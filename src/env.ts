/**
 * scratchblocks を Node.js 上で動かすための実行環境をつくる。
 *
 * scratchblocks はブラウザ前提のライブラリで、DOM とテキストの幅計測を要求する。
 * jsdom が DOM を、canvas が計測を与える。どちらが欠けても描画が落ちる。
 */
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"

const require = createRequire(import.meta.url)

export type Environment = { sb: any; window: any }

let cached: Environment | null = null

/**
 * 実行環境を組み立てて返す。2 度目以降は組み立て済みのものを返す。
 */
export async function loadScratchblocks(): Promise<Environment> {
  if (cached) return cached

  const dom = new JSDOM("<!DOCTYPE html><body></body>")
  // scratchblocks の内部には window を引数で受けずに大域から取る箇所がある
  globalThis.window = dom.window
  globalThis.document = dom.window.document

  // package.json の main は CommonJS 向けなので ES 版を明示して読み込む。
  // ES 版は読み込みの時点で大域の window を捉えて初期化済みの API を返すため、
  // 上の 2 行より後に読み込む必要がある
  const { default: exported } = await import(
    "scratchblocks/build/scratchblocks.min.es.js"
  )
  const sb = typeof exported === "function" ? exported(dom.window) : exported

  const ja = JSON.parse(
    readFileSync(require.resolve("scratchblocks/locales/ja.json"), "utf8"),
  )
  sb.loadLanguages({ ja })

  cached = { sb, window: dom.window }
  return cached
}
