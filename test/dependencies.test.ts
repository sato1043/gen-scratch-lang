import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * 本体が開発依存へ触れていないことを見張る。
 *
 * 台帳の組み立ては開発依存の scratch-blocks を要するため tools/ へ分けてある。分けた状態は
 * 放っておくと戻る。指定子を 1 つ書き足せば利用者の手元で落ちる経路が復活するのに、開発機
 * には開発依存も入っているため検証は素通りする。
 *
 * **見る範囲は入口から辿って決める。** 以前はディレクトリ（`src/` の直下）で区切っていたが、
 * それは本体の実体と一致しない。`src/serialize.ts` は `catalog/shadows.ts` を読むので、
 * `catalog/` も利用者の手元で読み込まれる。ディレクトリで区切ると、その外側へ指定子を
 * 書き足しても検査が緑のまま通る（実測 2026-08-18・CP6 レビュー指摘）。
 */

const root = new URL("../", import.meta.url)

/** 利用者が起動する入口。ここから静的に辿れる範囲が「本体」にあたる */
const ENTRY = "src/cli.ts"

const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
const devNames = Object.keys(manifest.devDependencies ?? {})

/**
 * モジュール指定子を取り出す。
 *
 * 以前は引用符で囲まれた中身をすべて拾っていたが、囲みの数を数える形だったため、文中に
 * 引用符が奇数個あると以降がずれた（偽陰性・偽陽性の双方を再現済み）。指定子が書ける形は
 * 限られるので、その形だけを見る。`require.resolve` も対象に含める（実行時に解決する
 * 呼び出しも、その依存を要求している点は同じ）。
 */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*|\brequire(?:\.resolve)?\s*\(\s*)(['"`])([^'"`\n]+)\1/g

function specifiersIn(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map(match => match[2])
}

/**
 * 入口から静的に辿れるファイルを集める。
 *
 * 辿るのは相対指定子だけで、パッケージ名はそこで止める（依存の中身は本体ではない）。
 *
 * `entry` はリポジトリの根からの相対
 * 戻りは相対パス → 中身
 */
function reachableFrom(entry: string): Map<string, string> {
  const seen: Map<string, string> = new Map()
  const queue = [entry]

  while (queue.length > 0) {
    const path = queue.shift()
    if (path === undefined || seen.has(path)) continue

    const source = readFileSync(new URL(path, root), "utf8")
    seen.set(path, source)

    for (const specifier of specifiersIn(source)) {
      if (!specifier.startsWith(".")) continue
      const resolved = fileURLToPath(new URL(specifier, new URL(path, root)))
      const relative = resolved
        .slice(fileURLToPath(root).length)
        .split("\\")
        .join("/")
      if (!seen.has(relative)) queue.push(relative)
    }
  }
  return seen
}

const body = reachableFrom(ENTRY)

test("本体のどのファイルも開発依存を指さない", () => {
  // 0 件は「触れていない」でなく「見ていない」かもしれない。辿れた範囲が実体を
  // 覆っていることを先に確かめる（実測 2026-08-18: 入口から 13 ファイル）
  assert.ok(body.size >= 10, `入口から辿れたのが ${body.size} 件しかない`)
  assert.ok(devNames.length > 0, "開発依存が 1 つも無く、検査が何も探していない")

  // ディレクトリで区切っていたころに外れていた範囲。実体の側から辿れることを固定する。
  // 影ブロックの表は `src/serialize.ts` が読むので本体に乗る。選択肢の表は生成側からしか
  // 読まれないため、ここには現れないのが正しい
  assert.ok(body.has("catalog/shadows.ts"), "手書きの表が本体の範囲から外れている")
  assert.ok(!body.has("catalog/dropdowns.ts"), "生成側の表が本体の範囲へ紛れている")

  const offenders = [...body]
    .map(([path, source]) => ({
      path,
      names: specifiersIn(source).filter(specifier =>
        devNames.some(name => specifier === name || specifier.startsWith(`${name}/`)),
      ),
    }))
    .filter(file => file.names.length > 0)

  assert.deepEqual(offenders, [], "本体が開発依存を指している")
})

test("同じ検査が、開発依存を指す生成側を検出する", () => {
  // 測定器の較正。本体が 0 件なのは触れていないからであって、検査が何も見ていない
  // からではないことを、既知の答えを持つ入力で確かめる
  const source = readFileSync(new URL("tools/opcodes.ts", root), "utf8")
  const found = specifiersIn(source).filter(specifier =>
    devNames.some(name => specifier === name || specifier.startsWith(`${name}/`)),
  )

  assert.ok(found.length > 0, "開発依存を指す生成側を検出できていない")
  assert.deepEqual([...new Set(found)], ["scratch-blocks"])
})

test("指定子の取り出しが、散文と引用符の数に左右されない", () => {
  // 以前の実装は引用符を数える形で、文中の引用符が奇数個あると以降がずれた。
  // 散文で名前に触れるだけの行を通し、実際の指定子だけを拾うことを固定する
  const sample = [
    "// scratch-blocks の定義を読む。値に ' を含む綴りがある",
    "/** `scratch-blocks` は開発依存である */",
    'import { a } from "./local.mjs"',
    "const x = require('scratch-blocks')",
    'const y = require.resolve("scratch-blocks/package.json")',
    "const text = `テンプレートの中の scratch-blocks`",
  ].join("\n")

  assert.deepEqual(specifiersIn(sample), [
    "./local.mjs",
    "scratch-blocks",
    "scratch-blocks/package.json",
  ])
})

/**
 * Node の下限を持つ 4 箇所が食い違わないことを見る。
 *
 * 下限は 4 つの手で守っている ── 宣言（`engines`）・導入時の強制（`.npmrc` の
 * `engine-strict`）・静的な検査（`@types/node` の整列）・実行の検証（CI の下限の行）。
 * 手が増えるほど、1 つだけ動かして他が古びる形が起きやすい。
 *
 * **実際に一度乖離した。** TASK0005 が `engines` を EOL の理由で 24 へ上げたとき、
 * `@types/node` も 24 系へ揃えたが、その後 `^24.13.3` へ動いて下限 24.12.0 より
 * 1 マイナー上になっていた（CP6 で実測）。この状態では下限に無い API を型検査が通す。
 */
test("Node の下限を持つ 4 箇所が食い違わない", () => {
  const 宣言 = manifest.engines?.node
  assert.ok(宣言, "engines.node が無い。測る対象が無い")

  const 下限 = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(String(宣言))
  assert.ok(下限, `engines.node が下限の形をしていない: ${宣言}`)
  const [, major, minor] = 下限

  // 手元が指す版。下限そのものを指す（約束した下限を書き手が毎日踏むため）
  const 手元 = readFileSync(fileURLToPath(new URL(".node-version", root)), "utf8").trim()
  assert.equal(手元, `${major}.${minor}.${下限[3]}`, ".node-version が下限を指していない")

  // 型は下限と同じマイナーへ揃える。上にあると下限に無い API を型検査が通す
  const 型 = String(manifest.devDependencies?.["@types/node"] ?? "")
  assert.equal(型, `~${major}.${minor}.0`, "@types/node が下限のマイナーへ揃っていない")

  // CI は下限と最新の両端を回す。下限だけでは利用者の大半が動かす版が抜け、
  // 最新だけでは宣言した下限が 1 度も走らない
  const ci = readFileSync(fileURLToPath(new URL(".github/workflows/verify.yml", root)), "utf8")
  const matrix = /node: \[([^\]]*)\]/.exec(ci)
  assert.ok(matrix, "CI の matrix を読めない")
  const 版 = matrix[1].split(",").map(t => t.trim().replace(/"/g, ""))
  assert.ok(版.includes(`${major}.${minor}`), `CI が下限 ${major}.${minor} を回していない`)
  assert.ok(版.includes(major), `CI が最新の ${major} 系を回していない`)

  // 宣言を強制へ変える設定が残っていること。無いと npm は警告だけで通す
  const npmrc = readFileSync(fileURLToPath(new URL(".npmrc", root)), "utf8")
  assert.match(npmrc, /^engine-strict=true$/m, "engine-strict が立っていない")
})
