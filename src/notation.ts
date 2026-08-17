import { markCodePoints } from "./errors.ts"

/**
 * 記法の引数の綴りを解く。
 *
 * 台帳の引数は `%n`・`%m.var` のように「前置」と「種別」でできている。前置が値の受け方を
 * 決め、種別はドロップダウンの中身を分ける。この分解を各所で書くと、`startsWith` と
 * `slice(0, 2)` が読む側 2 モジュールと作る側 1 モジュールに散り、綴りが増えたときに
 * どこが追随していないのか誰にも見えない。
 *
 * **呼び名の表は持たない。** 綴りをどう呼ぶかは読み手ごとに違う ── 台帳との突き合わせは
 * 「メニュー / 値 / 色」で分け（`serialize.ts`）、書き方の案内は
 * 「数 / 文字 / 条件 / 色 / 選択肢 / 名前」で分ける（`knowledge.ts`）。同じ対象を扱うが
 * 段階が違い、片方へ揃えると切り捨てた側の読み手が失われる。ここが持つのは分解だけで、
 * 呼び名は各読み手が持つ。
 */

/**
 * 引数の綴りが取りうる前置。
 *
 * 出典は scratchblocks 3.7.1 の記法（`%n` 数・`%s` 文字・`%b` 真偽・`%c` 色・
 * `%d` 数にドロップダウン・`%m` ドロップダウン）。ここに無い前置は未知として扱い、
 * 黙って通さない。
 */
export const PREFIXES = Object.freeze({
  BOOLEAN: "%b",
  COLOUR: "%c",
  NUMBER_MENU: "%d",
  MENU: "%m",
  NUMBER: "%n",
  STRING: "%s",
})

/** 知っている前置の一覧。許される側を数える */
const KNOWN: Set<string> = new Set(Object.values(PREFIXES))

/**
 * 綴りの前置を取り出す。知らない前置なら null を返す。
 *
 * null を返すのは、未知の綴りを黙って通さないためである。呼ぶ側が `?? 綴りそのもの` で
 * 受けると、台帳に増えた綴りがそのまま公開ドキュメントへ載る（`%x.foo` が実際に出た。
 * 2026-08-19 実測）。
 *
 */
export function prefixOf(notation: unknown): string | null {
  const head = String(notation ?? "").slice(0, 2)
  return KNOWN.has(head) ? head : null
}

/**
 * 綴りの種別（前置の後ろ）を取り出す。持たなければ null を返す。
 *
 */
export function subKindOf(notation: unknown): string | null {
  const [, kind] = String(notation ?? "").split(".", 2)
  return kind || null
}

/**
 * 綴りが指定の前置かを見る。
 *
 * `prefix` は `PREFIXES` の値。
 */
export function isKind(notation: unknown, prefix: string): boolean {
  return prefixOf(notation) === prefix
}

/**
 * 差し替えに使う目印。逆変換器へ渡す前に未知のブロックをこの綴りの呼び出しへ替え、
 * 戻ってきた記法の側で行ごとコメントへ直す。
 *
 * 逆変換器は未知の opcode を**黙って落とす**（`console` へ 1 行言うが、その口は
 * 差し替えられないので捕まえられない。2026-08-20 に実測）。落ちた後では位置が分からない
 * ため、渡す前に「逆変換器が知っている形」へ替えておくほかない。呼び出しの名前は
 * そのまま行の綴りになるので、位置と字下げが逆変換器の側で決まる。
 *
 * 綴りが利用者のブロック名と重ならないよう、記法に現れない括弧で囲む。
 */
export const SENTINEL_OPEN = "\u27ea"
export const SENTINEL_CLOSE = "\u27eb"

/**
 * 印の括弧の対。入力に現れたら、印そのものへ変えて名乗れなくする。
 *
 * 印は綴りでしか守られていない。正当な独自ブロックの呼び出しへ同じ綴りを書くだけで、
 * 読み取りの経路が本物の印と同じコメントへ直してしまう ── 読めているブロックが
 * 「読み取れない」と申告され、その存在は記法から消える（CP6 で実測）。
 *
 * **1 回の走査で対の両方を見る。** 順に置換すると取り違える ── 開き括弧を印へ変えた
 * 結果には閉じ括弧が含まれるので、続けて閉じ括弧を置換すると、いま作った印の末尾まで
 * 巻き込む。
 */
const SENTINELS = new RegExp(`[${SENTINEL_OPEN}${SENTINEL_CLOSE}]`, "gu")

/**
 * 符号位置を綴った印。戻す側が読む形。
 *
 * `+` は文字クラスで書く。逃がしのバックスラッシュは、この環境では書き込む経路によって
 * 1 段消えることがあり、消えると `+` が量詞になって黙って何も戻さなくなる（実測）。
 */
const MARKED = new RegExp(
  `${SENTINEL_OPEN}U[+]([0-9A-F]{4,6})${SENTINEL_CLOSE}`,
  "gu",
)

/**
 * こちらの言葉であることを示す綴りにする。
 *
 * 作品が名乗った綴りと、こちらが補った綴りは、読み手から見分けが付かなければならない。
 * 印の括弧で囲めば見分けが付く ── `spelled` が入力からこの括弧を必ず印へ変えるので、
 * 作品の側からは名乗れない綴りになる。
 *
 * 丸括弧で書いていたころは名乗れた（`(opcode が無い)` という opcode を持つ .sb3 を
 * 作れる）。守りが立ってから初めて、括弧を「こちらの言葉」の印として使える。
 *
 */
export function ours(word: string): string {
  return `${SENTINEL_OPEN}${word}${SENTINEL_CLOSE}`
}

/** 符号位置 1 つを、こちらの印の綴りにする */
const ourMark = (hex: string) => ours(`U+${hex}`)

/**
 * 入力に由来する綴りを、記法へ載せられる形にする。
 *
 * 2 つを同じ印へ変える ── 印の括弧と、記法へ生のままでは載せられない符号位置である。
 *
 * **印の括弧**は記法の側で予約した綴りである。作品が名乗れる場所（独自ブロックの名前・
 * 欄の値・入力に書いた値と名前・ターゲットの名前・宣言の名前）すべてに掛ける。掛けそこ
 * ねた場所が 1 つでもあると、そこから偽の印を立てられる。掛ける場所を数えるのは拒否
 * リストであり、次に増えた場所が漏れる。せめて 1 か所で綴りを決め、掛ける場所を名指しで
 * 呼ぶ側へ集める。
 *
 * **制御文字**は 2 方向に壊れる。逆変換器は改行とタブを黙って落とすので、記法は `スア`
 * を名乗り、作品定義は改行を挟んだままの名前を宣言する。NUL と双方向制御は逆に素通し
 * するので、生の制御文字がそのまま記法へ入り、`grep` も `git diff` もその生成物を
 * バイナリと判定して中身を読まなくなる。
 *
 * **落とさず印へ変えるので、`restored` が解けば元へ戻る。** 変えたことも綴りに残るため、
 * 黙って落ちも変わりもしない。
 *
 * **綴りに `<` を使わない。** 記法では真偽ブロックの開始として読まれるため、丸括弧の
 * レポーター（`(スコア)` のように変数を値として読む形）の中に置くとパースが崩れ、
 * `もし〜なら` の対応まで壊れる。申告の側の綴り（`<U+000A>`）をそのまま記法へ載せて
 * いたころは、変数名に改行が 1 つあるだけで往復が成立しなかった（TASK0016 で実測）。
 *
 * **名前と値を分けない。** 記法へ載る綴りである点で 2 つは同じで、ここで分けても綴りが
 * 揃うだけである。区別が要るのは戻す側で、そちらは名前を宣言と突き合わせるために印の
 * まま扱い、値だけを符号位置へ戻す。
 *
 * 文字列ならば載せられる綴りを返す。それ以外はそのまま返す。
 */
export function spelled(text: any): any {
  if (typeof text !== "string") return text
  return markCodePoints(markCodePoints(text, ourMark, SENTINELS), ourMark)
}

/**
 * 印が指せる符号位置か。
 *
 * `spelled` が作る印は必ずここへ収まるが、**記法と作品定義は人も書く**。桁が合って
 * いるだけの綴り（`⟪U+110000⟫`・`⟪U+D800⟫`）は書けてしまうので、復す前に判定する。
 *
 * 上限を超えると `String.fromCodePoint` が投げ、入力の誤りが「こちらの落ち度である」
 * という申告に化ける。孤立サロゲートは逆に投げず、不正な UTF-16 が .sb3 へ入る
 * （どちらも CP6 で実測）。投げる側と黙る側で扱いが割れないよう、同じ 1 か所で見る。
 *
 */
function withinUnicode(code: number): boolean {
  return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
}

/**
 * 記法へ載せた印を、元の符号位置へ戻す。
 *
 * `spelled` の逆である。**印の括弧そのものも同じ形で戻る** ── 括弧を先に印へ変えて
 * から符号位置を印へ変えているので、出来上がった綴りに現れる括弧はすべてこちらが
 * 作ったものになり、戻し方が 1 通りに決まる。作品が元から `⟪U+000A⟫` と書いていた
 * 場合も、その括弧は印へ変わっているため改行とは取り違えない。
 *
 * **指せない符号位置の印はそのまま残す。** 落とすと「何かが在った」ことまで消え、
 * 投げると入力の誤りをこちらの落ち度として申告することになる。残った印は
 * `unrestorable` が挙げ、呼ぶ側が入力の誤りとして申告する。
 *
 */
export function restored(text: string): string {
  return text.replace(MARKED, (whole, hex) => {
    const code = Number.parseInt(hex, 16)
    return withinUnicode(code) ? String.fromCodePoint(code) : whole
  })
}

/**
 * 記法 1 本を、図へ描ける正規の綴りへ揃える。
 *
 * 印を一度復してから掛け直す。手で書いた印（`⟪U+0041⟫`）は印の要らない文字へ戻り、
 * 生の制御文字は印になる。**図と .sb3 が同じものを指すようになる** ── 図はこの綴りを
 * 描き、`build` は同じ記法から復した実体を .sb3 へ入れるので、図の綴りを復せば .sb3 の
 * 値と一致する。掛けないと、手書きの `⟪U+0041⟫` が図では印のまま・.sb3 では `A` にな
 * り、同じ記法から出た 2 つが食い違った（CP6 で実測）。
 *
 * **行区切りと字下げは保つ。** 記法は行と字下げが構造を持つので、丸ごと掛けると改行
 * まで印へ変わって 1 行に潰れる。
 *
 */
export function normalized(code: string): string {
  return code
    .split("\n")
    .map(line => {
      const indent = line.length - line.trimStart().length
      return line.slice(0, indent) + spelled(restored(line.slice(indent)))
    })
    .join("\n")
}

/**
 * 復せない印を挙げる。呼ぶ側が申告に使う。
 *
 * 戻りは綴りそのもの（`⟪U+110000⟫` の形）。
 */
export function unrestorable(text: string): string[] {
  return [...text.matchAll(MARKED)]
    .filter(match => !withinUnicode(Number.parseInt(match[1], 16)))
    .map(match => match[0])
}
