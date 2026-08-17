import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { announcementGroups } from "../src/cli.ts"

const run = promisify(execFile)
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

// 台帳の組み立ては開発者向けの入口が持つ。利用者向けの入口からは分けてある
const TOOLS_CLI = fileURLToPath(new URL("../tools/cli.ts", import.meta.url))
const work = mkdtempSync(join(tmpdir(), "gen-scratch-"))

function fixture(name: string, code: string) {
  const path = join(work, name)
  writeFileSync(path, code)
  return path
}

/**
 * 追跡下の知識層を写す。壊す検査は写した側で行い、追跡下に手を付けない。
 */
function copyKnowledge(dir: string) {
  cpSync(fileURLToPath(new URL("../docs/knowledge", import.meta.url)), dir, {
    recursive: true,
  })
}

/**
 * 作品のディレクトリを 1 つ作る。
 *
 * `code` はスプライトの記法
 */
function project(name: string, code: string) {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "project.yaml"),
    ["スプライト:", "  - 名前: ネコ", "    スクリプト: main.sbk"].join("\n"),
  )
  writeFileSync(join(dir, "main.sbk"), code)
  return dir
}

test("記法から SVG を書き出し、終了コード 0 で終わる", async () => {
  const input = fixture("ok.sbk", "緑の旗が押されたとき\n(10) 歩動かす\n")
  const out = join(work, "ok.svg")
  const { stdout } = await run(process.execPath, [
    CLI, "render", input, "--out", out,
  ])
  assert.equal(stdout.trim(), out)
  assert.match(readFileSync(out, "utf8"), /^<svg/)
})

test("PNG も書き出せる", async () => {
  const input = fixture("png.sbk", "緑の旗が押されたとき\n(10) 歩動かす\n")
  const out = join(work, "png.png")
  await run(process.execPath, [CLI, "render", input, "--out", out])
  assert.deepEqual([...readFileSync(out).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test("認識できないブロックがあると終了コード 1 で止まる", async () => {
  const input = fixture("ng.sbk", "緑の旗が押されたとき\nほげほげする\n")
  const error = await run(process.execPath, [
    CLI, "render", input, "--out", join(work, "ng.svg"),
  ]).then(() => null, e => e)

  assert.ok(error, "認識できない記法なのに成功している")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /認識できないブロックが 1 件ある/)
  assert.match(error.stderr, /ng\.sbk:2: ほげほげする/)
})

test("ブロックが 1 つも無い入力は成功にしない", async () => {
  const input = fixture("empty.sbk", "\n\n")
  for (const format of ["svg", "png"]) {
    const error = await run(process.execPath, [
      CLI, "render", input, "--out", join(work, `empty.${format}`),
    ]).then(() => null, e => e)

    assert.ok(error, `${format}: 空の入力なのに成功している`)
    assert.equal(error.code, 1)
    assert.match(error.stderr, /ブロックが 1 つも無い/)
    // 例外が素通りしてスタックトレースで落ちていないこと
    assert.doesNotMatch(error.stderr, /invalid size/)
  }
})

test("台帳を書き出し、覆わない範囲を申告する", async () => {
  const out = join(work, "blocks.json")
  const { stdout } = await run(process.execPath, [TOOLS_CLI, "catalog", "--out", out])

  assert.match(stdout, /台帳: \d+ 件/)
  assert.match(stdout, /覆わない範囲:/)
  // 申告は群ごとに件数を出す。0 件を装わないことを、群の存在で確かめる
  assert.match(stdout, /core の外のカテゴリ: [1-9]\d* 件/)
  assert.match(stdout, /台帳から到達しない opcode: [1-9]\d* 件/)

  const written = JSON.parse(readFileSync(out, "utf8"))
  assert.ok(written.ブロック.length > 100)
})

test("追跡下の台帳が組み立て直したものと一致する", async () => {
  const { stdout } = await run(process.execPath, [TOOLS_CLI, "catalog", "--check"])
  assert.match(stdout, /最新/)
})

test("台帳が古いと --check が終了コード 1 で止まる", async () => {
  const stale = join(work, "stale.json")
  writeFileSync(stale, "{}\n")
  const error = await run(process.execPath, [
    TOOLS_CLI, "catalog", "--check", "--out", stale,
  ]).then(() => null, e => e)

  assert.ok(error, "古い台帳なのに成功している")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /台帳が古い/)
  assert.match(error.stderr, /書き出し直す: node tools\/cli\.ts catalog --out /)
  assert.ok(error.stderr.includes(stale), "示したコマンドが渡した書き出し先を指していない")
})

test("追跡下のブロック解説が台帳と一致する", async () => {
  const { stdout } = await run(process.execPath, [CLI, "knowledge", "--check"])
  assert.match(stdout, /生成した層は最新/)
  assert.match(stdout, /9 カテゴリ \/ ブロック 119 件/)
  assert.match(stdout, /定義のキー 11 個/)
})

test("解説が古いと --check が終了コード 1 で止まる", async () => {
  const dir = join(work, "stale-knowledge")
  copyKnowledge(dir)
  const page = join(dir, "blocks", "motion.md")
  writeFileSync(page, readFileSync(page, "utf8").replace(/motion_movesteps/, "motion_wrong"))

  const error = await run(process.execPath, [
    CLI, "knowledge", "--check", "--dir", dir,
  ]).then(() => null, e => e)

  assert.ok(error, "書き換えた解説なのに最新と言っている")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /生成した層が古い/)
  // 古いと告げるだけでは、書き手は次に打つものを自分で組み立てることになる。
  // しかも渡された置き場を反映しないと、示したとおりに打っても照合した先は直らない
  assert.match(error.stderr, /書き出し直す: node src\/cli\.ts knowledge --dir /)
  assert.ok(error.stderr.includes(dir), "示したコマンドが渡した置き場を指していない")
})

test("空白を含む置き場でも、示した復帰コマンドがそのまま打てる", async () => {
  // 裸で並べると 2 つ目が位置引数として弾かれ、示したとおりに打っても復帰できない
  const dir = join(work, "stale knowledge")
  copyKnowledge(dir)
  const page = join(dir, "blocks", "motion.md")
  writeFileSync(page, readFileSync(page, "utf8").replace(/motion_movesteps/, "motion_wrong"))

  const error = await run(process.execPath, [
    CLI, "knowledge", "--check", "--dir", dir,
  ]).then(() => null, e => e)

  assert.ok(error, "書き換えた解説なのに最新と言っている")
  assert.match(error.stderr, /書き出し直す: node src\/cli\.ts knowledge --dir "/)
  assert.ok(error.stderr.includes(`"${dir}"`), "空白を含む置き場を囲んでいない")
})

test("作品定義の仕様が実装と食い違うと --check が終了コード 1 で止まる", async () => {
  const dir = join(work, "stale-definition")
  copyKnowledge(dir)
  const page = join(dir, "project-definition.md")
  const text = readFileSync(page, "utf8")
  const broken = text.replace("| `向き` | 数 |", "| `向き` | 文字列 |")
  assert.notEqual(broken, text, "仕様の表を壊せていない（検査が何も測らない）")
  writeFileSync(page, broken)

  const error = await run(process.execPath, [
    CLI, "knowledge", "--check", "--dir", dir,
  ]).then(() => null, e => e)

  assert.ok(error, "書き換えた仕様なのに最新と言っている")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /project-definition/)
})

test("古びた申告が出どころを名指す", async () => {
  // 目印は出どころごとに分けてある。申告が「台帳」で揃っていると、実装の表から出る
  // ページの直し先を誤って伝える
  const dir = join(work, "stale-origin")
  copyKnowledge(dir)
  const page = join(dir, "project-definition.md")
  const text = readFileSync(page, "utf8")
  const broken = text.replace("| `向き` | 数 |", "| `向き` | 文字列 |")
  assert.notEqual(broken, text, "仕様の表を壊せていない")
  writeFileSync(page, broken)

  const error = await run(process.execPath, [
    CLI, "knowledge", "--check", "--dir", dir,
  ]).then(() => null, e => e)

  assert.ok(error)
  assert.match(error.stderr, /定義の表と一致しない/)
  assert.doesNotMatch(error.stderr, /台帳と一致しない/)
})

test("ブロック解説の古びた申告は台帳を名指す", async () => {
  const dir = join(work, "stale-origin-catalog")
  copyKnowledge(dir)
  const page = join(dir, "blocks", "motion.md")
  writeFileSync(page, readFileSync(page, "utf8").replace(/motion_movesteps/, "motion_wrong"))

  const error = await run(process.execPath, [
    CLI, "knowledge", "--check", "--dir", dir,
  ]).then(() => null, e => e)

  assert.ok(error)
  assert.match(error.stderr, /台帳と一致しない/)
})

test("1 ページでも組み立てられなければ、どのページも書き換えない", async () => {
  // 読みながら書くと、途中で失敗したときに先行ページだけが新しくなり、半分だけ
  // 更新された知識層が残る（build 側の「検証は書き出しの前に置く」と同じ規律）
  const dir = join(work, "all-or-nothing")
  copyKnowledge(dir)

  // 先に処理されるページを古くし、後から処理されるページの目印を壊す
  const first = join(dir, "blocks", "motion.md")
  const stale = readFileSync(first, "utf8").replace(/motion_movesteps/, "motion_wrong")
  writeFileSync(first, stale)
  const later = join(dir, "blocks", "list.md")
  writeFileSync(later, readFileSync(later, "utf8").replace("<!-- 台帳から生成: ここから -->", ""))

  const error = await run(process.execPath, [
    CLI, "knowledge", "--dir", dir,
  ]).then(() => null, e => e)

  assert.ok(error, "目印が壊れているのに成功している")
  assert.equal(error.code, 1)
  assert.equal(readFileSync(first, "utf8"), stale, "止まったのに先行ページを書き換えている")
})

test("生成の目印が無い解説で終了コード 1 で止まる", async () => {
  const dir = join(work, "no-marker")
  copyKnowledge(dir)
  const page = join(dir, "blocks", "sound.md")
  writeFileSync(page, readFileSync(page, "utf8").replace(/<!-- 台帳から生成: ここから -->/, ""))

  const error = await run(process.execPath, [
    CLI, "knowledge", "--dir", dir,
  ]).then(() => null, e => e)

  assert.ok(error, "目印が無いのに書き換えている")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /目印が無い/)
})

test("解説ファイルが足りないと終了コード 1 で止まる", async () => {
  const dir = join(work, "missing-page")
  mkdirSync(dir, { recursive: true })

  const error = await run(process.execPath, [
    CLI, "knowledge", "--dir", dir,
  ]).then(() => null, e => e)

  assert.ok(error, "解説が 1 つも無いのに成功している")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /解説を読めない/)
})

test("台帳に無いブロックを含む作品は、行を示して終了コード 1 で止まる", async () => {
  const dir = project("unknown-block", "緑の旗が押されたとき\nほげほげする\n(10) 歩動かす")
  const out = join(work, "unknown-block.sb3")
  const error = await run(process.execPath, [
    CLI, "build", dir, "--out", out,
  ]).then(() => null, e => e)

  assert.ok(error, "台帳に無いブロックなのに成功している")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /台帳に無いブロック/)
  assert.match(error.stderr, /main\.sbk:2 ほげほげする/)
  // 半分だけ生成した .sb3 は Scratch では開けてしまい、成功と見分けが付かない
  assert.equal(existsSync(out), false, "止まったのに .sb3 を書き出している")
})

test("引数の書き方が台帳と噛み合わない記法を、行を示して終了コード 1 で止まる", async () => {
  // 値の欄へドロップダウンを書いても、これまでは黙って文字として通っていた
  const dir = project("mismatch", "緑の旗が押されたとき\n[こんにちは v] と言う\n(10) 歩動かす")
  const out = join(work, "mismatch.sb3")
  const error = await run(process.execPath, [
    CLI, "build", dir, "--out", out,
  ]).then(() => null, e => e)

  assert.ok(error, "噛み合わない引数なのに成功している")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /引数の書き方が台帳と噛み合わない/)
  assert.match(error.stderr, /main\.sbk:2/)
  assert.equal(existsSync(out), false, "止まったのに .sb3 を書き出している")
})

test("解析器は知っていても台帳に無いブロックで止まる", async () => {
  // 拡張機能（ペン）は本作業の非目標。記法としては成立するので、認識できない記述とは
  // 別の枝で止まる。この枝を通る入力が無いと、片方の枝だけを見張ることになる
  const dir = project("extension-block", "緑の旗が押されたとき\nペンを下ろす")
  const error = await run(process.execPath, [
    CLI, "build", dir, "--out", join(work, "extension-block.sb3"),
  ]).then(() => null, e => e)

  assert.ok(error, "台帳に無い拡張機能のブロックなのに成功している")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /台帳に無いブロック/)
  assert.match(error.stderr, /識別子 pen\.penDown が台帳に無い/)
  assert.match(error.stderr, /main\.sbk:2 /)
})

test("宣言の無い変数を含む作品も終了コード 1 で止まる", async () => {
  const dir = project("unknown-var", "[未宣言 v] を (1) にする")
  const error = await run(process.execPath, [
    CLI, "build", dir, "--out", join(work, "unknown-var.sb3"),
  ]).then(() => null, e => e)

  assert.ok(error, "宣言の無い変数なのに成功している")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /変数が宣言されていない/)
})

test("入力ファイルが無いと終了コード 1 で止まる", async () => {
  const error = await run(process.execPath, [
    CLI, "render", join(work, "missing.sbk"),
  ]).then(() => null, e => e)

  assert.ok(error, "存在しない入力なのに成功している")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /記法ファイルを読めない/)
})

/**
 * 知識層の markdown を CRLF に置き換える。Git for Windows の既定で clone した作業ツリーを
 * 手元で作る。
 */
function toCrlf(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      toCrlf(path)
      continue
    }
    if (!path.endsWith(".md")) continue
    writeFileSync(path, readFileSync(path, "utf8").split("\n").join("\r\n"))
  }
}

/**
 * 改行の数を数える。混在しているかを測るため CRLF と単独の LF を分けて返す。
 */
function endingsOf(path: string) {
  const text = readFileSync(path, "utf8")
  return {
    crlf: (text.match(/\r\n/g) ?? []).length,
    lf: (text.match(/(^|[^\r])\n/g) ?? []).length,
  }
}

test("CRLF の知識層を「古い」でなく改行として名指す", async () => {
  // 中身は合っているのに一覧を作り直せと言われ、作り直しても直らない状態だった
  const dir = join(work, "crlf-knowledge")
  copyKnowledge(dir)
  toCrlf(dir)

  const error = await run(process.execPath, [
    CLI, "knowledge", "--check", "--dir", dir,
  ]).then(() => null, e => e)

  assert.ok(error, "CRLF なのに最新と言っている")
  assert.equal(error.code, 1)
  assert.match(error.stderr, /改行が LF でない/)
  assert.doesNotMatch(error.stderr, /生成した層が古い/, "改行の違いを古さと取り違えている")
})

test("CRLF の知識層を書き直すと、改行が混ざらない", async () => {
  // 揃えずに差し込むと、CRLF のページへ LF の一覧が入って混在したまま --check が緑になる
  const dir = join(work, "crlf-rewrite")
  copyKnowledge(dir)
  toCrlf(dir)

  await run(process.execPath, [CLI, "knowledge", "--dir", dir])

  const page = join(dir, "blocks", "motion.md")
  const { crlf, lf } = endingsOf(page)
  assert.ok(lf > 0, "書き直していない")
  assert.equal(crlf, 0, `改行が混ざっている（CRLF ${crlf} / 単独 LF ${lf}）`)

  const { stdout } = await run(process.execPath, [
    CLI, "knowledge", "--check", "--dir", dir,
  ])
  assert.match(stdout, /生成した層は最新/)
})

/** 旗を取るコマンドすべて。1 つでも抜けると、そのコマンドだけ扱いが割れる */
const COMMANDS = ["render", "build", "read", "knowledge"]

test("使い方は、求められたら標準出力へ出て 0 で終わる", async () => {
  // 標準エラーへ出していたので `| less` も `> usage.txt` も空になった。読もうとした人の
  // 手元に何も残らない（2026-08-22 実測）
  for (const args of [[], ["--help"], ...COMMANDS.map(command => [command, "--help"])]) {
    const done = await run(process.execPath, [CLI, ...args]).catch(e => e)
    const 名 = args.join(" ") || "(引数なし)"

    // 実害を先に置く。求めた人の標準出力に届くことが要る
    assert.match(String(done.stdout), /使い方:/, `${名} が標準出力へ出していない`)
    assert.equal(String(done.stderr), "", `${名} が標準エラーへも出している`)
    assert.ok(!(done instanceof Error), `${名} が 0 以外で終わった`)
  }
})

test("止まって出す使い方は、標準エラーへ出る", async () => {
  // 対照。出す先で「求めて出した」と「止まって出した」を分ける。両方を標準出力へ
  // 出すと、成功したのか止まったのかがパイプの先から見分けられない
  const done = await run(process.execPath, [CLI, "しらないコマンド"]).catch(e => e)
  assert.match(String(done.stderr), /使い方:/, "止まったのに標準エラーへ出していない")
  assert.equal(String(done.stdout), "", "止まったのに標準出力へ出した")
  assert.equal(done.code, 1, "止まったのに 0 で終わった")
})

test("空の値を渡した旗は、どのコマンドでも同じように弾く", async () => {
  // `render` と `build` は既定へ倒し、`read` は弾いたが何が悪いかを言わなかった。
  // 打ち間違いが既定で静かに通るのが害である
  // 旗はコマンドごとに違う。持たない旗を渡すと引数の受け口が先に止め、測る対象を失う
  const 置き場の旗 = {
    render: "--out",
    build: "--out",
    read: "--out",
    knowledge: "--dir",
  }
  for (const command of COMMANDS) {
    const flag = (置き場の旗 as Record<string, string>)[command]
    assert.ok(flag, `${command} の旗を挙げていない`)
    // 位置引数は渡さない。`knowledge` は取らないので、渡すと引数の受け口が先に止める。
    // 空の砦は位置引数の要求より手前に置いてあるので、これで測れる
    const done = await run(process.execPath, [CLI, command, flag, ""]).catch(e => e)

    // 実害を先に置く。空の値が既定として静かに通らないこと
    assert.equal(done.code, 1, `${command} ${flag} "" が止まらなかった`)
    assert.match(
      String(done.stderr),
      new RegExp(`${flag} に空の値`),
      `${command} ${flag} "" が何が悪いかを言わない`,
    )
  }
})

test("拡大率に上限が掛かる", async () => {
  // 上限が無いと、1 回の指定で 1 枚 16.9 MB・249 秒の図を作れた（2026-08-22 実測）。
  // `read` では同じ指定が全スクリプトへ掛かる
  const path = fixture("scale.sbk", "(10) 歩動かす\n")
  const 越える = [CLI, "render", path, "--scale", "100"]
  const done = await run(process.execPath, 越える).catch(e => e)

  // 実害を先に置く。上限を超えた指定で図が書き出されないこと
  assert.equal(done.code, 1, "上限を超えた拡大率で書き出した")
  assert.match(String(done.stderr), /--scale は \d+ 倍までにする/, "上限を言わずに止めた")

  // 対照。上限の内側は通る ── 「常に止める」実装でも緑にならないようにする
  const 通る = await run(process.execPath, [
    CLI, "render", path, "--out", join(work, "scale-ok.svg"), "--scale", "2",
  ])
  assert.match(String(通る.stdout), /scale-ok\.svg/, "上限の内側を止めた")
})

test("申告の見出しが、その申告の出どころを述べる", () => {
  // ひとまとめの「申告が N 件ある」だと、読み手は自分の作品が悪いのか道具が悪いのかを
  // 自分で当てることになる。2 つに割っていたころは、台帳の申告が「読み切れなかった
  // 箇所」を、資源の上限による拒否が「検証器が弾いた理由」を名乗っていた（どちらも偽。
  // CP6 で 2 観点が指摘）
  const 申告 = [
    { kind: "大きすぎる", subject: "x", refusal: true, intake: true },
    { kind: "台帳の型が違う", subject: "x", catalog: true },
    { kind: "公式検証器が弾いた", subject: "x", refusal: true },
    { kind: "記法へ戻せない", subject: "x" },
  ]
  const 行き先 = new Map(
    announcementGroups(申告).flatMap(([heading, group]) =>
      group.map(problem => [problem.kind, heading]),
    ),
  )

  // 実害を先に置く。出どころの違うものが同じ見出しへ落ちないこと
  assert.equal(行き先.get("台帳の型が違う"), "台帳を使えない理由", "台帳の申告の行き先")
  assert.equal(行き先.get("大きすぎる"), "受け入れ検査で断った理由", "資源の拒否の行き先")
  assert.equal(行き先.get("公式検証器が弾いた"), "検証器が弾いた理由", "検証器の行き先")
  assert.equal(行き先.get("記法へ戻せない"), "読み切れなかった箇所", "読み残しの行き先")
  assert.equal(行き先.size, 4, "同じ申告が 2 つの組に入った")
})

test("印を持たない申告も行き先を失わない", () => {
  // 対照。次に印を足した申告が、どの組にも入らず黙って消えることが無いこと
  const 申告 = [{ kind: "まだ印の無い申告", subject: "x" }]
  const 並んだ = announcementGroups(申告).flatMap(([, group]) => group)
  assert.equal(並んだ.length, 1, `どの組にも入らなかった: ${JSON.stringify(並んだ)}`)
})
