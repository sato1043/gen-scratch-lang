/**
 * 綴りが重なったブロックを、引数の形とカテゴリの明示で分ける。
 *
 * Scratch の日本語ラベルには、別のブロックどうしで同じ綴りになる組がある。解析器は綴り
 * だけを見るので組の一方しか返せず、返らなかった側は記法から書けない。ここが持つのは
 * **解析器が返した識別子を、綴りの外にある手掛かりで読み替える規則**である。
 *
 * 台帳の例外表（`catalog/exceptions.ts`）とは層が違う。向こうは台帳を組むときに上流の
 * 定義から導けないものを補い、こちらは組み上がった台帳を引く前に識別子を決め直す。
 *
 * 読み替えは解析の直後に当てる。図も .sb3 も同じ中間表現から導くので、1 か所で両方が
 * 揃う。生成の側だけで読み替えると、図が元のカテゴリの色で残って食い違う。
 *
 * **重なりのすべてがここで解けるわけではない。** 手掛かりが綴りの中にも外にも無い組は
 * 残る。どれが残るかは検出器（`labelCollisions`）が測り、「覆わない範囲」に出る。
 */
import { loadCatalog } from "./catalog.ts"

/** 数学の関数の選択肢を持つ引数の名前 */
const MATH_OPERATOR_FIELD = "OPERATOR"

/** 数学の関数を持つブロックの識別子。選択肢はこの項目から引く */
const MATH_IDENTIFIER = "OPERATORS_MATHOP"

/**
 * 解析器が返すブロックのうち、読み替えが読む欄。
 *
 * scratchblocks は型を持たないので、触る欄だけを述べる。全体を `any` で受けると、欄の
 * 綴りを間違えても黙って undefined になる。
 */
type ParsedBlock = {
  info?: { id?: string; category?: string; categoryIsDefault?: boolean }
  children?: ParsedChild[]
}

/** 解析器が返すブロックの子。引数と、綴りの中のラベルが混ざって並ぶ */
type ParsedChild = {
  isInput?: boolean
  isBlock?: boolean
  shape?: string
  value?: unknown
}

/**
 * 綴りの重なりを解く規則 1 つ分。
 */
type Rule = {
  /** 解析器が返す識別子 */
  from: string
  /** 読み替える先の識別子 */
  to: string
  /** 読み替えた後のカテゴリ。図の色がこれで決まる */
  category: string
  /** 読み替えるかを決める。真を返したときだけ読み替える */
  applies: (block: ParsedBlock) => boolean
  /** なぜこの手掛かりで分けられるか */
  reason: string
}

const RULES: Rule[] = [
  {
    from: "SENSING_OF",
    to: MATH_IDENTIFIER,
    category: "operators",
    applies: block => {
      const slots = slotsOf(block)
      if (slots.length !== 2) return false
      const [head, tail] = slots
      // 第 1 位置が選択肢なら、書かれているのは属性の取得である。数学の関数は数を受ける
      if (isMenu(head)) return false
      // 末尾が数学の関数の名でなければ、書きたかったのは属性の取得である。選択肢と同じ
      // 名前のスプライトを持つ作品を巻き込まないよう、名でも照合する
      return isMenu(tail) && mathOperators().has(String(tail.value))
    },
    reason:
      "「%2 の %1」を sensing_of と operator_mathop が共有する。解析器は sensing_of を" +
      "選ぶ。属性の取得は第 1 位置に**対象**の選択肢を取り（日本語は「対象 の 属性」の" +
      "順）、数学の関数は数を取るので、第 1 位置の形と末尾の名の 2 つで分かれる",
  },
  {
    from: "OPERATORS_LENGTH",
    to: "DATA_LENGTHOFLIST",
    category: "list",
    applies: block => {
      const slots = slotsOf(block)
      return slots.length === 1 && isMenu(slots[0])
    },
    reason:
      "「%1 の長さ」を operator_length と data_lengthoflist が共有する。解析器は " +
      "operator_length を選ぶ。文字の長さは値を取り、リストの長さはリストの名前を" +
      "選択肢で取るので、引数の形で分かれる",
  },
  {
    from: "SOUND_VOLUME",
    to: "SENSING_LOUDNESS",
    category: "sensing",
    // 引数を持たないので、綴りの中に手掛かりが無い。カテゴリの明示だけが分ける
    applies: block =>
      block.info?.categoryIsDefault === false && block.info?.category === "sensing",
    reason:
      "「音量」を sound_volume と sensing_loudness が共有する。どちらも引数を持たない" +
      "ため綴りの中に手掛かりが無い。記法のカテゴリの明示（`:: sensing`）だけが分ける",
  },
]

/**
 * ブロック 1 つに規則を当てる。当たれば識別子とカテゴリを読み替える。
 *
 * 読み替えるのは `info` の写しで、元の値は書き換えない。解析器は同じ定義の実体を複数の
 * ブロックで共有しうるので、実体を書き換えると当たっていない側まで巻き込む。
 */
export function disambiguateBlock(block: ParsedBlock): void {
  const identifier = block?.info?.id
  if (!identifier) return

  const rule = RULES.find(item => item.from === identifier && item.applies(block))
  if (!rule) return
  if (contradictsExplicitCategory(block, rule)) return

  block.info = { ...block.info, id: rule.to, category: rule.category }
}

/**
 * 記法がカテゴリを明示していて、その値が読み替え先と食い違うか。
 *
 * 引数の形は書き手が選べるが、カテゴリの明示は**どのブロックのつもりか**を直に述べる。
 * 述べてあるならそちらを優先し、食い違う読み替えを断る。
 *
 * これが無いと、読み取りが書き出した記法を組み立て直すときに opcode が変わる。読み取りは
 * カテゴリを明示して書き出すので、値の欄に入っていた文字が偶然メニューの形（末尾が ` v`）
 * を持つだけで別のブロックへ化ける（実測 2026-09-04: 外部の .sb3 が持つ文字列
 * 「ほげ v」で `operator_length` が `data_lengthoflist` になった）。
 *
 * 解析器が知らないカテゴリの綴りは既定として届く（`::data` が当たる）ので、明示として
 * 数えない。明示を名乗れるのは解析器が受け取った綴りだけである。
 */
function contradictsExplicitCategory(block: ParsedBlock, rule: Rule): boolean {
  if (block.info?.categoryIsDefault !== false) return false
  return block.info?.category !== rule.category
}

/**
 * 規則の一覧を読み取り用に返す。知識層と検査が中身を数えるために引く。
 */
export function rules(): readonly Rule[] {
  return RULES
}

/**
 * ブロックが受け取る引数を、記法での並び順に返す。
 *
 * ラベル（「の」「の長さ」）は引数でないので外す。値は入力として、変数や式は入れ子の
 * ブロックとして届くので、どちらも引数として数える。
 */
function slotsOf(block: ParsedBlock): ParsedChild[] {
  return (block.children ?? []).filter(child => child.isInput || child.isBlock)
}

/**
 * その引数が選択肢（`[... v]`）で書かれているか。
 *
 * 入れ子のブロックは形を持たないので、入力であることも併せて見る。
 *
 * **形の綴りは 2 つある。** 角括弧の `dropdown` と、丸括弧で数を受ける `number-dropdown`
 * である。後者を落とすと `((x座標 v) の [sin v])` が「選択肢でない」と読まれ、属性の取得が
 * 数学の関数へ化ける（実測 2026-09-04）。`src/serialize.ts` の `writtenAs` も同じ理由で
 * 接尾辞を見ている。
 */
function isMenu(slot: ParsedChild | undefined): boolean {
  return Boolean(slot?.isInput) && Boolean(slot?.shape?.endsWith("dropdown"))
}

/** 台帳から引いた数学の関数の選択肢。読み込みは 1 度で足りる */
let mathOps: Set<string> | null = null

/**
 * 数学の関数の選択肢を台帳から引く。
 *
 * ここへ写すと台帳と二重になり、上流が選択肢を増やしたときに黙って古びる。台帳を読めな
 * ければ空の集合を返し、読み替えは起きない ── 読み替えないことは、この変更の前の挙動で
 * ある。
 */
function mathOperators(): Set<string> {
  if (mathOps) return mathOps
  const entry = loadCatalog().byIdentifier.get(MATH_IDENTIFIER)
  const field = entry?.args?.find(arg => arg.name === MATH_OPERATOR_FIELD)
  const found = new Set(Object.keys(field?.options ?? {}))
  // 引けたときだけ覚える。空を覚えると、読めなかった 1 度がプロセスの残りすべてを縮退
  // させる（`src/env.ts` の実行環境の組み立ても成功時だけ控える）
  if (found.size > 0) mathOps = found
  return found
}
