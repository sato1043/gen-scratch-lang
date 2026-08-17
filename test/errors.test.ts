import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import {
  announceProblems,
  clip,
  neutralize,
  problemOf,
  quotedPath,
  reasonOf,
  rerun,
  shownPath,
} from "../src/errors.ts"

/** Windows の区切り。ソースへ裸で書くと読む側が数を取り違える */
const SEP = String.fromCharCode(92)

const ROOT = fileURLToPath(new URL("../", import.meta.url))

test("投げられたものが Error でなくても理由を取り出す", () => {
  assert.equal(reasonOf(new Error("こわれた")), "こわれた")
  assert.equal(reasonOf("素の文字列"), "素の文字列")
  assert.equal(reasonOf({ code: 1 }), "[object Object]")
})

test("そのまま打てる綴りは裸で置く", () => {
  for (const path of ["docs/knowledge", "out/blocks.json", "日本語/知識", "a-b_c.d"]) {
    const { text, safe } = quotedPath(path)
    assert.equal(text, path, `${path} を囲んでいる`)
    assert.ok(safe)
  }
})

test("空白と Windows の区切りは引用して守る", () => {
  for (const path of ["my docs/knowledge", `C:${SEP}Users${SEP}x`]) {
    const { text, safe } = quotedPath(path)
    assert.equal(text, `"${path}"`, `${path} を囲んでいない`)
    assert.ok(safe, `${path} を守れないと言っている`)
  }
})

test("引用で守れない綴りは、守れないと申告する", () => {
  // 3 つの shell（POSIX sh・PowerShell・cmd）すべてで安全な単一の引用は存在しない。
  // 打てないものを打てると言う方が、打てないと告げるより悪い
  const cases = [
    "docs;calc",
    "a$(id)b",
    "back`tick",
    'q"uote',
    "has(paren)",
    `C:${SEP}dir${SEP}`,
    "line\nbreak",
  ]
  for (const path of cases) {
    const { safe } = quotedPath(path)
    assert.equal(safe, false, `${JSON.stringify(path)} を守れると言っている`)
  }
})

test("復帰コマンドが渡された置き場を反映する", () => {
  const { command, note } = rerun("node src/cli.ts knowledge", "--dir", "docs/knowledge")
  assert.equal(command, "node src/cli.ts knowledge --dir docs/knowledge")
  assert.equal(note, null)
})

test("置き場が渡されていなければ、旗ごと落とす", () => {
  const { command, note } = rerun("node tools/cli.ts catalog", "--out", undefined)
  assert.equal(command, "node tools/cli.ts catalog")
  assert.equal(note, null)
})

test("写して打てない置き場には、打てない旨を添える", () => {
  const { command, note } = rerun("node src/cli.ts knowledge", "--dir", "a$(id)b")
  assert.match(command, /--dir "a\$\(id\)b"/)
  assert.match(note ?? "", /そのまま打てない/, "打てない置き場を黙って示している")
})

/**
 * 中和の較正。既知の答えを持つ入力を通し、通す側と落とす側の両方を測る。
 *
 * 通す側を測らないと「全部を印へ変える」実装でも緑になり、落とす側を測らないと
 * 「何もしない」実装でも緑になる。どちらか片方では測定器にならない。
 */
test("申告へ載せてよい綴りは、中和しても変わらない", () => {
  const kept = [
    "a-b_c.d/e:f;g|h~i^j@k#l%m$n+o=p<q>r(s)t[u]v{w}x!y?z",
    "スプライト「ネコ」の 変数 スコア（1）",
    "docs/knowledge/blocks/motion.md",
    "🐱ねこ",
  ]
  for (const text of kept) assert.equal(neutralize(text), text, `${text} を変えている`)
})

test("表示できない符号位置を、消さずに見える印へ変える", () => {
  const cases = [
    // 画面を消して申告の一覧を隠す ANSI の列（2026-08-19 に記法ファイルで実測）
    [`${String.fromCharCode(27)}[2J`, "<U+001B>[2J"],
    // git がファイルを binary と見なす NUL
    [`a${String.fromCharCode(0)}b`, "a<U+0000>b"],
    // 行を偽装できる改行とタブ
    [`a${String.fromCharCode(10)}b`, "a<U+000A>b"],
    [`a${String.fromCharCode(9)}b`, "a<U+0009>b"],
    // 表示順を覆す双方向制御
    [`abc${String.fromCodePoint(0x202e)}def`, "abc<U+202E>def"],
    // 幅を持たない結合子。名前に紛れると「宣言されていない」の理由が読めなくなる
    [`ね${String.fromCodePoint(0x200d)}こ`, "ね<U+200D>こ"],
  ]
  for (const [given, want] of cases) {
    assert.equal(neutralize(given), want, `${JSON.stringify(given)} を通している`)
  }
})

test("文字列でない値も中和を通せる", () => {
  assert.equal(neutralize(42), "42")
  assert.equal(neutralize(undefined), "undefined")
})

/**
 * 申告を書く入口が 1 か所に集まっていることを見張る。
 *
 * 中和は全部の入口に掛かって初めて意味を持つ。入口を増やしても抜けないことは、
 * 「入口が 1 つしかない」を機械で確かめる以外に測りようがない。
 */
/**
 * 直に書く綴り。JavaScript で流れへ書く綴りは数え切れないので、これは拒否リストである。
 *
 * CP6 で `process.std*.write` の 1 綴りだけを見ていることを指摘された（`console.*` を
 * 見ておらず、1 行の変更で到達基準が黙って無効になる）。数え切れない側を数える形は
 * 取れないので、当たる綴りを増やし、綴りごとに「実際に当たる」ことを較正する。
 */
const DIRECT_WRITES = [
  { name: "process.stdout.write", pattern: /process\.stdout\.write/ },
  { name: "process.stderr.write", pattern: /process\.std(err)\.write/ },
  { name: "console.*", pattern: /console\.(log|error|warn|info|debug|trace|dir)/ },
  { name: "process.stdout/stderr の別名", pattern: /process\.std(out|err)\s*[,)\]]/ },
]

/** 走査するディレクトリ。実装が置かれる場所をすべて挙げる */
const SCANNED_DIRS = ["src", "tools", "catalog"]

test("標準出力・標準エラーへ書くのは errors.ts だけである", () => {
  const offenders = []
  let scanned = 0
  for (const dir of SCANNED_DIRS) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!name.endsWith(".mjs") && !name.endsWith(".ts")) continue
      // 入口そのものは除く。拡張子で書くと、置き換わったときに除外が外れて自分自身が
      // 違反に数えられるので、幹で見る
      if (dir === "src" && (name === "errors.mjs" || name === "errors.ts")) continue
      scanned += 1
      const source = readFileSync(join(ROOT, dir, name), "utf8")
      for (const { name: form, pattern } of DIRECT_WRITES) {
        if (pattern.test(source)) offenders.push(`${dir}/${name}: ${form}`)
      }
    }
  }

  // 走査が空だと、以下の照合は 1 件も見ないまま緑になる
  assert.ok(scanned >= 18, `走査できたのが ${scanned} ファイルしかない`)
  assert.deepEqual(offenders, [], "errors.ts の外から直に書いている")
})

test("走査の当てる綴りが、どれも実在の書き方に当たる", () => {
  // 測定器の較正。0 件なのは寄せ切ったからであって、走査が何も見ていないからではない。
  // 綴りごとに当たることを確かめる ── 1 つでも当たらない綴りが混じると、その分だけ
  // 守備範囲が黙って狭い
  const samples = {
    "process.stdout.write": 'process.stdout.write("x")',
    "process.stderr.write": 'process.stderr.write("x")',
    "console.*": 'console.error("x")',
    "process.stdout/stderr の別名": "const out = process.stdout, y = 1",
  }
  for (const { name, pattern } of DIRECT_WRITES) {
    const sample = (samples as Record<string, string>)[name]
    assert.ok(sample, `${name} の見本が無い`)
    assert.match(sample, pattern, `${name} の綴りが実在の書き方に当たらない`)
  }
})

test("切り詰めた綴りには、切ったことが分かる印が残る", () => {
  // 印が無いと、途中で切れたパスが完全なパスに見える
  assert.equal(clip("abcdefghij", 20), "abcdefghij", "切る必要の無いものを切っている")
  assert.equal(clip("abcdefghij", 10), "abcdefghij", "上限ちょうどを切っている")
  assert.equal(clip("abcdefghij", 5), "abcd…")
  assert.ok(clip("abcdefghij", 5).length <= 5, "上限を超えている")
})

test("申告に載せるパスを、打った場所からの相対へ畳む", () => {
  // 既定の台帳は import.meta.url から引くので絶対パスになる。そのまま出すと利用者名が漏れる
  const inside = new URL("../catalog/blocks.json", import.meta.url)
  assert.equal(shownPath(inside), "catalog/blocks.json")
  assert.ok(!shownPath(inside).includes(":"), "絶対パスのまま出している")

  // 打った場所の外は畳まない。畳んだ方が読みにくく、利用者自身が渡した綴りである
  assert.equal(shownPath("/elsewhere/blocks.json"), "/elsewhere/blocks.json")
})

test("行を偽装できる符号位置も印へ変える", () => {
  // `\p{Z}` を丸ごと通すと行区切りと段落区切りが混じり、改行を印へ変えた意味が消える。
  // 端末や下流の道具がそこで行を割れば、申告の行を偽装できる（CP6 で 5 観点が指摘）
  assert.equal(neutralize(`a${String.fromCodePoint(0x2028)}b`), "a<U+2028>b")
  assert.equal(neutralize(`a${String.fromCodePoint(0x2029)}b`), "a<U+2029>b")

  // 対照。ふつうの間隔は通す。全部を落とす実装でも緑にならないようにする
  assert.equal(neutralize("a b"), "a b")
  const nbsp = String.fromCodePoint(0x00a0)
  assert.equal(neutralize(`a${nbsp}b`), `a${nbsp}b`)
})

test("投げられたものを、読む側の口である申告の形へ寄せる", () => {
  // 読み取りの経路は投げる側と返す側が混ざる。受け取る側の形を 1 通りにするための部品
  const made = problemOf(new Error("開けない"), "読み取れない .sb3", "作品.sb3")
  assert.deepEqual(made, {
    kind: "読み取れない .sb3",
    subject: "作品.sb3",
    detail: "開けない",
  })

  // Error でないものも受ける。`message` を直に読むと undefined が申告へ出る
  assert.equal(problemOf("素の文字列", "名", "対象").detail, "素の文字列")
  assert.equal(problemOf(undefined, "名", "対象").detail, "undefined")

  // 理由に混じる絶対パスは畳む。畳まないと利用者名とディレクトリ構成が申告へ乗る
  const inside = fileURLToPath(new URL("../catalog/blocks.json", import.meta.url))
  const folded = problemOf(new Error(`open '${inside}'`), "名", "対象").detail
  assert.equal(folded, "open 'catalog/blocks.json'")
})

test("文字にできないものを投げられても、理由の取り出しが落ちない", () => {
  // 実害を先に置く。理由が何になるかより、申告の経路そのものが落ちないことが要る ──
  // 落ちると、誤りを伝える経路が誤りで止まり、利用者には生のスタックトレースだけが残る
  const cases = [
    ["原型を持たないオブジェクト", Object.create(null)],
    ["toString が投げるもの", { toString() { throw new Error("boom") } }],
    // message は外から差し替えられる。Error なら安全という前提は置けない
    [
      "message が投げる Error",
      Object.assign(new Error(), { message: { toString() { throw new Error("boom") } } }),
    ],
  ]
  for (const [name, thrown] of cases) {
    // 較正: この入力が本当に素の String() を落とすことを確かめる。落とさない入力で
    // 測ると、`textOf` を外しても緑のまま通る
    assert.throws(
      () => String(thrown instanceof Error ? thrown.message : thrown),
      `${name} は素の String() でも落ちない`,
    )
    const reason = reasonOf(thrown)
    assert.equal(typeof reason, "string", `${name} で文字列が返らない`)
    assert.match(reason, /文字にできない/, `${name} で何が起きたかを述べていない`)
  }
})

test("並べる申告の件数に上限が掛かり、切ったことを告げる", () => {
  const problems = Array.from({ length: 900 }, (_, index) => ({
    kind: "台帳に無いブロック",
    subject: `main.sbk:${index + 1}`,
  }))
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: any) => {
    written.push(String(chunk))
    return true
  }
  try {
    announceProblems(problems)
  } finally {
    process.stderr.write = original
  }
  const text = written.join("")

  // 実害を先に置く。件数を相手が決められることが問題なので、まず並んだ数を測る
  const listed = text
    .split("\n")
    .filter(line => line.startsWith("  台帳に無いブロック")).length
  assert.ok(listed < problems.length, "全件をそのまま並べている")
  // 切ったことを告げる。黙って切ると、読み手には一覧が全部に見える
  assert.match(text, /ほか \d+ 件は並べない/, "切ったことを告げていない")
  // 総数は復元できる。並べた数と告げた数を足して元へ戻る
  const withheld = Number(text.match(/ほか (\d+) 件は並べない/)?.[1])
  assert.equal(listed + withheld, problems.length, "並べた数と切った数が総数に戻らない")
})
