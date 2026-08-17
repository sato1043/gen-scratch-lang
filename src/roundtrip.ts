/**
 * .sb3 を記法へ戻す。往復検査（記法 → .sb3 → 記法）の逆側を担う。
 *
 * 逆変換は自作せず公開実装（`parse-sb3-blocks`）を使う。自作すると台帳の誤りが往復で
 * 相殺され、検査が何も捕まえなくなる。
 *
 * 比較はブロックの識別子列で行う。文字列で比べると、日本語辞書が同じラベルに認めている
 * 別名を差分と誤って報告する。
 *
 * TASK0002（.sb3 の読み取り解析）はこの部品の上に乗るため、テストの中の使い捨てにしない。
 */
import { createRequire } from "node:module"
import JSZip from "jszip"
import { eachBlock } from "./parse.ts"
import { clip } from "./errors.ts"
import { PROJECT_JSON_LIMIT, acceptArchive, refuseBadLimit } from "./intake.ts"
import { TYPES, asKeyed } from "./definition.ts"

const require = createRequire(import.meta.url)
const { toScratchblocks } = require("parse-sb3-blocks")

/**
 * 戻す先の言語。
 *
 * 日本語でも戻せる（実測で往復が成立する）が、英語を既定に置く。日本語の綴りには
 * 2 つのブロックが同じラベルになる衝突があり、往復検査がその衝突で落ちると、生成器の
 * 取りこぼしを見張るという本来の役目が埋もれる。
 */
const LOCALE = "en"

// 上限そのものは受け入れ検査が持つ。読み取りの経路と検証器へ渡す経路の双方が同じ値を
// 使うためで、ここから読み直せるよう名前だけを通す
export { PROJECT_JSON_LIMIT }

/**
 * ブロックの入れ子の深さの上限。
 *
 * 現象から導く。逆変換（`toScratchblocks`）は入れ子を再帰で辿るため、深いところで
 * `RangeError: Maximum call stack size exceeded` になる。JSON としては 0.2 MB しか無く、
 * project.json の 5 MB では縛れない（2026-08-20 に二分探索で実測）。
 *
 * | 実行環境 | 通る最大 | 落ちる最小 |
 * |---|---|---|
 * | Node 24.19.0 | 1874 | 1875 |
 * | Node 20.19.1 | 1561 | 1562 |
 *
 * **落ちる点は run ごとに動く。** 同じ Node 20 で 1749 と 1561 の 2 通りを測った。呼ばれた
 * 時点のスタックの残りに依るためで、実測値をそのまま線にすると別の run で破れる。
 *
 * 線は最も低い実測（1561）の 1/10 に置く。zip のエントリ数の上限と同じ割合で揃えてあり、
 * 片方だけを別の割合で動かすと、どの検査がどれだけの余裕で通っているのかが読めなくなる。
 *
 * 記法の量が深さの二乗で増えることも、この線が抑えている（字下げが段ごとに積み上がるため。
 * 深さ 1500 で 9.0 MB の記法になる。この線では約 0.10 MB）。
 *
 * 直列に長いスクリプトは深さに数えない。逆変換は `next` を繰り返しで辿るので、10 万件の
 * 直列でも落ちない（2026-08-20 実測）。数えると正当な作品を弾く。Scratch のエディタで
 * 組める入れ子は現実には 10 段ほどで、この線には 15 倍の余裕がある。
 */
export const NESTING_LIMIT = 156

/**
 * 記法の字下げ 1 段ぶん。TASK0001 が書く記法と揃える。
 *
 * 鍵は `tab` である。上流の README は `tabs` と書くが、実装（0.5.2 の dist）が読むのは
 * `tab` だけで、`tabs` を渡すと既定の 4 空白のまま出る。README を写したまま効果を測って
 * いなかった（2026-08-19 に発覚し、2026-08-20 に直した）。
 */
const INDENT = "  "

/**
 * project.json を探す規則。公式検証器（`scratch-parser`）と同じ形にしてある。
 *
 * 検証器は 1 段のディレクトリを許し、当たった先頭 1 件を読む。こちらが名前の完全一致で
 * 探すと、両方を収めた zip で「検証器が見たもの」と「こちらが読むもの」が別になり、
 * 検証を通した中身と実際に扱う中身が食い違う（2026-08-18 実測）。規則を揃えたうえで、
 * 当たりが 1 件でなければ読まない。
 */
const PROJECT_JSON = /^([^/]*\/)?project\.json$/

/**
 * .sb3 を開いて project.json を取り出す。
 *
 * 入力は信頼しない。TASK0002 が他者の .sb3 を読むため、ここへ来る .sb3 は自分が
 * 作ったものだとは限らない。大きさ・エントリ数・入れ子の深さ・参照の循環を、
 * 読み取りの入口で見る。
 *
 * 誤りは投げる。読む側から見た口を `Problem[]` へ揃えるのは呼ぶ側の役目で、ここを
 * 戻り値へ変えると既存の呼び出し元（往復検査）が受け取り方ごと変わる。
 *
 * `limit` は project.json の展開後の上限、`entries` は zip のエントリ数の上限、
 * `depth` は入れ子の深さの上限。戻りは project.json の中身。
 */
export async function openSb3(
  bytes: Buffer,
  // 既定は分割代入で与える。`??` で書くと `null` を「渡されなかった」と読み、上限として
  // 使えない値が黙って既定へ戻る（本作業で実際に書き、既存の検査が捕まえた）
  {
    limit = PROJECT_JSON_LIMIT,
    entries: entryLimit,
    depth = NESTING_LIMIT,
  }: { limit?: number; entries?: number; depth?: number } = {},
): Promise<any> {
  refuseBadLimit(limit)
  refuseBadLimit(depth)

  // 開く前に見る。展開してから大きさを見ては、その時点で資源を使い切っている
  const refused = acceptArchive(bytes, "入力", { entries: entryLimit, projectJson: limit })
  if (refused.length > 0) {
    // 説明は持つものだけ添える約束なので、無いときに `undefined` を綴らない
    const [{ kind, detail }] = refused
    throw new Error(detail ? `${kind}: ${detail}` : kind)
  }

  const zip = await JSZip.loadAsync(bytes)
  const entries = zip.file(PROJECT_JSON)
  if (entries.length === 0) throw new Error("project.json が入っていない")
  if (entries.length > 1) {
    // どれを読んでも、検証器が見た 1 件と一致する保証が無い。選ばずに止める
    const names = entries.map(entry => entry.name).join(", ")
    throw new Error(`project.json が ${entries.length} 個ある: ${names}`)
  }

  const project = readJson(await readWithin(entries[0], limit))
  const found = inspectProject(project)
  refuseCycle(found.cycle)
  refuseShared(found.shared)
  refuseDepth(found.depth, depth)
  return project
}

/**
 * project.json を読む。壊れていたら、入力の断片を載せずに止める。
 *
 * `JSON.parse` の `SyntaxError` は誤りの周辺を引用する。他者の .sb3 を読む経路では、
 * 引用された断片がそのまま申告と端末の履歴へ流れる。位置は残して中身は落とす。
 *
 */
function readJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    // 位置だけを拾う。`SyntaxError` の文言は版で変わるので、取れなければ位置を諦める
    const at = /position (\d+)/.exec(error instanceof Error ? error.message : "")
    const where = at ? `${at[1]} バイト目の付近` : "位置を特定できず"
    throw new Error(`project.json が JSON として読めない: ${where}`)
  }
}

/**
 * 循環が見つかっていたら止める。
 *
 * 読み取りの入口（`openSb3`）と、ブロックの表を受け取る口（`toNotation`）の両方から
 * 呼ぶ。入口だけに置くと、表を別の経路で組み立てた呼び出し（zip を自分で開く・
 * 一部だけ差し替える）が素通りし、辿る側でスタックを使い切る。
 *
 * 経路は畳んでから載せる。1 ブロックあたり約 20 文字が 1 行に並ぶので、8000 ブロックの
 * 環では 160,033 文字の 1 行になる（2026-08-20 実測）。端末にも申告にも収まらず、
 * 循環していることまで読めなくなる。両端を残すのは、どこから入ってどこへ戻ったかが
 * 循環の手掛かりだからである。
 *
 */
function refuseCycle(cycle: string[] | null): void {
  if (cycle) throw new Error(`ブロックの参照が循環している: ${shownCycle(cycle)}`)
}

/** 経路に並べる ID の数。前後で分け合う */
const CYCLE_SHOWN = 6

/**
 * 循環の経路を、読める長さへ畳む。畳んだ件数を残す。
 *
 */
function shownCycle(cycle: string[]): string {
  const arrow = " → "
  if (cycle.length <= CYCLE_SHOWN) return cycle.map(id => clip(id, CYCLE_ID)).join(arrow)

  const half = CYCLE_SHOWN / 2
  const head = cycle.slice(0, half).map(id => clip(id, CYCLE_ID))
  const tail = cycle.slice(-half).map(id => clip(id, CYCLE_ID))
  return [...head, `(ほか ${cycle.length - CYCLE_SHOWN} 件)`, ...tail].join(arrow)
}

/**
 * 経路に並べる ID 1 つの長さの上限。
 *
 * Scratch が振る ID は 20 文字である。細工した .sb3 は好きな長さの ID を持てるので、
 * 件数を絞っても 1 件で枠を埋められる。
 */
const CYCLE_ID = 40

/**
 * 入れ子が深すぎたら止める。
 *
 * `depth` は実際の深さ、`limit` は上限。
 */
function refuseDepth(depth: number, limit: number): void {
  if (depth > limit) {
    throw new Error(`ブロックの入れ子が深すぎる: 深さ ${depth} で、上限 ${limit} を超えた`)
  }
}

/**
 * エントリを読む。展開しながら数え、上限を超えたところで打ち切る。
 *
 * 展開し終えてから長さを見る形では上限の意味が無い。その時点で資源は使い切って
 * いる（小さな zip が展開で膨れる細工に対して無防備になる）。JSZip が展開前に持つ
 * 大きさは私有プロパティ（`_data`）にあり、型定義が「公開したらここを開ける」と
 * 明記しているため使わず、公開されている stream で読む。
 *
 * `limit` はバイト数。
 */
function readWithin(entry: import("jszip").JSZipObject, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    let stopped = false

    // `for await` では書けない。JSZip 3.10.1 が抱える readable-stream は 2.3.8 で、
    // その Readable は `Symbol.asyncIterator` を持たない（3.x から持つ）。
    // イベントは 2.x でも同じなのでそちらを使う。抱えている型は 2.x のもので
    // `destroy` を宣言しないが、実体は持つ。在るかどうかは呼ぶ前に確かめる
    const stream: any = entry.nodeStream("nodebuffer")

    stream.on("data", (chunk: Buffer) => {
      if (stopped) return
      size += chunk.length
      if (size > limit) {
        // 打ち切る。読み切ってから長さを見ては上限の意味が無い。
        // 一時停止では展開の作業が残ったままになるので、破棄して資源を手放す
        stopped = true
        if (typeof stream.destroy === "function") stream.destroy()
        else stream.pause()
        reject(new Error(`project.json が大きすぎる: 上限 ${limit} バイトを超えた`))
        return
      }
      parts.push(chunk)
    })
    stream.on("error", reject)
    stream.on("end", () => {
      if (!stopped) resolve(Buffer.concat(parts).toString("utf8"))
    })
  })
}

/**
 * 作品ぜんぶのブロックを辿り、循環と最も深い入れ子を調べる。
 *
 * Scratch のエディタは循環を作らないが、細工した .sb3 では作れる。記法へ戻す処理は
 * 参照を辿って進むため、循環があると戻ってこない。深い入れ子も同じ辿りで壊れる。
 * 1 度の走査で両方を出すのは、2 度歩くと同じ費用を 2 回払うためである。
 *
 */
function inspectProject(project: unknown): { cycle: string[] | null; depth: number; shared?: string } {
  const listed = asKeyed(project)?.targets
  const targets = Array.isArray(listed) ? listed : []
  let deepest = 0
  for (const target of targets) {
    const blocks = asKeyed(asKeyed(target)?.blocks)
    if (!blocks) continue
    const found = traverse(blocks)
    // 循環と共有があれば深さは測り切れていない。見つけた時点で返す
    if (found.cycle || found.shared) return found
    deepest = Math.max(deepest, found.depth)
  }
  return { cycle: null, depth: deepest }
}

/**
 * 2 か所から指されているブロックがあれば止める。
 *
 */
function refuseShared(shared: string | undefined): void {
  if (shared === undefined) return
  throw new Error(
    `ブロックが 2 か所から指されている: ${clip(shared, CYCLE_ID)}` +
      "（Scratch は同じブロックを 2 か所へ差せない）",
  )
}

/**
 * ブロックの表 1 つぶんを深さ優先に辿り、循環と最も深い入れ子を探す。
 *
 * 再帰では書かない。上限を 5 MB まで許すのでブロックは数万件になりうり、直列に
 * 長いスクリプトでスタックを使い切る。
 *
 * 深さに数えるのは入れ子の辺だけである。`next` は横に並ぶ辺であり、逆変換もそちらは
 * 繰り返しで辿る。混ぜて数えると、直列に長いだけの正当なスクリプトを深いと誤る。
 *
 */
function traverse(blocks: Record<string, unknown>): { cycle: string[] | null; depth: number; shared?: string } {
  /** 辿り終えた（先に循環が無いと分かった）ブロック */
  const done = new Set<string>()

  /**
   * ブロックごとの辺。1 度だけ作る。
   *
   * 以前は辺を 1 本進むたびに作り直しており、1 ブロックの辺数の二乗になっていた。
   * 入力を 8,000 本持つブロック 1 つ（JSON 1.1 MB）で 25.7 秒、5 MB の線の内側へ外挿すると
   * 8 分を超えた（CP6 で実測）。深さの上限も受け入れ検査もこの形を弾かない ── 深さは
   * 2 段しか無く、エントリは 1 つで足りる。下の予算は「辿った辺」を数えるので、
   * 作り直しの費用を覆っていなかった。
   */
  const edgeCache = new Map()

  /**
   * 既にどこかの辺から指されているブロック。
   *
   * Scratch は 1 つのブロックを 2 か所から指さない（木である）。細工した .sb3 では
   * 指せる ── 循環ではないので循環の検知に掛からず、深さの上限にも掛からない
   * （深さは変わらない）。逆変換器は共有を展開するので、時間が深さに対して指数で
   * 伸びる。深さ 18・ブロック 19 件で 172 ms、1 段あたり約 1.7 倍だった
   * （CP6 で実測）。上限の内側で事実上停止する
   */
  const pointed = new Set()
  const edgesFor = (id: string) => {
    const seen = edgeCache.get(id)
    if (seen) return seen
    const edges = edgesOf(blocks[id])
    edgeCache.set(id, edges)
    return edges
  }

  /**
   * 辿ってよい辺の総数。深さ優先の探索は各辺を 1 度しか辿らないので、これを超えたら
   * 探索そのものが壊れている（同じ辺を回り続けている）。
   *
   * 予算を置かないと、循環の検知が破れたときに同期の無限ループへ落ちる。同期の
   * ループはイベントループを止めるため、テストの timeout でも中断できず、
   * 「どの検査が落ちたか」が集計から消える（実測 2026-08-18）。
   */
  let budget = 0
  for (const id of Object.keys(blocks)) {
    const edges = edgesFor(id)
    budget += edges.length
    for (const edge of edges) {
      if (!Object.hasOwn(blocks, edge.to)) continue
      if (pointed.has(edge.to)) return { cycle: null, depth: 0, shared: edge.to }
      pointed.add(edge.to)
    }
  }

  /**
   * ブロックごとの、その先にある入れ子の深さ。
   *
   * 辿り終えた先を 2 度歩かないための覚えでもある。`done` だけで飛ばすと、同じブロックを
   * 複数の親が指す細工の入力で、飛ばした側の深さが数えられない
   */
  const below = new Map()
  let deepest = 0

  for (const start of Object.keys(blocks)) {
    if (done.has(start)) continue

    const path = [start]
    /** 今の経路に居るもの。ここへ戻る辺が循環である */
    const onPath = new Set([start])
    /** 経路の各段が次に見る辺の番号 */
    const cursor = [0]
    /** 経路の各段へ入ってきた辺が入れ子だったか */
    const nested = [false]
    /** 経路の各段の、今までに分かっているその先の深さ */
    const found = [0]

    while (path.length > 0) {
      const id = path[path.length - 1]
      const edges = edgesFor(id)
      const at = cursor[cursor.length - 1]

      if (at >= edges.length) {
        done.add(id)
        onPath.delete(id)
        const reach = found.pop() ?? 0
        below.set(id, reach)
        deepest = Math.max(deepest, reach)
        path.pop()
        cursor.pop()
        const step = nested.pop() ? 1 : 0
        if (found.length > 0) {
          found[found.length - 1] = Math.max(found[found.length - 1], reach + step)
        }
        continue
      }
      cursor[cursor.length - 1] = at + 1
      if (budget-- <= 0) {
        throw new Error("ブロックの参照を辿り切れない（循環の検知が働いていない）")
      }

      const edge = edges[at]
      // 表に無い参照は循環ではない。持ち物だけを見る（`in` は
      // `Object.prototype` の名前まで拾い、`toString` のような値を辺に化かす）
      if (!Object.hasOwn(blocks, edge.to)) continue
      if (onPath.has(edge.to)) return { cycle: [...path, edge.to], depth: deepest }

      const step = edge.nested ? 1 : 0
      if (done.has(edge.to)) {
        const reach = (below.get(edge.to) ?? 0) + step
        found[found.length - 1] = Math.max(found[found.length - 1], reach)
        continue
      }

      path.push(edge.to)
      onPath.add(edge.to)
      cursor.push(0)
      nested.push(edge.nested)
      found.push(0)
    }
  }
  return { cycle: null, depth: deepest }
}

type Edge = {
  /** 指す先のブロックの ID */
  to: string
  /** 入れ子の辺か（横に並ぶ `next` なら偽）*/
  nested: boolean
}

/**
 * ブロックから下向きの辺を取る。
 *
 * `parent` は取らない。上向きの辺であり、辿れば必ず循環に見える。
 *
 */
function edgesOf(raw: unknown): Edge[] {
  const block = asKeyed(raw)
  if (!block) return []

  const edges: Edge[] = []
  // `next` は同じ段に横へ並ぶ。逆変換も繰り返しで辿るため、深さには数えない
  if (typeof block.next === "string") edges.push({ to: block.next, nested: false })

  for (const input of Object.values(asKeyed(block.inputs) ?? {})) {
    // 入力は [種別, 値, ...] の並び。埋まったブロックの ID は文字列で入り、
    // 素の値は `[4, "10"]` のように配列で入る
    if (!Array.isArray(input)) continue
    for (const item of input.slice(1)) {
      if (typeof item === "string") edges.push({ to: item, nested: true })
    }
  }
  return edges
}

/**
 * ブロックの表を記法へ戻す。
 *
 * スクリプトの並びは表に現れる順に従う。生成した .sb3 では書き出した順で、読み込んだ
 * .sb3 ではファイルに現れる順になる。
 *
 * `blocks` はターゲット 1 つぶんのブロックの表。
 */
export function toNotation(
  blocks: Record<string, any>,
  options: { locale?: string; depth?: number } = {},
): string {
  return toScripts(blocks, options).join(SCRIPT_GAP)
}

/**
 * スクリプトの区切り。`toNotation` が繋ぐときの間である。
 *
 * 繋いだ後の文字列を割り直してスクリプトを数えると、記法の中に空行が現れた途端に数が
 * ずれる。数えたい側は `toScripts` を直に呼ぶ。
 */
const SCRIPT_GAP = "\n\n"

/**
 * ブロックの表をスクリプト単位の記法にする。
 *
 * 図はスクリプトごとに描くので、繋ぐ前の形を要る側がある。繋ぐのは `toNotation` の役目に
 * 留め、こちらは並びのまま返す。
 *
 * `blocks` はターゲット 1 つぶんのブロックの表。
 */
export function toScripts(
  blocks: Record<string, any>,
  { locale = LOCALE, depth = NESTING_LIMIT }: { locale?: string; depth?: number } = {},
): string[] {
  // 表を受け取る口でも循環と深さを見る。逆変換は参照を辿って進むため、循環したままでも
  // 深すぎても、スタックを使い切って落ちる（`openSb3` を経ない呼び出しでも同じ）
  refuseBadBlocks(blocks)
  refuseBadLimit(depth)
  const found = traverse(blocks)
  refuseCycle(found.cycle)
  refuseShared(found.shared)
  refuseDepth(found.depth, depth)

  const scripts = []
  for (const [id, block] of Object.entries(blocks)) {
    // 影ブロックと、他のブロックに繋がっているものは、スクリプトの先頭ではない。
    // 単独で置かれた値（並び）も記法にしない ── 逆変換器はレポーターから書き起こせない
    if (Array.isArray(block) || !block.topLevel || block.shadow) continue
    scripts.push(toScratchblocks(id, blocks, locale, { tab: INDENT }))
  }
  return scripts
}

/**
 * 表の中身が壊れていたら止める。
 *
 * 辺を取る側（`edgesOf`）は壊れた値を「辺の無いもの」として読み飛ばすが、記法へ戻す側は
 * `block.topLevel` を直接引く。同じ表を読み飛ばす目と直に引く目の両方が見ており、
 * `null` が混ざると後者が素の TypeError で落ちる（2026-08-18 実測）。循環に当てた
 * 論法（表を受け取る口でも守る）を、中身の壊れにも当てる。
 *
 */
function refuseBadBlocks(blocks: unknown): void {
  // 旧実装は並びを除いて投げていた。正典で書く
  const table = TYPES.対応(blocks) ? blocks : null
  if (!table) {
    throw new Error("ブロックの表になっていない")
  }
  for (const [id, block] of Object.entries(table)) {
    // 形の整った並びは壊れていない。Scratch は単独で置かれた変数・リストのレポーターを
    // `[12, "スコア", "variable:スコア"]` のような並びで書く（公式検証器も通す）。
    // 生成の向きでは現れないので投げていたが、読み取りは入力を選べない ── 子どもが
    // 変数を画面へ置いた作品でターゲットが丸ごと落ちていた（CP6 で実測）。
    // 空の並びや種別の無い並びは通さない。それは形が整っておらず、値でもない
    if (Array.isArray(block)) {
      if (isPrimitive(block)) continue
      throw new Error(`ブロックの中身が壊れている: ${id}`)
    }
    if (!block || typeof block !== "object") {
      throw new Error(`ブロックの中身が壊れている: ${id}`)
    }
  }
}

/**
 * 単独で置かれた値（top-level primitive）の形をしているか。
 *
 * Scratch は種別の番号を先頭に置く。数と文字が 4〜10、合図が 11、変数が 12、リストが 13
 * である（出典は `scratch-parser` が抱える sb3 の schema）。番号の範囲を見るのは、
 * 「並びなら何でも値」と読むと壊れた中身まで値として通してしまうためである。
 *
 */
function isPrimitive(block: unknown[]): boolean {
  const kind = block[0]
  return block.length >= 2 && typeof kind === "number" && kind >= 4 && kind <= 13
}

/**
 * 中間表現からブロックの識別子列を取る。往復の前後を比べるのに使う。
 *
 * 識別子を持たないブロック（変数とリストのレポーター・認識できない記述）は、選択子か
 * カテゴリで代える。前後で同じ代え方をするので、取りこぼしはそのまま差分に出る。
 *
 * `doc` は scratchblocks の Document。
 */
export function identifiersOf(doc: any): string[] {
  return [...eachBlock(doc)].map(
    block => block.info?.id ?? block.info?.selector ?? block.info?.category ?? "(不明)",
  )
}
