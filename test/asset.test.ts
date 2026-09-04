import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import { Resvg } from "@resvg/resvg-js"
import {
  BITMAP_RESOLUTION_FALLBACK,
  COSTUME_FORMATS,
  DERIVABLE_FORMATS,
  SOUND_FORMATS,
  SVG_RESOLUTION,
} from "../src/definition.ts"
import {
  costumeOf,
  defaultResolutionOf,
  formatOf,
  pngSize,
  soundOf,
  stemOf,
  svgBox,
  wavSpec,
} from "../src/asset.ts"

const require = createRequire(import.meta.url)

/**
 * 公式検証器が抱える schema。認める形式の出典である。
 *
 * 一覧を手で写している以上、上流が動けば古びる。写しであることを隠さず、実物と突き合わせる。
 */
const SCHEMA = require("scratch-parser/lib/sb3_definitions.json")

/** 検査用の無音 WAV を組む。単声・16 ビット */
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

/** 寸法を指定した SVG を組む */
function svgOf(width: number, height: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" fill="#123456"/></svg>`,
    "utf8",
  )
}

/** 寸法を指定した PNG を組む。描画は resvg に任せる */
function pngOf(width: number, height: number): Buffer {
  return Buffer.from(new Resvg(svgOf(width, height).toString("utf8")).render().asPng())
}

test("認める形式が、公式検証器の schema と一致する", () => {
  // 写しなので上流が動けば古びる。等号で見るので、足しすぎても落ちる
  assert.deepEqual(
    [...COSTUME_FORMATS].sort(),
    [...SCHEMA.definitions.costume.properties.dataFormat.enum].sort(),
    "コスチュームの形式が schema と食い違う",
  )
  assert.deepEqual(
    [...SOUND_FORMATS].sort(),
    [...SCHEMA.definitions.sound.properties.dataFormat.enum].sort(),
    "音の形式が schema と食い違う",
  )
})

test("導けると名乗る形式は、実際に導ける", () => {
  // 一覧と実装が割れると、「導ける」と名乗るのに属性が出ない形式が生まれる。
  // 実物を通して確かめる ── 名乗りだけを読んでも、割れていることは見えない
  const bodies: Record<string, Buffer> = {
    png: pngOf(8, 6),
    svg: svgOf(8, 6),
    wav: silentWav(11025, 4),
  }
  assert.deepEqual(
    [...DERIVABLE_FORMATS].sort(),
    Object.keys(bodies).sort(),
    "導ける形式の一覧と、検査が用意した入力が食い違う",
  )

  for (const format of DERIVABLE_FORMATS) {
    const file = `a.${format}`
    const built =
      format === "wav" ? soundOf(file, {}, bodies[format]) : costumeOf(file, {}, bodies[format])
    assert.ok(!("missing" in built), `${format} から属性を導けていない`)
  }
})

test("導けない形式は、書かれていない属性の名前を返す", () => {
  const costume = costumeOf("a.jpg", {}, Buffer.from("not really a jpeg"))
  assert.deepEqual(
    "missing" in costume ? costume.missing : [],
    ["rotationCenterX", "rotationCenterY"],
    "jpg で足りない属性の名前が出ない",
  )

  const sound = soundOf("a.mp3", {}, Buffer.from([0xff, 0xfb, 0x90, 0x00]))
  assert.deepEqual(
    "missing" in sound ? sound.missing : [],
    ["rate", "sampleCount"],
    "mp3 で足りない属性の名前が出ない",
  )
})

test("導けない形式でも、書いてあれば通る", () => {
  const costume = costumeOf(
    "a.jpg",
    { rotationCenterX: 10, rotationCenterY: 20 },
    Buffer.from("bytes"),
  )
  assert.ok(!("missing" in costume))
  assert.equal(costume.costume.rotationCenterX, 10)
  assert.equal(costume.costume.dataFormat, "jpg")

  const sound = soundOf("a.mp3", { rate: 44100, sampleCount: 100 }, Buffer.from("bytes"))
  assert.ok(!("missing" in sound))
  assert.equal(sound.sound.rate, 44100)
})

test("書かれた属性が、導いた値より優先される", () => {
  // 往復では出典の値をそのまま写す。導出が勝つと、元と違う .sb3 が出る
  const costume = costumeOf("a.png", { rotationCenterX: 1, rotationCenterY: 2 }, pngOf(64, 40))
  assert.ok(!("missing" in costume))
  assert.equal(costume.costume.rotationCenterX, 1, "書いた値が導出に上書きされた")
  assert.equal(costume.costume.rotationCenterY, 2)

  const sound = soundOf("a.wav", { rate: 8000, sampleCount: 3 }, silentWav(22050, 8))
  assert.ok(!("missing" in sound))
  assert.equal(sound.sound.rate, 8000, "書いた値が導出に上書きされた")
  assert.equal(sound.sound.sampleCount, 3)
})

test("PNG の寸法を IHDR から読む", () => {
  // 期待値は描かせた寸法。実装の戻りから作らない
  assert.deepEqual(pngSize(pngOf(64, 40)), { width: 64, height: 40 })
  assert.deepEqual(pngSize(pngOf(1, 1)), { width: 1, height: 1 })
})

test("PNG でないバイト列を PNG として読まない", () => {
  assert.equal(pngSize(Buffer.from("not a png at all, really no")), null)
  // 目印だけ合っていて中身が続かない入力で、範囲の外を読んで落ちないことも見る
  assert.equal(pngSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null)
  assert.equal(pngSize(Buffer.alloc(0)), null)
})

test("SVG の枠を取る。viewBox があればその座標系で読む", () => {
  // 寸法だけの SVG は原点 0
  assert.deepEqual(svgBox(svgOf(48, 32)), { x: 0, y: 0, width: 48, height: 32 })
  // viewBox しか持たない SVG も解ける
  assert.deepEqual(
    svgBox(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"/>')),
    { x: 0, y: 0, width: 120, height: 90 },
  )
  // **原点を持つ viewBox。** Scratch は回転の中心をこの座標系で読む
  assert.deepEqual(
    svgBox(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 100 60"/>')),
    { x: 10, y: 20, width: 100, height: 60 },
  )
  // width と viewBox が別の尺度なら viewBox を採る（Scratch が見るのはそちら）
  assert.deepEqual(
    svgBox(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 100 60"/>')),
    { x: 0, y: 0, width: 100, height: 60 },
  )
})

test("枠を宣言しない SVG からは、既定値で枠を作らない", () => {
  // resvg は既定の 100x100 を返すが、そこから回転の中心を作ると絵が明後日の位置を軸に回る
  assert.equal(svgBox(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
})

test("SVG として解けないバイト列は枠を返さない", () => {
  assert.equal(svgBox(Buffer.from("<not-svg>")), null)
})

test("WAV のサンプルの率と数を読む", () => {
  // 期待値は組んだときの値。実装の戻りから作らない
  assert.deepEqual(wavSpec(silentWav(22050, 8)), { rate: 22050, sampleCount: 8 })
  assert.deepEqual(wavSpec(silentWav(44100, 0)), { rate: 44100, sampleCount: 0 })
})

test("WAV として読めないバイト列は返さない", () => {
  assert.equal(wavSpec(Buffer.from("RIFFxxxxNOPE")), null)
  assert.equal(wavSpec(Buffer.alloc(0)), null)
  // 塊が自分の名乗りより長い入力で、範囲の外を読まない
  const lying = silentWav(22050, 8)
  lying.writeUInt32LE(0xffff, 40)
  assert.equal(wavSpec(lying), null)
})

test("回転の中心は絵の真ん中になる", () => {
  const built = costumeOf("neko.png", {}, pngOf(64, 40))
  assert.ok(!("missing" in built))
  assert.equal(built.costume.rotationCenterX, 32)
  assert.equal(built.costume.rotationCenterY, 20)
})

test("SVG の回転の中心は viewBox の原点を足した値になる", () => {
  // Scratch は回転の中心を viewBox の座標系で読み、scratch-render が原点を引いて描画へ
  // 渡す（`SVGSkin.js`）。原点を無視すると絵が明後日の位置を軸に回る
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 100 60"/>')
  const built = costumeOf("a.svg", {}, svg)
  assert.ok(!("missing" in built))
  assert.equal(built.costume.rotationCenterX, 60, "原点を足していない")
  assert.equal(built.costume.rotationCenterY, 50, "原点を足していない")
})

test("解像度の既定は、素材を拡大しないので 1 である", () => {
  // **実機で確かめて 1 に戻した値である**（2026-09-04）。scratch-vm は取り込み時に 2 を
  // 立てるが、同じ経路で絵を 2 倍へ拡大している。こちらは拡大しないので、2 にすると絵が
  // 半分の大きさで出る（48×48 の PNG と SVG を並べて Scratch エディタで実測）
  const bitmap = costumeOf("a.png", {}, pngOf(8, 8))
  assert.ok(!("missing" in bitmap))
  assert.equal(bitmap.costume.bitmapResolution, 1, "ビットマップの既定が 1 でない")

  const vector = costumeOf("a.svg", {}, svgOf(8, 8))
  assert.ok(!("missing" in vector))
  assert.equal(vector.costume.bitmapResolution, 1, "svg の既定が 1 でない")
})

test("解像度の既定は、形式ごとに別の定数から来る", () => {
  // 今は同じ値だが、片方を動かしたときにもう片方が巻き添えにならないことを見る。
  // 値の一致だけを測ると、1 つの定数を共有する実装でも緑になる
  assert.equal(defaultResolutionOf("png"), BITMAP_RESOLUTION_FALLBACK)
  assert.equal(defaultResolutionOf("svg"), SVG_RESOLUTION)
})

test("呼び名は書いた名前、無ければファイル名の幹", () => {
  const named = costumeOf("a/neko.png", { 名前: "ネコ" }, pngOf(2, 2))
  assert.ok(!("missing" in named))
  assert.equal(named.costume.name, "ネコ")

  const bare = costumeOf("a/neko.png", {}, pngOf(2, 2))
  assert.ok(!("missing" in bare))
  assert.equal(bare.costume.name, "neko")
})

test("同じ中身からは同じ ID が出て、中身が変わると変わる", () => {
  const one = costumeOf("a.png", {}, pngOf(8, 8))
  const same = costumeOf("b.png", {}, pngOf(8, 8))
  const other = costumeOf("a.png", {}, pngOf(8, 9))
  assert.ok(!("missing" in one) && !("missing" in same) && !("missing" in other))
  assert.equal(one.costume.assetId, same.costume.assetId, "同じ中身で ID が割れた")
  assert.notEqual(one.costume.assetId, other.costume.assetId, "違う中身で ID が同じ")
  assert.match(one.costume.md5ext, /^[0-9a-f]{32}\.png$/)
})

test("形式と幹の取り出しが、大文字と入れ子の綴りを扱う", () => {
  assert.equal(formatOf("NYA.WAV"), "wav")
  assert.equal(formatOf("noext"), "")
  assert.equal(stemOf("sub/dir/neko.png"), "neko")
  assert.equal(stemOf("neko"), "neko")
  // 先頭の点はディレクトリを持たない隠しファイル。幹を空にしない
  assert.equal(stemOf(".hidden"), ".hidden")
})
