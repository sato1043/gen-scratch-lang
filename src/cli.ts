#!/usr/bin/env node
/**
 * コマンド入口。記法のファイルを受け取ってブロック図を書き出す。
 */
import { parseArgs } from "node:util"
import { stringify as stringifyYaml } from "yaml"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { basename, dirname, extname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { normalized } from "./notation.ts"
import { countBlocks, findUnrecognized, readNotation } from "./parse.ts"
import { renderSvg, svgToPng } from "./render.ts"
import { CATALOG_KEYS, loadCatalog, type Entry } from "./catalog.ts"
import {
  CATALOG_MARKS,
  CATEGORIES,
  DEFINITION_MARKS,
  categoryTable,
  labelCollisions,
  definitionKeyCount,
  definitionTable,
  renderInto,
  scopeReport,
} from "./knowledge.ts"
import { buildProject, definitionProblems } from "./project.ts"
import {
  LOCALES,
  definitionOf,
  fieldLabel,
  foldedName,
  readSb3,
  stemsFor,
  summaryOf,
} from "./read.ts"
import { PROJECT_JSON_LIMIT, openAssets } from "./roundtrip.ts"
import { packSb3 } from "./sb3.ts"
import { officialProblems } from "./validate.ts"
import {
  announce,
  announceProblems,
  announceRerun,
  announceUsage,
  neutralize,
  reasonOf,
  quotedPath,
  report,
  reportUsage,
  shownPath,
  withLf,
} from "./errors.ts"

/**
 * 図の拡大率の上限。
 *
 * 現象から導く。同じ記法を拡大率を変えて描いた実測（2026-08-22・Node 24.19.0）はこう
 * なった ── 1 倍で 39 KB・7.7 秒、8 倍で 439 KB・5.8 秒、16 倍で 1.0 MB・7.8 秒、
 * 32 倍で 3.2 MB・13.6 秒、100 倍で 16.9 MB・**249 秒**である。SVG の大きさは拡大率で
 * ほとんど動かない（39,680 → 39,689 バイト）ので、効くのは PNG の側だけである。
 *
 * 16 倍までは描画の費用が起動の費用（依存の読み込みで 6〜8 秒）に埋もれる。膝は 16 と
 * 32 の間にあり、そこから先は面積に比例して伸びる。線は埋もれる側の上端へ置く。
 *
 * `read` では 1 回の指定が全スクリプトへ掛かるので、1 枚あたりの費用がそのまま効く。
 * 図の本数の上限（`FIGURE_LIMIT`）だけでは、拡大率の側から同じ量を作れてしまう。
 *
 * 実際の大きさは記法の大きさにもよる。ここが縛るのは倍率であって、書き出す量そのものでは
 * ない。
 */
const SCALE_LIMIT = 16

const USAGE = `使い方:
  node src/cli.ts render <記法ファイル> [--out <出力先>] [--format svg|png]
                                        [--scale <倍率>]
  node src/cli.ts build <作品のディレクトリ> [--out <出力先>]
                                            [--format sb3|json]
  node src/cli.ts read <.sb3> [--out <ディレクトリ>] [--format svg|png]
                               [--scale <倍率>] [--locale ja|en] [--anyway]
  node src/cli.ts knowledge [--dir <置き場>] [--check]

  どのコマンドにも --help を付けられる。--scale は ${SCALE_LIMIT} 倍まで。

render:
  --out     出力先。省略すると out/<入力名>.<形式> へ書き出す
  --format  出力形式。省略すると --out の拡張子から決め、それも無ければ svg
  --scale   拡大率。省略すると 1

build:
  --out     出力先。省略すると out/<作品名>.<形式> へ書き出す
  --format  出力形式。省略すると --out の拡張子から決め、それも無ければ sb3
  組み上がったものを Scratch 公式の検証器へ通してから書き出す。通らなければ
  書き出さない（検証を飛ばす旗は無い）

read:
  --out     書き出し先のディレクトリ。省略すると out/<入力名>/ を使う
  --format  図の形式。省略すると svg
  --scale   図の拡大率。省略すると 1
  --locale  記法の言語。省略すると ja。記法とその中の印だけが従い、
            要約・作品定義・申告は日本語のままである
  --anyway  Scratch 公式の検証器が弾いた作品も、読めるところまで読む。検証は
            飛ばさず、弾いた理由と保証しないことを申告して読み進む
  ターゲットごとの記法（.sbk）・スクリプトごとの図・構造の要約と、
  組み立て直せる作品定義（project.yaml）を書き出す

knowledge:
  --dir     知識層の置き場。省略すると docs/knowledge を使う
  --check   書き換えず、生成した一覧が実装と一致するか調べる
`

/**
 * 1 度の読み取りで書き出す図の本数の上限。
 *
 * 現象から導く。図 1 枚は約 4.6 ms・約 29 KB である（2026-08-20 実測。暖まった後の値で、
 * 最初の 1 枚だけは依存の読み込みで 623 ms かかる）。project.json の上限（5 MB）の内側には
 * 最小のスクリプトが約 39,420 本入り、そのまま描くと約 181 秒・約 1.1 GB になる。
 *
 * 線は図の書き出しが約 9 秒・約 57 MB に収まる本数へ置く。Scratch のエディタで組む作品は
 * 数十〜数百本なので、10 倍以上の余裕がある。
 *
 * 超えたら切り詰めずに止める。黙って一部だけ書くと、読み手には「全部読めた」と
 * 見分けが付かない。
 */
const FIGURE_LIMIT = 2000

/**
 * 1 度の読み取りで書き出す量の上限。
 *
 * 入口の上限（`PROJECT_JSON_LIMIT`）は入力しか縛らない。値を印へ変える設計では出力が
 * 入力より膨らむ ── 1 文字が `⟪U+XXXX⟫` の 9 文字になるので、制御文字で埋めた入力は
 * 最大 8 倍を超える。実測では 2.7 KB の .sb3 から 6.08 MB が出た（CP6）。図の本数
 * （`FIGURE_LIMIT`）も拡大率（`SCALE_LIMIT`）もこの膨張を縛れない。
 *
 * 線は入力の上限と同じ値へ置く。記法は project.json から構造を落として綴りだけを
 * 残すので、普通の作品では入力より小さくなる。同じ線を超えるのは膨張が起きたときだけ
 * である。
 *
 * 超えたら切り詰めずに止める。黙って一部だけ書くと、読み手には「全部読めた」と
 * 見分けが付かない（`FIGURE_LIMIT` と同じ扱い）。
 */
const OUTPUT_LIMIT = PROJECT_JSON_LIMIT

/** 知識層の置き場。ブロック解説と作品定義の仕様をこの下に持つ */
const KNOWLEDGE_DIR = "docs/knowledge"

/**
 * 空の値を渡された旗を探す。
 *
 * `--format ""` を「渡されなかった」と読まない。読むと打ち間違いが既定で静かに通る。
 * 扱いが 3 つのコマンドで割れていた ── `render` と `build` は既定へ倒し、`read` は
 * 弾いたが何が悪いかを言わなかった（申告の値が空で出ていた）。
 *
 * `values` は`parseArgs` の戻りの `values`
 * 戻りは空だった旗の名。無ければ null
 */
function emptyFlag(values: Record<string, any>): string | null {
  for (const [flag, value] of Object.entries(values)) {
    if (value === "") return flag
  }
  return null
}

/**
 * 旗の共通の扱いを 1 か所で持つ。どのコマンドも同じ規則を通る。
 *
 * 挙動を 4 か所へ写しても揃うが、揃っているのは書いた時点だけである。片方だけ直すと
 * 黙って割れる ── 本作業が畳んだ割れは、どれもそうやってできた。
 *
 * `values` は`parseArgs` の戻りの `values`
 * 戻りは終えるなら終了コード。続けてよければ null
 */
function flagGate(values: Record<string, any>): number | null {
  // 使い方を求められたら標準出力へ出して 0 で終える
  if (values.help) {
    reportUsage(USAGE)
    return 0
  }
  const empty = emptyFlag(values)
  if (empty) {
    announce`--${empty} に空の値が渡された。値を書くか、旗ごと省く\n`
    return 1
  }
  return null
}

/**
 * 引数を読めなかったときの申告。
 *
 * 引数の受け口が返すのは Node の英語である。何が悪いかは英語のまま残し（旗の名前が
 * 入っているので手掛かりになる）、どうすればよいかを日本語で添える。使い方の記述に
 * 無い旗を渡したときに、英語だけを返して終わっていた（TASK0015 の CP6 が指摘）。
 *
 * 戻りは終了コード
 */
function badArgs(error: unknown): number {
  announce`引数が読めない: ${reasonOf(error)}\n`
  announce`  下の使い方に無い旗は受け取らない。綴りを確かめる\n\n`
  announceUsage(USAGE)
  return 1
}

/**
 * 拡大率を読む。正の数で、上限の内側であることを見る。
 */
function scaleOf(given: string | undefined): { scale: number } | { error: string } {
  const scale = Number(given ?? 1)
  if (!Number.isFinite(scale) || scale <= 0) {
    return { error: `--scale は正の数で指定する: ${given}` }
  }
  if (scale > SCALE_LIMIT) {
    return { error: `--scale は ${SCALE_LIMIT} 倍までにする: ${given}` }
  }
  return { scale }
}

/**
 *
 * 戻りは終了コード
 */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  // 使い方を求められたら標準出力へ出して 0 で終える。止まって出すときとは出す先が違う
  if (command === undefined || command === "--help") {
    reportUsage(USAGE)
    return 0
  }
  if (command === "render") return render(rest)
  if (command === "build") return build(rest)
  if (command === "read") return read(rest)
  if (command === "knowledge") return knowledge(rest)

  announce`知らないコマンド: ${command}\n\n`
  announceUsage(USAGE)
  return 1
}

async function render(rest: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: "string" },
        format: { type: "string" },
        scale: { type: "string" },
        help: { type: "boolean" },
      },
    })
  } catch (error) {
    return badArgs(error)
  }

  const gate = flagGate(parsed.values)
  if (gate !== null) return gate

  const input = parsed.positionals[0]
  if (!input) {
    announce`記法ファイルを指定する\n\n`
    announceUsage(USAGE)
    return 1
  }

  const measured = scaleOf(parsed.values.scale)
  if ("error" in measured) {
    announce`${measured.error}\n`
    return 1
  }
  const scale = measured.scale

  const out = parsed.values.out ?? defaultOut(input, parsed.values.format)
  const format = parsed.values.format || extname(out).replace(".", "") || "svg"
  if (format !== "svg" && format !== "png") {
    announce`--format は svg か png を指定する: ${format}\n`
    return 1
  }

  let code
  try {
    code = readFileSync(input, "utf8")
  } catch (error) {
    announce`記法ファイルを読めない: ${reasonOf(error)}\n`
    return 1
  }

  // 図にする前に印を揃える。手で書いた印を復さないと、同じ記法から出た図と .sb3 が
  // 食い違う（図は印のまま・`build` は復した実体を入れる）
  const { doc, problems: unparsed } = await readNotation(normalized(code), input)
  if (doc === null) {
    announce`記法を図にできない\n`
    announceProblems(unparsed)
    writeGuide()
    return 1
  }

  const refused = undrawable(doc, code)
  if (refused) {
    announce`${refused.reason}。図にしない: ${input}\n`
    for (const { line, text } of refused.unknown) {
      const place = line > 0 ? `${input}:${line}` : `${input}:(行を特定できず)`
      announce`  ${place}: ${text}\n`
    }
    writeGuide()
    return 1
  }

  // 描画は解析と別に再帰する。解析が通る深さでも描画が投げることがあり、捕まえないと
  // 最小化した依存のソース 1 行がスタックトレースごと出る（深さ 1150 で 130,670 バイト。
  // CP6 で実測）。書き出しも同じ受け口に入れる ── 投げると中和も畳み込みも通らない
  try {
    const svg = await renderSvg(doc, { scale })
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, format === "png" ? svgToPng(svg) : svg)
  } catch (error) {
    announce`図にできない\n`
    announceProblems([{ kind: "図を書き出せない", subject: input, detail: reasonOf(error) }])
    writeGuide()
    return 1
  }
  report`${out}\n`
  return 0
}

/**
 * 作品から .sb3 を組み立てて書き出す。中身の project.json も単体で出せる。
 *
 * 台帳で解けないブロックが 1 つでもあれば書き出さずに止める。半分だけ生成した .sb3 は、
 * Scratch では開けるのに中身が抜けており、成功と見分けが付かない。
 */
async function build(rest: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: "string" },
        format: { type: "string" },
        help: { type: "boolean" },
      },
    })
  } catch (error) {
    return badArgs(error)
  }

  const gate = flagGate(parsed.values)
  if (gate !== null) return gate

  const dir = parsed.positionals[0]
  if (!dir) {
    announce`作品のディレクトリを指定する\n\n`
    announceUsage(USAGE)
    return 1
  }

  const out =
    parsed.values.out ?? join("out", `${basename(dir)}.${parsed.values.format ?? "sb3"}`)
  const format = parsed.values.format || extname(out).replace(".", "") || "sb3"
  if (format !== "sb3" && format !== "json") {
    announce`--format は sb3 か json を指定する: ${format}\n`
    return 1
  }

  const { project, assets, problems } = await buildProject(dir)
  if (problems.length > 0) {
    // 「.sb3 にできない箇所」とは名乗らない。台帳の申告もここへ集まるので、入力の中の
    // 箇所を指していない申告まで箇所として数えることになる（`read` の出口と同じ規律）
    announce`作品を .sb3 にできない。申告が ${problems.length} 件ある\n`
    announceProblems(problems)
    writeGuide()
    return 1
  }

  // 検証は書き出しの前に置く。後に置くと、弾かれた生成物が出力先に残り、
  // 終了コードだけが失敗を告げる状態になる
  const bytes =
    format === "json"
      ? Buffer.from(`${JSON.stringify(project)}\n`)
      : await packSb3({ project, assets })

  const rejected = await officialProblems(bytes, dir)
  if (rejected.length > 0) {
    announce`Scratch が読める形になっていない。書き出さない\n`
    announceProblems(rejected)
    writeGuide()
    return 1
  }

  try {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, bytes)
  } catch (error) {
    announce`書き出せない\n`
    announceProblems([{ kind: "生成物を書き出せない", subject: out, detail: reasonOf(error) }])
    return 1
  }

  const blocks = project.targets.reduce(
    (sum: number, target: any) =>
      sum + Object.keys(target.blocks).length,
    0,
  )
  const summary =
    `ターゲット ${project.targets.length} 件` +
    ` / ブロック ${blocks} 件 / 素材 ${assets.length} 件`
  report`${out}\n  ${summary}\n`
  return 0
}

/**
 * 素材を .sb3 から取り出し、書き出しの一覧へ足す。
 *
 * 名前は zip の中の名前（中身の md5 + 拡張子）のままにする。理由は 3 つ ── 対応が
 * 自明になる、名前の側から他人の文字が入らない、組み立て直しがそのまま通る。
 *
 * 同じ素材を複数のターゲットが使うことがある（zip は 1 件しか持たない）。名前で束ねて
 * 1 度だけ置く。
 *
 * 取れなかった名前を返す。落としても読めた側は書き出す ── 図が 1 枚落ちても記法と要約を
 * 残すのと同じ規律である。
 *
 * `files` は要約の対応表。素材もそのターゲットの書き出しとして数える
 */
async function placeAssets(
  bytes: Buffer,
  reading: import("./read.ts").Reading,
  built: { name: string; body: string | Buffer; escape: string }[],
  files: Map<string, string[]>,
): Promise<string[]> {
  // 名前の形を満たさず落としたものを先に言う。**黙って落とすと、組み立て直した作品から
  // 絵が消えた理由が誰にも分からない**。落とす判断そのものは読み取りが済ませている
  const malformed = reading.targets.flatMap(target => target.shown.dropped)
  if (malformed.length > 0) {
    announce`名前の形が合わず落とした素材が ${malformed.length} 件ある\n`
    announceProblems([
      {
        kind: "素材の名前が形を満たさない",
        subject: "入力",
        detail:
          `${malformed.length} 件を落とした: ` +
          `${malformed.slice(0, LOST_ASSETS_SHOWN).join("・")}` +
          `（md5 と拡張子の形でなければ、書き出し先の外を指しうる）`,
      },
    ])
  }

  const wanted = new Set<string>()
  for (const target of reading.targets) {
    for (const asset of [...target.shown.costumes, ...target.shown.sounds]) {
      wanted.add(asset.file)
      // 対応表は書いた側が数える。取れなかった素材は下で外す
      files.get(target.stem)?.push(asset.file)
    }
  }
  if (wanted.size === 0) return []

  let taken
  try {
    taken = await openAssets(bytes, wanted)
  } catch (error) {
    // 上限を超えたときと、中身が壊れていて展開できないときにここへ来る。読めた側は
    // 捨てないが、**1 件も置かない以上は全件を落としたものとして扱う** ── ここで
    // 定義を刈らずに戻っていたとき、素材 1 件の破損で全素材が消えたのに `project.yaml`
    // が 3 件を参照したまま終了コード 0 で出ていた（CP6 の再評価層が実測）
    announceProblems([
      { kind: "素材を取り出せない", subject: "入力", detail: reasonOf(error) },
    ])
    return prune(reading, files, wanted)
  }

  for (const [name, body] of taken.assets) {
    built.push({ name, body, escape: ESCAPES.素材 })
  }
  if (taken.missing.length === 0) return []
  return prune(reading, files, new Set(taken.missing))
}

/**
 * 置けなかった素材を、対応表からも作品定義からも外す。落とした名前を返す。
 *
 * **定義だけ残すと、実在しないファイルを指す定義を書き出すことになる**。公式検証器は
 * 素材の欠落を通すので（FEAT0003 が申告している）、素材の無い .sb3 は実在する。
 * 外した結果コスチュームが 0 件になったターゲットは、組み立てが自前の四角を与える。
 *
 * **失敗の経路は 2 つあり、両方がここを通る。** 片方だけを刈っていたときに壊れたのが
 * 上の実測である。
 */
function prune(
  reading: import("./read.ts").Reading,
  files: Map<string, string[]>,
  lost: Set<string>,
): string[] {
  for (const written of files.values()) {
    for (const name of [...written]) if (lost.has(name)) written.splice(written.indexOf(name), 1)
  }
  for (const target of reading.targets) {
    const kept = target.shown.costumes.filter(asset => !lost.has(asset.file))
    // 番号は残った並びを指す。指していたものを外したら先頭へ倒す ── 指し先が消えている
    // 以上、元の番号を保っても意味を持たない
    const at = target.shown.current - 1
    if (at < 0 || at >= target.shown.costumes.length || lost.has(target.shown.costumes[at].file)) {
      target.shown.current = 1
    } else {
      target.shown.current = kept.indexOf(target.shown.costumes[at]) + 1
    }
    target.shown.costumes = kept
    target.shown.sounds = target.shown.sounds.filter(asset => !lost.has(asset.file))
  }
  return [...lost]
}

/**
 * 書き出し先が使える状態かを見る。
 *
 * 空でない置き場へ黙って重ねると、前回の `.sbk` と図が残り、要約の対応表に無い
 * ファイルが並ぶ。どちらが今の読み取りの結果かを読み手が見分けられない（CP6 で指摘）。
 *
 * **消す道は持たない。** 一度は「印を見て入れ替える旗」を設けたが、印は偽造でき、
 * 許せるのはディレクトリ 1 個までで中の個々のファイルには及ばず、利用者が置いた資料も
 * 入力の .sb3 自身も巻き添えにした（CP6 で 6 観点が独立に指摘。いずれも実測）。
 * 取り返しが付かない操作を、読み取りという読むだけの道具が持つ理由が無い
 * （2026-08-21 に旗ごと取り下げる裁定）。
 *
 * リンクは通さない。`--out` がリンクを指していると、置き場を空けるつもりの操作が
 * リンクそのものを消し、利用者が指した実体には何も書かれない（CP6 で実測）。
 */
function occupancyOf(dir: string): { error: import("./errors.ts").Problem } | { ok: true } {
  let here
  try {
    here = lstatSync(dir)
  } catch (error) {
    // 置き場がまだ無いのは正常な出発点である。それ以外（権限・親が無い）は書き出しの
    // 前に止める。書き始めてから気づくと、止めた時点の状態が中途半端になる
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { ok: true }
    return { error: { kind: "書き出し先を見られない", subject: dir, detail: reasonOf(error) } }
  }

  if (here.isSymbolicLink()) {
    return {
      error: {
        kind: "書き出し先がリンクを指している",
        subject: dir,
        detail: "置き場を空けるとリンクそのものが消える。リンク先を直に指す",
      },
    }
  }
  if (!here.isDirectory()) {
    return {
      error: {
        kind: "書き出し先を見られない",
        subject: dir,
        detail: "ディレクトリではない",
      },
    }
  }

  let entries
  try {
    entries = readdirSync(dir)
  } catch (error) {
    return { error: { kind: "書き出し先を見られない", subject: dir, detail: reasonOf(error) } }
  }
  if (entries.length === 0) return { ok: true }
  return {
    error: {
      kind: "書き出し先に前回の成果物が残っている",
      subject: dir,
      detail: `${entries.length} 件ある。別の置き場を指すか、中を空にしてから読ませる`,
    },
  }
}

/**
 * 一時ディレクトリの名前の頭。組む側と数える側で 1 つに保つ。
 *
 * 2 か所へ別々の綴りで置くと、片方を動かしたときに残骸を数える側が黙って外れる。
 *
 * **ASCII に閉じる。** Node 24.12.0 は、非 ASCII の名前を持つディレクトリを `rmSync` で
 * 消すとプロセスごと落ちる（この機械で実測。例外を投げず `catch` にも入らない。詳細は
 * `docs/records/20260903_rmsync-crashes-on-non-ascii-dir.md`）。巻き戻しはこの名前の
 * ディレクトリを消すので、置き場の名前をそのまま使うと**日本語の名前を付けた利用者
 * だけが、申告の出るはずの場面で黙って落ちる**。
 *
 * 置き場の名前を短い要約に替えて持つ。名前をそのまま使っていたのは、どの置き場の残骸か
 * を見分けるためだけなので、見分けがつけば綴りは要らない。
 */
export function stagingPrefix(dir: string): string {
  const mark = createHash("sha256").update(basename(dir)).digest("hex").slice(0, 8)
  return `.gen-scratch-${mark}.tmp-`
}

/**
 * 前の実行が残した一時ディレクトリを数える。
 *
 * 残るのは強制終了されたときだけで、そのときは申告も出せない。ドット始まりのうえ
 * 置き場の検分は親を見ないので、放っておくと出力 1 回分ずつ見えないまま積もる
 * （CP6 で実測）。**消さずに数える** ── 自分が作ったと確かめずに消す形は、入れ替えの
 * 旗を取り下げた裁定と逆を向く。消す判断は利用者に残す。
 */
function leftoversOf(dir: string): string[] {
  const prefix = stagingPrefix(dir)
  try {
    return readdirSync(dirname(dir)).filter(name => name.startsWith(prefix))
  } catch {
    // 親を読めないなら数えられない。ここで止める理由は無く、置き場の検分が別に見る
    return []
  }
}

/**
 * 出力の種類ごとの逃がし方。書き出すものは、どれを通ったかを必ず名乗る。
 *
 * 標準出力・標準エラーは `errors.ts` が入口を 1 つに絞り、走査が見張っている。ファイルの
 * 側に同じ形は取れない ── 出力の全体へ中和を掛けられないためである。記法は改行と字下げが
 * 意味を持ち、丸ごと中和すると `build` へ戻せない。逃がし方も種類ごとに違う（表を割る
 * 文字・YAML のコメントの改行・XML のコメントの記号）。
 *
 * **これは保証でなく強制である。** 宣言を書けば逃がしたことにはならない。効くのは、出力を
 * 足す人がこの一覧を見て「自分のはどれか」を選ばされる点だけである。逃がしが効いているか
 * は、敵対的な .sb3 で成果物の構造を測る検査が受け持つ。
 */
export const ESCAPES = Object.freeze({
  /** 記法（.sbk）。印の括弧と引数の目印を落とす。中和は掛けない */
  記法: "記法",
  /** 要約（markdown）。`cell` が表を割る文字とリンクの入口を逃がす */
  要約: "要約",
  /** 作品定義（YAML）。断りの行は中和し、値は YAML の書き手が引用する */
  定義: "定義",
  /** 図（SVG）。XML のコメントへ記号を 2 つ続けない */
  図: "図",
  /** 像（PNG）。文字を持たないので逃がすものが無い */
  像: "像",
  /**
   * 素材（他人の .sb3 から写した絵と音）。中身は一切解釈せずそのまま置く。
   *
   * 中身に逃がすものが無いのは、**この道具がこのバイト列を解釈しないから**である。
   * 図や記法と違い、読む先はここには無い。
   *
   * **名前の側は違う。** 他人の project.json が名乗る綴りがそのままファイル名になるので、
   * 形を見る守りが要る（`MD5EXT`）。守りは名前がこちらへ入る場所（`writtenAssets`）に
   * 置いてあり、ここへ届く時点で md5 と拡張子の形に限られている
   */
  素材: "素材",
})

/** 名乗ってよい逃がし方。`placeAll` はこの集合の外を置かない */
const KNOWN_ESCAPES = new Set(Object.values(ESCAPES) as string[])

/**
 * 組み上がったものを不可分に置く。全部を一時ディレクトリへ書き、揃ってから移す。
 *
 * 逐次で置き場へ書くと、輪の途中で失敗したときに新旧の混ざったディレクトリが残る。
 * 読み手には、どのファイルが今の読み取りの結果かが見分けられない。
 *
 * **中身のあるものは消さない。** 置き場を空けるのは、空のディレクトリを外す 1 手だけで
 * ある。検分を通った後に誰かがファイルを置いたら、その手が `ENOTEMPTY` で止まり、
 * 置かれたものはそのまま残る。時間の窓を狭めるのでなく、窓の中で起こることを無害に
 * している（2026-08-21 に入れ替えの旗を取り下げる裁定）。
 *
 * 宣言の無い出力は置かない。逃がし方を名乗らせるのは、出力の種類を足す人にこの一覧を
 * 見せて「自分のはどれか」を選ばせるためである（`ESCAPES` を参照）。名乗りが無いまま
 * 通ると、その一瞬が来ない。
 *
 * `write` は書き出す手。差し替えるのは検査だけで、不可分性を壊して落ちることを
 * 確かめるためである。
 */
export function placeAll(
  dir: string,
  built: { name: string; body: string | Buffer; escape?: string }[],
  write: (path: string, body: string | Buffer) => void = writeFileSync,
): { error: import("./errors.ts").Problem } | { ok: true } {
  const undeclared = built.filter(item => !KNOWN_ESCAPES.has(String(item.escape)))
  if (undeclared.length > 0) {
    return {
      error: {
        kind: "逃がし方を名乗らない出力がある",
        subject: dir,
        detail: `${undeclared.map(item => item.name).join("・")}`
          + `（${[...KNOWN_ESCAPES].join("・")} のどれかを名乗る）`,
      },
    }
  }

  // **毎回、新しい名前で作る。** PID を付けて使い回していたが、PID は再利用されるので
  // 前の実行の残骸を確かめずに消すことになる（消してよい側を数える、という A の裁定と
  // 逆を向く）。`mkdtemp` なら既に在るものへは当たらず、この関数が消すのは必ず
  // 自分がこの実行で作ったものになる。残骸は消さずに数えて申告する（2026-08-21 裁定）
  let staging
  try {
    // 置き場と同じ親の下に作る。別の親（作業ディレクトリ・一時領域）へ置くと、
    // 改名が装置をまたいで失敗しうる
    mkdirSync(dirname(dir), { recursive: true })
    staging = mkdtempSync(join(dirname(dir), stagingPrefix(dir)))
    for (const { name, body } of built) write(join(staging, name), body)
  } catch (error) {
    // 始末そのものが失敗しても、元の誤りを失わない。catch の中で投げると元の例外が
    // 消え、最上位に catch が無いので申告でなくスタックトレースで終わる
    let left = ""
    if (staging !== undefined) {
      try {
        rmSync(staging, { recursive: true, force: true })
      } catch {
        left = `。組み上がりかけたものは ${shownPath(staging)} に残っている`
      }
    }
    return {
      error: {
        kind: "読み取りの結果を書き出せない",
        subject: dir,
        detail: `${reasonOf(error)}${left}`,
      },
    }
  }

  try {
    // 空の置き場だけを外す。中身が無くても、既にあるディレクトリの上へは改名できない。
    // 中身があれば `ENOTEMPTY` で止まり、置かれたものには触れない ── 検分から書き出しまで
    // の間に図の描画が挟まって数分空くが、その窓で置かれたものを消さずに済む
    try {
      rmdirSync(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    renameSync(staging, dir)
  } catch (error) {
    return {
      error: {
        kind: "読み取りの結果を置き場へ移せない",
        subject: dir,
        detail: `${reasonOf(error)}。組み上がったものは ${shownPath(staging)} に残してある`,
      },
    }
  }
  return { ok: true }
}

/**
 * 既にある .sb3 を読み、記法・図・要約を書き出す。
 *
 * 全部を組み立て、一時ディレクトリへ書き切ってから置き場へ移す。`build` と
 * `knowledge` が採る規律と同じで、途中で失敗したときに半分だけ新しい出力が
 * 残らないようにするため。
 */
async function read(rest: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: "string" },
        format: { type: "string" },
        scale: { type: "string" },
        locale: { type: "string" },
        anyway: { type: "boolean" },
        help: { type: "boolean" },
      },
    })
  } catch (error) {
    return badArgs(error)
  }

  const gate = flagGate(parsed.values)
  if (gate !== null) return gate

  const input = parsed.positionals[0]
  if (!input) {
    announce`.sb3 を指定する\n\n`
    announceUsage(USAGE)
    return 1
  }

  const measured = scaleOf(parsed.values.scale)
  if ("error" in measured) {
    announce`${measured.error}\n`
    return 1
  }
  const scale = measured.scale

  const format = parsed.values.format ?? "svg"
  if (format !== "svg" && format !== "png") {
    announce`--format は svg か png を指定する: ${format}\n`
    return 1
  }

  const locale = parsed.values.locale ?? LOCALES[0]
  if (!LOCALES.includes(locale)) {
    announce`--locale は ${LOCALES.join(" か ")} を指定する: ${locale}\n`
    return 1
  }

  let bytes
  try {
    bytes = readFileSync(input)
  } catch (error) {
    announce`.sb3 を読めない: ${reasonOf(error)}\n`
    return 1
  }

  const reading = await readSb3(bytes, input, { locale, anyway: parsed.values.anyway })
  if (reading.problems.length > 0) {
    // 出どころごとに数を割る。ひとまとめの「申告が N 件ある」は、どこで止まったのかを
    // 読み手に問わせる。実体の同一性で分ける ── 種類の綴りで分けると、綴りを変えた
    // 瞬間に黙って戻る。
    //
    // 2 つに割っていたころは、台帳の申告と自分の資源上限による拒否が、それぞれ
    // 「読み切れなかった箇所」と「検証器が弾いた理由」を名乗っていた（どちらも偽。
    // CP6 で 2 観点が指摘）。`reading.refused` は使えない ── あの欄は「弾かれた
    // **うえで読み進んだ**」を表すので、止まったときは空になる
    for (const [heading, group] of announcementGroups(reading.problems)) {
      if (group.length === 0) continue
      announce`${heading}が ${group.length} 件ある\n`
      announceProblems(group)
    }
    // 1 つも読めていないなら書き出すものが無い。部分的に読めたものは書き出す
    if (reading.targets.length === 0) {
      escapeGuide(reading, input, parsed.values.anyway === true)
      readGuide()
      return 1
    }
  }

  // 入力の名前をそのまま置き場にしない。`...sb3` は `basename` が `..` を返すので、
  // 既定の置き場が作業ディレクトリになり、根にある同名のファイルを上書きする
  // （CP6 で実測）。ターゲット名と同じ規則で、置ける綴りへ落とす
  const dir = parsed.values.out ?? join("out", stemsFor([basename(input, extname(input))])[0])

  // 置き場は図を描く前に見る。描いてから止めると、上限を超えた作品では 180 秒あまりを
  // 費やしてから「使えない置き場だ」と言うことになる
  const occupancy = occupancyOf(dir)
  if ("error" in occupancy) {
    announce`書き出し先を使えない\n`
    announceProblems([occupancy.error])
    return 1
  }

  // 残骸は消さずに知らせる。前の実行が強制終了されたときだけ残り、そのときは申告も
  // 出せないので、次の実行が代わりに言う
  const leftovers = leftoversOf(dir)
  if (leftovers.length > 0) {
    announce`前の実行が残した一時ディレクトリが ${leftovers.length} 件ある\n`
    announce`  ${shownPath(dirname(dir))} の ${leftovers.join("・")}\n`
    announce`  読み取りは消さない。中身を確かめてから消す\n`
  }

  const wanted = reading.targets.reduce((sum, target) => sum + target.scripts.length, 0)
  if (wanted > FIGURE_LIMIT) {
    announce`図が多すぎる。書き出さない\n`
    announceProblems([
      {
        kind: "図の本数が上限を超えた",
        subject: input,
        detail: `${wanted} 本あり、上限 ${FIGURE_LIMIT} 本を超えた`,
      },
    ])
    readGuide()
    return 1
  }

  // 名前だけを持ち、置き場と繋ぐのは書き出す時にする。組み立ての途中で置き場の綴りを
  // 混ぜると、一時ディレクトリへ書いてから移す経路で付け替えが要る
  const built: { name: string; body: string | Buffer; escape: string }[] = []
  const undrawn: import("./errors.ts").Problem[] = []
  // 要約の対応表が指す実ファイル。書いた側が数える ── 幹と拡張子から組み立て直すと、
  // 落とした図の番号まで表に載り、表が実在しないファイルを案内する
  const files = new Map<string, string[]>()

  for (const target of reading.targets) {
    // スクリプトが 1 本も無いターゲットでも書き出す。要約の対応表がこの名前を指すので、
    // 落とすと表が実在しないファイルを案内する。中身は空にする
    const written = [`${target.stem}.sbk`]
    files.set(target.stem, written)
    built.push({
      name: `${target.stem}.sbk`,
      body: target.scripts.length === 0 ? "" : `${target.scripts.join("\n\n")}\n`,
      escape: ESCAPES.記法,
    })
    for (const [index, script] of target.scripts.entries()) {
      const drawn = await drawScript(script, `${input}: ${target.name}`, scale, format)
      if ("error" in drawn) {
        // 描けなかった 1 枚のために、読めた記法も要約も断りも捨てない。逃げ道
        // （`--anyway`）は「読めるところまで読む」ための旗であり、図の 1 本で全部を
        // 落とすとその趣旨と正面から反する（TASK0015 の CP6 が指摘）。落としたことは
        // 申告・要約・`project.yaml` の 3 か所へ残す。
        //
        // **今ここへは落ちない。保険である** ── `drawScript` の doc のとおり、読み取りが
        // 入れ子を止める深さでは解析器も描画器も投げない。落ちたときに読めた側が残る
        // ことは、`drawScript` に細工をして手で確かめた（2026-08-21）
        undrawn.push(drawn.error)
        continue
      }
      const name = `${target.stem}-${index + 1}.${format}`
      written.push(name)
      const body = format === "svg" ? markedSvg(drawn.body, reading) : drawn.body
      built.push({ name, body, escape: format === "svg" ? ESCAPES.図 : ESCAPES.像 })
    }
  }

  if (undrawn.length > 0) {
    announce`図にできないスクリプトが ${undrawn.length} 本ある\n`
    announceProblems(undrawn)
  }

  // 素材は記法と図を組み終えてから足す。先に取ると、素材が取れなかったときに
  // 読めた側まで組み上がらない
  const lostAssets = await placeAssets(bytes, reading, built, files)
  if (lostAssets.length > 0) {
    announce`.sb3 の中に無い素材が ${lostAssets.length} 件ある\n`
    announceProblems([
      {
        kind: "素材が .sb3 に入っていない",
        subject: input,
        detail:
          `${lostAssets.length} 件を落とした: ` +
          lostAssets.slice(0, LOST_ASSETS_SHOWN).join("・"),
      },
    ])
  }

  // 復元した定義は、組み立てが使うのと同じ規則で確かめてから書く。通らない定義を
  // 書き出すと、読み手はそれを直せる入力だと思って `build` へ渡し、そこで初めて
  // 止まる。読めた側（記法・図・要約）は書き、定義だけを落として理由を申告する
  const definition = definitionOf(reading, basename(input, extname(input)))
  const unfit = definitionProblems(definition).problems
  if (unfit.length > 0) {
    announce`復元した作品定義が組み立てを通らない。定義は書き出さない\n`
    announceProblems(unfit)
  }

  // 要約は図を描き、定義の可否が決まってから組む。落とした本数も落とした定義も要約が
  // 数えるので、先に組むと実装が数えた値でなくなる
  const summary = summaryOf(reading, input, { undrawn, files, format, unfit })
  built.push({ name: "summary.md", body: summary, escape: ESCAPES.要約 })

  if (unfit.length === 0) {
    built.push({
      name: "project.yaml",
      body: `${noticeOf(reading, undrawn)}${stringifyYaml(definition)}`,
      escape: ESCAPES.定義,
    })
  }

  try {
    // 同じ書き出し先が 2 度現れたら止める。上流の採番が破れると、後の書き込みが前の
    // 書き込みを黙って消し、終了コードは 0 のまま件数だけが合わなくなる（2026-08-20 に
    // 実際に起きた）。素材の名前で同じ事故を止めている `packSb3` と規則を揃える。
    //
    // **今この砦へは到達しない。保険である** ── 採番（`stemsFor`）が重なりを出さなく
    // なったため。採番を壊すと実際にここが発火し、黙る代わりに止まる（破壊で確かめた）
    const seen = new Set()
    for (const { name } of built) {
      // 畳んで数える。文字列の一致で見ると、大文字小文字だけが違う名前をこの砦が
      // 通してしまい、Windows と macOS で片方が消える（CP6 で実測）
      const key = foldedName(name)
      if (seen.has(key)) throw new Error(`書き出し先が重複している: ${name}`)
      seen.add(key)
    }
  } catch (error) {
    announce`書き出せない\n`
    announceProblems([{ kind: "読み取りの結果を書き出せない", subject: dir, detail: reasonOf(error) }])
    return 1
  }

  // **素材は数えない。** この線が縛るのは「値を印へ変える設計で出力が膨張する」性質で、
  // 入力から 1 対 1 で写る素材はその性質を持たない。素材は入口が縛る
  // （`ASSET_TOTAL_LIMIT`）。除く側を明示しないと、素材を一覧へ入れた時点で黙って合算され、
  // Scratch が受け取る大きさの作品が「書き出す量が多すぎる」で落ちる（CP6 で 6 観点が
  // 独立に指摘し、6 MB の素材を持つ作品が読めないことを実測した）
  const produced = built.reduce(
    (sum, item) => (item.escape === ESCAPES.素材 ? sum : sum + Buffer.byteLength(item.body)),
    0,
  )
  if (produced > OUTPUT_LIMIT) {
    announce`書き出す量が多すぎる。書き出さない\n`
    announceProblems([
      {
        kind: "書き出す量が上限を超えた",
        subject: input,
        detail: `${produced} バイトになり、上限 ${OUTPUT_LIMIT} バイトを超えた`,
      },
    ])
    readGuide()
    return 1
  }

  const placed = placeAll(dir, built)
  if ("error" in placed) {
    announce`書き出せない\n`
    announceProblems([placed.error])
    return 1
  }

  // 素材は数えない。拡張子だけで数えると、`--format svg` のとき svg の素材が図として
  // 数えられる（素材と図は同じ拡張子で同じ置き場に並ぶ）
  const figures = built.filter(
    item => item.escape !== ESCAPES.素材 && item.name.endsWith(`.${format}`),
  ).length
  // 落としたターゲットがあるのに「作品定義あり」とだけ言わない。定義は書けているが
  // 元の作品の全部ではなく、その差は報告からしか分からない（CP6 で指摘）
  // 落とした件数は定義の可否と別に出す。定義が書けた枝にだけ添えていたので、定義が
  // 落ちると落としたターゲットの件数まで報告から消えていた（CP6 の指摘）
  const restored = unfit.length === 0 ? "作品定義あり" : "作品定義なし"
  const lost =
    reading.dropped.length > 0 ? ` / ターゲット ${reading.dropped.length} 件を落とした` : ""
  // 素材の件数も出す。出さないと、素材を持つ作品と持たない作品が同じ報告になる
  const assets = built.filter(item => item.escape === ESCAPES.素材).length
  const dropped = lostAssets.length > 0 ? ` / 素材 ${lostAssets.length} 件を落とした` : ""
  const counts = `ターゲット ${reading.targets.length} 件 / 図 ${figures} 件 / 素材 ${assets} 件`
  report`${dir}\n  ${counts} / ${restored}${lost}${dropped}\n`
  // 図を落としたことも素材を落としたことも 0 で終わらせない。書けなかったものがあるのに
  // 成功で返すと、呼び出し側は全部揃ったものとして次へ渡す。**素材だけ 0 を返していた
  // ため、素材 1 件の破損で全素材が消えても成功で終わっていた**（CP6 の再評価層が実測）
  return reading.problems.length > 0 ||
    unfit.length > 0 ||
    undrawn.length > 0 ||
    lostAssets.length > 0
    ? 1
    : 0
}

/** 作品定義の断りへ並べる欄の数。全部は要約が数えるので、ここは頭だけ出す */
const NOTICE_KEY_LIMIT = 4

/**
 * 取れなかった素材を、申告に何件まで並べるか。
 *
 * 名前は中身の md5 なので 1 件 36 文字ある。全部並べると 1 行が読めなくなる。
 * 件数そのものは上に出しているので、ここは手掛かりの列である
 */
const LOST_ASSETS_SHOWN = 4

/**
 * 逃げ道を通したことを、図の側にも残す。
 *
 * `project.yaml` には印を置いたが、図と記法は名乗っていなかった（TASK0015 の CP6 が
 * 指摘）。記法（`.sbk`）には置けない ── 記法にコメントの構文が無く、`build` が
 * ブロックとして読んで止まる（2026-08-20 実測）。SVG にはコメントの構文があるので置く。
 * PNG は像なので置けず、要約の断りが引き受ける。
 *
 * 文面に `-` を 2 つ続けない。XML のコメントは中に `--` を持てず、置くと図そのものが
 * 開けなくなる。旗の名前をそのまま書けないのはこのためである。
 */
function markedSvg(svg: string | Buffer, reading: { refused: unknown[] }): string | Buffer {
  if (reading.refused.length === 0) return svg
  return [
    "<!--",
    "  Scratch 公式の検証器が弾いた作品から、逃げ道の旗を立てて読み取った図である。",
    "  記法が実物と食い違うことがある。詳しくは同じディレクトリの summary.md を見る。",
    "-->",
    svg,
  ].join("\n")
}

/**
 * 落としたものと出自を、作品定義の先頭に残す。
 *
 * 落とした事実が `summary.md` の散文にしか無いと、`project.yaml` だけを受け取った人には
 * 欠けが見えず、正当な作品由来と見分けが付かない（CP6 で 5 観点が指摘）。記法（`.sbk`）
 * には置けない ── 記法にコメントの構文が無く、`build` がブロックとして読んで止まる
 * （2026-08-20 実測）。
 *
 * 断りは 2 段に分ける。**例外**（逃げ道・落としたターゲット・図の欠け）は起きたときだけ
 * 出し、**常にある欠け**（復元しない属性）は必ず 1 行で出す。前者を常に付けると読み手は
 * 印を見なくなるが、後者は例外でないので出さないと嘘になる（2026-08-21 裁定）。
 *
 * 名前は中和して載せる。他者の .sb3 は名前に改行を入れられる。そのまま置くとコメントが
 * そこで終わり、続きが定義の一部として読まれる。
 *
 * `undrawn` は図にできなかったスクリプト
 */
function noticeOf(reading: import("./read.ts").Reading, undrawn: import("./errors.ts").Problem[]): string {
  const lines = []
  if (reading.refused.length > 0) {
    lines.push(
      "# Scratch 公式の検証器が弾いた作品から、--anyway で読み取った定義である。",
      "# 組み立て直せるとは限らず、記法が実物と食い違うことがある。",
    )
  }
  if (reading.dropped.length > 0) {
    lines.push(`# 記法へ戻せず落としたターゲットが ${reading.dropped.length} 件ある。`)
    for (const { name, reason } of reading.dropped) {
      lines.push(`#   ${neutralize(name)}: ${neutralize(reason)}`)
    }
  }
  if (undrawn.length > 0) {
    lines.push(
      `# 図にできなかったスクリプトが ${undrawn.length} 本ある。記法には入っている。`,
    )
  }
  const unrestored = reading.unrestored ?? []
  if (unrestored.length > 0) {
    // 一覧の全部は載せない。要約が同じものを数え上げているので、ここは「一部である」
    // ことが伝わる長さに留める
    // 欄の名前も他者の .sb3 が決める。JSON のキーは改行を持てるので、中和せずに置くと
    // コメントがそこで終わり、続きが定義の一部として読まれる（CP6 で 4 観点が実測。
    // 8 行上の落としたターゲットには掛けてあり、同じ関数の中で規則が割れていた）
    const head = unrestored
      .slice(0, NOTICE_KEY_LIMIT)
      .map(field => neutralize(fieldLabel(field)))
      .join("・")
    const over = unrestored.length - NOTICE_KEY_LIMIT
    const rest = over > 0 ? `・ほか ${over} 種` : ""
    lines.push(`# この定義は .sb3 の一部である。写さない欄: ${head}${rest}`)
  }
  if (lines.length === 0) return ""
  lines.push("# 詳しくは同じディレクトリの summary.md を見る。", "")
  return lines.join("\n")
}

/**
 * 記法を図にしてよいかを見る砦。
 *
 * 同じ規則を 2 か所に書かない。`render` の入口にしか無かったころは、読み取りの描画経路が
 * 同じものを素通しした ── 寸法 0 の図と、認識できない記述を含む図である。規則をここへ
 * 置き、止めるか落とすかだけを呼ぶ側に決めさせる（`render` は止め、`read` はその 1 本を
 * 落として読めた側を書く）。
 *
 * **読み取りの経路では今のところ発火しない。保険である** ── 読み取りが出す記法は
 * 逆変換器が書き起こしたもので、印のコメントも値の印も認識され、ブロックとして
 * 数えられる
 * （2026-08-22 実測。印だけの行・値の印を含む行・敵対的な名前を含む行のいずれも
 * ブロック 1 件・認識できない 0 件だった）。効くのは、逆変換器が書けない記法を出すように
 * なったときと、印の綴りを変えたときである。
 *
 * 検査から呼べるようにしてある。`render` と `read` の双方から同じものが呼ばれることは
 * 走査でしか測れないが、規則そのものはここを直に呼んで測れる。
 *
 *   図にしてよければ null
 *
 * `doc` は解析済みの記法
 * `code` は解析に渡した綴り。行を指すために要る
 */
export function undrawable(doc: any, code: string): { reason: string, unknown: { line: number, text: string }[] } | null {
  // 空の入力は寸法 0 の図になる。無言で書き出すと成功と見分けが付かない
  if (countBlocks(doc) === 0) return { reason: "ブロックが 1 つも無い", unknown: [] }

  const unknown = findUnrecognized(doc, code)
  if (unknown.length > 0) {
    return { reason: `認識できないブロックが ${unknown.length} 件ある`, unknown }
  }
  return null
}

/**
 * スクリプト 1 本を図にする。解析も描画も投げずに問題として返す。
 *
 * **今この受け口へは落ちない。保険である。** 解析器と描画器が壊れるのは深い入れ子だが、
 * 読み取りは入れ子を 156 段で止めるので、そこまで深い記法がここへ来ない。実測では
 * 深さ 1200 の記法でも図になった（2026-08-20・Node 24.19.0）。上限を上げたときと、
 * 上流が別の理由で投げるようになったときに効く。
 *

 */
async function drawScript(script: string, subject: string, scale: number, format: "svg" | "png"): Promise<{ body: string | Buffer } | { error: { kind: string, subject: string, detail?: string } }> {
  const { doc, problems } = await readNotation(script, subject)
  if (doc === null) return { error: problems[0] }

  // `render` と同じ砦を通す。寸法 0 の図と、認識できない記述を含む図を書かない
  const refused = undrawable(doc, script)
  if (refused) {
    return { error: { kind: "記法を図にできない", subject, detail: refused.reason } }
  }

  try {
    const svg = await renderSvg(doc, { scale })
    return { body: format === "png" ? svgToPng(svg) : svg }
  } catch (error) {
    return { error: { kind: "図を書き出せない", subject, detail: reasonOf(error) } }
  }
}

/**
 * 知識層の生成した層を組み立て、各ページへ差し込む。
 *
 * ブロック解説の一覧は台帳から、作品定義の仕様は定義の表から出る。どちらも人が書いた
 * 説明には触らず、目印で囲んだ一覧だけを差し替える。出どころが変われば `--check` が
 * 落ち、記述が古びたことが分かる。
 *
 * 台帳の位置を引数で受けるのは、壊れた台帳を渡す検査のためである。旗にはしない ──
 * 利用者が別の台帳を指す用途は無く、旗にすると追跡下でない台帳から知識層を組み立てて
 * しまう道ができる。`buildProject` が `catalogPath` を受けるのと同じ理由と形である。
 *
 * `options` は台帳の位置。
 */
export async function knowledge(
  rest: string[],
  options: { catalogPath?: string | URL } = {},
): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        dir: { type: "string" },
        check: { type: "boolean" },
        help: { type: "boolean" },
      },
    })
  } catch (error) {
    return badArgs(error)
  }

  const gate = flagGate(parsed.values)
  if (gate !== null) return gate

  const catalog = loadCatalog(options.catalogPath)
  if (!catalog.raw || catalog.problems.length > 0) {
    // 項目が 1 つ壊れているだけでも止める。落ちた項目は一覧から黙って消えるので、
    // 書き上がった知識層は欠けたことを自分では名乗れない
    announce`知識層を組み立てられない。申告が ${catalog.problems.length} 件ある\n`
    announceProblems(catalog.problems)
    return 1
  }
  const raw = catalog.raw

  // 衝突の測定は内側で解析器を直に呼ぶ。投げると中和も畳み込みも通らずに出る
  let found
  try {
    const measured = await labelCollisions(raw)
    found = measured.collisions
    for (const problem of measured.problems) announce`綴りの衝突を測れない: ${problem}\n`
    if (measured.problems.length > 0) return 1
  } catch (error) {
    announce`綴りの衝突を測れない\n`
    announceProblems([{ kind: "綴りの衝突を測れない", subject: "台帳", detail: reasonOf(error) }])
    return 1
  }

  const dir = parsed.values.dir ?? KNOWLEDGE_DIR
  const pages = [
    ...CATEGORIES.map(({ key, label }) => ({
      path: join(dir, "blocks", `${key}.md`),
      body: categoryTable(raw, key),
      marks: CATALOG_MARKS,
      origin: "台帳",
      count: raw[CATALOG_KEYS.BLOCKS].filter(
        (block: Entry) => block.category === key,
      ).length,
      label,
    })),
    {
      path: join(dir, "blocks", "README.md"),
      body: scopeReport(raw, found),
      marks: CATALOG_MARKS,
      origin: "台帳",
      count: 0,
      label: CATALOG_KEYS.SCOPE,
    },
    {
      // 作品定義の仕様は台帳でなく実装の表から出る。生成の仕組みは同じなので同じ経路に置く
      path: join(dir, "project-definition.md"),
      body: definitionTable(),
      marks: DEFINITION_MARKS,
      origin: "定義の表",
      count: 0,
      label: "作品定義のキー",
    },
  ]

  // 全ページを組み立ててから書く。読みながら書くと、途中で失敗したときに先行ページ
  // だけが書き換わり、半分だけ新しい知識層が残る（build 側の「検証は書き出しの前に
  // 置く」と同じ規律）
  const built: { page: (typeof pages)[number]; current: string; lf: string; text: string }[] =
    []
  for (const page of pages) {
    let current
    try {
      current = readFileSync(page.path, "utf8")
    } catch (error) {
      announce`解説を読めない: ${reasonOf(error)}\n`
      return 1
    }

    // 追跡下のテキストは LF で持つ（`.gitattributes`）。読んだものを揃えてから差し込む。
    // 揃えずに差し込むと CRLF のページへ LF の一覧が入り、改行が混ざったまま `--check` が
    // 緑になる（実測 2026-08-19。1 ページに CRLF 22 行と単独 LF 26 行が同居した）
    const lf = withLf(current)
    const rendered = renderInto(lf, page.body, page.marks)
    if ("error" in rendered) {
      announce`${page.path}: ${rendered.error}\n`
      return 1
    }
    built.push({ page, current, lf, text: rendered.text })
  }

  if (parsed.values.check) {
    let wrong = 0
    for (const { page, current, lf, text } of built) {
      if (text === current) continue
      wrong += 1
      // 改行だけの違いを「古い」と言わない。中身は合っているのに一覧を作り直せと言われ、
      // 作り直しても改行が混ざるだけで直らない
      if (text === lf) {
        announce`改行が LF でない: ${page.path}\n`
        continue
      }
      // 出どころを名指す。目印は出どころごとに分けてあるのに、申告が「台帳」で揃って
      // いると、実装の表から出るページの直し先を誤って伝える
      announce`生成した層が古い。${page.origin}と一致しない: ${page.path}\n`
    }
    if (wrong > 0) {
      announceRerun("書き出し直す", "node src/cli.ts knowledge", "--dir", parsed.values.dir)
      return 1
    }
  } else {
    for (const { page, current, text } of built) {
      if (text === current) continue
      try {
        writeFileSync(page.path, text)
      } catch (error) {
        announce`解説を書き出せない\n`
        announceProblems([
          { kind: "解説を書き出せない", subject: page.path, detail: reasonOf(error) },
        ])
        return 1
      }
    }
  }

  const covered = pages.reduce((sum, page) => sum + page.count, 0)
  const summary =
    `${CATEGORIES.length} カテゴリ / ブロック ${covered} 件` +
    ` / 綴りの衝突 ${found.length} 組 / 定義のキー ${definitionKeyCount()} 個`
  report`${parsed.values.check ? "生成した層は最新" : dir}\n  ${summary}\n`
  return 0
}

/**
 * 申告を出どころごとに分け、見出しと組にして返す。
 *
 * 見出しが述べるのは「どこで止まったか」である。ひとまとめの「申告が N 件ある」だと、
 * 読み手は自分の作品が悪いのか道具が悪いのかを自分で当てることになる。
 *
 * **分けるのは印であって種類の綴りではない。** 綴りで分けると、綴りを変えた瞬間に
 * 黙って戻る。印は申告を作る側が付ける（`validate.ts` の `refusal` / `intake`、
 * `catalog.ts` の `catalog`）。
 *
 * 並べる順は、読み手が手を打てる順である ── こちらの都合（資源の上限・台帳）が先で、
 * 作品の中身の話が後になる。印を持たないものが最後の組へ落ちるので、次に印を足した
 * 申告も行き先を失わない。
 *
 * 検査から呼べるようにしてある。見出しの選び分けは純粋な規則なので、CLI を通さずに
 * 測れる（`read` の口は台帳の位置を受けないため、壊れた台帳での見出しは端から測れない）。
 */
export function announcementGroups(problems: import("./errors.ts").Problem[]): [string, import("./errors.ts").Problem[]][] {
  const intake = problems.filter(problem => problem.intake === true)
  const catalog = problems.filter(problem => problem.catalog === true)
  const rejected = problems.filter(
    problem => problem.refusal === true && problem.intake !== true,
  )
  const rest = problems.filter(
    problem =>
      problem.intake !== true && problem.catalog !== true && problem.refusal !== true,
  )
  return [
    ["受け入れ検査で断った理由", intake],
    ["台帳を使えない理由", catalog],
    ["検証器が弾いた理由", rejected],
    ["読み切れなかった箇所", rest],
  ]
}

/**
 * 逃げ道への案内を添える。
 *
 * 弾かれて止まったときに戻り道を示さないのは、既存の慣行（`writeGuide`）と不整合で
 * ある。旗の名前は USAGE にしか無く、止まった画面からは辿れなかった（TASK0015 の CP6 が
 * 指摘）。
 *
 * **勧めてよい場面を数える（許可リスト）。** 旗が効くのは、検証器が弾いたことだけを
 * 理由に止まったときに限る。効かない場面を数える形にしていたところ、受け入れ検査の
 * 拒否 1 つしか塞いでおらず、zip として開けない入力・台帳の壊れ・全ターゲットが記法へ
 * 戻せない場合・ターゲット過多の 4 経路で効かない一手を勧めていた（2026-08-22 実測。
 * zip でないファイルに勧め、実際に旗を付けても同じ理由・同じ終了コードで止まった）。
 *
 * 既に旗を立てているなら出さない ── 立てても止まったなら、旗では直らない。
 *
 * `input` は読ませた .sb3
 * `anyway` は旗が立っているか
 */
function escapeGuide(reading: { problems: { refusal?: boolean, intake?: boolean }[] }, input: string, anyway: boolean) {
  if (anyway) return
  // 旗が降ろすのは検証器の判定だけである。受け入れ検査（資源の上限）の拒否は降ろさない
  const helps = reading.problems.some(
    problem => problem.refusal === true && problem.intake !== true,
  )
  if (!helps) return

  const { text, safe } = quotedPath(input)
  announce`読めるところまで読む: node src/cli.ts read ${text} --anyway\n`
  if (!safe) announce`  綴りに引用を壊す文字があるため、この行はそのまま打てない\n`
  announce`  検証は飛ばさない。弾いた理由と保証しないことを申告して読み進む\n`
}

/**
 * 止まったときに見る先を添える。
 *
 * 行番号の出る申告にも出ない申告にも同じように付ける。出ない側にだけ付けると、実際に
 * 書き手がよく踏む側（台帳に無いブロック・宣言の無い名前）へ案内が届かない。
 *
 * 区切りは `/` に固定する。読み手が開くのは markdown のパスであり、`join` に任せると
 * Windows だけ `\` になる。
 */
function writeGuide() {
  // 置き場はリポジトリからの位置で決め、打った場所からの相対で見せる。定数のまま出すと、
  // リポジトリの外から実行したときに解決しないパスを案内する
  const guide = new URL(`../${KNOWLEDGE_DIR}/howto.md`, import.meta.url)
  announce`詰まったときに見るもの: ${shownPath(guide)}\n`
}

/**
 * 読み取りが止まったときに見る先を添える。
 *
 * 書く向きの `writeGuide` と同じ形で、示す先だけが違う。読み取りの停止を手順書へ
 * 送ると、書く側の表に読む側の申告が無く、読み手が行き止まる。示す先は読む側の
 * ページ（止まったときの表と逃げ道の説明を持つ）にする。
 */
function readGuide() {
  const guide = new URL(`../${KNOWLEDGE_DIR}/reading.md`, import.meta.url)
  announce`詰まったときに見るもの: ${shownPath(guide)}\n`
}

function defaultOut(input: string, format: string | undefined) {
  const stem = basename(input, extname(input))
  return join("out", `${stem}.${format ?? "svg"}`)
}

// テストから main だけを読み込めるよう、直接起動されたときにのみ走らせる
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    // 最上位の受け口。無いと未捕捉例外が生のスタックトレースを出し、絶対パスの畳み込みも
    // 中和も通らずに利用者名とディレクトリ構成が漏れる。ここへ落ちるのはこちらの落ち度で
    // あって入力の誤りではないので、そう名乗る。
    //
    // **今ここへは落ちない。保険である** ── `main` の下は全部が受け口を持つ。細工で
    // 投げさせて確かめた（2026-08-22。受け口が無いと 795 バイトのスタックトレースが出て
    // 利用者名を含む絶対パスが 3 か所に載る。受け口を通すと 3 行になり、パスは打った
    // 場所からの相対へ畳まれた）
    announce`思わぬところで止まった。入力の誤りではなく、こちらの落ち度である\n`
    announceProblems([
      {
        kind: "内部で例外が出た",
        subject: process.argv.slice(2).join(" ") || "(引数なし)",
        detail: reasonOf(error),
      },
    ])
    process.exitCode = 1
  }
}
