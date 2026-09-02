import test from "node:test"
import assert from "node:assert/strict"
import { loadSnippets } from "../src/idioms.ts"
import { eachBlock, findUnrecognized, parseNotation } from "../src/parse.ts"
import { catalogOrStop } from "./fixtures.ts"

const catalog = catalogOrStop()
const snippets = loadSnippets(new URL("../docs/knowledge/idioms/", import.meta.url))

/**
 * 台帳が覆うカテゴリ。実装から借りず、覆うべき範囲として書き下す。
 *
 * core の 9 つに、扱うと裁定した拡張機能（ペン）を足したもの。
 */
const LISTED = [
  "control",
  "events",
  "list",
  "looks",
  "motion",
  "operators",
  "pen",
  "sensing",
  "sound",
  "variables",
]

test("イディオム集から記法を取り出せる", () => {
  // 抽出が 0 件だと、以下の検査は 1 件も走らないまま緑になる
  assert.ok(snippets.length > 0, "取り出せた記法が 0 件")
  assert.ok(snippets.length >= 12, `イディオムが ${snippets.length} 件しかない`)
})

test("イディオム集が台帳の扱うカテゴリすべてに触れる", async () => {
  // 数だけを見張ると、1 つのカテゴリに偏った 12 件でも基準を満たしてしまう
  const touched = new Set()
  for (const snippet of snippets) {
    for (const block of eachBlock(await parseNotation(snippet.code))) {
      const entry = catalog.byIdentifier.get(block.info?.id)
      if (entry) touched.add(entry.category)
    }
  }
  assert.deepEqual([...touched].sort(), LISTED, "触れていないカテゴリがある")
})

/** 手順書に載せた記法。説明のための飾りではなく、成立することを確かめる対象とする */
const guides = loadSnippets(new URL("../docs/knowledge/", import.meta.url))

for (const snippet of [...snippets, ...guides]) {
  test(`記法が Scratch のブロックとして成立する: ${snippet.name}`, async () => {
    const doc = await parseNotation(snippet.code)
    const unknown = findUnrecognized(doc, snippet.code)
    assert.deepEqual(
      unknown,
      [],
      `成立しない記述: ${unknown.map(u => u.text).join(" / ")}`,
    )
  })
}

test("手順書から記法を取り出せる", () => {
  assert.ok(guides.length > 0, "手順書に記法が 1 つも無い")
})
