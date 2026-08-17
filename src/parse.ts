/**
 * 日本語のブロック記法を解析して中間表現にする。
 *
 * 中間表現は scratchblocks の Document で、ここから図と .sb3 の双方を導出する。
 */
import { loadScratchblocks } from "./env.ts"
import { reasonOf } from "./errors.ts"

/**
 * 解析に用いる辞書。英語を外せないのは、C 型ブロックを閉じる `end` が英語辞書に
 * しか無いため。日本語だけにすると `end` が未知のブロックとして残り、
 * 「ずっと」「もし〜なら」が閉じない
 */
export const LANGUAGES = ["ja", "en"]

/**
 * 記法を解析する。
 * `code` は日本語のブロック記法。戻りは scratchblocks の Document。
 */
export async function parseNotation(code: string): Promise<any> {
  const { sb } = await loadScratchblocks()
  return sb.parse(code, { languages: LANGUAGES })
}

/**
 * 記法を解析する。解けなければ投げずに問題として返す。
 *
 * 解析器は入れ子の深さで再帰する。深さ 3000 の記法は `RangeError` で落ち、捕まえないと
 * 最小化した依存のソース 1 行（実測 127KB）がスタックトレースごと利用者の画面へ出る
 * （2026-08-19 実測。閾値は 1200〜2000 の間）。台帳を読む側が「投げずに問題として返す」
 * 方針を採っているのに、解析だけがその外にあった。
 *
 * `subject` は報告に出す対象の名。
 */
export async function readNotation(
  code: string,
  subject: string,
): Promise<{ doc: any | null; problems: Problem[] }> {
  try {
    return { doc: await parseNotation(code), problems: [] }
  } catch (error) {
    return {
      doc: null,
      problems: [{ kind: "記法を解析できない", subject, detail: reasonOf(error) }],
    }
  }
}

export type Problem = {
  kind: string
  subject: string
  detail?: string
}

/**
 * Document の全ブロックを深さ優先で辿る。入れ子の引数と C 型の中身も含む。
 */
export function* eachBlock(doc: any): Generator<any> {
  for (const script of doc.scripts) {
    for (const block of script.blocks) yield* descend(block)
  }
}

function* descend(block: any): Generator<any> {
  yield block
  for (const child of block.children ?? []) {
    if (child.isScript) {
      for (const b of child.blocks) yield* descend(b)
    } else if (child.isBlock) {
      yield* descend(child)
    } else if (child.isInput && child.value?.isBlock) {
      yield* descend(child.value)
    }
  }
}

/**
 * ブロックの総数を数える。0 なら図にできる中身が無い。
 */
export function countBlocks(doc: any): number {
  let count = 0
  for (const _block of eachBlock(doc)) count += 1
  return count
}

/**
 * 認識できなかったブロックを入力の行つきで返す。
 *
 * scratchblocks は解釈できない記述を握りつぶさず、カテゴリ `obsolete` の
 * ブロックとして残す。これを拾って呼び出し元へ渡し、黙って落とさない。
 *
 * `code` は解析した元の記法。
 */
export function findUnrecognized(doc: any, code: string): { line: number; text: string }[] {
  const lineOf = lineFinder(code)
  const found: { line: number; text: string }[] = []

  for (const block of eachBlock(doc)) {
    if (block.info?.category !== "obsolete") continue
    const text = String(block.stringify?.() ?? "").split("\n")[0].trim()
    found.push({ line: lineOf(text), text })
  }
  return found
}

/**
 * ブロックの記法から入力の行番号を引く道具を作る。
 *
 * 中間表現は行を持たないため、ブロックの綴りを元の入力から探す。同じ綴りを 2 度
 * 同じ行に割り当てないよう、割り当て済みの行を覚える。呼ぶ順に消費するので、道具は
 * 1 つの入力につき 1 つ作る。
 *
 * 戻りは行を引く関数で、見つからなければ 0 を返す。
 */
export function lineFinder(code: string): (text: string) => number {
  const lines = code.split(/\r?\n/)
  const taken = new Set<number>()
  return text => locate(lines, text, taken)
}

/**
 * ブロックの文字列に対応する行番号を探す。見つからなければ 0 を返す。
 *
 * 行全体の一致を先に全行ぶん試してから、部分一致へ落とす。順序を混ぜると、
 * 短い記述が手前の正しい行の一部に当たってしまい、誤りの無い行を指す。
 *
 * `taken` は同じ行を 2 度割り当てないための記録。
 */
function locate(lines: string[], text: string, taken: Set<number>): number {
  const match = (index: number) => {
    taken.add(index)
    return index + 1
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (!taken.has(i) && lines[i].trim() === text) return match(i)
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (!taken.has(i) && lines[i].includes(text)) return match(i)
  }
  return 0
}
