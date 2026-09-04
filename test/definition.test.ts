import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  LEVELS,
  LIST_FALLBACK,
  SPRITE_KEYS,
  TOP_KEYS,
  VARIABLE_FALLBACK,
  omissionOf,
} from "../src/definition.ts"
import { DEFINITION_MARKS, definitionKeyCount, definitionTable } from "../src/knowledge.ts"

const PAGE = fileURLToPath(new URL("../docs/knowledge/project-definition.md", import.meta.url))

/** 追跡下の仕様から、生成した層だけを取り出す */
function generatedLayer() {
  const text = readFileSync(PAGE, "utf8")
  const from = text.indexOf(DEFINITION_MARKS.begin)
  const to = text.indexOf(DEFINITION_MARKS.end)
  assert.ok(from >= 0 && to > from, "仕様に生成の目印が無い")
  return text.slice(from + DEFINITION_MARKS.begin.length, to).trim()
}

test("追跡下の仕様が実装の表と一致する", () => {
  assert.equal(generatedLayer(), definitionTable())
})

test("実装の表へキーを足すと、追跡下の仕様と一致しなくなる", () => {
  // 一致していることは「何も見ていない」場合と同じ値を返す。壊して落ちるまでを 1 つの検査とする
  TOP_KEYS.ためし = { type: "文字列", effect: "検査のために足したキー", omitted: "何も起きない" }
  try {
    assert.notEqual(generatedLayer(), definitionTable(), "キーを足したのに仕様と一致している")
    assert.match(definitionTable(), /ためし/, "足したキーが一覧に出ていない")
  } finally {
    delete TOP_KEYS.ためし
  }
  assert.equal(generatedLayer(), definitionTable(), "戻したのに一致しない")
})

test("全てのキーが、省略したときの挙動を持つ", () => {
  // 既定値も散文も持たないキーは仕様の穴になる。一覧には出るが、読んでも何も分からない
  for (const level of LEVELS) {
    for (const [key, spec] of Object.entries(level.keys)) {
      assert.notEqual(
        omissionOf(spec),
        "(記述が無い)",
        `${level.title} の ${key} に省略時の記述が無い`,
      )
      assert.ok(spec.effect.length > 0, `${level.title} の ${key} に効き目の記述が無い`)
    }
  }
})

/**
 * キーごとの既定値。実装から借りず書き下す。
 *
 * 借りると、既定値を変えたときに検査も仕様ページも一緒に動き、何も固定されない
 * （仕様ページは同じ表から組み直されるため、書類の側も pin にならない）。
 */
const FALLBACKS = { 今のコスチューム: 1, x: 0, y: 0, 表示: true, 大きさ: 100, 向き: 90 }

test("既定値が実装と独立に固定されている", () => {
  for (const [key, value] of Object.entries(FALLBACKS)) {
    assert.equal(SPRITE_KEYS[key].fallback, value, `${key} の既定値が変わった`)
  }
  assert.equal(VARIABLE_FALLBACK, 0, "変数の初期値の既定が変わった")
  assert.deepEqual(LIST_FALLBACK, [], "リストの初期値の既定が変わった")

  // 既定値を持つキーの数も固定する。減っても検査が縮まないようにする
  const withFallback = Object.entries(SPRITE_KEYS).filter(([, spec]) => spec.fallback !== undefined)
  assert.equal(withFallback.length, Object.keys(FALLBACKS).length)
})

test("定義に書けるキーは 21 個で、同じキーを二重に数えない", () => {
  // 件数は実装から借りず書き下す。借りると、実装がキーを落としたとき検査も一緒に縮む
  assert.equal(definitionKeyCount(), 21)

  // 最上位 3 + ステージ 7 + スプライト 13 + コスチュームの項 5 + 音の項 4 = 32。
  // 名前が 4 か所、スクリプト・変数・リスト・再描画しないブロック・コスチューム・音・
  // 今のコスチュームが 2 か所、ファイルが 2 か所に出るため、場所ごとの合計はキーの数
  // より 11 多い
  const total = LEVELS.reduce((sum, level) => sum + Object.keys(level.keys).length, 0)
  assert.equal(total, 32)
})

test("一覧が 5 つの場所すべてを見出しつきで載せる", () => {
  const table = definitionTable()
  for (const level of LEVELS) {
    assert.match(table, new RegExp(`### ${level.title}`), `${level.title} の見出しが無い`)
  }
})
