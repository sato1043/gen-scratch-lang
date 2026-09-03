/**
 * 既にある .sb3 を読み、ターゲットごとの日本語記法として出す。
 *
 * 生成の向き（記法 → .sb3）と同じ台帳・同じ記法を共有する。違うのは入力を選べないこと
 * である。生成側は台帳に無いブロックを拒んで止まってよいが、読む側は渡されたものを
 * 読むしかない。**落とさずに印を付けて出す**のが本モジュールの主題である。
 *
 * 誤りは投げずに `Problem[]` で返す。読み取りの下には投げる部品（`openSb3`・
 * `toNotation`）と返す部品（`loadCatalog`）が混ざっており、読む側から見た口が 3 通りに
 * 割れていた。ここで 1 通りへ揃える。
 */
import { createRequire } from "node:module"
import { CATALOG_KEYS, loadCatalog } from "./catalog.ts"
import {
  SPRITE_KEYS,
  TYPES,
  asKeyed,
} from "./definition.ts"
import { clip, neutralize, problemOf } from "./errors.ts"
import { SENTINEL_CLOSE, SENTINEL_OPEN, ours, spelled } from "./notation.ts"
import { openSb3, toScripts } from "./roundtrip.ts"
import { REFUSAL_LEAD, officialProblems } from "./validate.ts"

const require = createRequire(import.meta.url)
const { allBlocks } = require("parse-sb3-blocks")

/**
 * 読み取りが出す記法の言語。人が読むものなので日本語を既定にする。
 *
 * 英語も選べる。日本語の綴りには 2 つのブロックが同じラベルになる衝突があり、読んだ
 * ものを機械で突き合わせたいときは英語の方が扱いやすい（往復検査が英語を使うのと
 * 同じ理由）。
 */
/**
 * 1 度の読み取りが扱うターゲットの本数の上限。
 *
 * 現象から導く。ターゲット 1 件は約 0.36 ms・約 0.26 KB で、必ず記法のファイルを
 * 1 つ増やす（2026-08-20 実測。入口から通して 2,000 件 2,577 ms・600 KB、
 * 8,000 件 4,724 ms・2,132 KB）。project.json の上限（5 MB）の内側には最小の
 * ターゲットが約 187,000 件入り、そのまま書き出すと約 67 秒・約 187,000 ファイルになる。
 *
 * 逃げ道がこの天井を押し上げる。schema の必須項目が外れると最小のターゲットが
 * 438 バイト → 24 バイトへ縮み、収まる件数が 18 倍になる（同日実測）。
 *
 * 線は図の本数（`FIGURE_LIMIT`）と同じ 2,000 に置く。どちらも「1 度の読み取りが
 * 書き出すファイルの本数」という同じ現象を縛るので、別の値を置く理由が無い。
 * Scratch のエディタで組む作品のスプライトは数十なので、余裕は 2 桁ある。
 *
 * 超えたら切り詰めずに止める。黙って一部だけ読むと「全部読めた」と見分けが付かない。
 */
export const TARGET_LIMIT = 2000

export const LOCALES = ["ja", "en"]
const LOCALE = LOCALES[0]

export type Problem = {
  kind: string
  subject: string
  detail?: string
  /** 成果物へ載せる理由。端末より広い枠で作る */
  full?: string
  /** 入口で受け取りを拒んだものか（`validate.ts` が付ける）*/
  refusal?: boolean
  /** 受け入れ検査（資源の上限）の拒否か */
  intake?: boolean
}

/**
 * opcode の被覆の区分。
 *
 * 台帳と逆変換器は別々の表であり、どちらが知っているかで扱いが変わる。区分を 4 つに
 * 分けておくと、読めたのか・戻せるのか・消えたのかを件数で言える。
 *
 * **影ブロックにはその 4 区分を当てない。** 逆変換器は影の opcode を一度も見ない。影に
 * 書かれた欄（`fields`）を親の行へ直に描くので、opcode をでたらめな綴りに替えても同じ行が
 * 出る（2026-08-20 に実測）。2 つの表と突き合わせると、描けているメニューが「どちらも
 * 知らない」に並ぶ ── 実際には何も落ちていないのに、落ちたと申告することになる。
 *
 * 数えないのではなく、5 つめの区分として数える。件数の総和が作品のブロック数と合わなく
 * なる方が、読み手には分かりにくい。
 */
export const COVERAGE = Object.freeze({
  BOTH: "双方が知る",
  REVERSE_ONLY: "逆変換器だけが知る",
  CATALOG_ONLY: "台帳だけが知る",
  NEITHER: "どちらも知らない",
  SHADOW: "影として親の行に出る",
  LOOSE: "単独で置かれた値（記法にしない）",
})

/**
 * 印の綴り。逆変換器が知らないブロックを、消さずに記法へ残す。
 *
 * 記法のコメントとして出す。scratchblocks はコメント行をそのまま受け、描画器も
 * 認識できないブロックとして扱わない（2026-08-20 に実測）。
 *
 * **記法の言語に従う。** 印は記法の内側に入る綴りなので、`--locale en` を渡したのに
 * ここだけ日本語だと、英語の記法へ日本語のコメントが混ざる ── 旗の宣言（記法の言語を
 * 選ぶ）と実装が食い違う（2026-08-22 実測・裁定）。要約・作品定義・申告は記法の外なので
 * 日本語のままにする。
 */
const MARKS = Object.freeze({ ja: "読み取れない: ", en: "unreadable: " })

/**
 * その言語の印の綴りを引く。知らない言語は既定へ倒す。
 */
function markOf(locale: string): string {
  const table = MARKS as Record<string, string>
  return table[locale] ?? table[LOCALE]
}

/**
 * 引数の目印。独自ブロックの名前では `%s` 等が引数の位置を表す。
 *
 * opcode に `%` が入ると、渡していない引数を逆変換器が読もうとして投げ、そのターゲットの
 * 記法・図・定義が丸ごと落ちる（CP6 で実測）。Scratch の opcode は英小文字と `_` だけ
 * なので、`%` を含む時点で細工された入力である。全角へ逃がして、綴りは読める形で残す。
 */
const ARGUMENT_MARK = new Map([["%", "％"]])

/**
 * 入力に由来する綴りを、印の仕組みを壊さない形へ落とす。
 */
function escaped(text: string, table: Map<string, string>): string {
  let out = text
  for (const [from, to] of table) out = out.replaceAll(from, to)
  return out
}

/**
 * 差し替えた行を、記法のコメントへ直す規則を、その言語の印で組み立てる。
 *
 * 直すのは文の位置に置いた印だけである。値の枠に置いた印は行の途中にあり、記法の
 * コメントは行末までを飲むので、コメントへ直すと後ろのブロックまで消える。値の印は
 * `⟪…⟫::custom` のまま残す ── scratchblocks の記法として正しく、既定のブロックでない
 * ことが図でも読める。
 */
function sentinelLine(locale: string): RegExp {
  const mark = markOf(locale)
  // 中身は閉じ括弧を含みうる。`spelled` は入力の括弧を落とさず印（`⟪U+27EB⟫`）へ変える
  // ので、印の中身にこちらが作った閉じ括弧が現れる。閉じ括弧の手前までを取る形
  // （`[^⟫]*`）だと途中で切れ、行がコメントへ直らず記法へ漏れた（CP6 で実測）。
  // 貪欲に取って行末の `⟫::custom` へ当てる ── 中身の生の閉じ括弧は `spelled` が
  // 印へ変えているので、この並びは行末にしか現れない
  return new RegExp(`^(\\s*)${SENTINEL_OPEN}(${mark}.*)${SENTINEL_CLOSE}::custom$`)
}

/** 入力に現れた opcode 1 つ分 */
type Used = {
  opcode: string
  /** 影ブロックとして現れたか */
  shadow: boolean
  /** 現れた回数 */
  count: number
  /** `COVERAGE` のいずれか */
  coverage: string
}

/** 読み取ったターゲット 1 つ分 */
type ReadTarget = {
  name: string
  /** ファイル名にできる綴り */
  stem: string
  isStage: boolean
  /** スクリプトごとの日本語の記法 */
  scripts: string[]
  /** 宣言された変数の、名前と初期値 */
  variables: Record<string, unknown>
  /** 宣言されたリストの、名前と初期値 */
  lists: Record<string, unknown>
  /** 宣言されたメッセージの名前 */
  broadcasts: string[]
  /** 画面を再描画しない指定を持つブロック定義の名前。記法の形で持つ */
  warped: string[]
  /** 位置・大きさ・向き・表示。ステージは持たない */
  placement: Record<string, unknown>
}

/** 記法へ戻せず落としたターゲット */
type Dropped = {
  /** 元の作品での名前 */
  name: string
  /** 落とした理由 */
  reason: string
}

/** 読み取りの結果 */
export type Reading = {
  targets: ReadTarget[]
  /** 入力に現れた opcode を、現れた順でなく綴りの順に並べたもの */
  used: Used[]
  /**
   * 復元しない .sb3 の欄の名前。**作品が実際に持つ欄から数える**。手で並べた一覧を
   * 持つと、.sb3 の形が変わったときに一覧だけが古びる
   */
  unrestored: string[]
  /**
   * 落としたターゲット。**同じことを `problems` も述べるが、あちらは人が読む申告で、
   * こちらは成果物へ痕跡を残す側が数える**。申告の綴りから拾い直すと、綴りを変えた
   * 瞬間に痕跡が黙って消える
   */
  dropped: Dropped[]
  /**
   * 落とした宣言の名前（読めない値・重なった名前）。`dropped` と同じ理由でここが
   * 数える ── 申告の綴りから拾い直すと、綴りを変えた瞬間に痕跡が黙って消える
   */
  droppedValues: string[]
  /** 申告のすべて。空なら何も言うことが無かった */
  problems: Problem[]
  /**
   * 逃げ道を通したときだけ、検証器が弾いた理由が入る。**同じ実体が `problems` にも
   * 入る**（`refused` は `problems` の部分集合である）。要約はこの実体の同一性で
   * 2 つの節を分ける
   */
  refused: Problem[]
}

/**
 * .sb3 を読む。
 *
 * `anyway` は検証を飛ばす旗ではない。検証器は必ず走らせ、その判定を止める理由から
 * 申告へ降ろすだけである。飛ばすと、何が悪かったのかを誰も言えなくなる。
 *
 * 台帳の申告を足すのはここ 1 か所だけである。読み取りの本体は返す口を 5 つ持つので、
 * 口ごとに足す形にすると、次に口を増やしたときに黙って漏れる（実際に漏れていた ──
 * 項目だけが壊れた台帳で `catalog.problems` が捨てられ、終了コードが 0 になった）。
 *
 * `subject` は報告に出す対象の名。`limit`・`entries`・`depth` は `openSb3` へ渡す。
 * `locale` は記法の言語。`anyway` を立てると、検証器が弾いた作品も読めるところまで
 * 読む。`catalogPath` は台帳の位置で、壊れた台帳を渡す検査で使う。
 */
export async function readSb3(
  bytes: Buffer,
  subject: string,
  options: {
    limit?: number
    entries?: number
    depth?: number
    locale?: string
    anyway?: boolean
    catalogPath?: string | URL
  } = {},
): Promise<Reading> {
  const catalog = loadCatalog(options.catalogPath)
  if (!catalog.raw) {
    const empty = emptyReading()
    return { ...empty, problems: catalog.problems }
  }

  const reading = await readWith(catalog.raw, bytes, subject, options)
  return { ...reading, problems: [...catalog.problems, ...reading.problems] }
}

/**
 * 何も読めなかったときの器。
 *
 * 5 か所が同じ形を別々に綴っていた。欄を足すときに 1 か所でも書き忘れると、その経路
 * だけ欄が欠けたまま返り、受け取る側は `undefined` を数えることになる（本作業が畳んだ
 * 割れと同じ型である）。`problems` と `refused` は経路ごとに違うので、呼ぶ側が
 * 上書きする。
 */
function emptyReading(): Reading {
  return {
    targets: [],
    used: [],
    unrestored: [],
    dropped: [],
    droppedValues: [],
    refused: [],
    problems: [],
  }
}

/**
 * 読める台帳を受け取って .sb3 を読む。
 *
 * 台帳の申告を足すのは呼ぶ側（`readSb3`）の役目である。ここでは足さない。
 *
 * `raw` は読めた台帳。
 */
async function readWith(
  raw: import("./catalog.ts").Catalog,
  bytes: Buffer,
  subject: string,
  options: {
    limit?: number
    entries?: number
    depth?: number
    locale?: string
    anyway?: boolean
  },
): Promise<Reading> {
  const locale = options.locale ?? LOCALE
  const anyway = options.anyway === true

  let project
  try {
    project = await openSb3(bytes, options)
  } catch (error) {
    return {
      ...emptyReading(),
      problems: [problemOf(error, "読み取れない .sb3", subject)],
    }
  }

  // 形を確かめてから読む。確かめずに読むと、`targets` が配列でないだけの .sb3 が
  // 「ターゲット 0 件」として成功で終わる（2026-08-20 に実際にそうなった）。Scratch 自身が
  // 開けないものを、こちらだけが読めたことにしない。上限は受け入れ検査が既に掛けてある
  //
  // `anyway` が立っていても検証器は走らせる。止める理由から申告へ降ろすだけで、弾いた
  // 理由そのものは必ず伝える
  const rejected = await officialProblems(bytes, subject)
  // 受け入れ検査（資源の上限）の拒否は旗で降ろさない。旗は schema の判定を申告へ降ろす
  // ためのもので、量の目を外すためのものではない。CLI からは手前の砦で止まるが、
  // API を直に呼ぶ経路では残っていた
  const blocking = rejected.filter(problem => problem.intake === true)
  if (rejected.length > 0 && (!anyway || blocking.length > 0)) {
    // `refused` は空のままにする。この欄は「弾かれた**うえで読み進んだ**」を表すので、
    // 止まったときに入れると、断りを引く側（要約・図・作品定義）が「逃げ道を通した」と
    // 名乗る。読み進んだときに空にならないことは契約の検査が見張る
    const empty = emptyReading()
    return { ...empty, problems: rejected }
  }

  // 逃げ道を通しても、読み取りが要求する形は要る。検証器が弾いた 24 通りのうち読めない
  // のは 2 通りだけで、どちらもここで止まる（2026-08-20 実測。`targets` が配列でない
  // .sb3 と、sb2 の形）。床は検証器と独立に置く ── 旗が無ければ上で先に弾かれるので、
  // 検証器が schema を緩めたときの保険として残る
  if (!Array.isArray(project?.targets)) {
    return {
      ...emptyReading(),
      refused: rejected,
      problems: [
        ...rejected,
        { kind: "読み取れる形をしていない", subject, detail: shapeReason(project) },
      ],
    }
  }

  if (project.targets.length > TARGET_LIMIT) {
    return {
      ...emptyReading(),
      refused: rejected,
      problems: [
        ...rejected,
        {
          kind: "ターゲットが多すぎる",
          subject,
          detail: `${project.targets.length} 件あり、上限 ${TARGET_LIMIT} 件を超えた`,
        },
      ],
    }
  }

  const stems = stemsFor(targetsOf(project).map((target, index) => nameOf(target, index)))

  const known = catalogOpcodes(raw)
  const used = censusOf(project, known)

  const targets: ReadTarget[] = []
  const droppedTargets: Dropped[] = []
  /** 落とした宣言の名前。成果物の断りがここから数える */
  const droppedValues = []
  /** 復元しない欄。落としたターゲットのぶんは数えない（定義に載らないので） */
  const unrestored = new Set<string>()
  const problems: Problem[] = []
  for (const [index, target] of targetsOf(project).entries()) {
    const name = nameOf(target, index)
    // ここへは落ちない。保険である ── 上の検証器が `blocks` の欠けと型違いを既に弾く。
    // 検証を外したときと、検証器が schema を緩めたときに効く
    const blocks = asKeyed(asKeyed(target)?.blocks)
    if (!blocks) {
      problems.push({
        kind: "ターゲットのブロックの表が無い",
        subject: `${subject}: ${name}`,
        detail: "スクリプトを読めないので、このターゲットは記法にしない",
      })
      droppedTargets.push({ name, reason: "ブロックの表が無い" })
      continue
    }

    let scripts
    try {
      scripts = toScripts(markedBlocks(blocks, locale), { locale, depth: options.depth })
    } catch (error) {
      problems.push(problemOf(error, "記法へ戻せない", `${subject}: ${name}`))
      droppedTargets.push({ name, reason: "記法へ戻せない" })
      continue
    }

    const fields = asKeyed(target)
    const variables = declaredValues(fields?.variables, scalarValue)
    const lists = declaredValues(fields?.lists, listValue)
    const broadcasts = declaredValues(fields?.broadcasts)
    const dropped = [...variables.dropped, ...lists.dropped, ...broadcasts.dropped]
    // 同じ名前で捨てた宣言も申告する。捨てた事実を黙ると、要約が数えた宣言の数と
    // 作品定義に並ぶ数が食い違い、その差の理由がどこにも残らない
    const duplicated = [
      ...variables.duplicated,
      ...lists.duplicated,
      ...broadcasts.duplicated,
    ]
    if (duplicated.length > 0) {
      problems.push({
        kind: "同じ名前の宣言が 2 つある",
        subject: `${subject}: ${name}`,
        detail:
          `${duplicated.length} 件を捨てた（先に来た方を残す）: ` +
          `${duplicated.map(clipName).join("・")}`,
      })
    }
    // 落としたことは黙らない。宣言が消えた作品を「読めた」とだけ言うと、組み立て直した
    // ときに変数が無いことの理由が誰にも辿れない
    const unnamed = [
      ...variables.unnamed,
      ...lists.unnamed,
      ...broadcasts.unnamed,
    ]
    if (unnamed.length > 0) {
      problems.push({
        kind: "宣言の名前が文字列でない",
        subject: `${subject}: ${name}`,
        detail: `${unnamed.length} 件を落とした（名前の形: ${unnamed.join("・")}）`,
      })
    }
    droppedValues.push(...dropped, ...duplicated, ...unnamed)
    if (dropped.length > 0) {
      problems.push({
        kind: "宣言の値が読める形をしていない",
        subject: `${subject}: ${name}`,
        detail: `${dropped.length} 件を落とした: ${dropped.map(clipName).join("・")}`,
      })
    }

    for (const field of unrestoredOf(target)) unrestored.add(field)

    // スクリプト単位で持つ。図はスクリプトごとに描くので、繋いだ後で割り直すと
    // 記法の中に空行が出た途端に本数がずれる
    targets.push({
      name,
      stem: stems[index],
      isStage: asKeyed(target)?.isStage === true,
      scripts: scripts.map(script => unmark(script, locale)),
      variables: variables.values,
      lists: lists.values,
      broadcasts: Object.keys(broadcasts.values),
      warped: warpedIn(target),
      placement: placementOf(target),
    })
  }

  return {
    targets,
    used,
    unrestored: [...unrestored].sort(),
    dropped: droppedTargets,
    droppedValues,
    refused: rejected,
    problems: [...rejected, ...problems],
  }
}

/**
 * 台帳が知る opcode を集める。
 *
 * 主の opcode と `alsoCovers`（同じ記法が中身の形によって取る別の opcode）の双方を数える。
 * `alsoCovers` は別の項目が覆っているので、読み取りでも生成の向きでも扱える
 * （2026-08-20 に裁定）。台帳自身が `覆わない範囲` へ挙げるものは数えない ── 台帳が
 * 「覆っていない」と申告しているものを覆っていることにすると、申告の意味が消える。
 */
export function catalogOpcodes(raw: import("./catalog.ts").Catalog): Set<string> {
  const known = new Set<string>()
  for (const entry of raw[CATALOG_KEYS.BLOCKS]) {
    // 対応（キーと値の組）でない項目は飛ばす。`loadCatalog` が既に申告しており、
    // ここで落ちるとその申告ごと消える ── 台帳の壊れを伝える経路が、台帳の壊れで
    // 止まることになる（2026-08-22 実測。項目を `null` にすると `TypeError` で
    // 落ちた。数値・文字列・配列・真偽・opcode 欠落の 5 通りは落ちない）
    if (!entry || typeof entry !== "object") continue
    known.add(entry.opcode)
    for (const also of entry.alsoCovers ?? []) known.add(also?.opcode)
  }
  return known
}

/** 逆変換器が知る opcode。版を固定するのは呼ぶ側（`package.json`）の役目 */
export function reverseOpcodes() {
  return new Set(Object.keys(allBlocks))
}

/**
 * 作品に現れた opcode を数え、4 区分へ分ける。
 *
 * **逆変換に渡す前に数える。** 渡した後では、逆変換器が落としたものが数えられない。
 *
 * 影ブロック（メニュー等）も数えるが、区分は別に置く。数えないと件数の総和が作品の
 * ブロック数と合わず、読み手が「残りはどこへ行ったのか」を追えない。
 *
 * 同じ opcode が影としても影でなくも現れる作品はありうる。行を分けて数える ── 1 行へ
 * 潰すと、区分の違うものが 1 つの件数の裏に隠れる。
 *
 * `known` は台帳が知る opcode
 */
export function censusOf(project: unknown, known: Set<string>): Used[] {
  const reverse = reverseOpcodes()
  const counted = new Map<string, Used>()
  for (const target of targetsOf(project)) {
    const blocks = asKeyed(asKeyed(target)?.blocks)
    if (!blocks) continue
    // 区分も置き場で決める。`shadow` の旗だけを見ると、文の並びに置かれた影が
    // 「影として親の行に出る」と数えられる ── 親の行になど出ていない（CP6 で実測）
    const { asValue } = positionsIn(blocks)
    for (const [id, raw] of Object.entries(blocks)) {
      if (raw === null || typeof raw !== "object") continue
      const block = asKeyed(raw)
      // 単独で置かれた変数・リストのレポーターは並びで書かれ、opcode を持たない。
      // 「どちらも知らない」に混ぜると、読めなかったものと見分けが付かない
      // こちらの言葉は印の括弧で囲む。丸括弧で書いていたころは、opcode をその綴りに
      // した .sb3 が「単独で置かれた値」を名乗れた。括弧は `unnameable` が入力から
      // 必ず落とすので、囲めば作品の側からは名乗れない
      // 単独で置かれた値は並びで書かれる。容器の形そのものが手掛かりなので、
      // 対応として読めるかでなく並びかで見る
      const loose = Array.isArray(raw)
      const opcode = loose
        ? ours("単独で置かれた値")
        : typeof block?.opcode === "string"
          ? spelled(block.opcode)
          : ours("opcode が無い")
      const shadow = !loose && block?.shadow === true && asValue.has(id)
      const key = JSON.stringify([opcode, shadow])
      const seen = counted.get(key)
      if (seen) {
        seen.count += 1
        continue
      }
      counted.set(key, {
        opcode,
        shadow,
        count: 1,
        coverage: loose
          ? COVERAGE.LOOSE
          : shadow
            ? COVERAGE.SHADOW
            : coverageOf(opcode, known, reverse),
      })
    }
  }

  return [...counted.values()].sort(
    (a, b) => (a.opcode < b.opcode ? -1 : a.opcode > b.opcode ? 1 : Number(a.shadow) - Number(b.shadow)),
  )
}

/**
 * 影でない opcode 1 つの区分を決める。
 *
 * `known` は台帳が知る opcode
 * `reverse` は逆変換器が知る opcode
 */
function coverageOf(opcode: string, known: Set<string>, reverse: Set<string>): string {
  if (known.has(opcode)) return reverse.has(opcode) ? COVERAGE.BOTH : COVERAGE.CATALOG_ONLY
  return reverse.has(opcode) ? COVERAGE.REVERSE_ONLY : COVERAGE.NEITHER
}

/**
 * 2 つの表そのものの被覆を 4 区分へ分ける。入力に依らない。
 *
 * 作品ごとの集計（`censusOf`）とは別の問いに答える ── こちらは「台帳と逆変換器が、
 * どれだけ食い違っているか」であり、版が動いたことを検査が捕まえるための値である。
 *
 * `known` は台帳が知る opcode
 */
export function coveragePartition(known: Set<string>): { both: string[], catalogOnly: string[], reverseOnly: string[] } {
  const reverse = reverseOpcodes()
  const both = []
  const catalogOnly = []
  for (const opcode of known) {
    if (reverse.has(opcode)) both.push(opcode)
    else catalogOnly.push(opcode)
  }
  const reverseOnly = [...reverse].filter(opcode => !known.has(opcode))
  return { both, catalogOnly, reverseOnly }
}

/**
 * 作品のターゲットを取る。壊れていたら空の並びを返す。
 */
function targetsOf(project: unknown): unknown[] {
  const targets = asKeyed(project)?.targets
  return Array.isArray(targets) ? targets : []
}

/**
 * ターゲットの名前を取る。名前が無くても呼び分けられる綴りにする。
 */
function nameOf(target: unknown, index: number): string {
  const name = asKeyed(target)?.name
  // 名前にも宣言と同じ守りを掛ける。要約の対応表と作品定義に出るので、掛けないと
  // 「読み取れない」と名乗るターゲットを作れる。付ける代替名も括弧で囲む ── 素の
  // 綴りだと、その名を名乗るターゲットと見分けが付かない
  return typeof name === "string" && name !== ""
    ? spelled(name)
    : `${ours("名前が無い")}${index + 1}`
}

/**
 * 宣言（変数・リスト・メッセージ）を、名前と初期値の対応にする。
 *
 * project.json は 3 つを別々の形で持つ。変数は `{id: [名前, 値]}`、リストは
 * `{id: [名前, 並び]}`、メッセージは `{id: 名前}` である。名前の位置が違うだけなので、
 * 取り出す側で吸収する。メッセージは初期値を持たないので `null` を置く。
 *
 * 名前で引ける形にするのは、復元した定義がこの形で書くためである。同じ名前の宣言が
 * 2 つある作品は Scratch が作らないが、細工した .sb3 では作れる。後から来た方で
 * 上書きせず、先に来た方を残す ── 上書きすると、要約の件数と定義の件数が食い違う。
 *
 * 値の形が読めないものは落とし、落とした名前を返す。schema が守っていた保証を、
 * 逃げ道を通したときはここが引き継ぐ。
 *
 * `fits` は値として読める形かを見る。既定は何でも通す。
 */
function declaredValues(
  declared: unknown,
  fits: (value: unknown) => boolean = () => true,
): {
  values: Record<string, unknown>
  dropped: string[]
  duplicated: string[]
  unnamed: string[]
} {
  // 素の `{}` への添字代入で組み立てない。`__proto__` を名前に持つ宣言が、持ち物に
  // ならず黙って消える（`JSON.parse` は持ち物として作るので、作品には現れる）。
  // Map で組み立ててから `Object.fromEntries` で移す ── こちらは持ち物として作る
  const found = new Map<string, unknown>()
  const dropped: string[] = []
  /** 同じ名前で 2 度め以降に来たもの */
  const duplicated: string[] = []
  /** 名前が文字列でなかったもの */
  const unnamed: string[] = []
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    return { values: Object.fromEntries(found), dropped, duplicated, unnamed }
  }
  for (const value of Object.values(declared)) {
    const raw = Array.isArray(value) ? value[0] : value
    // 記法の側（ブロックの欄）と同じ守りを掛ける。片方だけに掛けると、記法が名乗る
    // 綴りと作品定義が宣言する綴りが割れ、書き出したものを `build` へ戻せなくなる。
    // 制御文字まで含めて揃える ── 逆変換器は名前から改行とタブを黙って落とす
    const name = spelled(raw)
    // 名前が文字列でない宣言も落ちたと数える。同じ関数の他の 2 経路（読めない値・
    // 重なった名前）は申告するのに、ここだけ黙っていた（CP6 の指摘）。Scratch は
    // 作らないが、細工した .sb3 では作れる
    if (typeof name !== "string") {
      unnamed.push(shapeOf(raw))
      continue
    }
    // 同じ名前の宣言が 2 つある作品は Scratch が作らないが、細工した .sb3 では作れる。
    // 先に来た方を残し、捨てた件数を返す ── 黙って捨てると、要約が数えた宣言の数と
    // 作品定義に並ぶ数が食い違い、その差の理由がどこにも残らない
    if (found.has(name)) {
      duplicated.push(name)
      continue
    }
    const held = Array.isArray(value) ? value[1] : null
    // 値の形は schema が守っていた。逃げ道を通すと守り手が居なくなるので、ここで引き継ぐ。
    // 引き継がないと、深い入れ子の値が定義の検査までそのまま届いてスタックを使い切る
    // （CP6 で実測。深さ 50,000 で生のスタックトレースが出た）
    if (!fits(held)) {
      dropped.push(name)
      continue
    }
    // 宣言の**値**にも同じ守りを掛ける。名前にだけ掛けていたころは、変数の初期値や
    // リストの要素に混ざった制御文字が作品定義へ生のまま出ていた（CP6 で実測。双方向
    // 上書き・行区切りを含む 7 区分）。値は入れ子の並びも取るので深く辿る
    found.set(name, deepGuard(held, spelled))
  }
  return { values: Object.fromEntries(found), dropped, duplicated, unnamed }
}

/**
 * 落とした宣言の名前を、申告へ載せられる長さに切る。
 *
 * 名前は他者が綴る。上限を置かないと、申告 1 行が画面を埋める。
 */
function clipName(name: string): string {
  return clip(name, DROPPED_NAME_LENGTH)
}

/**
 * 名前として使えなかった値の形を、申告に載せられる綴りにする。
 *
 * 値そのものは載せない。名前でないものを名前の位置へ出すと、読み手が作品の中から
 * 探せる綴りだと誤解する。`project.json` は JSON なので形は 5 通りしかない。
 */
function shapeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "並び"
  return typeof value === "object" ? "対応" : typeof value
}

/** 申告へ載せる名前の長さ。理由 1 件の長さの上限と釣り合わせる */
const DROPPED_NAME_LENGTH = 40

/** 変数が持てる値。Scratch の schema が許すのは文字列・数・真偽だけである */
const SCALARS = new Set(["string", "number", "boolean"])

/**
 * 変数の値として読める形か。
 */
function scalarValue(value: unknown): boolean {
  return value === null || SCALARS.has(typeof value)
}

/**
 * リストの値として読める形か。中身まで見る。
 */
function listValue(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.every(scalarValue))
}

/**
 * 読める形をしていない理由を言う。
 *
 * sb2 は公式検証器を通りうるので、床が唯一の砦になる（CP6 の指摘）。正体が分かるなら
 * 名乗り、手当ても添える。「targets が配列でない」だけでは、何をすればよいか伝わらない。
 */
function shapeReason(project: unknown): string {
  const fields = asKeyed(project)
  const sb2 = typeof fields?.objName === "string" || Array.isArray(fields?.children)
  if (sb2) return "Scratch 2 の作品に見える。Scratch 3 で開いて保存し直すと読める"
  return "targets が配列でない。逃げ道を通しても 1 件も読めない"
}

/**
 * .sb3 のターゲットの欄と、作品定義のキーの対応。
 *
 * **置かれ方を復元する唯一の表である。** 復元しない属性はこの表の補集合から数えるので、
 * 表を動かすと申告も動く。対応を 2 か所に別々の綴りで持つと、片方を直したときに
 * もう片方が取り残され、しかも申告は「復元している」と言い続ける。
 *
 * 日本語側は `SPRITE_KEYS` に在る綴りでなければならない。無い綴りを書くと、定義には
 * 出るが組み立てが知らないキーになる。一致は検査が見張る。
 */
export const PLACEMENT_KEYS = {
  x: "x",
  y: "y",
  visible: "表示",
  size: "大きさ",
  direction: "向き",
}

/**
 * 置かれ方のほかに、別の形で復元しているターゲットの欄。
 *
 * 記法（`blocks`）・宣言（`variables` / `lists`）・呼び名（`name`）と、種別の印
 * （`isStage`）である。ここに挙げない欄は復元しない側へ数える。
 *
 * **`broadcasts` は挙げない。** 定義の形式にメッセージのキーが無く、`definitionOf` も
 * 書かない。記法の中で使われたものは組み立てが作り直すが、宣言だけのものは消える。
 * ここへ挙げていた間は、要約が「メッセージ 2 件」と数えるのに定義には無く、「復元しない
 * 属性」にも出ないという状態だった（CP6 で 3 観点が独立に実測）。
 */
const RESTORED_ELSEWHERE = new Set(["name", "isStage", "blocks", "variables", "lists"])

/**
 * .sb3 の欄の名前の言い換え。
 *
 * 要約を読むのは Scratch の利用者で、`.sb3` の内部の綴りを知らない。doc と作業書は
 * 日本語で書いているのに成果物だけ生綴りという逆転を解く（CP6 の指摘）。
 *
 * **覆っていない欄は生綴りのまま出す。** そのため `.sb3` の形が変わってこの表が古びても、
 * 申告が誤るのでなく言い換えが減るだけで済む。網羅は要らない。
 */
const FIELD_NAMES = {
  broadcasts: "メッセージ",
  comments: "コメント",
  costumes: "コスチューム",
  currentCostume: "今のコスチューム",
  draggable: "ドラッグ可否",
  layerOrder: "重なり順",
  rotationStyle: "回転方法",
  sounds: "音",
  tempo: "テンポ",
  textToSpeechLanguage: "読み上げの言語",
  videoState: "ビデオの状態",
  videoTransparency: "ビデオの透明度",
  volume: "音量",
}

/**
 * 欄の名前を、読み手が引ける形にする。
 */
export function fieldLabel(field: string): string {
  const name = FIELD_NAMES[field as keyof typeof FIELD_NAMES]
  return name === undefined ? field : `${name}（${field}）`
}

/**
 * そのターゲットで復元しない欄を数える。
 *
 * 実際に持っている欄から数える。手で並べた一覧を持つと、.sb3 の形が変わったときに
 * 一覧だけが古びる。ステージは置かれ方を復元しない（`placementOf` が空を返す）ので、
 * 対応表の欄も復元しない側へ入れる。
 */
function unrestoredOf(target: unknown): string[] {
  const fields = asKeyed(target)
  if (!fields) return []
  const restored = new Set(RESTORED_ELSEWHERE)
  if (fields.isStage !== true) {
    for (const field of Object.keys(PLACEMENT_KEYS)) restored.add(field)
  }
  return Object.keys(fields).filter(field => !restored.has(field))
}

/**
 * スプライトの置かれ方を取る。定義のキーの綴りで返す。
 *
 * ステージは位置も大きさも持たない。空の対応を返し、書き出す側が何も足さないようにする。
 */
function placementOf(target: unknown): Record<string, unknown> {
  const fields = asKeyed(target)
  if (fields?.isStage === true) return {}
  const placement: Record<string, unknown> = {}
  for (const [field, key] of Object.entries(PLACEMENT_KEYS)) {
    placement[key] = fields?.[field]
  }
  return placement
}

/**
 * ファイル名に置ける文字。
 *
 * 許される側を数える。禁じる側を数え上げる形にすると、機械ごとに違う禁止文字
 * （Windows の `<>:"/\|?*` と制御文字、macOS の `:`）を書き手が先回りできず、素通りに
 * 気づくのは書き出しが失敗した後になる。字・記号・数と、区切りに使う 2 文字だけを通す。
 */
const NAME_SAFE = /[^\p{L}\p{M}\p{N}_-]/gu

/**
 * Windows が装置の名として予約している綴り。ファイルに使えない。
 *
 * 許可リストを通っても当たりうる（どれも字だけでできている）ので、別に見る。
 */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/**
 * ファイル名の長さの上限。
 *
 * Windows のパス全体の上限（260 文字）から、置き場と拡張子と番号のぶんを残す。作品が
 * 付けた名前は長くなりうるので、切った結果が重なることを前提に、下の採番で分ける。
 */
const NAME_LENGTH = 64

/**
 * ターゲットの名前を、ファイル名にできる綴りへ落とす。重なったら番号で分ける。
 *
 * Scratch は `/` `\` `:` を含む名前を許す。そのまま書き出すと、別のディレクトリへ
 * 書こうとするか、書き出しごと失敗する。
 *
 * 落とした結果が重なることはある（`A/B` と `A:B` はどちらも `A_B` になる）。黙って
 * 上書きすると、2 つのターゲットのうち片方が消える。番号で分けたうえで、元の名前との
 * 対応を要約へ残す。
 *
 * `names` は現れた順のターゲット名
 * 戻りは同じ並びの、ファイル名にできる綴り
 */
export function stemsFor(names: string[]): string[] {
  /**
   * 既に配った綴り。基の名前でなく、配った結果そのものを覚える。
   *
   * 覚えるのは畳んだ形である（`foldedName` を参照）。文字列の一致で数えると、
   * `Cat` と `cat` を別の名前として配ってしまい、Windows と macOS では同じファイルに
   * なって片方が消える（CP6 でこの機械の NTFS 上に実測）
   */
  const taken = new Set()

  /**
   * 基の綴りごとに、次に試す番号。
   *
   * 毎回 2 から数え直すと、同じ名前が並んだときに採番が件数の二乗になる（CP6 で実測。
   * 4,000 件で 2,680 ms。逃げ道は最小ターゲットを 438 → 24 バイトへ下げるので、
   * 上限の内側に収まる件数が 18 倍になり、二乗がそのまま効く）
   */
  const nextNth = new Map()

  return names.map(name => {
    // 切り詰めは表示用の `clip` に任せない。あれは省略の印（…）を足すので、自分で
    // 立てた許可リストを自分で破る。符号位置で切るのは、UTF-16 の単位で切ると
    // サロゲート対を割って別の名前と重なりうるため（CP6 の指摘）
    const safe = [...String(name).replace(NAME_SAFE, "_")].slice(0, NAME_LENGTH).join("")
    // 全部が落ちると空になる（記号だけの名前）。予約語もここで避ける
    const base = safe === "" || RESERVED.test(safe) ? `_${safe}` : safe

    // 番号を付けた綴りが、別の名前として既に配られていることがある（`A:B` を
    // `A_B-2` へ逃がした先に、`A_B-2` という名前のターゲットが居る）。基の名前だけを
    // 数えると、逃がした先で 2 度目の衝突が起きて黙って上書きする（2026-08-20 実測）。
    // 配った結果を覚え、空くまで番号を進める
    const key = foldedName(base)
    let nth = nextNth.get(key) ?? 2
    let stem = base
    while (taken.has(foldedName(stem))) {
      stem = `${base}-${nth}`
      nth += 1
    }
    nextNth.set(key, nth)
    taken.add(foldedName(stem))
    return stem
  })
}

/**
 * ファイル名を、ファイルシステムが同じと見なす形へ畳む。
 *
 * Windows（NTFS）と macOS（APFS の既定）は大文字小文字を区別しない。macOS はさらに
 * 合成済みと分解済みを同じ名前として扱う。JavaScript の文字列の一致はどちらも別物と
 * 数えるので、そのまま使うと「重ならない」と判断した綴りが実際には重なる。
 *
 * 畳むのは**重なりを数えるときだけ**である。書き出す名前は元の綴りのまま残す ── 畳んだ
 * 綴りで書くと、大文字を含む名前が読み手の知らない形へ変わる。
 */
export function foldedName(name: string): string {
  return name.normalize("NFC").toLowerCase()
}

/**
 * 逆変換器が知らないブロックを、印へ差し替えた表を作る。
 *
 * 元の表は書き換えない。呼び出し元が同じ表を別の用途（集計・復元）でも使うため。
 *
 * 差し替え先は置き場で決まる。逆変換器は未知の opcode を、文の位置では黙って落とし、
 * 値の枠では投げる（2026-08-20 実測）。どちらも手当てが要るが、替える先が違う。
 *
 * **`shadow` の自己申告は信じない。** 影は「値の枠に置かれた」ことで影なのであって、
 * 旗が立っているから影なのではない。旗だけを見ていたとき、文の並びに影を名乗る未知の
 * ブロックを置くと差し替えを免れ、逆変換器が黙って落とし、集計は「影として親の行に
 * 出る」と嘘をついた（CP6 で実測）。置き場で決め、旗は値の枠に居るときだけ効かせる。
 *
 * **差し替えたブロックの中身を捨てない。** 以前は `inputs` を空にしていたため、未知の
 * C 型の中身と値の枠に差さった**読めるブロック**がまとめて消えていた（CP6 で実測。
 * ブロック 5 件の作品が 2 行になった）。中身は先頭のブロックとして切り出し、記法の
 * 別のスクリプトとして出す。元の位置は失うが、消すよりは残る。
 *
 * `locale` は記法の言語で、印の綴りがこれに従う。
 */
export function markedBlocks(
  blocks: Record<string, unknown>,
  locale: string = LOCALE,
): Record<string, unknown> {
  const reverse = reverseOpcodes()
  const { asValue, asStatement } = positionsIn(blocks)

  /**
   * 切り出して先頭へ上げる中身。差し替えたブロックが抱えていた**文**である。
   *
   * 値は上げない。逆変換器はレポーターから記法を書き起こせず、先頭へ上げると
   * `toScratchblocks` が投げる（実測）。値は下の印の引数として行内に残す
   */
  const detached = new Set()
  for (const [id, block] of Object.entries(blocks)) {
    if (knownEnough(block, reverse, asValue.has(id))) continue
    for (const child of statementChildrenOf(block)) {
      if (Object.hasOwn(blocks, child) && asKeyed(blocks[child])?.shadow !== true) {
        detached.add(child)
      }
    }
  }

  // 素の `{}` へ積むと、ID が `__proto__` のブロックだけが持ち物にならず消える
  // （`JSON.parse` は持ち物として作るので、作品には現れる）。Map で組み立ててから移す
  const out = new Map<string, unknown>()
  for (const [id, raw] of Object.entries(blocks)) {
    const block = asKeyed(raw)
    const promoted = block && detached.has(id) ? { ...block, parent: null, topLevel: true } : raw
    // 守りは分岐の前で掛ける。印を立てる側も入力を残すので、そのまま渡す側にだけ
    // 掛けていると、落とさなかった入力から偽の印を立てられる
    const safeBlock = guarded(promoted)
    // 対応として読めないものは印を立てる形も持たない。守りだけ掛けてそのまま渡す
    if (!block || knownEnough(raw, reverse, asValue.has(id))) {
      out.set(id, safeBlock)
      continue
    }

    // 入力の綴りをそのまま印へ入れない。括弧を名乗られると偽の印になり、
    // `%` を入れられると引数の目印として読まれてターゲットが丸ごと落ちる
    const safe = escaped(spelled(String(block.opcode)), ARGUMENT_MARK)
    const spell = `${SENTINEL_OPEN}${markOf(locale)}${safe}${SENTINEL_CLOSE}`
    const values = valueChildrenOf(raw, blocks)
    out.set(
      id,
      asValue.has(id)
        ? valueMark(asKeyed(safeBlock) ?? block, spell, values.length)
        : statementMark(asKeyed(safeBlock) ?? block, spell, values),
    )
  }
  return Object.fromEntries(out)
}


/**
 * そのまま渡すブロックから、印の括弧を落とす。
 *
 * 独自ブロックの名前は利用者が決められる。印と同じ綴りを名乗られると、記法へ戻した
 * 後では本物の印と区別が付かない（CP6 で実測）。名乗れる材料を渡さない。
 *
 * 守るのは名前だけでなく、欄の値と入力に書いた値も含む。`proccode` だけを守っていた
 * ころは、変数の名前へ印の綴りを書くだけで「読み取れない」と名乗る行を作れた
 * （2026-08-22 実測。読めているブロックに偽の印が立つ）。
 *
 * ブロックの ID は守らない。ID は参照であって綴りが読み手へ出ないので、守ると
 * 参照の先を失う。
 */
function guarded(raw: unknown): unknown {
  const block = asKeyed(raw)
  if (!block) return raw

  const guardedBlock: Record<string, unknown> = { ...block }
  const mutation = asKeyed(block.mutation)
  const proccode = mutation?.proccode
  if (typeof proccode === "string") {
    guardedBlock.mutation = { ...mutation, proccode: spelled(proccode) }
  }
  // 欄は `{ 名前: [値, ID] }`。値だけを守る。名前を持つ欄も同じ守りを通る ── 記法へ
  // 載る綴りである点で違いが無く、区別が要るのは戻す側である（`spelled` を参照）
  const fields = asKeyed(block.fields)
  if (fields) {
    guardedBlock.fields = mappedWithKey(fields, entry => {
      // 欄が文字列そのものでも守る。逆変換器は添字で読むので先頭の 1 文字が記法へ出る。
      // 印は名乗れないが、入力から括弧を必ず印へ変えるという約束は破れる（実測）
      if (typeof entry === "string") return spelled(entry)
      const list = listOf(entry)
      if (!list) return entry
      return [deepGuard(list[0], spelled), ...list.slice(1)]
    })
  }
  // 入力は `{ 名前: [種別, 中身, ...] }`。中身は原始値の並び（`[10, "文字"]`・
  // `[12, "変数名", "ID"]`）かブロックの ID である。並びの 2 つ目だけを守る
  const inputs = asKeyed(block.inputs)
  if (inputs) {
    guardedBlock.inputs = mapped(inputs, entry => {
      // 入力が文字列そのものでも守る（欄と同じ理由）
      if (typeof entry === "string") return spelled(entry)
      const list = listOf(entry)
      if (!list) return entry
      return list.map(item => {
        const primitive = listOf(item)
        // 並びでないものはブロックの ID である。参照なので触らない
        if (!primitive) return item
        return [primitive[0], deepGuard(primitive[1], spelled), ...primitive.slice(2)]
      })
    })
  }
  return guardedBlock
}

/**
 * 並びとして読める値を、本物の並びにして返す。読めないなら null。
 *
 * **逆変換器が読む形に合わせる。** こちらが `Array.isArray` で見て、逆変換器が添字で
 * 読むと、対応（`{ 0: "…", 1: "…" }`）が守りだけを素通りして記法へ届く。作品の側から
 * 印を名乗れる穴になっていた（2026-08-22 実測。欄・入力・入れ子の 3 経路で成立した）。
 *
 * 形を揃えて渡すのは、記法を組み立てる経路だけである。作品定義は別の口が元の値から
 * 組むので、ここで揃えても書き出す .sb3 の中身は変わらない。
 */
function listOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return null
  // 添字は捨てずに置き直す。詰めて並べると `{ 1: … }` が 0 番へ動き、逆変換器が読めなく
  // なる ── 守りを足したせいで読めていたものが落ちる
  const list: unknown[] = []
  for (const [key, item] of Object.entries(value)) {
    const index = Number(key)
    // 添字でないキーを持つなら並びではない。触らずに返す（逆変換器も添字で読めない）
    if (!Number.isInteger(index) || index < 0 || index > SLOT_LIMIT) return null
    list[index] = item
  }
  return list
}

/**
 * 並びとして読み直す添字の上限。
 *
 * 現象から導く。.sb3 の入力は `[種別, 中身, 影]` の 3 つ、欄は `[値, ID]` の 2 つで、
 * 実際に使う添字は 0〜2 である。上限が無いと `{ 4294967294: 1 }` のような対応から
 * 40 億要素の疎な並びを作らされる。線は実際の最大（2）の十数倍へ置く ── 逆変換器が
 * 読む形が増えても当たらず、量としては無害な範囲である。
 */
const SLOT_LIMIT = 32

/**
 * 入れ子の奥にある文字列まで守りを掛ける。
 *
 * 守りは文字列にしか効かないので、1 段だけ見る形だと `["⟪…⟫"]` のように 1 枚包んだ
 * 値が素通りする。逆変換器は最後に文字へ均すので、包みは印を隠す道になる
 * （2026-08-22 実測）。
 */
function deepGuard(value: unknown, guard: (text: string) => string): unknown {
  if (typeof value === "string") return guard(value)
  if (Array.isArray(value)) return value.map(item => deepGuard(item, guard))
  const fields = asKeyed(value)
  if (fields) return mapped(fields, item => deepGuard(item, guard))
  return value
}

/**
 * 対応の値だけを写して作り直す。
 *
 * 素の `{}` へ添字代入で積まない。`__proto__` を名前に持つ欄が持ち物にならず消える。
 */
function mapped(
  source: Record<string, unknown>,
  change: (value: unknown) => unknown,
): Record<string, unknown> {
  return mappedWithKey(source, value => change(value))
}

/**
 * 対応の値を、キーも見ながら写して作り直す。
 */
function mappedWithKey(
  source: Record<string, unknown>,
  change: (value: unknown, key: string) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, change(value, key)]),
  )
}

/**
 * そのブロックを、差し替えずにそのまま渡してよいか。
 *
 * `reverse` は逆変換器が知る opcode
 * `inValue` は値の枠に置かれているか
 */
function knownEnough(block: unknown, reverse: Set<string>, inValue: boolean): boolean {
  // 旧実装は並びを除いていた（並びのブロックはそのまま渡す）。正典で書く
  if (!TYPES.対応(block)) return true
  const fields = block
  if (typeof fields.opcode !== "string") return true
  if (reverse.has(fields.opcode)) return true
  // 値の枠に居る影だけは、旗を信じてそのまま渡す。逆変換器が欄を親の行へ直に描く
  return inValue && fields.shadow === true
}

/**
 * 印を文として置く。
 *
 * `values` は値の枠に中身を持つ入力の名前
 */
function statementMark(
  block: Record<string, unknown>,
  spell: string,
  values: string[],
): Record<string, unknown> {
  // 値の中身は引数として行内に残す。空にすると、そこに差さっていた読めるブロックが
  // まとめて消える（CP6 で実測）。呼び出しの綴りへ `%s` を値の数だけ足し、
  // その入力だけを持たせる
  const written = asKeyed(block.inputs) ?? {}
  const inputs = Object.fromEntries(values.map(name => [name, written[name]]))
  return {
    ...block,
    opcode: "procedures_call",
    inputs,
    fields: {},
    mutation: {
      tagName: "mutation",
      children: [],
      proccode: `${spell}${" %s".repeat(values.length)}`,
      argumentids: JSON.stringify(values),
      argumentnames: JSON.stringify(values.map(() => "値")),
      argumentdefaults: JSON.stringify(values.map(() => "")),
      warp: "false",
    },
  }
}

/**
 * 印を値として置く。文の呼び出しへ替えると親の行ごと壊れる。
 *
 * `lost` は記法へ残せなかった中身の件数
 */
function valueMark(
  block: Record<string, unknown>,
  spell: string,
  lost: number,
): Record<string, unknown> {
  // 値の位置に置く印は引数を取れない（レポーターに引数の枠が無い）。中に差さっていた
  // 値は記法へ残せないので、件数を印そのものへ書いて黙って落とさない。
  //
  // 末尾から詰める。最初の閉じ括弧を置き換える形だと、印の中身に現れるこちらの印
  // （`⟪U+27EB⟫`）の閉じ括弧を掴んでしまう（CP6 で実測）
  const shown =
    lost === 0
      ? spell
      : `${spell.slice(0, -SENTINEL_CLOSE.length)}（値 ${lost} 件を落とした）${SENTINEL_CLOSE}`
  return { ...block, opcode: "argument_reporter_string_number", inputs: {}, fields: { VALUE: [shown, null] } }
}

/**
 * ブロックが入力から指している ID を集める。C 型の中身も値も区別せずに取る。
 */
function statementChildrenOf(block: unknown): string[] {
  const found = []
  for (const [name, input] of Object.entries(asKeyed(asKeyed(block)?.inputs) ?? {})) {
    if (!name.startsWith("SUBSTACK") || !Array.isArray(input)) continue
    for (const item of input.slice(1)) {
      if (typeof item === "string") found.push(item)
    }
  }
  return found
}

/**
 * 値の枠に差さっているブロックを持つ入力の名前を集める。
 *
 * 素の値（`[4, "10"]` のような並び）は数えない。逆変換器はそれを親の行へ直に描くので、
 * 引数へ移し替える必要が無い。
 */
function valueChildrenOf(block: unknown, blocks: Record<string, unknown>): string[] {
  const found = []
  for (const [name, input] of Object.entries(asKeyed(asKeyed(block)?.inputs) ?? {})) {
    if (name.startsWith("SUBSTACK") || !Array.isArray(input)) continue
    const holds = input.slice(1).some(item => typeof item === "string" && Object.hasOwn(blocks, item))
    if (holds) found.push(name)
  }
  return found
}

/**
 * ブロックの置き場を、表の形から決める。
 *
 * 未知のブロックは形が分からない。文なのか値なのかは、**置かれている場所**から決める
 * ほかない。
 *
 * C 型の中身（`SUBSTACK`）は入力に入っているが文の並びである。名前で除く ── Scratch の
 * 直列化器も拡張機能も、C 型の中身はこの綴りで書く。
 *
 * 次のブロックを持つもの・先頭のもの・別のブロックの `next` から指されているものは、
 * 入力から指されていても文として扱う。値として置き換えると `next` の先が丸ごと消える。
 */
function positionsIn(blocks: Record<string, unknown>): { asValue: Set<string>, asStatement: Set<string> } {
  const asValue = new Set<string>()
  const asStatement = new Set<string>()

  for (const raw of Object.values(blocks)) {
    const block = asKeyed(raw)
    if (!block) continue
    if (typeof block.next === "string") asStatement.add(block.next)
    for (const [name, input] of Object.entries(asKeyed(block.inputs) ?? {})) {
      if (!Array.isArray(input)) continue
      const into = name.startsWith("SUBSTACK") ? asStatement : asValue
      for (const item of input.slice(1)) {
        if (typeof item === "string") into.add(item)
      }
    }
  }

  for (const [id, raw] of Object.entries(blocks)) {
    const block = asKeyed(raw)
    if (typeof block?.next === "string" || block?.topLevel === true) asStatement.add(id)
    if (asStatement.has(id)) asValue.delete(id)
  }
  return { asValue, asStatement }
}

/**
 * 差し替えた行を、記法のコメントへ直す。
 *
 * `locale` は記法の言語。印の綴りがこれに従う
 */
function unmark(notation: string, locale: string): string {
  const pattern = sentinelLine(locale)
  return notation
    .split("\n")
    .map(line => {
      const hit = pattern.exec(line)
      return hit ? `${hit[1]}// ${hit[2]}` : line
    })
    .join("\n")
}

/** 要約の見出しの下線 */
const SUMMARY_RULE = "=".repeat(24)

/**
 * 読み取りの結果を、構造の要約（markdown）にする。
 *
 * 件数は必ず読み取りの結果から数える。散文へ引き写すと、実装が動いたときに要約だけが
 * 誤りになり、しかも検査が緑のまま通る。
 *
 * 名前は中和して載せる。他者の .sb3 は名前に制御文字を入れられる。要約は人が開いて読む
 * ものなので、表示順を覆す文字や画面を消す列がそのまま届くと、要約そのものを偽装できる。
 *
 * `subject` は入力の名。`options` は書き出す側だけが知ることを受け取る ── 読み取りは
 * 図を描かないので、落ちた図も、実際に書いたファイルの名前も、図の形式も、読み取りの
 * 結果からは分からない。
 */
export function summaryOf(
  reading: Reading,
  subject: string,
  options: {
    undrawn?: Problem[]
    unfit?: Problem[]
    files?: Map<string, string[]>
    format?: string
  } = {},
): string {
  const { targets, used, problems, refused = [] } = reading
  const refusedSet = new Set(refused)
  const scripts = targets.reduce((sum, target) => sum + target.scripts.length, 0)
  const blocks = used.reduce((sum, item) => sum + item.count, 0)

  const lines = [
    `${neutralize(subject)} の読み取り`,
    SUMMARY_RULE,
    "",
    ...caveatSection(refused, options.format, {
      // 断りは、その実行で実際に置いた先と実際に落ちた量を述べる。静的な文だと、
      // 何も落ちていない読み取りでも「落とした」と読める行が並ぶ。
      // 図は「形式が SVG か」でなく「実際に書いたか」で数える ── 1 枚も書けなかった
      // 実行で「図の先頭にも置いた」と述べていた（CP6 の指摘）
      definition: (options.unfit ?? []).length === 0,
      figures: drawnCount(options.files),
      dropped: (reading.dropped ?? []).length,
      droppedValues: (reading.droppedValues ?? []).length,
      undrawn: (options.undrawn ?? []).length,
    }),
    "## 全体",
    "",
    "| 見るもの | 件数 |",
    "|---|---|",
    `| ターゲット | ${targets.length} |`,
    `| スクリプト | ${scripts} |`,
    `| ブロック | ${blocks} |`,
    "",
    "## ターゲット",
    "",
    "書き出したファイルの名前は、元の名前から作れないことがある。Scratch は `/` や `:` を",
    "含む名前を許すため、置ける文字だけを残して落とし、重なったら番号で分ける。",
    "",
    "| 名前 | 書き出したファイル | スクリプト |",
    "|---|---|---|",
    ...targets.map(target => {
      const written = options.files?.get(target.stem)
      const files = fileCell(written, target.stem)
      return `| ${cell(target.name)} | ${files} | ${target.scripts.length} |`
    }),
    "",
    ...declarations(targets),
    ...unrestoredSection(reading.unrestored ?? []),
    "## 使ったブロック",
    "",
    "| opcode | 件数 | 区分 |",
    "|---|---|---|",
    ...used.map(item => `| ${cell(item.opcode)} | ${item.count} | ${item.coverage} |`),
    "",
    ...coverageSection(used),
    ...undrawnSection(options.undrawn ?? []),
    ...unfitSection(options.unfit ?? []),
    ...typefaceSection(options.format),
    // 検証器の拒否は断りの節が引き受ける。両方へ載せると、読み切れなかった箇所の節が
    // 「記法にも図にもなっていない」と偽を述べ、件数も二重になる（CP6 で 7 観点が指摘）。
    // 分けるのは実体の同一性で行う。種類の綴りで分けると、綴りを変えた瞬間に黙って戻る
    ...announced(problems.filter(problem => !refusedSet.has(problem))),
  ]
  return `${lines.join("\n").trimEnd()}\n`
}

/**
 * その実行で実際に書いた図の本数を数える。
 *
 * 形式が SVG かどうかでは数えない。全スクリプトが図にできなかった実行でも形式は SVG の
 * ままなので、置いていない図を「置いた」と案内することになる（CP6 の指摘）。
 *
 * `files` はターゲットごとの書き出したファイル名
 */
function drawnCount(files: Map<string, string[]> | undefined): number {
  let count = 0
  for (const written of files?.values() ?? []) count += written.length
  return count
}

/**
 * 断りを実際に置いた先を述べる。
 *
 * 置いていない先を案内しない。図の形式でも定義の可否でも枝が変わる。
 *
 * `hasDefinition` は作品定義を書くか
 * `figures` は実際に書いた図の本数
 */
function placedNotice(hasDefinition: boolean, format: string | undefined, figures: number): string[] {
  // 図は「形式が SVG か」でなく「実際に書いたか」で数える。1 枚も書けなかった実行でも
  // 形式は SVG のままなので、置いていない図を案内することになる（CP6 の指摘）
  const inFigures = figures > 0 && format === "svg"
  const placed = [
    ...(hasDefinition ? ["`project.yaml`"] : []),
    ...(inFigures ? ["図（SVG）"] : []),
  ]
  // 置けない先も名指す。名指さないと、読み手は「そこにも在るはず」と探す。1 枚も
  // 書いていない実行では図に触れない ── 無いものの置けなさを述べても読み手は探せない
  const asImage = figures > 0 && format !== "svg"
  const cannot = ["記法（`.sbk`）", ...(asImage ? ["図（PNG）"] : [])]
  const why = asImage
    ? "記法にコメントの構文が無く、PNG は像なので、どちらも断りを持てない。"
    : "記法にコメントの構文が無く、置くと組み立てが止まる。"

  if (placed.length === 0) {
    return [
      `同じ断りを置ける先がこの実行には無い。${cannot.join("と")}には置けない ──`,
      why,
      "この節が引き受ける。",
    ]
  }
  return [
    `${placed.join("と")}の先頭にも同じ断りを置いた。${cannot.join("と")}には`,
    `置けない ── ${why}`,
  ]
}

/**
 * その実行で実際に落ちた量を述べる。
 *
 * 断りの節が静的だと、何も落ちていない読み取りでも「落とした」と読める行が並ぶ
 * （TASK0015 の CP6 が指摘）。落ちていないものは書かない。
 *
 *   実際に落ちた量
 */
function lostCounts(placed: { dropped?: number, undrawn?: number, droppedValues?: number }): string[] {
  const lines = []
  if (placed.dropped) {
    lines.push(`- 記法へ戻せず落としたターゲットが ${placed.dropped} 件ある`)
  }
  if (placed.undrawn) {
    lines.push(
      `- 図にできなかったスクリプトが ${placed.undrawn} 本ある（記法には入っている）`,
    )
  }
  // 宣言の落ちも数える。静的な断りを動的な件数へ置き換えたときに、この 1 区分だけが
  // 抜けていた（CP6 の指摘）。落ちた宣言は作品定義に並ばないので、読み手が
  // 組み立て直したときに変数が無い理由がここに要る
  if (placed.droppedValues) {
    lines.push(
      `- 読めない値や重なった名前で落とした宣言が ${placed.droppedValues} 件ある`,
    )
  }
  if (lines.length === 0) {
    lines.push("- この読み取りでは、ターゲットも図も宣言も落としていない")
  }
  return lines
}

/**
 * 逃げ道を通して読んだことと、そのとき保証しないことを要約へ載せる。
 *
 * 申告は stderr へ流れて消える。読み手が後から開くのは成果物の側なので、断りは
 * ここにも要る。落ち方は測って分かったものだけを書く（2026-08-20 実測）。
 *
 * `refused` は検証器が弾いた理由で、空なら節ごと出さない。`format` は図の形式で、
 * 断りを置いた先を述べ分ける。`placed` はその実行で実際に置いたものと落とした量 ──
 * 静的な文にすると、書いていない `project.yaml` や図を案内し、落としていないのに
 * 「落とした」と読める行が並ぶ。
 */
function caveatSection(
  refused: Problem[],
  format: string | undefined,
  placed: {
    definition: boolean
    figures: number
    dropped: number
    droppedValues: number
    undrawn: number
  },
): string[] {
  if (refused.length === 0) return []
  const hasDefinition = placed.definition
  return [
    "## 逃げ道を通して読んだ",
    "",
    "Scratch 公式の検証器はこの作品を弾いた。`--anyway` が付いていたので、読める",
    "ところまで読んで書き出した。次のことは保証しない。",
    "",
    "- Scratch エディタで開けるとは限らない（検証器が弾いた作品である）",
    ...(hasDefinition
      ? ["- `project.yaml` から組み立て直せるとは限らない"]
      : [
          "- 復元した定義が組み立ての規則を通らなかったので、`project.yaml` は",
          "  書いていない",
        ]),
    "- 記法が実物と食い違うことがある。読めないブロックには印が入るが、opcode を",
    "  欠いたブロックは逆変換器が黙って落とす",
    "- 下の件数は、読めた範囲で数えた値である",
    ...lostCounts(placed),
    "",
    // 置いた先は、その実行で実際に置いた先だけを述べる。固定文にすると、PNG のときに
    // 置いていない図を案内し（CP6 で 2 観点が実測）、定義を落とした実行でも
    // 「`project.yaml` の先頭にも置いた」と偽を述べる（2026-08-22 実測）
    ...placedNotice(hasDefinition, format, placed.figures),
    "",
    REFUSAL_LEAD,
    "",
    // 節の前置きが既に「弾いた理由」と名乗っているので、種類は繰り返さない。理由を
    // 持たない申告のときだけ種類を出す。
    //
    // 端末向けの切り詰めをそのまま継がない。要約は後から開いて読むもので、続きを見る
    // 手段が無いまま切られると読み手はそこで止まる（TASK0015 の CP6 が指摘）
    ...refused.map(problem => {
      const reason = problem.full || problem.detail || problem.kind
      return `- ${cell(reason)}`
    }),
    "",
  ]
}

/**
 * 対応表の升に、書き出した実ファイルの名前を並べる。
 *
 * 幹だけを載せると、実ファイル（`<幹>.sbk` / `<幹>-<n>.<形式>`）と字面が一致せず、
 * 表から辿れない（CP6 の指摘）。書き出した側が数えた名前をそのまま出すので、図が
 * 落ちた番号は表にも現れない。
 *
 * 本数が多いときは頭だけを出す。2000 本の名前を 1 つの升へ並べても、引く道具にならない。
 *
 * `written` は書き出した名前。渡らなければ幹だけを出す
 */
function fileCell(written: string[] | undefined, stem: string): string {
  if (written === undefined) return `\`${cell(stem)}\``
  if (written.length === 0) return "なし"
  const quoted = written.map(name => `\`${cell(name)}\``)
  if (quoted.length <= FILE_CELL_LIMIT) return quoted.join("・")
  const head = quoted.slice(0, FILE_CELL_LIMIT).join("・")
  return `${head}・ほか ${quoted.length - FILE_CELL_LIMIT} 件`
}

/** 対応表の 1 升へ並べるファイル名の数。読み手が字面を追える範囲に留める */
const FILE_CELL_LIMIT = 4

/**
 * 作品定義を書き出さなかったことを要約へ載せる。
 *
 * 定義を落とすのは、この道具がする「落とす」の中でいちばん大きい。それが申告にしか
 * 出ないと、成果物を後から開いた人には作品定義が**最初から無かったのか落ちたのか**が
 * 見分けられない（CP6 の指摘）。落とすなら成果物の側に痕跡を残す、という本作業の軸を
 * この経路にも当てる。
 *
 * `unfit` は定義が組み立てを通らなかった理由。空なら節ごと出さない
 */
function unfitSection(unfit: Problem[]): string[] {
  if (unfit.length === 0) return []
  return [
    "",
    `## 作品定義を書き出さなかった（${unfit.length} 件）`,
    "",
    "復元した定義が組み立ての規則を通らなかったので、`project.yaml` は書いていない。",
    "記法・図・この要約は読めた範囲で書いてある。",
    "",
    ...unfit.map(problem => {
      const detail = problem.detail ? ` ── ${cell(problem.detail)}` : ""
      return `- **${cell(problem.kind)}**: ${cell(problem.subject)}${detail}`
    }),
  ]
}

/**
 * 図の見え方の断りを要約へ載せる。
 *
 * SVG は書体を名前でしか参照しない。寸法は書き出した機械の文字の幅で決めてあるので、
 * その書体を持たない機械で開くと文字が枠を越えうる。**実測していない**（測るより断りを
 * 置いて受容する裁定。2026-08-21）。PNG は書き出した時点で像になっているので当たらない。
 */
function typefaceSection(format: string | undefined): string[] {
  if (format !== "svg") return []
  return [
    "",
    "## 図の見え方",
    "",
    "図（SVG）は書体を名前で参照する。枠の寸法は書き出した機械の文字の幅で決めてあるので、",
    "同じ書体を持たない機械で開くと、文字が枠を越えて見えることがある。図の中身が違うので",
    "はなく、見え方だけの違いである。どの程度ずれるかは測っていない。",
  ]
}

/**
 * 復元しない属性を要約へ載せる。
 *
 * 断りがソースの doc にしかないと、成果物を受け取った人には読めない。組み立て直した
 * 作品の見た目が元と違う理由が、どこにも書かれていない状態になる（CP6 の指摘）。
 *
 * 欄の名前は .sb3 のものをそのまま出す。日本語の言い換えを添えると、その対応表を手で
 * 保つことになり、.sb3 の形が変わったときに言い換えだけが古びる。
 */
function unrestoredSection(unrestored: string[]): string[] {
  if (unrestored.length === 0) return []
  // 先頭に空行を置かない。この節が続く `declarations` は末尾に空行を持つので、置くと
  // ここだけ空行が 2 つになる
  return [
    `## 復元しない属性（${unrestored.length} 種）`,
    "",
    "この作品が持っているが、`project.yaml` へ写さない .sb3 の欄である。組み立て直すと",
    "既定の値になるので、元と見た目が違うことがある。括弧の中が .sb3 の欄の名前である。",
    "",
    "`broadcasts`（メッセージ）は宣言としては写らない。記法の中で使われたものは組み立てが",
    "作り直すが、宣言だけで使われていないものは消える。",
    "",
    ...unrestored.map(field => `- ${cell(fieldLabel(field))}`),
    "",
  ]
}

/**
 * 図にならなかったスクリプトを要約へ載せる。
 *
 * 読み切れなかった箇所とは別の節にする。あちらは「記法にも図にもなっていない」と
 * 名乗っており、記法にはなったが図にできなかったものを混ぜると、その一文が偽になる。
 */
function undrawnSection(undrawn: Problem[]): string[] {
  if (undrawn.length === 0) return []
  return [
    "",
    `## 図にならなかったスクリプト（${undrawn.length} 本）`,
    "",
    "記法（`.sbk`）には入っているが、図にできなかった。図の番号はターゲットごとに",
    "スクリプトの順で振るので、欠けた番号がここに挙がったものに当たる。",
    "",
    ...undrawn.map(problem => {
      const detail = problem.detail ? ` ── ${cell(problem.detail)}` : ""
      return `- **${cell(problem.kind)}**: ${cell(problem.subject)}${detail}`
    }),
  ]
}

/**
 * 読み切れなかった箇所を要約へ載せる。
 *
 * 申告は標準エラーへ出るだけで、端末を閉じれば消える。要約は残る成果物なので、
 * これが黙っていると「落としたターゲット」が後から辿れない ── 要約の件数だけを見て
 * 「全部読めた」と受け取れてしまう（CP6 の指摘）。
 */
function announced(problems: Problem[]): string[] {
  const lines = ["", `## 読み切れなかった箇所（${problems.length} 件）`, ""]
  if (problems.length === 0) {
    lines.push("なし。")
    return lines
  }
  lines.push("読み取りが止まった箇所である。ここに挙がったものは記法にも図にもなっていない。", "")
  for (const problem of problems) {
    const detail = problem.detail ? ` ── ${cell(problem.detail)}` : ""
    lines.push(`- **${cell(problem.kind)}**: ${cell(problem.subject)}${detail}`)
  }
  return lines
}

/**
 * 宣言（変数・リスト・メッセージ）の節を組み立てる。
 *
 * 1 件も無い種類は見出しごと落とさず「なし」と書く。落とすと、読み手には「無い」のか
 * 「数え忘れた」のかが分からない。
 */
function declarations(targets: ReadTarget[]): string[] {
  const owned = (pick: (target: ReadTarget) => string[]) =>
    targets.flatMap(target => pick(target).map(name => [target.name, name]))

  const kinds = [
    ["変数", owned(target => Object.keys(target.variables))],
    ["リスト", owned(target => Object.keys(target.lists))],
    ["メッセージ", owned(target => target.broadcasts)],
  ]

  const lines = []
  for (const [label, found] of kinds) {
    lines.push(`## ${label}（${found.length} 件）`, "")
    if (found.length === 0) {
      lines.push("なし", "")
      continue
    }
    lines.push("| 持ち主 | 名前 |", "|---|---|")
    for (const [owner, name] of found) lines.push(`| ${cell(owner)} | ${cell(name)} |`)
    lines.push("")
  }
  return lines
}

/**
 * 被覆の区分ごとの件数と、読み取れなかったものの一覧を組み立てる。
 */
function coverageSection(used: Used[]): string[] {
  const lines = [
    "## 被覆",
    "",
    // 区分の語をその場で言い換える。どのドキュメントも定義しておらず、要約だけを
    // 受け取った人には読めなかった（TASK0015 の CP6 が指摘）
    "**台帳**は日本語のブロック記法とブロックの対応表、**逆変換器**は .sb3 のブロックを",
    "記法へ書き戻す部品である。どちらが知っているかで、読める向きと書ける向きが決まる。",
    "",
    "| 区分 | 種類 | 件数 |",
    "|---|---|---|",
  ]
  for (const coverage of Object.values(COVERAGE)) {
    const rows = used.filter(item => item.coverage === coverage)
    const count = rows.reduce((sum, item) => sum + item.count, 0)
    lines.push(`| ${coverage} | ${rows.length} | ${count} |`)
  }

  // 記法へ印として残したもの。要約と記法で同じものを指していることが読めるようにする
  const marked = used.filter(
    item => item.coverage === COVERAGE.NEITHER || item.coverage === COVERAGE.CATALOG_ONLY,
  )
  lines.push("", `## 記法に印を残したブロック（${marked.length} 種）`, "")
  if (marked.length === 0) {
    lines.push("なし。すべてのブロックが記法へ落ちた。")
  } else {
    lines.push(
      "記法の該当箇所に印が入っている。文の位置なら `// 読み取れない: <opcode>` の行、",
      "値の枠なら `⟪読み取れない: <opcode>⟫` が行の途中に出る（行末までを飲むコメントに",
      "すると、後ろのブロックまで消えるため）。`--locale en` を渡した記法では、印の",
      "綴りも英語（`unreadable:`）になる。",
      "",
    )
    for (const item of marked) lines.push(`- ${cell(item.opcode)} ${item.count} 件`)
  }

  const oneWay = used.filter(item => item.coverage === COVERAGE.REVERSE_ONLY)
  lines.push("", `## 生成の向きへ戻せないブロック（${oneWay.length} 種）`, "")
  if (oneWay.length === 0) {
    lines.push("なし。")
  } else {
    lines.push("記法へは落ちるが、台帳に無いので作品定義からは組み立て直せない。", "")
    for (const item of oneWay) lines.push(`- ${cell(item.opcode)} ${item.count} 件`)
  }
  return lines
}

/**
 * 表の升に置く綴りにする。中和したうえで、表を割る文字を逃がす。
 */
function cell(text: string): string {
  // markdown として意味を持つ文字を逃がす。升を割る縦棒だけを見ていたとき、逆引用符で
  // コード表記を抜け、`<` で HTML として描かれる余地が残っていた（CP6 の指摘）。
  // 逆斜線を先に逃がす ── 後にすると、こちらが足した逃がしをさらに逃がしてしまう
  // 逆斜線と逆引用符は符号位置で書く。この綴りを直に書くと、道具の層で 1 段縮んだり
  // テンプレートを閉じたりして、意図と違う文字列が黙って入る（本作業で 4 度踏んだ）
  //
  // `[` はリンクと画像の入口である。塞ぐまでは、ターゲット名へ
  // `[クリック](https://…)` を仕込むだけで要約に活きたリンクが立った（2026-08-22 実測。
  // 正当な .sb3・旗なし・終了コード 0）。`]` は要らない ── 開きを逃がせば対にならない。
  //
  // **これは拒否リストである。** 升の中で残るのは強調と実体参照で、どちらも見た目を
  // 変えるだけで行き先を作らない。行の頭でしか働く記法（見出し・引用・箇条書き・
  // 参照の定義）は升が `| ` で始まるので届かない。中和が制御文字と改行を先に落として
  // いるので、升の外へ出る道は残っていない
  const escape = "\u005c"
  let out = neutralize(text)
  for (const mark of [escape, "|", "\u0060", "<", "["]) {
    out = out.replaceAll(mark, escape + mark)
  }
  return out
}

/**
 * 読み取った内容から、TASK0001 の入力形式（作品定義）を組み立てる。
 *
 * 復元するのは project.json が持つものだけである。コスチュームと音は復元しない
 * （非目標）。作品の呼び名も project.json は持たないので、入力のファイル名を置く。
 *
 * 既定と同じ値は書かない。書いても意味は変わらないが、読み手が「なぜこの値なのか」を
 * 問うことになる。定義の側の既定は `SPRITE_KEYS` が持っており、そこから引く ── ここへ
 * 数を書き写すと、既定が動いたときに復元だけが古びる。
 *
 * `name` は作品の呼び名
 */
export function definitionOf(reading: Reading, name: string): Record<string, unknown> {
  const stage = reading.targets.find(target => target.isStage)
  const sprites = reading.targets.filter(target => !target.isStage)

  const declared = (target: ReadTarget) => ({
    ...(target.scripts.length > 0 ? { スクリプト: `${target.stem}.sbk` } : {}),
    ...(Object.keys(target.variables).length > 0 ? { 変数: target.variables } : {}),
    ...(Object.keys(target.lists).length > 0 ? { リスト: target.lists } : {}),
    ...(target.warped.length > 0 ? { 再描画しないブロック: target.warped } : {}),
  })

  return {
    名前: name,
    ...(stage ? { ステージ: declared(stage) } : {}),
    スプライト: sprites.map(target => ({
      名前: target.name,
      ...declared(target),
      ...placed(target.placement),
    })),
  }
}

/**
 * 画面を再描画しない指定を持つブロック定義を集める。
 *
 * `warp` はプロトタイプの mutation が持つ。記法はこの指定を表せないので、書き出す
 * 作品定義の側へ移さないと往復で消える。
 *
 * 綴りは記法の形へ戻す。内部の綴り（`%s`）で書き出すと、組み立て直すときに利用者が
 * 記法から写せない形になる。
 */
function warpedIn(target: unknown): string[] {
  const blocks = asKeyed(asKeyed(target)?.blocks) ?? {}
  const names = new Set<string>()
  for (const block of Object.values(blocks)) {
    const entry = asKeyed(block)
    if (entry?.opcode !== "procedures_prototype") continue
    const mutation = asKeyed(entry.mutation)
    if (String(mutation?.warp) !== "true") continue
    // 綴りは他人の .sb3 から来る。記法へ載る綴りと同じ守りを通す ── 通さないと
    // 右横書きの上書き（U+202E）や印の括弧が作品定義へ生で出て、同じ 1 回の
    // 読み取りが書く 2 つの成果物で守りが割れる（CP6 で実測）
    const proccode = spelled(String(mutation?.proccode ?? ""))
    if (proccode === "") continue
    let index = 0
    // 同じ綴りの定義が 2 つあっても作品定義には 1 度だけ載せる。並びで持つと
    // 「2 つ挙げた」ように読めるが、指定は綴りに掛かるので重複に意味が無い
    names.add(proccode.replace(/%[sbn]/g, () => `(引数${(index += 1)})`))
  }
  return [...names]
}

/**
 * 置かれ方のうち、既定と違うものだけを書く。
 */
function placed(placement: Record<string, unknown>): Record<string, unknown> {
  const written: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(SPRITE_KEYS)) {
    const value = placement[key]
    if (value === undefined || value === spec.fallback) continue
    written[key] = value
  }
  return written
}
