import test from "node:test"
import assert from "node:assert/strict"
import {
  countBlocks,
  eachBlock,
  findUnrecognized,
  parseNotation,
  readNotation,
} from "../src/parse.ts"
import { detailOf } from "./fixtures.ts"

const GOOD = `緑の旗が押されたとき
ずっと
  (10) 歩動かす
  もし <[端 v] に触れた> なら
    ((1) + (2)) と言う
  end
end`

test("正しい記法は全ブロックが識別できる", async () => {
  const doc = await parseNotation(GOOD)
  const ids = [...eachBlock(doc)].map(b => b.info?.id)
  assert.deepEqual(ids, [
    "EVENT_WHENFLAGCLICKED",
    "CONTROL_FOREVER",
    "MOTION_MOVESTEPS",
    "CONTROL_IF",
    "SENSING_TOUCHINGOBJECT",
    "LOOKS_SAY",
    "OPERATORS_ADD",
  ])
  assert.deepEqual(findUnrecognized(doc, GOOD), [])
})

test("C 型ブロックが end で閉じ、中身の数が合う", async () => {
  const doc = await parseNotation(GOOD)
  assert.equal(doc.scripts.length, 1)

  const [hat, forever] = doc.scripts[0].blocks
  assert.equal(hat.info.id, "EVENT_WHENFLAGCLICKED")
  assert.equal(forever.info.id, "CONTROL_FOREVER")

  // `end` が閉じ役として消費されないと、余った `end` が中身に混じって数が増える
  const inForever = substack(forever)
  assert.deepEqual(inForever.map((b: any) => b.info?.id), [
    "MOTION_MOVESTEPS",
    "CONTROL_IF",
  ])
  assert.deepEqual(substack(inForever[1]).map((b: any) => b.info?.id), ["LOOKS_SAY"])
})

/** C 型ブロックが抱える中身のブロック列を返す */
function substack(block: any): any[] {
  const script = block.children.find((c: any) => c.isScript)
  return script ? script.blocks : []
}

test("認識できない行を行番号つきで返す", async () => {
  const code = `緑の旗が押されたとき
ほげほげする
(10) 歩動かす`
  const doc = await parseNotation(code)
  assert.deepEqual(findUnrecognized(doc, code), [
    { line: 2, text: "ほげほげする" },
  ])
})

test("正しい行の一部に当たる記述でも、誤りのある行を指す", async () => {
  // 2 行目だけが誤り。1 行目はその文字列を部分として含む正しい記述
  const code = `(10) 歩動かす
歩動かす`
  const doc = await parseNotation(code)
  assert.deepEqual(findUnrecognized(doc, code), [{ line: 2, text: "歩動かす" }])
})

test("ブロックを含まない記法は 0 と数える", async () => {
  for (const code of ["", "\n\n", "   "]) {
    assert.equal(countBlocks(await parseNotation(code)), 0, JSON.stringify(code))
  }
  assert.equal(countBlocks(await parseNotation(GOOD)), 7)
})

test("引数の書き忘れを認識できない記法として拾う", async () => {
  // 正しくは `(10) 歩動かす`。括弧が無いと別の記述になり成立しない
  const code = "10 歩動かす"
  const doc = await parseNotation(code)
  assert.equal(findUnrecognized(doc, code).length, 1)
})

test("解けない記法を、投げずに問題として返す", async () => {
  // 解析器は入れ子で再帰する。捕まえないと最小化した依存のソース 1 行（実測 127KB）が
  // スタックトレースごと利用者の画面へ出る（2026-08-19 実測）
  const depth = 3000
  const lines = ["緑の旗が押されたとき"]
  for (let i = 0; i < depth; i += 1) lines.push(`${"  ".repeat(i)}ずっと`)
  for (let i = depth - 1; i >= 0; i -= 1) lines.push(`${"  ".repeat(i)}end`)

  const { doc, problems } = await readNotation(lines.join("\n"), "ためし.sbk")
  assert.equal(doc, null, "解けたことになっている")
  assert.deepEqual(
    problems.map(p => [p.kind, p.subject]),
    [["記法を解析できない", "ためし.sbk"]],
  )
  assert.ok(detailOf(problems[0]), "理由を落としている")
})

test("解ける記法では、問題を出さずに中間表現を返す", async () => {
  // 対照。上の検査が「常に null を返す」実装でも緑にならないようにする
  const { doc, problems } = await readNotation("緑の旗が押されたとき\n(10) 歩動かす", "ためし.sbk")
  assert.deepEqual(problems, [])
  assert.equal(countBlocks(doc), 2)
})
