/**
 * 知識層の一覧表を組み立てる。
 *
 * 知識層のページは 2 層でできている。何をするものかの説明は人が書き、一覧は出どころから
 * 生成する。ブロック解説の一覧は台帳から、作品定義の仕様は定義の表から出る。一覧を手で
 * 書くと二重管理になり、必ず食い違う。生成した層は目印で囲み、`--check` が組み立て直した
 * ものとの一致を見る（台帳の `--check` と同じ形）。
 */
import { CATALOG_KEYS, type Catalog, type CatalogArgument, type Entry, type ScopeEntry } from "./catalog.ts"
import { LEVELS, omissionOf } from "./definition.ts"
import { PREFIXES, isKind, prefixOf } from "./notation.ts"
import { eachBlock, parseNotation } from "./parse.ts"

/**
 * 生成した層を囲む目印。この間だけを差し替える。
 *
 * 出どころごとに別の綴りを持つ。ブロック解説は台帳から、作品定義の仕様は実装の表から
 * 出るため、同じ綴りにすると読む側が出どころを取り違える。
 */
type Marks = { begin: string; end: string }

/** 台帳から出る層の目印 */
export const CATALOG_MARKS: Marks = {
  begin: "<!-- 台帳から生成: ここから -->",
  end: "<!-- 台帳から生成: ここまで -->",
}

/** 定義の表から出る層の目印 */
export const DEFINITION_MARKS: Marks = {
  begin: "<!-- 定義の表から生成: ここから -->",
  end: "<!-- 定義の表から生成: ここまで -->",
}

/** core のカテゴリと、Scratch の画面での呼び名。並びは Scratch のパレットに合わせる */
export const CATEGORIES = [
  { key: "motion", label: "動き" },
  { key: "looks", label: "見た目" },
  { key: "sound", label: "音" },
  { key: "events", label: "イベント" },
  { key: "control", label: "制御" },
  { key: "sensing", label: "調べる" },
  { key: "operators", label: "演算" },
  { key: "variables", label: "変数" },
  { key: "list", label: "リスト" },
]

/** 台帳の形状の呼び名 */
const SHAPES: Record<string, string> = {
  hat: "帽子",
  stack: "積む",
  cap: "終わり",
  "c-block": "中身を持つ",
  "c-block cap": "中身を持つ・終わり",
  reporter: "値",
  boolean: "真偽",
}

/**
 * ブロックの形状の呼び名を返す。知らない形状は綴りのまま載せず印を付ける。
 *
 * 表の持ち物だけを見る。素朴に引くと原型の名前が呼び名として通り、関数が公開ドキュメントの
 * セルへ載る（CP6 で実測）。`typeOf` で直した素引きの双子がここに残っていた。
 *
 * `block` は台帳の項目。
 */
function shapeOf(block: Entry): string {
  const shape = String(block.shape ?? "")
  if (Object.hasOwn(SHAPES, shape)) return SHAPES[shape]
  return `${UNKNOWN_NOTATION}（${shape}）`
}

/**
 * 引数の綴りと、記法での書き方の呼び名の対応。
 *
 * 手順書の「値と入れ子を埋める」が読者へ示す型と揃える。突き合わせに使う `expectedAs`
 * （serialize.ts）は数と文字をどちらも「値」として扱うため、書く人が読む一覧には足りない。
 * 綴りを解く場所をここ 1 か所に閉じる。
 */
const ARGUMENT_TYPES: Record<string, string> = {
  [PREFIXES.NUMBER]: "数",
  [PREFIXES.STRING]: "文字",
  [PREFIXES.BOOLEAN]: "条件",
  [PREFIXES.COLOUR]: "色",
}

/**
 * 選択肢を一覧の行へ並べたまま置ける長さ。超えたものはページの末尾の表へ回す。
 *
 * 台帳を測って決めた（2026-08-19）。この散文が名指す数は `test/knowledge.test.ts` が
 * 数えており、台帳が動けば検査が落ちる。
 *
 * 検査から呼べるよう export する。
 */
export const OPTIONS_INLINE_LIMIT = 40

/** 長い選択肢を回す先の見出し。一覧の行を数える側が別表と切り分けるのに使う */
export const DEFERRED_HEADING = "### 選択肢の長いもの"

/**
 * 型に添える注意の印。選択肢の見た目でも書けてしまう欄に付ける。
 *
 * 検査から呼べるよう export する。手順書の型と照合するとき、印を外した綴りで見る。
 */
export const WARNED = "※"

/**
 * カテゴリ 1 つぶんのブロック一覧を markdown の表にする。
 *
 * 引数の型と選択肢まで載せるのは、記法を書くのに要る情報が台帳にしか無かったためである。
 * 手順書の自己検査項目「ドロップダウンの綴りが選択肢どおりである」は、綴りの一覧が
 * どこにも無ければ読者に実行できない。
 *
 * `catalog` は追跡下の台帳（`loadCatalog` の戻り）。
 */
export function categoryTable(catalog: Catalog, category: string): string {
  /** 一覧に置くには長い選択肢。ページの末尾へ回す */
  const deferred: string[] = []
  const rows = catalog[CATALOG_KEYS.BLOCKS]
    .filter((block: Entry) => block.category === category)
    .map((block: Entry) => {
      const cell = argumentCell(block)
      deferred.push(...cell.deferred)
      return (
        `| \`${block.ja}\` | \`${block.opcode}\` | ${shapeOf(block)} |` +
        ` ${cell.text} |`
      )
    })

  const lines = [
    // 折るのは句読点の直後に限る。markdown のソフト改行は空白になるため、語の途中で折ると
    // 「合図・音・ コスチューム」のように語の中へ空白が入る（2026-08-19 に実際に出した）
    "引数の欄は記法での書き方を表す。",
    "型の意味は[言葉から記法を組む手順](../howto.md)の「値と入れ子を埋める」にある。",
    "",
    "`名前` はリスト・変数・合図・音・コスチュームの名前を書く欄で、",
    "`[スコア v]` の形で書く。",
    "`※` の付いた欄は数で書く。選択肢の見た目（`[右 v]`）でも素の文字（`[右]`）でも",
    "書けてしまうが、値は文字として入るため、数として読めない値は止まる。",
    "",
    "| 記法 | opcode | 形 | 引数 |",
    "|---|---|---|---|",
    ...rows,
  ]
  if (deferred.length > 0) {
    lines.push("", DEFERRED_HEADING, "", "| 記法 | 引数 | 選択肢 |", "|---|---|---|", ...deferred)
  }
  return lines.join("\n")
}

/**
 * 1 ブロックの引数を 1 つのセルにまとめる。
 *
 * 番号は記法の `%1`・`%2` に対応する。台帳の引数は記法の番号順に並び、中身の置き場
 * （`statement`）だけが末尾に付く。中身は記法では字下げと `end` で表すので番号を持たない。
 *
 * 積む先を引数で受けて副作用で書き足すのはやめ、回す行を戻り値に含める。受けて積む形は
 * 「値を返す」と「渡されたものを書き換える」の 2 つを同じ関数が持ち、呼ぶ側から
 * どちらが起きるのか読めない。
 *
 * `block` は台帳の項目。戻りはセルの中身と、末尾へ回す行。
 */
function argumentCell(block: Entry): { text: string; deferred: string[] } {
  // 引数名を取れない 2 件は、記法から呼ぶと「中身の数に合う opcode が無い」で止まる
  // （2026-08-19 実測）。「覆わない範囲」に既出だが、一覧だけを見る人にも書けないと分かる形で出す
  if (!block.args) return { text: UNRESOLVED_ARGUMENTS, deferred: [] }

  const args = (block.args ?? []).filter((arg: CatalogArgument) => arg.kind !== "statement")
  if (args.length === 0) return { text: "—", deferred: [] }

  const deferred: string[] = []
  const text = args
    .map((arg: CatalogArgument, index: number) => {
      const place = `\`%${index + 1}\``
      const type = typeOf(arg)
      const options = arg.options
      if (!options) return `${place} ${type}`

      // 選択肢を持つことは上で確かめた。持つ形だけを渡す
      const choices = choicesOf({ options, namesAllowed: arg.namesAllowed })
      if (choices.length <= OPTIONS_INLINE_LIMIT) return `${place} ${type}（${choices}）`
      deferred.push(`| \`${block.ja}\` | \`%${index + 1}\` | ${choices} |`)
      return `${place} ${type}（${Object.keys(options).length} 種・下の表）`
    })
    .join(" / ")
  return { text, deferred }
}

/**
 * 引数を解けないブロックの一覧に出す文。件数を数える検査から引けるよう export する。
 */
export const UNRESOLVED_ARGUMENTS = "引数を解けない。記法からは書けない"

/**
 * 引数 1 つの型を、記法での書き方の呼び名で返す。
 *
 * 手順書の型と同じ語を使う。検査から呼べるよう export し、生成物を経由せずに
 * 語彙の一致を測れるようにする。
 *
 * `arg` は台帳の引数。
 */
export function typeOf(arg: Pick<CatalogArgument, "notation" | "options">): string {
  const prefix = prefixOf(arg.notation)
  // 数にドロップダウンが付く入力。選択肢の見た目でも解析は通るが、値は文字として入る
  // （`[右 v] 度に向ける` が問題 0 件で `右` を入れた。2026-08-19 実測）。手順書は
  // 「数で書く」と警告しており、一覧が逆を向くと読者を黙った誤りへ送る
  if (prefix === PREFIXES.NUMBER_MENU) return `数${WARNED}`
  // 選択肢が作品ごとに決まる欄は台帳が表を持たない。書かれた名前がそのまま値になる
  if (prefix === PREFIXES.MENU) return arg.options ? "選択肢" : "名前"
  // 表の持ち物だけを見る。素朴に引くと原型の名前（`toString` 等）が型として通り、
  // 関数がそのまま公開ドキュメントへ載る（2026-08-19 実測）
  const known = prefix !== null && Object.hasOwn(ARGUMENT_TYPES, prefix)
  if (known) return ARGUMENT_TYPES[prefix]
  // 知らない綴りを綴りのまま返さない。返すと `%x.foo` が公開ドキュメントへ載り、
  // 台帳が増えたことに誰も気づかない
  return `${UNKNOWN_NOTATION}（${arg.notation}）`
}

/**
 * 知らない綴りに付ける印。検査から呼べるよう export する。
 *
 * 一覧に出た時点で誤りなので、台帳の全引数がここへ落ちないことを検査が見張る。
 */
export const UNKNOWN_NOTATION = "解けない綴り"

/**
 * 選択肢の綴りを並べる。作品ごとの名前も取る欄はその旨を添える。
 *
 * 長さの上限を測る検査から呼べるよう export する。検査が長さを別に組み立てると、
 * 測っているものが実装の出す綴りとずれる。
 *
 * `arg` は台帳の引数。
 */
export function choicesOf(
  arg: { options: Record<string, string>; namesAllowed: boolean },
): string {
  const choices = Object.keys(arg.options).join("・")
  return arg.namesAllowed ? `${choices}、または名前` : choices
}

/**
 * 作品の定義に書けるキーの一覧を markdown の表にする。
 *
 * キー・値の型・既定値は実装の表（`definition.ts`）から取る。手で写すと実装と二重管理に
 * なり、キーを足したときに必ず食い違う。何をするキーかの散文は人が書き、この一覧の外に置く。
 */
export function definitionTable(): string {
  const lines: string[] = []
  for (const level of LEVELS) {
    lines.push(
      `### ${level.title}（${level.where}）`,
      "",
      "| キー | 値の型 | 省略したとき | 効き目 |",
      "|---|---|---|---|",
    )
    for (const [key, spec] of Object.entries(level.keys)) {
      lines.push(`| \`${key}\` | ${spec.type} | ${omissionOf(spec)} | ${spec.effect} |`)
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

/**
 * 定義に書けるキーの数。報告に出して、見た範囲を隠さない。
 */
export function definitionKeyCount(): number {
  return new Set(LEVELS.flatMap(level => Object.keys(level.keys))).size
}

/**
 * 生成した層を差し替える。目印が無ければ書き換えずに知らせる。
 *
 * 目印は必ず渡させる。既定値を置くと、出どころの違う層へ台帳の目印を当てる呼び出しが
 * 黙って通る（渡し忘れが差分として現れない）。
 *
 * 差し込む中身も見る。中身が目印を含むと、1 回目は書き込みに成功して 2 回目以降が
 * 「目印が 2 組以上ある」で恒久的に止まる。手で直すまで自力では戻れないので、書く前に断る。
 *
 * `text` は解説ファイルの中身、`body` は差し込む中身、`marks` は囲む目印。
 */
export function renderInto(
  text: string,
  body: string,
  marks: Marks,
): { text: string } | { error: string } {
  const { begin, end } = marks
  const from = text.indexOf(begin)
  const to = text.indexOf(end)
  if (from < 0 || to < 0) return { error: `生成の目印が無い（${begin} と ${end} で囲む）` }
  if (to < from) return { error: "生成の目印の順が逆" }
  if (text.indexOf(begin, from + 1) >= 0 || text.indexOf(end, to + 1) >= 0) {
    return { error: "生成の目印が 2 組以上ある" }
  }
  if (body.includes(begin) || body.includes(end)) {
    return { error: "差し込む中身が生成の目印を含む。書き込むと次から開けなくなる" }
  }

  return { text: `${text.slice(0, from)}${begin}\n${body}\n${text.slice(to)}` }
}

/**
 * 日本語の綴りが重なった組 1 つ分。`labelCollisions` がその場で組み立てる。
 */
export type Collision = {
  /** 重なっている日本語の綴り */
  ja: string
  /** 実際に解析器へ通した結果。どの綴りがどの識別子へ届いたか */
  tried: { identifier: string, notation: string, reaches: string }[]
  /** 記法から呼べない側の識別子 */
  unreachable: string[]
}

/**
 * 日本語の綴りが衝突するブロックを台帳から集め、解析器がどちらを返すかを実際に測る。
 *
 * 名に「ラベルの」を入れるのは、宣言の ID が衝突する別の検査（`project.ts`）と
 * 同じ名だったためである。同じ名で別の概念を指すと、読み手が同一のものと誤読する。
 *
 * 同じ日本語ラベルを持つブロックが複数あると、記法からは一方しか呼べない。どちらが呼ばれる
 * かは辞書の並びで決まるため、推測せず綴りを組んで解析器に通す。引数の形（値かドロップ
 * ダウンか）で区別が付く組もあるので、組ごとに全員ぶん試す。
 *
 */
export async function labelCollisions(
  catalog: Catalog,
): Promise<{ collisions: Collision[]; problems: string[] }> {
  const byLabel = new Map<string, any[]>()
  for (const block of catalog[CATALOG_KEYS.BLOCKS]) {
    // 日本語の綴りを持たないブロックは綴りで衝突しない。束ねると全員が同じ鍵へ入り、
    // 衝突していないものを衝突として数える（`sharedLabelsOf` と同じ規則で書く）
    if (!block.ja) continue
    byLabel.set(block.ja, [...(byLabel.get(block.ja) ?? []), block])
  }

  const found = []
  const problems = []
  for (const [ja, group] of byLabel) {
    if (group.length < 2) continue

    const reached = new Set()
    const tried = []
    for (const block of group) {
      const notation = fillArgs(block)
      const [first] = [...eachBlock(await parseNotation(notation))]
      const identifier = first?.info?.id ?? null
      if (identifier === null) {
        problems.push(`綴りを組み立てられない: ${block.identifier}（${notation}）`)
        continue
      }
      reached.add(identifier)
      tried.push({ identifier: block.identifier, notation, reaches: identifier })
    }

    found.push({
      ja,
      tried,
      unreachable: group.map(b => b.identifier).filter(id => !reached.has(id)),
    })
  }
  return { collisions: found, problems }
}

/**
 * 記法の綴りへ、引数の種別に応じた値を埋める。解析器に通せる形にするためだけに使う。
 * `block` は台帳の項目。
 */
function fillArgs(block: Entry & { ja: string }) {
  return block.ja.replace(/%(\d+)/g, (_: string, index: string) => {
    const kind = block.inputs[Number(index) - 1] ?? PREFIXES.STRING
    if (isKind(kind, PREFIXES.BOOLEAN)) return "<マウスが押された>"
    if (isKind(kind, PREFIXES.NUMBER)) return "(1)"
    if (isKind(kind, PREFIXES.COLOUR)) return "[#ff0000]"
    return isKind(kind, PREFIXES.MENU) ? "[なにか v]" : "[x]"
  })
}

/**
 * 覆わない範囲を markdown にする。台帳の申告と、綴りの衝突で到達できないブロックを並べる。
 *
 * `found` は `collisions` の戻り。
 */
export function scopeReport(catalog: Catalog, found: Collision[]): string {
  const lines: string[] = []
  for (const [label, entries] of Object.entries(catalog[CATALOG_KEYS.SCOPE])) {
    const count = entries.reduce((sum, entry) => sum + (entry.件数 ?? 1), 0)
    lines.push(`### ${label}（${count} 件）`, "")
    for (const entry of entries) lines.push(`- ${describe(entry)}`)
    lines.push("")
  }

  const unreachable = found.flatMap(item => item.unreachable)
  lines.push(
    `### 日本語の綴りが衝突して記法から呼べないブロック（${unreachable.length} 件）`,
    "",
    `同じ日本語ラベルを持つ組が ${found.length} 組ある。記法からは一方しか呼べない。`,
    "どちらが呼ばれるかは実際に解析器へ通して確かめたものである。",
    "",
    "| 綴り | 記法から呼べる | 呼べない |",
    "|---|---|---|",
  )
  for (const item of found) {
    const reachable = [...new Set(item.tried.map(t => t.reaches))]
    lines.push(
      `| \`${item.ja}\` | ${reachable.map(code).join(" / ")} |` +
        ` ${item.unreachable.length > 0 ? item.unreachable.map(code).join(" / ") : "（無し）"} |`,
    )
  }
  return lines.join("\n")
}

/** 覆わない範囲の 1 項目を 1 行にする */
function describe(entry: ScopeEntry) {
  if (entry.category) return `\`${entry.category}\`: ${entry.件数} 件`

  // 識別子を持たない項目（Scratch 2 の記法）は綴りで示す。「名前なし」では引けない
  const name = entry.identifier ?? entry.opcode ?? entry.spec ?? "(名前なし)"
  const where = entry.入力 ? ` の入力 \`${entry.入力}\`` : ""
  const why = entry.reason ? ` — ${entry.reason}` : ""
  const shadow = entry.影 ? `（影は \`${entry.影}\`）` : ""
  return `\`${name}\`${where}${shadow}${why}`
}

function code(identifier: string) {
  return `\`${identifier}\``
}
