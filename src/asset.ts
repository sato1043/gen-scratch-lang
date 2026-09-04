/**
 * 利用者が用意した素材を取り込み、書かれていない属性を中身から導く。
 *
 * 自前で作る既定のコスチュームは `costume.ts` が持つ。あちらは「素材を書かないときの
 * 四角」で、こちらは「書かれた素材」を扱う。責務が違うので分けてある。
 *
 * **ファイルを読まない。** 受け取るのはバイト列だけで、置き場所を知らない。読み書きは
 * 組み立ての側（`project.ts`）が持つ。分けておくと、導出の検査が仮のディレクトリを
 * 作らずに書ける。
 *
 * `assetId` は素材の中身の md5 である（`costume.ts` と同じ規則）。中身から導くので、
 * 同じ入力からは同じ ID になり決定論を保つ。
 */
import { createHash } from "node:crypto"
import { Resvg } from "@resvg/resvg-js"
import {
  BITMAP_RESOLUTION_FALLBACK,
  DERIVABLE_FORMATS,
  SVG_RESOLUTION,
  asMapping,
} from "./definition.ts"
import type { Costume } from "./costume.ts"

/** 絵の枠。原点を持つ ── Scratch は SVG を `viewBox` の座標系で読む */
export type Box = { x: number; y: number; width: number; height: number }

/** 音 1 つ分。欄は公式検証器の schema に合わせる */
export type Sound = {
  /** 中身の md5 */
  assetId: string
  name: string
  /** zip に収めるときのファイル名 */
  md5ext: string
  dataFormat: string
  /** 1 秒あたりのサンプル数 */
  rate: number
  /** サンプルの総数 */
  sampleCount: number
}

/** 素材の綴りから形式を取る。大文字小文字は畳む */
export function formatOf(file: string): string {
  const dot = file.lastIndexOf(".")
  return dot < 0 ? "" : file.slice(dot + 1).toLowerCase()
}

/**
 * 素材の綴りから呼び名を取る。ディレクトリと拡張子を落とした幹。
 *
 * 区切りは `/` だけを見る。定義の綴りは `/` で書く約束で、`\` は組み立ての前に止まる。
 */
export function stemOf(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? name : name.slice(0, dot)
}

/**
 * WAV の中身が素の PCM であることを示す値。
 *
 * 出典は RIFF WAVE の `fmt ` の先頭 2 バイト（`wFormatTag`）。圧縮された形式では
 * `data` の長さと標本数が比例しないので、こちらは導出の対象にしない。
 */
const WAVE_FORMAT_PCM = 1

/** PNG の目印。先頭 8 バイトに置かれる */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * PNG の寸法を IHDR から読む。読めなければ null。
 *
 * IHDR は必ず先頭の塊で、位置が決まっている（PNG 仕様 11.2.2「IHDR shall be the first
 * chunk」）。塊を歩かずに済むので、走査の費用が入力の大きさに依らない。
 */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  // 24 バイトは目印 8 + 塊の長さ 4 + 種別 4 + 幅 4 + 高さ 4。ここを見ないと
  // `readUInt32BE` が範囲の外で投げる
  if (bytes.length < 24) return null
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  // 0 は PNG として不正である（仕様は 1 以上を求める）。通すと回転の中心が 0 になり、
  // 絵の左上を中心に置いた作品が黙って出る
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/**
 * SVG の絵の枠を取る。読めなければ null。
 *
 * **Scratch は `viewBox` の座標系で読む。** コスチュームの回転の中心はその座標系の値で、
 * scratch-render（`SVGSkin.js`）が原点を引いて描画へ渡す。だから枠は原点を持つ ──
 * `viewBox="10 20 100 60"` の絵の真ん中は (60, 50) であって (50, 30) ではない。
 *
 * `viewBox` を持たない SVG では、描画したときの画素数を枠にする（原点は 0）。寸法も
 * `viewBox` も持たない SVG では resvg が既定の 100×100 を返すので、**枠として使えない
 * ものとして null を返す** ── 任意の値から回転の中心を作ると、Scratch で絵が明後日の
 * 位置を軸に回る（CP6 で移植性が指摘）。
 *
 * 解決そのものは描画に使っているのと同じ実装（resvg）へ委ねる。単位付き・百分率も解ける
 * ことを実測した（2026-09-04）。自前で解くと、図を描く側と寸法の読みが割れる。
 */
export function svgBox(bytes: Buffer): Box | null {
  const text = bytes.toString("utf8")
  const view = viewBoxOf(text)
  if (view) return view
  try {
    const { width, height } = new Resvg(text)
    if (!(width > 0) || !(height > 0)) return null
    // 寸法を宣言しない SVG では resvg が既定値を返す。既定値から中心を作らない
    if (!/<svg[^>]*\s(width|height)\s*=/i.test(text)) return null
    return { x: 0, y: 0, width, height }
  } catch {
    // 解けない SVG は枠を持たない。ここで投げると、1 つの素材の誤りが組み立て全体を
    // 止める。呼ぶ側が「導けなかった」として申告へ落とす
    return null
  }
}

/**
 * 根の `<svg>` の `viewBox` を読む。無ければ null。
 *
 * 見るのは根の開始タグの中だけである。全文を正規表現で走らせると、入れ子の `<svg>` や
 * コメントの中の綴りを拾う。値は「min-x min-y width height」の 4 つで、区切りは空白か
 * カンマ（SVG 1.1 の 7.7）。
 */
function viewBoxOf(text: string): Box | null {
  const open = text.match(/<svg\b[^>]*>/i)
  if (!open) return null
  const found = open[0].match(/\bviewBox\s*=\s*["']([^"']*)["']/i)
  if (!found) return null
  const parts = found[1].trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) return null
  const [x, y, width, height] = parts
  if (!(width > 0) || !(height > 0)) return null
  return { x, y, width, height }
}

/**
 * WAV のサンプルの率と数を読む。読めなければ null。
 *
 * RIFF の塊を先頭から歩く。`fmt ` が声の数と量子化の幅を、`data` が中身の長さを持つので、
 * 総数は `data` の長さを 1 標本ぶんの幅で割って出す。
 *
 * 塊の長さが自分の名乗りより長い入力では、範囲の外を読まずに null を返す。中身は他人の
 * .sb3 から来ることがあり、名乗りを信じると走査が壊れる。
 */
export function wavSpec(bytes: Buffer): { rate: number; sampleCount: number } | null {
  // 12 バイトは `RIFF` 4 + 全体の長さ 4 + `WAVE` 4
  if (bytes.length < 12) return null
  if (bytes.toString("ascii", 0, 4) !== "RIFF") return null
  if (bytes.toString("ascii", 8, 12) !== "WAVE") return null

  let rate = 0
  let channels = 0
  let bits = 0
  let at = 12
  // 塊の見出しは 8 バイト（種別 4 + 長さ 4）
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4)
    const size = bytes.readUInt32LE(at + 4)
    const body = at + 8
    if (body + size > bytes.length) return null

    if (id === "fmt ") {
      // 16 バイトは PCM の最小。これを下回る `fmt ` は読めない
      if (size < 16) return null
      // **PCM 以外は読まない。** 圧縮された形式では `data` の長さから標本数を割り出せず、
      // 割ると桁違いの値が出る。導けないものは導けないとして返す（CP6 の指摘）
      if (bytes.readUInt16LE(body) !== WAVE_FORMAT_PCM) return null
      channels = bytes.readUInt16LE(body + 2)
      rate = bytes.readUInt32LE(body + 4)
      bits = bytes.readUInt16LE(body + 14)
    }
    if (id === "data") {
      const frame = channels * (bits / 8)
      // `fmt ` を見ないまま `data` に当たると 0 になる。割ると Infinity が出るので止める
      if (!(frame > 0) || !(rate > 0)) return null
      return { rate, sampleCount: Math.floor(size / frame) }
    }
    // 塊は偶数の境界に揃う。奇数長の塊の後ろには詰め物が 1 バイト入る
    at = body + size + (size % 2)
  }
  return null
}

/**
 * 形式と中身から寸法を取る。導けない形式は null。
 *
 * 導ける形式の一覧（`DERIVABLE_FORMATS`）と、ここで分岐する形式を揃える。片方だけを
 * 足すと、一覧が「導ける」と名乗るのに実際は導かない状態になる。検査が両者を照合する。
 */
export function boxOf(format: string, bytes: Buffer): Box | null {
  if (format === "png") {
    const size = pngSize(bytes)
    return size === null ? null : { x: 0, y: 0, ...size }
  }
  if (format === "svg") return svgBox(bytes)
  return null
}

/**
 * 欠けていると組み立てられない属性。導出か明示のどちらかで埋まる必要がある。
 *
 * **1 か所で持つ。** 組む側（`costumeOf` / `soundOf`）と、中身を読まずに先回りする側
 * （`checkAssets`）が同じ一覧を見る。割ると、片方だけが「書かなくてよい」と判定する。
 *
 * `bitmapResolution` は入れない ── 既定値を持つので欠けても組み立てられる。
 */
export const COSTUME_REQUIRED = ["rotationCenterX", "rotationCenterY"]
export const SOUND_REQUIRED = ["rate", "sampleCount"]

/**
 * 形式ごとの `bitmapResolution` の既定。
 *
 * 分岐を 1 か所で持つ ── 値を 2 か所へ書くと、片方だけを直したときに SVG が巻き添えで
 * 半分の大きさになる（CP6 で 4 観点が「svg にも無条件に当たる」と指摘）。
 *
 * 今はどちらも 1 だが、**参照する定数を分けたままにする**。ビットマップ側を動かす理由は
 * SVG に掛からない。
 */
export function defaultResolutionOf(format: string): number {
  return format === "svg" ? SVG_RESOLUTION : BITMAP_RESOLUTION_FALLBACK
}

/** 中身から md5 を出し、zip に収める名前を組む */
function identify(bytes: Buffer, format: string): { assetId: string; md5ext: string } {
  const assetId = createHash("md5").update(bytes).digest("hex")
  return { assetId, md5ext: `${assetId}.${format}` }
}

/**
 * 書かれた値を数として読む。書かれていなければ undefined。
 *
 * 型の検査は定義の側（`checkAssets`）が済ませている。ここでは書かれたかどうかだけを見る。
 */
function written(item: Record<string, unknown> | null, key: string): number | undefined {
  const value = item?.[key]
  return typeof value === "number" ? value : undefined
}

/**
 * 要る属性を 明示 > 導出 の順に埋める。埋まらないものがあればその名前を返す。
 *
 * 一覧を回すのは、集める側と使う側が同じ一覧を見るようにするためである。1 つずつ書くと、
 * 一覧へ足したときに片方だけが古びる。
 */
function fill(
  fields: Record<string, unknown> | null,
  required: string[],
  derived: Record<string, number | undefined>,
): { values: Record<string, number> } | { missing: string[] } {
  const values: Record<string, number> = {}
  const missing: string[] = []
  for (const key of required) {
    const value = written(fields, key) ?? derived[key]
    if (value === undefined) missing.push(key)
    else values[key] = value
  }
  return missing.length > 0 ? { missing } : { values }
}

/**
 * コスチューム 1 つを組む。属性は 明示 > 導出 の順に決める。
 *
 * 導けず書かれてもいない属性があれば、その名前を `missing` で返す。呼ぶ側が申告にする
 * ── ここで申告の形にすると、素材のモジュールが申告の綴りを知ることになる。
 *
 * `file` は定義に書かれた綴り、`item` は定義の項、`bytes` は素材の中身。
 */
export function costumeOf(
  file: string,
  item: unknown,
  bytes: Buffer,
): { costume: Costume } | { missing: string[] } {
  const fields = asMapping(item)
  const format = formatOf(file)
  // **書かれているなら中身を読まない。** 導出は他人のバイト列を native の解析器へ渡すので、
  // 要らないときに払う費用でも通す面でもない（CP6 で 2 観点が指摘）
  const needed = COSTUME_REQUIRED.some(key => written(asMapping(item), key) === undefined)
  const box = needed ? boxOf(format, bytes) : null

  // 枠の真ん中。**原点を足す** ── Scratch は SVG の回転の中心を `viewBox` の座標系で
  // 読み、scratch-render が原点を引いて描画へ渡す（`SVGSkin.js`）。原点を無視すると、
  // `viewBox="10 20 …"` の絵が明後日の位置を軸に回る（CP6 で互換性が実測）
  const derived: Record<string, number | undefined> = {
    rotationCenterX: box ? box.x + box.width / 2 : undefined,
    rotationCenterY: box ? box.y + box.height / 2 : undefined,
  }
  const filled = fill(fields, COSTUME_REQUIRED, derived)
  if ("missing" in filled) return filled
  const centerX = filled.values.rotationCenterX
  const centerY = filled.values.rotationCenterY

  const name = typeof fields?.名前 === "string" && fields.名前 !== "" ? fields.名前 : stemOf(file)
  const { assetId, md5ext } = identify(bytes, format)
  // キーの並びは `defaultCostume` に揃える。JSON の並びがそのまま .sb3 のバイト列に
  // なるので、割ると同じ絵が生成の経路ごとに別のバイト列になる
  return {
    costume: {
      assetId,
      name,
      bitmapResolution:
        written(fields, "bitmapResolution") ?? defaultResolutionOf(format),
      md5ext,
      dataFormat: format,
      rotationCenterX: centerX,
      rotationCenterY: centerY,
    },
  }
}

/**
 * 音 1 つを組む。属性は 明示 > 導出 の順に決める。
 *
 * `rate` と `sampleCount` は schema では任意だが、欠けると Scratch が正しく鳴らせない
 * （率を誤ると音程がずれ、総数を誤ると途中で切れる）。導けず書かれてもいなければ
 * `missing` で返し、黙って省かない。
 */
export function soundOf(
  file: string,
  item: unknown,
  bytes: Buffer,
): { sound: Sound } | { missing: string[] } {
  const fields = asMapping(item)
  const format = formatOf(file)
  const needed = SOUND_REQUIRED.some(key => written(asMapping(item), key) === undefined)
  const spec = needed && format === "wav" ? wavSpec(bytes) : null

  const filled = fill(fields, SOUND_REQUIRED, { rate: spec?.rate, sampleCount: spec?.sampleCount })
  if ("missing" in filled) return filled
  const { rate, sampleCount } = filled.values

  const name = typeof fields?.名前 === "string" && fields.名前 !== "" ? fields.名前 : stemOf(file)
  return {
    sound: { ...identify(bytes, format), name, dataFormat: format, rate, sampleCount },
  }
}

/**
 * その形式から属性を導けるかを、一覧の側から答える。
 *
 * 申告の文言を組むのに使う。「書かせる」のか「中身が読めなかった」のかで手当てが違う。
 */
export function derivable(format: string): boolean {
  return DERIVABLE_FORMATS.includes(format)
}
