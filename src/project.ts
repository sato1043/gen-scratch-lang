/**
 * 作品の定義と記法から project.json を組み立てる。
 *
 * 記法はスクリプトしか表せない。スプライトの構成・変数の初期値・コスチュームの指定は
 * 定義（YAML）が持つ。1 つの作品は次の形をとる。
 *
 * ```
 * projects/<作品名>/
 *   project.yaml     スプライト一覧・変数の初期値
 *   stage.sbk        ステージのスクリプト（記法）
 *   <スプライト>.sbk  スプライトごとのスクリプト（記法）
 * ```
 *
 * 名前と ID の割り当ては決定論で行う。Scratch 本体は無作為な ID を振るが、それでは
 * 同じ入力から同じ .sb3 が出ない。ID は名前から導く。
 */
import { readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, resolve, sep, win32 } from "node:path"
import { parse as parseYaml } from "yaml"
import { agentFor, loadCatalog, type LoadedCatalog } from "./catalog.ts"
import {
  COSTUME_FORMATS,
  COSTUME_KEYS,
  DERIVABLE_FORMATS,
  LIST_FALLBACK,
  SOUND_FORMATS,
  SOUND_KEYS,
  SPRITE_KEYS,
  TARGET_KEYS,
  TOP_KEYS,
  TYPES,
  VALUE_TYPES,
  VARIABLE_FALLBACK,
  asMapping,
  fitsType,
} from "./definition.ts"
import { restored, unrestorable } from "./notation.ts"
import { reasonOf } from "./errors.ts"
import { defaultCostume, type Costume } from "./costume.ts"
import {
  COSTUME_REQUIRED,
  SOUND_REQUIRED,
  costumeOf,
  derivable,
  formatOf,
  soundOf,
  type Sound,
} from "./asset.ts"
import { ASSET_FILE_LIMIT } from "./intake.ts"
import { extensionIdOf } from "../catalog/extensions.ts"
import { lineFinder, readNotation } from "./parse.ts"
import { asProccode, serializeScripts } from "./serialize.ts"

/**
 * project.json の meta。`semver` は `3.x.y` の形を要求される。
 *
 * `agent` はここに置かない。台帳の版から組み立てるため、作品ごとに `agentFor` で
 * 埋める。Scratch 公式が「生成した処理系」を入れる欄で、これまで空文字だった。
 */
const META = {
  semver: "3.0.0",
  vm: "0.2.0",
}

export type Problem = {
  kind: string
  subject: string
  detail?: string
}

/**
 * スプライトのキーを読む。書かれていなければ表が持つ既定値を使う。
 *
 * `SPRITE_KEYS` 専用である。名に表を出すのは、`Object.prototype.valueOf` と同名だと
 * 概念が衝突し、ステージにも使えるものと読めてしまうためである。
 *
 * 既定値を直に書かないのは、仕様として書き出す一覧が同じ表から読むため。ここへ
 * 直に書くと、一覧に載る既定値と組み立ての結果が食い違っても誰も気づかない。
 *
 * `source` は定義のスプライト
 */
function spriteFallback(source: unknown, key: string) {
  return asMapping(source)?.[key] ?? SPRITE_KEYS[key].fallback
}

type Built = {
  /** project.json の中身 */
  project: any
  /** zip へ収める素材 */
  assets: { name: string; bytes: Buffer }[]
  problems: Problem[]
}

/** 宣言 1 つ分。値は人が書くので何が来るか分からない */
type Declared = { name: string; value: unknown; id: string }

/**
 * 宣言の値へ印を復す。リストの要素は並びなので深く辿る。
 *
 * 値に文字列でないもの（数・真偽）が混ざるのは正当で、そのまま返す。値の型の検査は
 * 定義の側が別に持つ。
 */
function deepRestore(value: unknown): unknown {
  if (typeof value === "string") return restored(value)
  if (Array.isArray(value)) return value.map(deepRestore)
  return value
}

/**
 * 作品のディレクトリから project.json を組み立てる。
 *
 * `dir` は作品のディレクトリ、`options` は台帳の位置で、壊れた台帳を渡す検査で使う。
 */
export async function buildProject(
  dir: string,
  options: { catalogPath?: string | URL } = {},
): Promise<Built> {
  const problems: Problem[] = []

  let definition
  try {
    definition = parseYaml(readFileSync(join(dir, "project.yaml"), "utf8"))
  } catch (error) {
    return {
      project: null,
      assets: [],
      problems: [{ kind: "作品の定義を読めない", subject: dir, detail: reasonOf(error) }],
    }
  }

  const catalog = loadCatalog(options.catalogPath)
  problems.push(...catalog.problems)
  if (!catalog.raw) {
    // 台帳が無ければ 1 つのブロックも解けない。先へ進むと「台帳に無いブロック」が
    // 記法の数だけ並び、本当の原因（台帳を読めない）が埋もれる
    return { project: null, assets: [], problems }
  }

  const { problems: checked, stage, sprites, declared } = definitionProblems(definition, dir)
  problems.push(...checked)
  /** 放送の名前から ID */
  const broadcasts = new Map<string, string>()
  /**
   * zip へ収める素材。名前が中身の md5 なので、同じ絵を使うターゲットが並ぶと名前が
   * 重なる。zip は同じ名前を 2 度収められないため名前で束ねる
   */
  const assets = new Map<string, Buffer>()
  const targets: any[] = []

  for (const [index, source] of [stage, ...sprites].entries()) {
    const isStage = index === 0
    const name = restored(String(asMapping(source)?.名前 ?? ""))
    if (!isStage && !name) {
      problems.push({
        kind: "スプライトに名前が無い",
        // ステージを先頭に足した並びを回しているので、定義の並びへ戻して数える
        subject: placeIn("スプライト", { index: index - 1 }),
        detail: "定義の 名前 を書く",
      })
      continue
    }

    const blocks = await scriptsOf(source, dir, name, catalog, declared, broadcasts, problems)
    const at = isStage ? placeIn("ステージ") : placeIn("スプライト", { index: index - 1, name })
    const shown = assetsOf(source, dir, isStage, at, assets, problems)

    targets.push(target(isStage, name, source, blocks, declared, shown, index))
  }

  // 放送はステージが持つ。記法に現れた名前をすべて集めてから配る
  if (targets.length > 0) {
    targets[0].broadcasts = Object.fromEntries(
      [...broadcasts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, id]) => [id, n]),
    )
  }

  // 使ったブロックから拡張機能の申告を導く。並びは名前順にする（上流は現れた順に
  // 並べるが、この環境は同じ入力から同じバイト列を出す約束を持つ）
  const extensions = [
    ...new Set(
      targets.flatMap(entry =>
        Object.values(entry.blocks as Record<string, { opcode?: unknown }>)
          .map(block => extensionIdOf(String(block.opcode ?? "")))
          .filter(id => id !== null),
      ),
    ),
  ].sort()

  return {
    project: { targets, extensions, meta: { ...META, agent: agentFor(catalog) } },
    assets: [...assets].map(([name, bytes]) => ({ name, bytes })),
    problems,
  }
}

/**
 * 定義に書かれた素材を読み、コスチュームと音を組む。
 *
 * 1 件も書かれていなければ自前の四角 1 種を持たせる。Scratch の既定素材は同梱しない
 * （憲章の非目標。`costume.ts` が理由を持つ）。
 *
 * 読めない素材はその項を落として先へ進む。1 件で組み立て全体を止めると、残りの素材の
 * 誤りが 1 回の実行で見えない。
 *
 * `at` は申告に出す場所、`bytes` は zip へ収める中身の集まり（呼ぶ側と共有する）。
 */
function assetsOf(
  source: unknown,
  dir: string,
  isStage: boolean,
  at: string,
  bytes: Map<string, Buffer>,
  problems: Problem[],
): { costumes: Costume[]; sounds: Sound[]; current: number } {
  const fields = asMapping(source)
  const costumes: Costume[] = []
  const sounds: Sound[] = []

  for (const [kind, listed] of [
    ["コスチューム", fields?.コスチューム],
    ["音", fields?.音],
  ] as const) {
    if (!Array.isArray(listed)) continue
    for (const [index, item] of listed.entries()) {
      const spot = `${at}: ${kind} ${index + 1} 番目`
      const file = asMapping(item)?.ファイル
      // 形と綴りの誤りは `checkAssets` が申告済み。ここで二重に申告しない
      if (typeof file !== "string" || file === "") continue

      const outside = pathProblem(dir, file, kind)
      if (outside) {
        problems.push({ ...outside, subject: `${spot}: ファイル` })
        continue
      }

      const body = assetBody(join(dir, file), file, spot, kind, problems)
      if (!body) continue

      const built =
        kind === "コスチューム" ? costumeOf(file, item, body) : soundOf(file, item, body)
      if ("missing" in built) {
        // **導けない形式と、導ける形式が解けなかった場合で言い分を変える。** 一律に
        // 「この形式からは導けない」と書くと、壊れた PNG で「png からは導けない。
        // 導けるのは svg / png / wav」という自己矛盾した申告が出て、書き手を誤った
        // 手当てへ導く（CP6 で 7 観点が指摘。`derivable()` はこの区別のために在る）
        const format = formatOf(file)
        problems.push({
          kind: `${kind}の属性を導けない`,
          subject: `${spot}: ${file}`,
          detail: derivable(format)
            ? `${built.missing.join(" と ")} を書く（${format} として中身を読めなかった）`
            : `${built.missing.join(" と ")} を書く` +
              `（${format} からは導けない。導けるのは ${DERIVABLE_FORMATS.join(" / ")}）`,
        })
        continue
      }

      if ("costume" in built) {
        costumes.push(built.costume)
        bytes.set(built.costume.md5ext, body)
      } else {
        sounds.push(built.sound)
        bytes.set(built.sound.md5ext, body)
      }
    }
  }

  if (costumes.length === 0) {
    // 素材を書かない作品定義の出力を動かさない。既定の四角はここでだけ入る
    const fallback = defaultCostume(isStage)
    costumes.push(fallback.costume)
    bytes.set(fallback.costume.md5ext, fallback.bytes)
  }

  // 番号は 1 始まりで書かせ、生成物の添字（0 始まり）へ直す。範囲は `checkCurrent` が
  // 見ているので、ここへ来る値は必ず在るコスチュームを指す
  const written = fields?.今のコスチューム
  const current = TYPES.数(written) ? written - 1 : (TARGET_KEYS.今のコスチューム.fallback as number) - 1
  return { costumes, sounds, current }
}

/**
 * 素材のファイルを読む。読めなければ申告して null を返す。
 *
 * 読む前に大きさを見る。読んでから見ては、その時点で資源を使い切っている
 * （`intake.ts` が .sb3 の受け入れで採るのと同じ規律）。
 */
function assetBody(
  path: string,
  file: string,
  spot: string,
  kind: string,
  problems: Problem[],
): Buffer | null {
  try {
    const { size } = statSync(path)
    if (size > ASSET_FILE_LIMIT) {
      problems.push({
        kind: `${kind}が大きすぎる`,
        subject: `${spot}: ${file}`,
        detail: `${size} バイトあり、上限 ${ASSET_FILE_LIMIT} バイトを超えた`,
      })
      return null
    }
    return readFileSync(path)
  } catch (error) {
    problems.push({
      kind: `${kind}を読めない`,
      subject: `${spot}: ${file}`,
      detail: reasonOf(error),
    })
    return null
  }
}

/** 内部の綴りを記法の形へ戻す。申告の手掛かりに使う */
function asNotation(proccode: string): string {
  let index = 0
  return proccode.replace(/%s/g, () => `(引数${(index += 1)})`)
}

/**
 * 定義が挙げた「再描画しないブロック」の名前を読む。
 *
 * 要素が文字列でないときは申告してその項を落とす。既定へ倒すと、書き間違えた
 * 指定が黙って効かないまま生成が成功する。
 *
 * 入れ物自体が並びでない場合はここで見ない ―― キーの型は `TARGET_KEYS` から引く
 * 共通の検査が既に見ており、ここでも見ると同じ書き間違いへ申告が 2 件並ぶ。
 */
function warpedNames(source: unknown, at: string, problems: Problem[]): string[] {
  const listed = asMapping(source)?.再描画しないブロック
  if (!Array.isArray(listed)) return []
  const names: string[] = []
  for (const [index, value] of listed.entries()) {
    if (typeof value !== "string" || value === "") {
      problems.push({
        kind: "再描画しないブロックの書き方が違う",
        subject: `${at}: ${index + 1} 件目`,
        detail: "ブロック定義の名前を文字列で書く",
      })
      continue
    }
    // 記法へ書いたのと同じ形で受け、内部の綴りへ直す。`%s` を書かせない
    names.push(asProccode(restored(value)))
  }
  return names
}

/**
 * 挙げた名前が記法に無ければ止める。
 *
 * 綴りを取り違えると、指定したつもりの定義が再描画する側のまま生成され、しかも生成は
 * 成功する。速さのために書いた指定なので、効かないまま動くのが一番わるい。
 */
function missingWarped(
  warped: string[],
  defined: Set<string>,
  at: string,
  problems: Problem[],
): void {
  // 手掛かりは挙げた名前に依らない。ループの外で 1 度だけ組む ── 中で組むと、
  // 挙げた件数 × 定義の件数だけ同じ文字列を作り直す
  const detail =
    defined.size === 0
      ? "この記法はブロック定義を 1 つも持たない"
      : `記法が定義するのは ${[...defined].map(asNotation).join(" / ")}`

  for (const spell of warped) {
    if (defined.has(spell)) continue
    problems.push({
      kind: "再描画しないブロックの名前が記法に無い",
      // 書いたものと見比べられるよう、記法の形へ戻して出す。内部の綴り（`%s`）は
      // Scratch の画面にも作品定義にも現れない
      subject: `${at}: ${asNotation(spell)}`,
      detail,
    })
  }
}

/**
 * 定義がスクリプトの途中に置かれていないかを見る。
 *
 * `定義` は帽子なので、解析器はそこで新しいスクリプトを始める。前のブロックの続きの
 * つもりで書くと**前のスクリプトが中身を失い**、旗を押しても何も起きない .sb3 が
 * 申告 0 件で出る（CP6 で実測）。空行が同じようにスクリプトを割ることは手順書が
 * 断っているが、`定義` の側は誰も断っていなかった。
 *
 * 見るのは記法の行である。解析した後では既に割れており、割れた理由が残らない。
 *
 * `catalog` から綴りを引く。手書きすると、上流が接頭辞を変えたとき黙って外れる
 */
function splitByDefine(code: string, catalog: LoadedCatalog, at: string): Problem[] {
  const define = catalog.byIdentifier.get("PROCEDURES_DEFINITION")?.ja
  // 綴りを引けないなら見ない。台帳の側の破れは別の申告が拾う
  if (!define) return []

  const found: Problem[] = []
  const lines = code.split("\n")
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue
    if (!line.trimStart().startsWith(define)) continue
    if (lines[index - 1].trim() === "") continue
    found.push({
      kind: "定義がスクリプトの途中にある",
      subject: `${at}: ${index + 1} 行目`,
      detail: "`定義` は帽子なので、ここでスクリプトが割れて前の続きが切り離される。"
        + "1 行空ける",
    })
  }
  return found
}

/**
 * ターゲット 1 つぶんの記法を解析して直列化する。
 *
 * `source` は定義のターゲット
 */
async function scriptsOf(
  source: unknown,
  dir: string,
  name: string,
  catalog: LoadedCatalog,
  declared: any,
  broadcasts: Map<string, string>,
  problems: Problem[],
): Promise<Record<string, any>> {
  const at = placeIn(isStageName(name) ? "ステージ" : "スプライト", { name: shownName(name) })
  // 記法はスクリプトしか表せないので、画面を再描画しない指定は定義が持つ
  const warped = warpedNames(source, at, problems)

  const file = asMapping(source)?.スクリプト
  if (!file) {
    // スクリプトが無ければ定義も無い。ここで見ないと、この指定だけが黙って消える
    missingWarped(warped, new Set(), at, problems)
    return {}
  }

  const outside = pathProblem(dir, String(file), "スクリプト")
  if (outside) {
    problems.push({ ...outside, subject: `${at}: ${file}` })
    return {}
  }

  let code
  try {
    code = readFileSync(join(dir, String(file)), "utf8")
  } catch (error) {
    problems.push({
      kind: "記法ファイルを読めない",
      subject: `${at}: ${file}`,
      detail: reasonOf(error),
    })
    return {}
  }

  const { doc, problems: unparsed } = await readNotation(code, `${at}: ${file}`)
  if (doc === null) {
    problems.push(...unparsed)
    return {}
  }

  problems.push(...splitByDefine(code, catalog, at))

  const { blocks, problems: found } = serializeScripts(doc, {
    catalog,
    names: names(name, declared, broadcasts),
    warped,
  })

  // プロトタイプの綴りだけを見る。触る 2 欄を型で述べる
  type Prototype = { opcode?: string, mutation?: { proccode?: string } }
  const spells = Object.values<Prototype>(blocks)
    .filter(block => block.opcode === "procedures_prototype")
    .map(block => String(block.mutation?.proccode ?? ""))
  const defined = new Set(spells)

  // 同じ綴りの定義が 2 つあると、Scratch はどちらを呼ぶかを綴りだけで決められない。
  // 生成物は成立し公式検証器も通るので、開くまで気づけない。`再描画しないブロック` の
  // 指定も両方に掛かる
  if (defined.size < spells.length) {
    const seen = new Set<string>()
    for (const spell of spells) {
      if (!seen.has(spell)) {
        seen.add(spell)
        continue
      }
      problems.push({
        kind: "同じ綴りのブロック定義が 2 つある",
        subject: `${at}: ${asNotation(spell)}`,
        detail: "呼び出しがどちらの定義に結び付くかを決められない。綴りを分ける",
      })
    }
  }

  missingWarped(warped, defined, at, problems)

  // 直列化は行を持たない。ブロックの綴りから入力の行を引き直して報告に添える。
  // 認識できない記述もここに含まれる（識別子を持たないブロックとして現れる）ため、
  // 解析側の走査と二重に報告しない
  //
  // 行を引く道具は同じ行を 2 度割り当てない。同じ綴りの別のブロックを別の行へ配るために
  // 要る規則だが、1 つのブロックが 2 件の問題を出すと 2 件目まで巻き添えで行を失う
  // （2026-08-19 実測）。ブロックごとに 1 度だけ引き、同じブロックの 2 件目は覚えた行を返す
  const lineOf = lineFinder(code)
  /** ブロックの通し番号から、引き当てた行 */
  const known = new Map<number, number>()
  for (const problem of found) {
    problems.push({
      kind: problem.kind,
      subject: `${file}:${placeOf(problem, lineOf, known)} ${problem.subject}`,
      detail: problem.detail,
    })
  }
  return blocks
}

/**
 * 問題 1 件が指す行を、ブロックごとに 1 度だけ引く。
 *
 * `known` は既に引いたブロックの行
 * 戻りは行番号。引けなければその旨
 */
function placeOf(problem: import("./serialize.ts").Problem, lineOf: (text: string) => number, known: Map<number, number>): string {
  if (!problem.where) return "行を特定できず"

  // 同定を持たない問題は覚えない。覚えると別のブロックどうしが 1 つの行を共有する
  const remembered =
    problem.blockIndex === undefined ? undefined : known.get(problem.blockIndex)
  const line = remembered ?? lineOf(problem.where)
  if (problem.blockIndex !== undefined) known.set(problem.blockIndex, line)

  return line > 0 ? String(line) : "行を特定できず"
}

/** ステージの内部名。定義に書ける名ではないので、申告では呼び名へ直す */
const STAGE_NAME = "Stage"

function isStageName(name: string) {
  return name === STAGE_NAME
}

/**
 * 申告に出す名前。ステージは内部名を見せない。
 *
 * `Stage` は実装が付ける名で、書き手が定義に書いた綴りではない（むしろ書くと止まる）。
 */
function shownName(name: string): string {
  return isStageName(name) ? "" : name
}

/** Windows の区切り。ソースへ裸で書くと読む側が数を取り違える */
const BACKSLASH = String.fromCharCode(92)

/**
 * 定義に書かれた綴りが、作品のディレクトリの中を指しているかを見る。
 *
 * 仕様は「作品のディレクトリからの相対で書く」と述べるのに、実装が強制していなかった。
 * `../../../../README.md` を書くと作品の外を読み、中身が申告へそのまま出る（実測）。
 *
 * 区切りの `\` も止める。`sub\main.sbk` は Windows で組み上がり Linux で `ENOENT` になる
 * （実測）。書いた機械では通るので、書いた人はずれに気づけない。
 *
 * 読む前に見る。読んでから確かめるのでは、外を読んだ事実が消えない。
 *
 * `スクリプト` と素材（`コスチューム` / `音`）が同じ規則を使う。規則を 2 か所へ書くと
 * 片方だけが古びるので、申告に出す呼び名だけを引数で受ける。
 *
 * `dir` は作品のディレクトリ
 * `file` は定義に書かれた綴り
 * `kind` は申告に出すキーの呼び名
 * 戻りは中を指していれば null
 */
function pathProblem(
  dir: string,
  file: string,
  kind: string,
): { kind: string, detail: string } | null {
  if (file.includes(BACKSLASH)) {
    return {
      kind: `${kind}の区切りが / でない`,
      detail: `区切りは / で書く（${BACKSLASH} は Windows でしか通らない）`,
    }
  }
  // 実行機械の規則だけで見ると、`C:/x.sbk` が POSIX で相対として素通りする。D6 が消そうと
  // した機械差が別の綴りで残るので、両方の規則で見る
  if (isAbsolute(file) || win32.isAbsolute(file)) {
    return {
      kind: `${kind}が作品のディレクトリの外を指す`,
      detail: "作品のディレクトリからの相対で書く",
    }
  }

  // 解決した先が作品の下にあるかで見る。相対の綴りを前方一致で見ると、`..foo` という
  // 名前のディレクトリを外と誤判定する（`..` で始まるだけで外に見える）
  const base = resolve(dir)
  const full = resolve(dir, file)
  if (full !== base && !full.startsWith(base + sep)) {
    return {
      kind: `${kind}が作品のディレクトリの外を指す`,
      detail: "作品のディレクトリの外は指せない",
    }
  }

  // **リンクを解いてからもう一度見る。** 綴りだけを見ると、作品のディレクトリに置いた
  // リンクが外を指していても通る ── 記法なら解析されて記法にできなければ止まるが、
  // 素材は**無解釈のバイト列として配布物（.sb3）へそのまま入る**（CP6 で 3 観点が指摘）。
  // 解けないのは実体が無いときで、そちらは読む段が申告する
  let real
  try {
    real = realpathSync(full)
  } catch {
    return null
  }
  // 置き場そのものもリンクでありうる。両側を解いて比べないと、正当な作品を外と読む
  const realBase = realpathSync(base)
  if (real !== realBase && !real.startsWith(realBase + sep)) {
    return {
      kind: `${kind}が作品のディレクトリの外を指す`,
      detail: "リンクの先が作品のディレクトリの外にある",
    }
  }
  return null
}

/** 定義を書くファイル。申告はここからの位置で示す */
const DEFINITION_FILE = "project.yaml"

/**
 * 定義の中の場所を、書き手が読める綴りで表す。
 *
 * `スプライト[0]` は実装の添字であって、書き手が書いた位置ではない。1 始まりで数え、
 * 名前を書いていればそれを添える。記法側の申告（`stage.sbk:2 …`）と同じ
 * 「どのファイルの、どこ」の並びにする。
 *
 * 場所の呼び名は仕様の一覧の見出し（`LEVELS` の `title`）と揃える。書き手が読むページと
 * 申告で別の語を使うと、示された場所を仕様から引けない。
 *
 * `level` は場所の呼び名、`at` は並びの中の位置と書かれた名前。
 */
function placeIn(level: string, at: { index?: number; name?: string } = {}): string {
  const number = at.index === undefined ? "" : ` ${at.index + 1} 番目`
  const named = at.name ? `「${at.name}」` : ""
  return `${DEFINITION_FILE} ${level}${number}${named}`
}

/**
 * 定義そのものを検査する。記法ファイルを読まずに済む検査だけを回す。
 *
 * 読み取り（`read`）が復元した定義を、書き出す前に同じ規則で確かめるために分けてある。
 * 検査を読み取り側へ写すと、同じ規則が 2 か所に増えて必ず食い違う。組み立て
 * （`buildProject`）もここを通るので、片方だけが古びることがない。
 *
 * `subject` は空の定義を申告するときに指す対象。省略すると定義そのもの。
 */
export function definitionProblems(
  definition: unknown,
  subject: string = DEFINITION_FILE,
): {
  problems: Problem[]
  stage: Record<string, unknown>
  sprites: unknown[]
  declared: Map<string, Map<string, Declared>>
} {
  const problems: Problem[] = []

  const fields = asMapping(definition)
  const stage = { ...((TYPES.対応(fields?.ステージ) ? fields?.ステージ : null) ?? {}), 名前: "Stage", isStage: true }
  // 並びでなければ回さない。`entries()` を持たない値で回すと TypeError が外へ出て、
  // 「誤りは投げずに問題として返す」を破る（`ステージ` の同じ誤りは申告になっていた）
  const written = fields?.スプライト
  const listed = written === undefined || written === null || TYPES.並び(written)
  const sprites = listed ? (written ?? []) : []
  if (!listed) {
    problems.push({
      kind: "定義の値の型が違う",
      subject: placeIn("最上位") + ": スプライト",
      detail: `並びで書く（今は ${JSON.stringify(written)}）`,
    })
  }

  // 空の申告を先に置く。何も宣言していないことの方が、綴りの誤りより上位の診断である。
  // ここへ置くのは、読み取りが復元した定義も同じ規則で確かめるためである ── 組み立ての
  // 側にだけ残していたとき、`targets` が空の .sb3 から作った空の定義を、読み取りが
  // 「組み立てを通る」と判断して終了コード 0 で書き出していた（CP6 で実測）
  if (!fields?.ステージ && sprites.length === 0) {
    // 何も宣言していない定義は、Scratch で開けるが何も起きない .sb3 になる。終了コードが
    // 0 なので成功と見分けが付かない（記法の側は `render` が同じ状況を塞いでいる）
    problems.push({
      kind: "作品の定義が空",
      subject,
      detail: "ステージ か スプライト を書く（今はどちらも宣言していない）",
    })
  }

  inspect(definition, sprites, problems)
  const declared = declare(stage, sprites, problems)
  // 検査の置き場を 1 か所へ揃える。収集する関数の内側から呼ぶと、定義の検査が
  // `inspect` と `declare` の 2 か所に分かれる
  idCollisions(declared, problems)

  return { problems, stage, sprites, declared }
}

/**
 * 作品の定義そのものを検査する。
 *
 * 記法の誤りは行を示して止まるのに、定義の誤りは黙って通っていた。キーの綴りを誤れば
 * スクリプトの無いスプライトになり、値の型を誤れば Scratch が開けない .sb3 になる。
 * どちらも終了コード 0 で出るため、成功と見分けが付かない。
 */
function inspect(definition: unknown, sprites: unknown[], problems: Problem[]) {
  checkKeys(definition, TOP_KEYS, placeIn("最上位"), problems)
  checkKeys(asMapping(definition)?.ステージ, TARGET_KEYS, placeIn("ステージ"), problems)

  const seen = new Set()
  for (const [index, sprite] of sprites.entries()) {
    const name = restored(String(asMapping(sprite)?.名前 ?? ""))
    const where = placeIn("スプライト", { index, name })
    checkKeys(sprite, SPRITE_KEYS, where, problems)

    if (!name) continue
    if (name === "Stage") {
      // ステージと同じ名前のスプライトは、変数の持ち主を取り違えさせる
      problems.push({
        kind: "スプライトに使えない名前",
        subject: `${where}: ${name}`,
        detail: "Stage はステージの名前として予約されている",
      })
    }
    if (seen.has(name)) {
      problems.push({
        kind: "同じ名前のスプライトが 2 つある",
        subject: `${where}: ${name}`,
        detail: "先に書いた側の宣言が消える",
      })
    }
    seen.add(name)
  }
}

/**
 * 対応のキーと値の型を確かめる。未知のキーは綴りの誤りとして扱う。
 *
 * `allowed` は書けるキーと、その仕様
 * `where` は報告に使う場所の名
 */
function checkKeys(
  source: unknown,
  allowed: Record<string, import("./definition.ts").KeySpec>,
  where: string,
  problems: Problem[],
) {
  if (source === undefined || source === null) return
  if (!TYPES.対応(source)) {
    problems.push({ kind: "定義の型が違う", subject: where, detail: "対応（キーと値の組）で書く" })
    return
  }

  for (const [key, value] of Object.entries(source)) {
    const want = allowed[key]?.type
    if (!want) {
      problems.push({
        kind: "定義に知らないキーがある",
        subject: `${where}: ${key}`,
        detail: `書けるのは ${Object.keys(allowed).join(" / ")}`,
      })
      continue
    }
    if (value === undefined || value === null) continue
    if (!fitsType(want, value)) {
      problems.push({
        kind: "定義の値の型が違う",
        subject: `${where}: ${key}`,
        detail: `${want}で書く（今は ${JSON.stringify(value)}）`,
      })
    }
  }

  // 書けるキーとして認めた場所でだけ初期値を見る。最上位に `変数` を書くと
  // 「知らないキー」と初期値の申告が 2 件並ぶ
  const fields = asMapping(source)
  if (Object.hasOwn(allowed, "変数")) checkVariables(fields?.変数, where, problems)
  if (Object.hasOwn(allowed, "リスト")) checkLists(fields?.リスト, where, problems)
  if (Object.hasOwn(allowed, "コスチューム")) {
    checkAssets(
      fields?.コスチューム, "コスチューム", COSTUME_KEYS, COSTUME_FORMATS,
      COSTUME_REQUIRED, where, problems,
    )
    checkCurrent(fields?.今のコスチューム, fields?.コスチューム, where, problems)
  }
  if (Object.hasOwn(allowed, "音")) {
    checkAssets(
      fields?.音, "音", SOUND_KEYS, SOUND_FORMATS, SOUND_REQUIRED, where, problems,
    )
  }
}

/**
 * 素材の並びを確かめる。項ごとに、書けるキー・ファイルの綴り・形式を見る。
 *
 * 中身（寸法・サンプル）は読まない。ここは記法ファイルを読まずに済む検査だけを回す層で、
 * 読み取りが復元した定義もここを通る（`definitionProblems` の約束）。ファイルを開く必要の
 * ある検査は組み立ての側（`assetsOf`）が持つ。
 *
 * `kind` はキーの名前で、申告と、パスの規則を告げる文言に出す。
 */
function checkAssets(
  written: unknown,
  kind: string,
  allowed: Record<string, import("./definition.ts").KeySpec>,
  formats: string[],
  required: string[],
  where: string,
  problems: Problem[],
) {
  if (written === undefined || written === null) return
  // 並びでないことは `checkKeys` が既に申告している。ここで回すと 1 つの誤りから
  // 項ごとの申告が並ぶ（`declarationsIn` が同じ理由で対応かどうかを見ている）
  if (!Array.isArray(written)) return

  for (const [index, item] of written.entries()) {
    // 位置は 1 始まりで数える。0 始まりの添字で名指すと、書き手が数えている位置とずれる
    const spot = `${where}: ${kind} ${index + 1} 番目`
    if (!TYPES.対応(item)) {
      problems.push({
        kind: `${kind}の項が対応でない`,
        subject: spot,
        detail: `ファイル を持つ対応で書く（今は ${JSON.stringify(item)}）`,
      })
      continue
    }

    checkKeys(item, allowed, spot, problems)

    const file = item.ファイル
    if (file === undefined || file === null || file === "") {
      problems.push({
        kind: `${kind}にファイルが無い`,
        subject: spot,
        detail: "ファイル に素材の名前を書く",
      })
      continue
    }
    // 型の誤りは `checkKeys` が申告済み。綴りとして読めないものをここで二重に申告しない
    if (typeof file !== "string") continue

    // 綴りが作品のディレクトリの中を指すかは、ここでは見ない。判定に `dir` が要り、
    // この層は記法ファイルを読まずに済む検査だけを回す約束になっている。`スクリプト` の
    // 同じ規則も組み立ての側にあり、規則を 2 か所へ割らないため揃えてある（`assetsOf`）
    const format = formatOf(file)
    if (!formats.includes(format)) {
      problems.push({
        kind: `${kind}の形式を扱えない`,
        subject: `${spot}: ファイル`,
        detail: `拡張子は ${formats.join(" / ")} のいずれかにする（今は ${JSON.stringify(file)}）`,
      })
    }

    // 導けない形式で属性を省いていたら、中身を読まずに止める。**導けるかどうかは
    // 拡張子で決まる**ので、この判定にファイルは要らない。ここで見ないと、読み取りが
    // 「組み立てを通る」と判断して書き出した定義が、組み立てで初めて落ちる
    if (formats.includes(format) && !derivable(format)) {
      const absent = required.filter(key => item[key] === undefined || item[key] === null)
      if (absent.length > 0) {
        problems.push({
          kind: `${kind}の属性を導けない`,
          subject: `${spot}: ファイル`,
          detail:
            `${absent.join(" と ")} を書く` +
            `（${format} からは導けない。導けるのは ${DERIVABLE_FORMATS.join(" / ")}）`,
        })
      }
    }

    // 整数を求める欄は、型が数であることだけでは足りない。小数を書くと公式検証器まで
    // 届いて英語の schema 文で止まり、書き手は自分の書いた鍵へ戻れない
    for (const key of WHOLE_NUMBERS) {
      const value = item[key]
      if (value === undefined || value === null) continue
      if (typeof value === "number" && Number.isInteger(value)) continue
      // 型そのものの誤りは `checkKeys` が申告済み
      if (typeof value !== "number") continue
      problems.push({
        kind: `${kind}の ${key} が整数でない`,
        subject: `${spot}: ${key}`,
        detail: `整数で書く（今は ${JSON.stringify(value)}）`,
      })
    }
  }
}

/**
 * 整数しか置けない欄。公式検証器の schema が `integer` を求める。
 *
 * 出典は `node_modules/scratch-parser/lib/sb3_definitions.json`。`rotationCenter` は
 * `number` なので入れない ── 小数の中心は正当である（回転の中心が画素の間に来る絵がある）。
 */
const WHOLE_NUMBERS = ["bitmapResolution", "rate", "sampleCount"]

/**
 * `今のコスチューム` が、実際に在るコスチュームを指しているかを見る。
 *
 * 範囲の外を指すと、Scratch は開けるのに何も見えないターゲットになる。生成物の
 * `currentCostume` は添字なので、範囲外でも schema としては通ってしまう。
 */
function checkCurrent(
  written: unknown,
  costumes: unknown,
  where: string,
  problems: Problem[],
) {
  if (written === undefined || written === null) return
  // 型の誤りは `checkKeys` が申告済み
  if (!TYPES.数(written)) return

  // 素材を書かないときは自前の四角 1 種になる。番号の在る範囲は常に 1 件以上ある
  const count = Array.isArray(costumes) && costumes.length > 0 ? costumes.length : 1
  if (!Number.isInteger(written) || written < 1 || written > count) {
    problems.push({
      kind: "今のコスチュームが範囲の外",
      subject: `${where}: 今のコスチューム`,
      detail: `1 から ${count} までの整数で書く（今は ${JSON.stringify(written)}）`,
    })
  }
}

/**
 * 宣言の並びを回してよいかを見る。
 *
 * 対応でなければ回さない。`リスト: "abc"` を `Object.entries` へ渡すと添字と文字の組へ
 * 展開され、1 つの誤りから添字ごとの申告が並ぶ（実測 4 件。2026-08-19）。型そのものは
 * `checkKeys` が既に申告している。
 */
function declarationsIn(written: unknown): [string, unknown][] {
  const fields = asMapping(written)
  return fields ? Object.entries(fields) : []
}

/** 値が変数へ入れられる型かを見る */
function isValue(value: unknown) {
  return VALUE_TYPES.some(name => fitsType(name, value))
}

/**
 * 変数の初期値を確かめる。
 *
 * 対応や並びを書くと公式検証器まで届いて英語のスキーマ文で止まる。リストの初期値には
 * 専用の申告があるのに変数には無く、同じ誤りが別の言葉で返っていた。
 */
function checkVariables(written: unknown, where: string, problems: Problem[]) {
  for (const [name, value] of declarationsIn(written)) {
    if (value === null || value === undefined) continue
    if (isValue(value)) continue
    problems.push({
      kind: "変数の初期値が値でない",
      subject: `${where}: ${name}`,
      detail: `${VALUE_TYPES.join(" / ")} のいずれかで書く（今は ${JSON.stringify(value)}）`,
    })
  }
}

/**
 * リストの初期値と、その要素を確かめる。
 *
 * 要素まで見るのは、並びであることだけを見ても中身が対応なら公式検証器へ届くためである
 * （`.targets[0].lists[…][1][0]: should be string` の形で返る）。
 */
function checkLists(written: unknown, where: string, problems: Problem[]) {
  for (const [name, value] of declarationsIn(written)) {
    if (value === null || value === undefined) continue
    if (!Array.isArray(value)) {
      problems.push({
        kind: "リストの初期値が並びでない",
        subject: `${where}: ${name}`,
        detail: `[] の形で書く（今は ${JSON.stringify(value)}）`,
      })
      continue
    }

    for (const [index, item] of value.entries()) {
      if (isValue(item)) continue
      problems.push({
        kind: "リストの要素が値でない",
        // Scratch のリストは 1 始まりで、記法も `(1) 番目` と書く。0 始まりの添字で
        // 名指すと、書き手が数えている位置と 1 つずれる
        subject: `${where}: ${name} の ${index + 1} 番目`,
        detail: `${VALUE_TYPES.join(" / ")} のいずれかで書く（今は ${JSON.stringify(item)}）`,
      })
    }
  }
}

/**
 * 定義に書かれた変数とリストを集め、名前から ID を引ける形にする。
 *
 * 集めるだけで検査はしない。ID の衝突は `idCollisions` が別に見る。
 *
 * ステージの変数は全体で共有し、スプライトの変数はそのスプライトだけが持つ。ID には
 * 種別とスプライト名を前置する。scratch-vm は変数とリストを実行時に 1 つの表へ集める
 * ため、前置しないと同名の変数とリストが衝突する。
 */
function declare(stage: unknown, sprites: unknown[], problems: Problem[]) {
  const scopes = new Map<string, Map<string, Declared>>()

  const collect = (owner: string, source: unknown) => {
    const entries = new Map<string, Declared>()
    for (const kind of ["variable", "list"]) {
      const fields = asMapping(source)
      const written = (TYPES.対応(fields?.[kind === "variable" ? "変数" : "リスト"]) ? fields?.[kind === "variable" ? "変数" : "リスト"] : null) ?? {}
      for (const [declared, value] of Object.entries(written)) {
        // 記法の側と同じ規則で印を復す。片方だけ復すと綴りが割れ、宣言と参照が指す
        // 名前が違うものになる
        const stuck = unrestorable(declared)
        if (stuck.length > 0) {
          // 定義は人が書く。指せない符号位置の印は入力の誤りとして止める ── 黙って
          // 通すと上限超えが実行時例外になり、孤立サロゲートは .sb3 へ入る
          problems.push({
            kind: "印が指せない符号位置を書いている",
            subject: `${owner} の ${declared}`,
            detail: "符号位置は U+10FFFF までで、U+D800〜U+DFFF は単独で書けない",
          })
          continue
        }
        const name = restored(declared)
        const key = `${kind}:${name}`
        if (entries.has(key)) {
          // 実際に守っているのは YAML の解析器で、重複キーはそこで例外になる。依存を
          // 差し替えたときに素通りしないよう、検出だけはここに残す
          problems.push({ kind: "同じ名前を 2 度宣言している", subject: `${owner} の ${name}` })
          continue
        }
        // 値にも同じ規則で復す。読む側が宣言の値へも印を掛けるので、片方だけ復すと
        // 往復で初期値が印の綴りのまま .sb3 へ入る
        entries.set(key, { name, value: deepRestore(value), id: idOf(kind, owner, name) })
      }
    }
    scopes.set(owner, entries)
  }

  collect("Stage", stage)
  for (const sprite of sprites) collect(restored(String(asMapping(sprite)?.名前 ?? "")), sprite)
  return scopes
}

/**
 * 同じ ID を名乗る宣言を申告する。
 *
 * ID は名前から導くので決定論だが、単射ではない。ステージの変数 `ネコ/スコア` と、
 * スプライト `ネコ` の変数 `スコア` はどちらも `variable:ネコ/スコア` になる。この
 * まま出すと、スプライト側のブロックは名前を表示したまま ID では別の変数を指す。
 * 公式検証器は通り終了コードも 0 なので、書いた側から気づく手段が無い（実測）。
 *
 * 導出の形は変えない。名前から導くのをやめると同じ入力から同じ .sb3 が出なくなる。
 */
function idCollisions(scopes: Map<string, Map<string, Declared>>, problems: Problem[]) {
  /** ID から、それを名乗る宣言 */
  const holders = new Map<string, string[]>()
  for (const [owner, entries] of scopes) {
    for (const entry of entries.values()) {
      holders.set(entry.id, [...(holders.get(entry.id) ?? []), `${owner} の ${entry.name}`])
    }
  }

  for (const [id, named] of holders) {
    if (named.length < 2) continue
    problems.push({
      kind: "別の宣言が同じ ID になる",
      subject: `${DEFINITION_FILE} ${named.join(" / ")}`,
      detail: `どちらも ${id} を名乗る。持ち主の名前か宣言の名前から / を外す`,
    })
  }
}

/**
 * ID を名前から導く。
 */
function idOf(kind: string, owner: string, name: string) {
  return owner === "Stage" ? `${kind}:${name}` : `${kind}:${owner}/${name}`
}

/**
 * 記法に書かれた名前から ID を引く。自分の持ち物を先に見て、無ければステージを見る。
 */
function names(owner: string, declared: Map<string, Map<string, Declared>>, broadcasts: Map<string, string>) {
  return {
    idFor: (kind: string, name: string) => {
      if (kind === "broadcast") {
        // 放送は記法が名前を与える。定義に書かせず、現れたものを集める
        const id = `broadcast:${name}`
        broadcasts.set(name, id)
        return id
      }
      const key = `${kind}:${name}`
      const mine = declared.get(owner)?.get(key)
      if (mine) return mine.id
      return declared.get("Stage")?.get(key)?.id ?? null
    },
  }
}

/**
 * ターゲット 1 つを組み立てる。
 *
 * `layer` は重なりの順。ステージは 0、スプライトは 1 から
 */
function target(
  isStage: boolean,
  name: string,
  source: unknown,
  blocks: Record<string, any>,
  declared: Map<string, Map<string, Declared>>,
  shown: { costumes: Costume[]; sounds: Sound[]; current: number },
  layer: number,
) {
  const own = declared.get(isStage ? "Stage" : name) ?? new Map<string, Declared>()
  const variables: Record<string, [string, unknown]> = {}
  const lists: Record<string, [string, unknown]> = {}

  for (const [key, entry] of [...own].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (key.startsWith("list:")) lists[entry.id] = [entry.name, entry.value ?? LIST_FALLBACK]
    else variables[entry.id] = [entry.name, entry.value ?? VARIABLE_FALLBACK]
  }

  const common = {
    isStage,
    name: isStage ? "Stage" : name,
    variables,
    lists,
    broadcasts: {},
    blocks,
    // キーの並びは動かさない。JSON の並びがそのまま .sb3 のバイト列になるので、
    // 挿し直すと素材を書かない既存の作品まで別のバイト列になる
    currentCostume: shown.current,
    costumes: shown.costumes,
    sounds: shown.sounds,
    volume: 100,
  }

  if (isStage) {
    return {
      ...common,
      tempo: 60,
      videoTransparency: 50,
      videoState: "off",
      layerOrder: 0,
    }
  }
  return {
    ...common,
    visible: spriteFallback(source, "表示"),
    x: spriteFallback(source, "x"),
    y: spriteFallback(source, "y"),
    size: spriteFallback(source, "大きさ"),
    direction: spriteFallback(source, "向き"),
    draggable: false,
    rotationStyle: "all around",
    layerOrder: layer,
  }
}
