import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildProject } from "../src/project.ts"
import { LIST_FALLBACK, SPRITE_KEYS, VARIABLE_FALLBACK } from "../src/definition.ts"
import { officialProblems } from "../src/validate.ts"
import { detailOf } from "./fixtures.ts"

/** Windows の区切り。ソースへ裸で書くと読む側が数を取り違える */
const SEP = String.fromCharCode(92)

/**
 * 作品を一時ディレクトリへ書いて組み立てる。
 *
 * `options` は台帳の位置。壊れた台帳を渡す検査で使う
 */
async function build(
  files: Record<string, string>,
  options: { catalogPath?: string | URL } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-"))
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  return buildProject(dir, options)
}

/** 公式検証器へ通す。通らなければ理由つきで落とす */
async function official(project: any) {
  const [problem] = await officialProblems(Buffer.from(JSON.stringify(project)), "ためし")
  if (problem) throw new Error(`公式検証器が弾いた: ${problem.detail}`)
  return true
}

const SAMPLE = {
  "project.yaml": [
    "名前: ためし",
    "ステージ:",
    "  スクリプト: stage.sbk",
    "  変数:",
    "    スコア: 0",
    "  リスト:",
    "    記録: []",
    "スプライト:",
    "  - 名前: ネコ",
    "    スクリプト: neko.sbk",
    "    x: 10",
    "    y: -20",
  ].join("\n"),
  "stage.sbk": ["[はじめ v] を受け取ったとき", "[スコア v] を (0) にする"].join("\n"),
  "neko.sbk": [
    "緑の旗が押されたとき",
    "[はじめ v] を送る",
    "ずっと",
    "  ((1) から (10) までの乱数) 歩動かす",
    "  もし <[マウスのポインター v] に触れた> なら",
    "    [スコア v] を (1) ずつ変える",
    "    (スコア) を [記録 v] に追加する",
    "  でなければ",
    "    [どこかの場所 v] へ行く",
    "  end",
    "end",
  ].join("\n"),
}

test("作品からステージとスプライトを組み立てる", async () => {
  const { project, problems } = await build(SAMPLE)
  assert.deepEqual(problems, [])

  const [stage, neko] = project.targets
  assert.equal(stage.isStage, true)
  assert.equal(stage.name, "Stage")
  assert.equal(neko.isStage, false)
  assert.equal(neko.name, "ネコ")
  assert.equal(neko.x, 10)
  assert.equal(neko.y, -20)

  // ターゲットごとにスクリプトが分かれている
  assert.ok(Object.keys(stage.blocks).length > 0)
  assert.ok(Object.keys(neko.blocks).length > 0)
})

test("組み立てた project.json が公式検証器を通る", async () => {
  const { project, problems } = await build(SAMPLE)
  assert.deepEqual(problems, [])
  await official(project)
})

test("変数とリストの初期値を定義から取る", async () => {
  const { project } = await build(SAMPLE)
  const [stage] = project.targets

  assert.deepEqual(Object.values(stage.variables), [["スコア", 0]])
  assert.deepEqual(Object.values(stage.lists), [["記録", []]])
  // 変数とリストは実行時に 1 つの表へ集まる。ID が衝突しないよう種別を前置する
  const ids = [...Object.keys(stage.variables), ...Object.keys(stage.lists)]
  assert.equal(new Set(ids).size, ids.length)
})

test("ステージの変数をスプライトから参照できる", async () => {
  const { project, problems } = await build(SAMPLE)
  assert.deepEqual(problems, [])

  const [stage, neko] = project.targets
  const id = Object.keys(stage.variables)[0]
  const change = Object.values<any>(neko.blocks).find(b => b.opcode === "data_changevariableby")
  assert.deepEqual((change as any).fields.VARIABLE, ["スコア", id])
})

test("スプライトの変数はそのスプライトが持ち、ステージのものと ID が別になる", async () => {
  const { project, problems } = await build({
    "project.yaml": [
      "ステージ:",
      "  変数:",
      "    数: 0",
      "スプライト:",
      "  - 名前: ネコ",
      "    スクリプト: neko.sbk",
      "    変数:",
      "      数: 5",
    ].join("\n"),
    "neko.sbk": "[数 v] を (1) ずつ変える",
  })
  assert.deepEqual(problems, [])

  const [stage, neko] = project.targets
  assert.deepEqual(Object.values(neko.variables), [["数", 5]])
  const [stageId] = Object.keys(stage.variables)
  const [nekoId] = Object.keys(neko.variables)
  assert.notEqual(stageId, nekoId, "同名の変数が同じ ID になっている")

  // 自分の持ち物を先に見る。ステージ側を掴むと初期値が食い違う
  const change = Object.values<any>(neko.blocks).find(b => b.opcode === "data_changevariableby")
  assert.deepEqual((change as any).fields.VARIABLE, ["数", nekoId])
})

test("放送は記法から集めてステージが持つ", async () => {
  const { project, problems } = await build(SAMPLE)
  assert.deepEqual(problems, [])

  const [stage, neko] = project.targets
  assert.deepEqual(Object.values(stage.broadcasts), ["はじめ"])
  assert.deepEqual(Object.values(neko.broadcasts), [], "放送をスプライトに持たせている")

  // 送る側と受け取る側が同じ ID を指す
  const [id] = Object.keys(stage.broadcasts)
  const send = Object.values<any>(neko.blocks).find(b => b.opcode === "event_broadcast")
  assert.deepEqual(send.inputs.BROADCAST_INPUT, [1, [11, "はじめ", id]])
  const receive = Object.values<any>(stage.blocks).find(
    b => b.opcode === "event_whenbroadcastreceived",
  )
  assert.deepEqual((receive as any).fields.BROADCAST_OPTION, ["はじめ", id])
})

test("コスチュームを 1 つ同梱し、素材の名前が中身から決まる", async () => {
  const { project, assets } = await build(SAMPLE)

  for (const target of project.targets) {
    assert.equal(target.costumes.length, 1, `${target.name} のコスチュームが 1 つでない`)
    assert.match(target.costumes[0].assetId, /^[0-9a-f]{32}$/)
    assert.equal(target.costumes[0].md5ext, `${target.costumes[0].assetId}.svg`)
  }

  // 素材の名前は中身の md5。zip へ収めるときのファイル名と一致する
  const names = new Set(assets.map(a => a.name))
  for (const target of project.targets) {
    assert.ok(names.has(target.costumes[0].md5ext), `${target.name} の素材が assets に無い`)
  }
})

test("拡張機能の申告を、使ったブロックから導く", async () => {
  const withPen = await build({
    "project.yaml": ["スプライト:", "  - 名前: 絵かき", "    スクリプト: e.sbk"].join("\n"),
    "e.sbk": ["ペンを下ろす", "(10) 歩動かす"].join("\n"),
  })
  assert.deepEqual(withPen.problems, [])
  assert.deepEqual(withPen.project.extensions, ["pen"])
  await official(withPen.project)

  // 使っていなければ空で申告する。0 件を装わず、欄そのものは出す
  const without = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ", "    スクリプト: n.sbk"].join("\n"),
    "n.sbk": "(10) 歩動かす",
  })
  assert.deepEqual(without.problems, [])
  assert.deepEqual(without.project.extensions, [])
})

test("台帳で解けないブロックを問題として返し、記法ファイルと行を示す", async () => {
  const { problems } = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ", "    スクリプト: neko.sbk"].join("\n"),
    "neko.sbk": ["(10) 歩動かす", "そんなブロックはない"].join("\n"),
  })

  // 同じブロックを解析側と直列化側で二重に報告しない
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "台帳に無いブロック")
  assert.match(problems[0].subject, /^neko\.sbk:2 /)
})

test("宣言されていない変数を、記法ファイルを示して止める", async () => {
  const { problems } = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ", "    スクリプト: neko.sbk"].join("\n"),
    "neko.sbk": "[未宣言 v] を (1) にする",
  })

  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "変数が宣言されていない")
  assert.match(problems[0].subject, /^neko\.sbk:1 /)
})

test("記法ファイルが無いことを黙って空のスクリプトにしない", async () => {
  const { problems } = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ", "    スクリプト: 無い.sbk"].join("\n"),
  })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "記法ファイルを読めない")
})

test("スクリプトを持たないターゲットも成立する", async () => {
  const { project, problems } = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ"].join("\n"),
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(project.targets[1].blocks, {})
  await official(project)
})

test("キーを省略したスプライトが、仕様の表が持つ既定値になる", async () => {
  const { project, problems } = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ"].join("\n"),
  })
  assert.deepEqual(problems, [])

  // キーと project.json の欄の対応は実装から借りず書き下す。借りると、組み立てが欄を
  // 取り違えても検査が一緒に取り違える
  const fields = { x: "x", y: "y", 表示: "visible", 大きさ: "size", 向き: "direction" }
  for (const [key, field] of Object.entries(fields)) {
    assert.equal(
      project.targets[1][field],
      SPRITE_KEYS[key].fallback,
      `${key} の既定値が仕様の表と違う`,
    )
  }
})

test("初期値を省略した変数とリストが、仕様の表が持つ既定値になる", async () => {
  const { project, problems } = await build({
    "project.yaml": ["ステージ:", "  変数:", "    スコア:", "  リスト:", "    記録:"].join("\n"),
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(Object.values(project.targets[0].variables), [["スコア", VARIABLE_FALLBACK]])
  assert.deepEqual(Object.values(project.targets[0].lists), [["記録", LIST_FALLBACK]])
})

test("定義の知らないキーを綴りの誤りとして申告する", async () => {
  // キーを誤ると中身の無いスプライトになり、終了コード 0 で「開くが何もしない」.sb3 が出る
  const { problems } = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ", "    スクリプト名: neko.sbk"].join("\n"),
    "neko.sbk": "(10) 歩動かす",
  })

  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "定義に知らないキーがある")
  assert.match(problems[0].subject, /スクリプト名/)
})

test("定義の値の型が違えば止める", async () => {
  // YAML 1.2 では no は真偽値でなく文字列。visible が文字列の .sb3 は公式検証器が弾く
  const wrong = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ", "    表示: no"].join("\n"),
  })
  assert.equal(wrong.problems.length, 1)
  assert.equal(wrong.problems[0].kind, "定義の値の型が違う")

  const number = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ", "    x: 右のほう"].join("\n"),
  })
  assert.equal(number.problems.length, 1)
  assert.equal(number.problems[0].kind, "定義の値の型が違う")

  // 正しく書けば通る
  const ok = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ", "    表示: false", "    x: 10"].join("\n"),
  })
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.project.targets[1].visible, false)
})

test("リストの初期値が並びでなければ止める", async () => {
  const { problems } = await build({
    "project.yaml": ["ステージ:", "  リスト:", "    記録: 5"].join("\n"),
  })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "リストの初期値が並びでない")
})

test("同じ名前のスプライトと、予約された名前を止める", async () => {
  // 同名だと先に書いた側の宣言が消え、両者が同じ変数 ID を名乗る
  const same = await build({
    "project.yaml": [
      "スプライト:",
      "  - 名前: ネコ",
      "    変数:",
      "      得点: 1",
      "  - 名前: ネコ",
      "    変数:",
      "      得点: 99",
    ].join("\n"),
  })
  assert.equal(same.problems.length, 1)
  assert.equal(same.problems[0].kind, "同じ名前のスプライトが 2 つある")

  // Stage という名前のスプライトはステージの変数を丸ごと覆い隠す
  const reserved = await build({
    "project.yaml": ["スプライト:", "  - 名前: Stage"].join("\n"),
  })
  assert.equal(reserved.problems.length, 1)
  assert.equal(reserved.problems[0].kind, "スプライトに使えない名前")
})

test("何も宣言していない定義を、黙って空の作品にしない", async () => {
  // 空の定義は「Scratch で開けるが何も起きない .sb3」になる。終了コードが 0 だと
  // 成功と見分けが付かない（記法の側は render が同じ状況を塞いでいる）
  for (const body of ["", "# 書きかけ\n", "名前: ためし\n"]) {
    const { problems } = await build({ "project.yaml": body })
    const empty = problems.filter(p => p.kind === "作品の定義が空")
    assert.equal(empty.length, 1, `空の定義を通している: ${JSON.stringify(body)}`)
  }
})

test("ステージだけ、スプライトだけの定義は空として止めない", async () => {
  // 止めすぎると、片方だけの正当な作品が作れなくなる
  const stage = await build({
    "project.yaml": ["ステージ:", "  変数:", "    スコア: 0"].join("\n"),
  })
  assert.deepEqual(stage.problems, [])

  const sprite = await build({
    "project.yaml": ["スプライト:", "  - 名前: ネコ"].join("\n"),
  })
  assert.deepEqual(sprite.problems, [])
})

test("名前に / を含む宣言が同じ ID になることを、ID を根拠に止める", async () => {
  // ID は名前から導くので単射でない。このまま出すと、スプライト側のブロックは名前を
  // 表示したまま ID では別の変数を指す。公式検証器は通り終了コードも 0 になる
  const { problems } = await build({
    "project.yaml": [
      "ステージ:",
      "  変数:",
      "    ネコ/スコア: 111",
      "スプライト:",
      "  - 名前: ネコ",
      "    変数:",
      "      スコア: 222",
    ].join("\n"),
  })

  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "別の宣言が同じ ID になる")
  assert.match(detailOf(problems[0])!, /variable:ネコ\/スコア/)
  assert.match(problems[0].subject, /Stage の ネコ\/スコア/)
  assert.match(problems[0].subject, /ネコ の スコア/)
})

test("スプライトの名前に / を含む場合も衝突を捕まえる", async () => {
  // 衝突はステージとスプライトの間だけでなく、スプライト同士の間にも起きる
  const { problems } = await build({
    "project.yaml": [
      "スプライト:",
      "  - 名前: ネコ/ス",
      "    変数:",
      "      コア: 1",
      "  - 名前: ネコ",
      "    変数:",
      "      ス/コア: 2",
    ].join("\n"),
  })

  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "別の宣言が同じ ID になる")
})

test("同じ名前でも持ち主が違えば衝突として止めない", async () => {
  // 止めすぎると正当な作品が作れなくなる。落ちないことも別に測る
  const { project, problems } = await build({
    "project.yaml": [
      "ステージ:",
      "  変数:",
      "    スコア: 1",
      "スプライト:",
      "  - 名前: ネコ",
      "    変数:",
      "      スコア: 2",
    ].join("\n"),
  })

  assert.deepEqual(problems, [])
  assert.notEqual(
    Object.keys(project.targets[0].variables)[0],
    Object.keys(project.targets[1].variables)[0],
    "持ち主の違う変数が同じ ID になっている",
  )
})

test("壊れた台帳を例外でなく問題として申告する", async () => {
  // 投げると、呼ぶ側が持つ受け口を素通りして経路が切れる
  const broken = join(mkdtempSync(join(tmpdir(), "gen-scratch-")), "blocks.json")
  writeFileSync(broken, "これは JSON ではない")

  const { project, problems } = await build(
    { "project.yaml": ["スプライト:", "  - 名前: ネコ"].join("\n") },
    { catalogPath: broken },
  )

  assert.equal(project, null, "台帳を読めないのに組み立てている")
  assert.equal(problems.length, 1, `申告が 1 件でない: ${JSON.stringify(problems)}`)
  assert.equal(problems[0].kind, "台帳を読めない")
})

test("無い台帳も同じ経路で申告する", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "gen-scratch-")), "no-such-catalog.json")
  const { project, problems } = await build(
    { "project.yaml": ["スプライト:", "  - 名前: ネコ"].join("\n") },
    { catalogPath: missing },
  )

  assert.equal(project, null)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "台帳を読めない")
})

test("同じ作品から 2 回組み立てた project.json が一致する", async () => {
  const first = await build(SAMPLE)
  const second = await build(SAMPLE)
  assert.deepEqual(first.problems, [])
  // ID を含めて一致する。無作為な ID を振ると .sb3 が毎回変わる
  assert.equal(JSON.stringify(first.project), JSON.stringify(second.project))
})

/**
 * 行の引き当て。1 つのブロックが複数の問題を出しても全部に行が付くことと、
 * 同じ綴りの別のブロックが別の行を指すことを、両方とも測る。
 *
 * 片方だけでは測定器にならない。覚えるだけの実装は前者しか満たさず、消費をやめる
 * だけの実装は後者を壊す。
 */
test("同じブロックから 2 件出ても、どちらにも行が付く", async () => {
  const { problems } = await build({
    "project.yaml": ["ステージ:", "  スクリプト: stage.sbk"].join("\n"),
    // 2 つの引数がどちらも噛み合わない。1 つのブロックから 2 件出る
    "stage.sbk": ["緑の旗が押されたとき", "([あ v] から [い v] までの乱数) 歩動かす"].join("\n"),
  })

  const mismatched = problems.filter(p => p.kind === "引数の書き方が台帳と噛み合わない")
  assert.equal(mismatched.length, 2, "同じブロックから 2 件出ていない")
  for (const problem of mismatched) {
    assert.match(problem.subject, /^stage\.sbk:2 /, `行が付いていない: ${problem.subject}`)
  }
})

test("同じ綴りのブロックが並んでも、それぞれの行を指す", async () => {
  const { problems } = await build({
    "project.yaml": ["ステージ:", "  スクリプト: stage.sbk"].join("\n"),
    "stage.sbk": ["緑の旗が押されたとき", "[x v] 秒待つ", "[x v] 秒待つ", "[x v] 秒待つ"].join("\n"),
  })

  const places = problems
    .filter(p => p.kind === "引数の書き方が台帳と噛み合わない")
    .map(p => p.subject.split(" ")[0])
  assert.deepEqual(places, ["stage.sbk:2", "stage.sbk:3", "stage.sbk:4"])
})

test("定義側の申告が、ファイルと 1 始まりの番号と書かれた名前で指す", async () => {
  const { problems } = await build({
    "project.yaml": [
      "スプライト:",
      "  - 名前: ネコ",
      "    いろ: 赤",
      "  - スクリプト: inu.sbk",
    ].join("\n"),
  })

  const unknown = problems.find(p => p.kind === "定義に知らないキーがある")
  assert.equal(unknown?.subject, "project.yaml スプライト 1 番目「ネコ」: いろ")

  // 名前を書いていないスプライトは番号だけで指す。添字は 0 始まりにしない
  const unnamed = problems.find(p => p.kind === "スプライトに名前が無い")
  assert.equal(unnamed?.subject, "project.yaml スプライト 2 番目")
})

test("変数の初期値が値でなければ、書いた鍵を指して止める", async () => {
  const { problems } = await build({
    "project.yaml": ["ステージ:", "  変数:", "    メモ: [1, 2]"].join("\n"),
  })

  assert.deepEqual(
    problems.map(p => [p.kind, p.subject]),
    [["変数の初期値が値でない", "project.yaml ステージ: メモ"]],
  )
})

test("リストの要素が値でなければ、その番号を指して止める", async () => {
  const { problems } = await build({
    "project.yaml": ["ステージ:", "  リスト:", "    記録: [1, {a: 1}, 3]"].join("\n"),
  })

  assert.deepEqual(
    problems.map(p => [p.kind, p.subject]),
    // Scratch のリストは 1 始まりで、記法も `(1) 番目` と書く。0 始まりの添字で名指すと
    // 書き手が数えている位置と 1 つずれる
    [["リストの要素が値でない", "project.yaml ステージ: 記録 の 2 番目"]],
  )
})

test("宣言の並びが対応でなければ、添字ごとに申告を並べない", async () => {
  // `Object.entries("abc")` は添字と文字の組へ展開される。素朴に回すと 1 つの誤りから
  // 4 件が並ぶ（2026-08-19 実測）
  const { problems } = await build({
    "project.yaml": ["ステージ:", "  リスト: abc"].join("\n"),
  })

  assert.deepEqual(
    problems.map(p => p.kind),
    ["定義の値の型が違う"],
    "1 つの誤りから複数の申告が出ている",
  )
})

/**
 * 構文は正しいが中身の型が違う台帳。JSON として読めるところまでしか見ていなかったため、
 * 7 形のうち 5 形が例外で抜けていた（2026-08-19 実測）。容器の型と要素の型を測る。
 */
const BROKEN_TYPES = [
  ["中身が無い", "{}"],
  ["ブロックが null", '{"ブロック": null}'],
  ["ブロックが文字", '{"ブロック": "x"}'],
  ["最上位が並び", "[]"],
  ["最上位が数", "42"],
  ["最上位が null", "null"],
  ["覆わない範囲が無い", '{"ブロック": [], "生成元": {}}'],
]

test("型の違う台帳を、例外でなく問題として申告する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-"))
  for (const [index, [label, text]] of BROKEN_TYPES.entries()) {
    const path = join(dir, `${index}.json`)
    writeFileSync(path, text)

    const { project, problems } = await build(
      { "project.yaml": ["スプライト:", "  - 名前: ネコ"].join("\n") },
      { catalogPath: path },
    )
    assert.equal(project, null, `${label}: 組み立てを続けている`)
    assert.ok(problems.length > 0, `${label}: 黙って通している`)
    assert.equal(problems[0].kind, "台帳の型が違う", `${label}: ${problems[0].kind}`)
  }
})

test("台帳の項目が対応でなければ、その添字を指して申告する", async () => {
  // 容器だけを見ても、要素が対応でなければ引くときに壊れる
  const path = join(mkdtempSync(join(tmpdir(), "gen-scratch-")), "blocks.json")
  writeFileSync(
    path,
    JSON.stringify({ ブロック: [1, null, { identifier: "OK" }], 覆わない範囲: {}, 生成元: {} }),
  )

  const { problems } = await build(
    { "project.yaml": ["スプライト:", "  - 名前: ネコ"].join("\n") },
    { catalogPath: path },
  )
  const shapes = problems.filter(p => p.kind === "台帳の型が違う")
  assert.equal(shapes.length, 2, `要素を見ていない: ${JSON.stringify(problems)}`)
  assert.match(shapes[0].subject, /ブロック\[0\]$/)
  assert.match(shapes[1].subject, /ブロック\[1\]$/)
})

test("正しい型の台帳は、問題なく読める", async () => {
  // 対照。上の 2 件が「常に申告する」実装でも緑にならないようにする
  const path = join(mkdtempSync(join(tmpdir(), "gen-scratch-")), "blocks.json")
  writeFileSync(path, JSON.stringify({ ブロック: [], 覆わない範囲: {}, 生成元: {} }))

  const { problems } = await build(
    { "project.yaml": ["スプライト:", "  - 名前: ネコ"].join("\n") },
    { catalogPath: path },
  )
  assert.deepEqual(problems.filter(p => p.kind === "台帳の型が違う"), [])
})

test("スクリプトが作品のディレクトリの外を指したら、読まずに止める", async () => {
  for (const file of ["../外.sbk", "../../../../README.md", "/etc/passwd"]) {
    const { problems } = await build({
      "project.yaml": ["ステージ:", `  スクリプト: ${file}`].join("\n"),
    })
    assert.deepEqual(
      problems.map(p => p.kind),
      ["スクリプトが作品のディレクトリの外を指す"],
      `外を指す綴りを通している: ${file}`,
    )
  }
})

test("スクリプトの区切りが / でなければ止める", async () => {
  // Windows では組み上がり Linux では ENOENT になる。書いた機械では気づけない
  const { problems } = await build({
    "project.yaml": ["ステージ:", `  スクリプト: sub${SEP}main.sbk`].join("\n"),
  })
  assert.deepEqual(problems.map(p => p.kind), ["スクリプトの区切りが / でない"])
})

test("作品のディレクトリの中を指すスクリプトは通す", async () => {
  // 対照。上の 2 件が「常に止める」実装でも緑にならないようにする
  const { problems } = await build({
    "project.yaml": ["ステージ:", "  スクリプト: ./stage.sbk"].join("\n"),
    "stage.sbk": "緑の旗が押されたとき",
  })
  assert.deepEqual(problems, [])
})

test("作品の下にあれば、`..` で始まる名前のディレクトリも通す", async () => {
  // 相対の綴りを前方一致で見ると `..foo` が外に見える。解決した先が下にあるかで見る
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-"))
  mkdirSync(join(dir, "..foo"), { recursive: true })
  const yaml = ["ステージ:", "  スクリプト: ..foo/main.sbk"].join("\n")
  writeFileSync(join(dir, "project.yaml"), yaml)
  writeFileSync(join(dir, "..foo", "main.sbk"), "緑の旗が押されたとき")

  const { problems } = await buildProject(dir)
  assert.deepEqual(problems, [], "作品の下にあるのに外と見なしている")
})

test("下位ディレクトリのスクリプトも通す", async () => {
  // 通す側の対照。閉じ込めが「作品の直下だけ」に縮んでいないことを見る
  const { problems } = await build({
    "project.yaml": ["ステージ:", "  スクリプト: ./stage.sbk"].join("\n"),
    "stage.sbk": "緑の旗が押されたとき",
  })
  assert.deepEqual(problems, [])
})

test("最上位に 変数 を書いても、申告を 2 件並べない", async () => {
  // 書けるキーとして認めた場所でだけ初期値を見る。認めていない場所でも見ると
  // 「知らないキー」と初期値の申告が並ぶ
  const { problems } = await build({
    "project.yaml": ["変数:", "  メモ: [1, 2]"].join("\n"),
  })
  assert.deepEqual(
    problems.map(p => p.kind),
    ["作品の定義が空", "定義に知らないキーがある"],
    `申告が並んでいる: ${JSON.stringify(problems.map(p => p.kind))}`,
  )
})

test("申告の並びが、台帳を先にし、その後は定義に書いた順に従う", async () => {
  // TASK0002 で並びが黙って変わった。どの申告を先に読ませるかは診断の質そのものなので
  // 固定する。規則は 2 段ある ── 台帳の申告が先（台帳が欠けていれば以降の申告は
  // その結果でしかない）、その後は定義に書いた並びの順である。
  //
  // 種別ごとにまとめる実装でも緑にならないよう、同じ 2 件を順序だけ入れ替えて 2 度測る。
  // 片方だけだと、種別で並べる実装がたまたま一致して通りうる
  const path = join(mkdtempSync(join(tmpdir(), "gen-scratch-")), "blocks.json")
  // 識別子の無い項目を 1 つだけ持たせる。台帳としては読めるので、この後の段も走る
  writeFileSync(
    path,
    JSON.stringify({
      ブロック: [{ opcode: "識別子なし" }],
      覆わない範囲: {},
      生成元: {},
    }),
  )
  const 台帳 = "台帳の項目が識別子を持たない"
  const 名前無し = ["  - x: 1"]
  const 記法 = ["  - 名前: ネコ", "    スクリプト: neko.sbk"]

  const kindsOf = async (sprites: string[]) => {
    const { problems } = await build(
      {
        "project.yaml": ["名前: ためし", "スプライト:", ...sprites].join("\n"),
        "neko.sbk": "台帳に無いはずのブロック\n",
      },
      { catalogPath: path },
    )
    return problems.map(problem => problem.kind)
  }

  // 実害を先に置く。並びが崩れることが問題なので、まず並びそのものを測る
  assert.deepEqual(await kindsOf([...記法, ...名前無し]), [
    台帳,
    "台帳に無いブロック",
    "スプライトに名前が無い",
  ])
  assert.deepEqual(await kindsOf([...名前無し, ...記法]), [
    台帳,
    "スプライトに名前が無い",
    "台帳に無いブロック",
  ])
})

/**
 * ブロック定義を 2 つ持つ作品。片方だけを「再描画しない」と挙げる。
 *
 * 1 つでは足りない ── 全部を真にする実装でも緑になる。挙げていない側が偽のままで
 * あることまで見て、初めて「挙げたものだけ」を測ったことになる
 */
const WARP = {
  "project.yaml": [
    "名前: ためし",
    "スプライト:",
    "  - 名前: ネコ",
    "    スクリプト: neko.sbk",
    "    再描画しないブロック:",
    "      - しかくをかく (へん)",
  ].join("\n"),
  "neko.sbk": [
    "定義 しかくをかく (へん)",
    "(4) 回繰り返す",
    "  (へん) 歩動かす",
    "end",
    "",
    "定義 まつ",
    "(1) 秒待つ",
    "",
    "緑の旗が押されたとき",
    "しかくをかく (120)",
    "まつ",
  ].join("\n"),
}

/** mutation を持つブロックの、見たい欄だけ */
type Mutated = { mutation?: { proccode?: string, warp?: string } }

/** ブロック定義の綴りごとに、mutation の `warp` を集める */
function warpsIn(target: { blocks: Record<string, Mutated> }): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const block of Object.values(target.blocks)) {
    const mutation = block.mutation
    if (!mutation?.proccode) continue
    ;(found[mutation.proccode] ??= []).push(String(mutation.warp))
  }
  return found
}

test("再描画しないブロックに挙げた定義だけが warp を持つ", async () => {
  const { project, problems } = await build(WARP)
  assert.deepEqual(problems, [])
  const [, neko] = project.targets

  // 定義とプロトタイプと呼び出しの 3 つが同じ綴りを持つ。Scratch は定義の側を見るが、
  // 食い違ったまま出すと編集した利用者が別のブロックを作ってしまう
  assert.deepEqual(warpsIn(neko), {
    "しかくをかく %s": ["true", "true"],
    まつ: ["false", "false"],
  })

  await official(project)
})

test("再描画しないブロックの名前を、記法と同じ形で書ける", async () => {
  // 内部の綴り（`%s`）は Scratch の画面にも記法にも現れない。作品定義へ書かせると、
  // 写すだけで済むはずのものを覚え直させることになる
  const { project, problems } = await build({
    ...WARP,
    "project.yaml": WARP["project.yaml"].replace(
      "しかくをかく (へん)",
      "しかくをかく (なまえはなんでもよい)",
    ),
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(warpsIn(project.targets[1])["しかくをかく %s"], ["true", "true"])
})

test("挙げた名前が記法に無ければ、その名前を示して申告する", async () => {
  // 既定へ倒すと、綴りを取り違えた指定が黙って効かないまま生成が成功する。速さのために
  // 書いた指定なので、効かなくても動いてしまうのが一番わるい
  const { problems } = await build({
    ...WARP,
    "project.yaml": WARP["project.yaml"].replace("しかくをかく (へん)", "しかくをかく"),
  })
  assert.deepEqual(problems.map(p => p.kind), ["再描画しないブロックの名前が記法に無い"])

  // 書いたものと見比べられる形で返す。内部の綴りで返すと写した元と見比べられない
  assert.match(detailOf(problems[0]), /しかくをかく \(引数1\)/)
  assert.doesNotMatch(String(problems[0].subject ?? ""), /%s/)
})

test("再描画しないブロックの書き方が違えば、既定へ倒さず申告する", async () => {
  const kindsOf = async (written: string[]) =>
    (
      await build({
        ...WARP,
        "project.yaml": [
          "名前: ためし",
          "スプライト:",
          "  - 名前: ネコ",
          "    スクリプト: neko.sbk",
          ...written,
        ].join("\n"),
      })
    ).problems.map(p => p.kind)

  // 入れ物が並びでないことは、キーの型を引く共通の検査が見る。ここで二重に見ると
  // 同じ書き間違いへ申告が 2 件並ぶ（`変数` で一度そうなっていた）
  assert.deepEqual(await kindsOf(["    再描画しないブロック: しかくをかく (へん)"]), [
    "定義の値の型が違う",
  ])
  assert.deepEqual(await kindsOf(["    再描画しないブロック:", "      - 12"]), [
    "再描画しないブロックの書き方が違う",
  ])
  // 書かなければ何も起きない。申告は書き間違いにだけ出す
  assert.deepEqual(await kindsOf([]), [])
})

test("スクリプトを持たないターゲットでも、挙げた名前を黙って捨てない", async () => {
  // 記法を読む前に返る道がある。そこで見ないと、この指定だけが申告も無く消える
  const { problems } = await build({
    "project.yaml": [
      "名前: ためし",
      "スプライト:",
      "  - 名前: ネコ",
      "    再描画しないブロック:",
      "      - しかくをかく (へん)",
    ].join("\n"),
  })
  assert.deepEqual(problems.map(p => p.kind), ["再描画しないブロックの名前が記法に無い"])
  assert.match(detailOf(problems[0]), /ブロック定義を 1 つも持たない/)
})

test("同じ綴りのブロック定義が 2 つあれば申告する", async () => {
  // Scratch は綴りだけで定義と呼び出しを結ぶので、綴りが同じ定義が 2 つあると
  // どちらを呼ぶかを決められない。生成物は成立し公式検証器も通るため、
  // .sb3 を開くまで気づけない（CP6 で実測。申告 0 件だった）
  const { problems } = await build({
    "project.yaml": ["名前: ためし", "スプライト:", "  - 名前: ネコ", "    スクリプト: n.sbk"]
      .join("\n"),
    "n.sbk": ["定義 えがく", "(1) 歩動かす", "", "定義 えがく", "(2) 歩動かす"].join("\n"),
  })
  assert.deepEqual(problems.map(p => p.kind), ["同じ綴りのブロック定義が 2 つある"])

  // 対照。綴りが違えば通る。何を書いても申告する実装でも上は緑になる
  const 別 = await build({
    "project.yaml": ["名前: ためし", "スプライト:", "  - 名前: ネコ", "    スクリプト: n.sbk"]
      .join("\n"),
    "n.sbk": ["定義 えがく", "(1) 歩動かす", "", "定義 かく", "(2) 歩動かす"].join("\n"),
  })
  assert.deepEqual(別.problems, [])
})

test("作品定義の綴り合わせが、記法と同じゆれを吸収する", async () => {
  // 記法は解析器が全角の括弧を直し空白を畳んでから定義と呼び出しを結ぶ。こちらが
  // 吸収しないと、画面で見分けの付かない 2 つの綴りを並べて「記法に無い」と申告する
  const 記法 = ["定義 えがく (かず)", "(かず) 歩動かす"].join("\n")
  const kindsOf = async (書いた: string) =>
    (
      await build({
        "project.yaml": [
          "名前: ためし",
          "スプライト:",
          "  - 名前: ネコ",
          "    スクリプト: n.sbk",
          "    再描画しないブロック:",
          `      - ${書いた}`,
        ].join("\n"),
        "n.sbk": 記法,
      })
    ).problems.map(p => p.kind)

  // 全角の括弧・二重の空白・全角の空白。日本語入力ではどれも普通に出る
  assert.deepEqual(await kindsOf("えがく （かず）"), [])
  assert.deepEqual(await kindsOf("えがく  (かず)"), [])
  assert.deepEqual(await kindsOf("えがく　(かず)"), [])

  // 対照。本当に無い名前は止まる。全部通す実装でも上の 3 つは緑になる
  assert.deepEqual(await kindsOf("ちがう (かず)"), ["再描画しないブロックの名前が記法に無い"])
})

test("引数の ID が、綴りの長さに引きずられない", async () => {
  // ID が綴りを全長で抱えると、引数 N 個のブロックは N 個の ID それぞれに綴り全体を
  // 持つので二乗で伸びる（CP6 で N=100/200/400 の実測がある）
  const 長い = "とても長い名前を持つブロック定義"
  const idsOf = async (引数: number) => {
    const 並び = Array.from({ length: 引数 }, (_, i) => `(引数${i})`).join(" と ")
    const { project } = await build({
      "project.yaml": ["名前: ためし", "スプライト:", "  - 名前: ネコ", "    スクリプト: n.sbk"]
        .join("\n"),
      "n.sbk": `定義 ${長い} ${並び}\n(1) 歩動かす`,
    })
    const prototype = Object.values<any>(project.targets[1].blocks).find(
      block => block.opcode === "procedures_prototype",
    )
    return String(prototype.mutation.argumentids).length
  }

  // 引数を倍にしても、長さは倍までしか伸びない（綴りの長さが乗らない）
  const [a, b] = [await idsOf(2), await idsOf(4)]
  assert.ok(b < a * 2.5, `二乗で伸びている: 引数 2 個で ${a} / 4 個で ${b}`)
  // 較正。長さを 1 度も測れていないと上は通ってしまう
  assert.ok(a > 0 && b > a, `測る対象が無い: ${a} / ${b}`)
})

test("記法の行末が CRLF でも、綴りに復帰文字が入らない", async () => {
  // 解析器は改行だけを行の区切りにするので、CRLF だと復帰文字が行の中身へ残り、
  // ブロック定義の綴りの末尾に**画面で見えない文字**が入る。CRLF と LF が混ざった
  // 記法では申告 0 件で通っていた（CP6 の測り直しで実測）。Windows のエディタは
  // CRLF が既定で、追跡下を守る .gitattributes は手書きの記法に及ばない
  const CR = String.fromCharCode(13)
  const 本文 = ["定義 えがく (かず)", "(かず) 歩動かす", "", "緑の旗が押されたとき", "えがく (1)"]
  const spellsOf = async (記法: string) => {
    const { project, problems } = await build({
      "project.yaml": ["名前: ためし", "スプライト:", "  - 名前: ネコ", "    スクリプト: n.sbk"]
        .join("\n"),
      "n.sbk": 記法,
    })
    assert.deepEqual(problems, [], `申告が出た: ${記法.replace(/\r/g, "<CR>")}`)
    return [
      ...new Set(
        Object.values<{ mutation?: { proccode?: string } }>(project.targets[1].blocks)
          .filter(block => block.mutation?.proccode)
          .map(block => block.mutation!.proccode!),
      ),
    ]
  }

  // 3 通りとも同じ綴りになる。混在が一番わるい ── 全部 CRLF なら別の申告で止まるが、
  // 混ざると申告 0 件で復帰文字入りの綴りが通っていた
  const 期待 = ["えがく %s"]
  assert.deepEqual(await spellsOf(本文.join("\n")), 期待, "LF")
  assert.deepEqual(await spellsOf(本文.join(CR + "\n")), 期待, "CRLF")
  assert.deepEqual(await spellsOf(本文[0] + CR + "\n" + 本文.slice(1).join("\n")), 期待, "混在")
})

test("引数に名前が無いブロック定義を申告する", async () => {
  // 名前の無い引数は本体から参照できない。置き場だけがあって値を取り出せない
  // ブロックが、申告 0 件・公式検証器も通る形で出ていた（CP6 の測り直しで実測）
  const { problems } = await build({
    "project.yaml": ["名前: ためし", "スプライト:", "  - 名前: ネコ", "    スクリプト: n.sbk"]
      .join("\n"),
    "n.sbk": ["定義 えがく ()", "(1) 歩動かす"].join("\n"),
  })
  assert.deepEqual(problems.map(p => p.kind), ["ブロック定義の引数に名前が無い"])

  // 対照。名前があれば通る
  const 名前あり = await build({
    "project.yaml": ["名前: ためし", "スプライト:", "  - 名前: ネコ", "    スクリプト: n.sbk"]
      .join("\n"),
    "n.sbk": ["定義 えがく (かず)", "(かず) 歩動かす"].join("\n"),
  })
  assert.deepEqual(名前あり.problems, [])
})

test("定義がスクリプトの途中にあれば申告する", async () => {
  // `定義` は帽子なので、解析器はそこで新しいスクリプトを始める。前の続きのつもりで
  // 書くと前のスクリプトが中身を失い、旗を押しても何も起きない .sb3 が申告 0 件で
  // 出ていた（CP6 の測り直しで実測）
  const kindsOf = async (記法: string[]) =>
    (
      await build({
        "project.yaml": ["名前: ためし", "スプライト:", "  - 名前: ネコ", "    スクリプト: n.sbk"]
          .join("\n"),
        "n.sbk": 記法.join("\n"),
      })
    ).problems.map(p => p.kind)

  assert.deepEqual(await kindsOf(["緑の旗が押されたとき", "定義 えがく", "(1) 歩動かす"]), [
    "定義がスクリプトの途中にある",
  ])

  // 対照 2 つ。空行で割れば通る。先頭にあっても通る。どちらも申告する実装なら落ちる
  assert.deepEqual(
    await kindsOf(["緑の旗が押されたとき", "(1) 歩動かす", "", "定義 えがく", "(2) 歩動かす"]),
    [],
  )
  assert.deepEqual(await kindsOf(["定義 えがく", "(1) 歩動かす"]), [])
})
