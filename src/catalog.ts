/**
 * 書き出し済みの台帳を読み、生成物へ焼き込む版を扱う。
 *
 * 台帳そのものの組み立ては tools/build-catalog.ts が担う。組み立てには開発依存の
 * scratch-blocks が要り、利用者の手元には無い。読む側がそれを巻き込まないよう分けて
 * いる。読むだけなら追跡下の catalog/blocks.json で足りる。
 */
import { readFileSync } from "node:fs"
import { TYPES, fitsType } from "./definition.ts"
import { reasonOf, shownPath } from "./errors.ts"

/** 追跡下の台帳。生成のたびに組み立て直さず、書き出し済みのものを読む */
const CATALOG_PATH = new URL("../catalog/blocks.json", import.meta.url)

export type Problem = {
  kind: string
  subject: string
  detail: string
  /** 台帳由来の申告か。`loadCatalog` が出口で付ける */
  catalog?: boolean
}

/**
 * 台帳が持つ引数 1 つ分。
 *
 * 形を読む側で定義するのは、作る側（`tools/build-catalog.ts`）が開発依存を要するため
 * である。作る側で定義すると、読む側が形を知るために生成側を参照することになり、分けた
 * 意味が無くなる。作る側はここを参照する。
 *
 */
export type CatalogArgument = {
  /** .sb3 での欄の名前 */
  name: string
  /** 置き場 */
  kind: "field" | "input" | "statement" | null
  /** 記法での引数の綴り */
  notation: string | null
  /** 敷く影ブロック */
  shadow: string | null
  /** 影の出どころ */
  shadowFrom: string | null
  /** 選択肢 */
  options: Record<string, string> | null
  /** 選択肢の出どころ */
  optionsFrom: string | null
  /** 書いた名前をそのまま値にできるか */
  namesAllowed: boolean
}

/** 台帳の項目 1 つ分 */
export type Entry = {
  identifier: string
  opcode: string
  category: string
  shape: string
  /** 英語の記法 */
  spec: string
  /** 日本語ラベル */
  ja: string | null
  /** 引数の種別 */
  inputs: string[]
  /** 引数。取れなければ null */
  args: CatalogArgument[] | null
  /** 同じ記法が中身の形によって取る別の opcode と、その引数 */
  alsoCovers: { opcode: string; args: CatalogArgument[] | null }[]
  /** opcode の出どころ */
  opcodeFrom: "定義" | "例外表"
}

/**
 * 台帳の欄の名前。
 *
 * 読む側 5 か所と作る側が同じ綴りを literal で持っていた。欄を改名するときに追随漏れが
 * 起きても、JSON の添字引きは undefined を返すだけで止まらない。書く側と読む側が同じ
 * ここを見る。
 */
export const CATALOG_KEYS = Object.freeze({
  BLOCKS: "ブロック",
  SCOPE: "覆わない範囲",
  ORIGIN: "生成元",
  COUNTS: "件数",
  SOURCES: "表の出典",
})

/**
 * 「覆わない範囲」の 1 項目。
 *
 * 群ごとに書く欄が違う（区分を数える群・記法を挙げる群・入力を挙げる群など 8 群ある）
 * ので、どれも省ける形で持つ。並べる側は在る欄だけを読む。
 *
 * **欄は実物から数えて挙げた**（2026-08-25 実測。8 群・11 欄）。読む側が触る欄だけを
 * 書くと、書き出す側が足した欄を型が黙って落とす。
 */
export type ScopeEntry = {
  category?: string
  identifier?: string | null
  opcode?: string
  selector?: string | null
  spec?: string
  reason?: string
  件数?: number
  入力?: string
  定義が空?: boolean
  影?: string | null
  識別子?: string[]
}

/** 書き出した台帳の全体 */
export type Catalog = {
  生成元: Record<string, string>
  表の出典: { 表: string; 種別: string; 出典: string; 版: string | null; 理由: string }[]
  件数: Record<string, number>
  ブロック: Entry[]
  覆わない範囲: Record<string, ScopeEntry[]>
}

/**
 * 読み出した台帳。`loadCatalog` の戻りであり、受け取る側の引数の型でもある。
 *
 * `raw` は読めなければ null になる。受け取る側が読めた前提で欄を触るなら、先に
 * null を落としてから渡す（そうしないと「欄が空」と「台帳ごと無い」が同じ顔で出る）。
 */
export type LoadedCatalog = {
  raw: Catalog | null
  byIdentifier: Map<string, Entry>
  problems: Problem[]
}

/**
 * 書き出し済みの台帳を読み、識別子で引ける形にする。
 *
 * 組み立て直さないのは、生成のたびに scratch-blocks の字句走査が入るため。追跡下の
 * 台帳が古びていないかは `catalog --check` が別に見張る。
 *
 * 読めないことは投げずに問題として返す。投げると、呼ぶ側が積み上げた問題ごと経路から
 * 落ち、「台帳を読めない」という受け口を持っているのに使われないまま例外で終わる。
 * 読めなかったときは `raw` が null になる。呼ぶ側はそこで止める。
 *
 * 壊れ方は 2 つある。**台帳を読めない**（`raw` が null。JSON として読めないか最上位の
 * 型が違う）と、**項目だけが壊れている**（`raw` はあるが `problems` が空でない。その
 * 項目だけが `byIdentifier` から落ち、残りは引ける）である。
 *
 * 呼ぶ側 3 つ（`build`・`knowledge`・`read`）は同じ規則を通る。
 *
 * > 台帳の申告は捨てない。申告が 1 件でもあれば終了コードは非 0 にする。
 * > 成果物を書くかどうかは、申告と別に決める。
 *
 * 分かれてよいのは最後の 1 文だけである。`build` と `knowledge` は台帳が欠ければ
 * 成果物が欠けるので書かずに止める。`read` は台帳に無い opcode を印で示す道を持つので、
 * 読めたところまで書いて非 0 で終える。項目だけが壊れた台帳で `read` が申告を捨てて
 * いた（2026-08-22 に是正）。
 *
 */
export function loadCatalog(path: string | URL = CATALOG_PATH): LoadedCatalog {
  const found = readCatalog(path)
  // 台帳由来であることを、出口 1 か所でまとめて印す。申告を作る場所ごとに付ける形に
  // すると、次に足した申告が黙って印を落とす（本作業が畳んだ割れと同じ型である）。
  // 呼ぶ側はこの印で見出しを選び分ける ── 種類の綴りで見分けると、綴りを変えた瞬間に
  // 黙って戻る
  return {
    ...found,
    problems: found.problems.map(problem => ({ ...problem, catalog: true })),
  }
}

/**
 * 台帳を読んで、引ける形と申告に分ける。印は付けない（`loadCatalog` の役目）。
 *
 */
function readCatalog(path: string | URL): LoadedCatalog {
  const problems: Problem[] = []
  const byIdentifier = new Map<string, Entry>()

  const where = shownPath(path)

  let raw
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    return {
      raw: null,
      byIdentifier,
      problems: [{ kind: "台帳を読めない", subject: where, detail: reasonOf(error) }],
    }
  }

  const broken = typeProblems(raw, where)
  if (broken.length > 0) return { raw: null, byIdentifier, problems: broken }

  for (const [index, block] of raw[CATALOG_KEYS.BLOCKS].entries()) {
    if (!TYPES.対応(block)) {
      problems.push({
        kind: "台帳の型が違う",
        subject: `${where}: ${CATALOG_KEYS.BLOCKS}[${index}]`,
        detail: `対応（キーと値の組）で書く（今は ${JSON.stringify(block)}）`,
      })
      continue
    }
    // 上の `対応` で形は確かめた。欄の中身は下で 1 つずつ見る
    const entry = block as unknown as Entry
    if (!entry.identifier) {
      problems.push({
        kind: "台帳の項目が識別子を持たない",
        subject: entry.opcode,
        detail: "識別子で引けないため生成に使えない",
      })
      continue
    }
    byIdentifier.set(entry.identifier, entry)
  }
  return { raw, byIdentifier, problems }
}

/**
 * 読む側が触る欄が、触れる型で入っているかを見る。
 *
 * JSON として読めることまでしか見ていなかったため、`{}` も `{"ブロック": null}` も
 * `42` も例外で抜けていた（7 形を測って 5 形。2026-08-19 実測）。受け口を持っているのに
 * 使われず、呼ぶ側が積み上げた問題ごと経路から落ちる ── このモジュールが避けている
 * 事態そのものである。
 *
 * 見るのは読む側が実際に触る 3 つに限る。守備範囲を欄の名前で書き出しておき、読まない
 * 欄まで検査する形にはしない。`TYPES` を定義の表から借りるのは、値の型を呼ぶ語
 * （対応・並び）を作品の仕様と揃えるためである。同じ型に 2 通りの呼び名を作らない。
 *
 * `where` は申告に出す台帳の位置。触れる型なら空を返す。
 */
function typeProblems(raw: unknown, where: string): Problem[] {
  if (!TYPES.対応(raw)) {
    return [
      {
        kind: "台帳の型が違う",
        subject: where,
        detail: `台帳そのものを対応（キーと値の組）で書く（今は ${JSON.stringify(raw)}）`,
      },
    ]
  }

  /** 読む側が触る欄と、その型 */
  const required: [string, string][] = [
    [CATALOG_KEYS.BLOCKS, "並び"],
    [CATALOG_KEYS.SCOPE, "対応"],
    [CATALOG_KEYS.ORIGIN, "対応"],
  ]
  // 上の `対応` が型述語なので、ここでは既にキーで引ける形へ絞れている
  const table = raw
  return required
    .filter(([key, type]) => !fitsType(type, table[key]))
    .map(([key, type]) => ({
      kind: "台帳の型が違う",
      subject: `${where}: ${key}`,
      detail: `${type}で書く（今は ${JSON.stringify(table[key])}）`,
    }))
}

/**
 * 名前を UTF-16 の符号単位の順に比べる。
 *
 * `localeCompare` を使わないのは、並びが実行環境の照合規則に左右されるため。台帳は
 * 追跡下に置いて差分を読む生成物であり、機械が変われば並びが変わる状態にはできない。
 *
 * 符号位置の順ではない。JavaScript の `<` は符号単位で比べるので、全角形・半角カナと
 * 代理対で表す絵文字が混ざると並びが分かれる。実行環境をまたいでは同じなので不変条件は
 * 保たれるが、他の言語（符号位置順で並べるもの）で生成物を照合すると食い違う。
 *
 */
export function byName(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** 生成物へ名乗る生成器の名 */
const AGENT_NAME = "gen-scratch-lang"

/** 焼き込みの前置き。読む側はここで錨を打ち、他所の作品を自分の刻印と読み違えない */
const STAMP_PREFIX = `${AGENT_NAME} `

/**
 * 生成物の `meta.agent` へ入れる文字列を組み立てる。
 *
 * 台帳は生成物の出どころである。台帳を更新して .sb3 を作り直し忘れると、図と .sb3 が
 * 食い違う。生成物の側に版が残っていれば、後から .sb3 だけを見て気づける。
 *
 * 書く側と読む側（`catalogDrift`）を同じファイルに置くのは、書式の知識を 1 か所に
 * 閉じるため。2 か所に書くと、片方だけ変えたときに黙って読めなくなる。
 *
 * `catalog` は `loadCatalog` の戻り。
 */
export function agentFor(catalog: LoadedCatalog): string {
  return `${STAMP_PREFIX}${JSON.stringify(catalog.raw?.[CATALOG_KEYS.ORIGIN] ?? {})}`
}

/**
 * 生成物へ焼き込まれた台帳の版を取り出す。
 *
 * `project` は project.json の中身。焼き込みが無ければ null を返す。
 */
export function stampedCatalogOf(project: any): Record<string, string> | null {
  const agent = project?.meta?.agent
  // 生成器の名で錨を打つ。最初の `{` から読むと、他所の処理系が `agent` に JSON を
  // 載せているだけで自分の刻印と読み違え、他人の作品に対して食い違いを申告する
  if (typeof agent !== "string" || !agent.startsWith(STAMP_PREFIX)) return null

  try {
    const parsed = JSON.parse(agent.slice(STAMP_PREFIX.length))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    // 他の処理系が作った .sb3 では `agent` は素の UA 文字列で JSON を含まない。
    // 読めないことは異常ではないため、問題として上げず「焼き込みが無い」を返す
    return null
  }
}

/**
 * 生成物に焼き込まれた台帳の版と、今の台帳の版を突き合わせる。
 *
 * 「刻印が無い」と「刻印はあるが食い違う」を別の欄で返す。前者は他所の作品では正常な
 * 状態であり、後者だけが作り直しを促す。1 つの配列へ混ぜると、受け取る側が件数でしか
 * 見分けられず、他人の .sb3 を読んだだけで警告を出すことになる。
 *
 * `project` は project.json の中身、`catalog` は今の台帳（`loadCatalog` の戻り）。
 * 戻りの `stamped` が false なら焼き込みが無い。`differences` は食い違った項目で、
 * 一致すれば空。
 */
export function catalogDrift(
  project: any,
  catalog: LoadedCatalog,
): { stamped: boolean; differences: string[] } {
  const stamped = stampedCatalogOf(project)
  if (!stamped) return { stamped: false, differences: [] }

  const now = catalog.raw?.[CATALOG_KEYS.ORIGIN] ?? {}
  const keys = [...new Set([...Object.keys(stamped), ...Object.keys(now)])].sort(byName)
  const differences = keys
    .filter(key => stamped[key] !== now[key])
    .map(key => `${key}: 生成時 ${stamped[key] ?? "(無い)"} / 今 ${now[key] ?? "(無い)"}`)
  return { stamped: true, differences }
}
