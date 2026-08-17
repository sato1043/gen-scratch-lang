/**
 * 誤りを伝えるための部品を集める。
 *
 * 止まったことを告げる文と、そこから戻るためのコマンドは、どちらも「誤りの伝え方」の
 * 一部である。入口ごとに書くと、書き方が入口の数だけ分かれる。
 *
 * 標準出力・標準エラーへ書くのはこのモジュールだけとする。書く入口が散っていると、
 * 中和のような「全部に掛かっていないと意味の無い手当て」が入口を増やすたびに抜ける。
 * この決まりは `test/errors.test.ts` が走査して見張る。
 */
import { isAbsolute, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * 申告へ載せられる符号位置。文字・記号・数・区切り・空白だけを通す。
 *
 * 許される側を数える。危ない文字を数え上げる形にすると書き手の語彙を先回りできず、
 * 素通りに気づくのは仕込まれた後になる。Unicode の一般カテゴリは 7 つしか無いので、
 * 通す側（L 文字・M 結合・N 数・P 区切り・S 記号・Z 空白）を挙げれば数え切れる。
 *
 * 落ちるのは「その他（C）」── 制御文字・書式指定・私用領域・未割り当てである。ANSI の
 * エスケープ列（C0 制御）と、表示順を覆す双方向制御（書式指定）がここに入る。記法ファイルへ
 * 仕込むと申告の一覧を隠せる（2026-08-19 実測）。絵文字の結合子も書式指定なので印へ変わるが、
 * 診断としてはその方が正しい ── 見えない文字が名前に入っていることが読める。
 *
 * 空白は `\p{Zs}`（間隔）だけを通す。`\p{Z}` を丸ごと通すと行区切り（U+2028）と段落区切り
 * （U+2029）が混じり、改行を印へ変えた意味が消える ── 端末や下流の道具がそこで行を割れば、
 * 申告の行を偽装できる（CP6 で 5 観点が独立に指摘）。
 */
const SHOWABLE = /[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/gu

/**
 * 符号位置を印へ変える。**どれを印にするかの判定はここが唯一の出典である。**
 *
 * 綴りだけを呼ぶ側に選ばせる。申告は端末へ出すだけなので `<U+000A>` で足りるが、記法
 * へ載せる綴りは `<` を含められない ── 記法では真偽ブロックの開始として読まれ、丸
 * 括弧のレポーターの中に置くとパースが崩れる（TASK0016 で実測）。用途で綴りが割れて
 * も、判定が割れなければ「次に増えた区分がどちらかで漏れる」ことは起きない。
 *
 * 見る対象も選べる。既定は載せられない符号位置（`SHOWABLE`）で、記法の側は印の括弧も
 * 同じ形へ変えるために自前の対象を渡す。
 *
 * `spell` は符号位置 1 つを綴る。`pattern` は印へ変える対象で、省略すると申告へ
 * 載せられない符号位置。
 */
export function markCodePoints(
  value: unknown,
  spell: (hex: string) => string,
  pattern: RegExp = SHOWABLE,
): string {
  return textOf(value).replace(pattern, character =>
    spell(
      (character.codePointAt(0) ?? 0)
        .toString(16)
        .toUpperCase()
        .padStart(4, "0"),
    ),
  )
}

/**
 * 外から来た値を、申告へ載せられる綴りにする。
 *
 * 落とさずに符号位置を見せるのは、消すと「何かが在った」ことまで消えるためである。
 *
 */
export function neutralize(value: unknown): string {
  return markCodePoints(value, hex => `<U+${hex}>`)
}

/**
 * 値を文字にする。文字にできない値でも投げない。
 *
 * `String()` は Symbol と原型を持たないオブジェクトで投げる。中和は申告の唯一の入口なので、
 * ここで投げると申告そのものが出せなくなる ── 誤りを伝える経路が誤りで止まる。
 *
 */
function textOf(value: unknown): string {
  try {
    return String(value)
  } catch {
    return `(文字にできない: ${typeof value})`
  }
}

/**
 * 申告を書く。標準エラーへ出す。
 *
 * テンプレートとして呼ぶ（``announce`古い: ${path}\n` ``）。地の文はそのまま通し、
 * 埋め込んだ値だけを中和する。値を中和するかどうかを呼ぶ側に選ばせないので、入口を
 * 増やしても中和が抜けない。
 *
 * `parts` は地の文、`values` は埋め込む値で、外から来たものとして扱う。
 */
export function announce(parts: TemplateStringsArray, ...values: unknown[]): void {
  process.stderr.write(join(parts, values))
}

/**
 * 結果を書く。標準出力へ出す。中和の扱いは `announce` と同じ。
 *
 */
export function report(parts: TemplateStringsArray, ...values: unknown[]): void {
  process.stdout.write(join(parts, values))
}

/**
 * 地の文と中和した値を交互に繋ぐ。
 *
 */
function join(parts: TemplateStringsArray, values: unknown[]): string {
  let out = ""
  for (const [index, part] of parts.entries()) {
    out += part
    if (index < values.length) out += clip(neutralize(values[index]), EMBEDDED_LIMIT)
  }
  return out
}

/**
 * 申告へ埋める値 1 つの長さの上限。
 *
 * 上限が無いと、台帳を丸ごと載せた申告が 5 万字を超える（CP6 で実測）。中和は 1 文字を
 * 最大 8 文字の印へ変えるので、膨らむ側でもある。`validate.ts` は既に切り詰めており、
 * 同じ規律を申告の入口へも通す。
 *
 * 200 文字は `validate.ts` の理由 1 件の上限と同じにした。読める長さの目安を 2 つに
 * 割らないためで、片方だけを動かすと同じ申告の中で切れ方が変わる。
 */
const EMBEDDED_LIMIT = 200

/**
 * 使い方の記述を書く。中身を中和しない。
 *
 * 使い方は開発者が書いた定型で、改行と字下げが意味を持つ。中和すると改行まで印へ変わる。
 * 外から来た値を混ぜて渡さない ── 混ぜるなら `announce` を使う。
 *
 */
export function announceUsage(text: string): void {
  process.stderr.write(text)
}

/**
 * 使い方の記述を、求められて出すときに書く。標準出力へ出す。
 *
 * `--help` は誤りでなく求めに応じた出力である。標準エラーへ出すと `| less` や
 * `> usage.txt` が空になり、読もうとした人の手元に何も残らない（2026-08-22 実測）。
 * 止まったときに添える使い方は誤りの一部なので `announceUsage` のままにする ── 出す先で
 * 「求めて出した」と「止まって出した」を分ける。
 *
 */
export function reportUsage(text: string): void {
  process.stdout.write(text)
}

export type Problem = {
  /** 申告の名 */
  kind: string
  /** 何について言っているか */
  subject: string
  /** 直し方や理由。持つものだけ添える */
  detail?: string
  /** 成果物へ載せる理由。端末より広い枠で作る（`validate.ts`）*/
  full?: string
  /**
   * 入口で受け取りを拒んだものか（`validate.ts` が付ける）。
   * 逃げ道はこれを見て降ろす
   */
  refusal?: boolean
  /** 受け入れ検査（資源の上限）の拒否か。逃げ道で降ろさない */
  intake?: boolean
  /** 台帳由来の申告か（`catalog.ts` が付ける）*/
  catalog?: boolean
}

/**
 * 1 度に並べる申告の件数の上限。
 *
 * 現象から導く。申告 1 件は約 120 バイト・2 行である（2026-08-22 実測。台帳に無い
 * ブロックを 5,000 件持つ入力で stderr が 602,900 バイト・10,002 行になった）。件数を
 * 決めるのは攻撃者側で、こちらは受け取るだけなので、上限が無いと出力の大きさも相手が
 * 決める。
 *
 * 線は約 60 KB・1,000 行へ置く。既定の端末のスクロールバックが 1,000 行前後で、そこに
 * 収まれば読み手は先頭の件数の行まで遡れる。Scratch のエディタで組む作品はブロックが
 * 数十〜数百なので（`FIGURE_LIMIT` の実測）、正当な入力の申告が切られることはまず無い。
 *
 * 切っても総数は失わない。件数は呼ぶ側が先に出しており、ここでも切った件数を告げる。
 */
const PROBLEM_LIMIT = 500

/**
 * 問題の一覧を申告する。名・対象・説明の 3 つに分けて受け取り、並べ方はここが持つ。
 *
 * 上限を超えた分は出さずに件数だけ告げる。黙って切ると、読み手には一覧が全部に見える。
 *
 */
export function announceProblems(problems: Problem[]): void {
  for (const { kind, subject, detail } of problems.slice(0, PROBLEM_LIMIT)) {
    announce`  ${kind}: ${subject}\n`
    for (const line of linesOf(detail)) announce`    ${line}\n`
  }
  const withheld = problems.length - PROBLEM_LIMIT
  if (withheld > 0) {
    announce`  ほか ${withheld} 件は並べない（1 度に ${PROBLEM_LIMIT} 件まで）\n`
  }
}

/**
 * 説明を行へ分ける。
 *
 * 説明は 1 行とは限らない。`yaml` は誤りの位置を「行と列＋その行＋位置を指すキャレット」の
 * 枠で返す。中和は改行を印へ変えるので、丸ごと 1 つの値として渡すと枠が 1 行へ潰れて
 * 読めなくなる（本作業で実際に潰した）。行へ分けてから渡せば、各行は中和を通りつつ枠は残る。
 *
 * 埋め込んだ値が改行を含む場合、字下げの下に行が増える。行を増やせても字下げの外へは
 * 出られないので、申告そのものを偽装することはできない。
 *
 */
function linesOf(detail: string | undefined): string[] {
  if (!detail) return []
  const lines = String(detail).split(/\r\n?|\n/)
  // 末尾の空行は落とす。枠の最後の改行がそのまま空の字下げ行になる
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * 復帰コマンドを申告する。写して打てないときは、その断りも添える。
 *
 * `label` は何をする手かを述べる前置き、`command` は打つコマンド（置き場を除く）、
 * `flag` は置き場を渡す旗、`value` は渡された置き場。
 */
export function announceRerun(
  label: string,
  command: string,
  flag: string,
  value?: string,
): void {
  const line = rerun(command, flag, value)
  announce`${label}: ${line.command}\n`
  if (line.note) announce`  ${line.note}\n`
}

/**
 * 投げられたものから、報告に載せる理由を取り出す。
 *
 * catch が受け取るのは Error とは限らない。文字列も、素のオブジェクトも投げられる。
 * `message` を直に読むと、Error でないものを受け取ったときに報告へ `undefined` が出て、
 * 何が起きたかを黙って失う。
 *
 * 文字にするのは `textOf` を通す。`String()` を直に呼ぶと、Symbol や原型を持たない
 * オブジェクトを投げられたときにここが投げる ── 誤りを伝える経路が誤りで止まる。
 * `neutralize` は同じ理由で既に `textOf` を通しており、同じモジュールの中で規則が
 * 割れていた。Error の `message` も外から差し替えられるので同じ扱いにする。
 *
 * `thrown` は catch が受け取ったもの。
 */
export function reasonOf(thrown: unknown): string {
  return foldPaths(textOf(thrown instanceof Error ? thrown.message : thrown))
}

/**
 * 投げられたものを、申告の形（`Problem`）へ寄せる。
 *
 * 読み取りの経路は誤りの伝え方が 3 通りに割れている（`Problem[]` を返す・`throw` する・
 * 独自の組を返す）。読む側から見た口を 1 通りにするための部品で、投げる側の作りは変えない
 * ── `openSb3` の throw を戻り値へ変えると、往復検査（throw を期待する）まで巻き込む。
 *
 * `thrown` は catch が受け取ったもの、`kind` は申告の名、`subject` は何について
 * 言っているか。
 */
export function problemOf(thrown: unknown, kind: string, subject: string): Problem {
  return { kind, subject, detail: reasonOf(thrown) }
}

/**
 * 絶対パスらしき綴り。打った場所からの相対へ畳める候補を拾う。
 *
 * Windows のドライブ付き・POSIX の根から始まるもの・`file://` の 3 形を拾う。引用符と
 * 空白で切るのは、Node の例外文が `open 'C:\…\x'` のようにパスを引用して挟むため。
 */
const ABSOLUTE_PATH = /(?:file:\/\/\/)?(?:[A-Za-z]:[\\/]|\/)[^\s'"`]+/g

/**
 * 文中の絶対パスを、打った場所からの相対へ畳む。
 *
 * `subject` だけを畳んでも、同じ申告の `detail` が利用者名を載せる。Node の例外文は
 * パスを含むので、理由を取り出すところで畳まないと畳み損ねる（CP6 で 6 か所を実測）。
 * 畳めない綴りはそのまま返すので、パスでない文字列を巻き込んで壊すことはない。
 *
 */
function foldPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, match => shownPath(match))
}

/**
 * 申告へ載せるパスを、打った場所からの相対へ畳む。
 *
 * 既定の台帳は `import.meta.url` から引くので `file:///C:/Users/<利用者名>/…` の形を取る。
 * そのまま申告へ出すと、止まった出力を公開の Issue へ貼っただけで利用者名と
 * ディレクトリの構成が漏れる。畳んでも「どの台帳か」は失わない。
 *
 * 上へ登る形（`..` から始まる）になるときは畳まない。畳んだ方が読みにくく、そもそも
 * 打った場所の外は利用者自身が渡した綴りである。
 *
 */
export function shownPath(path: string | URL): string {
  const raw = String(path)
  try {
    const isUrl = path instanceof URL || raw.startsWith("file:")
    const full = isUrl ? fileURLToPath(path) : raw
    // 打った場所を先に試し、届かなければリポジトリからの位置で畳む。リポジトリの外を
    // 打った場所にすると前者は上へ登る形になり、畳む動機（利用者名を出さない）が最も
    // 要る場面で効かなかった（CP6 で実測）
    return within(process.cwd(), full) ?? within(REPOSITORY, full) ?? raw
  } catch {
    return raw
  }
}

/** リポジトリの根。打った場所が外でも畳めるようにするための基準 */
const REPOSITORY = fileURLToPath(new URL("../", import.meta.url))

/**
 * 基準からの相対へ畳む。上へ登る形になるなら畳まない。
 *
 */
function within(base: string, full: string): string | null {
  const near = relative(base, full)
  if (!near || near.startsWith("..") || isAbsolute(near)) return null
  // 区切りは `/` に固定する。同じ台帳を指す申告が機械ごとに違う綴りになると読み比べられない
  return near.split(sep).join("/")
}

/**
 * 改行を LF へ揃える。CRLF と単独の CR の両方を受ける。
 *
 * 追跡下のテキストは LF で持つ（`.gitattributes`）。Git for Windows の既定
 * （`autocrlf=true`）で clone すると作業ツリーが CRLF になるため、読んだ側で揃える。
 *
 * 生成物を追跡下のものと突き合わせる `--check` は 2 つある（知識層と台帳）。片方だけが
 * 揃えると、もう片方は改行の違いを「古い」と誤診したままになる（CP6 で 5 観点が指摘）。
 *
 */
export function withLf(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

/**
 * 長い綴りを切り詰める。切ったことが分かるよう印を残す。
 *
 * 印が無いと、120 文字で切れたパスが完全なパスに見える。読み手は「そこで終わっている」
 * ことを疑えず、実在しない場所を探す。
 *
 * `limit` は印を含めた長さの上限。
 */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - ELLIPSIS.length))}${ELLIPSIS}`
}

/** 切り詰めた印。1 文字で済むものを選ぶ */
const ELLIPSIS = "…"

/**
 * 復帰コマンドへ裸で置ける綴り。ここに無い文字が 1 つでもあれば引用する。
 *
 * 許される側を数える。危ない文字を数え上げる形にすると、書き手の語彙を先回りできず、
 * 素通りに気づくのは示したコマンドが別の意味で走った後になる。
 *
 * 範囲の始点は \u{0080} と綴る。ここへ生の符号位置を置くと字面では範囲が読めず、
 * 1 文字消えただけで許可が U+002D 以降へ広がって `;` や `$` が裸で通る（CP6 で実測）。
 */
const PLAIN_PATH = /^[A-Za-z0-9/._:\-\u{0080}-\u{10FFFF}]+$/u

/** 引用で囲めば守れる綴り。裸で置ける文字に、空白と Windows の区切りを足す */
const QUOTABLE_PATH = /^[A-Za-z0-9/._:\- \\\u{0080}-\u{10FFFF}]+$/u

/**
 * 復帰コマンドへ埋めるパスを、写して打てる形にする。
 *
 * 空白を含むパスを裸で並べると、示したコマンドが別の意味になる。`--dir "my docs/knowledge"`
 * を受けた申告が `--dir my docs/knowledge` を示し、打つと 2 つ目が位置引数として弾かれる
 * （2026-08-19 実測）。復帰コマンドは戻り道そのものなので、写して打てる形で出す。
 *
 * ただし二重引用符は万能でない。POSIX sh は引用の中でも `$`・`` ` ``・`\` を解き、`"` 自体は
 * 引用を閉じる。PowerShell も `$` を解く。Windows では末尾の `\` が閉じ引用符を食う。
 * 3 つの shell（POSIX sh・PowerShell・cmd）すべてで安全な単一の引用は存在しないため、
 * 守れないと分かったときは `safe` を偽で返し、呼ぶ側に断らせる。打てないものを打てると
 * 言う方が、打てないと告げるより悪い。
 *
 * 戻りは埋める綴りと、写して打てるか。
 */
export function quotedPath(path: string): { text: string; safe: boolean } {
  if (PLAIN_PATH.test(path)) return { text: path, safe: true }
  // 末尾の区切りを引用で囲むと、Windows では閉じ引用符が次の引数へ吸われる
  if (QUOTABLE_PATH.test(path) && !path.endsWith("\\")) return { text: `"${path}"`, safe: true }
  return { text: `"${path}"`, safe: false }
}

/**
 * 復帰コマンドの綴りと、写して打てないときの断り書きを組み立てる。
 *
 * 渡された置き場を反映する。既定の場所を指すコマンドを示すと、示したとおりに打っても
 * 照合した先は直らない。打てるかどうかの判定を入口ごとに書くと、入口の数だけ判定が分かれる。
 *
 * `command` は打つコマンド（置き場を除く）、`flag` は置き場を渡す旗、`value` は
 * 渡された置き場で、省略すると旗ごと落とす。
 */
export function rerun(
  command: string,
  flag: string,
  value?: string,
): { command: string; note: string | null } {
  if (value === undefined) return { command, note: null }

  const { text, safe } = quotedPath(value)
  return {
    command: `${command} ${flag} ${text}`,
    note: safe ? null : "綴りに引用を壊す文字があるため、この行はそのまま打てない",
  }
}
