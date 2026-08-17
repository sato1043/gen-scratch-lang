#!/usr/bin/env node
/**
 * 開発者向けのコマンド入口。台帳を組み立てて書き出す。
 *
 * 利用者向けの入口は src/cli.ts にある。台帳の組み立てには開発依存の
 * scratch-blocks が要り、利用者の手元には無いため、入口ごと分けてある。
 */
import { parseArgs } from "node:util"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { buildCatalog } from "./build-catalog.ts"
import { compareOptions, deriveOptions } from "./derive-options.ts"
import { OPTIONS } from "../catalog/dropdowns.ts"
import { CATALOG_KEYS, type Catalog } from "../src/catalog.ts"
import {
  announce,
  announceProblems,
  announceRerun,
  announceUsage,
  reasonOf,
  report,
  withLf,
} from "../src/errors.ts"

const USAGE = `使い方:
  node tools/cli.ts catalog [--out <出力先>] [--check]
  node tools/cli.ts options [--out <出力先>]

catalog:
  --out     出力先。省略すると catalog/blocks.json へ書き出す
  --check   書き出さず、既にある台帳が組み立て直したものと一致するか調べる

options:
  --out     書き出し先。省略すると照合だけを行い、書き出さない
`

const CATALOG_OUT = "catalog/blocks.json"

/** 選択肢の対応を書き出す既定の場所。写す元にするだけなので追跡下へは置かない */
const OPTIONS_OUT = "out/options.json"

/**
 *
 * 戻りは終了コード
 */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === "catalog") return catalog(rest)
  if (command === "options") return options(rest)

  announceUsage(USAGE)
  return command === undefined || command === "--help" ? 0 : 1
}

/**
 * 台帳を組み立てて書き出す。整合が破れていれば書き出さずに止める。
 */
async function catalog(rest: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: rest,
      options: { out: { type: "string" }, check: { type: "boolean" } },
    })
  } catch (error) {
    announce`引数が読めない: ${reasonOf(error)}\n\n`
    announceUsage(USAGE)
    return 1
  }

  const { catalog: built, problems } = buildCatalog()
  if (problems.length > 0) {
    announce`台帳の整合が取れない。${problems.length} 件\n`
    announceProblems(problems)
    return 1
  }

  reportCounts(built)

  const out = parsed.values.out ?? CATALOG_OUT
  const text = `${JSON.stringify(built, null, 2)}\n`

  if (parsed.values.check) {
    let current
    try {
      current = readFileSync(out, "utf8")
    } catch (error) {
      announce`台帳を読めない: ${reasonOf(error)}\n`
      announceRerun("書き出し直す", "node tools/cli.ts catalog", "--out", parsed.values.out)
      return 1
    }
    if (current !== text) {
      // 改行だけの違いを「古い」と言わない。中身は合っているのに組み立て直せと言われ、
      // 直しても改行が混ざるだけで直らない（知識層の `--check` と同じ形）
      if (withLf(current) === text) {
        announce`改行が LF でない: ${out}\n`
      } else {
        announce`台帳が古い。組み立て直したものと一致しない: ${out}\n`
      }
      announceRerun("書き出し直す", "node tools/cli.ts catalog", "--out", parsed.values.out)
      return 1
    }
    report`${out} は最新\n`
    return 0
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
  report`${out}\n`
  return 0
}

/**
 * 覆えた件数と覆えない範囲を申告する。覆えない範囲は 0 件でも群ごと残す。
 */
function reportCounts(built: Catalog) {
  for (const [label, count] of Object.entries(built[CATALOG_KEYS.COUNTS])) {
    report`${label}: ${count} 件\n`
  }
  report`覆わない範囲:\n`
  for (const [label, entries] of Object.entries(built[CATALOG_KEYS.SCOPE])) {
    // カテゴリでまとめた群は、群の数でなく中身の数を出す
    const count = entries.reduce((sum, entry) => sum + (entry.件数 ?? 1), 0)
    report`  ${label}: ${count} 件\n`
  }
}

/**
 * ドロップダウンの選択肢を上流から書き出し直し、追跡下の表と突き合わせる。
 *
 * 追跡下の表は手で保つ。丸ごと上書きしないのは、同じファイルに機械で導けない補足も
 * 同居しているためで、書き出したものは写す元として渡す。
 */
async function options(rest: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: rest, options: { out: { type: "string" } } })
  } catch (error) {
    announce`引数が読めない: ${reasonOf(error)}\n\n`
    announceUsage(USAGE)
    return 1
  }

  const { options: derived, problems } = deriveOptions()
  if (problems.length > 0) {
    announce`上流から読み出せない。${problems.length} 件\n`
    announceProblems(problems)
    return 1
  }

  const pairs = Object.values(derived)
    .flatMap(byField => Object.values(byField))
    .reduce((sum, choices) => sum + Object.keys(choices).length, 0)
  report`上流: ${Object.keys(derived).length} ブロック / ${pairs} 組\n`

  if (parsed.values.out) {
    const text = `${JSON.stringify(derived, null, 2)}\n`
    mkdirSync(dirname(parsed.values.out), { recursive: true })
    writeFileSync(parsed.values.out, text)
    report`${parsed.values.out}\n`
  }

  const differences = compareOptions(OPTIONS, derived)
  if (differences.length > 0) {
    announce`追跡下の表が上流と食い違う。${differences.length} 件\n`
    // 食い違いは対象を `at` で持つ。申告の並べ方を 1 か所へ寄せるため名を揃えて渡す
    announceProblems(
      differences.map(({ kind, at, detail }) => ({ kind, subject: at, detail })),
    )
    // 表は丸ごと上書きしない（機械で導けない補足が同居する）。写す元を作る手を示す。
    // 書き出し先が渡されていなければ具体の場所を埋める。`<書き出し先>` のような差し込み口を
    // 残すと、写して打った先で shell がリダイレクトとして解く（2026-08-19 実測）
    announceRerun(
      "上流の対応を書き出して写す",
      "node tools/cli.ts options",
      "--out",
      parsed.values.out ?? OPTIONS_OUT,
    )
    return 1
  }

  report`追跡下の選択肢の対応は上流と一致\n`
  return 0
}

// テストから main だけを読み込めるよう、直接起動されたときにのみ走らせる
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
