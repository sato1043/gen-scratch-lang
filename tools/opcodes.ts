/**
 * scratch-blocks（Scratch 本体のブロック定義）から opcode を読む。
 *
 * .sb3 はブロックを opcode で識別し、記法の解析器 scratchblocks は l10n の識別子で
 * 識別する。両者を結ぶ一次情報はここにしか無い。ブロック定義は opcode
 * （`Blockly.Blocks.<opcode>`）・識別子（`Blockly.Msg.<識別子>`）・引数名を同じ場所に
 * 並べて持つ。
 *
 * 読み方は字句走査に留め、定義を評価しない。評価するには Blockly の実行環境一式が要り、
 * 得られるものに比して重い。上流が書き方を変えれば抽出は減るが、黙って減りはしない。
 * 台帳の整合検査が未解決として落とす。
 */
import { createRequire } from "node:module"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)

/** ブロック定義の始まり。ここから次の始まりまでを 1 ブロックの本文として切る */
const BLOCK_HEAD = /^Blockly\.Blocks\.([A-Za-z0-9_]+) = \{/gm

/**
 * 識別子。宣言的な定義（`jsonInit`）と命令的な定義（`appendField`）の 2 通りある。
 * ドロップダウンの選択肢も `Blockly.Msg.*` を使うため、その 2 通りに限って拾う
 */
const IDENTIFIER =
  /message\d+: Blockly\.Msg\.([A-Z0-9_]+)|appendField\(Blockly\.Msg\.([A-Z0-9_]+)\)/g

/** 宣言的な定義（`jsonInit`）の引数名 */
const DECLARED = /\bname: '([A-Za-z0-9_]+)'/g

/** 同じ要素の中に書かれた引数の種別。名前より前にも後ろにも書ける */
const DECLARED_TYPE = /\btype: '([a-z_]+)'/

/** 命令的な定義が足す欄 */
const APPENDED_FIELD = /appendField\([^,()]+, *'([A-Za-z0-9_]+)'\)/g

/** 命令的な定義が足す入力 */
const APPENDED_INPUT = /append(Value|Statement)Input\('([A-Za-z0-9_]+)'\)/g

/**
 * scratch-blocks の引数の型を、.sb3 での置き場へ移す。
 *
 * .sb3 は欄（ブロックに直接書く値）と入力（別のブロックを差せる穴）を
 * 別の欄に分ける。どちらへ置くかは型で決まり、取り違えると Scratch が読めない
 */
function kindOf(type: string | undefined): "field" | "input" | "statement" | null {
  if (type === undefined) return null
  if (type === "input_value") return "input"
  if (type === "input_statement") return "statement"
  return type.startsWith("field_") ? "field" : null
}

type Argument = {
  /** .sb3 での欄の名前 */
  name: string
  /** 置き場。読めなければ null */
  kind: "field" | "input" | "statement" | null
}

type Definition = {
  opcode: string
  /** 見出しに使う l10n の識別子。空なら定義が空 */
  identifiers: string[]
  /** 書かれた順 */
  args: Argument[]
  /** 出どころのファイル名 */
  file: string
}

let cached: { version: string; definitions: Definition[] } | null = null

/**
 * ブロック定義を読み出す。2 度目以降は読み出し済みのものを返す。
 */
export function readDefinitions(): { version: string, definitions: Definition[] } {
  if (cached) return cached

  const root = packageRoot()
  const version = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).version
  const dir = join(root, "src", "blocks")

  const definitions: Definition[] = []
  for (const file of readdirSync(dir).filter(n => n.endsWith(".ts")).sort()) {
    definitions.push(...scan(readFileSync(join(dir, file), "utf8"), file))
  }

  cached = { version, definitions }
  return cached
}

/**
 * 1 ファイル分の定義を切り出す。
 */
function scan(source: string, file: string): Definition[] {
  const heads = [...source.matchAll(BLOCK_HEAD)]
  return heads.map((head, i) => {
    const body = source.slice(head.index, heads[i + 1]?.index ?? source.length)
    return {
      opcode: head[1],
      identifiers: pick(body, IDENTIFIER),
      args: readArguments(body),
      file,
    }
  })
}

/**
 * 引数を書かれた順に読む。
 *
 * 宣言的な定義では種別と名前が同じ要素に並ぶ。並び順は要素ごとに違うため、名前を
 * 見つけてから、それを囲む要素の中で種別を探す。命令的な定義では呼び出す関数名が
 * そのまま種別を表す。
 */
function readArguments(body: string): Argument[] {
  const found: { at: number; name: string; kind: Argument["kind"] }[] = []

  for (const match of body.matchAll(DECLARED)) {
    const opened = body.lastIndexOf("{", match.index)
    const element = body.slice(opened, match.index + match[0].length)
    found.push({
      at: match.index,
      name: match[1],
      kind: kindOf(DECLARED_TYPE.exec(element)?.[1]),
    })
  }
  for (const match of body.matchAll(APPENDED_FIELD)) {
    found.push({ at: match.index, name: match[1], kind: "field" })
  }
  for (const match of body.matchAll(APPENDED_INPUT)) {
    const kind = match[1] === "Value" ? "input" : "statement"
    found.push({ at: match.index, name: match[2], kind })
  }

  found.sort((a, b) => a.at - b.at)

  const args: Argument[] = []
  for (const { name, kind } of found) {
    if (!args.some(arg => arg.name === name)) args.push({ name, kind })
  }
  return args
}

/**
 * 本文から捕捉した文字列を、書かれた順で重複なく取り出す。
 *
 * `pattern` は択一の捕捉群を持つ。一致した群だけが値を持つ
 */
function pick(body: string, pattern: RegExp): string[] {
  const found: string[] = []
  for (const match of body.matchAll(pattern)) {
    const value = match.slice(1).find(Boolean)
    if (value && !found.includes(value)) found.push(value)
  }
  return found
}

/**
 * scratch-blocks が置かれた場所を探す。
 *
 * 公開の入口（`dist/main.mjs`）しか解決できないため、そこから package.json を
 * 遡って見つける。node_modules の掘られ方に依らずに済ませるため。
 */
export function packageRoot(): string {
  let dir = dirname(require.resolve("scratch-blocks"))
  for (;;) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      )
      if (manifest.name === "scratch-blocks") return dir
    } catch {
      // package.json が無い階層は素通りする。見つからないまま根に着けば下で落ちる
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error("scratch-blocks の置き場を特定できない")
    dir = parent
  }
}

/**
 * 識別子から opcode を引く索引をつくる。
 *
 * 1 つの識別子が複数の opcode に当たることがある（`CONTROL_IF` は `control_if` と
 * `control_if_else` の双方に現れる）。どちらかを黙って選ぶと誤りが台帳へ流れ込むため、
 * 当たった全てを返して呼び出し元に決めさせる。
 */
export function indexByIdentifier(definitions: Definition[]): Map<string, Definition[]> {
  const index = new Map<string, Definition[]>()
  for (const definition of definitions) {
    for (const identifier of definition.identifiers) {
      const bucket = index.get(identifier) ?? []
      bucket.push(definition)
      index.set(identifier, bucket)
    }
  }
  return index
}
