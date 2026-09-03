import test from "node:test"
import assert from "node:assert/strict"
import { PROVENANCE } from "../catalog/provenance.ts"
import { FINGERPRINTED, buildCatalog } from "../tools/build-catalog.ts"
import { loadCatalog } from "../src/catalog.ts"

/**
 * 上流から書き出し直せない表を、見張れていない範囲として申告できているかを見る。
 *
 * 照合が通っただけでは全部を見張れたことにならない。手書きの表 675 行のうち照合で
 * 見張れるのは選択肢の対応だけで、残りは出典の版が動いたことしか分からない。分から
 * ないことを分からないと言えている状態を保つ。
 */

const { catalog, problems } = buildCatalog()

test("台帳が、上流から書き出し直せない表を出典つきで申告する", () => {
  const declared = catalog.表の出典
  assert.ok(Array.isArray(declared), "出典の欄が無い")

  // 導出できる表は照合で見張るので、この欄には出さない（実測 2026-08-18: 8 件中 7 件）
  assert.equal(declared.length, PROVENANCE.length - 1)

  // 指紋が畳む表と、出典を名乗る表を突き合わせる。両辺が PROVENANCE 由来だと、表を
  // 足して申告し忘れても永久に緑になる（2026-09-03 に実際に 1 表が漏れた）。
  // 例外表は引数で渡るので指紋の側に無く、選択肢の対応は照合で見張るので出典の側に無い
  const fingerprinted = new Set(Object.keys(FINGERPRINTED))
  const claimed = new Set(PROVENANCE.map(source => source.表.replace(/（.*）$/, "")))
  const unclaimed = [...fingerprinted].filter(name => !claimed.has(name))
  assert.deepEqual(
    unclaimed,
    [],
    "指紋へ入れたのに出典を名乗っていない表がある。PROVENANCE へ足す",
  )
  assert.ok(
    declared.every(source => source.種別 !== "導出"),
    "照合で見張れる表が、見張れない側へ紛れている",
  )
  assert.ok(
    declared.every(source => source.理由.length > 0),
    "理由の無い項目がある。導けないのではなく調べていない疑いがある",
  )

  // 旧版から取った表は、版まで名乗れていないと確かめ直せない
  const old = declared.filter(source => source.種別 === "旧版")
  assert.ok(old.length >= 2)
  assert.ok(old.every(source => typeof source.版 === "string" && source.版.length > 0))
})

test("出典の記録が生成物へ載り、読み出せる", () => {
  const written = loadCatalog()
  assert.deepEqual(written.raw!.表の出典, catalog.表の出典)
})

test("出典の版が動くと、確かめ直しを促す", () => {
  // 測定器の較正。問題 0 件が「動いていない」からであって、誰も見ていないから
  // ではないことを、既知の答えを持つ入力で確かめる
  const moved = PROVENANCE.map(source => ({ ...source, 確認した現行版: "0.0.0-未来" }))
  const { problems: raised } = buildCatalog({ provenance: moved })

  const stale = raised.filter(problem => problem.kind === "出典を確かめ直す必要がある")
  assert.equal(stale.length, PROVENANCE.length)
  assert.ok(stale.every(problem => problem.detail.includes("0.0.0-未来")))
})

test("今の出典は、現行の版で確かめられている", () => {
  const stale = problems.filter(problem => problem.kind === "出典を確かめ直す必要がある")
  assert.deepEqual(stale, [], "出典の記録が現行の版から遅れている")
})
