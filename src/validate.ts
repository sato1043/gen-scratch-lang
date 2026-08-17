/**
 * 生成物を Scratch 公式の検証器へ通す。
 *
 * 検証器（`scratch-parser`）は Scratch 本体が作品の読み込みに使う実装である。独自の
 * 検証器を書くより、これを通す方が「Scratch で開けるか」に近い。ただし構造しか見ない。
 * 素材の欠落と実在しない opcode は通すため、安全網の主力には数えない（守備範囲を壊した
 * 入力で測った表は `test/sb3.test.ts` にある）。
 *
 * 呼び出しはテストの中に 2 か所あった。出荷経路（`build` の出口）と自動テストが同じ
 * 関数を通るよう、ここへ 1 つに集める。別々に書くと、テストで通ったものが出荷では
 * 別の呼び方をされ、テストの緑が出荷の緑を意味しなくなる。
 */
import { createRequire } from "node:module"
import { clip, reasonOf } from "./errors.ts"
import { acceptArchive } from "./intake.ts"

const require = createRequire(import.meta.url)
const validate = require("scratch-parser")

/**
 * 理由に載せる schema 違反の件数の上限。1 か所の誤りから何件も出るため、
 * 全件並べると読めなくなる。
 *
 * 端末へ流す申告の上限である。成果物（要約）は後から開いて読むものなので、同じ枠で
 * 切ると読み手が「続きを見る手段が無い」状態になる ── そちらは `FILE_ITEMS` を使う
 * （TASK0015 の CP6 が指摘）。
 */
const REASON_ITEMS = 5

/**
 * 成果物へ載せる違反の件数の上限。
 *
 * 端末の枠（5 件）の 4 倍に置く。端末は流れて消えるので少なく、ファイルは戻って読める
 * ので多くしてよい。それでも上限は要る ── 件数を決めるのは相手側だからである。
 */
const FILE_ITEMS = REASON_ITEMS * 4

/** 理由 1 件の長さの上限（端末向け） */
const REASON_LENGTH = 200

/** 理由 1 件の長さの上限（成果物向け）。端末の枠の 4 倍 */
const FILE_LENGTH = REASON_LENGTH * 4

/**
 * 検証器の理由に添える前置き。
 *
 * 検証器の文言は英語の schema 診断（`.targets[1].direction: should be number`）である。
 * 日本語の成果物へ素で入ると、読み手には何の一覧なのかが分からない（TASK0015 の CP6 が
 * 指摘）。
 *
 * **訳さない。** 訳すと上流の文言で検索できなくなり、Scratch の schema を当たる道が
 * 閉じる。代わりに、何を見ているのかを日本語で述べてから原文を並べる。場所
 * （`.targets[…]`）は JSON の道筋であって英語の散文ではないので、そのまま残す。
 */
export const REFUSAL_LEAD = "検証器が返した診断（Scratch の形式の決まりに合わない箇所）:"

/**
 * 違反 1 件を場所と診断に分けて切り詰める長さ。端末の枠（`REASON_LENGTH`）から割る。
 * 成果物の枠へは `split` が同じ割合で広げて渡す。
 *
 * まとめて 1 つの上限で切ると、場所（`dataPath`）が長い作品で診断部が丸ごと消える。
 * 実測（2026-08-19・scratch-parser 6.0.1）は場所が最長 37 文字・診断が最長 44 文字だった。
 * 診断は検証器の定型文なので実測の 2 倍を確保すれば足り、残りを場所へ回す。場所の枠を
 * 厚くするのは、作品が付けた名前が入るぶん伸びる側だからである。
 */
const REASON_DETAIL = 88
const REASON_PLACE = REASON_LENGTH - REASON_DETAIL - ": ".length

/**
 * 枠の広さに応じて、場所と診断の取り分を割る。
 *
 * 端末の枠（200）では上の実測値をそのまま返す。成果物の枠（800）では同じ割合のまま
 * 4 倍に広がる ── 割合を 1 つに決めて両方へ通す。広げないと、成果物でも端末と同じ
 * 200 桁で切れる（2026-08-22 実測。`FILE_LENGTH` が主経路で効いていなかった）。
 *
 * `length` は理由 1 件に許す長さ。
 */
function split(length: number): { place: number; detail: number } {
  const detail = Math.round((length * REASON_DETAIL) / REASON_LENGTH)
  return { place: length - detail - ": ".length, detail }
}

export type Problem = {
  kind: string
  subject: string
  detail?: string
  /** 成果物へ載せる理由。端末より広い枠で作る */
  full?: string
  /**
   * 入口で受け取りを拒んだものか。読み切れなかった箇所と区別して数えるために使う。
   * 種類の綴りで見分けると、綴りを変えた瞬間に黙って戻る
   */
  refusal?: boolean
  /** 受け入れ検査（資源の上限）の拒否か。逃げ道で降ろさない */
  intake?: boolean
}

/**
 * 検証器へ通す。.sb3（zip）と project.json のどちらのバイト列も受ける
 * （どちらも通ることを実測してある）。
 *
 * 渡す前に受け入れ検査を通す。検証器は自分で zip を開いて project.json を展開するので、
 * こちらが量を握れない。上限を `openSb3` の内側にだけ置いていた頃は、同じ .sb3 をこちらへ
 * 先に渡すだけで上限を迂回できた（生 1.4 MB・展開後 216 MB の .sb3 が 2271 ms・
 * RSS +676 MB を費やして通った。2026-08-20 実測）。
 *
 * `subject` は報告に出す対象の名。通れば空の配列を返す。
 */
export function officialProblems(bytes: Buffer, subject: string): Promise<Problem[]> {
  // 受け入れ検査は上限として使えない値で投げる。ここから素の例外が抜けると、呼ぶ側
  // （`build` の出口）に受け口が無く、スタックトレースがそのまま出る。このモジュールが
  // 「検証の失敗を報告する代わりに落ちる」ことを避けている理由と同じ
  let refused
  try {
    refused = acceptArchive(bytes, subject)
  } catch (error) {
    return Promise.resolve([
      {
        kind: "受け入れ検査を通せない",
        subject,
        detail: reasonOf(error),
        refusal: true,
        intake: true,
      },
    ])
  }
  // 受け入れ検査の拒否には印を付ける。逃げ道の旗はこれを降ろしてはならない ── 旗は
  // schema の判定を申告へ降ろすためのもので、資源の上限を外すためのものではない。
  // 種類の綴りで見分ける形は取らない。綴りを変えた瞬間に黙って戻る
  if (refused.length > 0) {
    return Promise.resolve(
      refused.map(problem => ({ ...problem, refusal: true, intake: true })),
    )
  }

  return new Promise(resolve => {
    validate(bytes, false, (error: unknown) => {
      if (!error) return resolve([])
      resolve([
        {
          kind: "公式検証器が弾いた",
          subject,
          detail: refusalReason(error),
          // 成果物は後から開いて読むので、端末より広い枠で作った理由も持たせる。
          // 端末向けの切り詰めをそのまま継ぐと、読み手に続きを見る手段が無い
          full: refusalReason(error, { items: FILE_ITEMS, length: FILE_LENGTH }),
          refusal: true,
        },
      ])
    })
  })
}

/**
 * 検証器が渡してきた値から、読める理由を組み立てる。
 *
 * 値の型は 2 通りある（2026-08-18 実測・scratch-parser 6.0.1）。zip や JSON として
 * 読めない入力では素の文字列が来る。schema に反する入力では
 * `{ validationError, sb2Errors, sb3Errors }` が来る。
 *
 * `sb2Errors` は載せない。sb3 の作品を渡しても「objName が無い」が必ず出るため、
 * 本当の原因（`sb3Errors` の側）を埋もれさせる。
 *
 * この 2 通りは 6.0.1 で測った形であり、依存は `^6.0.1` なので 6.x の更新は自動で
 * 入る。形が変わっても落ちないよう、最後は文字にできない値まで受け止める。ここで
 * 例外を投げると、投げる場所が検証器のコールバックの中なので `officialProblems` の
 * promise が解決も棄却もされず、検証の失敗を報告する代わりに固まる。
 *
 * 投げられたもの全般から理由を取るのは `errors.ts` の `reasonOf` が担う。こちらは
 * 公式検証器が返す形だけを解く。名前で選び分けられるよう、役割を名に出す。
 *
 */
export function refusalReason(
  error: unknown,
  { items = REASON_ITEMS, length = REASON_LENGTH }: { items?: number; length?: number } = {},
): string {
  if (typeof error === "string") return clip(error, length)

  const listed = error !== null && typeof error === "object"
    ? (error as { sb3Errors?: unknown }).sb3Errors
    : null
  const details = Array.isArray(listed) ? listed : null
  if (details && details.length > 0) {
    const lines = readableLines(details, split(length))
    const shown = lines.slice(0, items)
    // 畳んだ数と枠に入りきらなかった数を分ける。1 つの「ほか N 件」へ混ぜると、
    // 検証器が実際に何件返したのかを後から知る手立てが消える
    const notes = []
    if (lines.length > shown.length) notes.push(`ほか ${lines.length - shown.length} 行`)
    if (details.length > lines.length) {
      notes.push(`重なりで畳んだ ${details.length - lines.length} 件`)
    }
    return [...shown, ...notes].join(" / ")
  }

  const reported = error !== null && typeof error === "object"
    ? (error as { validationError?: unknown }).validationError
    : null
  if (typeof reported === "string") {
    return clip(reported, length)
  }
  if (error instanceof Error) {
    return clip(`${error.name}: ${error.message}`, length)
  }
  return safeText(error, length)
}

/**
 * 検証器が並べた違反を、読める理由の行にする。
 *
 * 検証器は 1 つの誤りから複数の違反を出す。同じ場所へ同じことを 2 度言う行と、
 * 「どの形にも当てはまらない」としか言わない `oneOf` の行が枠を占め、本当の原因が
 * 「ほか N 件」へ押し出される（2026-08-19 実測。opcode を 1 つ落とした .sb3 で
 * 5 件中 4 件が重複と `oneOf` だった）。
 *
 * `oneOf` の行も、場所を名指す行がほかに無ければ唯一の手掛かりになる。落とすのは
 * 名指す行が別に残るときだけにする。
 *
 * `details` は検証器の `sb3Errors`、`frame` は場所と診断の取り分。
 */
function readableLines(
  details: unknown[],
  frame: { place: number; detail: number } = split(REASON_LENGTH),
): string[] {
  const rows: { place: string; detail: string; vague: boolean; named: boolean }[] = []
  const seen = new Set()
  for (const item of details) {
    // 要素が object とは限らない。ここで投げると検証器のコールバックの中で投げることになり、
    // 上の promise が解決も棄却もされないまま固まる（このモジュールが避けている事態そのもの）
    // 要素の形は上流の版で変わりうる。欄が無ければ空として読む
    const detail = item as { dataPath?: unknown, message?: unknown, keyword?: unknown } | null
    const where = String(detail?.dataPath ?? "")
    const what = String(detail?.message ?? "")

    // 重なりは切り詰める前の綴りで見る。切り詰めた後で見ると、頭が同じで違う場所を指す
    // 違反どうしが 1 件へ潰れる（共有する前置きが枠を超えると起きる）。2 つを繋いだ
    // 文字列でなく配列を綴るのは、区切りに使った文字が値の側に現れても混ざらないため
    const key = JSON.stringify([where, what])
    if (seen.has(key)) continue
    seen.add(key)

    rows.push({
      place: where === "" ? "(最上位)" : clip(where, frame.place),
      detail: what === "" ? "(理由が読めない)" : clip(what, frame.detail),
      // 上流の表示文字列でなく種別で見る。文言は版で変わるが種別は schema の語彙である
      vague: detail?.keyword === "oneOf",
      named: where !== "",
    })
  }

  const solid = rows.some(row => row.named && !row.vague)
  return (solid ? rows.filter(row => !row.vague) : rows).map(row => `${row.place}: ${row.detail}`)
}

/**
 * 未知の形を文字にする。文字にできない値でも投げない。
 *
 * 枠は呼ぶ側から受け取る。ここだけ端末の枠を焼き付けていたので、成果物向けに広げた
 * 呼び出しでもこの分岐だけが端末の幅で切れていた（CP6 の指摘。CP5 で直した
 * `readableLines` と同型の残り）。
 *
 * `length` は理由に許す長さ。
 */
function safeText(error: unknown, length: number = REASON_LENGTH): string {
  try {
    const shown = JSON.stringify(error)
    // 関数と undefined では `JSON.stringify` が undefined を返す
    if (typeof shown === "string") return clip(shown, length)
    return clip(String(error), length)
  } catch {
    // 循環参照と BigInt は JSON にできず、Symbol は文字列にできない。理由を諦めても
    // 「弾かれた」ことは伝わる方を採る
    return `(理由を文字にできない: ${typeof error})`
  }
}
