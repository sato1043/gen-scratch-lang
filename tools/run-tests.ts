#!/usr/bin/env node
/**
 * 検証を走らせる。ファイルを自分で数えてテストランナーへ渡す。
 *
 * 渡し方が Node の版で割れているため、どちらでも通る「ファイルを並べて渡す」形に寄せる。
 *
 * | 渡し方 | Node 20.19 | Node 22 |
 * |---|---|---|
 * | `--test test/` | 通る | 通らない（位置引数を glob として読む）|
 * | glob を渡す | 通らない（glob 未対応）| 通る |
 * | 引数なし | 追跡外まで拾う | 同左 |
 *
 * 引数なしが使えないのは、既定の探索が作業ディレクトリ配下を丸ごと見るためである。
 * 手元では退避してある過去の版まで拾い、278 件のうち 56 件が落ちた（実測 2026-08-18）。
 * 走らせる対象は追跡下の `test/` に限る。
 *
 * テストランナーへの追加の引数は、そのまま素通しする。
 */
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { announce } from "../src/errors.ts"

const here = new URL("../test/", import.meta.url)
const files = readdirSync(here)
  // 追跡下は `.ts` に揃っているが、`.mjs` も拾い続ける。片方だけを見る形にすると、
  // その拡張子で置かれた検査が黙って走らなくなる（0 件なら下で止まるが、1 本だけ
  // 外れた状態では止まらない）
  .filter(name => name.endsWith(".test.mjs") || name.endsWith(".test.ts"))
  .sort()
  .map(name => fileURLToPath(new URL(name, here)))

if (files.length === 0) {
  announce`検証のファイルが 1 つも無い\n`
  process.exit(1)
}

const passthrough = process.argv.slice(2)
const run = spawnSync(process.execPath, ["--test", ...passthrough, ...files], {
  stdio: "inherit",
})

// 落ちた理由を握りつぶさない。シグナルで終わった場合も 0 を返さない
if (run.error) {
  announce`検証を起動できない: ${run.error.message}\n`
  process.exit(1)
}
process.exit(run.status ?? 1)
