/**
 * コスチュームを自前で作る。
 *
 * .sb3 は各ターゲットに最低 1 つのコスチュームを要求する。Scratch の既定素材は
 * 持ち込まない（配布物へ他者の権利物を混ぜないため）。代わりに最小の SVG を生成する。
 *
 * `assetId` は素材の中身の md5 である（scratch-parser の schema が 32 桁の 16 進を
 * 要求する）。中身から導くので、同じ入力からは同じ ID になり決定論を保つ。
 */
import { createHash } from "node:crypto"

/** スプライトの見え。Scratch の既定の配色に寄せた四角 1 つ */
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <rect x="4" y="4" width="40" height="40" rx="6" fill="#4c97ff" stroke="#3373cc" stroke-width="2"/>
</svg>
`

/** ステージの背景。舞台の寸法どおりの白 1 枚 */
const STAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <rect width="480" height="360" fill="#ffffff"/>
</svg>
`

export type Costume = {
  /** 中身の md5 */
  assetId: string
  name: string
  bitmapResolution: number
  /** zip に収めるときのファイル名 */
  md5ext: string
  dataFormat: string
  rotationCenterX: number
  rotationCenterY: number
}

/**
 * ターゲット 1 つぶんのコスチュームと、zip へ収める中身を返す。
 */
export function defaultCostume(isStage: boolean): { costume: Costume; bytes: Buffer } {
  const svg = isStage ? STAGE : SPRITE
  const bytes = Buffer.from(svg, "utf8")
  const assetId = createHash("md5").update(bytes).digest("hex")
  const [width, height] = isStage ? [480, 360] : [48, 48]

  return {
    costume: {
      assetId,
      name: isStage ? "背景1" : "コスチューム1",
      bitmapResolution: 1,
      md5ext: `${assetId}.svg`,
      dataFormat: "svg",
      // 回転の中心は絵の真ん中。ずらすと「向き」の変更で絵が振り回される
      rotationCenterX: width / 2,
      rotationCenterY: height / 2,
    },
    bytes,
  }
}
