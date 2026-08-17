import test from "node:test"
import assert from "node:assert/strict"
import { censusOfAny, withoutProse } from "../tools/count-any.ts"

/**
 * `any` の総数に上限を掛ける。
 *
 * 一度きりの目標は達成した時点で効かなくなる。上限なら、減らした後も増えないことを
 * 見張り続ける。TASK0008 の裁定（2026-08-25）で置いた。
 *
 * **上限は下がる方向にも壊れる。** 走査が対象を見失えば数が減り、上限は緑のまま通る。
 * 数だけを見る検査は「無い」と「見ていない」を同じ顔で返すので、走査が実を持つことを
 * 別の下限で確かめる。
 */

/**
 * 数えてよい `any` の上限。
 *
 * **減らしたらこの数も下げる。** 上限と実数が離れると、離れたぶんだけ黙って増やせる。
 * 下の「離れすぎていない」がその見張りで、上限を下げ忘れると落ちる。
 *
 * 実測 151 個（2026-08-25・CP6 の反映後。着手時 290 → 段階 5 の完了時 168 →
 * CP6 で A 群を直して 148 → 走査器の盲点を塞いで 151）。余裕を 0 にすると無関係な
 * 変更が落ちるので、1 割ほどの余りを持たせる。
 */
const CEILING = 166

/**
 * 走査が読めていなければならないファイルの数。
 *
 * 上限そのものは数が減っても通るため、走査が実を持つことをここで確かめる。
 * 実測 53 ファイル（2026-08-25）。
 */
const SCANNED_FLOOR = 45

test("`any` の数が上限を超えていない", () => {
  const census = censusOfAny()

  // 走査が空・痩せていれば、下の照合は何も見ないまま緑になる
  assert.ok(
    census.scanned >= SCANNED_FLOOR,
    `走査できたのが ${census.scanned} ファイルしかない。数えた ${census.total} 個は実を持たない`,
  )

  const worst = [...census.byFile]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(({ path, count }) => `${path} ${count}`)
    .join(" / ")
  assert.ok(
    census.total <= CEILING,
    `any が ${census.total} 個ある（上限 ${CEILING}）。多い順: ${worst}`,
  )
})

test("上限と実数が離れすぎていない", () => {
  // 上限を下げ忘れると、離れたぶんだけ黙って増やせる。実数が下がったら上限も下げる
  const { total } = censusOfAny()
  assert.ok(
    CEILING - total <= 20,
    `上限 ${CEILING} と実数 ${total} が ${CEILING - total} 離れている。上限を下げる`,
  )
})

test("散文と文字列の中の `any` を数えない", () => {
  // 数え方の較正。`any` を話題にしたコメントが数に混じると、減らしたはずの数が
  // 動かない理由が読めなくなる。既知の答えを持つ入力で、除く側と数える側を分ける
  const source = [
    "// any をここで論じる",
    "/** any を JSDoc でも論じる */",
    'const 綴り = "any という文字列"',
    "function f(x: any) { return x }",
  ].join("\n")

  const { code, dropped } = withoutProse(source)
  assert.equal(dropped, 3, "散文と文字列の中の any を数え落としていない")
  assert.equal((code.match(/\bany\b/g) ?? []).length, 1, "本文の any が 1 個でない")

  // 潰した位置の長さを保つ。行と桁がずれると、申告が指す場所が実物と食い違う
  assert.equal(code.length, source.length, "潰した後で長さが変わった")
  assert.equal(code.split("\n").length, source.split("\n").length, "行数が変わった")
})

test("正規表現の中の引用符が、以降のコードを散文にしない", () => {
  // 走査器の守備範囲の較正。`[^\\s\'"]` のような文字クラスの引用符を文字列の始まりと
  // 読むと、そこから先のコードが丸ごと潰れる。CP6 で実測した ── `src/errors.ts` の
  // 絶対パスの正規表現から先へ `any` を仕込んでも、数が 1 つも動かなかった
  const source = [
    "const PATH = /[^\\s\'\"]+/g",
    "function f(x: any) { return x }",
  ].join("\n")

  const { code } = withoutProse(source)
  assert.equal((code.match(/\bany\b/g) ?? []).length, 1, "正規表現の後ろの any が見えない")
})

test("テンプレートの補間はコードとして数える", () => {
  // `${(error as any).stdout}` の中は式であり散文ではない。潰すと実在の any が
  // 数から漏れる（CP6 で実測。3 個が漏れていた）
  const source = "const t = `前${(error as any).stdout}後`"

  const { code, dropped } = withoutProse(source)
  assert.equal((code.match(/\bany\b/g) ?? []).length, 1, "補間の中の any を数えていない")
  assert.equal(dropped, 0, "補間の中を散文として数えた")
})

test("語の一部を `any` と数えない", () => {
  const { code } = withoutProse("const company: Anything = anyway")
  assert.equal((code.match(/\bany\b/g) ?? []).length, 0, "語の一部を数えている")
})
