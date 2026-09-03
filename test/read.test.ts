import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import JSZip from "jszip"
import { buildProject } from "../src/project.ts"
import { packSb3 } from "../src/sb3.ts"
import { CATALOG_KEYS } from "../src/catalog.ts"
import { PROCEDURE_OPCODES } from "../catalog/procedures.ts"
import { catalogOrStop, detailOf, ourSb3, spriteOf, stageOf } from "./fixtures.ts"
import {
  COVERAGE,
  catalogOpcodes,
  censusOf,
  coveragePartition,
  definitionOf,
  markedBlocks,
  readSb3,
  type Reading,
  reverseOpcodes,
  stemsFor,
  TARGET_LIMIT,
} from "../src/read.ts"

const require = createRequire(import.meta.url)



/**
 * どちらの表にも無い opcode。
 *
 * 実在の綴りを使うと、上流が覚えた版で「未知」でなくなり、検査が測る対象を静かに失う
 * （`pen_penDown` を未知のつもりで書いたら、逆変換器が「ペンを下ろす」と出して落ちた）。
 * 下の較正でこの前提を毎回確かめる。
 */
const UNKNOWN = "だれも知らない_opcode"

test("較正: 未知として使う綴りが、本当にどちらの表にも無い", () => {
  assert.ok(!catalogOpcodes(catalogOrStop().raw).has(UNKNOWN), "台帳が知っている")
  assert.ok(!reverseOpcodes().has(UNKNOWN), "逆変換器が知っている")
})

/**
 * ブロックの表 1 つを持つターゲットだけの .sb3 を組み立てる。
 */
async function sb3With(blocks: Record<string, any>, name: string = "ネコ"): Promise<Buffer> {
  const project = {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({ isStage: false, name, blocks }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  }
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(project))
  return zip.generateAsync({ type: "nodebuffer" })
}

/**
 * ターゲットの記法を、繋いだ 1 つの綴りとして見る。
 *
 * 読み取りはスクリプト単位で持つ（図がスクリプトごとに要る）。ここで繋ぐのは、記法の
 * 中身を見る検査にとって本数の区切りが主題でないためである。
 */
function notationOf(target: { scripts: string[] }): string {
  return target.scripts.join("\n\n")
}

/**
 * schema を通るターゲットを組み立てる。渡した欄だけを差し替える。
 *
 * 公式検証器は欄の欠けを弾く。最小のつもりで書いた表は `costumes` が無いだけで通らず、
 * 検査が「読めない」を測っているのか「形が足りない」を測っているのか分からなくなる
 * （2026-08-20 に実測）。実物と同じ形を既定にして、測りたい欄だけを渡す。
 */
function targetOf(fields: Record<string, any>): Record<string, any> {
  const costume = {
    assetId: "0".repeat(32),
    name: "costume1",
    md5ext: `${"0".repeat(32)}.svg`,
    dataFormat: "svg",
    rotationCenterX: 0,
    rotationCenterY: 0,
  }
  const base = {
    isStage: false,
    name: "ネコ",
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [costume],
    sounds: [],
    volume: 100,
  }
  // ステージは必ず最背面（0）で、スプライトはそれより前。検証器はここも見る
  const extra = fields.isStage
    ? { layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: "on", textToSpeechLanguage: null }
    : { layerOrder: 1, x: 0, y: 0, size: 100, direction: 90, draggable: false,
        rotationStyle: "all around", visible: true }
  return { ...base, ...extra, ...fields }
}

/** 文の位置に 1 件、未知の opcode を挟んだ表 */
function withUnknownStatement(opcode: string) {
  return {
    a: {
      opcode: "event_whenflagclicked",
      next: "b",
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
    b: { opcode, next: "c", parent: "a", inputs: {}, fields: {}, shadow: false, topLevel: false },
    c: {
      opcode: "motion_ifonedgebounce",
      next: null,
      parent: "b",
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  }
}

/** 値の枠に未知の opcode を置いた表 */
function withUnknownValue(opcode: string) {
  return {
    a: {
      opcode: "motion_movesteps",
      next: null,
      parent: null,
      inputs: { STEPS: [3, "r", [4, "10"]] },
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
    r: { opcode, next: null, parent: "a", inputs: {}, fields: {}, shadow: false, topLevel: false },
  }
}

test("自作の .sb3 を読むと、ターゲットごとの日本語記法が出る", async () => {
  const { targets, problems } = await readSb3(await ourSb3(), "測定")
  assert.deepEqual(problems, [])

  const names = targets.map(target => target.name)
  assert.deepEqual(names, ["Stage", "ネコ"], "ターゲットが揃っていない")

  const cat = spriteOf(targets)
  // 日本語で出ていること。英語のままなら綴りが違う
  assert.match(notationOf(cat), /歩動かす/)
  assert.match(notationOf(cat), /@greenFlag が押されたとき/)
  // 対照。英語の綴りが混じっていないか
  assert.doesNotMatch(notationOf(cat), /move \(/, "英語のまま出ている")
})

test("記法の字下げが 2 空白で出る", async () => {
  const { targets } = await readSb3(await ourSb3(), "測定")
  const cat = spriteOf(targets)

  const indents = notationOf(cat)
    .split("\n")
    .map(line => line.length - line.trimStart().length)
    .filter(width => width > 0)

  assert.ok(indents.length > 0, "字下げのある行が 1 つも無い。測る対象が無い")
  // 既定は 4 空白である。上流の README が書く鍵（tabs）を渡すと既定のまま出る
  assert.deepEqual(
    [...new Set(indents)].sort((a, b) => a - b),
    [2, 4],
    "2 空白ずつになっていない",
  )
})

test("逆変換器が知らない opcode を、文の位置で落とさず印として残す", async () => {
  const bytes = await sb3With(withUnknownStatement(UNKNOWN))
  const { targets, used, problems } = await readSb3(bytes, "測定")
  assert.deepEqual(problems, [])

  const cat = spriteOf(targets)
  // 印が該当の位置に残る。前後のブロックも消えていない
  assert.deepEqual(notationOf(cat).split("\n"), [
    "@greenFlag が押されたとき",
    `// 読み取れない: ${UNKNOWN}`,
    "もし端に着いたら、跳ね返る",
  ])

  // 件数の側にも出る。印だけだと、要約が何件と言えばよいか分からない
  const row = used.find(item => item.opcode === UNKNOWN)
  assert.equal(row?.count, 1)
  assert.equal(row?.coverage, COVERAGE.NEITHER)
})

test("逆変換器が知る拡張機能のブロックは、印でなく記法として出る", async () => {
  // 台帳が知らなくても逆変換器が知っていれば読める。この 79 件を印にしてしまうと、
  // 読めているものを「読み取れない」と申告することになる。ペンは台帳へ入れたので、
  // ここでは扱わない拡張機能を使う。引数を持たない積むブロックはこれだけである
  // （逆変換器が知る core 外の 79 件のうち、引数が無く値でもないもの）
  const bytes = await sb3With(withUnknownStatement("microbit_displayClear"))
  const { targets, used } = await readSb3(bytes, "測定")

  const cat = spriteOf(targets)
  assert.match(notationOf(cat), /画面を消す/)
  assert.doesNotMatch(notationOf(cat), /読み取れない/)
  assert.equal(
    used.find(item => item.opcode === "microbit_displayClear")?.coverage,
    COVERAGE.REVERSE_ONLY,
  )
})

test("台帳だけが知る opcode（sensing_online）が黙って消えない", async () => {
  // 台帳にあるのに逆変換器が知らない 1 件。読み取りで消えると、生成できるのに
  // 読めないブロックが黙って落ちることになる
  const known = catalogOpcodes(catalogOrStop().raw)
  assert.ok(known.has("sensing_online"), "測る前提が崩れている（台帳から消えた）")
  assert.ok(!reverseOpcodes().has("sensing_online"), "測る前提が崩れている（逆変換器が覚えた）")

  const bytes = await sb3With(withUnknownStatement("sensing_online"))
  const { targets, used, problems } = await readSb3(bytes, "測定")
  assert.deepEqual(problems, [])

  const cat = spriteOf(targets)
  assert.match(notationOf(cat), /\/\/ 読み取れない: sensing_online/)
  assert.equal(used.find(item => item.opcode === "sensing_online")?.coverage, COVERAGE.CATALOG_ONLY)
})

test("値の枠に居る未知の opcode で、例外にせず印を埋める", async () => {
  // 文の位置では黙って落ち、値の枠では投げる（2026-08-20 実測）。落ちるのと投げるのとで
  // 手当てが違うので、両方を見る
  const bytes = await sb3With(withUnknownValue("sensing_online"))
  const { targets, problems } = await readSb3(bytes, "測定")
  assert.deepEqual(problems, [], "値の枠の未知のブロックで読み取りごと落ちた")

  const cat = spriteOf(targets)
  // 行の途中なのでコメントにはしない。コメントは行末までを飲み、後ろのブロックが消える
  assert.equal(notationOf(cat), "(⟪読み取れない: sensing_online⟫::custom) 歩動かす")
})

test("記法をスクリプト単位で持つ", async () => {
  // 図はスクリプトごとに描く。繋いだ記法を空行で割り直すと、記法の中に空行が現れた
  // 途端に本数がずれる
  const bytes = await sb3With({
    a: {
      opcode: "event_whenflagclicked",
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
    b: {
      opcode: "motion_ifonedgebounce",
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 200,
    },
  })
  const { targets } = await readSb3(bytes, "測定")
  const cat = spriteOf(targets)

  assert.equal(cat.scripts.length, 2, "スクリプトの本数が合わない")
  assert.deepEqual(cat.scripts, ["@greenFlag が押されたとき", "もし端に着いたら、跳ね返る"])
  // ブロックが 1 つも無いターゲットは 0 本。1 本の空文字にしない
  assert.deepEqual(stageOf(targets).scripts, [])
})

test("4 区分の件数が、台帳と allBlocks の被覆と一致する", () => {
  const known = catalogOpcodes(catalogOrStop().raw)
  const reverse = reverseOpcodes()
  const { both, catalogOnly, reverseOnly } = coveragePartition(known)

  // 版が動いたことを捕まえる。数え方を数の隣に書く ──「台帳が知る」は主の opcode と
  // alsoCovers を合わせたもので、台帳自身が「覆わない範囲」へ挙げるものは含めない
  assert.equal(reverse.size, 207, "逆変換器の表の件数が動いた")
  // 区分が重ならず、取りこぼしも無い。件数を固定する前に置く ── 後に置くと、固定した
  // 数どうしの算術になって恒真になり、どんな状態でも落ちない
  assert.equal(both.length + catalogOnly.length, known.size)
  assert.equal(both.length + reverseOnly.length, reverse.size)

  // ブロック定義を通して 3 件増えた。3 件とも逆変換器の表にも在るので、増分はすべて
  // 「双方が知る」へ入る。件数だけでは入れ替わり（1 件が抜けて別の 1 件が入る）が
  // 差し引き 0 で通るため、顔ぶれを名指しで見る
  for (const opcode of PROCEDURE_OPCODES) {
    assert.ok(both.includes(opcode), `${opcode} が双方の知る側に無い`)
  }

  assert.equal(known.size, 132, "台帳が知る opcode の件数が動いた")
  assert.equal(both.length, 131, "双方が知る件数が動いた")
  assert.equal(catalogOnly.length, 1, "台帳だけが知る件数が動いた")
  assert.equal(reverseOnly.length, 76, "逆変換器だけが知る件数が動いた")
  assert.deepEqual(catalogOnly, ["sensing_online"])
})

test("台帳が知る opcode に、台帳が「覆わない」と申告したものを混ぜない", () => {
  const raw = catalogOrStop().raw
  const known = catalogOpcodes(raw)
  const declared = raw[CATALOG_KEYS.SCOPE]["台帳から到達しない opcode"]

  assert.ok(declared.length > 0, "申告が空。測る対象が無い")
  const wrong = declared
    .map(item => item.opcode)
    .filter(opcode => opcode !== undefined && known.has(opcode))
  assert.deepEqual(wrong, [], "覆わないと申告した opcode を、知っている側に数えている")
})

test("影ブロックを、読めなかった側に数えない", async () => {
  // 逆変換器は影の opcode を一度も見ない。影の欄を親の行へ直に描くので、opcode が
  // 2 つの表のどちらにも無くても何も落ちていない（2026-08-20 実測）
  const { used } = await readSb3(await ourSb3(), "測定")
  const menus = used.filter(item => item.opcode.endsWith("_menu"))

  assert.ok(menus.length > 0, "メニューの影が 1 件も無い。測る対象が無い")
  for (const menu of menus) {
    assert.equal(menu.coverage, COVERAGE.SHADOW, `${menu.opcode} を落ちた側に数えている`)
  }
})

test("集計の件数の総和が、作品のブロック数と合う", async () => {
  const bytes = await sb3With(withUnknownStatement(UNKNOWN))
  const { used } = await readSb3(bytes, "測定")

  // 総和が合わないと、読み手は「残りはどこへ行ったのか」を追えない
  const counted = used.reduce((sum, item) => sum + item.count, 0)
  assert.equal(counted, 3, "数えた件数が作品のブロック数と合わない")
})

test("読み取りの誤りが、例外でなく申告として読める", async () => {
  // 下には投げる部品と返す部品が混ざっている。読む側から見た口を 1 通りに揃える
  const { targets, problems } = await readSb3(Buffer.from("zip ではない"), "こわれた.sb3")

  assert.deepEqual(targets, [])
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "読み取れない .sb3")
  assert.equal(problems[0].subject, "こわれた.sb3")
  assert.ok(detailOf(problems[0]), "理由が空")
})

test("形の壊れたターゲットを持つ .sb3 を、原因を示して断る", async () => {
  // 読み取りは公式検証器を通してから読む。Scratch 自身が開けないものを、こちらだけが
  // 読めたことにしない。断る理由は検証器の言葉で示す
  const project = {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({ isStage: false, name: "こわれた", blocks: null }),
    ],
    meta: { semver: "3.0.0" },
  }
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(project))
  const { targets, problems } = await readSb3(
    await zip.generateAsync({ type: "nodebuffer" }),
    "測定",
  )

  assert.deepEqual(targets, [], "形が壊れたまま読み進めた")
  assert.equal(problems[0]?.kind, "公式検証器が弾いた")
  assert.match(String(problems[0]?.detail), /blocks/, "どの欄が悪いかを示していない")
})

test("形が通らない .sb3 では、ブロックを 1 つも読まない", async () => {
  // `targets` が配列ですらない .sb3 が「ターゲット 0 件」で成功していた
  // （2026-08-20 実測）。0 件の成功と、読めなかったことを見分けられるようにする
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify({ targets: "配列ですらない", meta: { semver: "3.0.0" } }))
  const { targets, used, problems } = await readSb3(
    await zip.generateAsync({ type: "nodebuffer" }),
    "測定",
  )

  assert.deepEqual(targets, [])
  assert.deepEqual(used, [], "読めていないのに集計だけ出した")
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "公式検証器が弾いた")
})

test("集計は逆変換に渡す前の作品を数える", async () => {
  // 渡した後で数えると、逆変換器が落としたものと、こちらが印へ差し替えたものが
  // 数から消える。差し替えを掛けない作品を直に数えた結果と突き合わせる
  const blocks = withUnknownStatement(UNKNOWN)
  const { used } = await readSb3(await sb3With(blocks), "測定")

  const direct = censusOf(
    { targets: [targetOf({ isStage: true, name: "Stage", blocks: {} }), { blocks }] },
    catalogOpcodes(catalogOrStop().raw),
  )
  assert.deepEqual(used, direct, "読み取りが数えた結果が、素の作品を数えた結果と違う")
  assert.ok(
    used.some(item => item.opcode === UNKNOWN),
    "逆変換が落とす opcode が集計から消えている",
  )
})

test("容器が並びの形でも、中和の守りが掛かる", () => {
  // 崩し方の表に「容器そのものが並び」が無く、`typeof x === "object"`（並びを通す）を
  // 並びを除く判定へ寄せたときに守りが外れた（CP6 で実測。旧は印へ置換、新は生の
  // 制御文字が残った）。.sb3 の欄は細工すれば並びで書けるので、容器の形で守りが
  // 変わってはいけない
  const 生 = String.fromCharCode(10)
  const 素 = {
    opcode: "motion_movesteps",
    next: null,
    parent: null,
    shadow: false,
    topLevel: true,
  }

  /** 出てきた綴りを全部集める。容器の形が変わっても同じ物差しで測るため */
  const 綴りたち = (value: unknown): string[] => {
    if (typeof value === "string") return [value]
    if (Array.isArray(value)) return value.flatMap(綴りたち)
    if (value && typeof value === "object") return Object.values(value).flatMap(綴りたち)
    return []
  }

  for (const [名, block] of [
    ["fields が対応", { ...素, fields: { VALUE: [`あ${生}い`, null] } }],
    ["fields が並び", { ...素, fields: [[`あ${生}い`, null]] }],
    ["inputs が対応", { ...素, inputs: { X: [1, [10, `あ${生}い`]] } }],
    ["inputs が並び", { ...素, inputs: [[1, [10, `あ${生}い`]]] }],
  ] as [string, Record<string, unknown>][]) {
    const 綴り = 綴りたち(markedBlocks({ a: block }).a)
    assert.equal(綴り.filter(t => t.includes(生)).length, 0, `${名}: 生の制御文字が残った`)
    assert.equal(綴り.filter(t => t.includes("U+000A")).length, 1, `${名}: 印へ置き換わっていない`)
  }
})

test("元の表を書き換えずに印を付ける", () => {
  // 読み取りは 1 つの作品を集計・記法・（後の段階で）復元に使い回す。差し替えが元の表へ
  // 及ぶと、後から数え直した集計に印が混じる
  const blocks = withUnknownStatement(UNKNOWN)
  const before = JSON.stringify(blocks)

  const out = markedBlocks(blocks)
  // 較正。差し替えが起きていなければ、下の照合は何もしない実装でも緑になる
  assert.equal((out.b as any).opcode, "procedures_call", "差し替えが起きていない")

  assert.equal(JSON.stringify(blocks), before, "呼び出し元の表を書き換えた")
  assert.equal(blocks.b.opcode, UNKNOWN, "元のブロックの opcode が変わった")
})

test("大文字小文字だけが違う名前を、同じファイルへ書かない", () => {
  // Windows（NTFS）と macOS の既定 FS は大文字小文字を区別しない。文字列の一致で
  // 数えると、別の綴りとして配ってしまい片方が消える（CP6 でこの機械に実測）
  assert.deepEqual(stemsFor(["Cat", "cat"]), ["Cat", "cat-2"])
  assert.deepEqual(stemsFor(["ネコ", "ネコ"]), ["ネコ", "ネコ-2"])

  // 合成済みと分解済みも macOS では同じ名前になる
  const composed = "ガ"
  const decomposed = "ガ"
  assert.notEqual(composed, decomposed, "測る前提が崩れている（同じ綴りになった）")
  const stems = stemsFor([composed, decomposed])
  assert.equal(new Set(stems.map(name => name.normalize("NFC"))).size, 2, "畳むと重なる")
})

test("ブロックの ID が __proto__ でも消えない", async () => {
  // `JSON.parse` は持ち物として作るが、素の `{}` への添字代入では持ち物にならない。
  // 集計は差し替えの前に数えるので、消えたぶんを数え続けていた（CP6 で実測）
  // 対応の literal では書けない。`__proto__:` は原型を差し替える綴りであり、
  // 持ち物にならない。JSON の文から解析すると持ち物として作られる
  const blocks = JSON.parse(
    '{"__proto__":{"opcode":"motion_ifonedgebounce","next":null,"parent":null,' +
      '"inputs":{},"fields":{},"shadow":false,"topLevel":true,"x":0,"y":0}}',
  )
  assert.deepEqual(Object.keys(blocks), ["__proto__"], "測る前提が崩れている")

  const marked = markedBlocks(blocks)
  assert.deepEqual(Object.keys(marked), ["__proto__"], "写しで消えた")
})

test("変数の名前が __proto__ でも定義から消えない", async () => {
  // 宣言の写しも同じ形の穴を持っていた
  const project = JSON.parse(
    '{"targets":[{"isStage":true,"name":"Stage","blocks":{},' +
      '"variables":{"v":["__proto__",7],"w":["ふつう",1]},"lists":{},"broadcasts":{},' +
      '"comments":{},"currentCostume":0,"costumes":[{"assetId":"00000000000000000000000000000000",' +
      '"name":"c","md5ext":"00000000000000000000000000000000.svg","dataFormat":"svg",' +
      '"rotationCenterX":0,"rotationCenterY":0}],"sounds":[],"volume":100,' +
      '"layerOrder":0,"tempo":60,"videoTransparency":50,"videoState":"on",' +
      '"textToSpeechLanguage":null}],"meta":{"semver":"3.0.0"}}',
  )
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(project))
  const { targets } = await readSb3(await zip.generateAsync({ type: "nodebuffer" }), "測定")

  const stage = stageOf(targets)
  assert.deepEqual(Object.keys(stage.variables), ["__proto__", "ふつう"], "写しで消えた")
  assert.equal(stage.variables.__proto__, 7, "値が取れない")
})

test("影を名乗る未知の opcode を、文の位置なら印にする", async () => {
  // 影は「値の枠に置かれた」ことで影であって、旗が立っているから影ではない。
  // 旗だけを見ていたとき、文の並びに置かれた影が差し替えを免れて黙って消えた
  const bytes = await sb3With({
    a: {
      opcode: "event_whenflagclicked",
      next: "u",
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
    u: { opcode: UNKNOWN, next: "c", parent: "a", inputs: {}, fields: {}, shadow: true, topLevel: false },
    c: {
      opcode: "motion_ifonedgebounce",
      next: null,
      parent: "u",
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  })
  const { targets, used } = await readSb3(bytes, "測定")
  const cat = spriteOf(targets)

  assert.match(notationOf(cat), new RegExp(`// 読み取れない: ${UNKNOWN}`), "印が出ていない")
  // 集計も「影として親の行に出る」と言わない。親の行になど出ていない
  assert.equal(used.find(item => item.opcode === UNKNOWN)?.coverage, COVERAGE.NEITHER)
})

test("未知のブロックの中身を、記法から落とさない", async () => {
  // 差し替えで `inputs` を空にしていたため、中の読めるブロックがまとめて消えていた
  // （CP6 で実測。ブロック 5 件の作品が 2 行になった）
  const bytes = await sb3With({
    a: {
      opcode: "event_whenflagclicked",
      next: "u",
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
    u: {
      opcode: UNKNOWN,
      next: null,
      parent: "a",
      inputs: { SUBSTACK: [2, "s1"], NUM: [3, "r", [4, "10"]] },
      fields: {},
      shadow: false,
      topLevel: false,
    },
    s1: {
      opcode: "motion_movesteps",
      next: "s2",
      parent: "u",
      inputs: { STEPS: [1, [4, "7"]] },
      fields: {},
      shadow: false,
      topLevel: false,
    },
    s2: {
      opcode: "motion_ifonedgebounce",
      next: null,
      parent: "s1",
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: false,
    },
    r: {
      opcode: "sensing_mousex",
      next: null,
      parent: "u",
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  })
  const { targets } = await readSb3(bytes, "測定")
  const text = notationOf(spriteOf(targets))

  // 値の中身は印の行内に残る
  assert.match(text, /マウスのx座標/, "値の中身が消えた")
  // 文の中身は別のスクリプトとして残る。位置は失うが、消えるよりは残る
  assert.match(text, /\(7\) 歩動かす/, "文の中身が消えた")
  assert.match(text, /もし端に着いたら、跳ね返る/, "文の中身が消えた")
})

test("単独で置かれた値を持つ作品で、ターゲットが丸ごと落ちない", async () => {
  // Scratch は単独で置かれた変数のレポーターを並びで書く。生成の向きでは現れないので
  // 「壊れた中身」として投げており、子どもが変数を画面へ置くだけで踏んでいた
  const bytes = await sb3With({
    loose: [12, "スコア", "variable:スコア"],
    real: {
      opcode: "motion_ifonedgebounce",
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
  })
  const { targets, used, problems } = await readSb3(bytes, "測定")

  assert.deepEqual(problems, [], "正当な作品を弾いた")
  const cat = spriteOf(targets)
  assert.match(notationOf(cat), /もし端に着いたら、跳ね返る/, "読めるスクリプトまで消えた")

  // 「どちらも知らない」に混ぜない。読めなかったものと見分けが付かなくなる。
  // 綴りを印の括弧で囲むのは、丸括弧のままだと同じ綴りの opcode を持つ .sb3 が
  // この言葉を名乗れるためである（2026-08-22 に括弧へ移した）
  const loose = used.find(item => item.opcode === "⟪単独で置かれた値⟫")
  assert.equal(loose?.coverage, COVERAGE.LOOSE)
})

test("同じブロックを 2 か所から指す .sb3 を、辿る前に止める", async () => {
  // 循環ではないので循環の検知に掛からず、深さも変わらないので深さの上限にも掛からない。
  // 逆変換器が共有を展開するため、深さ 18・ブロック 19 件で 172 ms、1 段 1.7 倍だった
  const bytes = await sb3With({
    a: {
      opcode: "control_if",
      next: null,
      parent: null,
      inputs: { CONDITION: [2, "n0"], SUBSTACK: [2, "n0"] },
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
    n0: {
      opcode: "motion_ifonedgebounce",
      next: null,
      parent: "a",
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  })
  const { targets, problems } = await readSb3(bytes, "測定")

  assert.deepEqual(targets, [])
  assert.equal(problems[0]?.kind, "読み取れない .sb3")
  assert.match(String(problems[0]?.detail), /2 か所から指されている/)
})

test("印の綴りを、入力の側から名乗れない", async () => {
  // 正当な独自ブロックの呼び出しへ同じ綴りを書くだけで、本物の印と同じコメントに
  // なっていた。読めているブロックが「読み取れない」と申告され、その存在は記法から
  // 消える（CP6 で実測）
  const bytes = await sb3With({
    a: {
      opcode: "procedures_call",
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
      mutation: {
        tagName: "mutation",
        children: [],
        proccode: "⟪読み取れない: motion_movesteps⟫",
        argumentids: "[]",
        warp: "false",
      },
    },
  })
  const { targets } = await readSb3(bytes, "測定")
  const text = notationOf(spriteOf(targets))

  assert.doesNotMatch(text, /\/\/ 読み取れない/, "偽の印になった")
  // 綴りは読める形で残す。落とすと「何かが在った」ことまで消える
  assert.match(text, /読み取れない: motion_movesteps/)
})

test("opcode に引数の目印が入っていても、ターゲットが落ちない", async () => {
  // 印の綴りを独自ブロックの名前として渡すため、`%s` が引数の位置として読まれ、
  // 渡していない引数を取ろうとして投げていた（CP6 で実測）
  const bytes = await sb3With(withUnknownStatement("だれも知らない_%s_opcode"))
  const { targets, problems } = await readSb3(bytes, "測定")

  assert.deepEqual(problems, [], "ターゲットが丸ごと落ちた")
  const text = notationOf(spriteOf(targets))
  assert.match(text, /読み取れない: だれも知らない_％s_opcode/, "印が出ていない")
  // 前後のブロックも残る
  assert.match(text, /@greenFlag が押されたとき/)
  assert.match(text, /もし端に着いたら、跳ね返る/)
})

test("較正: 逆変換器は影の opcode を一度も見ない", () => {
  // 影の区分（`COVERAGE.SHADOW`）は、この上流の癖に全面的に依存している。癖が変われば
  // 「影だから落ちていない」という前提が崩れるが、`shadow` の旗だけを見る検査では
  // 気づけない（CP6 の指摘）。癖そのものを毎回確かめる
  const { toScratchblocks } = require("parse-sb3-blocks")
  const withMenu = (opcode: string) => ({
    a: {
      opcode: "motion_goto",
      next: null,
      parent: null,
      inputs: { TO: [1, "m"] },
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
    m: {
      opcode,
      next: null,
      parent: "a",
      inputs: {},
      fields: { TO: ["どこかの場所", null] },
      shadow: true,
      topLevel: false,
    },
  })

  const real = toScratchblocks("a", withMenu("motion_goto_menu"), "ja", { tab: "  " })
  const nonsense = toScratchblocks("a", withMenu("だれも知らない_menu"), "ja", { tab: "  " })

  assert.equal(nonsense, real, "影の opcode が読まれるようになった。区分の前提が崩れている")
  assert.match(real, /どこかの場所/, "影の欄が親の行に出ていない")
})

/**
 * 検証器は弾くが、読めば読める .sb3 を組み立てる。
 *
 * コスチュームを 0 件にする。schema は 1 件以上を求めるので必ず弾かれ、一方でブロックの
 * 表には触らないので読み取りは無傷である（2026-08-20 実測。24 通りのうち検証器が弾いた
 * 11 通りの中で、完全に読めたのは 7 通りあった）。
 *
 * 読めない入力で逃げ道を測ると、通らなかった理由が「旗が効いていない」のか「そもそも
 * 読めない」のか分からなくなる。
 *
 * `extra` を立てるとエントリを 1 件増やす
 */
async function refusedButReadable({ extra = false }: { extra?: boolean } = {}): Promise<Buffer> {
  const project = {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({
        isStage: false,
        name: "ネコ",
        costumes: [],
        blocks: withUnknownStatement(UNKNOWN),
      }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  }
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(project))
  // エントリ数の上限を測る検査だけが使う。1 件では上限 1 を超えられない
  if (extra) zip.file("おまけ.txt", "エントリ数を増やすためだけに置く")
  return zip.generateAsync({ type: "nodebuffer" })
}

test("較正: 逃げ道の入力は、検証器が弾くが読める形である", async () => {
  const bytes = await refusedButReadable()
  const strict = await readSb3(bytes, "測定")
  assert.equal(strict.problems[0]?.kind, "公式検証器が弾いた", "検証器が通してしまった")

  const loose = await readSb3(bytes, "測定", { anyway: true })
  assert.equal(loose.targets.length, 2, "旗を立てても読めない入力では逃げ道を測れない")
})

test("旗が無ければ、検証器が弾いた作品は 1 件も読まない", async () => {
  // 逃げ道を足したことで既定が緩んでいないかは、緩めた側の検査では測れない
  const { targets, used, refused, problems } = await readSb3(await refusedButReadable(), "測定")

  assert.deepEqual(targets, [], "旗が無いのに読み進めた")
  assert.deepEqual(used, [], "読んでいないのに集計を出した")
  assert.deepEqual(refused, [], "旗が無いときに逃げ道の断りを立てた")
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "公式検証器が弾いた")
})

test("旗を立てると、検証器が弾いた作品も読めるところまで読む", async () => {
  const { targets, used, problems } = await readSb3(await refusedButReadable(), "測定", {
    anyway: true,
  })

  assert.equal(targets.length, 2, "読めるはずのターゲットが落ちた")
  assert.ok(notationOf(targets[1]).length > 0, "記法が空")
  assert.ok(used.length > 0, "集計が空")
  // 弾いた理由は消さない。飛ばすのでなく、止める理由から申告へ降ろしている
  assert.ok(
    problems.some(problem => problem.kind === "公式検証器が弾いた"),
    "弾いた理由を黙って捨てた",
  )
})

test("旗を立てても、読み取れる形をしていない .sb3 は止まる", async () => {
  // 床。検証器を止める理由から降ろした代わりに、読み取りが要求する形は自分で確かめる。
  // これを外すと `targets` が配列でない .sb3 が「ターゲット 0 件」の成功へ戻る
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify({ targets: "配列ですらない", meta: { semver: "3.0.0" } }))
  const bytes = await zip.generateAsync({ type: "nodebuffer" })
  const { targets, used, problems } = await readSb3(bytes, "測定", { anyway: true })

  assert.deepEqual(targets, [])
  assert.deepEqual(used, [], "読めていないのに集計だけ出した")
  assert.ok(
    problems.some(problem => problem.kind === "読み取れる形をしていない"),
    "床が働いていない",
  )
})

test("量の上限は、旗の有無に依らず掛かる", async () => {
  // 逃げ道が資源の防御まで外していないかは、通常の入力では測れない。受け入れ検査は
  // 検証器より前（`openSb3` の中）で走るので、旗は届かないはずである。
  //
  // 超える上限にはエントリ数を選ぶ。大きさの上限は展開の側（`readWithin`）でも掛かる
  // ので、受け入れ検査を外しても同じ顔で落ち、外したことが見えない。エントリ数を
  // 数えるのは受け入れ検査だけである
  const bytes = await refusedButReadable({ extra: true })
  const strict = await readSb3(bytes, "測定", { entries: 1 })
  const loose = await readSb3(bytes, "測定", { entries: 1, anyway: true })

  // 落ちたことでなく落ちた理由を見る。`読み取れない .sb3` は多くの原因が同じ顔で出る
  for (const [label, reading] of [["旗なし", strict], ["旗あり", loose]] as const) {
    assert.equal(reading.problems[0]?.kind, "読み取れない .sb3", label)
    assert.match(String(reading.problems[0]?.detail), /エントリ/, `${label}: 別の理由で落ちた`)
    assert.deepEqual(reading.targets, [], `${label}: 上限を超えたのに読み進めた`)
  }
})

test("旗を立てたとき、読めないターゲットだけを落として残りは読む", async () => {
  // 検証器が弾いた 24 通りのうち、ターゲット単位でしか読めない形が 2 通りあった
  // （`blocks` の欠けと、ターゲットが `null`）。丸ごと捨てず、読めた分は残す
  const project = {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({ isStage: false, name: "ネコ", blocks: withUnknownStatement(UNKNOWN) }),
      targetOf({ isStage: false, name: "こわれた", layerOrder: 2, blocks: null }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  }
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(project))
  const bytes = await zip.generateAsync({ type: "nodebuffer" })

  const strict = await readSb3(bytes, "測定")
  assert.deepEqual(strict.targets, [], "旗が無いのに読み進めた")

  const { targets, problems } = await readSb3(bytes, "測定", { anyway: true })
  assert.deepEqual(
    targets.map(target => target.name),
    ["Stage", "ネコ"],
    "読めるターゲットまで落とした",
  )
  assert.ok(
    problems.some(problem => problem.kind === "ターゲットのブロックの表が無い"),
    "落としたターゲットを黙って捨てた",
  )
})

test("旗を立てても、読める形をしていない宣言の値は落として申告する", async () => {
  // 床は「読めるか」だけで引いていた。schema は値がスカラーであることも守っており、
  // 引き継がないと深い入れ子が定義の検査まで届いてスタックを使い切る（CP6 で実測）
  const deep = "[".repeat(20000) + '"x"' + "]".repeat(20000)
  const zip = new JSZip()
  zip.file(
    "project.json",
    `{"targets":[{"isStage":true,"name":"Stage","blocks":{},` +
      `"variables":{"v":["ふかい",${deep}],"w":["まとも",7]},` +
      `"lists":{"l":["なかみ",[1,${deep}]]}}],"monitors":[],"extensions":[],"meta":{}}`,
  )
  const bytes = await zip.generateAsync({ type: "nodebuffer" })
  const { targets, problems } = await readSb3(bytes, "測定", { anyway: true })

  assert.equal(targets.length, 1, "ターゲットごと落とした")
  assert.deepEqual(Object.keys(targets[0].variables), ["まとも"], "読める宣言まで落とした")
  assert.deepEqual(Object.keys(targets[0].lists), [], "中身が読めないリストを残した")
  const dropped = problems.find(problem => problem.kind === "宣言の値が読める形をしていない")
  assert.ok(dropped, "落としたことを黙った")
  assert.match(String(dropped.detail), /2 件/, "落とした件数を言っていない")
})

test("旗を立てても、ターゲットが多すぎる .sb3 は止まる", async () => {
  // 旗は schema の必須項目を外すので、同じ 5 MB に収まるターゲット数が 18 倍になる
  // （438 → 24 バイト。2026-08-20 実測）。書き出すファイル数が青天井になる
  const targets = Array.from({ length: TARGET_LIMIT + 1 }, () => ({ name: "同じ", blocks: {} }))
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify({ targets, monitors: [], extensions: [], meta: {} }))
  const bytes = await zip.generateAsync({ type: "nodebuffer" })
  const { targets: read, used, problems } = await readSb3(bytes, "測定", { anyway: true })

  assert.deepEqual(read, [], "上限を超えたのに読み進めた")
  assert.deepEqual(used, [], "読めていないのに集計を出した")
  const over = problems.find(problem => problem.kind === "ターゲットが多すぎる")
  assert.ok(over, "上限が働いていない")
  assert.match(String(over.detail), new RegExp(`${TARGET_LIMIT}`), "線の値を言っていない")
})

test("床が sb2 を見分けて、手当てを添える", async () => {
  // sb2 は公式検証器を通りうるので、床が唯一の砦になる（CP6 の指摘）
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify({ objName: "Stage", children: [], info: {} }))
  const bytes = await zip.generateAsync({ type: "nodebuffer" })
  const { problems } = await readSb3(bytes, "測定", { anyway: true })

  const floor = problems.find(problem => problem.kind === "読み取れる形をしていない")
  assert.ok(floor, "床が働いていない")
  assert.match(String(floor.detail), /Scratch 2/, "正体を名乗っていない")
  assert.match(String(floor.detail), /保存し直す/, "手当てを示していない")
})

test("記法へ戻せないターゲットを、落として申告する", async () => {
  // この受け口には検査が 1 件も無かった（CP6 の指摘）。手で組んだ申告を要約へ流す検査は
  // あったが、**受け口そのものへ届く検査**が無く、届かなくなっても緑のまま通った。
  //
  // 表に `null` が混ざると、辺を取る側は読み飛ばすのに記法へ戻す側は直に引いて落ちる。
  // ターゲットの表そのものが無い場合は手前の砦が拾うので、ここへは届かない
  const bytes = await sb3With({
    こわれ: null,
    まとも: {
      opcode: "motion_ifonedgebounce",
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
    },
  })
  const { targets, problems, dropped } = await readSb3(bytes, "測定", { anyway: true })

  // 実害を先に置く。落としたことが伝わらないまま「読めた」と言うのが害である
  assert.deepEqual(
    dropped.map(item => item.reason),
    ["記法へ戻せない"],
    `落としたターゲットの記録が合わない: ${JSON.stringify(dropped)}`,
  )
  assert.ok(
    problems.some(problem => problem.kind === "記法へ戻せない"),
    `受け口へ届いていない: ${JSON.stringify(problems.map(p => p.kind))}`,
  )
  // 落としたターゲットは記法を持たない。持っていたら、落としていない
  assert.ok(
    !targets.some(target => target.name === "ネコ"),
    "落としたはずのターゲットが読めている",
  )
})

test("対照: まともな表なら、記法へ戻せないとは言わない", async () => {
  // 上の検査が「常に申告する」実装でも緑にならないようにする
  const bytes = await sb3With({
    まとも: {
      opcode: "motion_ifonedgebounce",
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
    },
  })
  const { problems, dropped } = await readSb3(bytes, "測定", { anyway: true })
  assert.deepEqual(dropped, [], "まともな作品からターゲットを落とした")
  assert.deepEqual(
    problems.filter(problem => problem.kind === "記法へ戻せない"),
    [],
    "まともな作品で受け口が発火した",
  )
})

test("同じ名前の宣言を捨てたら、捨てた件数を申告する", async () => {
  // Scratch は作らないが細工した .sb3 では作れる。黙って捨てると、要約が数えた宣言の数と
  // 作品定義に並ぶ数が食い違い、その差の理由がどこにも残らない（CP6 の指摘）
  const project = {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({
        isStage: false,
        name: "ネコ",
        blocks: {},
        variables: { a: ["スコア", 0], b: ["スコア", 1] },
      }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  }
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(project))
  const bytes = await zip.generateAsync({ type: "nodebuffer" })
  const { targets, problems } = await readSb3(bytes, "測定", { anyway: true })

  // 実害を先に置く。数の食い違いが説明できることが要る
  const cat = spriteOf(targets)
  assert.equal(Object.keys(cat?.variables ?? {}).length, 1, "重なった宣言を両方残した")
  assert.ok(
    problems.some(problem => problem.kind === "同じ名前の宣言が 2 つある"),
    `捨てたのに黙っている: ${JSON.stringify(problems.map(p => p.kind))}`,
  )
  const 申告 = problems.find(problem => problem.kind === "同じ名前の宣言が 2 つある")
  assert.match(申告?.detail ?? "", /1 件を捨てた/, "捨てた件数を言わない")
  assert.match(申告?.detail ?? "", /スコア/, "捨てた名前を言わない")
})

test("形を崩した入力からも、印を名乗れない", async () => {
  // 守りが `Array.isArray` で見て、逆変換器が添字で読むと、対応（`{ 0: "…" }`）が守りだけ
  // を素通りする。作品の側から `⟪読み取れない: …⟫` を名乗れた（2026-08-22 実測。CP6 の
  // 攻撃者視点が 3 経路で成立を示した）
  const 偽の印 = "⟪読み取れない: motion_movesteps⟫"
  const 崩し方 = {
    "入力が対応": { MESSAGE: { 1: [10, 偽の印] } },
    "入力の中身が並び": { MESSAGE: [1, [10, [偽の印]]] },
    "入力が文字列": { MESSAGE: 偽の印 },
  }

  for (const [label, inputs] of Object.entries(崩し方)) {
    const blocks = {
      say: {
        opcode: "looks_say", next: null, parent: null,
        inputs, fields: {}, shadow: false, topLevel: true,
      },
    }
    const bytes = await sb3With(blocks)
    const { targets } = await readSb3(bytes, "測定", { anyway: true })
    const 記法 = (targets.find(t => !t.isStage)?.scripts ?? []).join("\n")

    // 実害を先に置く。作品の側が「こちらの言葉」を名乗れないこと
    assert.ok(
      !記法.includes(偽の印),
      `${label}: 作品が印を名乗った: ${JSON.stringify(記法)}`,
    )
  }
})

test("形を崩しても、欄の名前が読めるままである", async () => {
  // 対照。守りを足したせいで読めていたものが落ちる形は取らない ── 添字を捨てて詰めると
  // `{ 1: … }` が 0 番へ動き、逆変換器が読めなくなる
  const blocks = {
    say: {
      opcode: "looks_say", next: null, parent: null,
      inputs: { MESSAGE: { 0: 1, 1: [10, "こんにちは"] } },
      fields: {}, shadow: false, topLevel: true,
    },
  }
  const bytes = await sb3With(blocks)
  const { targets } = await readSb3(bytes, "測定", { anyway: true })
  const 記法 = (targets.find(t => !t.isStage)?.scripts ?? []).join("\n")
  const 訳 = `対応の形の入力を読めなくした: ${JSON.stringify(記法)}`
  assert.match(記法, /こんにちは/, 訳)
})

test("名前が文字列でない宣言を落としたら、そう申告する", async () => {
  // 同じ関数の他の 2 経路（読めない値・重なった名前）は申告するのに、ここだけ黙って
  // 落としていた。要約が数えた宣言の数と作品定義に並ぶ数が食い違い、その差の理由が
  // どこにも残らない（CP6 の指摘）
  const project = {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({
        isStage: false,
        name: "ネコ",
        blocks: {},
        variables: { a: [42, 0], b: ["スコア", 1] },
      }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  }
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(project))
  const bytes = await zip.generateAsync({ type: "nodebuffer" })
  const 読み = await readSb3(bytes, "測定", { anyway: true })
  const { targets, problems, droppedValues } = 読み

  // 実害を先に置く。数の食い違いが説明できることが要る
  const cat = spriteOf(targets)
  assert.equal(Object.keys(cat?.variables ?? {}).length, 1, "名前でない宣言を残した")
  const 申告 = problems.find(problem => problem.kind === "宣言の名前が文字列でない")
  assert.ok(
    申告,
    `落としたのに黙っている: ${JSON.stringify(problems.map(p => p.kind))}`,
  )
  assert.match(申告?.detail ?? "", /1 件を落とした/, "落とした件数を言わない")
  assert.match(申告?.detail ?? "", /number/, "落とした名前の形を言わない")
  assert.equal(droppedValues.length, 1, "成果物の断りが数える側に入っていない")

  // 値そのものは載せない。名前でないものを名前の位置へ出すと、作品の中から探せる綴りだと
  // 読み手が誤解する
  assert.doesNotMatch(申告?.detail ?? "", /42/, "名前でない値をそのまま載せた")
})

test("対照: 名前が重ならなければ、捨てたとは言わない", async () => {
  const project = {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({
        isStage: false,
        name: "ネコ",
        blocks: {},
        variables: { a: ["スコア", 0], b: ["残り", 1] },
      }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  }
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(project))
  const bytes = await zip.generateAsync({ type: "nodebuffer" })
  const { targets, problems } = await readSb3(bytes, "測定", { anyway: true })

  assert.equal(Object.keys(targets.find(t => !t.isStage)?.variables ?? {}).length, 2)
  assert.deepEqual(
    problems.filter(problem => problem.kind === "同じ名前の宣言が 2 つある"),
    [],
    "重なっていないのに捨てたと言った",
  )
})

test("制御文字を含む名前でも、記法と作品定義が同じ綴りを指す", async () => {
  // 逆変換器は名前から改行とタブを黙って落とす。落としたままだと記法は `スア` を名乗り、
  // 作品定義は改行入りの名前を宣言する。綴りが割れた .sb3 は `build` へ戻すと
  // 「変数が宣言されていない」で止まる（2026-08-22 実測）
  const 名前 = `ス${String.fromCharCode(10)}ア`
  const project = {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({
        isStage: false,
        name: "ネコ",
        variables: { id1: [名前, 0] },
        blocks: {
          b: {
            opcode: "data_setvariableto",
            next: null,
            parent: null,
            inputs: { VALUE: [1, [10, "1"]] },
            fields: { VARIABLE: [名前, "id1"] },
            shadow: false,
            topLevel: true,
          },
        },
      }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  }
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(project))
  const bytes = await zip.generateAsync({ type: "nodebuffer" })
  const { targets } = await readSb3(bytes, "測定", { anyway: true })

  const cat = spriteOf(targets)
  const 宣言 = Object.keys(cat?.variables ?? {})[0] ?? "(宣言なし)"
  const 記法 = (cat?.scripts ?? [])[0] ?? "(記法なし)"
  const 綴り = 記法.match(/^\[(.*) v\]/)?.[1] ?? "(取れず)"
  // 記法は `>` を逃がして書く。`build` は逃がしを解いてから名前を引く
  const 解いた = 綴り.replaceAll(String.fromCharCode(92), "")

  // 実害を先に置く。2 つが同じ名前を指さないと、書き出したものを `build` へ戻せない
  assert.equal(解いた, 宣言, `記法と作品定義で綴りが割れた: 記法=${JSON.stringify(綴り)}`)
  assert.ok(
    !宣言.includes(String.fromCharCode(10)),
    "宣言に生の改行が残った。逆変換器が落とす文字なので、記法とは揃わない",
  )
})

test("値にも印を掛ける。落とすと往復で中身が変わる", async () => {
  // 以前は名前にだけ掛けていた。値は記法にしか現れず揃える相手が居ないためだが、その
  // ぶん逆変換器が値から改行を落とし、この台詞は `[1 行目2 行目] と言う` になっていた。
  // 書き出したものを `build` へ戻すと元の .sb3 と中身が変わる（TASK0016 で実測）。
  //
  // 印へ変えれば落ちず、戻す側が符号位置へ復せる。往復が中身を保つかは
  // `value-spelling.test.ts` が入口を通して測る。ここは読む側の 1 段だけを見る
  const 台詞 = `1 行目${String.fromCharCode(10)}2 行目`
  const bytes = await sb3With({
    b: {
      opcode: "looks_say",
      next: null,
      parent: null,
      inputs: { MESSAGE: [1, [10, 台詞]] },
      fields: {},
      shadow: false,
      topLevel: true,
    },
  })
  const { targets } = await readSb3(bytes, "測定", { anyway: true })
  const 記法 = ((targets.find(t => !t.isStage)?.scripts ?? [])[0] ?? "")

  // 実害を先に置く。改行が落ちると台詞が 1 行に潰れ、往復で中身が変わる
  assert.ok(
    !記法.includes("1 行目2 行目"),
    `値から改行が落ちた: ${JSON.stringify(記法)}`,
  )
  assert.ok(
    記法.includes(`${String.fromCodePoint(0x27ea)}U+000A${String.fromCodePoint(0x27eb)}`),
    `値が印へ変わっていない: ${JSON.stringify(記法)}`,
  )
})

test("印の綴りが記法の言語に従う", async () => {
  // 印は記法の内側に入る綴りである。英語の記法へ日本語のコメントが混ざると、旗の宣言
  // （記法の言語を選ぶ）と実装が食い違う（2026-08-22 実測・裁定）
  const bytes = await sb3With(withUnknownStatement(UNKNOWN))

  const 日本語 = await readSb3(bytes, "測定", { locale: "ja" })
  const 英語 = await readSb3(bytes, "測定", { locale: "en" })
  const 記法 = (reading: Reading) => notationOf(spriteOf(reading.targets))

  // 実害を先に置く。選んだ言語の記法へ、別の言語の綴りが混ざらないこと
  assert.doesNotMatch(記法(英語), /読み取れない/, "英語の記法へ日本語の印が混ざった")
  assert.match(記法(日本語), /読み取れない/, "日本語の記法から印が消えた")

  // 印は消えず、位置も保つ。言語を変えたら落ちる、では中身を失う
  const 行数 = (text: string) => text.split("\n").length
  assert.equal(行数(記法(英語)), 行数(記法(日本語)), "行数が変わった")
  assert.match(記法(英語), new RegExp(`// [^:]+: ${UNKNOWN}`), "英語の記法に印が無い")
})

test("画面を再描画しない指定が、読み取りで作品の定義へ戻る", async () => {
  // 記法はこの指定を表せない。読み取りが作品定義の側へ移さないと、往復で黙って消える
  // （消えても .sb3 は成立するので、遅くなったことでしか気づけない）
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-warp-"))
  writeFileSync(
    join(dir, "project.yaml"),
    [
      "名前: ためし",
      "スプライト:",
      "  - 名前: ネコ",
      "    スクリプト: neko.sbk",
      "    再描画しないブロック:",
      "      - しかくをかく (へん)",
    ].join("\n"),
  )
  writeFileSync(
    join(dir, "neko.sbk"),
    [
      "定義 しかくをかく (へん)",
      "(へん) 歩動かす",
      "",
      "定義 まつ",
      "(1) 秒待つ",
      "",
      "緑の旗が押されたとき",
      "しかくをかく (120)",
    ].join("\n"),
  )

  const { project, assets, problems: built } = await buildProject(dir)
  assert.deepEqual(built, [], "入力を組み立てられない")

  const reading = await readSb3(await packSb3({ project, assets }), "測定")
  assert.deepEqual(reading.problems, [])

  const restored = definitionOf(reading, "ためし") as {
    スプライト: { 再描画しないブロック?: string[] }[]
  }
  const [neko] = restored.スプライト

  // 挙げたものだけが戻る。全部を挙げる実装でも緑にならないよう、挙げていない `まつ` が
  // 混ざっていないことまで見る
  assert.deepEqual(neko.再描画しないブロック, ["しかくをかく (引数1)"])

  // 内部の綴りでは戻さない。`%s` は Scratch の画面にも記法にも現れないので、書き戻された
  // 定義を利用者が読んでも記法と結び付けられない
  assert.doesNotMatch(JSON.stringify(restored), /%s/)

  // 戻した綴りを組み立て側へ入れ直すところまで見る。読み取りが出す形と組み立てが
  // 受ける形は別々に書いてあるので、片方だけ変えると往復が黙って開く
  writeFileSync(
    join(dir, "project.yaml"),
    [
      "名前: ためし",
      "スプライト:",
      "  - 名前: ネコ",
      "    スクリプト: neko.sbk",
      "    再描画しないブロック:",
      `      - ${neko.再描画しないブロック[0]}`,
    ].join("\n"),
  )
  const again = await buildProject(dir)
  assert.deepEqual(again.problems, [], "読み取りが出した綴りを組み立てが受けない")
  const blocks: Record<string, { mutation?: { proccode?: string, warp?: string } }> =
    again.project.targets[1].blocks
  const warps = Object.values(blocks)
    .filter(block => block.mutation?.proccode === "しかくをかく %s")
    .map(block => block.mutation?.warp)
  assert.deepEqual(warps, ["true", "true"], "入れ直した綴りで指定が効いていない")
})

test("再描画しないブロックの綴りが、記法と同じ守りを通る", async () => {
  // 他人の .sb3 から来た綴りを作品定義へ書く経路である。記法の側は `spelled` を
  // 通っているので、こちらだけ素通しにすると、同じ 1 回の読み取りが書く 2 つの
  // 成果物で守りが割れる（CP6 で実測。生の U+202E が project.yaml へ出た）
  const nasty = `わな${String.fromCharCode(0x202e)}${String.fromCharCode(0x200b)}`
  const blocks = {
    d: {
      opcode: "procedures_definition", next: null, parent: null,
      inputs: { custom_block: [1, "p"] }, fields: {}, shadow: false, topLevel: true, x: 0, y: 0,
    },
    p: {
      opcode: "procedures_prototype", next: null, parent: "d", inputs: {}, fields: {},
      shadow: true, topLevel: false,
      mutation: {
        tagName: "mutation", children: [], proccode: nasty,
        argumentids: "[]", argumentnames: "[]", argumentdefaults: "[]", warp: "true",
      },
    },
  }
  const reading = await readSb3(await sb3With(blocks), "測定")
  assert.deepEqual(reading.problems, [])

  const restored = definitionOf(reading, "ためし") as {
    スプライト: { 再描画しないブロック?: string[] }[]
  }
  const [got] = restored.スプライト[0].再描画しないブロック ?? []
  assert.ok(got !== undefined, "再描画しないブロックが書き出されていない")

  // 実害を最初に見る。生の制御文字が 1 文字でも残ると、作品定義を grep や
  // git diff で読めなくなる
  assert.deepEqual(
    [...got].filter(c => c.codePointAt(0)! < 32 || /\p{Cf}/u.test(c)),
    [],
    `生の制御文字が残っている: ${JSON.stringify(got)}`,
  )
  // 印になっていることまで見る。落としてしまうと制御文字は消えるが往復も閉じない
  assert.match(got, /⟪U\+202E⟫/, `印になっていない: ${JSON.stringify(got)}`)
})
