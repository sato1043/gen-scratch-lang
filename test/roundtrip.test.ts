import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { loadSnippets } from "../src/idioms.ts"
import { parseNotation } from "../src/parse.ts"
import { buildProject } from "../src/project.ts"
import {
  PROJECT_JSON_LIMIT,
  identifiersOf,
  openSb3,
  toNotation,
} from "../src/roundtrip.ts"
import { packSb3 } from "../src/sb3.ts"
import { serializeScripts } from "../src/serialize.ts"
import { officialProblems } from "../src/validate.ts"
import { catalogOrStop, projectJsonIn, spriteOf } from "./fixtures.ts"

const catalog = catalogOrStop()
const snippets = loadSnippets(new URL("../docs/knowledge/idioms/", import.meta.url))

/**
 * 記法が要求する変数とリストを集める。
 *
 * 名前の見分けは直列化器に数えさせる。同じ規則を検査側で書き直すと、規則が誤ったとき
 * 双方が同じに誤って気づけない。
 */
function used(doc: any): { variable: string[], list: string[] } {
  const found = { variable: new Set<string>(), list: new Set<string>() }
  serializeScripts(doc, {
    catalog,
    names: {
      idFor: (kind: string, name: string) => {
        if (kind !== "broadcast") found[kind as "variable" | "list"].add(name)
        return `${kind}:${name}`
      },
    },
  })
  return { variable: [...found.variable], list: [...found.list] }
}

/** 影でない先頭のブロックの識別子。壊し方を仕込む先に使う */
function idOfFirstReal(blocks: Record<string, any>): string {
  const id = Object.keys(blocks).find(key => !blocks[key].shadow)
  if (!id) throw new Error("影でないブロックが 1 つも無い")
  return id
}

/**
 * 記法 1 つぶんの作品を組み立てて .sb3 にする。
 */
async function toSb3(code: string): Promise<Buffer> {
  const { variable, list } = used(await parseNotation(code))
  const definition = [
    "スプライト:",
    "  - 名前: ネコ",
    "    スクリプト: main.sbk",
    ...(variable.length > 0 ? ["    変数:", ...variable.map(n => `      ${n}: 0`)] : []),
    ...(list.length > 0 ? ["    リスト:", ...list.map(n => `      ${n}: []`)] : []),
  ].join("\n")

  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-"))
  writeFileSync(join(dir, "project.yaml"), definition)
  writeFileSync(join(dir, "main.sbk"), code)

  const built = await buildProject(dir)
  assert.deepEqual(built.problems, [], `.sb3 にできない: ${code}`)
  return packSb3(built)
}

/**
 * 記法 → .sb3 → 記法 と往復して、前後の識別子列を返す。
 */
async function roundTrip(code: string) {
  const project = await openSb3(await toSb3(code))
  const sprite = spriteOf<any>(project.targets)
  const back = toNotation(sprite.blocks)
  return {
    before: identifiersOf(await parseNotation(code)),
    after: identifiersOf(await parseNotation(back)),
    back,
  }
}

test("イディオム集から記法を取り出せる", () => {
  // 取り出しが 0 件だと、以下の検査は 1 件も走らないまま緑になる
  assert.ok(snippets.length > 0, "取り出せた記法が 0 件")
})

for (const snippet of snippets) {
  test(`往復してブロックの識別子列が一致する: ${snippet.name}`, async () => {
    const { before, after, back } = await roundTrip(snippet.code)
    assert.ok(before.length > 0, "元の記法にブロックが無い")
    assert.deepEqual(after, before, `戻した記法:\n${back}`)
  })
}

// 往復が成立しても Scratch が開けるとは限らない。知識層に載せた記法はすべて、
// 出荷経路と同じ検証器を通ることまで確かめる
for (const snippet of snippets) {
  test(`公式検証器を通る: ${snippet.name}`, async () => {
    const bytes = await toSb3(snippet.code)
    assert.deepEqual(await officialProblems(bytes, snippet.name), [])
  })
}

test("入れ子のブロックと C 型の中身も往復する", async () => {
  const { before, after, back } = await roundTrip(
    [
      "緑の旗が押されたとき",
      "ずっと",
      "  もし <[マウスのポインター v] に触れた> なら",
      "    ((1) から (10) までの乱数) 歩動かす",
      "  end",
      "end",
    ].join("\n"),
  )

  // 入れ子と中身が落ちれば列が短くなる。件数も直に見る
  // 帽子・ずっと・もし・触れた・歩動かす・乱数の 6 つ
  assert.equal(before.length, 6, `元の識別子列: ${before.join(", ")}`)
  assert.deepEqual(after, before, `戻した記法:\n${back}`)
})

/** 較正に使う記法。帽子・入れ子のレポーター・C 型・メニュー・変数を 1 つずつ含む */
const PROBE = [
  "緑の旗が押されたとき",
  "((1) から (10) までの乱数) 歩動かす",
  "もし <[マウスのポインター v] に触れた> なら",
  "  [スコア v] を (1) ずつ変える",
  "end",
].join("\n")

/**
 * opcode でブロックを 1 つ引く。
 */
function pick(blocks: Record<string, any>, opcode: string) {
  const found = Object.values(blocks).find(block => block.opcode === opcode)
  assert.ok(found, `${opcode} が .sb3 に無い`)
  return found
}

/**
 * 往復検査の感度。壊した .sb3 を記法へ戻して実測した結果を置く（2026-08-17）。
 *
 * 出方は 3 通りある。識別子列が動く・逆変換が例外で落ちる・何も起きない。前の 2 つは
 * 検査が捕まえる。「見ない」は安全網に数えないための記録で、代わりに何が見張るかを
 * `guarded` に書く。出方が変われば表が落ち、記録が古びたことが分かる。
 */
const SENSITIVITY: {
  name: string
  expect: string
  /** 往復が見ない壊し方を、代わりに何が見張っているか */
  guarded?: string
  mutate: (blocks: Record<string, any>) => void
}[] = [
  {
    name: "ブロックの繋がりを切る",
    expect: "列が動く",
    mutate: blocks => {
      pick(blocks, "event_whenflagclicked").next = null
    },
  },
  {
    name: "opcode を別のブロックにする",
    expect: "例外",
    mutate: blocks => {
      pick(blocks, "motion_movesteps").opcode = "motion_turnright"
    },
  },
  {
    // 影ブロックの欄名は逆変換が名前で引く。誤ると存在しない欄として落ちる
    name: "影ブロックの欄名を誤る",
    expect: "例外",
    mutate: blocks => {
      const menu = pick(blocks, "sensing_touchingobjectmenu")
      menu.fields = { WRONG_FIELD_NAME: menu.fields.TOUCHINGOBJECTMENU }
    },
  },
  {
    name: "入力の値を変える",
    expect: "見ない",
    guarded: "無し。値そのものを見張る検査は往復の外に置く",
    mutate: blocks => {
      pick(blocks, "operator_random").inputs.FROM = [1, [4, "999"]]
    },
  },
  {
    name: "引数を入れ替える",
    expect: "見ない",
    guarded: "記法の綴りから並び順を引き直す実装と、その単体検査",
    mutate: blocks => {
      const random = pick(blocks, "operator_random")
      const { FROM, TO } = random.inputs
      random.inputs = { FROM: TO, TO: FROM }
    },
  },
  {
    name: "ドロップダウンの内部値を日本語のラベルにする",
    expect: "見ない",
    guarded: "台帳が持つ選択肢の表と、その単体検査",
    mutate: blocks => {
      pick(blocks, "sensing_touchingobjectmenu").fields.TOUCHINGOBJECTMENU = [
        "マウスのポインター",
        null,
      ]
    },
  },
]

test("往復検査が何を捕まえ何を見ないかを測る", async () => {
  const bytes = await toSb3(PROBE)
  const before = identifiersOf(await parseNotation(PROBE))

  for (const item of SENSITIVITY) {
    // 壊す前の状態から毎回開き直す。壊し方どうしが混ざらないようにする
    const project = await openSb3(bytes)
    const sprite = spriteOf<any>(project.targets)
    item.mutate(sprite.blocks)

    let got
    let thrown = ""
    try {
      const after = identifiersOf(await parseNotation(toNotation(sprite.blocks)))
      got = JSON.stringify(after) === JSON.stringify(before) ? "見ない" : "列が動く"
    } catch (error) {
      // 例外そのものが観測の結果である。握りつぶさず、外れたときに理由を出す
      thrown = `: ${(error as Error).message}`
      got = "例外"
    }
    assert.equal(got, item.expect, `${item.name} の出方が記録と違う${thrown}`)
  }
})

test("往復は .sb3 のバイト列を経由する", async () => {
  const bytes = await toSb3("緑の旗が押されたとき\n(10) 歩動かす")
  assert.deepEqual([...bytes.subarray(0, 2)], [0x50, 0x4b], "zip を経ていない")

  const project = await openSb3(bytes)
  const sprite = spriteOf<any>(project.targets)
  assert.match(toNotation(sprite.blocks), /move \(10\) steps/)
})

/**
 * .sb3 のスプライトのブロックの表を壊して詰め直す。信頼できない入力を作る。
 */
async function breakSb3(bytes: Buffer, mutate: (blocks: Record<string, any>) => unknown): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes)
  const { project } = await projectJsonIn(zip)
  const sprite = spriteOf<any>(project.targets)
  mutate(sprite.blocks)
  zip.file("project.json", JSON.stringify(project))
  return zip.generateAsync({ type: "nodebuffer" })
}

test("上限を超える project.json を、原因を示して弾く", async () => {
  const bytes = await toSb3("(10) 歩動かす")
  // 上限の機構を測る。値そのものは別の検査で見る
  await assert.rejects(
    () => openSb3(bytes, { limit: 100 }),
    /project\.json が大きすぎる/,
  )
})

test("上限は自分たちの生成物ではなく Scratch の上限に合わせてある", async () => {
  const bytes = await toSb3("(10) 歩動かす")
  const size = Buffer.from(JSON.stringify(await openSb3(bytes))).length

  // Scratch は非圧縮の project.json を 5 MB まで許す。下回ると正当な作品を弾く
  assert.ok(PROJECT_JSON_LIMIT >= 5 * 1024 * 1024, "Scratch の上限を下回っている")
  // 生成物の倍率で置き直されたら落ちる。他者の作品を弾く線に戻る変更を捕まえる
  assert.ok(PROJECT_JSON_LIMIT > size * 100, "自分たちの生成物を基準にしている疑い")
})

// 循環を扱う 3 件には timeout を置く。ただし有限性を保証するのは実装側の辺の予算で
// あって、この timeout ではない（同期のループはイベントループを止めるため、
// runner の timeout では中断できない。2026-08-18 実測）。非同期の待ちが固まる
// 場合に備えた保険として残す
test("next が循環した .sb3 を、経路を示して弾く", { timeout: 20_000 }, async () => {
  const bytes = await breakSb3(await toSb3("(10) 歩動かす\n(10) 歩動かす"), blocks => {
    const ids = Object.keys(blocks).filter(id => !blocks[id].shadow)
    assert.ok(ids.length >= 2, "壊す前提が崩れている")
    blocks[ids[ids.length - 1]].next = ids[0]
  })

  await assert.rejects(() => openSb3(bytes), /参照が循環している/)
})

test("C 型の中身が外側へ戻る .sb3 を弾く", { timeout: 20_000 }, async () => {
  const code = ["ずっと", "  (10) 歩動かす", "end"].join("\n")
  const bytes = await breakSb3(await toSb3(code), blocks => {
    const outer = Object.keys(blocks).find(id => blocks[id].inputs?.SUBSTACK)
    assert.ok(outer, "C 型のブロックが見つからない")
    const inner = blocks[outer].inputs.SUBSTACK[1]
    blocks[inner].next = outer
  })

  await assert.rejects(() => openSb3(bytes), /参照が循環している/)
})

test("表に無い参照を指す .sb3 で、循環と読み違えず落ちもしない", async () => {
  for (const missing of ["存在しない ID", "toString"]) {
    const bytes = await breakSb3(await toSb3("(10) 歩動かす"), blocks => {
      for (const block of Object.values(blocks)) block.next = missing
    })

    // 表に無い参照は循環ではない。`toString` を混ぜるのは、参照の照合が
    // `Object.prototype` の名前を拾わないことを併せて見るため
    const project = await openSb3(bytes)
    assert.ok(project.targets.length > 0, `${missing} で正当な入力を弾いた`)
  }
})

test("ブロックの中身が壊れた .sb3 でも、例外でなく読み取りとして扱う", async () => {
  // 表に載っているのに中身が壊れている形。参照の照合（持ち物か）は通ってしまうため、
  // 辺を取る側が形を確かめないと `undefined.next` で落ちる
  for (const broken of [null, "文字列", 42, []]) {
    const bytes = await breakSb3(await toSb3("(10) 歩動かす"), blocks => {
      const id = idOfFirstReal(blocks)
      blocks[id].next = "壊れた先"
      blocks["壊れた先"] = broken
    })

    const project = await openSb3(bytes)
    assert.ok(project.targets.length > 0, `${JSON.stringify(broken)} で落ちた`)
  }
})

test("openSb3 を経ずに toNotation を呼んでも循環で止まる", { timeout: 20_000 }, async () => {
  // 入口のガードは契機だけを塞ぐ。表を別の経路で組み立てた呼び出し（zip を自分で
  // 開く・一部だけ差し替える）は openSb3 を通らないため、辿る側にも同じ目が要る
  const zip = await JSZip.loadAsync(await toSb3("(10) 歩動かす\n(10) 歩動かす"))
  const { project } = await projectJsonIn(zip)
  const sprite = spriteOf<any>(project.targets)

  const ids = Object.keys(sprite.blocks).filter(id => !sprite.blocks[id].shadow)
  sprite.blocks[ids[ids.length - 1]].next = ids[0]

  // ガードが無いとスタックを使い切って RangeError で落ちる（2026-08-18 実測）
  assert.throws(() => toNotation(sprite.blocks), /参照が循環している/)
})

test("並びの形のブロックの表でも、循環を弾く", async () => {
  // 容器が並びのとき、循環の検出が空振りした（CP6 で実測。旧は拒否、新は通した）。
  // 資源の上限は容器の形で変わってはいけない ── 通せば辿りが戻らない
  const 循環 = [
    { opcode: "control_repeat", next: "1", parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true },
    { opcode: "control_repeat", next: "0", parent: "0", inputs: {}, fields: {}, shadow: false, topLevel: false },
  ]
  const 作品 = {
    targets: [{
      isStage: true, name: "Stage", blocks: 循環,
      costumes: [], sounds: [], variables: {}, lists: {}, broadcasts: {},
    }],
    monitors: [], extensions: [], meta: { semver: "3.0.0" },
  }
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(作品))
  const bytes = await zip.generateAsync({ type: "nodebuffer" })

  await assert.rejects(() => openSb3(bytes), /参照が循環している/)
})

test("自分自身を指す next を弾く", { timeout: 20_000 }, async () => {
  const bytes = await breakSb3(await toSb3("(10) 歩動かす"), blocks => {
    const id = idOfFirstReal(blocks)
    blocks[id].next = id
  })

  await assert.rejects(() => openSb3(bytes), /参照が循環している/)
})

test("検証器が見る project.json と、読む側が読む project.json を食い違わせない", async () => {
  // 公式検証器は 1 段のディレクトリを許し、当たった先頭 1 件を読む。こちらが名前の
  // 完全一致で探していた頃は、両方を収めた zip で検証器が正当な方を通し、こちらは
  // でたらめな方を読んだ（2026-08-18 実測）。当たりが 1 件でなければ読まない
  const { source: good } = await projectJsonIn(
    await JSZip.loadAsync(await toSb3("(10) 歩動かす")),
  )

  for (const subFirst of [true, false]) {
    const zip = new JSZip()
    const entries = [
      ["sub/project.json", good],
      ["project.json", JSON.stringify({ でたらめ: true })],
    ]
    for (const [name, body] of subFirst ? entries : [...entries].reverse()) {
      zip.file(name, body)
    }
    const bytes = await zip.generateAsync({ type: "nodebuffer" })

    await assert.rejects(
      () => openSb3(bytes),
      /project\.json が 2 個ある/,
      `正当な sub を${subFirst ? "先" : "後"}に置いた zip を読んでしまう`,
    )
  }
})

test("1 段のディレクトリに入った project.json は検証器と同じく読む", async () => {
  const { source: good } = await projectJsonIn(
    await JSZip.loadAsync(await toSb3("(10) 歩動かす")),
  )

  const zip = new JSZip()
  zip.file("どこか/project.json", good)
  const project = await openSb3(await zip.generateAsync({ type: "nodebuffer" }))

  // 検証器が通す形をこちらが弾くと、検証を通った .sb3 が読めないことになる
  assert.ok(Array.isArray(project.targets), "検証器が読める形を弾いた")
})

test("上限として使えない値を黙って受け取らない", async () => {
  const bytes = await toSb3("(10) 歩動かす")

  // NaN との比較は常に false、Infinity は何も超えない。どちらも上限を黙って無効にする
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, null, "5000000"]) {
    await assert.rejects(
      // 型が禁じる値を渡して、実行時の見張りが効くことを測る。型で塞いだから実行時は
      // 要らない、とはならない ── 呼び手は型検査を通らない経路（JSON・引数）から来る
      () => openSb3(bytes, { limit: limit as number }),
      /上限の値が使えない/,
      `limit=${String(limit)} で上限が無効になった`,
    )
  }
})

test("表に壊れた中身が混ざったまま記法へ戻そうとしたら止める", async () => {
  const zip = await JSZip.loadAsync(await toSb3("(10) 歩動かす"))
  const { project } = await projectJsonIn(zip)
  const sprite = spriteOf<any>(project.targets)

  // 辺を取る側は壊れた値を読み飛ばすが、記法へ戻す側は block.topLevel を直に引く。
  // null では素の TypeError で落ちていた（2026-08-18 実測）
  for (const broken of [null, "文字列", 42, [], [99, "種別が範囲の外"], ["番号でない"]]) {
    const blocks = { ...sprite.blocks, 壊れた: broken }
    assert.throws(
      () => toNotation(blocks),
      /ブロックの中身が壊れている: 壊れた/,
      `${JSON.stringify(broken)} が素通りした`,
    )
  }

  // 対照。形の整った並び（単独で置かれた変数のレポーター）は壊れていない。Scratch が
  // 実際に書く形で、公式検証器も通す。ここで止めると正当な作品のターゲットが丸ごと
  // 落ちる（CP6 で実測）
  for (const fine of [[12, "スコア", "variable:スコア"], [10, "ことば"]]) {
    const blocks = { ...sprite.blocks, ゆるい: fine }
    // 既定の言語は英語である（往復検査が日本語の綴りの衝突を避けるため）
    assert.match(toNotation(blocks), /move \(10\) steps/, `${JSON.stringify(fine)} で止まった`)
  }

  assert.throws(() => toNotation(null as any), /ブロックの表になっていない/)
  assert.throws(() => toNotation([] as any), /ブロックの表になっていない/)
})
