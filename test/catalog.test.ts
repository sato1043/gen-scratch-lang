import test from "node:test"
import assert from "node:assert/strict"
import commands from "scratchblocks/syntax/commands.js"
import { EXCEPTIONS } from "../catalog/exceptions.ts"
import {
  CORE_EXTENSIONS,
  EXTENSION_DEFINITIONS,
  extensionIdOf,
} from "../catalog/extensions.ts"
import { OPTIONS } from "../catalog/dropdowns.ts"
import { PRIMITIVES } from "../catalog/shadows.ts"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CATALOG_KEYS,
  agentFor,
  catalogDrift,
  loadCatalog,
  stampedCatalogOf,
} from "../src/catalog.ts"
import {
  CORE_CATEGORIES,
  FINGERPRINTED,
  LISTED_CATEGORIES,
  buildCatalog,
} from "../tools/build-catalog.ts"
import { readDefinitions } from "../tools/opcodes.ts"
import { buildProject } from "../src/project.ts"
import { readSb3 } from "../src/read.ts"
import { knowledge } from "../src/cli.ts"
import { ourSb3 } from "./fixtures.ts"

const { catalog, problems } = buildCatalog()

/**
 * core の範囲は実装から借りずにここへ直書きする。実装の定数を検査にも使うと、
 * 実装が範囲を狭めたときに検査も一緒に狭まり、素通りする。件数は scratchblocks
 * 3.7.1 の実測値で、上流が増減すれば落ちる
 */
const CORE = [
  "motion",
  "looks",
  "sound",
  "events",
  "control",
  "sensing",
  "operators",
  "variables",
  "list",
]
const CORE_COUNT = 127

/** 台帳が扱うカテゴリ。core 9 つに、扱うと裁定した拡張機能とブロック定義を足したもの */
const LISTED = [...CORE, "pen", "custom", "custom-arg"]
const PEN_COUNT = 13

/**
 * 手書きの表が足す件数（定義の帽子・呼び出し・引数の参照）。
 *
 * 上流の定義表には現れないので、下の保存則で右辺へ足す。カテゴリの絞り込み自体は
 * `LISTED` 1 つで行う ── 上流を数える母集団を別に持つと、新しいカテゴリを扱う範囲へ
 * 足しても孤児検査がそれを一度も見ない状態になる
 */
const PROCEDURE_COUNT = 3
const LISTED_COUNT = 131

/** 例外表を差し替えて組み立て、出た問題の種別を返す */
function kindsWith(exceptions: any[]) {
  return buildCatalog({ exceptions }).problems.map(p => p.kind)
}

/** 例外表から 1 件を落とした表を返す */
function without(key: string) {
  return EXCEPTIONS.filter(e => (e.identifier ?? e.selector) !== key)
}

test("例外表どおりに組み立てれば整合が取れる", () => {
  assert.deepEqual(problems, [])
})

test("台帳が扱う範囲が、宣言したカテゴリと一致する", () => {
  // core の 9 つと、台帳が扱う範囲を別々に見る。片方だけを見ると、拡張機能を
  // 足したときに core の定義がずれても気づけない
  assert.deepEqual([...CORE_CATEGORIES].sort(), [...CORE].sort())
  assert.deepEqual([...LISTED_CATEGORIES].sort(), [...LISTED].sort())
  assert.deepEqual(
    [...new Set(catalog.ブロック.map(b => b.category))].sort(),
    // 選択肢と置けない記法をすべて除いたカテゴリは台帳に残らない
    LISTED.filter(c => catalog.ブロック.some(b => b.category === c)).sort(),
  )
  assert.equal(catalog.ブロック.length, LISTED_COUNT)
})

test("扱うカテゴリのブロックが 1 件残らず説明される", () => {
  const core = commands.filter((c: any) => LISTED.includes(c.category))
  assert.equal(
    core.length,
    CORE_COUNT + PEN_COUNT,
    "上流のブロック数が変わっている",
  )

  const listed = new Set(catalog.ブロック.map(b => b.identifier))
  const declared = new Set(EXCEPTIONS.map(e => e.identifier ?? e.selector))

  const orphans = core
    .map((c: any) => c.id ?? c.selector)
    .filter((key: string) => !listed.has(key) && !declared.has(key))
  assert.deepEqual(orphans, [], "台帳にも例外表にも無いブロックが残っている")

  // 覆えた数と覆えない数の合計が上流の総数に戻る。どちらにも数えられない取りこぼしが
  // あれば、この等式が崩れる
  const excluded =
    catalog.覆わない範囲["ドロップダウンの選択肢"].length +
    catalog.覆わない範囲["ブロックでない記法"].length +
    catalog.覆わない範囲["今の Scratch で置けない記法"].length +
    catalog.覆わない範囲["綴りが衝突して呼べない記法"].length
  // 手書きの表が足した分は上流の総数に含まれない。足さないと等式が崩れ、取りこぼしの
  // 検出が「手続きを足した」ことに埋もれる
  assert.equal(catalog.ブロック.length + excluded, core.length + PROCEDURE_COUNT)
})

test("台帳の指紋が、手書きの表を 1 つも取りこぼさない", () => {
  // 実装から借りず、指紋が畳むべき表を書き下す。表を足して指紋へ入れ忘れると、
  // その表を直しても台帳の版が動かず catalogDrift が沈黙する（2026-09-02 に 3 表が漏れた）
  const EXPECTED = [
    "CORE_EXTENSIONS",
    "EXTENSION_DEFINITIONS",
    "FALLBACK",
    "MENU_OPTIONS",
    "NAME_KINDS",
    "OPTIONS",
    "PRIMITIVES",
    "PROCEDURE_COMMANDS",
    "SHADOWS",
    "SUPPLEMENT",
  ]
  assert.deepEqual(
    Object.keys(FINGERPRINTED).sort(),
    EXPECTED,
    "指紋が畳む表が変わった。足した表を EXPECTED へも足す",
  )

  // 例外表は引数で渡るので FINGERPRINTED に無い。指紋が実際に反応することを見る
  const base = buildCatalog().catalog[CATALOG_KEYS.ORIGIN]["手書きの表"]
  const moved = buildCatalog({
    exceptions: [
      ...EXCEPTIONS,
      { identifier: "MOTION_MOVESTEPS", kind: "option", reason: "指紋を動かすための作り話" },
    ],
  }).catalog[CATALOG_KEYS.ORIGIN]["手書きの表"]
  assert.notEqual(base, moved, "例外表を変えても指紋が動かない")
})

test("拡張機能でない接頭辞の一覧が、上流の CORE_EXTENSIONS と一致する", () => {
  // 実装から借りず書き下す。出典は scratch-vm 5.0.300 の src/serialization/sb3.js。
  // 1 件でも欠けると、その接頭辞を持つ core のブロックが拡張機能として申告される
  const EXPECTED = [
    "argument",
    "colour",
    "control",
    "data",
    "event",
    "looks",
    "math",
    "motion",
    "operator",
    "procedures",
    "sensing",
    "sound",
  ]
  assert.deepEqual([...CORE_EXTENSIONS].sort(), EXPECTED)

  // 各要素が実際に効いていることを見る。表に在る名前は拡張機能と判定されない
  for (const prefix of CORE_EXTENSIONS) {
    assert.equal(extensionIdOf(`${prefix}_something`), null, `${prefix} が拡張と判定された`)
  }
  // 表に無い接頭辞は拡張機能になる。対照が無いと、常に null を返す実装でも通る
  assert.equal(extensionIdOf("pen_penDown"), "pen")
  assert.equal(extensionIdOf("music_setTempo"), "music")
})

test("台帳の全ブロックが opcode を持ち、opcode は重複しない", () => {
  const opcodes = catalog.ブロック.map(b => b.opcode)
  for (const block of catalog.ブロック) {
    // 拡張機能の opcode は語の切れ目を大文字で書く（`pen_penDown`）。core は
    // すべて小文字だが、形の検査は両方を通す
    assert.match(block.opcode, /^[a-z][A-Za-z0-9_]*$/, block.identifier)
  }
  assert.equal(new Set(opcodes).size, opcodes.length, "同じ opcode が 2 度出ている")
})

test("日本語ラベルと引数名が台帳に載る", () => {
  const find = (id: string) => catalog.ブロック.find(b => b.identifier === id)!

  assert.deepEqual(find("MOTION_MOVESTEPS"), {
    identifier: "MOTION_MOVESTEPS",
    opcode: "motion_movesteps",
    category: "motion",
    shape: "stack",
    spec: "move %1 steps",
    ja: "%1 歩動かす",
    inputs: ["%n"],
    args: [
      {
        name: "STEPS",
        kind: "input",
        notation: "%n",
        shadow: "math_number",
        shadowFrom: "表",
        shadowField: null,
        options: null,
        optionsFrom: null,
        namesAllowed: false,
      },
    ],
    alsoCovers: [],
    argsBy: null,
    opcodeFrom: "定義",
  })

  // 識別子の小文字化では届かない代表例。記法側は OPERATORS_、.sb3 側は operator_
  assert.equal(find("OPERATORS_ADD").opcode, "operator_add")
  assert.equal(find("CONTROL_WAITUNTIL").opcode, "control_wait_until")

  // 綴りを持てないのは、名前を利用者が決めるブロックに限る。それ以外が欠けたら失敗する
  const noLabel = catalog.ブロック.filter(
    b => !b.ja && !["custom", "custom-arg"].includes(b.category),
  )
  assert.deepEqual(noLabel, [], "日本語ラベルの無いブロックが残っている")

  // 上の絞り込みで何件を外したかを固定する。外した範囲を数えないと、綴りを持てる
  // ブロックが増えても減っても気づけない
  assert.deepEqual(
    catalog.ブロック.filter(b => !b.ja).map(b => b.opcode),
    ["procedures_call", "argument_reporter_string_number"],
    "綴りを持たないブロックの顔ぶれが変わった",
  )
})

test("引数を持たないブロックと、引数名を読めないブロックを混ぜない", () => {
  const find = (id: string) => catalog.ブロック.find(b => b.identifier === id)!

  // 「隠す」は引数を持たない。読めなかったのではなく、無い
  assert.deepEqual(find("LOOKS_HIDE").args, [])
  assert.deepEqual(find("LOOKS_HIDE").alsoCovers, [])
  // sensing_of は中身を実行時に埋めるため読めない
  assert.equal(find("SENSING_OF").args, null)

  // `args: null` は 2 つの意味を運ぶので、申告も 2 つに分ける。混ぜると
  // 「記法からは書けない」という偽の文が公開ページへ出る（CP6 で実測）
  assert.deepEqual(
    catalog.覆わない範囲["引数名を取れないブロック"].map(b => b.identifier),
    ["EVENT_WHENBACKDROPSWITCHESTO", "SENSING_OF"],
  )
  assert.deepEqual(
    catalog.覆わない範囲["引数を利用者が決めるブロック"].map(b => b.identifier),
    ["PROCEDURES_DEFINITION", "PROCEDURES_CALL", "getParam"],
  )

  // 意味の違いは `argsBy` が持つ。どちらの群も `args` は null なので、
  // `args` だけを見る側は 2 つを見分けられない
  assert.equal(find("SENSING_OF").argsBy, null)
  assert.equal(find("PROCEDURES_CALL").argsBy, "利用者")

  // 2 つの群が交わらないことまで見る。片方の判定を緩めると両方に出て、
  // 件数の検査は合ったまま一覧だけが偽になる
  const 取れない = catalog.覆わない範囲["引数名を取れないブロック"].map(b => b.identifier)
  const 利用者 = catalog.覆わない範囲["引数を利用者が決めるブロック"].map(b => b.identifier)
  assert.deepEqual(取れない.filter(id => 利用者.includes(id)), [])
})

test("入力ごとに敷く影ブロックが台帳に載る", () => {
  const shadowOf = (id: string, name: string) =>
    catalog.ブロック.find(b => b.identifier === id)!.args!.find(a => a.name === name)!

  // 記法の上ではどれも同じ「数」に見えるが、.sb3 で敷く影は入力ごとに違う。
  // 記法の種別から素朴に決めると、この 3 件がすべて math_number になる
  assert.equal(shadowOf("CONTROL_WAIT", "DURATION").shadow, "math_positive_number")
  assert.equal(shadowOf("CONTROL_REPEAT", "TIMES").shadow, "math_whole_number")
  assert.equal(
    shadowOf("MOTION_POINTINDIRECTION", "DIRECTION").shadow,
    "math_angle",
  )
  assert.equal(shadowOf("MOTION_MOVESTEPS", "STEPS").shadow, "math_number")

  // 比べる相手が文字列の入力は text を敷く。数に見えても数ではない
  assert.equal(shadowOf("OPERATORS_LT", "OPERAND1").shadow, "text")

  // フィールドと真偽の入力、C 型の中身は影を敷かない
  assert.equal(shadowOf("LOOKS_CHANGEEFFECTBY", "EFFECT").shadow, null)
  assert.equal(shadowOf("CONTROL_IF", "CONDITION").shadow, null)
  assert.equal(shadowOf("CONTROL_IF", "SUBSTACK").shadow, null)

  // ドロップダウンは別のブロックを影として敷く
  assert.equal(
    shadowOf("SENSING_TOUCHINGOBJECT", "TOUCHINGOBJECTMENU").shadow,
    "sensing_touchingobjectmenu",
  )
})

test("ドロップダウンの日本語ラベルから内部値を引ける", () => {
  const argOf = (id: string, name: string) =>
    catalog.ブロック.find(b => b.identifier === id)!.args!.find(a => a.name === name)!

  const keys = argOf("EVENT_WHENKEYPRESSED", "KEY_OPTION").options!
  assert.equal(keys["右向き矢印"], "right arrow")
  const touching = argOf("SENSING_TOUCHINGOBJECT", "TOUCHINGOBJECTMENU").options!
  assert.equal(touching["端"], "_edge_")
  const stop = argOf("CONTROL_STOP", "STOP_OPTION").options!
  assert.equal(stop["すべてを止める"], "all")

  // 内部値に ' を含む綴り。単引用符だけを見る取り出しでは黙って落ちる
  assert.equal(
    argOf("MOTION_SETROTATIONSTYLE", "STYLE").options!["回転しない"],
    "don't rotate",
  )
  assert.equal(Object.keys(argOf("MOTION_SETROTATIONSTYLE", "STYLE").options!).length, 3)
})

test("作品ごとに名前が決まる選択肢は表を持たない", () => {
  const argOf = (id: string, name: string) =>
    catalog.ブロック.find(b => b.identifier === id)!.args!.find(a => a.name === name)!

  // 変数名やコスチューム名は表で引く対象ではない。記法に書いた名前がそのまま値になる
  for (const [id, name] of [
    ["DATA_SETVARIABLETO", "VARIABLE"],
    ["LOOKS_SWITCHCOSTUMETO", "COSTUME"],
    ["SOUND_PLAY", "SOUND_MENU"],
  ]) {
    const arg = argOf(id, name)
    assert.equal(arg.options, null, `${id}.${name}`)
    assert.equal(arg.optionsFrom, "名前をそのまま使う", `${id}.${name}`)
    assert.equal(arg.namesAllowed, true, `${id}.${name}`)
  }
})

test("決まった選択肢と作品ごとの名前を併せ持つ入力を、名前だけの入力と分ける", () => {
  const argOf = (id: string, name: string) =>
    catalog.ブロック.find(b => b.identifier === id)!.args!.find(a => a.name === name)!

  // 「〜へ行く」の行き先はスプライト名も取るが、「マウスのポインター」と
  // 「どこかの場所」は内部値を持つ。名前だけの入力として扱うと、日本語のラベルが
  // そのまま .sb3 の値になり、Scratch が読めない値になる
  const both = [
    ["MOTION_GOTO", "TO", "マウスのポインター", "_mouse_"],
    ["MOTION_GLIDETO", "TO", "どこかの場所", "_random_"],
    ["MOTION_POINTTOWARDS", "TOWARDS", "どれかの向き", "_random_"],
    ["SENSING_DISTANCETO", "DISTANCETOMENU", "マウスのポインター", "_mouse_"],
    ["CONTROL_CREATECLONEOF", "CLONE_OPTION", "自分自身", "_myself_"],
    // 触れた判定の相手はスプライト名も取る
    ["SENSING_TOUCHINGOBJECT", "TOUCHINGOBJECTMENU", "マウスのポインター", "_mouse_"],
    // 背景は作品ごとの名前に加えて、決まった 3 つを取る
    ["LOOKS_SWITCHBACKDROPTO", "BACKDROP", "次の背景", "next backdrop"],
    ["LOOKS_SWITCHBACKDROPTOANDWAIT", "BACKDROP", "どれかの背景", "random backdrop"],
  ]
  for (const [id, name, ja, value] of both) {
    const arg = argOf(id, name)
    assert.equal(arg.options?.[ja], value, `${id}.${name}`)
    assert.equal(arg.namesAllowed, true, `${id}.${name}`)
    assert.match(arg.optionsFrom!, /名前の併用$/, `${id}.${name}`)
  }

  // 数を直に置く。併用の入力を数え落とすと、この件数が減っても気づかない
  const combined = catalog.ブロック.flatMap(b =>
    (b.args ?? []).filter(a => a.namesAllowed && a.options),
  )
  assert.equal(combined.length, both.length)
})

test("影ブロックが原始値か実在するブロックのどちらかである", () => {
  // 拡張機能の定義は scratch-blocks に無い（実行時に作られる）。写した側も
  // 実在の元として数える。写しそのものが正しいかは、別の出典から抽出した表と
  // 突き合わせる検査（serialize.test.ts の MENU_FIELDS）が見る
  const known = new Set(
    [...readDefinitions().definitions, ...EXTENSION_DEFINITIONS].map(d => d.opcode),
  )
  for (const block of catalog.ブロック) {
    for (const arg of block.args ?? []) {
      if (!arg.shadow) continue
      assert.ok(
        arg.shadow in PRIMITIVES || known.has(arg.shadow),
        `${block.identifier}.${arg.name} の影 ${arg.shadow} が実在しない`,
      )
    }
  }
})

test("記法が中身を 2 つ持つときに取る opcode を台帳が持つ", () => {
  // 記法は「もし〜なら」と「でなければ」を 1 つのブロックで表す。.sb3 は別の
  // opcode に分かれるため、中身の数で選ぶ先を台帳が持っていないと生成できない
  const branch = catalog.ブロック.find(b => b.identifier === "CONTROL_IF")!
  assert.deepEqual(
    branch.alsoCovers.map(c => c.opcode),
    ["control_if_else"],
  )

  // opcode の名だけでは生成できない。「でなければ」側の中身の置き場は記法に現れず、
  // 台帳が引数まで持っていないと 2 つ目の中身を収める先が決まらない
  const [または] = branch.alsoCovers as [(typeof branch.alsoCovers)[number]]
  assert.deepEqual(
    または.args!.map(a => `${a.name}:${a.kind}`),
    ["CONDITION:input", "SUBSTACK:statement", "SUBSTACK2:statement"],
  )

  const reached = catalog.覆わない範囲["台帳から到達しない opcode"].map(o => o.opcode)
  assert.ok(!reached.includes("control_if_else"), "到達しない側に数えている")
})

test("覆わない範囲を 0 件で装わない", () => {
  const 範囲 = catalog.覆わない範囲

  const 拡張 = 範囲["core の外のカテゴリ"]
  assert.ok(拡張.length > 0, "core の外のカテゴリが 1 つも申告されていない")
  const names = 拡張.map(g => g.category)
  for (const category of ["music", "microbit", "obsolete"]) {
    assert.ok(names.includes(category), `${category} が申告に無い`)
  }
  // 扱うと裁定したカテゴリは、覆わない範囲の側に残っていてはいけない
  assert.ok(!names.includes("pen"), "扱っている pen が覆わない範囲に残っている")

  // 除外した綴りも群として申告する。0 件を装わない
  const 衝突 = 範囲["綴りが衝突して呼べない記法"]
  assert.ok(Array.isArray(衝突), "綴りの衝突の群が無い")
  assert.ok(
    衝突.some((e: any) => e.identifier === "pen.setColor"),
    "pen.setColor の除外が申告されていない",
  )
  for (const group of 拡張) {
    // 件数と一覧の双方を持つ群である。片方が欠けていれば数えるものが無い
    assert.ok(group.識別子, `${group.category} が識別子の一覧を持たない`)
    assert.equal(group.件数, group.識別子.length, group.category)
  }

  // 影ブロックは段階 3 で要る。一覧に出ていなければ、その時に無いことに気づけない
  const 到達しない = 範囲["台帳から到達しない opcode"]
  const 影 = 到達しない.filter(o => o.定義が空).map(o => o.opcode)
  for (const opcode of [
    "motion_goto_menu",
    "motion_glideto_menu",
    "sensing_touchingobjectmenu",
    "sound_sounds_menu",
    "looks_costume",
  ]) {
    assert.ok(影.includes(opcode), `影ブロック ${opcode} が申告に無い`)
  }

  assert.ok(範囲["ドロップダウンの選択肢"].length > 0)
  assert.ok(範囲["ブロックでない記法"].length > 0)
  assert.ok(範囲["今の Scratch で置けない記法"].length > 0)

  // 影ブロック表の出典は 105 ブロックしか並べていない。規則で補ったぶんは
  // 表から引いたぶんより確度が落ちるので、件数と一覧を出す
  const 補い = 範囲["影ブロックを規則で補った入力"]
  assert.ok(補い.length > 0, "補いを 0 件と申告している")
  assert.ok(
    補い.some(x => x.identifier === "LOOKS_SAY" && x.影 === "text"),
    "出典に無い looks_say を申告していない",
  )
  for (const entry of 補い) {
    assert.ok(entry.入力 && entry.影, JSON.stringify(entry))
  }
  for (const key of [
    "ドロップダウンの選択肢",
    "ブロックでない記法",
    "今の Scratch で置けない記法",
    "綴りが衝突して呼べない記法",
  ]) {
    for (const entry of 範囲[key]) {
      assert.ok(entry.reason, `${key} の項目に理由が無い`)
    }
  }
})

test("例外表に未使用の項目が残ると失敗する", () => {
  const kinds = kindsWith([
    ...EXCEPTIONS,
    { identifier: "MOTION_NOSUCHBLOCK", kind: "option", reason: "作り話" },
  ])
  assert.deepEqual(kinds, ["例外表の項目が使われていない"])
})

test("例外表が同じ対象を 2 度指すと失敗する", () => {
  const kinds = kindsWith([...EXCEPTIONS, EXCEPTIONS[0]])
  assert.ok(kinds.includes("例外表の項目が重複している"))
})

test("例外表が実在しない opcode を指すと失敗する", () => {
  const kinds = kindsWith(
    EXCEPTIONS.map(e =>
      e.identifier === "SENSING_OF" ? { ...e, opcode: "sensing_nope" } : e,
    ),
  )
  assert.deepEqual(kinds, ["opcode が実在しない"])
})

test("opcode を解決できないブロックが残ると失敗する", () => {
  // SENSING_OF は定義が空で、例外表を外すと識別子から辿れなくなる
  const kinds = kindsWith(without("SENSING_OF"))
  assert.deepEqual(kinds, ["opcode を解決できない"])
})

test("opcode が一意に決まらないブロックが残ると失敗する", () => {
  // CONTROL_IF は control_if と control_if_else の双方に当たる
  const kinds = kindsWith(without("CONTROL_IF"))
  assert.deepEqual(kinds, ["opcode が一意に決まらない"])
})

test("識別子を持たない記法を例外表から外すと失敗する", () => {
  const kinds = kindsWith(without("comeToFront"))
  assert.deepEqual(kinds, ["識別子が無い"])
})

test("例外表の種別が読めないと失敗する", () => {
  // 綴りを外した種別を黙って受け取ると、そのブロックが台帳から静かに落ちる
  const kinds = kindsWith(
    EXCEPTIONS.map(e =>
      e.identifier === "SENSING_OF" ? { ...e, kind: "overide" } : e,
    ),
  )
  assert.deepEqual(kinds, ["例外表の種別が読めない", "opcode を解決できない"])
})

test("例外表の override が何も上書きしていないと失敗する", () => {
  const kinds = kindsWith(
    EXCEPTIONS.map(e =>
      e.identifier === "SENSING_OF"
        ? { identifier: e.identifier, kind: "override", reason: e.reason }
        : e,
    ),
  )
  assert.deepEqual(kinds, [
    "例外表が何も上書きしていない",
    "opcode を解決できない",
  ])
})

test("2 つのブロックが同じ opcode を指すと失敗する", () => {
  // sensing_of の選択肢をブロックとして扱うと、sensing_of が 2 度現れる
  const kinds = kindsWith(
    EXCEPTIONS.map(e =>
      e.identifier === "SENSING_OF_BACKDROPNAME"
        ? { ...e, kind: "override", opcode: "sensing_of" }
        : e,
    ),
  )
  assert.deepEqual(kinds, ["opcode が重複している"])
})

test("生成物に台帳の版が焼き込まれる", async () => {
  const built = await buildProject("projects/neko-to-score")
  assert.deepEqual(built.problems, [], "追跡下の作品が組み立てられない")

  const stamped = stampedCatalogOf(built.project)
  assert.ok(stamped, "meta.agent から台帳の版が読み出せない")
  // 台帳が名乗る生成元がそのまま載る。項目が欠けると照合の目が粗くなる
  assert.deepEqual(stamped, loadCatalog().raw!.生成元)
})

test("生成時と今で台帳の版が食い違うと、項目ごとに申告する", async () => {
  const built = await buildProject("projects/neko-to-score")
  const catalog = loadCatalog()

  const older = structuredClone(built.project)
  // 刻印は `生成元` だけを読む。版を 1 つずらした台帳で刻んで、古びを作る
  older.meta.agent = agentFor({
    ...catalog,
    raw: { ...catalog.raw!, 生成元: { ...catalog.raw!.生成元, scratchblocks: "0.0.1" } },
  })

  const drift = catalogDrift(older, catalog)
  assert.equal(drift.stamped, true, "刻印があるのに無いと言う")
  assert.equal(
    drift.differences.length,
    1,
    `食い違いの数が合わない: ${drift.differences.join(" / ")}`,
  )
  assert.match(drift.differences[0], /scratchblocks: 生成時 0\.0\.1 \/ 今 /)
})

test("台帳の版が一致すれば食い違いを申告しない", async () => {
  const built = await buildProject("projects/neko-to-score")
  assert.deepEqual(catalogDrift(built.project, loadCatalog()), {
    stamped: true,
    differences: [],
  })
})

test("焼き込みが無いことと食い違うことを、受け取る側が区別できる", () => {
  // 他の処理系が作った作品。agent は素の UA 文字列で JSON を含まない
  const foreign = { meta: { semver: "3.0.0", vm: "0.2.0", agent: "Mozilla/5.0 Scratch" } }
  assert.equal(stampedCatalogOf(foreign), null)
  // 刻印が無いのは他所の作品では正常な状態。食い違い 0 件と同じ形で返すと、
  // 受け取る側が件数でしか見分けられず、他人の .sb3 を読んだだけで警告になる
  assert.deepEqual(catalogDrift(foreign, loadCatalog()), { stamped: false, differences: [] })

  // 壊れた形でも落ちない。読めないことは異常ではない
  for (const agent of [undefined, 42, "{ こわれ", "[1,2]", '{"a":1']) {
    assert.equal(stampedCatalogOf({ meta: { agent } }), null, `agent=${agent} で落ちた`)
  }
  assert.equal(stampedCatalogOf(null), null)
  assert.equal(stampedCatalogOf({}), null)
})

test("他所の処理系が agent に JSON を載せていても、自分の刻印と読み違えない", () => {
  const now = loadCatalog()
  // 生成器の名で錨を打たず最初の `{` から読むと、この 3 通りが自分の刻印として通り、
  // 他人の作品に対して食い違いを申告する（2026-08-18 実測）
  const foreigners = [
    `OtherTool ${JSON.stringify(now.raw!.生成元)}`,
    'Mozilla/5.0 {"build":"1.2.3"}',
    '{"scratchblocks":"9.9.9"}',
  ]

  for (const agent of foreigners) {
    assert.equal(stampedCatalogOf({ meta: { agent } }), null, `${agent} を自分の刻印と読んだ`)
    assert.deepEqual(catalogDrift({ meta: { agent } }, now), {
      stamped: false,
      differences: [],
    })
  }
})

test("台帳の版が手書きの表の中身の変化で動く", () => {
  const 生成元 = loadCatalog().raw!.生成元
  assert.match(生成元.手書きの表, /^[0-9a-f]{12}$/)
  assert.equal(生成元.例外表, undefined, "件数を版として名乗ったままになっている")

  // 台帳を組み立て直しても同じ指紋になる（決定論。環境で揺れると照合が使えない）
  const 元の指紋 = buildCatalog().catalog.生成元.手書きの表
  assert.equal(元の指紋, 生成元.手書きの表)

  // 件数を変えずに中身だけ書き換える。件数を版として名乗っていた頃は、この変更で
  // 版が動かず `catalogDrift` が「一致」を返した。3 つの表すべてを指紋が覆う
  // 3 つの表は形が違う（並び・対応）。同じ手順で当てるため、組は素の三つ組で持つ
  const 差し替え: [any, any, any][] = [
    [EXCEPTIONS[0], "kind", `${EXCEPTIONS[0].kind}-ためし`],
    [PRIMITIVES, Object.keys(PRIMITIVES)[0], "ためし"],
    [OPTIONS, Object.keys(OPTIONS)[0], { ためし: "x" }],
  ]

  for (const [table, key, 別の値] of 差し替え) {
    const 元の値 = table[key]
    const 件数 = Array.isArray(table) ? table.length : Object.keys(table).length
    table[key] = 別の値
    try {
      assert.equal(
        Array.isArray(table) ? table.length : Object.keys(table).length,
        件数,
        "件数を変えてしまっては、件数との差が測れない",
      )
      assert.notEqual(
        buildCatalog().catalog.生成元.手書きの表,
        元の指紋,
        `${key} の中身を変えても版が動かない`,
      )
    } finally {
      table[key] = 元の値
    }
  }

  // 戻したら元の指紋に戻る（この検査が後続の検査を汚していないこと）
  assert.equal(buildCatalog().catalog.生成元.手書きの表, 元の指紋)

  // 例外表は組み立ての引数で差し替えられる。既定値の側を指紋に混ぜていると、
  // 差し替えた入力を指紋が表さない
  const 差し替えた = buildCatalog({ exceptions: EXCEPTIONS.slice(0, -1) }).catalog
  assert.notEqual(差し替えた.生成元.手書きの表, 元の指紋, "差し替えた例外表が版に映らない")
})

/**
 * 項目だけが壊れた台帳を書き出す。追跡下の台帳へ識別子の無い項目を 1 つ足す。
 *
 * 最小の台帳を捏造しない。読み取りは台帳が引けないと 1 つも解けないので、捏造した
 * 台帳では「申告が届くか」でなく「何も読めないか」を測ることになる。足りている台帳へ
 * 1 つだけ壊れた項目を混ぜれば、残りは引けたまま申告だけが立つ。
 *
 * 戻りは書き出した台帳の位置
 */
function catalogWithBrokenEntry(): string {
  // 壊れた項目を足すので、台帳の形からは外れる。意図した破壊なので素の値として持つ
  const raw: any = structuredClone(loadCatalog().raw)
  // 識別子が無い項目は `byIdentifier` から落ち、その 1 件だけが申告になる
  raw[CATALOG_KEYS.BLOCKS] = [...raw[CATALOG_KEYS.BLOCKS], { opcode: "識別子の無い項目" }]
  const path = join(mkdtempSync(join(tmpdir(), "gen-scratch-catalog-")), "blocks.json")
  writeFileSync(path, JSON.stringify(raw))
  return path
}

/** 上で混ぜた項目が立てる申告の名。実装の定数から作らず、字面をここへ置く */
const BROKEN_ENTRY = "台帳の項目が識別子を持たない"

/**
 * 標準エラーを捕まえる。申告が利用者へ届くことを測るので、届いた先を読む。
 */
async function captured(
  run: () => Promise<unknown> | unknown,
): Promise<{ value: any, text: string }> {
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: any) => {
    written.push(String(chunk))
    return true
  }
  try {
    return { value: await run(), text: written.join("") }
  } finally {
    // 差し替えたものを必ず戻す。戻し損ねると、以降の検査の申告が全部この配列へ消える
    process.stderr.write = original
  }
}

test("較正: 混ぜた項目が、台帳の申告をちょうど 1 件立てる", () => {
  // 測定器の較正。0 件なら以下の 3 つは「捨てていない」でなく「そもそも申告が無い」を
  // 測ることになり、2 件以上なら壊し方が広すぎて残りが引けなくなっている
  const broken = loadCatalog(catalogWithBrokenEntry())
  assert.ok(broken.raw, "台帳ごと読めなくしてしまっている")
  assert.deepEqual(
    broken.problems.map(problem => problem.kind),
    [BROKEN_ENTRY],
    "混ぜた項目の申告が 1 件でない",
  )
  // 残りが引けることも確かめる。引けないなら「項目だけが壊れている」を作れていない
  const 引ける = broken.byIdentifier.size
  assert.ok(引ける > 100, `引ける項目が ${引ける} 件しかない`)
})

test("項目だけが壊れた台帳の申告を、3 経路とも捨てない", async () => {
  const catalogPath = catalogWithBrokenEntry()

  const built = await buildProject("projects/neko-to-score", { catalogPath })
  assert.ok(
    built.problems.some(problem => problem.kind === BROKEN_ENTRY),
    "build が台帳の申告を捨てた",
  )

  const reading = await readSb3(await ourSb3(), "probe.sb3", { catalogPath })
  assert.ok(
    reading.problems.some(problem => problem.kind === BROKEN_ENTRY),
    "read が台帳の申告を捨てた",
  )

  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-knowledge-"))
  const { value, text } = await captured(() => knowledge(["--dir", dir], { catalogPath }))
  assert.match(text, new RegExp(BROKEN_ENTRY), "knowledge が台帳の申告を利用者へ届けない")
  assert.equal(value, 1, "knowledge が台帳の申告を出しながら 0 で終えた")
})

test("台帳に申告があっても、読み取りは読めたところまで返す", async () => {
  // 書き出しの規則と終了コードの規則を分ける裁定（2026-08-22）を固定する。捨てないことと
  // 止まることは別で、読み取りは止まらない
  const reading = await readSb3(await ourSb3(), "probe.sb3", {
    catalogPath: catalogWithBrokenEntry(),
  })
  assert.ok(reading.targets.length > 0, "台帳の申告 1 件で読み取りが全部を捨てた")
  assert.ok(reading.problems.length > 0, "申告が残っていない")
})
