/**
 * 中間表現をブロック図（SVG / PNG）にする。
 */
import { Resvg } from "@resvg/resvg-js"
import { loadScratchblocks } from "./env.ts"
import { LANGUAGES } from "./parse.ts"

/**
 * 中間表現を単体で表示できる SVG の文字列にする。
 *
 * scratchblocks の `render()` が返す SVG は配色をページ側の CSS に頼るため、
 * 単体では色が付かない。`exportSVGString()` は CSS を SVG の中へ入れる。
 *
 */
export async function renderSvg(doc: any, options: { scale?: number } = {}): Promise<string> {
  const { sb } = await loadScratchblocks()
  const view = sb.newView(doc, {
    style: "scratch3",
    languages: LANGUAGES,
    scale: options.scale ?? 1,
  })
  view.render()
  return view.exportSVGString()
}

/**
 * SVG の文字列を PNG にする。日本語の字形は環境のフォントから取る。
 *
 * 拡大率は SVG を作る側（`renderSvg`）だけが持つ。ここで重ねて掛けると
 * PNG だけが拡大率の二乗の大きさになり、同じ指定で SVG と寸法が食い違う。
 *
 */
export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: true },
    fitTo: { mode: "original" },
  })
  return Buffer.from(resvg.render().asPng())
}
