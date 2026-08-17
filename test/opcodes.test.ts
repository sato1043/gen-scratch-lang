import test from "node:test"
import assert from "node:assert/strict"
import { indexByIdentifier, readDefinitions } from "../tools/opcodes.ts"

const { definitions } = readDefinitions()
const byOpcode = new Map(definitions.map(d => [d.opcode, d]))

test("宣言的な定義から識別子と引数を、書かれた順に読む", () => {
  assert.deepEqual(byOpcode.get("motion_movesteps"), {
    opcode: "motion_movesteps",
    identifiers: ["MOTION_MOVESTEPS"],
    args: [{ name: "STEPS", kind: "input" }],
    file: "motion.ts",
  })

  // 引数の順は .sb3 の組み立てに要る。集合ではなく列として保つ
  assert.deepEqual(byOpcode.get("operator_add")!.args, [
    { name: "NUM1", kind: "input" },
    { name: "NUM2", kind: "input" },
  ])
  assert.deepEqual(byOpcode.get("control_if_else")!.args, [
    { name: "CONDITION", kind: "input" },
    { name: "SUBSTACK", kind: "statement" },
    { name: "SUBSTACK2", kind: "statement" },
  ])
})

test("引数がフィールドか入力かを読み分ける", () => {
  // .sb3 はフィールドと入力を別の欄に置く。取り違えると Scratch が読めない
  assert.deepEqual(byOpcode.get("looks_changeeffectby")!.args, [
    { name: "EFFECT", kind: "field" },
    { name: "CHANGE", kind: "input" },
  ])
  assert.deepEqual(byOpcode.get("data_setvariableto")!.args, [
    { name: "VARIABLE", kind: "field" },
    { name: "VALUE", kind: "input" },
  ])

  const unreadable = definitions.flatMap(d =>
    d.args.filter(a => a.kind === null).map(a => `${d.opcode}.${a.name}`),
  )
  assert.deepEqual(unreadable, [], "置き場を読めない引数が残っている")
})

test("命令的な定義からも識別子と引数を読む", () => {
  // control_stop は jsonInit を使わず appendField で組み立てる。宣言的な定義だけを
  // 見ていると、この 1 件が丸ごと落ちる
  assert.deepEqual(byOpcode.get("control_stop")!.identifiers, ["CONTROL_STOP"])
  assert.deepEqual(byOpcode.get("control_stop")!.args, [
    { name: "STOP_OPTION", kind: "field" },
  ])
})

test("ドロップダウンの選択肢を識別子と取り違えない", () => {
  // looks_seteffectto は選択肢として LOOKS_EFFECT_* を 7 つ並べる。見出しはひとつ
  assert.deepEqual(byOpcode.get("looks_seteffectto")!.identifiers, [
    "LOOKS_SETEFFECTTO",
  ])
  assert.deepEqual(byOpcode.get("looks_seteffectto")!.args, [
    { name: "EFFECT", kind: "field" },
    { name: "VALUE", kind: "input" },
  ])
})

test("中身を実行時に埋める定義は、空と分かる形で残る", () => {
  // 影ブロックは scratch-gui が実行時に選択肢を埋める。読めないことを読めたことに
  // しないため、項目自体は残して中身を空にする
  for (const opcode of ["motion_goto_menu", "sensing_of", "sound_sounds_menu"]) {
    const definition = byOpcode.get(opcode)
    assert.ok(definition, `${opcode} の定義が無い`)
    assert.deepEqual(definition.identifiers, [], opcode)
    assert.deepEqual(definition.args, [], opcode)
  }
})

test("識別子が複数の opcode に当たることを潰さない", () => {
  const index = indexByIdentifier(definitions)

  // CONTROL_IF は control_if と control_if_else の双方が見出しに使う。どちらかを
  // 黙って選ぶと、誤った opcode が台帳へ流れ込む
  assert.deepEqual(
    index.get("CONTROL_IF")!.map(d => d.opcode),
    ["control_if", "control_if_else"],
  )
  assert.deepEqual(
    index.get("CONTROL_ELSE")!.map(d => d.opcode),
    ["control_if_else"],
  )
})

test("読み落としが起きていない目安として、抽出の規模を見張る", () => {
  // 上流の書き方が変わって抽出が痩せたときに気づくための下限。実測は opcode 171 件・
  // 識別子 136 件（scratch-blocks 2.1.19）
  assert.ok(definitions.length >= 165, `opcode が ${definitions.length} 件しかない`)
  const identified = definitions.filter(d => d.identifiers.length > 0)
  assert.ok(identified.length >= 130, `識別子が ${identified.length} 件しかない`)
})
