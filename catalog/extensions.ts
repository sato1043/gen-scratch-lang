/**
 * 拡張機能のブロック定義。scratch-blocks から引けない範囲を写す。
 *
 * core のブロックは opcode と引数名を scratch-blocks の `Blockly.Blocks.*` から
 * 機械で読む。拡張機能はそこに無い ── 定義は scratch-vm 側にあり、エディタが
 * 起動してから作られる。実測（2026-09-02・scratch-blocks 2.1.19）で `pen_` の
 * 定義は 0 件だった。
 *
 * そこで scratch-vm の拡張実装から写す。写した値は上流が動いても検知できない。
 * これは `別出典` が構造として抱える弱点で、`provenance.ts` が出典と版を申告して
 * 確かめ直しの契機だけを残す。
 *
 * 写す範囲はパレットに出るものに限る。`hideFromPalette: true` が付く 4 件
 * （濃さ・色相の数値指定）は Scratch 3 のパレットに出ず、エディタで作った作品にも
 * 現れない。**うち 3 件を例外表が `legacy` として除外し、残る 1 件（`pen.setHue`）は
 * 現行の `pen_setPenColorToColor` へ読み替える** ── 「ペンの色を%1にする」の綴りを
 * 2 つのブロックが持ち、解析器が旧ブロックの側を選ぶためである。読み替えないと、
 * 色を直に決めるブロックが記法から呼べない。
 *
 * メニューは影ブロックとして入力へ差す。`pen_menu_colorParam` は選択肢を持つ
 * ブロックそのもので、記法の上では現れない。影ブロック表が実在を照合するため、
 * ここに定義を置く。
 */

/**
 * 拡張機能でないブロックの opcode の接頭辞。
 *
 * 出典は scratch-vm 5.0.300 の `src/serialization/sb3.js`（`CORE_EXTENSIONS`）。
 * 台帳が扱う 9 カテゴリより広い ── `argument` や `procedures` のように、記法には
 * 現れないが opcode としては在るものを含む。
 */
export const CORE_EXTENSIONS = [
  "argument",
  "colour",
  "control",
  "data",
  "event",
  "looks",
  "math",
  "motion",
  "operator",
  "procedures",
  "sensing",
  "sound",
]

/**
 * opcode から拡張機能の id を導く。core のものと、接頭辞を持たないものは null。
 *
 * 規則は scratch-vm 5.0.300 の `getExtensionIdForOpcode` をなぞる。作品が何の
 * 拡張機能を使うかは、使ったブロックから一意に決まる。作品定義に書かせると
 * 出所が 2 つになり、食い違いうる。
 */
export function extensionIdOf(opcode: string): string | null {
  const index = opcode.indexOf("_")
  if (index < 0) return null
  // 上流は id に使えない文字をハイフンへ倒す。同じ形に揃える
  const prefix = opcode.slice(0, index).replace(/[^\w-]/g, "-")
  if (prefix === "" || CORE_EXTENSIONS.includes(prefix)) return null
  return prefix
}

/** scratch-blocks 由来の定義と同じ形。`tools/opcodes.ts` の `Definition` に合わせる */
type ExtensionDefinition = {
  opcode: string
  /** 見出しに使う l10n の識別子。scratch-vm の message id を使う */
  identifiers: string[]
  /** 書かれた順 */
  args: { name: string; kind: "field" | "input" | "statement" | null }[]
  /** 出どころのファイル名 */
  file: string
}

const PEN = "scratch3_pen/index.js"

export const EXTENSION_DEFINITIONS: ExtensionDefinition[] = [
  { opcode: "pen_clear", identifiers: ["pen.clear"], args: [], file: PEN },
  { opcode: "pen_stamp", identifiers: ["pen.stamp"], args: [], file: PEN },
  { opcode: "pen_penDown", identifiers: ["pen.penDown"], args: [], file: PEN },
  { opcode: "pen_penUp", identifiers: ["pen.penUp"], args: [], file: PEN },
  {
    opcode: "pen_setPenColorToColor",
    identifiers: ["pen.setColor"],
    args: [{ name: "COLOR", kind: "input" }],
    file: PEN,
  },
  {
    opcode: "pen_setPenColorParamTo",
    identifiers: ["pen.setColorParam"],
    args: [
      { name: "COLOR_PARAM", kind: "input" },
      { name: "VALUE", kind: "input" },
    ],
    file: PEN,
  },
  {
    opcode: "pen_changePenColorParamBy",
    identifiers: ["pen.changeColorParam"],
    args: [
      { name: "COLOR_PARAM", kind: "input" },
      { name: "VALUE", kind: "input" },
    ],
    file: PEN,
  },
  {
    opcode: "pen_setPenSizeTo",
    identifiers: ["pen.setSize"],
    args: [{ name: "SIZE", kind: "input" }],
    file: PEN,
  },
  {
    opcode: "pen_changePenSizeBy",
    identifiers: ["pen.changeSize"],
    args: [{ name: "SIZE", kind: "input" }],
    file: PEN,
  },
  // 記法には現れない。影ブロック表が指す先の実在を照合するために置く。
  // 値を収める欄の名前は `MENU_FIELDS`（catalog/shadows.ts）が持つ。ここへ書くと
  // 同じ値が 2 箇所に散り、一方だけが古びる
  {
    opcode: "pen_menu_colorParam",
    identifiers: [],
    args: [],
    file: PEN,
  },
]
