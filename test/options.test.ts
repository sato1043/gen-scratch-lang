import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { OPTIONS } from "../catalog/dropdowns.ts"
import {
  compareOptions,
  countChoices,
  deriveOptions,
  japaneseMessages,
} from "../tools/derive-options.ts"
import { packageRoot } from "../tools/opcodes.ts"

/**
 * 手書きの表のうち、上流の現在の版から書き出し直せるものを照合する。
 *
 * 追跡下の選択肢の対応は「機械で書き出した結果を写したもの」だが、書き出す手順が
 * 残っていなかった。上流が変われば古びるのに、古びたことに気づく手段が無い。
 */

const { options: derived, problems } = deriveOptions()

/** 読み取り側が組を見つける形。較正がこれと別の手掛かりで数えることを確かめるのに使う */
const OPTION_SHAPE =
  /\[\s*(?:Blockly\.Msg\.([A-Z0-9_]+)|'([^']*)'|"([^"]*)")\s*,\s*(?:'([^']*)'|"([^"]*)")\s*\]/g

function countPairs(table: Record<string, Record<string, Record<string, string>>>) {
  return Object.values(table)
    .flatMap(byField => Object.values(byField))
    .reduce((sum, pairs) => sum + Object.keys(pairs).length, 0)
}

test("上流から選択肢を書き出せる", () => {
  // 0 組でも「一致」は返る。照合の前に、書き出しが実を持つことを確かめる
  // （実測 2026-08-18: 19 ブロック / 151 組）
  assert.ok(Object.keys(derived).length >= 15, "書き出せたブロックが少なすぎる")
  assert.ok(countPairs(derived) >= 140, "書き出せた組が少なすぎる")
  assert.deepEqual(problems, [], "書き出しで取りこぼしている")
})

test("追跡下の選択肢の対応が、上流の現在の版と食い違わない", () => {
  const differences = compareOptions(OPTIONS, derived)
  assert.deepEqual(differences, [], `${differences.length} 件が食い違う`)
})

test("照合が食い違いを見つける", () => {
  // 測定器の較正。差 0 件が「一致している」からであって、照合が何も見ていない
  // からではないことを、既知の答えを持つ入力で確かめる
  const [opcode] = Object.keys(derived)
  const [field] = Object.keys(derived[opcode])
  const [label] = Object.keys(derived[opcode][field])

  const rewritten = structuredClone(derived)
  rewritten[opcode][field][label] = "書き換えた値"
  const changed = compareOptions(rewritten, derived)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].kind, "値が食い違う")
  assert.equal(changed[0].at, `${opcode}.${field}`)

  const dropped = structuredClone(derived)
  delete dropped[opcode][field][label]
  const missing = compareOptions(dropped, derived)
  assert.equal(missing.length, 1)
  assert.equal(missing[0].kind, "上流にしか無い組")

  const gone = structuredClone(derived)
  delete gone[opcode]
  const removed = compareOptions(gone, derived)
  assert.ok(removed.length >= 1)
  assert.equal(removed[0].kind, "上流にしか無い欄")
})

test("日本語の見出しを同梱から引ける", () => {
  const messages = japaneseMessages(packageRoot())
  // 実測 2026-08-18: 284 件
  assert.ok(Object.keys(messages).length >= 250, "見出しが少なすぎる")
  assert.equal(messages.EVENT_WHENKEYPRESSED_SPACE, "スペース")
  assert.equal(messages.MOTION_SETROTATIONSTYLE_DONTROTATE, "回転しない")
})

test("単引用符を含む綴りを読み落とさない", () => {
  // 上流は値を単引用符と二重引用符の双方で書く。単引用符だけを見ると
  // "don't rotate" のような綴りが黙って落ちる
  const style = derived.motion_setrotationstyle?.STYLE
  assert.ok(style, "回転方向の選択肢を読めていない")
  assert.equal(Object.values(style).filter(value => value.includes("'")).length, 1)
  assert.ok(Object.values(style).includes("don't rotate"))
})

test("較正が、組の形に依らず要素を数える", () => {
  // 較正は読み取りと別の手掛かりで数えていなければ意味がない。以前は両方が開き括弧を
  // 見ており、括弧で始まらない要素は双方から見えず、取りこぼしても差が出なかった
  // （CP6 レビュー指摘）。区切りで数える今の形が、その 3 形を捕まえることを固定する
  // 実装を直に呼ぶ。以前はソースを切り出して `new Function` で組み立てていたが、
  // 型注釈が入ると JS として評価できない。実装が export する関数をそのまま使えば、
  // 切り出しの綴りに依存せず、測る対象も同じである

  const read = (text: string) => [...text.matchAll(OPTION_SHAPE)].length

  for (const text of [
    "[[Blockly.Msg.A, 'a'], ...EXTRA]",
    "[[Blockly.Msg.A, 'a'], EXTRA]",
    "[[Blockly.Msg.A, 'a'], build()]",
  ]) {
    assert.notEqual(countChoices(text), read(text), `取りこぼしを見逃す: ${text}`)
  }

  // 正しく読めている形では差を作らない（鳴りっぱなしにしない）
  for (const text of [
    "[[Blockly.Msg.A, 'a'], [Blockly.Msg.B, 'b']]",
    "[[Blockly.Msg.A, 'a'], [Blockly.Msg.B, 'b'],]",
  ]) {
    assert.equal(countChoices(text), read(text), `正しい形で鳴る: ${text}`)
  }
})
