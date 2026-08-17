import assert from "node:assert/strict"
import { ourSb3 } from "./fixtures.ts"
import test from "node:test"
import { readFileSync } from "node:fs"
import JSZip from "jszip"
import {
  ARCHIVE_ENTRY_LIMIT,
  PROJECT_JSON_LIMIT,
  acceptArchive,
} from "../src/intake.ts"
import { NESTING_LIMIT, openSb3, toNotation } from "../src/roundtrip.ts"
import { officialProblems } from "../src/validate.ts"

/**
 * 中身を指定して zip を作る。
 */
async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, body] of Object.entries(files)) zip.file(name, body)
  return zip.generateAsync({ type: "nodebuffer" })
}

/**
 * zip が名乗るエントリ数を書き換える。
 *
 * 3 万件の zip を実際に作ると 1 件あたりの生成が積み上がって 2 分半かかる（2026-08-20 実測）。
 * 受け入れ検査が見るのはセントラルディレクトリの終端が名乗る件数であり、そこを書き換えれば
 * 同じ判定を測れる。数え方を偽る zip を弾くこと自体も、測りたい挙動である。
 */
function claimingEntries(bytes: Buffer, count: number): Buffer {
  const patched = Buffer.from(bytes)
  // 終端は注記が無ければ末尾 22 バイト。件数の欄は 8 と 10 の 2 か所にある
  const end = patched.length - 22
  assert.equal(patched.readUInt32LE(end), 0x06054b50, "終端が末尾に無い")
  patched.writeUInt16LE(count, end + 8)
  patched.writeUInt16LE(count, end + 10)
  return patched
}

/**
 * セントラルディレクトリのヘッダを `count` 件だけ持つ zip を組み立てる。
 *
 * 実物の zip を 3 万件ぶん作ると 2 分半かかる（2026-08-20 実測）。受け入れ検査が数えるのは
 * セントラルディレクトリのヘッダなので、そこだけを組めば同じものを数えさせられる。中身の
 * ヘッダは置かない ── 検査は展開しないので読まない。
 */
function withRecords(count: number): Buffer {
  const name = Buffer.from("a.txt")
  const record = Buffer.alloc(46 + name.length)
  record.writeUInt32LE(0x02014b50, 0)
  record.writeUInt16LE(name.length, 28)
  name.copy(record, 46)

  const directory = Buffer.concat(Array.from({ length: count }, () => record))
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count & 0xffff, 8)
  end.writeUInt16LE(count & 0xffff, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(0, 16)
  return Buffer.concat([directory, end])
}

/** 検査を素通しにしない最小限の正当な project.json */
const SOUND_PROJECT = JSON.stringify({
  targets: [{ isStage: true, name: "Stage", blocks: {} }],
  meta: { semver: "3.0.0" },
})

test("自分たちが作った .sb3 を受け入れ検査が弾かない", async () => {
  // 上限を自分たちの生成物の倍率で置き直すと、この検査は緑のまま他者の作品を弾く側へ動く。
  // 弾かないことだけでなく、実際に .sb3 を読めていることも見る
  const bytes = await ourSb3()
  assert.deepEqual(acceptArchive(bytes, "測定"), [])

  const project = await openSb3(bytes)
  assert.ok(Array.isArray(project.targets) && project.targets.length > 0, "読めていない")
})

test("エントリが多すぎる zip を、読み取りと検証器の双方の経路で拒否する", async () => {
  const many = withRecords(ARCHIVE_ENTRY_LIMIT + 1)

  // 検証器へ渡す経路。上限を `openSb3` の内側にだけ置いていた頃はここが素通しだった
  const [refused] = await officialProblems(many, "測定")
  assert.equal(refused?.kind, "zip のエントリが多すぎる")
  // 検証器まで進んでいたら別の申告になる。短絡していることを名指しで見る
  assert.notEqual(refused?.kind, "公式検証器が弾いた")

  await assert.rejects(() => openSb3(many), /zip のエントリが多すぎる/)
})

test("エントリ数の上限が、通す側と弾く側の境で切り替わる", async () => {
  const files: Record<string, string> = { "project.json": SOUND_PROJECT }
  for (let i = 0; i < 9; i += 1) files[`asset-${i}.svg`] = "<svg/>"
  const ten = await zipOf(files)

  // 上限ちょうどは通す。1 つ下げたら弾く。片側だけを見ると、常に弾く実装でも緑になる
  assert.deepEqual(acceptArchive(ten, "測定", { entries: 10 }), [], "上限ちょうどを弾いた")
  const over = acceptArchive(ten, "測定", { entries: 9 })
  assert.equal(over[0]?.kind, "zip のエントリが多すぎる")
})

test("名乗る件数より実際の件数が多い zip を、名乗りでなく実際で数える", async () => {
  // zip の読み手は終端が名乗る件数を読み飛ばし、ヘッダの目印が続く限り読む
  // （JSZip 3.10.1 `lib/zipEntries.js` の `readCentralDir`）。名乗りを信じると、
  // 1 件と名乗って何万件も収めた zip が上限を素通りし、その後で読み手が費用を払う
  const files: Record<string, string> = { "project.json": SOUND_PROJECT }
  for (let i = 0; i < 9; i += 1) files[`asset-${i}.svg`] = "<svg/>"
  const lying = claimingEntries(await zipOf(files), 1)

  const over = acceptArchive(lying, "測定", { entries: 5 })
  assert.equal(over[0]?.kind, "zip のエントリが多すぎる")

  // 対照。実際の件数が上限に収まるなら、名乗りが小さくても通す
  assert.deepEqual(acceptArchive(lying, "測定", { entries: 10 }), [], "正当な zip を弾いた")
})

test("project.json が大きすぎる .sb3 を、双方の経路で展開する前に拒否する", async () => {
  // 上限を超える大きさだけを与える。中身の正しさはここでは問わない（受け入れ検査は
  // セントラルディレクトリが名乗る大きさだけを見て、1 バイトも展開しない）
  const huge = await zipOf({ "project.json": "a".repeat(PROJECT_JSON_LIMIT + 1) })

  const [refused] = await officialProblems(huge, "測定")
  assert.equal(refused?.kind, "project.json が大きすぎる")
  assert.notEqual(refused?.kind, "公式検証器が弾いた")

  await assert.rejects(() => openSb3(huge), /project\.json が大きすぎる/)
})

test("1 段のディレクトリに入った大きい project.json も見つける", async () => {
  // 検証器は 1 段のディレクトリを許す。名前の完全一致で探すと、そこへ隠された
  // project.json が上限を素通りする
  const huge = await zipOf({ "どこか/project.json": "a".repeat(PROJECT_JSON_LIMIT + 1) })
  const [refused] = await officialProblems(huge, "測定")
  assert.equal(refused?.kind, "project.json が大きすぎる")
})

test("zip でないバイト列も、量だけは見る", async () => {
  // 検証器は project.json のバイト列を直に受ける経路を持つ。zip を経ないぶん
  // セントラルディレクトリが無く、渡されたバイト列そのものが展開される量である
  const huge = Buffer.alloc(PROJECT_JSON_LIMIT + 1, 0x61)
  const [refused] = await officialProblems(huge, "測定")
  assert.equal(refused?.kind, "project.json が大きすぎる")

  // 小さいものは今までどおり検証器まで進む。ここを塞ぐと出荷経路が止まる
  const small = await officialProblems(Buffer.from("not a zip"), "測定")
  assert.equal(small[0]?.kind, "公式検証器が弾いた")
})

test("頭に 1 バイト足した .sb3 が、検証器へ届く前に止まる", async () => {
  // zip の読み手はセントラルディレクトリの終端を後ろから探すので、頭が汚れていても開ける。
  // 先頭の目印で zip かどうかを決めていた頃は、1 バイト足すだけでこの検査を飛び越せた
  const huge = await zipOf({ "project.json": "a".repeat(PROJECT_JSON_LIMIT + 1) })
  const shifted = Buffer.concat([Buffer.from("X"), huge])

  // 前置きはセントラルディレクトリの位置もずらすので、大きさより先に構造で止まる。Scratch は
  // 前置きのある .sb3 を作らないので、読めないと言って断る側へ倒す
  const [refused] = await officialProblems(shifted, "測定")
  assert.equal(refused?.kind, "zip として読めない")
  // 止まる名前より、検証器へ届かないことが要である
  assert.notEqual(refused?.kind, "公式検証器が弾いた")

  await assert.rejects(() => openSb3(shifted), /zip として読めない/)
})

test("受け入れ検査が投げても、検証器の口は申告を返す", async () => {
  // `Buffer` でない列を渡すと、バイトを読む口が無くて投げる。ここから素の例外が抜けると
  // 呼ぶ側に受け口が無く、スタックトレースがそのまま出る
  // 終端を探せる長さ（22 バイト以上）が要る。短いと 1 バイトも読まずに抜ける
  const notBuffer = new Uint8Array(64)
  const problems = await officialProblems(notBuffer as any, "測定")
  assert.equal(problems[0]?.kind, "受け入れ検査を通せない")
})

test("上限として使えない値を受け入れ検査も受け取らない", () => {
  const bytes = Buffer.from("not a zip")
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, null, "5000000"]) {
    assert.throws(
      // 型が禁じる値を渡して、実行時の見張りが効くことを測る
      () => acceptArchive(bytes, "測定", { entries: bad as number }),
      /上限の値が使えない/,
      `entries=${String(bad)} で上限が無効になった`,
    )
    assert.throws(
      () => acceptArchive(bytes, "測定", { projectJson: bad as number }),
      /上限の値が使えない/,
      `projectJson=${String(bad)} で上限が無効になった`,
    )
  }
})

/**
 * `count` 個のブロックが 1 本に入れ子になった表を作る。
 *
 * 入れ子の深さは辺の数で数えるので、この表の深さは `count - 1` である（入れ子を持たない
 * 1 個のブロックは深さ 0）。
 */
function nested(count: number): Record<string, any> {
  const blocks: Record<string, any> = {}
  for (let i = 0; i < count; i += 1) {
    blocks[`b${i}`] = {
      opcode: "control_if",
      next: null,
      parent: i === 0 ? null : `b${i - 1}`,
      inputs: i + 1 < count ? { SUBSTACK: [2, `b${i + 1}`] } : {},
      fields: {},
      shadow: false,
      topLevel: i === 0,
    }
  }
  return blocks
}

test("入れ子が深すぎる .sb3 を、RangeError でなく申告として弾く", async () => {
  // 深さは辺の数なので、上限を 1 つ超えるにはブロックが 2 つ余分に要る
  const deep = nested(NESTING_LIMIT + 2)
  const bytes = await zipOf({
    "project.json": JSON.stringify({ targets: [{ isStage: false, blocks: deep }] }),
  })

  // 型を名指す。RangeError のまま抜けると、最小化した依存のソースがスタックトレースごと出る
  await assert.rejects(() => openSb3(bytes), error => {
    assert.ok(!(error instanceof RangeError), "RangeError がそのまま抜けた")
    assert.match(String((error as any).message), /入れ子が深すぎる/)
    return true
  })

  // 表を受け取る口も同じ目を持つ。入口だけに置くと、zip を自分で開いた呼び出しが素通りする
  assert.throws(() => toNotation(deep), /入れ子が深すぎる/)
})

test("入れ子の上限が、通す側と弾く側の境で切り替わる", () => {
  // 深さ = ブロック数 - 1。上限ちょうどの深さは通し、1 つ深いものを弾く
  assert.doesNotThrow(() => toNotation(nested(NESTING_LIMIT + 1)), "上限ちょうどを弾いた")
  assert.throws(() => toNotation(nested(NESTING_LIMIT + 2)), /入れ子が深すぎる/)
})

test("直列に長いだけのスクリプトを、深いと誤らない", () => {
  // 逆変換は `next` を繰り返しで辿るので落ちない。深さに数えると正当な作品を弾く
  const blocks: Record<string, any> = {}
  const count = NESTING_LIMIT * 10
  for (let i = 0; i < count; i += 1) {
    blocks[`b${i}`] = {
      opcode: "motion_ifonedgebounce",
      next: i + 1 < count ? `b${i + 1}` : null,
      parent: i === 0 ? null : `b${i - 1}`,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: i === 0,
    }
  }

  const text = toNotation(blocks)
  assert.equal(text.split("\n").length, count, "直列の段数が記法に出ていない")
})

test("壊れた project.json の申告に、入力の断片が出ない", async () => {
  const secret = "これは外へ出てはいけない綴り"
  const bytes = await zipOf({ "project.json": `{"targets": ["${secret}"` })

  await assert.rejects(() => openSb3(bytes), error => {
    const shown = String((error as any).message)
    assert.ok(!shown.includes(secret), `入力の断片が申告に出た: ${shown}`)
    assert.match(shown, /JSON として読めない/)
    return true
  })
})

test("循環の申告が、経路の長さによらず読める長さに収まる", async () => {
  const blocks: Record<string, any> = {}
  const count = 8000
  for (let i = 0; i < count; i += 1) {
    blocks[`block-id-${String(i).padStart(8, "0")}`] = {
      opcode: "motion_ifonedgebounce",
      next: `block-id-${String((i + 1) % count).padStart(8, "0")}`,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: i === 0,
    }
  }

  // 畳む前は 1 行 160,033 文字だった（2026-08-20 実測）
  assert.throws(
    () => toNotation(blocks),
    error => {
      const shown = String((error as any).message)
      assert.ok(shown.length < 500, `申告が ${shown.length} 文字ある`)
      assert.match(shown, /参照が循環している/)
      // 畳んだ件数を残す。黙って切ると、経路の長さが後から分からない
      assert.match(shown, /ほか \d+ 件/)
      return true
    },
  )
})

test("短い循環は畳まずそのまま並べる", async () => {
  const blocks = {
    a: { opcode: "motion_ifonedgebounce", next: "b", inputs: {}, fields: {}, topLevel: true },
    b: { opcode: "motion_ifonedgebounce", next: "a", inputs: {}, fields: {}, topLevel: false },
  }
  assert.throws(() => toNotation(blocks), error => {
    assert.doesNotMatch(String((error as any).message), /ほか/, "畳む必要の無い経路を畳んだ")
    return true
  })
})

test("末尾に付け足した zip でも、上限が外れない", async () => {
  // 終端の記録が名乗る注記の長さと実際の残りが合わなくなるだけで、受け入れ検査が
  // 「zip として読めない」と読み、上限 3 種がまとめて外れていた（CP6 で実測。
  // エントリ 31,000 件の zip が通った）。読み手（JSZip）は長さの一致を求めない
  const many = withRecords(ARCHIVE_ENTRY_LIMIT + 1)
  const padded = Buffer.concat([many, Buffer.from([0])])

  // 較正。付け足す前は弾いている
  assert.equal(acceptArchive(many, "測定")[0]?.kind, "zip のエントリが多すぎる")
  assert.equal(
    acceptArchive(padded, "測定")[0]?.kind,
    "zip のエントリが多すぎる",
    "末尾に 1 バイト足すと上限が外れた",
  )
})
