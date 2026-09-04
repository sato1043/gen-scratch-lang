import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { crc32 } from "node:zlib"
import { Resvg } from "@resvg/resvg-js"
import { buildProject, definitionProblems } from "../src/project.ts"
import { packSb3 } from "../src/sb3.ts"
import { openAssets } from "../src/roundtrip.ts"
import { acceptArchive, ASSET_TOTAL_LIMIT } from "../src/intake.ts"
import { definitionOf, readSb3 } from "../src/read.ts"
import { officialProblems } from "../src/validate.ts"

/** 素材を置いた作品のディレクトリを組む。戻りはその置き場 */
function projectWith(definition: string, assets: Record<string, Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-asset-"))
  writeFileSync(join(dir, "project.yaml"), definition)
  writeFileSync(join(dir, "main.sbk"), "緑の旗が押されたとき\n  (10) 歩動かす\n")
  for (const [name, bytes] of Object.entries(assets)) writeFileSync(join(dir, name), bytes)
  return dir
}

/** 寸法を指定した SVG */
function svgOf(width: number, height: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" fill="#4c97ff"/></svg>`,
    "utf8",
  )
}

/** 寸法を指定した PNG。描画は resvg に任せる */
function pngOf(width: number, height: number): Buffer {
  return Buffer.from(new Resvg(svgOf(width, height).toString("utf8")).render().asPng())
}

/** 無音の WAV。単声・16 ビット */
function silentWav(rate: number, samples: number): Buffer {
  const data = Buffer.alloc(samples * 2)
  const head = Buffer.alloc(44)
  head.write("RIFF", 0, "ascii")
  head.writeUInt32LE(36 + data.length, 4)
  head.write("WAVE", 8, "ascii")
  head.write("fmt ", 12, "ascii")
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write("data", 36, "ascii")
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** 作品のディレクトリから .sb3 を組む。申告が出たらその場で止める */
async function sb3Of(dir: string): Promise<Buffer> {
  const built = await buildProject(dir)
  assert.deepEqual(built.problems, [], ".sb3 にできない")
  return packSb3(built)
}

/** .sb3 から、往復で保たれるべきものだけを取り出す */
/** project.json から読んだターゲット。検査が見る欄だけを名乗る */
type ReadTarget = {
  isStage: boolean
  name: string
  currentCostume: number
  costumes: Record<string, unknown>[]
  sounds: Record<string, unknown>[]
}

async function carried(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files).filter(name => name !== "project.json").sort()
  const assets: Record<string, string> = {}
  for (const name of names) {
    assets[name] = (await zip.file(name)!.async("nodebuffer")).toString("base64")
  }
  const project = JSON.parse(await zip.file("project.json")!.async("string"))
  return {
    names,
    assets,
    shown: (project.targets as ReadTarget[]).map(target => ({
      name: target.name,
      currentCostume: target.currentCostume,
      costumes: target.costumes,
      sounds: target.sounds,
    })),
  }
}

/**
 * 4 形式を持つ作品。往復の入力に使う。
 *
 * mp3 は中身から属性を導けない形式で、往復では project.json の値が写るので通る。
 * 中身は音として正しくないが、この作業は素材を解釈しないので区別が付かなくてよい。
 */
const FOUR_FORMATS = `
名前: 素材ためし
スプライト:
  - 名前: ネコ
    スクリプト: main.sbk
    コスチューム:
      - ファイル: a.png
      - 名前: 絵2
        ファイル: b.svg
    今のコスチューム: 2
    音:
      - ファイル: c.wav
      - ファイル: d.mp3
        rate: 44100
        sampleCount: 1000
`.trimStart()

const FOUR_BODIES = {
  "a.png": pngOf(64, 40),
  "b.svg": svgOf(32, 24),
  "c.wav": silentWav(22050, 8),
  "d.mp3": Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02]),
}

test("素材つきの作品が公式検証器を通る", async () => {
  const bytes = await sb3Of(projectWith(FOUR_FORMATS, FOUR_BODIES))
  assert.deepEqual(await officialProblems(bytes, "測定"), [])
})

test("往復で素材のバイト列と属性が保たれる", async () => {
  const before = await sb3Of(projectWith(FOUR_FORMATS, FOUR_BODIES))
  const reading = await readSb3(before, "測定")
  assert.deepEqual(reading.problems, [], "読み取りが申告を出した")

  // 読み取りが書く作品定義と素材を、組み立てが読める形で並べ直す
  const definition = definitionOf(reading, "測定")
  assert.deepEqual(definitionProblems(definition).problems, [], "復元した定義が組み立てを通らない")

  const wanted = new Set<string>()
  for (const target of reading.targets) {
    for (const asset of [...target.shown.costumes, ...target.shown.sounds]) wanted.add(asset.file)
  }
  const { assets, missing } = await openAssets(before, wanted)
  assert.deepEqual(missing, [], ".sb3 の中に無い素材がある")

  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-back-"))
  writeFileSync(join(dir, "project.yaml"), JSON.stringify(definition))
  for (const target of reading.targets) {
    writeFileSync(join(dir, `${target.stem}.sbk`), `${target.scripts.join("\n\n")}\n`)
  }
  for (const [name, body] of assets) writeFileSync(join(dir, name), body)

  const after = await sb3Of(dir)
  const one = await carried(before)
  const two = await carried(after)

  // 器が効くことを先に見る。何を比べても一致と言う器では、下の 3 つが何も測らない
  assert.notDeepEqual(one.shown, [], "比較の器が空と一致している")

  assert.deepEqual(two.names, one.names, "素材のエントリの名前が変わった")
  assert.deepEqual(two.assets, one.assets, "素材のバイト列が変わった")
  assert.deepEqual(two.shown, one.shown, "素材の属性か今のコスチュームが変わった")
})

test("既定でないコスチュームが選ばれている作品が往復する", async () => {
  const before = await sb3Of(projectWith(FOUR_FORMATS, FOUR_BODIES))
  const sprite = (await carried(before)).shown.find(t => t.name === "ネコ")!
  // 入力の側が本当に 0 でないことを見る。0 のままなら、この検査は何も測らない
  assert.equal(sprite.currentCostume, 1, "入力の currentCostume が既定のままになっている")

  const reading = await readSb3(before, "測定")
  const definition = definitionOf(reading, "測定")
  const sprites = definition.スプライト as Record<string, unknown>[]
  assert.equal(sprites[0].今のコスチューム, 2, "1 始まりの番号へ戻っていない")
})

test("既定のコスチュームのままなら、番号を作品定義に書かない", async () => {
  const dir = projectWith(
    "名前: 素\nスプライト:\n  - 名前: ネコ\n    スクリプト: main.sbk\n",
    {},
  )
  const reading = await readSb3(await sb3Of(dir), "測定")
  const definition = definitionOf(reading, "測定")
  const sprites = definition.スプライト as Record<string, unknown>[]
  assert.equal(
    sprites[0].今のコスチューム,
    undefined,
    "既定と同じ値を書き出している",
  )
})

test("出典が任意の属性を省いていたら、復元した定義は組み立てを通らない", async () => {
  // 導けない形式（mp3）から属性を落とす。schema は任意としているので .sb3 としては正当
  const bytes = await sb3Of(projectWith(FOUR_FORMATS, FOUR_BODIES))
  const zip = await JSZip.loadAsync(bytes)
  const project = JSON.parse(await zip.file("project.json")!.async("string"))
  for (const target of project.targets) {
    for (const sound of target.sounds) {
      if (sound.dataFormat !== "mp3") continue
      delete sound.rate
      delete sound.sampleCount
    }
  }
  zip.file("project.json", JSON.stringify(project))
  const stripped = await zip.generateAsync({ type: "nodebuffer" })

  const reading = await readSb3(stripped, "測定")
  const problems = definitionProblems(definitionOf(reading, "測定")).problems
  assert.ok(problems.length > 0, "属性が欠けた定義を組み立てられると判定している")
  // 黙って省くのでなく、書くべきキーを名指していることを見る
  assert.match(JSON.stringify(problems), /rate|sampleCount/, "欠けたキーを名指していない")
})

test("素材の綴りが作品のディレクトリの外を指す入力を止める", async () => {
  // `スクリプト` と同じ規則を使う。3 通りとも止まることを見る ── 1 通りだけ測ると、
  // 残りが素通しでも緑になる
  // 逆斜線はソースへ裸で書かない。読む側が本数を取り違える（`project.ts` と同じ扱い）
  const BACKSLASH = String.fromCharCode(92)
  const outside = [
    { 綴り: "../外.png", 名: "親を指す" },
    { 綴り: "/tmp/外.png", 名: "絶対パス" },
    { 綴り: `sub${BACKSLASH}外.png`, 名: "区切りが逆斜線" },
  ]
  for (const { 綴り, 名 } of outside) {
    const dir = projectWith(
      [
        "名前: 素",
        "スプライト:",
        "  - 名前: ネコ",
        "    スクリプト: main.sbk",
        "    コスチューム:",
        `      - ファイル: ${JSON.stringify(綴り)}`,
        "",
      ].join("\n"),
      {},
    )
    const built = await buildProject(dir)
    assert.ok(built.problems.length > 0, `${名} が素通りした`)
    assert.match(
      JSON.stringify(built.problems),
      /外を指す|区切りが/,
      `${名} が別の理由で止まっている`,
    )
  }

  // 中を指す綴りは通ることも見る。全部を止める実装でも上だけなら緑になる
  const inside = projectWith(FOUR_FORMATS, FOUR_BODIES)
  assert.deepEqual((await buildProject(inside)).problems, [], "中を指す綴りまで止めている")
})

test("素材つきの作品でも、同じ入力から同じバイト列が出る", async () => {
  // 素材は名前の昇順で収める（`packSb3` の既存規則）。並びが揺れると差分が読めなくなる
  const dir = projectWith(FOUR_FORMATS, FOUR_BODIES)
  const one = await sb3Of(dir)
  const two = await sb3Of(dir)
  assert.deepEqual(two, one, "同じ入力から違うバイト列が出た")

  // 器が効くことも見る。何を比べても一致と言う器では、上が何も測らない
  const other = await sb3Of(projectWith(FOUR_FORMATS, { ...FOUR_BODIES, "a.png": pngOf(8, 8) }))
  assert.notDeepEqual(other, one, "違う素材から同じバイト列が出た")
})

/** 検査が自分で決める上限。実装の定数から作らない */
const MEASURED_LIMIT = 1024 * 1024

test("素材だけが膨らむ .sb3 を、展開する前に拒む", async () => {
  const zip = new JSZip()
  zip.file("project.json", "{}")
  // **上限は検査が渡す。** 実装の定数から `+ 1` で作ると、定数が縮んだとき期待値も一緒に
  // 縮んで何も測らなくなる。0 埋めなので生の大きさは KB に収まる
  zip.file("big.png", Buffer.alloc(MEASURED_LIMIT + 1), { binary: true })
  const bomb = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  })

  // 生の大きさでは弾いていないことを見る。ここが大きいと、別の上限で落ちていても気づけない
  assert.ok(bomb.length < 1024 * 1024, `生の .sb3 が ${bomb.length} バイトある`)

  const refused = acceptArchive(bomb, "測定", { assets: MEASURED_LIMIT })
  assert.equal(refused.length, 1, "素材の総量で拒んでいない")
  assert.match(refused[0].kind, /素材が大きすぎる/)
})

test("上限の内側の素材は通る", async () => {
  // 弾く側だけを測ると、全部を弾く実装でも緑になる
  const zip = new JSZip()
  zip.file("project.json", "{}")
  zip.file("small.png", Buffer.alloc(1024), { binary: true })
  const fine = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  assert.deepEqual(acceptArchive(fine, "測定", { assets: MEASURED_LIMIT }), [])
})

test("出荷する上限が、正当な作品を弾かない大きさである", async () => {
  // 仕掛けの検査は自分の数で測るので、**出荷する値そのものは別に守る**。下限は現象から
  // 引く ── Scratch 自身が素材 1 件を 10 MB まで許すので、最大の素材が数件入る作品は
  // 正当である。ここを下回る値へ縮めると、Scratch が受け取る作品を弾く線になる
  const scratchPerAsset = 10 * 1024 * 1024
  assert.ok(
    ASSET_TOTAL_LIMIT >= scratchPerAsset * 10,
    `出荷する上限 ${ASSET_TOTAL_LIMIT} が、最大の素材 10 件ぶんを下回る`,
  )
})

test("展開しながらも上限で止まる", async () => {
  // 受け入れ検査は名乗りを見るだけで、名乗りは攻撃者が書ける。展開する側にも砦が要る
  const zip = new JSZip()
  zip.file("project.json", "{}")
  zip.file("a.png", Buffer.alloc(4096), { binary: true })
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  await assert.rejects(
    () => openAssets(bytes, ["a.png"], { total: 1024 }),
    /素材が大きすぎる/,
  )
  // 同じ入力が、上限を上げれば通ることも見る
  const { assets } = await openAssets(bytes, ["a.png"], { total: 8192 })
  assert.equal(assets.get("a.png")?.length, 4096)
})

test("zip に無い素材は、落とした名前として返る", async () => {
  const bytes = await sb3Of(projectWith(FOUR_FORMATS, FOUR_BODIES))
  const { assets, missing } = await openAssets(bytes, ["00000000000000000000000000000000.png"])
  assert.equal(assets.size, 0)
  assert.deepEqual(missing, ["00000000000000000000000000000000.png"])
})

test("読み取りが書き出した素材が、元のバイト列と一致する", async () => {
  const bodies = FOUR_BODIES
  const bytes = await sb3Of(projectWith(FOUR_FORMATS, bodies))
  const reading = await readSb3(bytes, "測定")
  const wanted = reading.targets.flatMap(target =>
    [...target.shown.costumes, ...target.shown.sounds].map(asset => asset.file),
  )
  const { assets } = await openAssets(bytes, wanted)

  // 取り出したバイト列を、置いた実ファイルと突き合わせる。md5 の名前どうしで比べると、
  // 名前が中身から出ている以上いつでも一致してしまい、何も測らない
  const placed = Object.values(bodies).map(body => body.toString("base64")).sort()
  const taken = [...assets.values()].map(body => body.toString("base64")).sort()
  // 既定の背景が 1 件増える。置いた素材がすべて含まれることを見る
  for (const body of placed) {
    assert.ok(taken.includes(body), "置いた素材のバイト列が取り出せていない")
  }
})

test("zip に素材が無い .sb3 でも、書き出した定義が実在しないファイルを指さない", async () => {
  // 公式検証器は素材の欠落を通す（FEAT0003 が申告している）ので、この形の .sb3 は実在する。
  // 定義だけが名前を残すと、読み手はそれを組み立てられる入力だと思って `build` へ渡す
  const zip = new JSZip()
  zip.file(
    "project.json",
    JSON.stringify({
      targets: [
        {
          isStage: true, name: "Stage", variables: {}, lists: {}, broadcasts: {}, blocks: {},
          currentCostume: 0, volume: 100, layerOrder: 0, tempo: 60,
          videoTransparency: 50, videoState: "on", textToSpeechLanguage: null,
          costumes: [
            {
              assetId: "0".repeat(32), name: "無い絵", md5ext: `${"0".repeat(32)}.svg`,
              dataFormat: "svg", rotationCenterX: 0, rotationCenterY: 0,
            },
          ],
          sounds: [],
        },
      ],
      extensions: [],
      meta: { semver: "3.0.0", vm: "0.2.0", agent: "" },
    }),
  )
  const bytes = await zip.generateAsync({ type: "nodebuffer" })

  // 素材が本当に入っていないことを先に見る。入っていたら、この検査は何も測らない
  const { assets, missing } = await openAssets(bytes, [`${"0".repeat(32)}.svg`])
  assert.equal(assets.size, 0, "素材が入っている .sb3 を測っている")
  assert.deepEqual(missing, [`${"0".repeat(32)}.svg`])

  // 読み取りの成果物を作る経路（`read`）と同じ順で組み、書き出した定義を確かめる
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-lost-"))
  const code = await import("../src/cli.ts").then(cli =>
    cli.main(["read", writeSb3(dir, bytes), "--out", join(dir, "out")]),
  )
  // **落としたので 1 を返す。** 図の欠落と同じ扱いにしてある（CP6 で 5 観点が、素材だけ
  // 0 を返すのは逆だと指摘した）。0 を期待していたのは、その扱いを直す前の姿である
  assert.equal(code, 1, "素材を落としたのに成功で終わった")

  // 読めた側は書き出す。落としたことと、読めたものを捨てることは別である
  const written = readFileSync(join(dir, "out", "project.yaml"), "utf8")
  assert.doesNotMatch(written, /00000000000000000000000000000000/, "無い素材を定義が指している")
})

/** バイト列を .sb3 として置き、その綴りを返す */
function writeSb3(dir: string, bytes: Buffer): string {
  const path = join(dir, "input.sb3")
  writeFileSync(path, bytes)
  return path
}

/**
 * 名前をそのまま収める zip をバイト列で組む。圧縮はしない（stored）。
 *
 * **JSZip の書き込み側は名前を正規化する**ので、`../` を含む名前の zip を作れない
 * （2026-09-04 実測。`../../../x.txt` が `x.txt` として収まった）。攻撃者は自前の道具で
 * 作れるため、守りを測るにはこちらも自前で組む必要がある。
 */
function rawZip(entries: { name: string; body: Buffer }[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const sum = crc32(entry.body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(entry.body.length, 18)
    local.writeUInt32LE(entry.body.length, 22)
    local.writeUInt16LE(name.length, 26)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt32LE(sum, 16)
    head.writeUInt32LE(entry.body.length, 20)
    head.writeUInt32LE(entry.body.length, 24)
    head.writeUInt16LE(name.length, 28)
    head.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([head, name]))
    parts.push(Buffer.concat([local, name]), entry.body)
    offset += 30 + name.length + entry.body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

test("書き出し先の外を指す素材の名前を、こちらの側で落とす", async () => {
  const evil = "../../../slipped.txt"
  const bytes = rawZip([
    {
      name: "project.json",
      body: Buffer.from(
        JSON.stringify({
          targets: [
            {
              isStage: true, name: "Stage", variables: {}, lists: {}, broadcasts: {}, blocks: {},
              currentCostume: 0, volume: 100, layerOrder: 0, tempo: 60,
              videoTransparency: 50, videoState: "on", textToSpeechLanguage: null,
              costumes: [
                { assetId: "0".repeat(32), name: "x", md5ext: evil, dataFormat: "svg",
                  rotationCenterX: 0, rotationCenterY: 0 },
              ],
              sounds: [],
            },
          ],
          extensions: [],
          meta: { semver: "3.0.0", vm: "0.2.0", agent: "" },
        }),
        "utf8",
      ),
    },
    { name: evil, body: Buffer.from("すり抜けた\n", "utf8") },
  ])

  // 逃げ道を通さないと検証器が弾く。**弾かれる経路だけを測ると、旗を立てた側が素通しでも
  // 緑になる**ので、旗を立てて測る
  const reading = await readSb3(bytes, "測定", { anyway: true })
  const target = reading.targets[0]
  assert.deepEqual(target.shown.costumes, [], "形を満たさない名前を作品定義へ載せている")
  assert.equal(target.shown.dropped.length, 1, "落としたことを数えていない")

  // 落とした綴りが申告に載ることも見る。黙って落とすと、絵が消えた理由が誰にも分からない
  assert.match(target.shown.dropped[0], /slipped/, "落とした綴りを持っていない")
})

test("正しい形の名前は落とさない", async () => {
  // 弾く側だけを測ると、全部を落とす実装でも緑になる
  const reading = await readSb3(await sb3Of(projectWith(FOUR_FORMATS, FOUR_BODIES)), "測定")
  for (const target of reading.targets) {
    assert.deepEqual(target.shown.dropped, [], "正しい名前を落としている")
  }
  const sprite = reading.targets.find(t => !t.isStage)!
  assert.equal(sprite.shown.costumes.length, 2, "コスチュームが 2 件で無い")
  assert.equal(sprite.shown.sounds.length, 2, "音が 2 件で無い")
})

test("素材の大きさは、書き出す量の上限に合算されない", async () => {
  // Scratch は素材 1 件を 10 MB まで許す。合算すると、自分の生成器が作った作品を
  // 自分の読み取りが読めなくなる（CP6 で 6 観点が指摘し、6 MB で実測した）
  const big = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">` +
      `<rect width="48" height="48" fill="#4c97ff"/><!--${" ".repeat(6 * 1024 * 1024)}--></svg>`,
    "utf8",
  )
  const dir = projectWith(
    [
      "名前: 大",
      "スプライト:",
      "  - 名前: ネコ",
      "    スクリプト: main.sbk",
      "    コスチューム:",
      "      - ファイル: big.svg",
      "",
    ].join("\n"),
    { "big.svg": big },
  )
  const bytes = await sb3Of(dir)
  // 入力が本当に上限を超えていることを先に見る。超えていなければ何も測らない
  assert.ok(big.length > 5 * 1024 * 1024, "検査の入力が上限を超えていない")

  const out = mkdtempSync(join(tmpdir(), "gen-scratch-big-"))
  const cli = await import("../src/cli.ts")
  const code = await cli.main(["read", writeSb3(out, bytes), "--out", join(out, "read")])
  assert.equal(code, 0, "素材の大きさで読み取りが止まった")
  assert.ok(
    readFileSync(join(out, "read", "project.yaml"), "utf8").includes("コスチューム"),
    "作品定義が書かれていない",
  )
})

test("素材を落としたら、終了コードが 0 にならない", async () => {
  // 図の欠落は 1 を返すのに素材だけ 0 を返していた。素材 1 件の破損で全素材が消えても
  // 成功で終わっていた（CP6 の再評価層が実測）
  const bytes = await sb3Of(projectWith(FOUR_FORMATS, FOUR_BODIES))
  const zip = await JSZip.loadAsync(bytes)
  const project = JSON.parse(await zip.file("project.json")!.async("string"))
  // project.json は素材を名乗るのに、zip からは 1 件抜いておく
  const target = (project.targets as ReadTarget[]).find(t => !t.isStage)!
  const gone = String(target.costumes[0].md5ext)
  zip.remove(gone)
  zip.file("project.json", JSON.stringify(project))
  const broken = await zip.generateAsync({ type: "nodebuffer" })

  const out = mkdtempSync(join(tmpdir(), "gen-scratch-lost-"))
  const cli = await import("../src/cli.ts")
  const code = await cli.main(["read", writeSb3(out, broken), "--out", join(out, "read")])
  assert.equal(code, 1, "素材を落としたのに成功で終わった")

  // 作品定義が、置かれていない素材を指していないことも見る
  const written = readFileSync(join(out, "read", "project.yaml"), "utf8")
  assert.ok(!written.includes(gone), "書いていない素材を定義が指している")
})

test("`md5ext` を持たない素材も、必須欄から名前を組んで写す", async () => {
  // schema の required は assetId / dataFormat / name で md5ext を含まない
  const bytes = await sb3Of(projectWith(FOUR_FORMATS, FOUR_BODIES))
  const zip = await JSZip.loadAsync(bytes)
  const project = JSON.parse(await zip.file("project.json")!.async("string"))
  const target = (project.targets as ReadTarget[]).find(t => !t.isStage)!
  const kept = String(target.costumes[0].md5ext)
  delete target.costumes[0].md5ext
  zip.file("project.json", JSON.stringify(project))
  const bare = await zip.generateAsync({ type: "nodebuffer" })

  const reading = await readSb3(bare, "測定")
  const sprite = reading.targets.find(t => !t.isStage)!
  assert.equal(sprite.shown.dropped.length, 0, "md5ext が無いだけで落としている")
  assert.equal(sprite.shown.costumes[0].file, kept, "必須欄から名前を組めていない")
})

test("拡張子が形式の一覧に無い素材は書き出さない", async () => {
  // 公式検証器の md5ext の pattern は任意の英字拡張子を許すので、旗なしで通る
  const evil = "0".repeat(32) + ".exe"
  const bytes = rawZip([
    {
      name: "project.json",
      body: Buffer.from(
        JSON.stringify({
          targets: [
            {
              isStage: true, name: "Stage", variables: {}, lists: {}, broadcasts: {}, blocks: {},
              currentCostume: 0, volume: 100, layerOrder: 0, tempo: 60,
              videoTransparency: 50, videoState: "on", textToSpeechLanguage: null,
              costumes: [
                { assetId: "0".repeat(32), name: "x", md5ext: evil, dataFormat: "svg",
                  rotationCenterX: 0, rotationCenterY: 0 },
              ],
              sounds: [],
            },
          ],
          extensions: [],
          meta: { semver: "3.0.0", vm: "0.2.0", agent: "" },
        }),
        "utf8",
      ),
    },
    { name: evil, body: Buffer.from("MZ", "utf8") },
  ])

  const reading = await readSb3(bytes, "測定")
  assert.deepEqual(reading.targets[0].shown.costumes, [], ".exe を作品定義へ載せている")
  assert.equal(reading.targets[0].shown.dropped.length, 1, "落としたことを数えていない")

  const out = mkdtempSync(join(tmpdir(), "gen-scratch-exe-"))
  const cli = await import("../src/cli.ts")
  await cli.main(["read", writeSb3(out, bytes), "--out", join(out, "read")])
  assert.ok(
    !readdirSync(join(out, "read")).some(name => name.endsWith(".exe")),
    ".exe が書き出し先へ置かれた",
  )
})

test("落とした素材に合わせて、今のコスチュームの番号が動く", async () => {
  const bytes = await sb3Of(projectWith(FOUR_FORMATS, FOUR_BODIES))
  const zip = await JSZip.loadAsync(bytes)
  const project = JSON.parse(await zip.file("project.json")!.async("string"))
  const target = (project.targets as ReadTarget[]).find(t => !t.isStage)!
  // 1 枚目を落とさせる（形式の一覧に無い拡張子にする）。2 枚目を指したままにする
  target.costumes[0].md5ext = "0".repeat(32) + ".exe"
  target.currentCostume = 1
  zip.file("project.json", JSON.stringify(project))
  const shifted = await zip.generateAsync({ type: "nodebuffer" })

  const reading = await readSb3(shifted, "測定")
  const sprite = reading.targets.find(t => !t.isStage)!
  assert.equal(sprite.shown.costumes.length, 1, "落とせていない")
  // 2 枚目が 1 枚だけの並びの 1 番目になる。1 を足すだけだと 2 のまま範囲の外へ出る
  assert.equal(sprite.shown.current, 1, "番号が落とした件数に追随していない")
})

test("追跡下の作品が、同じバイト列を出し続ける", async () => {
  // **素材を書かない作品の出力を動かさない**という不変条件を、退行として押さえる。
  // 手で測って確かめただけでは、次に触った人が動かしたことに気づけない。
  //
  // 期待値は追跡下の md5 を写さず、**同じ入力を 2 度組んで一致すること**と、
  // **素材を書かない作品には自前の四角しか入らないこと**で測る。前者は決定論、後者は
  // 「既定の素材が増えていない」を見る
  for (const name of ["sen-o-hiku", "neko-to-score"]) {
    const dir = `projects/${name}`
    const one = await sb3Of(dir)
    const two = await sb3Of(dir)
    assert.deepEqual(two, one, `${name} が同じ入力から違うバイト列を出した`)
  }

  // `sen-o-hiku` は素材を 1 つも書かない。ターゲット 2 つぶんの既定の四角だけが入る
  const bare = await carried(await sb3Of("projects/sen-o-hiku"))
  assert.equal(bare.names.length, 2, "素材を書かない作品に余分な素材が入っている")
  for (const target of bare.shown) {
    assert.equal(target.costumes.length, 1, "既定のコスチュームが 1 種で無い")
    assert.equal(target.sounds.length, 0, "書いていない音が入っている")
  }

  // `neko-to-score` は素材を書く。書いた分が入っていることも見る ── 両方が同じ形なら、
  // 上の検査は「素材を扱えていない」実装でも緑になる
  const withAssets = await carried(await sb3Of("projects/neko-to-score"))
  assert.equal(withAssets.names.length, 3, "追跡下の作品の素材が入っていない")
})

test("復元しない属性から、素材の 3 欄が消える", async () => {
  const reading = await readSb3(await sb3Of(projectWith(FOUR_FORMATS, FOUR_BODIES)), "測定")
  for (const field of ["costumes", "sounds", "currentCostume"]) {
    assert.ok(
      !reading.unrestored.includes(field),
      `${field} が「復元しない」に残っている`,
    )
  }
  // 一覧そのものが空になっていないことも見る。空なら上の 3 つは何も測らない
  assert.ok(reading.unrestored.length > 0, "復元しない属性が 1 件も無い")
})
