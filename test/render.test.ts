import test from "node:test"
import assert from "node:assert/strict"
import { parseNotation } from "../src/parse.ts"
import { renderSvg, svgToPng } from "../src/render.ts"

const CODE = `緑の旗が押されたとき
(10) 歩動かす`

test("SVG が単体で表示できる形で出る", async () => {
  const svg = await renderSvg(await parseNotation(CODE))
  assert.match(svg, /^<svg/)
  assert.match(svg, /width="\d/)
  // 配色をページ側の CSS に頼っていないこと
  assert.match(svg, /<style/)
  // 日本語のラベルが文字として入っていること
  assert.ok(svg.includes("歩動かす"), "ラベルが SVG に無い")
})

test("拡大率を上げると SVG が大きくなる", async () => {
  const doc = await parseNotation(CODE)
  const small = widthOf(await renderSvg(doc, { scale: 1 }))
  const large = widthOf(await renderSvg(doc, { scale: 2 }))
  assert.ok(large > small * 1.5, `拡大されていない: ${small} -> ${large}`)
})

test("PNG が画像として出る", async () => {
  const svg = await renderSvg(await parseNotation(CODE))
  const png = svgToPng(svg)
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
  assert.ok(png.length > 1000, `画像が小さすぎる: ${png.length} バイト`)
})

test("PNG の寸法が SVG と一致する（拡大率を二重に掛けない）", async () => {
  const doc = await parseNotation(CODE)
  for (const scale of [1, 2, 3]) {
    const svg = await renderSvg(doc, { scale })
    assert.equal(
      pngWidthOf(svgToPng(svg)),
      Math.round(widthOf(svg)),
      `拡大率 ${scale} で SVG と PNG の幅が違う`,
    )
  }
})

function widthOf(svg: string) {
  return Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 0)
}

/** PNG の幅は IHDR チャンクの先頭 4 バイトに入る */
function pngWidthOf(png: Buffer) {
  return png.readUInt32BE(16)
}

test("図にしてよいかの規則が、1 か所で決まる", async () => {
  // `render` の入口にしか無かったころは、読み取りの描画経路が同じものを素通しした。
  // 規則を 1 か所へ寄せたので、ここを直に測れば両方の経路を測ったことになる
  const { readNotation } = await import("../src/parse.ts")
  const { undrawable } = await import("../src/cli.ts")

  const 判定 = async (code: string) => {
    const { doc } = await readNotation(code, "測定")
    assert.ok(doc !== null, `解析できない綴りで測っている: ${JSON.stringify(code)}`)
    return undrawable(doc, code)
  }

  // 実害を先に置く。寸法 0 の図と、認識できない記述を含む図を書かないことが規則である
  assert.ok(await 判定(""), "ブロックが 1 つも無い記法を通した")
  assert.match((await 判定(""))?.reason ?? "", /ブロックが 1 つも無い/)

  const 誤り = await 判定("10 歩動かす")
  assert.ok(誤り, "認識できない記述を含む記法を通した")
  assert.equal(誤り?.unknown.length, 1, "認識できない箇所の件数が合わない")

  // 対照。正しい記法は通す ── 「常に止める」実装でも緑にならないようにする
  assert.equal(await 判定("(10) 歩動かす"), null, "正しい記法を止めた")

  // 較正: 上の 2 つが本当に別々の理由で止まっていることを見る。片方の理由で両方が
  // 止まっていると、規則を 1 つ外しても緑のまま通る
  const 空の理由 = (await 判定(""))?.reason
  assert.notEqual(空の理由, 誤り?.reason, "2 つの砦が同じ理由で止めている")
})

test("読み取りが出す記法は、図にしてよい側を通る", async () => {
  // 上の砦が読み取りの経路で誤って発火しないことを測る。発火すると、読めているのに
  // 図だけが落ちる。印のコメントも値の印も認識される（2026-08-22 実測）
  const { readNotation } = await import("../src/parse.ts")
  const { undrawable } = await import("../src/cli.ts")

  const 読み取りが出す記法 = [
    "// 読み取れない: 未知opcode",
    "⟪読み取れない: looks_say⟫::custom",
    "[スコア v] を [⟪読み取れない: looks_say⟫] にする",
    "[スコ // ア v] を [1] にする",
  ]
  for (const code of 読み取りが出す記法) {
    const { doc } = await readNotation(code, "測定")
    assert.ok(doc !== null, `解析できない: ${JSON.stringify(code)}`)
    const 判定 = undrawable(doc, code)
    assert.equal(判定, null, `図にできないと言った: ${JSON.stringify(code)}`)
  }
})
