import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import JSZip from "jszip"
import { parse as parseYaml } from "yaml"
import { parseNotation } from "../src/parse.ts"
import { SPRITE_KEYS } from "../src/definition.ts"
import {
  PLACEMENT_KEYS,
  definitionOf,
  type Reading,
  readSb3,
  stemsFor,
  summaryOf,
} from "../src/read.ts"
import { ESCAPES, placeAll } from "../src/cli.ts"
import { identifiersOf } from "../src/roundtrip.ts"
import { ourSb3, ourSb3File, projectJsonIn } from "./fixtures.ts"

/**
 * 出力の検査へ渡す読み取り結果。欄は測る分だけ書き、残りは空で埋める。
 *
 * 出力の器は結果の全欄を受け取るが、1 つの検査が測るのはそのうち 1〜2 欄である。
 * 検査ごとに全欄を書くと、欄が増えたとき検査の側が一斉に古びるうえ、どの欄を測って
 * いるのかが埋め草に紛れる。
 */
function readingOf(measured: Partial<Reading>): Reading {
  return {
    targets: [],
    used: [],
    unrestored: [],
    dropped: [],
    droppedValues: [],
    problems: [],
    refused: [],
    ...measured,
  }
}

const run = promisify(execFile)
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const work = mkdtempSync(join(tmpdir(), "gen-scratch-read-"))
const ROOT = fileURLToPath(new URL("../", import.meta.url))

/**
 * .sb3 を、ターゲットごとの識別子列にする。
 *
 * 往復の前後を比べる単位である。ブロック ID・座標・素材は保存されないので、比較の
 * 対象から外す（`概要設計` の裁定）。
 */
async function identifiersIn(bytes: Buffer): Promise<string[][]> {
  const { targets, problems } = await readSb3(bytes, "測定")
  assert.deepEqual(problems, [], "比べる前に読めていない")
  const rows = []
  for (const target of targets) {
    for (const script of target.scripts) {
      rows.push([target.name, ...identifiersOf(await parseNotation(script))])
    }
  }
  return rows
}

/** 逆変換器も台帳も知らない opcode。前提は `read.test.ts` の較正が見張る */
const UNKNOWN = "だれも知らない_opcode"

/**
 * 検査用の .sb3 を書き出す。
 *
 * `project` はproject.json の中身
 * 戻りは書き出したパス
 */
async function sb3File(name: string, project: any): Promise<string> {
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify(project))
  const path = join(work, name)
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }))
  return path
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

/** 文の位置と値の枠の双方に、読めない opcode を置いた表 */
const AWKWARD = {
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
  b: { opcode: UNKNOWN, next: "c", parent: "a", inputs: {}, fields: {}, shadow: false, topLevel: false },
  c: {
    opcode: "motion_movesteps",
    next: null,
    parent: "b",
    inputs: { STEPS: [3, "r", [4, "10"]] },
    fields: {},
    shadow: false,
    topLevel: false,
  },
  r: {
    opcode: "sensing_online",
    next: null,
    parent: "c",
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: false,
  },
}

/** 1 つのターゲットに 3 本のスクリプトを置いた表 */
const THREE = Object.fromEntries(
  [0, 1, 2].map(i => [
    `s${i}`,
    {
      opcode: "motion_ifonedgebounce",
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: i * 200,
    },
  ]),
)

test("スクリプトごとに図が出る。件数がスクリプト数と一致する", async () => {
  // 1 ターゲット 1 スクリプトの作品で測ると、ターゲットごとに 1 枚描く実装でも同じ数に
  // なる。本数の違うターゲットを混ぜて、スクリプトの側に付いていることを見る
  const input = await sb3File("figures.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {}, variables: {}, lists: {}, broadcasts: {} }),
      targetOf({ isStage: false, name: "みつご", blocks: THREE, variables: {}, lists: {}, broadcasts: {} }),
      targetOf({ isStage: false, name: "ひとつ", blocks: AWKWARD, variables: {}, lists: {}, broadcasts: {} }),
    ],
    meta: { semver: "3.0.0" },
  })
  const out = join(work, "figures")
  await run(process.execPath, [CLI, "read", input, "--out", out])

  const reading = await readSb3(readFileSync(input), "測定")
  const scripts = reading.targets.reduce((sum, target) => sum + target.scripts.length, 0)
  assert.equal(scripts, 4, "測る前提が崩れている（スクリプトの本数）")
  assert.notEqual(scripts, reading.targets.length, "本数とターゲット数が同じでは測れない")

  const figures = readdirSync(out).filter(name => name.endsWith(".svg"))
  assert.equal(figures.length, scripts, "図の件数がスクリプトの本数と合わない")

  // 図が空でないことも見る。件数だけだと、寸法 0 の図を並べても緑になる
  for (const name of figures) {
    const svg = readFileSync(join(out, name), "utf8")
    assert.match(svg, /^<svg/, `${name} が SVG になっていない`)
    const size = /^<svg[^>]*\swidth="([\d.]+)"\s+height="([\d.]+)"/.exec(svg)
    assert.ok(size, `${name} の寸法を読めない`)
    assert.ok(Number(size[1]) > 20 && Number(size[2]) > 20, `${name} の寸法が潰れている`)
  }
})

test("ターゲットごとに記法のファイルが出る", async () => {
  const out = join(work, "notation")
  await run(process.execPath, [CLI, "read", await ourSb3File(), "--out", out])

  const reading = await readSb3(await ourSb3(), "測定")
  for (const target of reading.targets) {
    const path = join(out, `${target.stem}.sbk`)
    const text = readFileSync(path, "utf8")
    for (const script of target.scripts) {
      assert.ok(text.includes(script), `${target.stem}.sbk にスクリプトが入っていない`)
    }
  }
})

test("要約の件数が、実装が数えた値と一致する", async () => {
  const path = await sb3File("counted.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {}, variables: { v: ["スコア", 0] }, lists: {}, broadcasts: { b: "はじめ" } }),
      targetOf({ isStage: false, name: "ネコ", blocks: AWKWARD, variables: {}, lists: { l: ["記録", []] }, broadcasts: {} }),
    ],
    meta: { semver: "3.0.0" },
  })

  const reading = await readSb3(readFileSync(path), path)
  const summary = summaryOf(reading, path)

  /**
   * 要約の表から数を引く。散文へ引き写した数は、実装が動いても直らない
   */
  const shown = (label: string) => {
    const hit = new RegExp(`^\\| ${label} \\| (\\d+) \\|$`, "m").exec(summary)
    assert.ok(hit, `要約に「${label}」の行が無い`)
    return Number(hit[1])
  }

  assert.equal(shown("ターゲット"), reading.targets.length)
  assert.equal(
    shown("スクリプト"),
    reading.targets.reduce((sum, target) => sum + target.scripts.length, 0),
  )
  assert.equal(
    shown("ブロック"),
    reading.used.reduce((sum, item) => sum + item.count, 0),
  )

  // 宣言の件数も見出しへ出る。0 件の種類も見出しごと落とさない
  assert.match(summary, /^## 変数（1 件）$/m)
  assert.match(summary, /^## リスト（1 件）$/m)
  assert.match(summary, /^## メッセージ（1 件）$/m)

  // 使ったブロックの行数が、集計の行数と一致する。opcode はコード表記で囲まない
  // （囲むと markdown の逃がしが効かず、逆引用符で抜けられる）
  const rows = [...summary.matchAll(/^\| [^|]+ \| \d+ \| (?:双方|逆変換器|台帳|どちらも|影|単独).+ \|$/gm)]
  assert.equal(rows.length, reading.used.length, "使ったブロックの行数が集計と合わない")
})

test("ファイル名にできない名前を持つターゲットで、対応表が出る", async () => {
  const path = await sb3File("awkward.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {}, variables: {}, lists: {}, broadcasts: {} }),
      targetOf({ isStage: false, name: "こま/切れ:名", blocks: AWKWARD, variables: {}, lists: {}, broadcasts: {} }),
      targetOf({ isStage: false, name: "こま:切れ/名", blocks: {}, variables: {}, lists: {}, broadcasts: {} }),
    ],
    meta: { semver: "3.0.0" },
  })

  const out = join(work, "awkward")
  await run(process.execPath, [CLI, "read", path, "--out", out])
  const summary = readFileSync(join(out, "summary.md"), "utf8")

  // 落とした結果が重なるので、番号で分ける。黙って上書きすると片方が消える。
  // 升には実ファイルの名前を出す。幹だけだと字面が実ファイルと一致せず辿れない
  assert.match(summary, /\| こま\/切れ:名 \| `こま_切れ_名\.sbk`/)
  assert.match(summary, /\| こま:切れ\/名 \| `こま_切れ_名-2\.sbk`/)

  const written = readdirSync(out)
  assert.ok(written.includes("こま_切れ_名.sbk"), "1 つ目の記法が無い")
  assert.ok(written.includes("こま_切れ_名-2.sbk"), "2 つ目の記法が上書きされた")
})

test("名前に縦棒が入っていても、要約の表が割れない", async () => {
  // markdown の表は縦棒で升を割る。名前に縦棒を入れると、逃がしていなければ 1 行の升が
  // 増え、表そのものが読めなくなる
  const path = await sb3File("pipe.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({ isStage: false, name: "ネ|コ" }),
    ],
    meta: { semver: "3.0.0" },
  })
  const reading = await readSb3(readFileSync(path), "測定")
  const summary = summaryOf(reading, "測定")

  const row = /^\| (ネ.*?コ) \| `.*?` \| \d+ \|$/m.exec(summary)
  assert.ok(row, "ターゲットの行が見つからない。表が割れている")
  assert.equal(row[1], String.raw`ネ\|コ`, "縦棒を逃がしていない")
})

test("採番した綴りが別の名前と重なっても、上書きしない", () => {
  // 逃がした先に、その綴りを持つ別のターゲットが居ることがある。基の名前だけを数えると
  // 逃がした先で 2 度目の衝突が起き、記法と図が黙って消える（2026-08-20 に実際に消えた）
  assert.deepEqual(stemsFor(["A/B", "A:B", "A_B-2"]), ["A_B", "A_B-2", "A_B-2-2"])
  assert.deepEqual(stemsFor(["x", "x-2", "x"]), ["x", "x-2", "x-3"])
  assert.deepEqual(stemsFor(["ネコ", "ネコ", "ネコ-2"]), ["ネコ", "ネコ-2", "ネコ-2-2"])

  // 何を渡しても重ならない。件数で見ておくと、上の 3 例に無い並びでも捕まる
  for (const names of [["a", "a", "a", "a-2", "a-3"], ["-2", "-2", "_-2"], ["", "", "_"]]) {
    const stems = stemsFor(names)
    assert.equal(new Set(stems).size, names.length, `重なった: ${JSON.stringify(stems)}`)
  }
})

test("採番が重なる .sb3 で、記法も図も消えない", async () => {
  const script = (n: number) => ({
    [`b${n}`]: {
      opcode: "motion_movesteps",
      next: null,
      parent: null,
      inputs: { STEPS: [1, [4, String(n)]] },
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
  })
  const path = await sb3File("stems.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage" }),
      targetOf({ name: "A/B", blocks: script(1) }),
      targetOf({ name: "A:B", blocks: script(2) }),
      targetOf({ name: "A_B-2", blocks: script(3) }),
    ],
    meta: { semver: "3.0.0" },
  })

  const out = join(work, "stems")
  const done = await run(process.execPath, [CLI, "read", path, "--out", out])

  // 3 本のスクリプトが 3 つの別々のファイルへ出る。1 つでも消えたら記法が失われている
  const notation = readdirSync(out).filter(name => name.endsWith(".sbk"))
  const bodies = notation.map(name => readFileSync(join(out, name), "utf8").trim())
  for (const n of [1, 2, 3]) {
    assert.ok(bodies.includes(`(${n}) 歩動かす`), `${n} 本目の記法が消えた`)
  }

  // 報告する図の件数が、実際に置かれた枚数と一致する
  const figures = readdirSync(out).filter(name => name.endsWith(".svg"))
  assert.match(done.stdout, new RegExp(`図 ${figures.length} 件`))
  assert.equal(figures.length, 3)
})

test("--locale en を渡すと、記法が英語で出る", async () => {
  const out = join(work, "english")
  await run(process.execPath, [CLI, "read", await ourSb3File(), "--out", out, "--locale", "en"])

  const notation = readFileSync(join(out, "ネコ.sbk"), "utf8")
  assert.match(notation, /steps/, "英語で出ていない")
  assert.doesNotMatch(notation, /歩動かす/, "日本語のまま出ている")
})

test("--locale に知らない言語を渡すと、終了コード 1 で止まる", async () => {
  const done = await run(process.execPath, [CLI, "read", await ourSb3File(), "--locale", "fr"]).catch(e => e)
  assert.equal(done.code, 1)
  assert.match(String(done.stderr), /--locale は ja か en を指定する/)
})

test("落とす規則が、置けない文字と予約語と空を塞ぐ", () => {
  // 許される側を数える規則にしてある。禁じる側を数えると、機械ごとに違う禁止文字を
  // 書き手が先回りできない
  assert.deepEqual(stemsFor(["a/b", "a\\b", "a:b"]), ["a_b", "a_b-2", "a_b-3"])
  assert.deepEqual(stemsFor(["<>?*|"]), ["_____"])
  assert.deepEqual(stemsFor([""]), ["_"])
  // Windows が装置の名として予約している綴りは、字だけでできているので許可を通る
  assert.deepEqual(stemsFor(["CON", "nul", "com1"]), ["_CON", "_nul", "_com1"])
  // 0 番も予約されている。1〜9 だけを見ていて取りこぼしていた（CP6 の指摘）
  assert.deepEqual(stemsFor(["COM0", "lpt0"]), ["_COM0", "_lpt0"])
  // 対照。置ける名前はそのまま通す
  assert.deepEqual(stemsFor(["ネコ", "Stage", "a-b_c1"]), ["ネコ", "Stage", "a-b_c1"])
})

test("印の付いた記法も図になる", async () => {
  const path = await sb3File("marked.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({ isStage: false, name: "ネコ", blocks: AWKWARD }),
    ],
    meta: { semver: "3.0.0" },
  })

  const out = join(work, "marked")
  await run(process.execPath, [CLI, "read", path, "--out", out])

  const notation = readFileSync(join(out, "ネコ.sbk"), "utf8")
  assert.match(notation, /\/\/ 読み取れない: だれも知らない_opcode/)
  assert.match(notation, /⟪読み取れない: sensing_online⟫/)

  // 印が図にも出る。記法にだけ出て図から消えると、図で読む側には落ちたことが見えない
  const svg = readFileSync(join(out, "ネコ-1.svg"), "utf8")
  assert.match(svg, /読み取れない/)
  assert.match(svg, /sensing_online/)

  const summary = readFileSync(join(out, "summary.md"), "utf8")
  assert.match(summary, /^## 記法に印を残したブロック（2 種）$/m)
})

test("要約が、名前に混ぜた制御文字をそのまま載せない", async () => {
  // 他者の .sb3 は名前に何でも入れられる。要約は人が開いて読むので、画面を消す列や
  // 表示順を覆す文字がそのまま届くと、要約そのものを偽装できる
  const path = await sb3File("nasty.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({
        isStage: false,
        name: `ネコ${String.fromCodePoint(0x1b)}[2J`,
        variables: { v: [`ス${String.fromCodePoint(0x202e)}コア`, 0] },
      }),
    ],
    meta: { semver: "3.0.0" },
  })

  const reading = await readSb3(readFileSync(path), "測定")
  const summary = summaryOf(reading, "測定")

  assert.ok(!summary.includes(String.fromCodePoint(0x1b)), "エスケープがそのまま出た")

  assert.ok(!summary.includes(String.fromCodePoint(0x202e)), "表示順を覆す文字がそのまま出た")

  // 名前は記法・作品定義・要約へ同じ綴りで載る。印の括弧を使うのは記法の都合だが、
  // 3 つで同じ名前に見えることを優先して綴りを分けない（TASK0016 の裁定）
  assert.match(summary, new RegExp(`${SENTINEL_OPEN}U\\+001B${SENTINEL_CLOSE}`, "u"))
  assert.match(summary, new RegExp(`${SENTINEL_OPEN}U\\+202E${SENTINEL_CLOSE}`, "u"))
})

test("壊れた .sb3 を、原因を示して終了コード 1 で止める", async () => {
  const notZip = join(work, "notzip.sb3")
  const out = join(work, "notzip-out")
  writeFileSync(notZip, "これは zip ではない")

  const done = await run(process.execPath, [CLI, "read", notZip, "--out", out]).catch(e => e)
  assert.equal(done.code, 1)
  assert.match(String(done.stderr), /読み取れない \.sb3/)

  // 読めなかったときに出力先を作らない。空のディレクトリが残ると、読めたのか
  // 読めなかったのかが後から見分けられない
  assert.throws(() => readdirSync(out), /ENOENT/, "読めなかったのに出力先を作った")
})

test("復元した定義から再生成した .sb3 が、識別子列として元と一致する", async () => {
  // ブロック ID・座標・素材は往復で保存されない。判定の単位を識別子列に固定する
  const out = join(work, "roundtrip")
  await run(process.execPath, [CLI, "read", await ourSb3File(), "--out", out])

  const again = join(work, "again.sb3")
  const built = await run(process.execPath, [CLI, "build", out, "--out", again])
  assert.match(built.stdout, /ターゲット 2 件/, "組み立てが通っていない")

  const before = await identifiersIn(await ourSb3())
  const after = await identifiersIn(readFileSync(again))

  assert.ok(before.length > 0, "元の .sb3 に識別子が 1 つも無い。測る対象が無い")
  assert.deepEqual(after, before, "往復で識別子列が変わった")
})

test("復元した定義が `build` を通らない入力で、理由を申告して定義を書かない", async () => {
  // ステージの変数 `ネコ/スコア` と、スプライト `ネコ` の変数 `スコア` は同じ ID を
  // 名乗る。組み立てはこれを止めるので、通らない定義を書き出さない
  const path = await sb3File("collide.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", variables: { v: ["ネコ/スコア", 0] } }),
      targetOf({ isStage: false, name: "ネコ", variables: { w: ["スコア", 0] } }),
    ],
    meta: { semver: "3.0.0" },
  })

  const out = join(work, "collide")
  const done = await run(process.execPath, [CLI, "read", path, "--out", out]).catch(e => e)

  assert.equal(done.code, 1, "通らない定義を書いたのに成功で終わった")
  assert.match(String(done.stderr), /別の宣言が同じ ID になる/)

  const written = readdirSync(out)
  assert.ok(!written.includes("project.yaml"), "組み立てを通らない定義を書き出した")
  // 読めた側は書き出す。定義が作れないことは、記法や要約を捨てる理由にならない
  assert.ok(written.includes("summary.md"), "読めた側まで捨てた")
  assert.ok(written.includes("ネコ.sbk"), "読めた側まで捨てた")
})

test("復元した定義が、既定と同じ値を書かない", async () => {
  const path = await sb3File("placed.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage" }),
      targetOf({ isStage: false, name: "きほん" }),
      targetOf({ isStage: false, name: "ずらし", x: 42, size: 150, visible: false }),
    ],
    meta: { semver: "3.0.0" },
  })

  const reading = await readSb3(readFileSync(path), "測定")
  const definition = definitionOf(reading, "測定")

  // 既定のままのスプライトは名前だけ。書いても意味は変わらないが、読み手が
  // 「なぜこの値なのか」を問うことになる
  assert.deepEqual((definition.スプライト as any[])[0], { 名前: "きほん" })
  assert.deepEqual((definition.スプライト as any[])[1], { 名前: "ずらし", x: 42, 表示: false, 大きさ: 150 })
})

test("復元した定義が、変数とリストの初期値を持ち帰る", async () => {
  const path = await sb3File("values.sb3", {
    targets: [
      targetOf({
        isStage: true,
        name: "Stage",
        variables: { v: ["スコア", 12] },
        lists: { l: ["記録", ["あ", 2, true]] },
      }),
    ],
    meta: { semver: "3.0.0" },
  })

  const reading = await readSb3(readFileSync(path), "測定")
  const definition = definitionOf(reading, "測定")

  assert.deepEqual((definition.ステージ as any).変数, { スコア: 12 })
  assert.deepEqual((definition.ステージ as any).リスト, { 記録: ["あ", 2, true] })
})

test("入力の名前が置き場を決めない", async () => {
  // `...sb3` は `basename` が `..` を返すので、既定の置き場が作業ディレクトリになり、
  // 根にある同名のファイルを上書きしていた（CP6 で実測）。攻撃者はファイル名を選べる
  const nasty = join(work, "...sb3")
  writeFileSync(nasty, await ourSb3())

  // 作業ディレクトリを一時の場所へ移して走らせる。根を汚さずに既定の振る舞いを見る
  const cwd = mkdtempSync(join(tmpdir(), "gen-scratch-cwd-"))
  await run(process.execPath, [CLI, "read", nasty], { cwd })

  const here = readdirSync(cwd)
  assert.deepEqual(here, ["out"], `作業ディレクトリへ直に書いた: ${JSON.stringify(here)}`)
  // 置ける綴りへ落として、その下へ書く
  assert.deepEqual(readdirSync(join(cwd, "out")), ["__"])
})

test("書き出し先に前回の成果物が残っていると、止めて何も触らない", async () => {
  // 黙って重ねると、前回の .sbk と図が残って要約の対応表に無いファイルが並ぶ。
  // どちらが今の読み取りの結果かを読み手が見分けられない（CP6 で 8 観点が指摘）
  const out = join(work, "occupied")
  mkdirSync(out, { recursive: true })
  const stray = join(out, "前回.sbk")
  writeFileSync(stray, "前回の成果物")

  const done = await run(process.execPath, [
    CLI,
    "read",
    await ourSb3File(),
    "--out",
    out,
  ]).catch(e => e)

  assert.equal(done.code, 1, "空でない書き出し先へ重ねた")
  assert.match(String(done.stderr), /書き出し先に前回の成果物が残っている/)
  assert.match(String(done.stderr), /別の置き場を指すか/, "直し方を示していない")
  assert.deepEqual(readdirSync(out), ["前回.sbk"], "止めたのに書き出し先へ書いた")
  assert.equal(readFileSync(stray, "utf8"), "前回の成果物", "止めたのに前回の中身を変えた")
})

test("読み取りが、書き出し先の中身を消す道を持たない", async () => {
  // 一度は「印を見て入れ替える旗」を設けたが、印は偽造でき、許せるのはディレクトリ
  // 1 個までで中の個々のファイルには及ばず、利用者の資料も入力の .sb3 も巻き添えに
  // した（CP6 で 6 観点が実測）。読むだけの道具が消す道を持たないことを見張る
  const source = readFileSync(join(ROOT, "src", "cli.ts"), "utf8")
  assert.doesNotMatch(source, /rmSync\([^)]*\bdir\b/, "置き場を再帰的に消す手が復活した")
  assert.doesNotMatch(source, /--clean/, "入れ替えの旗が復活した")

  // 一時ディレクトリの始末だけは残る。消す対象が自分で作ったものに限ることを字面で見る
  const staging = [...source.matchAll(/rmSync\(([^,)]+)/g)].map(hit => hit[1].trim())
  assert.ok(staging.length > 0, "rmSync を 1 件も拾えていない")
  for (const target of staging) {
    assert.equal(target, "staging", `自分で作ったもの以外を消している: ${target}`)
  }
})

test("書き出し先がリンクなら、書き出す前に止める", async () => {
  // 置き場を空ける手がリンクそのものを消し、利用者が指した実体には何も書かれない。
  // main は mkdirSync + writeFileSync でリンクを保って書き込んでいた（CP6 で実測）。
  //
  // **消えないことを守っているのは「空の置き場だけを外す」規則の側である**（破壊で
  // 確かめた。この検分を外してもリンクは消えず、申告が「移せない」に変わるだけ）。
  // この検分が足すのは、利用者が原因を読める申告である。両方を見る
  const nest = mkdtempSync(join(tmpdir(), "gen-scratch-link-"))
  const real = join(nest, "実体")
  const link = join(nest, "近道")
  mkdirSync(real, { recursive: true })
  try {
    symlinkSync(real, link, "junction")
  } catch {
    // リンクを作れない機械では、この性質を測れない。黙って緑にしない
    assert.fail("リンクを作れないため、この検査は何も測っていない")
  }

  const done = await run(process.execPath, [
    CLI,
    "read",
    await ourSb3File(),
    "--out",
    link,
  ]).catch(e => e)

  assert.ok(lstatSync(link).isSymbolicLink(), "リンクが消えた")
  assert.deepEqual(readdirSync(real), [], "リンク越しに書いた")
  assert.equal(done.code, 1, "リンクの上へ書こうとした")
  assert.match(String(done.stderr), /書き出し先がリンクを指している/)
})

test("検分の後に置かれたものを、書き出しが消さない", async () => {
  // 検分から書き出しまでの間に図の描画が挟まり、大きな作品では数分空く。その窓で
  // 置かれたものを消さない。空の置き場を外す 1 手だけなので ENOTEMPTY で止まる
  const out = join(work, "raced")
  mkdirSync(out, { recursive: true })
  const built = [{ name: "summary.md", body: "組み上がったもの", escape: ESCAPES.要約 }]
  writeFileSync(join(out, "割り込み.md"), "後から置かれた")

  const placed = placeAll(out, built)

  assert.ok("error" in placed, "中身のある置き場へ移した")
  // 落ちた理由まで見る。別の砦（逃がし方の名乗り）で止まっても同じ形で返るので、
  // 理由を見ないと測りたい性質を外しても緑のまま通る（実際に通した）
  assert.equal(
    "error" in placed ? placed.error.kind : "",
    "読み取りの結果を置き場へ移せない",
    "測りたい砦とは別の理由で止まった",
  )
  assert.deepEqual(readdirSync(out), ["割り込み.md"], "割り込んだファイルを消した")
  assert.equal(readFileSync(join(out, "割り込み.md"), "utf8"), "後から置かれた")
})

test("書き出しの途中で失敗したとき、置き場に何も残らない", async () => {
  // 不可分性は本作業の中核である。外から書き込みを失敗させる手が無いので、書く手を
  // 差し替えて確かめる。差し替えないと、この性質は次に触る人が壊しても緑になる
  const nest = mkdtempSync(join(tmpdir(), "gen-scratch-atomic-"))
  const out = join(nest, "置き場")
  const built = [
    { name: "summary.md", body: "1 つ目", escape: ESCAPES.要約 },
    { name: "project.yaml", body: "2 つ目", escape: ESCAPES.定義 },
  ]

  let wrote = 0
  const placed = placeAll(out, built, (path, body) => {
    if (wrote++ === 1) throw new Error("書き出しの途中で落ちた")
    writeFileSync(path, body)
  })

  assert.ok("error" in placed, "落ちたのに成功を返した")
  assert.equal(wrote, 2, "書く手が 2 度呼ばれていない。破壊が当たっていない")
  assert.throws(() => readdirSync(out), /ENOENT/, "置き場に半分だけ残った")
  assert.deepEqual(readdirSync(nest), [], "一時ディレクトリを残した")
})

test("前の実行が残した一時ディレクトリを、消さずに知らせる", async () => {
  // 残るのは強制終了されたときだけで、そのときは申告も出せない。ドット始まりのうえ
  // 置き場の検分は親を見ないので、放っておくと出力 1 回分ずつ見えないまま積もる
  const parent = mkdtempSync(join(tmpdir(), "gen-scratch-orphan-"))
  const out = join(parent, "置き場")
  const orphan = join(parent, ".置き場.tmp-99999")
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, "summary.md"), "前の実行の組み上がり")

  const args = [CLI, "read", await ourSb3File(), "--out", out]
  const done = await run(process.execPath, args)

  assert.match(String(done.stderr), /前の実行が残した一時ディレクトリが 1 件ある/)
  assert.match(String(done.stderr), /読み取りは消さない/, "消さないことを伝えていない")
  // 消す判断は利用者に残す。自分が作ったと確かめずに消す形は、入れ替えの旗を
  // 取り下げた裁定と逆を向く
  assert.equal(
    readFileSync(join(orphan, "summary.md"), "utf8"),
    "前の実行の組み上がり",
    "残骸を勝手に消した",
  )
})

test("書き出しの後に、一時ディレクトリが残らない", async () => {
  // 組み上がったものは置き場と同じ親の下へ一旦書く。移した後に残ると、次の読み取りが
  // 「前回の成果物がある」と誤って止まり、親の下にごみが積もる
  const parent = mkdtempSync(join(tmpdir(), "gen-scratch-staging-"))
  const out = join(parent, "atomic")
  await run(process.execPath, [CLI, "read", await ourSb3File(), "--out", out])

  assert.deepEqual(readdirSync(parent), ["atomic"], "一時ディレクトリを残した")
})

test("書き出し先の綴りがファイルを指していたら、書き出す前に止める", async () => {
  const out = join(work, "not-a-dir")
  writeFileSync(out, "ディレクトリではない")

  const done = await run(process.execPath, [
    CLI,
    "read",
    await ourSb3File(),
    "--out",
    out,
  ]).catch(e => e)

  assert.equal(done.code, 1, "ファイルの上へ書こうとした")
  assert.match(String(done.stderr), /書き出し先を見られない/)
  assert.equal(readFileSync(out, "utf8"), "ディレクトリではない", "止めたのに触った")

  // 入れ替えの旗は、この砦を素通りする理由にならない。検分を外すと置き場の削除が
  // ファイルを消し、その跡へディレクトリが立つ（破壊で実測）。--out の綴りを誤った
  // 利用者は、消えた覚えのないファイルを失う
  const forced = await run(process.execPath, [
    CLI,
    "read",
    await ourSb3File(),
    "--out",
    out,
    "--clean",
  ]).catch(e => e)

  assert.equal(forced.code, 1, "--clean がファイルの上への書き出しを通した")
  assert.equal(readFileSync(out, "utf8"), "ディレクトリではない", "--clean がファイルを消した")
})

test("図が多すぎる作品を、切り詰めずに止める", async () => {
  // project.json の上限（5 MB）の内側に最小のスクリプトが約 39,420 本入る。1 枚
  // 約 4.6 ms・約 29 KB なので、そのまま描くと約 181 秒・約 1.1 GB になる（CP6 で実測）。
  // 黙って一部だけ書くと、読み手には「全部読めた」と見分けが付かない
  const many = Object.fromEntries(
    Array.from({ length: 2001 }, (_, i) => [
      `s${i}`,
      {
        opcode: "motion_ifonedgebounce",
        next: null,
        parent: null,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: true,
        x: 0,
        y: i,
      },
    ]),
  )
  const path = await sb3File("many.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage" }),
      targetOf({ name: "ネコ", blocks: many }),
    ],
    meta: { semver: "3.0.0" },
  })

  const out = join(work, "many")
  const done = await run(process.execPath, [CLI, "read", path, "--out", out]).catch(e => e)

  assert.equal(done.code, 1, "上限を超えたのに書き出した")
  assert.match(String(done.stderr), /図の本数が上限を超えた/)
  assert.throws(() => readdirSync(out), /ENOENT/, "止めたのに出力先を作った")
})

/**
 * 他者が決められる綴りへ、成果物の構造を壊す文字を仕込んだ .sb3。
 *
 * ターゲット名・変数名・リスト名・メッセージ名・欄の名前の 5 経路へ同じ細工を置く。
 * 欄の名前は JSON のキーなので、schema が知らない綴りでも通る。
 */
async function hostileFile(name: string) {
  const nl = String.fromCharCode(10)
  const nasty = `${nl}名前: のっとり${nl}`
  const stage = targetOf({ isStage: true, name: "Stage" })
  const sprite = targetOf({
    name: `ネ${nasty}コ`,
    variables: { v: [`変${nasty}数`, 0] },
    lists: { l: [`リ${nasty}スト`, []] },
    broadcasts: { b: `メ${nasty}ッセージ` },
  })
  sprite[`${nasty}欄`] = 1
  return sb3File(name, {
    targets: [stage, sprite],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  })
}

test("敵対的な .sb3 でも、4 種の成果物が構造を保つ", async () => {
  // **呼び手が中和を思い出したかは測らない。** 端末の申告は「単一の入口 + ソース走査」で
  // 中和を見張るが、ファイルへ書く側にその仕組みが無く、入口が増えた本作業でちょうど
  // 1 つ抜けた（CP6 で 4 観点が実測）。ここでは結果として構造が壊れていないかを測る。
  // 入口が次に増えても、この検査は同じ強さで効く
  const path = await hostileFile("hostile.sb3")
  const out = join(work, "hostile")
  await run(process.execPath, [CLI, "read", path, "--out", out, "--anyway"]).catch(e => e)

  // 作品定義: YAML として読め、最上位のキーが増えていない
  const definition = parseYaml(readFileSync(join(out, "project.yaml"), "utf8"))
  assert.deepEqual(
    Object.keys(definition).sort(),
    ["スプライト", "ステージ", "名前"].sort(),
    "コメントから抜けて最上位のキーが増えた",
  )

  // 要約: 表の行数がターゲットの数と合う（升が割れていない）
  const summary = readFileSync(join(out, "summary.md"), "utf8")
  const table = summary.slice(summary.indexOf("| 名前 |"), summary.indexOf("## 変数"))
  const rows = table
    .split("\n")
    .filter(line => line.startsWith("| ") && line.includes("`"))
  assert.equal(rows.length, 2, `対応表の行数がターゲット数と合わない: ${rows.length}`)

  // 図: コメントの中に `-` が 2 つ続かない（続くと図そのものが開けなくなる）
  for (const file of readdirSync(out).filter(item => item.endsWith(".svg"))) {
    const svg = readFileSync(join(out, file), "utf8")
    const head = svg.startsWith("<!--") ? svg.slice(4, svg.indexOf("-->")) : ""
    assert.doesNotMatch(head, /--/, `${file} のコメントで記号が 2 つ続いた`)
    assert.match(svg, /<svg /, `${file} の本体が消えた`)
  }

  // 記法: 生の制御文字を持ち込まない
  for (const file of readdirSync(out).filter(item => item.endsWith(".sbk"))) {
    const text = readFileSync(join(out, file), "utf8")
    const raw = [...text].filter(ch => {
      const code = ch.codePointAt(0) ?? 0
      return code < 32 && code !== 10
    })
    assert.deepEqual(raw, [], `${file} に制御文字が残った`)
  }
})

test("記法へ戻せなかったターゲットが、project.yaml から辿れる", async () => {
  // 定義だけを受け取った人には、元の作品の全部が入っているのか、落ちたものがあるのかが
  // 見分けられない。落としたのに「作品定義あり」とだけ報告していた（CP6 の指摘）
  const path = await sb3File("dropped.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage" }),
      targetOf({ name: "ネコ" }),
      targetOf({ name: "こわれた", layerOrder: 2, blocks: null }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  })
  const out = join(work, "dropped")
  const done = await run(process.execPath, [
    CLI,
    "read",
    path,
    "--out",
    out,
    "--anyway",
  ]).catch(e => e)

  const yaml = readFileSync(join(out, "project.yaml"), "utf8")
  assert.match(yaml, /記法へ戻せず落としたターゲットが 1 件ある/, "痕跡が定義に無い")
  assert.match(yaml, /こわれた/, "落としたターゲットの名前が定義に無い")
  assert.match(String(done.stdout), /ターゲット 1 件を落とした/, "報告が落とした件数を言わない")
})

test("要約が、読み切れなかった箇所を残す", async () => {
  // 申告は標準エラーへ出るだけで端末を閉じれば消える。要約が黙っていると、落とした
  // ターゲットが後から辿れず、件数だけを見て「全部読めた」と受け取れる（CP6 の指摘）
  const reading = readingOf({ targets: [], used: [], problems: [
    { kind: "記法へ戻せない", subject: "測定: ネコ", detail: "理由" },
  ] })
  const summary = summaryOf(reading, "測定")

  assert.match(summary, /^## 読み切れなかった箇所（1 件）$/m)
  assert.match(summary, /記法へ戻せない/)
  assert.match(summary, /測定: ネコ/)

  // 0 件のときも見出しごと落とさない。落とすと「無い」のか「数え忘れた」のか分からない
  const clean = summaryOf(readingOf({ targets: [], used: [], problems: [] }), "測定")
  assert.match(clean, /^## 読み切れなかった箇所（0 件）$/m)
  assert.match(clean, /^なし。$/m)
})

test("要約の対応表が挙げる名前が、すべて実在する", async () => {
  // 表が指す先が実在しないと、読み手はそこで止まる。幹と拡張子から組み立て直した名前を
  // 載せると、落とした図の番号まで表に載る（CP6 の指摘）
  const out = join(work, "traceable")
  await run(process.execPath, [CLI, "read", await ourSb3File(), "--out", out])
  const summary = readFileSync(join(out, "summary.md"), "utf8")
  const here = new Set(readdirSync(out))

  // 表の行だけを見る。節の散文にも綴りを囲んだ字が出るので、節ごと拾うと表の外まで
  // 実在を問うことになる（`/` と `:` を拾って落ちた）
  const table = summary.slice(summary.indexOf("## ターゲット"), summary.indexOf("## 変数"))
  const rows = table
    .split("\n")
    .filter(line => line.startsWith("| ") && line.includes("`"))
  const named = rows.flatMap(row => [...row.matchAll(/`([^`]+)`/g)].map(hit => hit[1]))
  assert.ok(named.length > 0, "対応表から名前を 1 つも拾えていない")

  // **両方向を見る。** 載っている名前が実在するかだけを見ると、表が載せ漏らしても
  // 通る（実測 2026-08-21。図を数えない破壊がこの検査を素通りした）。この作品は
  // ターゲットごとに 2 ファイルなので、升の頭打ちには掛からない
  const listed = new Set(named)
  const aside = new Set(["summary.md", "project.yaml"])
  const written = [...here].filter(name => !aside.has(name))
  assert.deepEqual(
    [...listed].sort(),
    written.sort(),
    "対応表と実際に書いたファイルが食い違う",
  )
})

test("要約が、復元しない属性を実装の数えた値で挙げる", async () => {
  // 断りがソースの doc にしかなく、成果物のどこにも出ていなかった。重なり順は黙って
  // 変わるので、組み立て直した作品の見た目が元と違う理由を誰も辿れない（CP6 の指摘）
  const out = join(work, "unrestored")
  await run(process.execPath, [CLI, "read", await ourSb3File(), "--out", out])
  const summary = readFileSync(join(out, "summary.md"), "utf8")

  assert.match(summary, /^## 復元しない属性（\d+ 種）$/m)
  // 読み手は Scratch の利用者で .sb3 の内部の綴りを知らない。言い換えを添えつつ、
  // 引ける綴りも残す（CP6 の指摘。表に無い欄は生綴りのまま出る）
  for (const [field, name] of [
    ["layerOrder", "重なり順"],
    ["rotationStyle", "回転方法"],
    ["draggable", "ドラッグ可否"],
  ]) {
    assert.match(summary, new RegExp(`^- ${name}（${field}）$`, "m"), `${field} が挙がっていない`)
  }
  // 復元している欄は挙げない。挙げると「復元しない」の意味が消える。
  //
  // **綴りを並べて書くのは意図である。** `PLACEMENT_KEYS` から作ると、表を縮めたときに
  // 期待値も一緒に縮んで検査が素通りする（実測 2026-08-21。`direction` を表から外すと
  // 一覧は 10 種から 11 種へ動いたのに、検査は緑のままだった）
  for (const field of ["x", "y", "visible", "size", "direction"]) {
    assert.doesNotMatch(summary, new RegExp(`（${field}）`), `${field} は復元している`)
  }
})

test("置かれ方の対応表が、定義の知っているキーだけを使う", () => {
  // 2 つの表が割れると、定義には出るのに組み立てが知らないキーになる。しかも申告は
  // 「復元している」と言い続けるので、割れたことが成果物からは見えない
  const keys = Object.values(PLACEMENT_KEYS)
  assert.ok(keys.length > 0, "対応表が空だと以下の照合は何も見ない")
  for (const key of keys) {
    assert.ok(key in SPRITE_KEYS, `定義が知らないキーを復元しようとしている: ${key}`)
  }
})

test("宣言だけのメッセージが消えることが、成果物から読める", async () => {
  // 要約は「メッセージ 1 件」と数えるのに定義には無く、「復元しない属性」にも出ない
  // 状態だった。定義の形式にメッセージのキーが無く、記法で使われたものだけを組み立てが
  // 作り直す（CP6 で 3 観点が独立に実測）
  const path = await sb3File("declared-only.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage" }),
      targetOf({ name: "ネコ", broadcasts: { b: "だれも使わない" } }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  })
  const out = join(work, "declared-only")
  await run(process.execPath, [CLI, "read", path, "--out", out])

  const summary = readFileSync(join(out, "summary.md"), "utf8")
  assert.match(summary, /^## メッセージ（1 件）$/m, "宣言を数えていない")
  assert.match(summary, /^- メッセージ（broadcasts）$/m, "消えるのに復元しない属性へ出ない")

  const definition = parseYaml(readFileSync(join(out, "project.yaml"), "utf8"))
  const sprite = definition["スプライト"][0]
  assert.equal("メッセージ" in sprite, false, "定義がメッセージを持つ前提が変わった")
})

test("作品定義を落としたとき、成果物にその痕跡が残る", async () => {
  // 定義を落とすのはこの道具がする「落とす」の中でいちばん大きい。申告にしか出ないと、
  // 後から開いた人には最初から無かったのか落ちたのかが見分けられない（CP6 の指摘）
  // ステージの変数と、スプライトの同名の変数が同じ ID を名乗る。組み立てが止める形
  const path = await sb3File("unfit-trace.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", variables: { v: ["ネコ/スコア", 0] } }),
      targetOf({ name: "ネコ", variables: { w: ["スコア", 0] } }),
    ],
    meta: { semver: "3.0.0" },
  })
  const out = join(work, "unfit-trace")
  const done = await run(process.execPath, [CLI, "read", path, "--out", out]).catch(
    e => e,
  )

  assert.equal(done.code, 1, "定義を落としたのに成功で返した")
  assert.equal(readdirSync(out).includes("project.yaml"), false, "通らない定義を書いた")
  const summary = readFileSync(join(out, "summary.md"), "utf8")
  assert.match(summary, /^## 作品定義を書き出さなかった（\d+ 件）$/m, "痕跡が要約に無い")
})

test("落としたターゲットの件数が、定義の可否で消えない", async () => {
  // 件数を「定義が書けた」枝にだけ添えていたので、定義が落ちると報告から消えていた
  const path = await sb3File("dropped-and-unfit.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", variables: { v: ["ネコ/スコア", 0] } }),
      targetOf({ name: "ネコ", variables: { w: ["スコア", 0] } }),
      targetOf({ name: "こわれた", layerOrder: 2, blocks: null }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  })
  const out = join(work, "dropped-and-unfit")
  const done = await run(process.execPath, [
    CLI,
    "read",
    path,
    "--out",
    out,
    "--anyway",
  ]).catch(e => e)

  assert.match(String(done.stdout), /作品定義なし/, "この検査は定義が落ちる形を測っていない")
  assert.match(String(done.stdout), /ターゲット 1 件を落とした/, "落とした件数が消えた")
})

test("--format png の要約が、置いていない図を案内しない", async () => {
  // 書体の節は形式で分岐させたのに、断りの文言は固定のままだった（CP6 で 2 観点が実測）
  const path = await refusedFile("png-caveat.sb3")
  const out = join(work, "png-caveat")
  await run(process.execPath, [
    CLI,
    "read",
    path,
    "--out",
    out,
    "--anyway",
    "--format",
    "png",
  ]).catch(e => e)

  const summary = readFileSync(join(out, "summary.md"), "utf8")
  assert.match(summary, /## 逃げ道を通して読んだ/, "この検査は断りの節を測っていない")
  assert.doesNotMatch(summary, /図（SVG）の先頭にも/, "PNG なのに SVG へ置いたと述べた")
  assert.match(summary, /図（PNG）には/, "置けない先を述べていない")
})

test("要約が、図にならなかったスクリプトを読み切れなかった箇所と別に数える", async () => {
  // 「読み切れなかった箇所」は「記法にも図にもなっていない」と名乗る。記法にはなったが
  // 図にできなかったものを混ぜると、その一文が偽になる
  const reading = readingOf({ targets: [], used: [], problems: [] })
  const summary = summaryOf(reading, "測定", {
    undrawn: [{ kind: "図を書き出せない", subject: "測定: ネコ", detail: "理由" }],
  })

  assert.match(summary, /^## 図にならなかったスクリプト（1 本）$/m)
  assert.match(summary, /図を書き出せない/)
  assert.match(summary, /^## 読み切れなかった箇所（0 件）$/m, "落ちた図を読み取りの側へ数えた")

  // 1 本も落ちていないときは節ごと出さない。逃げ道の断りと同じで、常に出すと読み手が
  // 印を見なくなる
  const whole = summaryOf(reading, "測定")
  assert.doesNotMatch(whole, /図にならなかったスクリプト/, "落ちていないのに節が出た")
})

test("要約の升が、markdown として意味を持つ文字を逃がす", async () => {
  const name = `ネ|コ${String.fromCharCode(96)}<b>${String.fromCharCode(92)}`
  const reading = readingOf({
    targets: [
      { name, stem: "x", isStage: false, scripts: [], variables: {}, lists: {}, broadcasts: [], placement: {} },
    ],
    used: [],
    problems: [],
  })
  const row = summaryOf(reading, "測定")
    .split("\n")
    .find(line => line.includes("ネ"))

  assert.ok(row, "ターゲットの行が無い")
  // 升が割れず、コード表記も HTML も抜けない
  assert.equal(row.split(" | ").length, 3, `升が割れた: ${row}`)
  // 逃がしの綴りは文字を組み立てて作る。正規表現へ直に書くと道具の層で 1 段縮み、
  // `/\\|/` が「逆斜線か空」になって何にでも当たる（実際にそうなっていた）
  const escape = String.fromCharCode(92)
  assert.ok(row.includes(escape + "|"), `縦棒を逃がしていない: ${row}`)
  assert.ok(row.includes(escape + String.fromCharCode(96)), `逆引用符を逃がしていない: ${row}`)
  assert.ok(row.includes(escape + "<"), `山括弧を逃がしていない: ${row}`)
})

test("targets が空の .sb3 で、空の作品定義を書き出さない", async () => {
  // 「作品の定義が空」の検査だけが組み立ての側に残っていたため、読み取りが
  // 「組み立てを通る」と判断して終了コード 0 で書き出していた（CP6 の指摘）
  const path = await sb3File("empty.sb3", { targets: [], meta: { semver: "3.0.0" } })
  const out = join(work, "empty")
  const done = await run(process.execPath, [CLI, "read", path, "--out", out]).catch(e => e)

  assert.equal(done.code, 1, "空の定義を終了コード 0 で書き出した")
  assert.match(String(done.stderr), /作品の定義が空|公式検証器が弾いた/)
})

/**
 * 検証器は弾くが、読めば読める .sb3 をファイルとして置く。
 *
 * コスチュームを 0 件にする。schema は 1 件以上を求めるので必ず弾かれ、ブロックの表には
 * 触らないので読み取りは無傷である。前提は `read.test.ts` の較正が見張る。
 */
async function refusedFile(name: string): Promise<string> {
  return sb3File(name, {
    targets: [
      targetOf({ isStage: true, name: "Stage", blocks: {} }),
      targetOf({ isStage: false, name: "ネコ", costumes: [], blocks: AWKWARD }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  })
}

test("旗が無いと、検証器が弾いた作品では 1 つも書き出さない", async () => {
  const path = await refusedFile("refused-strict.sb3")
  const out = join(work, "refused-strict")

  await assert.rejects(
    () => run(process.execPath, [CLI, "read", path, "--out", out]),
    (error: any) => {
      assert.equal(error.code, 1, "終了コードが 1 でない")
      assert.match(String(error.stderr), /公式検証器が弾いた/, "弾いた理由が出ていない")
      return true
    },
  )
  assert.throws(() => readdirSync(out), "止まったのに出力先を作った")
})

test("旗を立てると書き出し、要約に保証しないことを残す", async () => {
  const path = await refusedFile("refused-anyway.sb3")
  const out = join(work, "refused-anyway")

  // 終了コードは 1 のまま。読み取りは「申告があれば書き出しつつ非 0」という契約を既に
  // 持っており、逃げ道だけを例外にしない（契約そのものの見直しは別の作業が持つ）
  await assert.rejects(
    () => run(process.execPath, [CLI, "read", path, "--out", out, "--anyway"]),
    (error: any) => {
      assert.equal(error.code, 1, "終了コードが契約から外れた")
      assert.match(String(error.stderr), /公式検証器が弾いた/, "弾いた理由を黙って捨てた")
      assert.match(String(error.stdout), /ターゲット 2 件/, "読めたものを書き出していない")
      return true
    },
  )

  const summary = readFileSync(join(out, "summary.md"), "utf8")
  // 申告は stderr へ流れて消える。後から開く成果物の側にも断りが要る
  assert.match(summary, /## 逃げ道を通して読んだ/, "要約に断りが無い")
  assert.match(summary, /組み立て直せるとは限らない/, "保証しないことが書かれていない")

  // 節を区別して見る。要約の全文に対して照合すると、理由がどちらの節に出ても通り、
  // 「読み切れなかった箇所」が読めたものを数える誤りを検出できない（CP6 の指摘）
  const sections = Object.fromEntries(
    summary
      .split(/^## /m)
      .slice(1)
      .map(part => [part.split("\n")[0].trim(), part]),
  )
  assert.match(sections["逃げ道を通して読んだ"], /fewer than 1 items/, "断りに理由が無い")
  assert.doesNotMatch(
    sections["読み切れなかった箇所（0 件）"] ?? "",
    /fewer than 1 items/,
    "読み切れなかった箇所へ検証器の拒否が混ざった",
  )
  assert.ok(
    Object.keys(sections).includes("読み切れなかった箇所（0 件）"),
    `読み切れなかった箇所が 0 件になっていない: ${Object.keys(sections).join(" / ")}`,
  )
  assert.ok(
    readdirSync(out).some(name => name.endsWith(".sbk")),
    "読めたはずの記法が書き出されていない",
  )
})

test("逃げ道を通っていない要約に、断りは出ない", async () => {
  // 断りが常に出ると、読み手はそれを見なくなる。出る条件を測る
  const reading = await readSb3(await ourSb3(), "測定")
  assert.deepEqual(reading.refused, [], "測る前提が崩れている（正当な入力で弾かれた）")

  assert.doesNotMatch(summaryOf(reading, "測定"), /逃げ道/, "通っていないのに断りが出た")
})

test("逃げ道を通した作品定義は、出自を名乗る", async () => {
  // 断りが summary.md の散文だけだと、project.yaml を受け取った人には正当な作品由来と
  // 見分けが付かない（CP6 で 5 観点が指摘）
  // 追跡下の作品からコスチュームだけを外す。schema は 1 件以上を求めるので必ず弾かれ、
  // 記法には印が入らない（印が入る入力だと、組み立てが別の理由で止まって測れない）
  const zip = await JSZip.loadAsync(await ourSb3())
  const { project } = await projectJsonIn(zip)
  project.targets[1].costumes = []
  const path = await sb3File("refused-provenance.sb3", project)
  const out = join(work, "refused-provenance")
  await assert.rejects(() => run(process.execPath, [CLI, "read", path, "--out", out, "--anyway"]))

  const definition = readFileSync(join(out, "project.yaml"), "utf8")
  assert.match(definition, /^# .*--anyway/m, "作品定義が出自を名乗らない")
  // 印を足しても組み立ての入力であり続ける。YAML の注記なので読み飛ばされる
  const rebuilt = join(work, "refused-provenance.sb3")
  await run(process.execPath, [CLI, "build", out, "--out", rebuilt])
})

test("逃げ道を通した図が、出自を名乗る", async () => {
  // 定義には印を置いたが、図と記法は名乗っていなかった（TASK0015 の CP6 が指摘）。
  // 記法には置けない ── コメントの構文が無く、置くと組み立てが止まる
  const path = await refusedFile("marked-figure.sb3")
  const out = join(work, "marked-figure")
  await run(process.execPath, [CLI, "read", path, "--out", out, "--anyway"]).catch(e => e)

  const svg = readFileSync(join(out, "ネコ-1.svg"), "utf8")
  assert.match(svg, /^<!--/, "図が出自を名乗っていない")
  assert.match(svg, /逃げ道の旗を立てて読み取った図である/)
  // XML のコメントは中に `--` を持てない。置くと図そのものが開けなくなる
  const comment = svg.slice(0, svg.indexOf("-->"))
  assert.doesNotMatch(comment.slice(4), /--/, "コメントの中で `-` が 2 つ続いている")
  assert.match(svg, /<svg /, "図の本体が消えた")

  // 記法は名乗らない。名乗ると組み立てが止まる
  assert.doesNotMatch(readFileSync(join(out, "ネコ.sbk"), "utf8"), /逃げ道の旗/)
})

test("逃げ道を通っていない図に、出自の印は出ない", async () => {
  const out = join(work, "plain-figure")
  await run(process.execPath, [CLI, "read", await ourSb3File(), "--out", out])

  assert.match(
    readFileSync(join(out, "Stage-1.svg"), "utf8"),
    /^<svg /,
    "通っていないのに印が出た",
  )
})

test("要約が、図の書体依存を断る", async () => {
  // 寸法は書き出した機械の文字の幅で決まる。書体を持たない機械では文字が枠を越えうる。
  // 実測はしない裁定（2026-08-21）なので、断りを置いて受容する
  const out = join(work, "typeface")
  await run(process.execPath, [CLI, "read", await ourSb3File(), "--out", out])
  assert.match(readFileSync(join(out, "summary.md"), "utf8"), /^## 図の見え方$/m)

  // PNG は書き出した時点で像になっているので当たらない。断りを出すと嘘になる
  const raster = join(work, "typeface-png")
  const asPng = [CLI, "read", await ourSb3File(), "--out", raster, "--format", "png"]
  await run(process.execPath, asPng)
  assert.doesNotMatch(readFileSync(join(raster, "summary.md"), "utf8"), /## 図の見え方/)
})

test("逃げ道を通っていない作品定義に、出自の印は出ない", async () => {
  const out = join(work, "plain-provenance")
  await run(process.execPath, [CLI, "read", await ourSb3File(), "--out", out])

  // 印そのものを見る。`#` 行の有無で見ていたが、常にある欠け（復元しない属性）の断りが
  // 定義に入ったため、その proxy では例外の印と常設の断りを分けられない（2026-08-21 裁定）
  const definition = readFileSync(join(out, "project.yaml"), "utf8")
  assert.doesNotMatch(definition, /検証器が弾いた/, "通っていないのに出自の印が出た")
  assert.doesNotMatch(definition, /落としたターゲット/, "落としていないのに印が出た")
  assert.doesNotMatch(definition, /図にできなかった/, "落としていないのに印が出た")
})

test("作品定義が、常に .sb3 の一部であることを断る", async () => {
  // 定義だけを受け取った人には、元の作品の全部が写っているのかが見えない。復元しない
  // 属性は例外でなく常にあるので、起きたときだけ出す印とは分けて必ず出す（2026-08-21 裁定）
  const out = join(work, "partial-notice")
  await run(process.execPath, [CLI, "read", await ourSb3File(), "--out", out])

  const definition = readFileSync(join(out, "project.yaml"), "utf8")
  assert.match(definition, /^# この定義は \.sb3 の一部である。写さない欄: /m)
  assert.match(definition, /^# 詳しくは同じディレクトリの summary\.md を見る。$/m)
  // 断りはコメントに留める。定義そのものへ混ぜると組み立てが知らないキーになる
  assert.match(definition, /^名前: /m, "定義の本体が消えた")
})

/**
 * 印の括弧は「こちらの言葉」の印である。作品の綴りからは必ず落とす。
 *
 * 括弧を落とす場所を数えるのは拒否リストなので、場所を数える代わりに**結果**を測る ──
 * 読めているブロックへ偽の印が立たないこと、こちらが補った言葉を作品が名乗れないこと。
 * 守る場所が次に増えても、この検査は同じ強さで効く。
 */
const SENTINEL_OPEN = "⟪"
const SENTINEL_CLOSE = "⟫"

/** 印を名乗る綴り。実装の定数から作らず、読み手が目にする字面をここへ置く */
const FAKE_MARK = `${SENTINEL_OPEN}読み取れない: looks_say${SENTINEL_CLOSE}`

test("読めているブロックへ、偽の印を立てられない", async () => {
  // 変数の名前・入力に書いた値・独自ブロックの名前の 3 か所から名乗れる。
  // `proccode` だけを
  // 守っていたころは、変数名に印の綴りを書くだけで「読み取れない」と名乗る行が作れた
  // （2026-08-22 実測）
  const path = await sb3File("forged.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", layerOrder: 0 }),
      targetOf({
        name: "偽装",
        variables: { id1: [FAKE_MARK, 0] },
        blocks: {
          b: {
            opcode: "data_setvariableto",
            next: null,
            parent: null,
            inputs: { VALUE: [1, [10, FAKE_MARK]] },
            fields: { VARIABLE: [FAKE_MARK, "id1"] },
            shadow: false,
            topLevel: true,
          },
        },
      }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  })
  const { targets } = await readSb3(readFileSync(path), "測定", { anyway: true })
  const notation = targets
    .filter(target => !target.isStage)
    .flatMap(target => target.scripts)
    .join("\n")

  // 実害を先に置く。読めているブロックが「読み取れない」と名乗ることが問題である
  assert.ok(notation.length > 0, "記法が空で、何も測っていない")
  assert.ok(
    !notation.includes(FAKE_MARK),
    `作品が名乗った印がそのまま記法へ出た: ${notation}`,
  )

  // 括弧が消えることは測らない。守りは括弧を落とすのでなく印へ変える形になったので、
  // 作品が書いた括弧も `⟪U+27EA⟫` として記法に現れる。測るのは偽の印が立たないこと
  // であって、括弧の不在はその手段でしかない（TASK0016）
  assert.ok(
    notation.includes(`${SENTINEL_OPEN}U+27EA${SENTINEL_CLOSE}`),
    `作品が書いた括弧が印へ変わっていない: ${notation}`,
  )

  // 記法と作品定義が同じ綴りを使う。片方だけ守ると、書き出したものを build へ戻せない
  const sprite = targets.find(target => !target.isStage)
  const [declared] = Object.keys(sprite?.variables ?? {})
  assert.ok(declared, "変数の宣言が消えた")
  assert.ok(notation.includes(declared), `記法と定義で変数の綴りが割れた: ${declared}`)
})

test("こちらが補った言葉を、作品の側から名乗れない", async () => {
  // 名前の無いターゲットへ付ける代替名である。素の綴りだったころは、その名を名乗る
  // ターゲットと見分けが付かなかった。
  //
  // 代替名の綴りを実装から引かず、**名乗り得る綴りを両方仕込む**。どちらを使う実装でも
  // 詐称できないことを測る ── 片方だけ仕込むと、もう片方を使う実装では衝突が起きず、
  // 守りを外しても緑のまま通る（実際に通した）。番号は代替名が使う並び順に合わせる
  const 素の綴り = "(名前が無い)4"
  const 括弧の綴り = `${SENTINEL_OPEN}名前が無い${SENTINEL_CLOSE}4`
  const path = await sb3File("claimed.sb3", {
    targets: [
      targetOf({ isStage: true, name: "Stage", layerOrder: 0 }),
      targetOf({ name: 素の綴り, layerOrder: 1 }),
      targetOf({ name: 括弧の綴り, layerOrder: 2 }),
      // 本当に名前が無い。並びの 4 番目なので代替名の番号は 4 になる
      targetOf({ name: "", layerOrder: 3 }),
    ],
    monitors: [],
    extensions: [],
    meta: { semver: "3.0.0" },
  })
  const { targets } = await readSb3(readFileSync(path), "測定", { anyway: true })
  const names = targets.map(target => target.name)

  // 実害を先に置く。同じ綴りが 2 つ出ると、どちらが本当に名前を持たないか読めない
  assert.equal(names.length, 4, `ターゲットが ${names.length} 件しか読めていない`)
  const 並び = names.join(" / ")
  assert.equal(new Set(names).size, names.length, `同じ名前が 2 つ出た: ${並び}`)
})

test("要約の升から、活きたリンクが立たない", async () => {
  // ターゲット名に `[…](https://…)` を仕込むと、要約を開いた人が押せるリンクになる
  // （2026-08-22 実測。正当な .sb3・旗なし・終了コード 0）
  const 名前 = "[クリック](https://example.com/x)"
  const summary = summaryOf(
    readingOf({
      targets: [
        {
          name: 名前,
          stem: "x",
          isStage: false,
          scripts: [],
          variables: {},
          lists: {},
          broadcasts: [],
          placement: {},
        },
      ],
      used: [],
      problems: [],
    }),
    "測定",
  )

  // 実害は「描画すると押せるリンクになる」ことだが、markdown の描画器を持たないので
  // **代理を測る** ── 逃がされていない `[` が残っていないか。リンクも画像も参照も、
  // 入口は `[` 1 つである。逃がしてあれば描画器はリンクにしない
  const LIVE_LINK = /(^|[^\\])\[[^\]]*\]\(/
  assert.doesNotMatch(summary, LIVE_LINK, "要約に逃がされていない `[` が残った")

  // 較正: この綴りが本当にリンクの形をしていることを確かめる。していなければ、上の
  // 照合は逃がしを外しても緑のまま通る
  assert.match(`| ${名前} |`, LIVE_LINK, "測る綴りがリンクの形をしていない")

  // 名前そのものは消さない。消すと「何かが在った」ことまで消える
  assert.ok(summary.includes("クリック"), "名前を落としている")
})

test("逃がし方を名乗らない出力は置かない", () => {
  // 出力の種類を足す人に、逃がし方の一覧を見せて「自分のはどれか」を選ばせるための砦。
  // **保証ではない** ── 名乗りを書けば逃がしたことにはならない。逃がしそのものが効いて
  // いるかは、敵対的な .sb3 で成果物の構造を測る検査が受け持つ
  const out = join(work, "undeclared")

  // 実害を先に置く。名乗らない出力が置かれてしまうことが問題なので、まず置かれたかを見る
  const placed = placeAll(out, [{ name: "summary.md", body: "名乗らない" }])
  assert.ok("error" in placed, "逃がし方を名乗らない出力を置いた")
  assert.throws(() => readdirSync(out), /ENOENT/, "置き場ができている")
  assert.equal(
    "error" in placed ? placed.error.kind : "",
    "逃がし方を名乗らない出力がある",
    "別の理由で止まった",
  )

  // 対照。名乗れば通る ── 「常に止める」実装でも緑にならないようにする
  const fine = join(work, "declared")
  const 名乗る = { name: "summary.md", body: "名乗る", escape: ESCAPES.要約 }
  const ok = placeAll(fine, [名乗る])
  assert.ok(!("error" in ok), "名乗ったのに止めた")

  // 名乗ってよい綴りが 1 つでも欠けていないかを較正する。実装から引くと、実装が
  // 一覧を狭めたときに検査も一緒に狭まる
  for (const 綴り of ["記法", "要約", "定義", "図", "像"] as const) {
    assert.ok(Object.values(ESCAPES).includes(綴り), `${綴り} を名乗れない`)
  }
})

test("断りが、その実行で実際に置いた先だけを案内する", () => {
  // 定義を落とした実行でも「`project.yaml` の先頭にも同じ断りを置いた」と述べていた。
  // 同じ要約の別の節が「`project.yaml` は書いていない」と言うので、1 つの成果物の中で
  // 矛盾する（TASK0015 の CP6 が指摘）
  const 弾かれた = [{ kind: "公式検証器が弾いた", subject: "測定", detail: "理由" }]
  const 読み取り = readingOf({
    targets: [],
    used: [],
    problems: 弾かれた,
    refused: 弾かれた,
    dropped: [],
  })

  /** 断りを置いた先を述べる行だけを取り出す。散文の他の箇所に同じ綴りが出るため */
  const 置いた行 = (summary: string) => {
    const line = summary
      .split("\n")
      .find((row: string) => row.includes("の先頭にも同じ断りを置いた"))
    assert.ok(line, "断りを置いた先を述べる行が無い。測る対象が無い")
    return line
  }

  // 図を実際に 1 本書いた実行を組む。形式が SVG でも 1 枚も書かなければ置き先は無い
  const 図あり = new Map([["ネコ", ["ネコ-1.svg"]]])

  const 定義なし = summaryOf(読み取り, "測定", {
    format: "svg",
    files: 図あり,
    unfit: [{ kind: "定義が通らない", subject: "測定" }],
  })
  // 実害を先に置く。書いていないファイルを案内しないこと
  assert.ok(
    !置いた行(定義なし).includes("project.yaml"),
    `書いていない定義へ断りを置いたと述べた: ${置いた行(定義なし)}`,
  )

  // 対照。定義を書いた実行では案内する ── 「常に伏せる」実装でも緑にならないようにする
  const 定義あり = summaryOf(読み取り, "測定", {
    format: "svg",
    files: 図あり,
    unfit: [],
  })
  assert.ok(
    置いた行(定義あり).includes("project.yaml"),
    `置いた先を案内しない: ${置いた行(定義あり)}`,
  )
})

test("図を 1 枚も書かなかった実行は、図へ断りを置いたと述べない", () => {
  // 形式が SVG かどうかで数えていたころは、全スクリプトが図にできなかった実行でも
  // 「図（SVG）の先頭にも同じ断りを置いた」と述べていた（CP6 の指摘）
  const 弾かれた = [{ kind: "公式検証器が弾いた", subject: "測定", detail: "理由" }]
  const 読み取り = readingOf({
    targets: [], used: [], problems: 弾かれた, refused: 弾かれた, dropped: [],
  })
  const 図なし = summaryOf(読み取り, "測定", {
    format: "svg",
    files: new Map(),
    unfit: [],
  })
  const 置いた行 = 図なし
    .split("\n")
    .find(row => row.includes("の先頭にも同じ断りを置いた"))

  // 実害を先に置く。書いていない図を案内しないこと
  assert.ok(置いた行, "断りを置いた先を述べる行が無い。測る対象が無い")
  assert.ok(!置いた行.includes("図"), `書いていない図へ置いたと述べた: ${置いた行}`)

  // 対照。1 本でも書いた実行では案内する
  const 図あり = summaryOf(読み取り, "測定", {
    format: "svg",
    files: new Map([["ネコ", ["ネコ-1.svg"]]]),
    unfit: [],
  })
  assert.match(図あり, /図（SVG）/, "書いた図を案内しない")
})

test("断りが、その実行で実際に落ちた量を述べる", () => {
  // 節が静的だと、何も落ちていない読み取りでも「落とした」と読める行が並ぶ
  const 弾かれた = [{ kind: "公式検証器が弾いた", subject: "測定", detail: "理由" }]
  const 素の読み取り = readingOf({ targets: [], used: [], problems: 弾かれた, refused: 弾かれた })

  const 素 = { ...素の読み取り, dropped: [] }
  const 落ちていない = summaryOf(素, "測定", { format: "svg" })
  // 実害を先に置く。落としていないのに落としたと読める行が並ばないこと
  const 無し = /ターゲットも図も宣言も落としていない/
  assert.match(落ちていない, 無し, "落ちていないことを述べない")
  const 件数 = /落としたターゲットが \d+ 件/
  assert.doesNotMatch(落ちていない, 件数, "落としていないのに件数を出した")

  const 落ちた = summaryOf(
    { ...素の読み取り, dropped: [{ name: "こわれた", reason: "記法へ戻せない" }] },
    "測定",
    { format: "svg", undrawn: [{ kind: "図にできない", subject: "測定" }] },
  )
  assert.match(落ちた, /落としたターゲットが 1 件ある/, "落とした件数を述べない")
  const 本数 = /図にできなかったスクリプトが 1 本ある/
  assert.match(落ちた, 本数, "落とした図の本数を述べない")

  // 宣言の落ちも数える。静的な断りを動的な件数へ置き換えたとき、この 1 区分だけが
  // 抜けていた（CP6 の指摘）。落ちた宣言は作品定義に並ばないので、組み立て直した人が
  // 変数の無い理由をここで知る
  const 宣言が落ちた = summaryOf(
    { ...素の読み取り, dropped: [], droppedValues: ["スコア", "残り"] },
    "測定",
    { format: "svg" },
  )
  assert.match(宣言が落ちた, /落とした宣言が 2 件ある/, "落とした宣言を数えない")
  assert.doesNotMatch(宣言が落ちた, 無し, "落ちているのに落ちていないと述べた")
})

test("弾かれて止まったとき、逃げ道への案内が出る", async () => {
  // 旗の名前は USAGE にしかなく、止まった画面からは辿れなかった。既存の戻り道の慣行
  // （`writeGuide`）と不整合で、利用者が逃げ道へ辿り着けない（TASK0015 の CP6 が指摘）
  const path = await refusedFile("guide.sb3")
  const done = await run(process.execPath, [
    CLI, "read", path, "--out", join(work, "guide"),
  ]).catch(e => e)

  // 実害を先に置く。止まった人が次に打つものへ辿れることが要る
  assert.match(String(done.stderr), /--anyway/, "逃げ道の旗を示さずに止まった")
  assert.match(String(done.stderr), /node src\/cli\.ts read /, "打てる形で示していない")
  assert.equal(done.code, 1, "弾かれたのに 0 で終わった")

  // 2 つの数に割る。ひとまとめだと、弾かれたのか読み切れなかったのかを読み手に問わせる
  const 弾いた数 = /検証器が弾いた理由が \d+ 件ある/
  assert.match(String(done.stderr), 弾いた数, "弾いた理由を数えない")
})

test("旗で直らない止まり方には、その旗を勧めない", async () => {
  // 対照。効かない場面を数える形にしていたところ、受け入れ検査の拒否 1 つしか塞いで
  // おらず、zip として開けない入力に効かない一手を勧めていた（2026-08-22 実測。旗を
  // 付けて再実行しても同じ理由・同じ終了コードで止まる）
  const path = join(work, "notzip.sb3")
  writeFileSync(path, "これは zip ではない")
  const done = await run(process.execPath, [
    CLI, "read", path, "--out", join(work, "notzip"),
  ]).catch(e => e)

  // 実害を先に置く。効かない一手を勧めないことが要る
  assert.doesNotMatch(
    String(done.stderr),
    /読めるところまで読む: node/,
    "旗では直らないのに勧めた",
  )
  assert.equal(done.code, 1, "読めないのに 0 で終わった")
})

test("旗を立てて止まったときは、同じ旗を勧めない", async () => {
  // 対照。旗を立てても止まったなら受け入れ検査の側で止まっているので、勧めても直らない
  const path = await refusedFile("guide-anyway.sb3")
  const done = await run(process.execPath, [
    CLI, "read", path, "--out", join(work, "guide-anyway"), "--anyway",
  ]).catch(e => e)
  assert.doesNotMatch(
    String(done.stderr),
    /読めるところまで読む: node/,
    "既に立てている旗を勧めた",
  )
})

test("弾かれたまま読み進んだら、4 種の成果物すべてに断りが立つ", async () => {
  // 断りの有無は `refused` 1 つに依存している。欠けると 4 種すべてから黙って消えるのに、
  // 消えたことは誰も申告しない（fail-open。TASK0015 の CP6 が指摘）。欄の実装を見るのでは
  // なく、**読み進んだ結果に断りが立っているか**を契約として測る
  const path = await refusedFile("failopen.sb3")
  const out = join(work, "failopen")
  await run(process.execPath, [CLI, "read", path, "--out", out, "--anyway"]).catch(e => e)

  // 較正: 逃げ道を通って実際に読めていること。読めていなければ断りを測る対象が無い
  const files = readdirSync(out)
  assert.ok(files.some(name => name.endsWith(".sbk")), "記法が書かれていない")
  assert.ok(files.some(name => name.endsWith(".svg")), "図が書かれていない")

  // 実害を先に置く。受け取った人が「弾かれた作品から読んだ」と知れることが要る
  const summary = readFileSync(join(out, "summary.md"), "utf8")
  assert.match(summary, /## 逃げ道を通して読んだ/, "要約に断りが無い")

  const yaml = readFileSync(join(out, "project.yaml"), "utf8")
  assert.match(yaml, /--anyway で読み取った定義である/, "作品定義に断りが無い")

  for (const name of files.filter(item => item.endsWith(".svg"))) {
    const svg = readFileSync(join(out, name), "utf8")
    assert.match(svg, /検証器が弾いた作品から/, `${name} に断りが無い`)
  }

  // 記法（.sbk）だけは断りを持てない。持てないことは要約が引き受ける
  assert.match(summary, /記法（`.sbk`）/, "断りを置けない先を述べていない")
})
