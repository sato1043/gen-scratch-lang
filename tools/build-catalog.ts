/**
 * ブロックの台帳を組み立てる。
 *
 * 図と .sb3 は同じ台帳から導く。日本語ラベル・記法・opcode・引数名の対応が 2 箇所に
 * 散ると、両者が食い違ったときにどちらが正しいかを決められなくなる。
 *
 * 台帳は生成物であり、生成元は 4 つに限る。
 *
 * | 生成元 | 与えるもの |
 * |---|---|
 * | scratchblocks の定義表 | 識別子・英語の記法・引数の種別・形状・カテゴリ |
 * | scratchblocks の日本語辞書 | 日本語ラベル |
 * | scratch-blocks のブロック定義 | opcode・引数名 |
 * | 手書きの例外表 | 機械で導けないもの |
 *
 * このファイルは開発者向けである。組み立てには開発依存の scratch-blocks が要るため、
 * 利用者が実行する経路（render・build・knowledge）からは切り離してある。
 */
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import commands from "scratchblocks/syntax/commands.js"
import { EXCEPTIONS } from "../catalog/exceptions.ts"
import { CORE_EXTENSIONS, EXTENSION_DEFINITIONS } from "../catalog/extensions.ts"
import {
  MENU_OPTIONS,
  NAME_KINDS,
  OPTIONS,
  SUPPLEMENT,
} from "../catalog/dropdowns.ts"
import { FALLBACK, PRIMITIVES, SHADOWS } from "../catalog/shadows.ts"
import { PROVENANCE } from "../catalog/provenance.ts"
import { indexByIdentifier, readDefinitions } from "./opcodes.ts"
import { CATALOG_KEYS, byName, type ScopeEntry } from "../src/catalog.ts"
import { PREFIXES, isKind, prefixOf } from "../src/notation.ts"

const require = createRequire(import.meta.url)

/** 逆変換器の表。メニューの欄の名前（`remap`）をここから引く */
const { allBlocks } = require("parse-sb3-blocks") as {
  allBlocks: Record<string, { remap?: Record<string, string> }>
}

/** Scratch の core の 9 カテゴリ。拡張機能はここに入らない */
export const CORE_CATEGORIES = [
  "motion",
  "looks",
  "sound",
  "events",
  "control",
  "sensing",
  "operators",
  "variables",
  "list",
]

/**
 * 台帳が扱うカテゴリ。core の 9 つに、扱うと裁定した拡張機能を足したもの。
 *
 * core と分けてあるのは、2 つが別の問いに答えるためである。core は Scratch の
 * 側が決めた区分で、こちらはこの環境が扱うと決めた範囲である。pen を足したのは
 * TASK0024（線を引く手段が無いと絵を描く作品が作れないため）。
 */
export const LISTED_CATEGORIES = [...CORE_CATEGORIES, "pen"]

/** 台帳が扱うブロックの opcode の接頭辞。台帳から到達しない opcode を数えるのに使う */
const LISTED_PREFIXES = [
  "motion_",
  "looks_",
  "sound_",
  "event_",
  "control_",
  "sensing_",
  "operator_",
  "data_",
  "pen_",
]

/**
 * 例外表が取れる種別。ここに無い種別を黙って受け取ると、台帳から静かにブロックが落ちる
 */
const KINDS = ["override", "option", "not-a-block", "legacy", "duplicate"]

/**
 * 台帳の形は読む側（`src/catalog.ts`）が定義する。作る側で定義すると、読む側が形を知る
 * ために生成側を参照することになり、開発依存を分けた意味が無くなる。
 */
type CatalogArgument = import("../src/catalog.ts").CatalogArgument
type Entry = import("../src/catalog.ts").Entry
type Catalog = import("../src/catalog.ts").Catalog

/** 台帳へ載せず、覆わない範囲として申告するもの */
type Excluded = {
  identifier: string | null
  selector: string | null
  spec: string
  reason: string
}

type Problem = {
  kind: string
  subject: string
  detail: string
}

/**
 * 台帳を組み立てる。整合の破れは投げずに問題として返し、報告の判断を呼び出し元に残す。
 *
 * 例外表を差し替えられるのは、整合検査そのものを壊して落ちることを確かめるため。
 * 検査が実際に見張っているかは、破ってみせない限り分からない。
 *
 */
export function buildCatalog({
  exceptions: table = EXCEPTIONS,
  provenance: sources = PROVENANCE,
}: { exceptions?: any[]; provenance?: any[] } = {}): {
  catalog: Catalog
  problems: Problem[]
} {
  const { version: blocksVersion, definitions: core } = readDefinitions()
  // 拡張機能の定義は scratch-blocks に無い（実測で `pen_` は 0 件）。別出典から
  // 写したものを同じ列へ載せ、以降の照合を 1 本の道に保つ
  const definitions = [...core, ...EXTENSION_DEFINITIONS]
  const byIdentifier = indexByIdentifier(definitions)
  const byOpcode = new Map(definitions.map(d => [d.opcode, d]))
  const known = new Set(byOpcode.keys())
  const ja = loadJapanese()

  const problems: Problem[] = []
  const exceptions = indexExceptions(table, problems)
  const used = new Set()

  const blocks: Entry[] = []
  const excluded: Record<string, Excluded[]> = {
    option: [],
    "not-a-block": [],
    legacy: [],
    duplicate: [],
  }

  for (const command of commands) {
    if (!LISTED_CATEGORIES.includes(command.category)) continue

    const key = command.id ?? command.selector
    const exception = exceptions.get(key)
    if (exception) used.add(key)

    if (exception && exception.kind !== "override") {
      excluded[exception.kind].push({
        identifier: command.id ?? null,
        selector: command.selector ?? null,
        spec: command.spec,
        reason: exception.reason,
      })
      continue
    }

    // 例外表は opcode を書かずに引数だけを直すことがある。書いていなければ導く
    const opcode = exception?.opcode ?? resolve(command, byIdentifier, problems)
    if (!opcode) continue

    if (!byOpcode.has(opcode)) {
      problems.push({
        kind: "opcode が実在しない",
        subject: key,
        detail: `例外表は ${opcode} を指すが scratch-blocks に定義が無い`,
      })
      continue
    }

    const definition = byOpcode.get(opcode)
    // 直前の has で在ることは確かめてある。型の上でも絞っておく
    if (!definition) continue
    // 見出しも引数も無い定義は、中身を scratch-gui が実行時に埋めるもの。引数名は
    // 読み取れない。引数を持たないブロック（`hide` 等）と混ぜず、空配列と null で分ける
    const empty =
      definition.identifiers.length === 0 && definition.args.length === 0

    // 上流の定義が誤っているとき、例外表が引数の種別を差し替える
    const inputs = exception?.inputs ?? command.inputs ?? []
    blocks.push({
      identifier: command.id,
      opcode,
      category: command.category,
      shape: command.shape,
      spec: command.spec,
      ja: ja[command.id] ?? null,
      inputs,
      args: empty
        ? null
        : pair(opcode, key, inputs, definition.args, known, problems),
      alsoCovers: (exception?.alsoCovers ?? []).map((covered: string) =>
        cover(covered, key, inputs, byOpcode, known, problems),
      ),
      // 引数だけを直す例外もあるので、opcode を書いた例外だけが出どころになる
      opcodeFrom: exception?.opcode ? "例外表" : "定義",
    })
  }

  for (const [key, exception] of exceptions) {
    if (used.has(key)) continue
    problems.push({
      kind: "例外表の項目が使われていない",
      subject: key,
      detail: `kind=${exception.kind}。core のどのブロックにも当たらない`,
    })
  }

  problems.push(...findCollisions(blocks))
  problems.push(...staleProvenance(blocksVersion, sources))

  // 欄の名前は読む側と同じところから取る。片方だけ改名しても JSON の添字引きは
  // undefined を返すだけで止まらない
  return {
    catalog: {
      [CATALOG_KEYS.ORIGIN]: {
        scratchblocks: version("scratchblocks"),
        "scratch-blocks": blocksVersion,
        手書きの表: handwrittenFingerprint(table),
      },
      [CATALOG_KEYS.SOURCES]: tablesNotDerived(sources),
      [CATALOG_KEYS.COUNTS]: {
        台帳: blocks.length,
        "opcode を例外表から得た": blocks.filter(b => b.opcodeFrom === "例外表")
          .length,
        "引数名を取れない": blocks.filter(b => b.args === null).length,
      },
      [CATALOG_KEYS.BLOCKS]: blocks,
      [CATALOG_KEYS.SCOPE]: uncovered(blocks, definitions, excluded),
    },
    problems,
  }
}

/**
 * 記法の引数と .sb3 の引数を突き合わせ、入力ごとに敷く影ブロックを決める。
 *
 * 記法の引数は書かれた順に `%1 %2` と並び、.sb3 の引数も同じ英文から起こされるため
 * 順で対応する。C 型の中身（statement）は記法に `%` を持たないので数から外す。
 *
 * `key` は問題の報告に使う対象名
 * `inputs` は記法が取る引数の種別
 * `args` は.sb3 の引数
 * `known` は実在する opcode
 */
function pair(opcode: string, key: string, inputs: string[], args: any[], known: Set<string>, problems: Problem[]) {
  const slots = args.filter(arg => arg.kind !== "statement")
  if (slots.length !== inputs.length) {
    problems.push({
      kind: "引数の数が合わない",
      subject: key,
      detail:
        `記法は引数を ${inputs.length} 個取るが ` +
        `${opcode} は ${slots.length} 個持つ`,
    })
    return null
  }

  let slot = 0
  return args.map(arg => {
    if (arg.kind === null) {
      problems.push({
        kind: "引数の置き場が読めない",
        subject: `${key}.${arg.name}`,
        detail: "欄か入力かを決められない",
      })
    }
    if (arg.kind === "statement") {
      return { ...arg, notation: null, shadow: null, shadowField: null }
    }

    const notation = inputs[slot]
    slot += 1
    const shadow = shadowFor(opcode, key, arg, notation, known, problems)
    return {
      ...arg,
      notation,
      ...shadow,
      // メニューの影が値を収める欄。規則（入力名と同じ）から外れるものだけ載せる
      shadowField: shadow.shadow ? remappedField(opcode, arg.name) : null,
      ...optionsFor(opcode, key, arg, notation, shadow.shadow, problems),
    }
  })
}

/**
 * 同じ記法が中身の形によって取る別の opcode に、その opcode の引数を添える。
 *
 * 引数まで持たせるのは、記法だけでは足りない引数があるため。「もし〜なら」は中身が
 * 2 つになると `control_if_else` になり、記法に現れない 2 つ目の中身の置き場
 * （`SUBSTACK2`）を要する。台帳が持たないと、生成側が scratch-blocks をもう一度引く
 * ことになり、対応表が 2 箇所へ散る。
 *
 * `opcode` は覆う先の opcode
 * `key` は問題の報告に使う対象名
 * `inputs` は記法が取る引数の種別
 * `known` は実在する opcode
 */
function cover(opcode: string, key: string, inputs: string[], byOpcode: Map<string, any>, known: Set<string>, problems: Problem[]) {
  const subject = `${key} -> ${opcode}`
  const definition = byOpcode.get(opcode)
  if (!definition) {
    problems.push({
      kind: "覆う先の opcode が実在しない",
      subject,
      detail: `例外表は ${opcode} を覆うと書くが scratch-blocks に定義が無い`,
    })
    return { opcode, args: null }
  }

  const empty =
    definition.identifiers.length === 0 && definition.args.length === 0
  return {
    opcode,
    args: empty
      ? null
      : pair(opcode, subject, inputs, definition.args, known, problems),
  }
}

/**
 * ドロップダウンの日本語ラベルから内部値を引く表を、引数に添える。
 *
 * 選択肢が作品ごとに決まるもの（変数名・コスチューム名等）は表を持たず、書かれた
 * 名前がそのまま値になる。固定の選択肢なのに表を引けないものは黙って通さない。
 */
function optionsFor(opcode: string, key: string, arg: any, notation: string, shadow: string | null, problems: Problem[]) {
  if (!isKind(notation, PREFIXES.MENU)) {
    return { options: null, optionsFrom: null, namesAllowed: false }
  }

  const listed =
    OPTIONS[opcode]?.[arg.name] ??
    (shadow ? OPTIONS[shadow]?.[arg.name] : undefined) ??
    (shadow ? MENU_OPTIONS[shadow]?.[arg.name] : undefined) ??
    SUPPLEMENT[opcode]?.[arg.name]

  // 作品ごとに名前が決まる選択肢。決まった選択肢を併せ持つものもあるため、表が
  // 引けたかどうかとは別に、名前を書ける口を開けておく
  const namesAllowed = NAME_KINDS.includes(notation)

  if (!listed) {
    if (namesAllowed) {
      return { options: null, optionsFrom: "名前をそのまま使う", namesAllowed }
    }
    problems.push({
      kind: "ドロップダウンの選択肢を引けない",
      subject: `${key}.${arg.name}`,
      detail:
        `${notation} は固定の選択肢を取るが、` +
        `対応表に ${opcode} の ${arg.name} が無い`,
    })
    return { options: null, optionsFrom: null, namesAllowed }
  }

  const from = OPTIONS[opcode]?.[arg.name]
    ? "定義"
    : OPTIONS[shadow ?? ""]?.[arg.name]
      ? "影ブロックの定義"
      : MENU_OPTIONS[shadow ?? ""]?.[arg.name]
        ? "メニューの定義"
        : "補足"
  return {
    options: listed,
    optionsFrom: namesAllowed ? `${from}と名前の併用` : from,
    namesAllowed,
  }
}

/**
 * 入力へ敷く影ブロックを引く。表に無ければ記法の引数の種別から補う。
 *
 * `known` は実在する opcode
 */
function shadowFor(opcode: string, key: string, arg: any, notation: string, known: Set<string>, problems: Problem[]) {
  // 欄は値をブロックに直接書くので影を敷かない。真偽の入力も敷かない
  if (arg.kind === "field") return { shadow: null, shadowFrom: null }
  if (isKind(notation, PREFIXES.BOOLEAN)) return { shadow: null, shadowFrom: null }

  const listed = SHADOWS[opcode]?.[arg.name]
  if (listed) {
    // 影ブロック表は過去の系列から取っている。現行の定義に無い影を指していたら、
    // 上流が入れ替えたということ。黙って使わない
    if (!known.has(listed)) {
      problems.push({
        kind: "影ブロックが実在しない",
        subject: `${key}.${arg.name}`,
        detail: `影ブロック表は ${listed} を指すが scratch-blocks に定義が無い`,
      })
      return { shadow: null, shadowFrom: null }
    }
    return { shadow: listed, shadowFrom: "表" }
  }

  // ドロップダウンの影はブロックごとに違い、規則で決められない
  if (isKind(notation, PREFIXES.MENU)) {
    problems.push({
      kind: "ドロップダウンの影ブロックが分からない",
      subject: `${key}.${arg.name}`,
      detail: `${opcode} の ${arg.name} は表に無く、規則でも補えない`,
    })
    return { shadow: null, shadowFrom: null }
  }

  const supplied = FALLBACK[prefixOf(notation) ?? ""]
  if (!supplied) {
    problems.push({
      kind: "影ブロックを補えない",
      subject: `${key}.${arg.name}`,
      detail: `記法の引数の種別 ${notation} に対応する影が無い`,
    })
    return { shadow: null, shadowFrom: null }
  }
  return { shadow: supplied, shadowFrom: "補い" }
}

/**
 * 識別子から opcode を引く。引けない・一意に決まらない場合は問題として記録する。
 */
function resolve(command: any, byIdentifier: Map<string, any[]>, problems: Problem[]): string | null {
  if (!command.id) {
    problems.push({
      kind: "識別子が無い",
      subject: command.selector ?? command.spec,
      detail: "識別子を持たない記法。例外表に扱いを書く",
    })
    return null
  }

  const hits = byIdentifier.get(command.id) ?? []
  if (hits.length === 0) {
    problems.push({
      kind: "opcode を解決できない",
      subject: command.id,
      detail: "scratch-blocks の定義に該当する見出しが無い",
    })
    return null
  }
  if (hits.length > 1) {
    problems.push({
      kind: "opcode が一意に決まらない",
      subject: command.id,
      detail: `${hits.map(h => h.opcode).join(" / ")} のどれかに決められない`,
    })
    return null
  }
  return hits[0].opcode
}

/**
 * 例外表を索引にする。重複はここで問題として拾う。
 */
function indexExceptions(table: any[], problems: Problem[]): Map<string, any> {
  const index = new Map()
  for (const exception of table) {
    const key = exception.identifier ?? exception.selector
    if (index.has(key)) {
      problems.push({
        kind: "例外表の項目が重複している",
        subject: key,
        detail: "同じ対象を 2 度指している",
      })
      continue
    }
    if (!KINDS.includes(exception.kind)) {
      problems.push({
        kind: "例外表の種別が読めない",
        subject: key,
        detail: `kind=${exception.kind}。${KINDS.join(" / ")} のいずれかを書く`,
      })
      continue
    }
    // override は定義の上書きである。opcode を直すものと引数の種別を直すものが
    // あり、どちらも書いていなければ何も上書きしていない
    if (exception.kind === "override" && !exception.opcode && !exception.inputs) {
      problems.push({
        kind: "例外表が何も上書きしていない",
        subject: key,
        detail: "kind=override は opcode か inputs のどちらかを伴う",
      })
      continue
    }
    index.set(key, exception)
  }
  return index
}

/**
 * 1 つの opcode に core のブロックが 2 件以上割り当たっていないか調べる。
 */
function findCollisions(blocks: Entry[]): Problem[] {
  const seen = new Map()
  const problems = []
  for (const block of blocks) {
    const first = seen.get(block.opcode)
    if (first) {
      problems.push({
        kind: "opcode が重複している",
        subject: block.opcode,
        detail: `${first} と ${block.identifier} が同じ opcode を指す`,
      })
      continue
    }
    seen.set(block.opcode, block.identifier)
  }
  return problems
}

/**
 * 台帳が覆わない範囲を数え上げる。0 件を装わないため、空の群も件数 0 で残す。
 */
function uncovered(
  blocks: Entry[],
  definitions: any[],
  excluded: Record<string, any[]>,
): Record<string, ScopeEntry[]> {
  const outside = new Map()
  for (const command of commands) {
    if (LISTED_CATEGORIES.includes(command.category)) continue
    const bucket = outside.get(command.category) ?? []
    bucket.push(command.id ?? command.selector ?? command.spec)
    outside.set(command.category, bucket)
  }

  const taken = new Set(
    blocks.flatMap(b => [b.opcode, ...b.alsoCovers.map(c => c.opcode)]),
  )
  const unreached = definitions
    .filter(d => LISTED_PREFIXES.some(p => d.opcode.startsWith(p)))
    .filter(d => !taken.has(d.opcode))
    .map(d => ({
      opcode: d.opcode,
      定義が空: d.identifiers.length === 0 && d.args.length === 0,
    }))
    .sort((a, b) => byName(a.opcode, b.opcode))

  return {
    "core の外のカテゴリ": [...outside]
      .map(([category, ids]) => ({ category, 件数: ids.length, 識別子: ids }))
      .sort((a, b) => byName(a.category, b.category)),
    "ドロップダウンの選択肢": excluded.option,
    "ブロックでない記法": excluded["not-a-block"],
    "今の Scratch で置けない記法": excluded.legacy,
    "綴りが衝突して呼べない記法": excluded.duplicate,
    "引数名を取れないブロック": blocks
      .filter(b => b.args === null)
      .map(b => ({ identifier: b.identifier, opcode: b.opcode })),
    // 機械で書き出せず手で補ったぶん
    // 名前を併せ持つ入力は「補足と名前の併用」になる。出所で見ずに補足を含むかで数える
    "選択肢を補足で埋めた入力": blocks.flatMap(b =>
      (b.args ?? [])
        .filter(arg => arg.optionsFrom?.startsWith("補足"))
        .map(arg => ({ identifier: b.identifier, 入力: arg.name })),
    ),
    // 影ブロック表の出典が 105 ブロックしか並べていないぶん。記法の引数の種別から
    // 補っており、表から引いた分より確度が落ちる
    "影ブロックを規則で補った入力": blocks.flatMap(b =>
      (b.args ?? [])
        .filter(arg => arg.shadowFrom === "補い")
        .map(arg => ({
          identifier: b.identifier,
          opcode: b.opcode,
          入力: arg.name,
          影: arg.shadow,
        })),
    ),
    "台帳から到達しない opcode": unreached,
  }
}

function version(name: string) {
  return JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8"))
    .version
}

/**
 * 手書きの表の中身から短い指紋を作る。
 *
 * 件数では中身の入れ替えを捕まえられない。項目を 1 つ書き換えても件数は動かないため、
 * 生成物の照合が「一致」を返す。指紋なら中身が動いた時点で変わる。
 *
 * 例外表だけでなくドロップダウン表と影ブロック表も混ぜる。台帳はこの 3 つすべてから
 * 導かれるのに、版として名乗っていたのは例外表の件数だけだった。
 *
 * 例外表は組み立ての引数で差し替えられる。既定値でなく実際に使った表を混ぜないと、
 * 差し替えたときに指紋が入力を表さなくなる。
 *
 * `exceptions` は組み立てに使った例外表
 */
/**
 * メニューの影が値を収める欄のうち、規則（欄の名前は入力名と同じ）から外れるものを引く。
 *
 * 規則から外れるのは拡張機能だけである。拡張のメニューは `menus` に書いた名前がそのまま
 * 欄の名前になり、入力名とは別に決まる。逆変換器（`parse-sb3-blocks`）はこの対応を
 * `remap` として持っており、2026-09-02 の実測では 25 件すべてが拡張機能のブロックだった
 * （core は 1 件も持たない）。
 *
 * 依存に在るものから引くので写しではない。上流が版を上げれば台帳の差分に出る。
 */
function remappedField(opcode: string, name: string): string | null {
  const remap = allBlocks[opcode]?.remap
  return remap?.[name] ?? null
}

/**
 * 指紋が畳む手書きの表。`EXCEPTIONS` は検査が差し替えるので引数で受け、ここには置かない。
 *
 * **手書きの表を足したらここへも足す。** 足し忘れると、その表を直しても台帳の版が動かず
 * `catalogDrift` が沈黙する。2026-09-02 の第三者視点レビューで実際に 3 表が漏れており、
 * 生成物の「表の出典」が申告する生成元と指紋が写す生成元が食い違っていた。
 * 取りこぼしは `test/catalog.test.ts` が名前の一覧で見張る。
 */
export const FINGERPRINTED = {
  MENU_OPTIONS,
  NAME_KINDS,
  OPTIONS,
  SUPPLEMENT,
  FALLBACK,
  PRIMITIVES,
  SHADOWS,
  EXTENSION_DEFINITIONS,
  CORE_EXTENSIONS,
}

function handwrittenFingerprint(exceptions: typeof EXCEPTIONS): string {
  const tables = { EXCEPTIONS: exceptions, ...FINGERPRINTED }
  return createHash("sha256").update(JSON.stringify(tables)).digest("hex").slice(0, 12)
}

function loadJapanese(): Record<string, string> {
  const locale = JSON.parse(
    readFileSync(require.resolve("scratchblocks/locales/ja.json"), "utf8"),
  )
  return locale.commands
}

/**
 * 出典の版が動いていないかを見る。
 *
 * 上流の現在の版から書き出し直せない表は、照合で見張れない。代わりに「確かめた時点の
 * 版」を持たせ、今の版がそれと違えば確かめ直しを促す。何がどう変わったかまでは分から
 * ない。分かるのは、確かめたときの前提が動いたことだけである。
 *
 * `blocksVersion` は今の scratch-blocks の版
 * `sources` は組み立てに使った出典の記録
 */
function staleProvenance(blocksVersion: string, sources: typeof PROVENANCE): Problem[] {
  return sources.filter(source => source.確認した現行版 !== blocksVersion).map(
    source => ({
      kind: "出典を確かめ直す必要がある",
      subject: source.表,
      detail:
        `確かめたのは scratch-blocks ${source.確認した現行版} の時点。` +
        `今は ${blocksVersion}`,
    }),
  )
}

/**
 * 手書きの表の出典を申告する。
 *
 * 上流から書き出し直せる表は照合で見張れるが、そうでない表は見張れない。見張れて
 * いない範囲を理由つきで同じ生成物へ載せる。黙って抱えると、照合が通ったときに
 * 全部を見張れている顔になる。
 *
 * ブロックの「覆わない範囲」とは別の欄に置く。あちらが数えるのは台帳に載らなかった
 * ブロックであり、表はブロックではない。同じ欄へ混ぜると、解説の生成が名前を取れず
 * 「(名前なし)」を並べる。
 *
 * `sources` は組み立てに使った出典の記録
 */
function tablesNotDerived(sources: typeof PROVENANCE): { 表: string, 種別: string, 出典: string, 版: string | null, 理由: string }[] {
  return sources.filter(source => source.種別 !== "導出").map(source => ({
    表: source.表,
    種別: source.種別,
    出典: source.出典,
    版: source.版,
    理由: source.理由,
  }))
}
