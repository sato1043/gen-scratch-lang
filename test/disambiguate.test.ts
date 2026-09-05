import assert from "node:assert/strict"
import test from "node:test"
import { rules } from "../src/disambiguate.ts"
import { eachBlock, parseNotation } from "../src/parse.ts"
import { renderSvg } from "../src/render.ts"
import { catalogOrStop } from "./fixtures.ts"

const catalog = catalogOrStop()

/** 記法を解析して、現れた識別子を並べる */
async function identifiersOf(code: string): Promise<string[]> {
  const doc = await parseNotation(code)
  return [...eachBlock(doc)].map(block => block.info?.id).filter(Boolean)
}

/** 台帳が持つ数学の関数の選択肢 */
function mathOperatorNames(): string[] {
  const entry = catalog.byIdentifier.get("OPERATORS_MATHOP")!
  return Object.keys(entry.args!.find(arg => arg.name === "OPERATOR")!.options!)
}

/** 図に現れたカテゴリの類 */
async function categoriesOf(code: string): Promise<string[]> {
  const svg = await renderSvg(await parseNotation(code))
  return [
    ...new Set(
      [...svg.matchAll(/class="([^"]+)"/g)]
        .flatMap(match => match[1].split(/\s+/))
        .filter(name => /^sb3-(operators|sensing|list|sound|looks)$/.test(name)),
    ),
  ]
}

test("数学の関数が、台帳の選択肢の数だけ読み替わる", async () => {
  const names = mathOperatorNames()
  assert.ok(names.length > 0, "台帳が選択肢を持っていない")

  for (const name of names) {
    const found = await identifiersOf(`[a v] を ((30) の [${name} v]) にする`)
    assert.ok(found.includes("OPERATORS_MATHOP"), `読み替わらない選択肢がある: ${name}`)
  }
})

test("属性の取得は読み替えない", async () => {
  // 日本語の綴りは「[対象 v] の [属性 v]」の順である（台帳の ja が `%2 の %1` で、
  // `%1` が属性・`%2` が対象）。第 1 位置が選択肢なら書かれているのは「調べる」の側である
  const found = await identifiersOf("[a v] を ([ネコ v] の [x座標 v]) にする")
  assert.ok(found.includes("SENSING_OF"))
  assert.ok(!found.includes("OPERATORS_MATHOP"))
})

test("選択肢と同じ名前のスプライトは、解析器が先に数学の関数を選ぶ", async () => {
  // 「sin」という名前のスプライトの x座標 を取ろうとすると、解析器そのものが数学の関数を
  // 返す。**読み替えを外しても同じ結果になる**（2026-09-05 実測）ので、この制約は上流の
  // ものであって読み替えが持ち込んだものではない。この記法ではその作品を書けない
  const found = await identifiersOf("[a v] を ([sin v] の [x座標 v]) にする")
  assert.ok(found.includes("OPERATORS_MATHOP"))

  // 対象の名が数学の関数でなければ、属性の取得として残る。読み替えの条件（第 1 位置が
  // 選択肢なら読み替えない）はこちらで効いている
  const other = await identifiersOf("[a v] を ([ネコ v] の [x座標 v]) にする")
  assert.ok(other.includes("SENSING_OF"))
  assert.ok(!other.includes("OPERATORS_MATHOP"))
})

test("丸括弧で書いた選択肢も選択肢として数える", async () => {
  // 形の綴りは `dropdown` と `number-dropdown` の 2 つある。後者を落とすと「選択肢でない」
  // と読まれ、属性の取得が数学の関数へ化ける
  const found = await identifiersOf("[a v] を ((x座標 v) の [sin v]) にする")
  assert.ok(found.includes("SENSING_OF"))
  assert.ok(!found.includes("OPERATORS_MATHOP"), "丸括弧の選択肢を見落としている")
})

test("カテゴリの明示が読み替えを断る", async () => {
  // 読み取りはカテゴリを明示して書き出す。値の欄に入っていた文字が偶然メニューの形を
  // 持つだけで別のブロックへ化けると、往復で opcode が変わる
  assert.ok((await identifiersOf("[a v] を ([ほげ v] の長さ::operators) にする"))
    .includes("OPERATORS_LENGTH"), "明示された演算を list へ読み替えている")
  assert.ok((await identifiersOf("[a v] を (音量::sound) にする"))
    .includes("SOUND_VOLUME"))

  // 明示が読み替え先と一致するときは読み替える（読み取りが書き出した形が戻る）
  assert.ok((await identifiersOf("[a v] を ((30) の [sin v]::operators) にする"))
    .includes("OPERATORS_MATHOP"))

  // 解析器が知らない綴りの明示は既定として届くので、明示として数えない
  assert.ok((await identifiersOf("[a v] を ([もちもの v] の長さ::data) にする"))
    .includes("DATA_LENGTHOFLIST"))
})

test("末尾が数学の関数の名でなければ読み替えない", async () => {
  // 第 1 位置は値だが、末尾が選択肢に無い。属性の取得を書き損ねたものとして扱う
  const found = await identifiersOf("[a v] を ((30) の [ネコ v]) にする")
  assert.ok(found.includes("SENSING_OF"))
  assert.ok(!found.includes("OPERATORS_MATHOP"))
})

test("リストの長さと文字の長さが引数の形で分かれる", async () => {
  assert.ok((await identifiersOf("[a v] を ([もちもの v] の長さ) にする"))
    .includes("DATA_LENGTHOFLIST"))
  assert.ok((await identifiersOf("[a v] を ([こんにちは] の長さ) にする"))
    .includes("OPERATORS_LENGTH"))
  assert.ok((await identifiersOf("[a v] を ((b) の長さ) にする"))
    .includes("OPERATORS_LENGTH"))
})

test("音の大きさはカテゴリの明示だけで分かれる", async () => {
  // 双方とも引数を持たないので、綴りの中に手掛かりが無い
  assert.ok((await identifiersOf("[a v] を (音量 :: sensing) にする"))
    .includes("SENSING_LOUDNESS"))
  assert.ok((await identifiersOf("[a v] を (音量) にする")).includes("SOUND_VOLUME"))
})

test("読み替えた結果が図のカテゴリにも出る", async () => {
  // 図と .sb3 は同じ中間表現から導く。読み替えを生成の側だけへ置くと、ここが食い違う
  assert.ok((await categoriesOf("[a v] を ((30) の [sin v]) にする")).includes("sb3-operators"))
  assert.ok((await categoriesOf("[a v] を ([もちもの v] の長さ) にする")).includes("sb3-list"))
  assert.ok((await categoriesOf("[a v] を (音量 :: sensing) にする")).includes("sb3-sensing"))

  // 読み替えない側は元のカテゴリのままである
  assert.ok((await categoriesOf("[a v] を ([ネコ v] の [x座標 v]) にする")).includes("sb3-sensing"))
  assert.ok((await categoriesOf("[a v] を (音量) にする")).includes("sb3-sound"))
})

test("規則が名指す識別子が台帳に実在する", async () => {
  // 台帳から消えた識別子を指す規則は、当たっても引き当てで落ちる。名指した先を見張る
  for (const rule of rules()) {
    assert.ok(catalog.byIdentifier.has(rule.from), `元が台帳に無い: ${rule.from}`)
    assert.ok(catalog.byIdentifier.has(rule.to), `先が台帳に無い: ${rule.to}`)
    assert.ok(rule.reason.length > 0, `理由の無い規則がある: ${rule.from}`)
  }
})

test("規則の先が、読み替えた後のカテゴリと食い違わない", async () => {
  // 図の色は読み替えたカテゴリで決まる。台帳のカテゴリとずれると、図だけが別の色になる
  for (const rule of rules()) {
    const entry = catalog.byIdentifier.get(rule.to)!
    assert.equal(entry.category, rule.category, `カテゴリが台帳と違う: ${rule.to}`)
  }
})
