/**
 * 知識層に書いた記法を取り出す。
 *
 * イディオム集の記法は説明のための飾りではなく、生成の入力そのものである。
 * ここで取り出したものを自動テストへ流すことで、記述と検査の入力を同じ物に保つ。
 */
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const FENCE_OPEN = /^\s*```scratchblocks\s*$/
const FENCE_CLOSE = /^\s*```\s*$/
const HEADING = /^##\s+(.+?)\s*$/

export type Snippet = { name: string; source: string; line: number; code: string }

/**
 * markdown から scratchblocks の囲みを取り出す。
 *
 * `source` は表示に使う出所の名前
 */
export function extractSnippets(markdown: string, source: string): Snippet[] {
  const lines = markdown.split(/\r?\n/)
  const found: Snippet[] = []
  let heading = "(見出しなし)"

  for (let i = 0; i < lines.length; i += 1) {
    const title = HEADING.exec(lines[i])
    if (title) {
      heading = title[1]
      continue
    }
    if (!FENCE_OPEN.test(lines[i])) continue

    const start = i + 1
    let end = start
    while (end < lines.length && !FENCE_CLOSE.test(lines[end])) end += 1
    found.push({
      name: `${source}:${start + 1} ${heading}`,
      source,
      line: start + 1,
      code: lines.slice(start, end).join("\n"),
    })
    i = end
  }
  return found
}

/**
 * ディレクトリの markdown をすべて読み、記法を取り出す。
 */
export function loadSnippets(dir: string | URL): Snippet[] {
  const path = dir instanceof URL ? fileURLToPath(dir) : dir
  return readdirSync(path)
    .filter(name => name.endsWith(".md"))
    .sort()
    .flatMap(name =>
      extractSnippets(readFileSync(join(path, name), "utf8"), name),
    )
}
