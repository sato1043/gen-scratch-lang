import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { CATALOG_KEYS } from "../src/catalog.ts"
import {
  CATALOG_MARKS,
  CATEGORIES,
  DEFERRED_HEADING,
  OPTIONS_INLINE_LIMIT,
  UNKNOWN_NOTATION,
  UNRESOLVED_ARGUMENTS,
  USER_DEFINED_ARGUMENTS,
  WARNED,
  categoryTable,
  choicesOf,
  labelCollisions,
  renderInto,
  scopeReport,
  typeOf,
} from "../src/knowledge.ts"
import { catalogOrStop } from "./fixtures.ts"

const catalog = catalogOrStop()

/**
 * 書き換えの結果から本文を取り出す。断られたらその場で止める。
 *
 * `renderInto` は成功と失敗を別の形で返す。`result.error` が undefined であることを
 * 見るだけでは、成功したのか欄の名を間違えたのかが同じ緑になる。
 */
function bodyOf(result: ReturnType<typeof renderInto>): string {
  if ("error" in result) throw new Error(`書き換えが断られた: ${result.error}`)
  return result.text
}

/** 書き換えを断った理由。通ってしまったらその場で止める */
function refusalOf(result: ReturnType<typeof renderInto>): string {
  if (!("error" in result)) throw new Error("断られるはずの入力で書き換えが通った")
  return result.error
}

/**
 * 一覧の表の行だけを取り出す。
 *
 * 行数で切り出すと、凡例や見出しを足したときに黙ってずれる。行の形（`| \`` で始まる）で
 * 選び、末尾へ回した選択肢の表は見出しで切り離す。
 */
function listRows(table: string): string[] {
  return table
    .split(DEFERRED_HEADING)[0]
    .split("\n")
    // 本体行を許される形で選ぶ。2 列目の opcode はバッククォート括りの小文字と決まって
    // おり、見出しも区切りもその形を持たない。記法の列で絞ると、綴りを利用者が決める
    // ブロックの行が漏れる（そちらはバッククォートで始まらない）
    .filter(line => /^\| [^|]+ \| `\w+` \|/.test(line))
}

/**
 * 解説が覆うべき範囲。台帳から借りず、覆うべき件数として書き下す。実装から借りると、
 * 実装が範囲を狭めたときに検査も一緒に狭まる（段階 2 で実際に起きた型）。
 */
const COVERAGE = {
  motion: 18,
  looks: 21,
  sound: 9,
  events: 9,
  control: 10,
  sensing: 19,
  operators: 18,
  variables: 4,
  list: 11,
  pen: 9,
  // 定義の帽子と呼び出しの 2 つ。呼び出しの綴りは利用者が決めるので台帳に名前を持たない
  custom: 2,
  // 引数の参照 1 つ。宣言の側はプロトタイプの中に現れるもので、独立した項を持たない
  "custom-arg": 1,
}

test("解説が扱うカテゴリを覆い、全ブロックを一覧に載せる", () => {
  assert.deepEqual(
    CATEGORIES.map(c => c.key).sort(),
    Object.keys(COVERAGE).sort(),
    "解説のカテゴリが台帳の扱う範囲と食い違う",
  )

  let total = 0
  for (const [category, count] of Object.entries(COVERAGE)) {
    const rows = listRows(categoryTable(catalog.raw, category))
    assert.equal(rows.length, count, `${category} の件数が合わない`)

    // 記法の列に許される形を全カテゴリで数える。行を選ぶ側は opcode の列で絞るので、
    // 記法の列が崩れても件数は動かない。許される側（綴りか、綴りを持たない旨）を
    // 挙げて、それ以外が入ったら落とす
    for (const row of rows) {
      const spelling = row.split("|")[1].trim()
      assert.ok(
        /^`.+`$/.test(spelling) || spelling === "利用者が決める",
        `${category} の記法の列が想定の形でない: ${spelling}`,
      )
    }
    total += rows.length
  }
  assert.equal(total, 131, "台帳 131 件が解説へ載っていない")
})

test("一覧の各行が記法と opcode と形と引数を持つ", () => {
  const rows = listRows(categoryTable(catalog.raw, "motion"))
  for (const row of rows) {
    const cells = row.split("|").filter(cell => cell.trim() !== "")
    assert.equal(cells.length, 4, `欄が 4 つでない: ${row}`)
  }
  assert.match(rows[0], /`%1 歩動かす`.+`motion_movesteps`.+積む.+`%1` 数/)
})

test("引数の型を記法での書き方の呼び名で出す", () => {
  const rows = listRows(categoryTable(catalog.raw, "sensing")).join("\n")

  // 手順書の「値と入れ子を埋める」が示す型と同じ言葉で出す
  assert.match(rows, /`sensing_askandwait`.+`%1` 文字/, "文字の欄が出ていない")
  assert.match(rows, /`sensing_touchingcolor`.+`%1` 色/, "色の欄が出ていない")
  assert.match(rows, /`sensing_touchingobject`.+`%1` 選択肢（.+、または名前）/)

  // 条件の欄は制御にある
  assert.match(listRows(categoryTable(catalog.raw, "control")).join("\n"), /`control_if`.+`%1` 条件/)

  // 数にドロップダウンが付く欄は「数」と案内し、印で注意を促す。選択肢の形でも解析は
  // 通るが値は文字として入るため、両方を並べると黙った誤りへ誘導する
  const motion = listRows(categoryTable(catalog.raw, "motion")).join("\n")
  assert.match(motion, new RegExp(`\`motion_pointindirection\`.+\`%1\` 数${WARNED}`))
  assert.doesNotMatch(motion, /数か選択肢/, "選択肢でも書けると案内している")
})

/**
 * 手順書の型の表から、読者へ示している型の名を取り出す。
 */
function typesInGuide(): string[] {
  const guide = readFileSync(new URL("../docs/knowledge/howto.md", import.meta.url), "utf8")
  const table = guide.split("| 型 | 書き方 | 入るもの |")[1]?.split("\n\n")[0] ?? ""
  return table
    .split(/\r?\n/)
    .filter(line => line.startsWith("| ") && !line.startsWith("|--"))
    .map(line => line.split("|")[1].trim())
}

test("一覧が出す型の名が、手順書の型の表に載っている", () => {
  // 生成器の doc は「手順書と揃える」と宣言する。宣言だけ置いて測らないと、片方が
  // 語を増やしたときに読者は一覧の語を手順書で引けなくなる
  const declared = new Set(typesInGuide())
  assert.ok(declared.size >= 6, `手順書の型の表から ${declared.size} 種しか読めていない`)

  const used = new Set()
  for (const block of catalog.raw.ブロック) {
    for (const arg of block.args ?? []) {
      if (arg.kind === "statement") continue
      used.add(typeOf(arg).replace(WARNED, ""))
    }
  }
  assert.ok(used.size >= 5, `台帳から ${used.size} 種の型しか出ていない`)

  assert.deepEqual(
    [...used].filter(type => !declared.has(type as string)).sort(),
    [],
    "一覧が手順書に無い型の名を出している",
  )
})

test("台帳の引数の並びが、記法の番号の順と揃っている", () => {
  // 一覧の `%1`・`%2` はこの前提の上に乗っている。崩れても --check は緑のまま、
  // 誤った対応の表を配り続ける
  const broken = []
  let checked = 0
  for (const block of catalog.raw.ブロック) {
    // 引数名を取れない 2 件は「覆わない範囲」に既出。記法からも呼べない
    if (!block.ja || !block.args) continue
    const marks = [...block.ja.matchAll(/%(\d+)/g)].map(match => Number(match[1]))
    const args = block.args.filter((arg: any) => arg.kind !== "statement")
    checked += 1

    if (marks.length !== args.length) {
      broken.push(`${block.identifier}: 印 ${marks.length} 個に引数 ${args.length} 個`)
      continue
    }
    const ordered = [...marks].sort((a, b) => a - b).join(",")
    const expected = args.map((_: any, index) => index + 1).join(",")
    if (ordered !== expected) broken.push(`${block.identifier}: 印が ${ordered}`)
  }

  assert.ok(checked >= 115, `照合できたブロックが ${checked} 件しかない`)
  assert.deepEqual(broken, [], "記法の番号と引数の並びが噛み合わない")
})

test("選択肢の綴りを一覧に載せ、長いものだけ末尾の表へ回す", () => {
  const short = categoryTable(catalog.raw, "sound")
  // 短い選択肢はその場に置く。別表への往復を増やさない
  assert.match(short, /`%1` 選択肢（ピッチ・左右にパン）/)
  assert.ok(!short.includes(DEFERRED_HEADING), "回す必要の無い選択肢を末尾へ送っている")

  const long = categoryTable(catalog.raw, "events")
  assert.match(long, /`%1` 選択肢（42 種・下の表）/, "長い選択肢の件数を一覧に出していない")
  assert.ok(long.includes(DEFERRED_HEADING), "長い選択肢の表が無い")

  // 回した先には綴りが全件ある。自己検査項目「綴りが選択肢どおり」を実行できる形にする
  const deferred = long.split(DEFERRED_HEADING)[1]
  const key = catalog.byIdentifier.get("EVENT_WHENKEYPRESSED")
  if (!key?.args) assert.fail("測る対象のブロックが台帳に無い")
  const choices = key.args[0].options
  if (!choices) assert.fail("測る対象の選択肢が台帳に無い")
  for (const spelling of Object.keys(choices)) {
    assert.ok(deferred.includes(spelling), `選択肢 ${spelling} が末尾の表に無い`)
  }
})

test("生成した層だけを差し替え、人が書いた層に触れない", () => {
  const text = [
    "前書き",
    "<!-- 台帳から生成: ここから -->",
    "古い表",
    "<!-- 台帳から生成: ここまで -->",
    "後書き",
  ].join("\n")

  const rendered = bodyOf(renderInto(text, "新しい表", CATALOG_MARKS))
  assert.match(rendered, /^前書き\n/)
  assert.match(rendered, /\n後書き$/)
  assert.match(rendered, /新しい表/)
  assert.doesNotMatch(rendered, /古い表/)
})

test("目印が無い・足りない・重なるときは書き換えずに知らせる", () => {
  const begin = "<!-- 台帳から生成: ここから -->"
  const end = "<!-- 台帳から生成: ここまで -->"

  const into = (text: string, body = "表") =>
    refusalOf(renderInto(text, body, CATALOG_MARKS))

  assert.match(into("目印なし"), /目印が無い/)
  assert.match(into(`${begin}\n表`), /目印が無い/)
  assert.match(into(`${end}\n${begin}`), /順が逆/)
  assert.match(into(`${begin}\n${end}\n${begin}\n${end}`), /2 組以上/)

  // 差し込む中身が目印を含むと、1 回目は書けて 2 回目以降が恒久的に止まる。書く前に断る
  assert.match(into(`${begin}\n${end}`, `表\n${end}`), /差し込む中身/)
  assert.match(into(`${begin}\n${end}`, `${begin}\n表`), /差し込む中身/)
})

test("日本語の綴りが衝突する組を数え、どちらが呼ばれるかを実際に測る", async () => {
  const { collisions: found, problems } = await labelCollisions(catalog.raw)
  assert.deepEqual(problems, [])

  // 実測値。台帳や解析器の辞書が変われば動く
  assert.equal(found.length, 6, "衝突する綴りの数が違う")
  assert.equal(found.flatMap(item => item.unreachable).length, 1, "呼べないブロックの数が違う")

  // 引数の形で見分けが付く組は、双方とも呼べる
  const contains = found.find(item => item.ja === "%1 に %2 が含まれる")
  assert.deepEqual(contains!.unreachable, [], "引数の形で解ける組を呼べない側に数えている")

  // 呼べる側の判定は推測でなく解析器の答えである。読み替えを通した後の答えを見る
  const length = found.find(item => item.ja === "%1 の長さ")
  assert.deepEqual(length!.unreachable, [])
  assert.deepEqual(
    [...new Set(length!.tried.map((t: { reaches: string }) => t.reaches))].sort(),
    ["DATA_LENGTHOFLIST", "OPERATORS_LENGTH"],
    "引数の形で分かれた結果が解析器の答えに現れていない",
  )

  // 分ける手掛かりを持たない組だけが残る。音量は双方とも引数を持たないので、素の綴りに
  // 差が出ない
  const volume = found.find(item => item.ja === "音量")
  assert.deepEqual(volume!.unreachable, ["SENSING_LOUDNESS"])

  // 選択肢の値で分かれる組も、実物の選択肢で測れば双方へ届く
  const effect = found.find(item => item.ja === "%1 の効果を %2 ずつ変える")
  assert.deepEqual(effect!.unreachable, [])
  assert.deepEqual(
    [...new Set(effect!.tried.map((t: { reaches: string }) => t.reaches))].sort(),
    ["LOOKS_CHANGEEFFECTBY", "SOUND_CHANGEEFFECTBY"],
  )
})

test("覆わない範囲を群ごとに件数と一覧で申告する", async () => {
  const { collisions: found } = await labelCollisions(catalog.raw)
  const report = scopeReport(catalog.raw, found)

  // 台帳が申告した群がすべて残っている。0 件を装わない
  for (const label of Object.keys(catalog.raw.覆わない範囲)) {
    assert.ok(report.includes(`### ${label}`), `${label} の群が落ちている`)
  }
  assert.match(report, /### core の外のカテゴリ（93 件）/)
  assert.match(report, /### 素の綴りでは呼べないブロック（1 件）/)

  // 読み替えで届くようになった組が「呼べる」側にいる理由を、規則として並べる
  assert.match(report, /### 綴りの重なりを解く規則（3 件）/)
  assert.match(report, /`SENSING_OF` \| `OPERATORS_MATHOP`/)

  // 識別子を持たない項目も綴りで引ける形で残す
  assert.match(report, /`go to front`/)
  assert.doesNotMatch(report, /名前なし/)
})

/**
 * 散文が名指す数を、数えて固定する。
 *
 * コメントに書いた数は、台帳が動いても落ちて知らせる仕組みを持たない。数を書いた側と
 * 数える側を並べて置き、動いたら赤くする。
 */
test("選択肢を一覧へ置ける長さの根拠を、台帳から数え直す", () => {
  const lengths = catalog.raw[CATALOG_KEYS.BLOCKS]
    .flatMap((block: any) => block.args ?? [])
    .filter((arg: any) => arg.options)
    .map((arg: any) => choicesOf(arg).length)

  assert.equal(lengths.length, 26, "選択肢を持つ引数の数が変わった")

  const over = lengths.filter(length => length > OPTIONS_INLINE_LIMIT)
  assert.equal(over.length, 3, "上限を超える選択肢の数が変わった")

  // 超えない側が上限のすぐ手前に張り付いていないことも見る。張り付いていれば、
  // 台帳が少し動くだけで一覧の見え方が変わる
  const rest = lengths.filter(length => length <= OPTIONS_INLINE_LIMIT)
  assert.equal(Math.max(...rest), 37, "上限に収まる側の最長が変わった")
})

test("引数を解けないブロックの件数を、台帳と一覧の両方から数える", () => {
  const unresolved = catalog.raw[CATALOG_KEYS.BLOCKS].filter(
    (block: any) => block.args === null,
  )
  // `args: null` は 2 つの意味を運ぶ。上流の定義が空で読めない 2 件（記法からも
  // 書けない）と、引数を利用者が決める 3 件（記法からは書ける）である
  assert.equal(unresolved.length, 5, "引数を解けないブロックの数が変わった")
  const 取れない = unresolved.filter((block: any) => block.argsBy === null)
  const 利用者 = unresolved.filter((block: any) => block.argsBy === "利用者")
  assert.equal(取れない.length, 2, "引数を導けないブロックの数が変わった")
  assert.equal(利用者.length, 3, "引数を利用者が決めるブロックの数が変わった")

  // 一覧の側にも、それぞれ同じ数だけ出ていることを見る。台帳で数えるだけでは、
  // 一覧が**どちらの文で**出しているかまでは分からない ── 混ぜると、記法から
  // 書けるブロックへ「記法からは書けない」と刷る（CP6 で実測）
  const 一覧 = CATEGORIES.map(({ key }) => categoryTable(catalog.raw, key)).join("\n")
  assert.equal(一覧.split(UNRESOLVED_ARGUMENTS).length - 1, 取れない.length)
  assert.equal(一覧.split(USER_DEFINED_ARGUMENTS).length - 1, 利用者.length)

  // 2 つの文が別物であることまで見る。同じ綴りにすると上の 2 つが両方通り、
  // 見分けが付かないまま緑になる
  assert.notEqual(UNRESOLVED_ARGUMENTS, USER_DEFINED_ARGUMENTS)
})

test("台帳のどの引数も、解けない綴りとして一覧に出ない", () => {
  // 綴りが増えたら一覧が印を出す。印を出さずに綴りをそのまま載せると、公開ドキュメントへ
  // `%x.foo` が並んだまま誰も気づかない（2026-08-19 実測）
  const unresolved = []
  let counted = 0
  for (const block of catalog.raw[CATALOG_KEYS.BLOCKS]) {
    for (const arg of block.args ?? []) {
      if (arg.kind === "statement") continue
      counted += 1
      if (!typeOf(arg).startsWith(UNKNOWN_NOTATION)) continue
      unresolved.push(`${block.identifier}.${arg.name}`)
    }
  }

  assert.ok(counted >= 120, `走査できた引数が ${counted} 個しかない`)
  assert.deepEqual(unresolved, [], "解けない綴りが台帳にある")
})

test("知らない綴りには印を付け、綴りをそのまま返さない", () => {
  // 対照。上の検査が「常に空を返す」実装でも緑にならないようにする
  const shown = typeOf({ notation: "%x.foo", options: null })
  assert.ok(shown.startsWith(UNKNOWN_NOTATION), `印が付いていない: ${shown}`)
  assert.ok(shown.includes("%x.foo"), "何が解けなかったのかを落としている")

  // 原型の名前が型として通ると、関数がそのまま一覧へ載る
  assert.equal(typeof typeOf({ notation: "constructor", options: null }), "string")
})
