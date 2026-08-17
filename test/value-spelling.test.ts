/**
 * 値の綴りが往復で保たれるかを測る。
 *
 * 測るのは読む向きの往復（.sb3 → 記法と作品定義 → .sb3）である。生成の向きの往復は
 * `roundtrip.test.ts` が持っており、そちらはブロックの識別子列を比べる。ここで比べる
 * のは**値の中身**で、識別子が一致していても値が変わっていれば落ちる。
 *
 * 入口（CLI）を通す。読む向きの往復は `read` の出力ディレクトリがそのまま `build` の
 * 入力になる形で成立しており、モジュールを直に呼ぶと 2 つを繋ぐ規約の側を測り損ねる。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import JSZip from "jszip"
import { parseNotation, eachBlock } from "../src/parse.ts"
import { restored, spelled, unrestorable } from "../src/notation.ts"
import { readSb3 } from "../src/read.ts"
import { ourSb3, projectJsonIn } from "./fixtures.ts"

const run = promisify(execFile)
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

/** 印の括弧。実装と同じ綴りを検査の側にも置く（`read.ts` は外へ出していない）*/
const SENTINEL_OPEN = String.fromCodePoint(0x27ea)
const SENTINEL_CLOSE = String.fromCodePoint(0x27eb)

/**
 * 測る対象の制御文字。区分ごとに 1 つずつ選ぶ。
 *
 * 代表を選ぶのは、符号位置の全域を往復させると入口を 1114112 回通ることになるためで
 * ある。区分を跨いで 1 つの値へ詰め、1 回の往復で全区分を測る。区分そのものは
 * `errors.ts` の許可リスト（通すのは L / M / N / P / S / Zs）が決めており、落ちるのは
 * その他（C）である。
 */
const CONTROLS: [number, string][] = [
  [0x000a, "改行（C0）"],
  [0x0009, "タブ（C0）"],
  [0x0000, "NUL（C0）"],
  [0x001b, "ESC（C0・端末の制御列の頭）"],
  [0x0085, "NEL（C1）"],
  [0x202e, "右書き強制（双方向制御）"],
  [0x2028, "行区切り"],
  [0x2029, "段落区切り"],
  [0x200d, "結合子（不可視）"],
  [0x0e0001, "言語タグ（基本多言語面の外・5 桁）"],
  [0x10fffe, "非文字（基本多言語面の外・6 桁）"],
]

/** 全区分を 1 つに詰めた値。区切りの平仮名は、落ちたときにどこが消えたかを読むため */
const LOADED = CONTROLS.map(([code], i) => `あ${String.fromCodePoint(code)}${i}`).join("")

/**
 * 題材の .sb3 へ「言う」ブロックを 1 つ足す。
 *
 * 足す先を「言う」にするのは、値を 1 つだけ持ち、他の欄と混ざらないためである。
 *
 * `value` は仕込む値
 */
async function sb3WithValue(value: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await ourSb3())
  const { project } = await projectJsonIn(zip)
  const target = project.targets.find(each => !each.isStage)
  const blocks: Record<string, any> = target.blocks
  const head = Object.entries(blocks).find(([, block]) => block.topLevel)
  assert.ok(head, "題材に先頭のブロックが無い")

  const [headId, headBlock] = head
  target.blocks.measured = {
    opcode: "looks_say",
    next: headBlock.next,
    parent: headId,
    inputs: { MESSAGE: [1, [10, value]] },
    fields: {},
    shadow: false,
    topLevel: false,
  }
  if (headBlock.next) target.blocks[headBlock.next].parent = "measured"
  headBlock.next = "measured"

  zip.file("project.json", JSON.stringify(project))
  return zip.generateAsync({ type: "nodebuffer" })
}

/**
 * 題材の .sb3 の変数名を、宣言と参照の双方で置き換える。
 *
 * 片方だけ替えると `build` が「変数が宣言されていない」で止まり、測りたい綴りの問題と
 * 仕込みの誤りが同じ落ち方になる（起票時に実際に取り違えた）。
 *
 * `name` は置き換えた後の名前
 */
async function sb3WithVariableName(name: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await ourSb3())
  const { source, project } = await projectJsonIn(zip)

  const swap = (value: any): any =>
    Array.isArray(value)
      ? value.map(swap)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, each]) => [
              key === "スコア" ? name : key,
              swap(each),
            ]),
          )
        : typeof value === "string"
          ? value.split("スコア").join(name)
          : value

  assert.ok(source.includes("スコア"), "題材に置き換える変数が無い")
  zip.file("project.json", JSON.stringify(swap(project)))
  return zip.generateAsync({ type: "nodebuffer" })
}

/**
 * .sb3 を読んで書き戻し、途中の成果物ごと返す。
 */
async function roundTrip(bytes: Buffer): Promise<{ rebuilt: Buffer, notation: string, definition: string }> {
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-spelling-"))
  const source = join(dir, "測定.sb3")
  const out = join(dir, "読んだもの")
  const rebuilt = join(dir, "戻したもの.sb3")
  writeFileSync(source, bytes)

  await run(process.execPath, [CLI, "read", source, "--out", out])
  await run(process.execPath, [CLI, "build", out, "--out", rebuilt])

  const notation = readdirSync(out)
    .filter(name => name.endsWith(".sbk"))
    .map(name => readFileSync(join(out, name), "utf8"))
    .join("\n")
  return {
    rebuilt: readFileSync(rebuilt),
    notation,
    definition: readFileSync(join(out, "project.yaml"), "utf8"),
  }
}

/**
 * .sb3 から「言う」ブロックの値を取り出す。
 */
async function saidValuesIn(bytes: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes)
  const { project } = await projectJsonIn(zip)
  const said = []
  for (const target of project.targets) {
    for (const block of Object.values<any>(target.blocks)) {
      if (Array.isArray(block) || block.opcode !== "looks_say") continue
      said.push(String(block.inputs?.MESSAGE?.[1]?.[1] ?? ""))
    }
  }
  return said
}

/**
 * 文字列に残っている「その他（C）」の符号位置を挙げる。
 *
 * 通す側（L / M / N / P / S / Zs）を数える。危ない文字を挙げる形にすると、次に増えた
 * 区分が漏れる。
 *
 * **改行だけは除く。** 記法も作品定義も行区切りに改行を使うので、ファイル全体を走査
 * すると構造の改行と値に混ざった改行を見分けられない。値の中の改行は往復の一致を見る
 * 検査（`値の制御文字が往復で失われない`）が受け持つ。
 *
 * 戻りは見つかった符号位置の綴り
 */
function rawControlsIn(text: string): string[] {
  return [...text]
    .filter(character => !/[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\n]/u.test(character))
    .map(
      character =>
        `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
    )
}

test("測る前提が立っている", async () => {
  // 詰めた値が 1 区分も持たないと、以下の検査は何も測らないまま緑になる
  assert.equal(CONTROLS.length, 11, "測る区分の数が変わっている")

  // 印の桁数が 4 桁で足りると思い込むと、基本多言語面の外が黙って戻らなくなる。破壊で
  // 実際に素通りしたので、5 桁と 6 桁を測る側へ入れた（TASK0016 の段階 6）
  assert.ok(
    CONTROLS.some(([code]) => code > 0xffff && code <= 0xfffff) &&
      CONTROLS.some(([code]) => code > 0xfffff),
    "基本多言語面の外を 5 桁と 6 桁の双方で測っていない",
  )

  // 9 区分のうち改行だけは走査から外れる（`rawControlsIn` を参照）。残り 8 区分が
  // 生のまま入っていることを、走査する側の器で確かめてから使う
  assert.equal(rawControlsIn(LOADED).length, CONTROLS.length - 1)
})

test("値の制御文字が往復で失われない", async () => {
  const { rebuilt } = await roundTrip(await sb3WithValue(LOADED))

  // 実害を最初に見る。値が変われば、Scratch で開いたときの台詞が元と違う
  assert.deepEqual(await saidValuesIn(rebuilt), [LOADED])
})

test("記法と作品定義に生の制御文字が入らない", async () => {
  const { notation, definition } = await roundTrip(await sb3WithValue(LOADED))

  // 実害を最初に見る。1 文字でも残ると grep と git diff がバイナリと判定し、
  // 「読む・直す・差分を追う」が丸ごと成り立たなくなる
  assert.deepEqual(rawControlsIn(notation), [], `記法: ${JSON.stringify(notation)}`)
  assert.deepEqual(rawControlsIn(definition), [])
})

test("印の括弧を持つ値が往復で元へ戻る", async () => {
  const value = `印${SENTINEL_OPEN}中${SENTINEL_CLOSE}後`
  const { rebuilt } = await roundTrip(await sb3WithValue(value))

  // 守りは保ったまま可逆にする。今は全角へ置き換えて落としており、戻らないうえに
  // 置き換えたことも申告しない
  assert.deepEqual(await saidValuesIn(rebuilt), [value])
})

test("印と同じ綴りを元から持つ値が往復で元へ戻る", async () => {
  const value = `${SENTINEL_OPEN}U+000A${SENTINEL_CLOSE}`
  const { rebuilt } = await roundTrip(await sb3WithValue(value))

  // 逃がしの自己衝突。作品が名乗った綴りを、こちらが作った印と取り違えて改行へ
  // 戻すと、往復のたびに値が変わっていく
  assert.deepEqual(await saidValuesIn(rebuilt), [value])
})

test("名前に制御文字を持つ作品が往復できる", async () => {
  const name = `ス${String.fromCharCode(10)}ア`

  // 実害を最初に見る。往復が成立しないと、読んだものを Scratch へ戻せない。印の綴りに
  // 山括弧を使っていたころは `build` が「識別子 scratchblocks:end が台帳に無い」で
  // 止まっていた
  const { rebuilt } = await roundTrip(await sb3WithVariableName(name))

  const zip = await JSZip.loadAsync(rebuilt)
  const { project } = await projectJsonIn(zip)
  const names = project.targets.flatMap(target =>
    Object.values<any>(target.variables ?? {}).map(entry => entry[0]),
  )

  // 名前も値と同じ規則で復す。記法の側と作品定義の側の双方で復すので、綴りは揃った
  // まま元へ戻る。期待値は元の入力から作り、実装の出力からは作らない
  assert.deepEqual(names, [name], `戻した変数名: ${JSON.stringify(names)}`)
})

/** 印つきの綴りを置き直す文脈と、そこで立つべき selector の組 */
const CASES: [string, (spelling: string) => string, string[]][] = [
  ["ドロップダウン", spelling => `[${spelling} v] を (1) ずつ変える`, ["changeVar:by:"]],
  [
    "レポーター",
    spelling => `(${spelling}) を [記録 v] に追加する`,
    ["append:toList:", "readVariable"],
  ],
  ["値の欄", spelling => `[${spelling}] と言う`, ["say:"]],
]

for (const [context, wrap, expected] of CASES) {
  test(`印を含む名前が ${context} でパースできる`, async () => {
    // 入口を通さず読む。CLI 越しだと図を作れない時点で非 0 で止まり、綴りを測る前に
    // 落ちる ── 落ちた理由が綴りを指さない
    const bytes = await sb3WithVariableName(`ス${String.fromCharCode(10)}ア`)
    const { targets, problems } = await readSb3(bytes, "測定")
    assert.deepEqual(problems, [], "測る前に読めていない")
    const notation = targets
      .filter(target => !target.isStage)
      .flatMap(target => target.scripts)
      .join("\n")

    // 記法から印つきの綴りを取り出し、3 つの文脈へ置き直して測る。往復の成否で
    // 測ると、壊れた理由が綴りなのか逆写しなのか分からない
    const spelling = notation.match(/ス\S*ア/u)?.[0]
    assert.ok(spelling, `印つきの綴りが記法に無い: ${JSON.stringify(notation)}`)

    const document = await parseNotation(wrap(spelling))
    const found = [...eachBlock(document)].map(
      block => block.info?.selector ?? block.info?.id ?? "(none)",
    )
    assert.deepEqual(found, expected, `綴り: ${JSON.stringify(spelling)}`)
  })
}

// ここから下は、入口を通さずに測る区分である。上の検査はいずれも「.sb3 を入力にした
// 往復」で、手書きの記法・作品定義を `build` へ通す経路と、綴りの規則そのものを直に
// 呼ぶ経路を 1 件も持っていなかった。CP6 の指摘 8 束のうち 5 束がその死角に居た。

test("綴りの規則が、符号位置の全域で可逆である", () => {
  // 入口越しの往復は 1 回が数秒かかるので、代表値を数個しか通せない。純関数として
  // 呼べば全域を舐められる ── 区分の代表を選ぶ判断そのものが要らなくなる
  let checked = 0
  for (let code = 0; code <= 0x10ffff; code += 1) {
    // サロゲートは単独で文字にできない。文字列に置けないものは入力になりえない
    if (code >= 0xd800 && code <= 0xdfff) continue
    const value = `あ${String.fromCodePoint(code)}い`
    if (restored(spelled(value)) !== value) {
      assert.fail(`U+${code.toString(16).toUpperCase()} が往復で戻らない`)
    }
    checked += 1
  }

  // 走査が途中で終わっていると、以下の主張は測っていない範囲を含む
  assert.equal(checked, 0x110000 - 0x800, "全域を舐めていない")
})

test("指せない符号位置の印は、復さずに挙げる", () => {
  for (const hex of ["110000", "FFFFFF", "D800", "DFFF"]) {
    const value = `あ${SENTINEL_OPEN}U+${hex}${SENTINEL_CLOSE}い`

    // 復すと `String.fromCodePoint` が投げるか、不正な UTF-16 を作る。どちらも
    // 入力の誤りなので、綴りのまま残して呼ぶ側が申告できるようにする
    assert.equal(restored(value), value, `U+${hex} を復してしまった`)
    assert.deepEqual(unrestorable(value), [`${SENTINEL_OPEN}U+${hex}${SENTINEL_CLOSE}`])
  }

  // 指せる側は復す。上の主張だけだと「何も復さない」実装でも通る
  assert.equal(restored(`あ${SENTINEL_OPEN}U+10FFFF${SENTINEL_CLOSE}い`), "あ\u{10FFFF}い")
  assert.deepEqual(unrestorable(`あ${SENTINEL_OPEN}U+10FFFF${SENTINEL_CLOSE}い`), [])
})

test("手書きの記法に書いた指せない印を、入力の誤りとして止める", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-handmade-"))
  writeFileSync(
    join(dir, "project.yaml"),
    ["名前: 手書き", "スプライト:", "  - 名前: ネコ", "    スクリプト: main.sbk"].join("\n"),
  )
  writeFileSync(
    join(dir, "main.sbk"),
    `緑の旗が押されたとき\n[あ${SENTINEL_OPEN}U+110000${SENTINEL_CLOSE}い] と言う\n`,
  )

  const failed = await run(process.execPath, [CLI, "build", dir, "--out", join(dir, "out.sb3")])
    .then(() => null)
    .catch(error => error)

  // 実害を最初に見る。内部例外として落ちると「こちらの落ち度である」と申告され、
  // 書いた本人は自分の入力を疑えない
  assert.ok(failed, "指せない印を書いた記法が通ってしまった")
  assert.match(failed.stderr, /印が指せない符号位置を書いている/)
  assert.doesNotMatch(failed.stderr, /内部で例外が出た/)
})

test("手書きの作品定義に書いた指せない印も、入力の誤りとして止める", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-handmade-"))
  writeFileSync(
    join(dir, "project.yaml"),
    [
      "名前: 手書き",
      "スプライト:",
      "  - 名前: ネコ",
      "    スクリプト: main.sbk",
      "    変数:",
      `      あ${SENTINEL_OPEN}U+110000${SENTINEL_CLOSE}い: 0`,
    ].join("\n"),
  )
  writeFileSync(join(dir, "main.sbk"), "緑の旗が押されたとき\n")

  const failed = await run(process.execPath, [CLI, "build", dir, "--out", join(dir, "out.sb3")])
    .then(() => null)
    .catch(error => error)

  assert.ok(failed, "指せない印を書いた定義が通ってしまった")
  assert.match(failed.stderr, /印が指せない符号位置を書いている/)
  assert.doesNotMatch(failed.stderr, /内部で例外が出た/)
})

test("同じ記法から出た図と .sb3 が、同じものを指す", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-handmade-"))
  writeFileSync(
    join(dir, "project.yaml"),
    ["名前: 手書き", "スプライト:", "  - 名前: ネコ", "    スクリプト: main.sbk"].join("\n"),
  )
  const notation = `緑の旗が押されたとき\n[X${SENTINEL_OPEN}U+0041${SENTINEL_CLOSE}Y] と言う\n`
  writeFileSync(join(dir, "main.sbk"), notation)

  await run(process.execPath, [CLI, "render", join(dir, "main.sbk"), "--out", join(dir, "f.svg")])
  await run(process.execPath, [CLI, "build", dir, "--out", join(dir, "out.sb3")])

  const drawn = readFileSync(join(dir, "f.svg"), "utf8")
  const [said] = await saidValuesIn(readFileSync(join(dir, "out.sb3")))

  // 実害を最初に見る。図が印のままで .sb3 が実体だと、同じ記法から出た 2 つが違うものを
  // 指す（README の「導出元が 1 つなので食い違わない」の反例になる）
  assert.equal(said, "XAY")
  assert.ok(drawn.includes("XAY"), "図が .sb3 と同じ綴りを描いていない")
  assert.ok(
    !drawn.includes(`X${SENTINEL_OPEN}U+0041${SENTINEL_CLOSE}Y`),
    "図が手書きの印をそのまま描いている",
  )
})
