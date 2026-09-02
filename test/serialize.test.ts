import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PRIMITIVES } from "../catalog/shadows.ts"
import { loadCatalog } from "../src/catalog.ts"
import { loadSnippets } from "../src/idioms.ts"
import { parseNotation } from "../src/parse.ts"
import {
  expectedAs,
  mismatchOf,
  serializeScripts,
  writtenAs,
} from "../src/serialize.ts"
import { catalogOrStop, detailOf } from "./fixtures.ts"

const catalog = catalogOrStop()

/**
 * 宣言済みの名前を持つ引き当て。作品の定義の代わりに使う。
 */
function names({ variable = [], list = [] }: { variable?: string[], list?: string[] } = {}) {
  const sets = { variable: new Set(variable), list: new Set(list) }
  return {
    idFor: (kind: string, name: string) => {
      // 放送は記法から集めるので、書かれていれば必ず引ける
      if (kind === "broadcast") return `broadcast:${name}`
      return sets[kind as "variable" | "list"].has(name) ? `${kind}:${name}` : null
    },
  }
}

/**
 * 記法を直列化する。
 */
async function serialize(code: string, declared?: { variable?: string[], list?: string[] }) {
  const doc = await parseNotation(code)
  return serializeScripts(doc, { catalog, names: names(declared) })
}

/** 影でないブロックを opcode で引く */
function find(blocks: Record<string, any>, opcode: string) {
  return Object.values(blocks).find(b => b.opcode === opcode)!
}

test("台帳を識別子で引ける形に読み出す", () => {
  assert.equal(catalog.problems.length, 0)
  assert.equal(catalog.byIdentifier.size, catalog.raw.ブロック.length)
  assert.equal(catalog.byIdentifier.get("MOTION_MOVESTEPS")!.opcode, "motion_movesteps")
})

test("縦に連なるブロックが next と parent で繋がる", async () => {
  const { blocks, problems } = await serialize(
    ["緑の旗が押されたとき", "(10) 歩動かす", "隠す"].join("\n"),
  )
  assert.deepEqual(problems, [])

  const [first, second, third] = Object.keys(blocks)
  assert.equal(blocks[first].opcode, "event_whenflagclicked")
  assert.equal(blocks[first].parent, null)
  assert.equal(blocks[first].topLevel, true)
  assert.equal(blocks[first].next, second)

  assert.equal(blocks[second].parent, first)
  assert.equal(blocks[second].topLevel, false)
  assert.equal(blocks[second].next, third)

  assert.equal(blocks[third].opcode, "looks_hide")
  assert.equal(blocks[third].next, null, "最後のブロックの next を省いてはいけない")
  assert.ok(!("x" in blocks[third]), "先頭でないブロックに座標を持たせない")
})

test("先頭のブロックだけが座標を持ち、スクリプトごとに縦へずらす", async () => {
  const { blocks } = await serialize(
    ["緑の旗が押されたとき", "(10) 歩動かす", "", "このスプライトが押されたとき", "隠す"].join(
      "\n",
    ),
  )
  const tops = Object.values(blocks).filter(b => b.topLevel)
  assert.equal(tops.length, 2)
  assert.deepEqual(tops.map(b => b.x), [0, 0])
  assert.ok(tops[1].y > tops[0].y, "2 本目のスクリプトが 1 本目に重なる")
})

/**
 * スクリプトを 2 本置いたときの、2 本目の縦位置を返す。
 *
 * 1 段は 48。`serializeScripts` は「スクリプトの段数 + 余白」でずらすので、平らな形なら
 * 帽子 1 + 中身 n の段数に余白が足された値が返る。
 */
async function secondY(script: string[]) {
  const { blocks } = await serialize(
    [...script, "", "このスプライトが押されたとき", "隠す"].join("\n"),
  )
  const tops = Object.values(blocks)
    .filter(b => b.topLevel)
    .sort((a, b) => a.y - b.y)
  assert.equal(tops.length, 2, "測る前提が崩れている")
  return tops[1].y
}

test("スクリプトの間に、帽子の高さを吸収する余白を空ける", async () => {
  // 下の「差で測る」検査は、両辺に共通の余白が相殺するので余白の変化を捕まえない
  // （2026-09-02 の第三者視点レビューが指摘し、+2 を +1 へ戻して 53 件全通過を実測）。
  // ここは絶対値で測る。1 本目は帽子 1 段 + 動かす 1 段の 2 段ぶんを占める
  const flat = await secondY(["緑の旗が押されたとき", "(10) 歩動かす"])
  assert.equal(flat, 4 * 48, "2 段のスクリプトの下に、余白 2 段を空けていない")
})

test("中身を持つブロックは、閉じる腕のぶんも高さに数える", async () => {
  // 「2 本目が 1 本目より下」だけを見ると、1px ずれていても通る。実機では中身を
  // 持つスクリプトへ次の帽子が食い込んだ（2026-09-02）。平らな形との差で測る
  const flat = await secondY(["緑の旗が押されたとき", "(10) 歩動かす"])
  const nested = await secondY([
    "緑の旗が押されたとき",
    "ずっと",
    "  (10) 歩動かす",
    "end",
  ])

  // 中身を持つ形は、平らな形より「中身 1 段」と「閉じる腕 1 段」ぶん高い。
  // 腕を数え落とすと差が 1 段に縮み、Scratch で次の帽子が重なる。1 段は 48
  assert.equal(nested - flat, 2 * 48, "閉じる腕を高さに数えていない")
})

test("C 型の中身が SUBSTACK に入る", async () => {
  const { blocks, problems } = await serialize(
    ["ずっと", "  (10) 歩動かす", "end"].join("\n"),
  )
  assert.deepEqual(problems, [])

  const forever = find(blocks, "control_forever")
  const [form, inner] = forever.inputs.SUBSTACK
  assert.equal(form, 2, "中身は影を持たないので形 2")
  assert.equal(blocks[inner].opcode, "motion_movesteps")
  assert.equal(blocks[inner].parent, Object.keys(blocks)[0])
})

test("空の C 型は中身の入力を持たない", async () => {
  const { blocks, problems } = await serialize(["ずっと", "end"].join("\n"))
  assert.deepEqual(problems, [])
  // `[2, null]` と書くと中身があるものとして扱われる
  assert.deepEqual(find(blocks, "control_forever").inputs, {})
})

test("中身が 2 つになると別の opcode を取り、2 つ目の置き場へ収める", async () => {
  const { blocks, problems } = await serialize(
    [
      "もし <マウスが押された> なら",
      "  (10) 歩動かす",
      "でなければ",
      "  隠す",
      "end",
    ].join("\n"),
  )
  assert.deepEqual(problems, [])

  // 記法は 1 つのブロックだが .sb3 は中身の数で opcode が分かれる
  assert.equal(find(blocks, "control_if"), undefined)
  const branch = find(blocks, "control_if_else")
  assert.equal(blocks[branch.inputs.SUBSTACK[1]].opcode, "motion_movesteps")
  assert.equal(blocks[branch.inputs.SUBSTACK2[1]].opcode, "looks_hide")
})

test("中身が 1 つなら分岐しない opcode を取る", async () => {
  const { blocks, problems } = await serialize(
    ["もし <マウスが押された> なら", "  隠す", "end"].join("\n"),
  )
  assert.deepEqual(problems, [])
  assert.equal(find(blocks, "control_if_else"), undefined)
  assert.ok(find(blocks, "control_if"))
  assert.ok(!("SUBSTACK2" in find(blocks, "control_if").inputs))
})

test("入力ごとに違う原始値の符号を敷く", async () => {
  const { blocks, problems } = await serialize(
    ["(10) 歩動かす", "(1) 秒待つ", "(4) 回繰り返す", "end", "(90) 度に向ける"].join("\n"),
  )
  assert.deepEqual(problems, [])

  // 記法の上ではどれも同じ「数」だが、.sb3 の符号は入力ごとに違う。
  // 記法の種別から素朴に決めると 4 件すべて 4 になる
  assert.deepEqual(find(blocks, "motion_movesteps").inputs.STEPS, [1, [4, "10"]])
  assert.deepEqual(find(blocks, "control_wait").inputs.DURATION, [1, [5, "1"]])
  assert.deepEqual(find(blocks, "control_repeat").inputs.TIMES, [1, [6, "4"]])
  assert.deepEqual(find(blocks, "motion_pointindirection").inputs.DIRECTION, [1, [8, "90"]])
})

test("比べる相手が文字列の入力は数に見えても文字列を敷く", async () => {
  const { blocks, problems } = await serialize("もし <(1) > (2)> なら\nend")
  assert.deepEqual(problems, [])
  const gt = find(blocks, "operator_gt")
  assert.deepEqual(gt.inputs.OPERAND1, [1, [10, "1"]])
  assert.deepEqual(gt.inputs.OPERAND2, [1, [10, "2"]])
})

test("メニューの影はブロックとして置き、欄名を入力名に合わせる", async () => {
  const { blocks, problems } = await serialize("[マウスのポインター v] へ行く")
  assert.deepEqual(problems, [])

  const goto = find(blocks, "motion_goto")
  const [form, shadow] = goto.inputs.TO
  assert.equal(form, 1, "覆われていない影は形 1")

  const menu = blocks[shadow]
  assert.equal(menu.opcode, "motion_goto_menu")
  assert.equal(menu.shadow, true)
  assert.equal(menu.topLevel, false)
  // 欄名は影ブロック側の入力名。scratch-vm の sb2.js が規則として書いている
  assert.deepEqual(menu.fields, { TO: ["_mouse_", null] })
})

/**
 * メニューの影ブロックが値を置く欄の名前。
 *
 * 実装はこれを規則で導く（原始値の表に無い影の欄名は入力名と同じ）。この表は規則とは
 * 別の出典から機械抽出したもので、規則の裏を取るためだけに置く。実装から借りると、
 * 実装が誤ったときに検査も一緒に誤る。
 *
 * 出典は scratch-blocks 0.1.0-prerelease.20221207082607 の `blocks_vertical/*.js`
 * （`field_dropdown` の `name`）。現行の 2.1.19 はメニューの定義が空で取れない。
 *
 * 拡張機能はどちらにも無い。scratch-vm 5.0.300 の `src/engine/runtime.js`
 * （`_buildMenuForScratchBlocks`）が `args0` の欄名を `menuName` そのものに置き、
 * opcode を `<拡張の id>_menu_<menuName>` に組む。ペンの色のメニューは
 * `scratch3_pen/index.js` が `colorParam` と名づけている。
 *
 * 公式検証器は欄名を見ない（実測: 別名へ変えても通る）。往復検査は逆変換が欄を名前で
 * 引くため誤りを例外として捕まえるが、記法に現れたメニューしか通らない。この表は
 * 12 件すべてを、どの記法を書いたかに依らず見張る。
 */
const MENU_FIELDS: Record<string, string> = {
  control_create_clone_of_menu: "CLONE_OPTION",
  looks_backdrops: "BACKDROP",
  looks_costume: "COSTUME",
  motion_glideto_menu: "TO",
  motion_goto_menu: "TO",
  motion_pointtowards_menu: "TOWARDS",
  pen_menu_colorParam: "colorParam",
  sensing_distancetomenu: "DISTANCETOMENU",
  sensing_keyoptions: "KEY_OPTION",
  sensing_of_object_menu: "OBJECT",
  sensing_touchingobjectmenu: "TOUCHINGOBJECTMENU",
  sound_sounds_menu: "SOUND_MENU",
}

test("メニューの影の欄名が、別の出典から抽出した表と一致する", () => {
  const menus = catalog.raw.ブロック.flatMap(block =>
    (block.args ?? [])
      .filter(arg => arg.shadow && !(arg.shadow in PRIMITIVES))
      .map(arg => ({ block: block.identifier, ...arg })),
  )
  assert.equal(menus.length, 14, "メニューの影を持つ引数の数が変わった")

  for (const arg of menus) {
    const expected = MENU_FIELDS[String(arg.shadow)]
    assert.ok(expected, `${arg.shadow} が照合表に無い`)
    // 実装は規則（欄名は入力名と同じ）で導き、規則から外れるものだけ台帳が
    // `shadowField` に持つ。別の出典から抽出したこの表が、その導出を裏づけるか
    const derived = arg.shadowField ?? arg.name
    assert.equal(derived, expected, `${arg.block}.${arg.name} の影 ${arg.shadow}`)
  }
})

test("ドロップダウンの日本語ラベルを内部値へ直す", async () => {
  const { blocks, problems } = await serialize(
    ["[スペース v] キーが押されたとき", "[すべてを止める v]"].join("\n"),
  )
  assert.deepEqual(problems, [])
  assert.deepEqual(find(blocks, "event_whenkeypressed").fields.KEY_OPTION, ["space", null])
  assert.deepEqual(find(blocks, "control_stop").fields.STOP_OPTION, ["all", null])
})

test("ペンの色は綴りの衝突を越えて現行のブロックへ落ちる", async () => {
  // 「ペンの色を%1にする」は 2 つのブロックが持つ綴りで、解析器は旧ブロック
  // （pen.setHue）を選ぶ。例外表がそれを現行の opcode へ読み替える。読み替えが
  // 外れると、色を直に決めるブロックが記法から呼べなくなる
  const { blocks, problems } = await serialize("ペンの色を [#ff0000] にする")
  assert.deepEqual(problems, [])
  const block = find(blocks, "pen_setPenColorToColor")
  assert.deepEqual(block.inputs.COLOR, [1, [9, "#ff0000"]])
})

test("ペンの色の要素は数を取り、メニューの欄は menus の名前になる", async () => {
  // 上流どうしが食い違う箇所。scratchblocks は第 2 引数を色と書くが、実装を持つ
  // scratch-vm は数と宣言する。色のまま組むと Scratch が開けない
  const { blocks, problems } = await serialize("ペンの [鮮やかさ v] を (50) にする")
  assert.deepEqual(problems, [])
  const block = find(blocks, "pen_setPenColorParamTo")
  assert.deepEqual(block.inputs.VALUE, [1, [4, "50"]])

  // 拡張機能のメニューは、欄の名前が入力名（COLOR_PARAM）と別に決まる
  const menu = find(blocks, "pen_menu_colorParam")
  assert.deepEqual(menu.fields, { colorParam: ["saturation", null] })
})

test("入力にブロックを差すと形 3 になり、下の影が既定値で残る", async () => {
  const { blocks, problems } = await serialize("((1) から (6) までの乱数) 歩動かす")
  assert.deepEqual(problems, [])

  const move = find(blocks, "motion_movesteps")
  const [form, inner, beneath] = move.inputs.STEPS
  assert.equal(form, 3)
  assert.equal(blocks[inner].opcode, "operator_random")
  // 影は覆われても消えない。値だけが既定へ戻る
  assert.deepEqual(beneath, [4, "10"])
})

test("文字列の入力を覆うと下の影が空文字で残る", async () => {
  const { blocks, problems } = await serialize("((1) と (2)) と言う")
  assert.deepEqual(problems, [])
  assert.deepEqual(find(blocks, "looks_say").inputs.MESSAGE[2], [10, ""])
})

test("真偽の入力は影を敷かず形 2 になる", async () => {
  const { blocks, problems } = await serialize("もし <マウスが押された> なら\nend")
  assert.deepEqual(problems, [])

  const [form, inner] = find(blocks, "control_if").inputs.CONDITION
  assert.equal(form, 2)
  assert.equal(blocks[inner].opcode, "sensing_mousedown")
})

test("日本語の語順で入れ替わる引数が、正しい引数へ入る", async () => {
  // 台帳の引数は英語の記法の %1 %2 の順に並ぶが、日本語のラベルは語順が違い
  // 引数を入れ替えて並べる。表示の順で素朴に対応させると隣の引数へ値が入る。
  // 公式検証は構造しか見ず、往復検査は識別子列で比べるため、どちらも捕まえない
  // （往復検査の感度は test/roundtrip.test.ts で実測した）
  const { blocks, problems } = await serialize(
    [
      "[記録 v] の (3) 番目を (99) で置き換える",
      "[記録 v] の (1) 番目に (5) を挿入する",
      "(2) 層 [手前に出す v]",
    ].join("\n"),
    { list: ["記録"] },
  )
  assert.deepEqual(problems, [])

  const replace = find(blocks, "data_replaceitemoflist")
  assert.deepEqual(replace.inputs.INDEX, [1, [4, "3"]], "番目に置き換える値が入っている")
  assert.deepEqual(replace.inputs.ITEM, [1, [10, "99"]])
  assert.deepEqual(replace.fields.LIST, ["記録", "list:記録"])

  const insert = find(blocks, "data_insertatlist")
  assert.deepEqual(insert.inputs.INDEX, [1, [4, "1"]])
  assert.deepEqual(insert.inputs.ITEM, [1, [10, "5"]])

  const layers = find(blocks, "looks_goforwardbackwardlayers")
  assert.deepEqual(layers.inputs.NUM, [1, [7, "2"]], "層の数に選択肢のラベルが入っている")
  assert.deepEqual(layers.fields.FORWARD_BACKWARD, ["forward", null])
})

test("入れ替わる引数を持つ 8 件すべてを直列化できる", async () => {
  // 語順が入れ替わるものを台帳から数え上げ、取りこぼしが出たら落ちるようにする。
  // 引数を持たない 2 件（引数名が読めないもの）は対象から外れる
  const reordered = catalog.raw.ブロック.filter(block => {
    const order = [...String(block.ja ?? "").matchAll(/%(\d+)/g)].map(m => Number(m[1]))
    const slots = (block.args ?? []).filter(a => a.kind !== "statement").length
    return block.args !== null && order.length === slots && order.some((n, i) => n !== i + 1)
  })
  assert.equal(reordered.length, 8, "入れ替わるブロックの数が変わった")

  for (const block of reordered) {
    const arg = block.args!.find(a => a.kind !== "statement")
    assert.ok(arg, `${block.identifier} に引数が無い`)
  }
})

test("変数とリストのレポーターを原始値へ畳む", async () => {
  const { blocks, problems } = await serialize(
    ["(スコア) と言う", "(1) を [記録 v] に追加する"].join("\n"),
    { variable: ["スコア"], list: ["記録"] },
  )
  assert.deepEqual(problems, [])

  const say = find(blocks, "looks_say")
  // 変数のレポーターは別のブロックにならず、入力の中へ畳まれる
  assert.deepEqual(say.inputs.MESSAGE, [3, [12, "スコア", "variable:スコア"], [10, ""]])
  assert.equal(find(blocks, "data_variable"), undefined)

  assert.deepEqual(find(blocks, "data_addtolist").fields.LIST, ["記録", "list:記録"])
})

test("放送は名前と ID の組で書き出す", async () => {
  const { blocks, problems } = await serialize(
    ["[合図 v] を送る", "[合図 v] を受け取ったとき"].join("\n"),
  )
  assert.deepEqual(problems, [])

  assert.deepEqual(find(blocks, "event_broadcast").inputs.BROADCAST_INPUT, [
    1,
    [11, "合図", "broadcast:合図"],
  ])
  assert.deepEqual(find(blocks, "event_whenbroadcastreceived").fields.BROADCAST_OPTION, [
    "合図",
    "broadcast:合図",
  ])
})

test("台帳に無いブロックを黙って落とさない", async () => {
  const { problems } = await serialize("そんなブロックはない")
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "台帳に無いブロック")
  assert.equal(problems[0].subject, "そんなブロックはない")
})

test("識別子を持たないレポーターを単独では扱わない", async () => {
  // 変数のレポーターは値としてのみ扱える。単独で置かれたら申告して止める
  const { problems } = await serialize("(スコア)", { variable: ["スコア"] })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "台帳に無いブロック")
  assert.match(detailOf(problems[0]), /値としてのみ/)
})

test("宣言されていない変数とリストを黙って作らない", async () => {
  const { problems } = await serialize(
    ["[未宣言 v] を (1) にする", "(1) を [無い記録 v] に追加する"].join("\n"),
  )
  assert.deepEqual(
    problems.map(p => `${p.kind}:${p.subject}`),
    ["変数が宣言されていない:未宣言", "リストが宣言されていない:無い記録"],
  )
})

test("選択肢に無いラベルを黙って通さない", async () => {
  const { problems } = await serialize("[ありえない向き v] キーが押されたとき")
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "選択肢に無いラベル")
})

test("選択肢に無いラベルの申告が、書ける候補を全件並べる", async () => {
  // 個数だけを返していたときは、台帳が綴りを持っているのに書き手へ渡していなかった
  const { problems } = await serialize("[ありえない向き v] キーが押されたとき")
  const key = catalog.byIdentifier.get("EVENT_WHENKEYPRESSED")
  if (!key?.args) assert.fail("測る対象のブロックが台帳に無い")
  const choices = key.args[0].options
  if (!choices) assert.fail("測る対象の選択肢が台帳に無い")

  const spellings = Object.keys(choices)
  assert.ok(spellings.length >= 40, `選択肢が ${spellings.length} 件しかない`)
  for (const spelling of spellings) {
    assert.ok(detailOf(problems[0]).includes(spelling), `候補 ${spelling} が申告に無い`)
  }
})

/** 全角として数える範囲。端末での見え方は文字数でなく表示桁で決まる */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/

function displayWidth(text: string) {
  let width = 0
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1
  return width
}

test("候補を並べた申告の長さが、台帳の現状から動いていない", async () => {
  // 最も長い欄（キー 42 件）で測る。文字数で測ると日本語の幅を見落とすので表示桁で見る。
  // 実測 216 表示桁（2026-08-19）。80 桁の端末では 3 行になる。読みやすさのために省くか
  // どうかは、台帳が伸びて実際に困ってから決める。ここでは現状を固定して気づけるようにする
  const { problems } = await serialize("[ありえない向き v] キーが押されたとき")
  assert.ok(!detailOf(problems[0]).includes("\n"), "申告が改行を含む")

  const width = displayWidth(detailOf(problems[0]))
  assert.ok(width <= 230, `申告が ${width} 表示桁ある（実測 216 から伸びた）`)
})

test("選択肢の照合が Object.prototype の名前を素通しさせない", async () => {
  // 素朴に引くと `toString` 等が「解決済みの値」として通り、欄が壊れた .sb3 が
  // 問題 0 件で出る。公式検証も往復検査も値を見ないため、ここで止めるしかない
  for (const label of ["toString", "constructor", "valueOf"]) {
    const { blocks, problems } = await serialize(`回転方法を [${label} v] にする`)
    assert.equal(problems.length, 1, `${label} を通している`)
    assert.equal(problems[0].kind, "選択肢に無いラベル")
    // 欄は空のまま残す。関数やオブジェクトが入ると JSON で null に落ちて .sb3 へ紛れる
    assert.deepEqual(find(blocks, "motion_setrotationstyle").fields, {}, label)
  }
})

test("触れた判定の相手にスプライト名も決まった選択肢も書ける", async () => {
  const { blocks, problems } = await serialize(
    ["もし <[イヌ v] に触れた> なら", "  (10) 歩動かす", "end"].join("\n"),
  )
  assert.deepEqual(problems, [])
  // 表に無い綴りはスプライト名として通し、表にある綴りは内部値へ直す
  assert.deepEqual(find(blocks, "sensing_touchingobjectmenu").fields, {
    TOUCHINGOBJECTMENU: ["イヌ", null],
  })

  const fixed = await serialize("もし <[端 v] に触れた> なら\n  (10) 歩動かす\nend")
  assert.deepEqual(fixed.problems, [])
  assert.deepEqual(find(fixed.blocks, "sensing_touchingobjectmenu").fields, {
    TOUCHINGOBJECTMENU: ["_edge_", null],
  })
})

test("背景の決まった選択肢を日本語のまま入れない", async () => {
  const { blocks, problems } = await serialize("背景を [次の背景 v] にする")
  assert.deepEqual(problems, [])
  // 「次の背景」は作品ごとの背景名でなく、内部値 next backdrop を持つ決まった選択肢
  assert.deepEqual(find(blocks, "looks_backdrops").fields, {
    BACKDROP: ["next backdrop", null],
  })

  const named = await serialize("背景を [夜の空 v] にする")
  assert.deepEqual(named.problems, [])
  assert.deepEqual(find(named.blocks, "looks_backdrops").fields, {
    BACKDROP: ["夜の空", null],
  })
})

test("値の欄へドロップダウンを書くと、噛み合わないとして止める", async () => {
  // 綴りの衝突するブロックを取り違えたとき、書き方の食い違いが唯一の手掛かりになる
  const { problems } = await serialize("[こんにちは v] と言う")
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "引数の書き方が台帳と噛み合わない")
  assert.match(detailOf(problems[0]), /値を受ける欄にメニューが書かれている/)
})

test("メニューの欄へ素の文字を書くと、噛み合わないとして止める", async () => {
  const { problems } = await serialize("[マウスのポインター] へ向ける")
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "引数の書き方が台帳と噛み合わない")
  assert.match(detailOf(problems[0]), /メニューを受ける欄に値が書かれている/)
})

test("選択肢が作品ごとに決まるメニューも、素の文字を通さない", async () => {
  // 放送・音・コスチュームは台帳の選択肢が空になる。選択肢の有無で見分けると素通しする
  const { problems } = await serialize("[はじめ] を送る")
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "引数の書き方が台帳と噛み合わない")
})

test("正しく書いた記法は、書き方の検査を素通しする", async () => {
  // 落ちるべきものが落ちることと、落ちてはならないものが通ることを別に測る
  const written = [
    "[こんにちは] と言う",
    "[マウスのポインター v] へ向ける",
    "(10) 歩動かす",
    "(1) 秒待つ",
    "[はじめ v] を送る",
    "[スコア v] を (1) ずつ変える",
    "(1) を [記録 v] に追加する",
    "[#ff0000] 色に触れた",
  ]
  for (const code of written) {
    const { problems } = await serialize(code, { variable: ["スコア"], list: ["記録"] })
    assert.deepEqual(problems, [], `正しい記法を止めている: ${code}`)
  }
})

test("数を文字の欄へ書くのは止めない", async () => {
  // Scratch は文字の欄へ数を書ける。数と文字を分けて数えると正当な記法を止める
  const { problems } = await serialize("[スコア v] を (0) にする", { variable: ["スコア"] })
  assert.deepEqual(problems, [])
})

test("色の欄へ素の文字を書くと止める", async () => {
  const { problems } = await serialize("[あか] 色に触れた")
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "引数の書き方が台帳と噛み合わない")
  assert.match(detailOf(problems[0]), /色を受ける欄/)
})

test("色として読める綴りは、値の欄でも止めない", async () => {
  // 解析器は `#` に 16 進が続く綴りを、どの欄でも色と読む。値の欄では正当な文字である
  for (const code of ["[#ff0000] と言う", "[#abc] と言う", "[#ff0000] と (2) 秒言う"]) {
    const { problems } = await serialize(code)
    assert.deepEqual(problems, [], `正当な記法を止めている: ${code}`)
  }
})

test("色の欄へ色でない値を書くのは止め続ける", async () => {
  // 上の緩和で色の検査ごと消えていないことを別に測る
  const { problems } = await serialize("[あか] 色に触れた")
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "引数の書き方が台帳と噛み合わない")
})

test("綴りが重なるブロックでは、v を外す直し方へ誘導しない", async () => {
  // `([記録 v] の長さ)` を止めたあと `([記録] の長さ)` へ直すと、リストの長さでなく
  // 文字列の長さになった .sb3 が問題 0 件で出る。手掛かりがそちらへ押してはいけない
  const { problems } = await serialize("([記録 v] の長さ)", { list: ["記録"] })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, "引数の書き方が台帳と噛み合わない")
  assert.match(detailOf(problems[0]), /別のブロックとして読まれた疑い/)
  assert.doesNotMatch(detailOf(problems[0]), /値は \(1\) か \[文字\] の形で書く/)
})

test("綴りが重ならないブロックでは、重なりを騙らない", async () => {
  // 事実でない手掛かりを添えない。`と言う` は台帳で重なっていない
  const { problems } = await serialize("[こんにちは v] と言う")
  assert.equal(problems.length, 1)
  assert.doesNotMatch(detailOf(problems[0]), /重なって/)
})

test("知らない書かれ方を素通ししない", () => {
  // 「素通ししない」は判断であって、測らなければ実装が変わっても気づけない
  assert.match(String(writtenAs({ isInput: true, shape: "まだ無い形" })), /知らない形/)
  assert.match(String(writtenAs({ isInput: true, shape: "" })), /知らない形/)

  // 既知の形は畳む。ドロップダウンは 2 綴りを取る
  assert.equal(writtenAs({ isInput: true, shape: "dropdown" }), "メニュー")
  assert.equal(writtenAs({ isInput: true, shape: "number-dropdown" }), "メニュー")
  assert.equal(writtenAs({ isInput: true, shape: "number" }), "値")
  assert.equal(writtenAs({ isInput: true, shape: "string" }), "値")
  assert.equal(writtenAs({ isInput: true, shape: "color" }), "色")

  // ブロックが差されていればこの検査の外
  assert.equal(writtenAs({ isBlock: true }), null)
  assert.equal(writtenAs({ isInput: true, value: { isBlock: true } }), null)
})

test("突き合わせの外に置く引数を、規則の側から確かめる", () => {
  // 件数（下の検査）は台帳が変われば動く。規則そのものはここで固定する
  assert.equal(expectedAs({ kind: "input", notation: "%b" }), null, "真偽を突き合わせている")

  // 数にドロップダウンが付く入力は値として突き合わせる（2026-08-19 に内側へ戻した）
  assert.equal(expectedAs({ kind: "input", notation: "%d.direction" }), "値")
  assert.equal(expectedAs({ kind: "input", notation: "%d.listItem" }), "値")

  assert.equal(expectedAs({ kind: "field", notation: "%m.var" }), "メニュー")
  assert.equal(expectedAs({ kind: "input", notation: "%m.broadcast" }), "メニュー")
  assert.equal(expectedAs({ kind: "input", notation: "%s", options: { あ: "a" } }), "メニュー")
  assert.equal(expectedAs({ kind: "input", notation: "%c" }), "色")
  assert.equal(expectedAs({ kind: "input", notation: "%s" }), "値")
  assert.equal(expectedAs({ kind: "input", notation: "%n" }), "値")
})

test("真偽の入力へ値を書くと、外した先の検査が受け持つ", async () => {
  // `%b` を突き合わせの外に置いた根拠は「別の検査が受け持つ」。その別の検査が
  // 実在することを測る。測らないと、除外だけが残って誰も見ない欄になる
  const { problems } = await serialize("<[はい] かつ [いいえ]>")
  assert.ok(problems.length > 0, "真偽の欄へ値を書いたのに素通りしている")
  for (const problem of problems) {
    assert.equal(problem.kind, "影を持たない入力に値を書けない")
  }
})

test("数にドロップダウンが付く入力は、数として読めれば書き方を問わない", async () => {
  // 通す側を測る。止める側だけを測ると、全部を止める実装でも緑になる。
  // 選択肢の見た目（`(90 v)`）でも値が数なら正しい .sb3 になるので止めない
  const written = [
    "(90) 度に向ける",
    "(90 v) 度に向ける",
    "[90] 度に向ける",
    "(-45.5) 度に向ける",
    "([記録 v] の (1) 番目)",
    "[記録 v] の (2) 番目を削除する",
  ]
  for (const code of written) {
    const { problems } = await serialize(code, { list: ["記録"] })
    const stopped = problems.filter(p => p.kind === "引数の書き方が台帳と噛み合わない")
    assert.deepEqual(stopped, [], `正当な記法を止めている: ${code}`)
  }
})

test("数にドロップダウンが付く入力へ数でない値を書くと、書き方を問わず止める", async () => {
  // 上流 `scratch-blocks` は該当の 5 引数をいずれも素の入力として定義し、ドロップダウンを
  // 持たない（2026-08-19 実測）。よって選択肢の見た目（`[右 v]`）と素の文字（`[右]`）は
  // 同じ誤りで、どちらも日本語のラベルが `math_angle` や `math_number` へ入った .sb3 が
  // 問題 0 件で出ていた。書かれ方で見ると綴りの軸しか塞がらないので、書かれた値で見る
  const written = [
    "[右 v] 度に向ける",
    "[右] 度に向ける",
    "([記録 v] の [最後 v] 番目)",
    "([記録 v] の [最後] 番目)",
    "[記録 v] の [すべて v] 番目を削除する",
  ]
  for (const code of written) {
    const { problems } = await serialize(code, { list: ["記録"] })
    const stopped = problems.filter(p => p.kind === "引数の書き方が台帳と噛み合わない")
    assert.equal(stopped.length, 1, `止めていない: ${code}`)
    assert.match(stopped[0].detail ?? "", /数を受ける欄に/, `手掛かりが数を指していない: ${code}`)
  }
})

test("数にドロップダウンが付く入力へブロックを差すのは止めない", async () => {
  // 対照。値を持たない子までは見ない
  const { problems } = await serialize("(スコア) 度に向ける", { variable: ["スコア"] })
  assert.deepEqual(problems.filter(p => p.kind === "引数の書き方が台帳と噛み合わない"), [])
})

/**
 * 書き方の突き合わせが届かない引数と、その件数。
 *
 * 実装から借りず、外した理由ごとに書き下す。借りると、実装が守備範囲を狭めたときに
 * 検査も一緒に狭まり、届かなくなったことが誰にも見えない。
 *
 * - `%b`: 真偽の入力。「影を持たない入力に値を書けない」が受け持つ
 *
 * `%d.*`（5 引数）は 2026-08-19 に突き合わせの内側へ戻した。上流にドロップダウンの定義が
 * 無く、選択肢の見た目で書くと日本語のラベルがそのまま値になるためである。
 */
const OUTSIDE_CHECK = { "%b": 9 }

/** 台帳の引数の総数。`alsoCovers` の引数を含めて数える */
const CATALOG_ARGUMENTS = 135

test("書き方を突き合わせない引数の件数が変わっていない", () => {
  const counted: Record<string, number> = {}
  let total = 0
  for (const block of catalog.raw.ブロック) {
    const args = [
      ...(block.args ?? []),
      ...(block.alsoCovers ?? []).flatMap((c: any) => c.args ?? []),
    ]
    for (const arg of args) {
      if (arg.kind === "statement") continue
      total += 1
      if (expectedAs(arg) !== null) continue
      counted[String(arg.notation ?? "")] = (counted[String(arg.notation ?? "")] ?? 0) + 1
    }
  }

  assert.equal(total, CATALOG_ARGUMENTS, "台帳の引数の総数が変わった")
  assert.deepEqual(counted, OUTSIDE_CHECK, "突き合わせの外に置く引数が変わった")
})

test("追跡下の記法を、書き方の検査が 1 件も止めない", async () => {
  // 較正（狙った誤りが落ちる）とは別に、正当な記法を止めないことを実物で測る。
  // 片方だけでは、何も見ていない検査と区別が付かない
  const written = [
    ...loadSnippets(new URL("../docs/knowledge/idioms/", import.meta.url)),
    ...loadSnippets(new URL("../docs/knowledge/", import.meta.url)),
  ]
  assert.ok(written.length >= 16, `測った記法が ${written.length} 件しかない`)

  const stopped = []
  for (const snippet of written) {
    const { problems } = await serialize(snippet.code, {
      // 宣言の有無はこの検査の対象外。名前は引ける前提にする
      variable: ["スコア", "回数", "たいむ", "秒", "名前"],
      list: ["記録", "並び"],
    })
    for (const problem of problems) {
      if (problem.kind === "引数の書き方が台帳と噛み合わない") {
        stopped.push(`${snippet.name}: ${problem.subject}`)
      }
    }
  }
  assert.deepEqual(stopped, [], `正当な記法を止めている:\n${stopped.join("\n")}`)
})

test("噛み合わない引数について、申告を 2 通り並べない", async () => {
  // メニューの欄へ素の文字を書くと「選択肢に無いラベル」も同時に成り立つ。
  // 両方を並べると、どちらを直せばよいのか読めなくなる
  const { problems } = await serialize("[マウスのポインター] へ向ける")
  assert.equal(problems.length, 1, `2 通り並んでいる: ${JSON.stringify(problems)}`)
})

test("同じ入力から 2 回直列化した結果が一致する", async () => {
  const code = [
    "緑の旗が押されたとき",
    "[スコア v] を (0) にする",
    "ずっと",
    "  もし <[マウスのポインター v] に触れた> なら",
    "    [スコア v] を ((1) から (6) までの乱数) ずつ変える",
    "  end",
    "end",
  ].join("\n")

  const first = await serialize(code, { variable: ["スコア"] })
  const second = await serialize(code, { variable: ["スコア"] })
  assert.deepEqual(first.problems, [])
  // ブロックの ID を含めて一致する。乱数の ID を振ると .sb3 が毎回変わる
  assert.equal(JSON.stringify(first.blocks), JSON.stringify(second.blocks))
})

test("知らない形は、突き合わせの外に置いた引数でも申告する", () => {
  // 解析器が形を増やしたときに検査が静かに効かなくなる範囲を残さない。実物の記法からは
  // 知らない形を作れない（作れたら知っている形である）ので、形を外から渡して測る
  const unknown = { isInput: true, shape: "なにか新しい形" }
  const ctx = { sharedLabels: new Set<string>() }

  // 真偽の入力は書き方を突き合わせない。それでも知らない形は素通ししない
  const outside = mismatchOf({ kind: "input", notation: "%b" }, unknown, ctx, null)
  assert.match(outside ?? "", /知らない形（なにか新しい形）/)

  // 突き合わせる引数でも同じ文言を出す。噛み合わせの手掛かりへ落とさない
  const inside = mismatchOf({ kind: "input", notation: "%n" }, unknown, ctx, null)
  assert.match(inside ?? "", /知らない形（なにか新しい形）/)
  assert.doesNotMatch(inside ?? "", /値は \(1\) か/, "誤導する手掛かりを添えている")

  // 対照。知っている形は素通りする
  const known = { isInput: true, shape: "number" }
  assert.equal(mismatchOf({ kind: "input", notation: "%n" }, known, ctx, null), null)
})

test("台帳が原型の名前を綴りに持っても、投げずに済ませる", async () => {
  // 素朴に引くと `constructor` が関数として返り、値と取り違えたまま先へ進んで例外になる
  // （影ブロックを引く経路で実測）。「誤りは投げずに問題として集めて返す」を破る
  const path = join(mkdtempSync(join(tmpdir(), "gen-scratch-")), "blocks.json")
  const entry = {
    identifier: "MOTION_MOVESTEPS",
    opcode: "motion_movesteps",
    category: "motion",
    shape: "stack",
    spec: "move %1 steps",
    ja: "%1 歩動かす",
    inputs: ["%n"],
    args: [
      { name: "STEPS", kind: "input", notation: "%n", shadow: "constructor", options: null },
    ],
    alsoCovers: [],
    opcodeFrom: "定義",
  }
  writeFileSync(path, JSON.stringify({ 生成元: {}, 覆わない範囲: {}, ブロック: [entry] }))

  const doc = await parseNotation("(10) 歩動かす")
  const broken = loadCatalog(path)
  // 投げないことがこの検査の主張。中身の正しさは問わない
  assert.doesNotThrow(() => serializeScripts(doc, { catalog: broken, names: names() }))
})
