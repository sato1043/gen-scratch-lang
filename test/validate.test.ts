import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { buildProject } from "../src/project.ts"
import { packSb3 } from "../src/sb3.ts"
import { officialProblems, refusalReason } from "../src/validate.ts"
import { detailOf } from "./fixtures.ts"

/** 追跡下の作品。出荷経路が実際に掛ける入力を検査にも使う */
const TRACKED = "projects/neko-to-score"

async function tracked(): Promise<{ project: any, assets: any[], bytes: Buffer }> {
  const built = await buildProject(TRACKED)
  assert.deepEqual(built.problems, [], "追跡下の作品が組み立てられない")
  return { ...built, bytes: await packSb3(built) }
}

test("追跡下の作品が .sb3 でも project.json でも検証を通る", async () => {
  const { project, bytes } = await tracked()
  assert.deepEqual(await officialProblems(bytes, TRACKED), [])
  // 出荷経路は json 形式では末尾に改行を付けて書き出す。その形のまま通ることを見る
  const json = Buffer.from(`${JSON.stringify(project)}\n`)
  assert.deepEqual(await officialProblems(json, TRACKED), [])
})

test("zip でも JSON でもないバイト列を弾き、理由を示す", async () => {
  const problems = await officialProblems(Buffer.from("これは zip ではない", "utf8"), "ためし")
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "公式検証器が弾いた")
  assert.equal(problems[0].subject, "ためし")
  // 検証器は素の文字列を渡してくる。空でなく読める理由が載る
  assert.match(detailOf(problems[0]), /JSON/)
})

test("壊れた JSON を収めた .sb3 を弾く", async () => {
  const { bytes } = await tracked()
  const zip = await JSZip.loadAsync(bytes)
  zip.file("project.json", "{ こわれ")
  const broken = await zip.generateAsync({ type: "nodebuffer" })

  const problems = await officialProblems(broken, "ためし")
  assert.equal(problems.length, 1)
  assert.match(detailOf(problems[0]), /JSON/)
})

test("schema に反する project を弾き、違反した場所を示す", async () => {
  const { project } = await tracked()
  const broken = structuredClone(project)
  for (const target of broken.targets) target.costumes = []

  const [problem] = await officialProblems(Buffer.from(JSON.stringify(broken)), "ためし")
  assert.ok(problem, "コスチュームが 0 個の project を通してしまう")
  // どこが悪いのかが分かる形で載る。理由が定型文だけなら直す手掛かりにならない
  assert.match(detailOf(problem), /costumes/)
})

test("sb2 側のエラーを理由に混ぜない", async () => {
  const { project } = await tracked()
  const broken = structuredClone(project)
  for (const target of broken.targets) target.costumes = []

  const [problem] = await officialProblems(Buffer.from(JSON.stringify(broken)), "ためし")
  // 検証器は sb3 の作品にも「sb2 として読めない」を必ず添えてくる。混ぜると
  // 本当の原因が埋もれ、読み手を sb2 の話へ誘導する
  assert.doesNotMatch(detailOf(problem), /objName/)
})

test("検証器が本体依存として宣言されている", () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  )
  // 出荷経路で使う以上、開発依存では配布した先で読み込めない
  assert.ok(
    manifest.dependencies["scratch-parser"],
    "scratch-parser が dependencies に無い",
  )
  assert.equal(manifest.devDependencies?.["scratch-parser"], undefined)
})

test("未知の形の拒否値でも、理由の組み立てで落ちない", () => {
  // 依存は ^6.0.1 で 6.x の更新が自動で入る。形が変わったとき、ここで例外を投げると
  // 検証器のコールバックの中で投げることになり、promise が解決しないまま固まる
  const circular: Record<string, any> = { もと: 1 }
  circular.自分 = circular

  const cases = [
    { name: "Error", value: new Error("こわれた"), expect: /Error: こわれた/ },
    { name: "循環した object", value: circular, expect: /理由を文字にできない: object/ },
    { name: "BigInt", value: 42n, expect: /理由を文字にできない: bigint/ },
    // `String(symbol)` は投げない（投げるのは暗黙の変換だけ）。素の記述が理由になる
    { name: "Symbol", value: Symbol("x"), expect: /Symbol\(x\)/ },
    { name: "関数", value: function こわれ() {}, expect: /こわれ/ },
    { name: "数", value: 42, expect: /42/ },
  ]

  for (const item of cases) {
    const reason = refusalReason(item.value)
    assert.equal(typeof reason, "string", `${item.name} で文字列が返らない`)
    assert.ok(reason.length > 0, `${item.name} で理由が空`)
    assert.match(reason, item.expect, `${item.name} の理由が読めない`)
  }
})

test("重なった違反と、場所を名指さない違反で枠を埋めない", async () => {
  const { project } = await tracked()
  const broken = structuredClone(project)
  for (const target of broken.targets) {
    for (const id of Object.keys(target.blocks)) delete target.blocks[id].opcode
  }

  const [problem] = await officialProblems(Buffer.from(JSON.stringify(broken)), "ためし")
  // 検証器は 1 つの誤りから 5 件を返し、うち 4 件が重複と oneOf だった（2026-08-19 実測）。
  // 畳まないと本当の原因が「ほか N 件」へ押し出される
  assert.match(detailOf(problem), /opcode/, "本当の原因が理由から落ちている")
  assert.doesNotMatch(detailOf(problem), /oneOf/, "場所を名指さない違反が枠を占めている")

  const lines = detailOf(problem).split(" / ")
  assert.equal(new Set(lines).size, lines.length, "同じ行を 2 度並べている")
})

test("場所を名指す違反がほかに無ければ、曖昧な違反でも理由に載せる", () => {
  const reason = refusalReason({
    sb3Errors: [
      { keyword: "oneOf", dataPath: ".targets[0]", message: "should match exactly one schema in oneOf" },
    ],
  })
  // 落とすのは代わりが残るときだけ。唯一の手掛かりまで消すと「弾かれた」しか伝わらない
  assert.match(reason, /oneOf/)
})

test("場所を持たない違反は、曖昧な違反を落とす根拠に数えない", () => {
  const reason = refusalReason({
    sb3Errors: [
      { keyword: "type", dataPath: "", message: "should be object" },
      { keyword: "oneOf", dataPath: ".targets[0]", message: "should match exactly one schema in oneOf" },
    ],
  })
  // 「場所を名指す行が残るときだけ落とす」と宣言している。最上位しか言わない行を
  // 根拠にすると、宣言と実装の軸がずれる
  assert.match(reason, /oneOf/, "場所を持たない行を根拠に、名指す行を落としている")
})

test("違反の要素が壊れた形でも、理由の組み立てで落ちない", () => {
  // 検証器の応答形は依存の版で変わりうる（^6.0.1）。ここで投げると検証器のコールバックの
  // 中で投げることになり、promise が解決も棄却もされないまま固まる
  for (const details of [[null], ["こわれ"], [{ dataPath: ".a" }], [{}], [42]]) {
    const reason = refusalReason({ sb3Errors: details })
    assert.equal(typeof reason, "string", `${JSON.stringify(details)} で文字列が返らない`)
    assert.ok(reason.length > 0, `${JSON.stringify(details)} で理由が空`)
  }
})

test("前置きが長い別々の違反を 1 行へ畳まない", () => {
  const long = "x".repeat(150)
  const reason = refusalReason({
    sb3Errors: [
      { keyword: "type", dataPath: `.targets[0].blocks['${long}'].A`, message: "should be array" },
      { keyword: "type", dataPath: `.targets[0].blocks['${long}'].B`, message: "should be array" },
    ],
  })
  // 重なりを切り詰めた後で見ると、頭が同じで違う場所を指す違反どうしが 1 件へ潰れる
  assert.equal(reason.split(" / ").length, 2, `別の違反が畳まれている: ${reason}`)
})

test("畳んだ件数と、枠に入りきらない行数を別々に申告する", () => {
  const same = { keyword: "type", dataPath: ".a", message: "should be array" }
  const reason = refusalReason({ sb3Errors: [same, same, same] })
  // 1 つの「ほか N 件」へ混ぜると、検証器が何件返したのかを後から知る手立てが消える
  assert.match(reason, /重なりで畳んだ 2 件/, `畳んだ数が申告に出ていない: ${reason}`)
})

test("場所が長くても、何が悪いかが理由に残る", () => {
  const reason = refusalReason({
    sb3Errors: [
      { dataPath: `.targets[0].variables['${"な".repeat(300)}']`, message: "should be array" },
    ],
  })
  // まとめて切ると、場所だけで枠を使い切って診断が消える
  assert.match(reason, /should be array/, "診断が切り落とされている")
})

test("理由 1 件の長さに上限が掛かる", () => {
  const long = "あ".repeat(5000)
  const reason = refusalReason({
    validationError: "だめ",
    sb3Errors: [{ dataPath: `.targets[0].${long}`, message: long }],
  })

  // 宣言した上限が主要な分岐にも掛かる。掛からないと stderr が 1 行で埋まる
  assert.ok(reason.length <= 200, `理由が長すぎる: ${reason.length} 文字`)
})

test("成果物向けの広い枠が、schema 診断の経路にも掛かる", () => {
  // 枠を件数だけ広げて長さを端末のまま置くと、成果物でも端末と同じ 200 桁で切れる。
  // 後から開いて読むものなのに続きを見る手段が無い（2026-08-22 実測）
  const 長い = { dataPath: `.targets[3].${"a".repeat(160)}`, message: "b".repeat(300) }
  const error = { sb3Errors: [長い] }
  const 端末 = refusalReason(error)
  const 成果物 = refusalReason(error, { items: 20, length: 800 })

  // 実害を先に置く。端末で切れた続きが成果物に載っていることが要る
  assert.ok(
    成果物.length > 端末.length,
    `成果物が端末より広くない: 端末 ${端末.length} 文字 / 成果物 ${成果物.length} 文字`,
  )
  assert.ok(成果物.length <= 800, `成果物の枠を超えた: ${成果物.length} 文字`)
})

test("較正: 枠を広げなければ、この診断は端末の枠で切れる", () => {
  // 上の検査が測る対象があることを確かめる。切れない短い診断で測っても差は出ない
  const 短い = { dataPath: ".targets[0].x", message: "should be number" }
  assert.ok(refusalReason({ sb3Errors: [短い] }).length < 200, "短い診断が既に枠を超えた")
  const 長い = { dataPath: `.targets[3].${"a".repeat(160)}`, message: "b".repeat(300) }
  assert.equal(refusalReason({ sb3Errors: [長い] }).length, 200, "端末の枠で切れていない")
})
