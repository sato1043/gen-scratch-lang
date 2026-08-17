/**
 * 追跡下の `.ts` に現れる `any` を数える。
 *
 * 数え方を 1 か所へ固定するために置く。過去に同じリポジトリの `any` 比率が 38% /
 * 25.7% / 11.5% と 3 通りの値を出した（TASK0008 の裁定記録）。どれも誤りでなく、
 * 数える人ごとに分母の定義が違っただけである。割合をやめて絶対数で数えることにした
 * ので、残る揺れは「何を `any` の 1 個と数えるか」だけになる。それをここで決める。
 *
 * **散文と文字列の中は数えない。** `any` を話題にしたコメントが数に混じると、減らした
 * はずの数が動かない理由が読めなくなる。ただし除いた数は必ず返す ── 除外は不可視に
 * すると、数が合わないときにどちらの側の問題か分からなくなる。
 *
 * 走査の対象は git が追跡している `.ts` に限る。追跡外の退避物や生成物を数えると、
 * 手元の状態で数が動く。
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { report } from "../src/errors.ts"

/** 語としての `any`。`anything` や `company` を数えない */
const WORD = /\bany\b/g

/** リポジトリの根。走査の起点であり、追跡下の一覧を引く先でもある */
export function repositoryRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url))
}

/**
 * コメントと文字列を空白へ潰す。
 *
 * 潰した位置の長さは保つ。行番号と桁がずれると、申告が指す場所が実物と食い違う。
 *
 * **引用符は改行で閉じる。** JavaScript の文字列リテラルは生の改行を跨げないので、
 * 跨げる形で書くと正規表現リテラルの中の引用符（`[^\s'"\`]+` のような文字クラス）が
 * 擬似的な文字列を開き、そこから先のコードが丸ごと散文として潰れる。CP6 で実測した
 * ── `src/errors.ts` の絶対パスの正規表現から先へ `const 破壊: any = 1` を仕込んでも
 * 数が 1 つも動かなかった。
 *
 * **テンプレートの補間はコードとして残す。** `${(error as any).stdout}` の中は式であり
 * 散文ではない。潰すと実在の `any` が数から漏れる（CP6 で実測。3 個が漏れていた）。
 *
 * 戻りは潰した後の本文と、潰した中に居た `any` の数
 */
export function withoutProse(source: string): { code: string, dropped: number } {
  const out: string[] = []
  let i = 0
  let dropped = 0

  const skip = (to: number) => {
    const cut = source.slice(i, to)
    dropped += (cut.match(WORD) ?? []).length
    out.push(cut.replace(/[^\n]/g, " "))
    i = to
  }

  /** 引用符で囲む文字列。改行で閉じる */
  const quoted = (quote: string) => {
    let j = i + 1
    while (j < source.length) {
      if (source[j] === "\\") {
        j += 2
        continue
      }
      if (source[j] === quote) {
        j += 1
        break
      }
      // 閉じないまま行が終わったら、そこで閉じる（正規表現の中の引用符がここへ来る）
      if (source[j] === "\n") break
      j += 1
    }
    skip(j)
  }

  /** テンプレート。地の文は潰し、`${…}` の中は式として残す */
  const template = () => {
    skip(i + 1)
    while (i < source.length) {
      if (source[i] === "\\") {
        skip(i + 2)
        continue
      }
      if (source[i] === "`") {
        skip(i + 1)
        return
      }
      if (source.slice(i, i + 2) === "${") {
        skip(i + 2)
        let depth = 1
        while (i < source.length) {
          if (source[i] === "{") depth += 1
          else if (source[i] === "}") {
            depth -= 1
            if (depth === 0) {
              skip(i + 1)
              break
            }
          }
          out.push(source[i])
          i += 1
        }
        continue
      }
      skip(i + 1)
    }
  }

  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === "//") {
      const end = source.indexOf("\n", i)
      skip(end === -1 ? source.length : end)
      continue
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2)
      skip(end === -1 ? source.length : end + 2)
      continue
    }
    const quote = source[i]
    if (quote === '"' || quote === "'") {
      quoted(quote)
      continue
    }
    if (quote === "`") {
      template()
      continue
    }
    out.push(source[i])
    i += 1
  }
  return { code: out.join(""), dropped }
}

/** 走査の結果。0 件が「無い」のか「見ていない」のかを分けられる形で返す */
export type Census = {
  /** 読んだファイルの数。0 なら以下の数は何も測っていない */
  scanned: number
  /** 数えた `any` の総数 */
  total: number
  /** 散文・文字列の中で数えなかった `any` の数 */
  dropped: number
  /** ファイルごとの数。多い順ではなく綴りの順で返す */
  byFile: { path: string, count: number }[]
}

/**
 * 追跡下の `.ts` を走査して数える。
 */
export function censusOfAny(root: string = repositoryRoot()): Census {
  const listed = execFileSync("git", ["ls-files", "*.ts"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .sort()

  let total = 0
  let dropped = 0
  const byFile: { path: string, count: number }[] = []

  for (const path of listed) {
    const { code, dropped: skipped } = withoutProse(
      readFileSync(join(root, path), "utf8"),
    )
    dropped += skipped
    const count = (code.match(WORD) ?? []).length
    total += count
    if (count > 0) byFile.push({ path, count })
  }

  return { scanned: listed.length, total, dropped, byFile }
}

// 直に走らせたときは人が読む形で出す。検査は上の関数を直に呼ぶ
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const census = censusOfAny()
  report`走査 ${census.scanned} ファイル / any ${census.total} 個 / 散文と文字列の中で除いた ${census.dropped} 個\n`
  for (const { path, count } of [...census.byFile].sort((a, b) => b.count - a.count)) {
    report`  ${String(count).padStart(4)}  ${path}\n`
  }
}
