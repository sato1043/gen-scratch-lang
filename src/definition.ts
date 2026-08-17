/**
 * 作品の定義（`project.yaml`）に書けるキーを 1 か所で持つ。
 *
 * 定義を検査する側（`project.ts`）と、仕様の一覧を組み立てる側（`knowledge.ts`）が
 * 同じ表から読む。既定値を組み立て側へ散らすと、書き出した仕様と実装が食い違っても
 * 検査に掛からない。キーを足すときはここだけを直せば、検査・既定値・仕様の一覧が揃う。
 */

/**
 * 定義の値が取る型。名前は問題の報告にも仕様の一覧にもそのまま出す
 */
export const TYPES = {
  文字列: (value: unknown): value is string => typeof value === "string",
  数: (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value),
  真偽: (value: unknown): value is boolean => typeof value === "boolean",
  対応: (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value),
  並び: (value: unknown): value is unknown[] => Array.isArray(value),
} satisfies Record<string, (value: unknown) => boolean>

/**
 * キーで引ける形として読めるなら、そう返す。読めなければ null。
 *
 * **並びも含む。** `Object.entries` は並びを添字の鍵で返すので、読み取りの経路は並びも
 * 歩ける。`.sb3` は容器を並びで書いた作品を持ちうる（Scratch は作らないが、細工した
 * 入力では作れる）ので、除くと守りと資源の上限がそこで空振りする ── 実際に
 * `typeof x === "object"` から並びを除く形へ寄せたとき、`guarded` の中和と
 * `inspectProject` の循環の検出が並び形で外れた（CP6 で実測）。
 *
 * 並びを除きたいときは `TYPES.対応` を使う。判定を 2 つに分けているのは、除く側と
 * 除かない側が実際に両方あるためで、名前で見分けられるようにしてある。
 */
export function asKeyed(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null
}

/**
 * 対応として読めるなら、キーで引ける形にして返す。読めなければ null。
 *
 * 判定は正典（`TYPES.対応`）へ委ねる。並びを除く規則をここで書き直すと、同じ概念の
 * 判定が 2 通りになる。`asKeyed` との違いは並びを通すかどうかだけである。
 */
export function asMapping(value: unknown): Record<string, unknown> | null {
  return TYPES.対応(value) ? value : null
}

/**
 * 型の名前で引いて確かめる。
 *
 * 名前は台帳や定義の表から `string` として来るので、`TYPES` を直に添字で引けない。
 * 引ける形へ均すのはここだけにする。無い名前で引けば従来どおり例外になる ── 名前は
 * すべて追跡下の表から来るので、無いのは書き手の誤りである
 */
export function fitsType(type: string, value: unknown): boolean {
  // 素朴に引くと原型の名前（`toString`・`constructor` 等）が関数として返り、呼べて
  // しまうので黙って真になる。表の持ち物だけを見る（`checkKeys` と同じ規則）
  if (!Object.hasOwn(TYPES, type)) {
    throw new Error(`型の名前が表に無い: ${type}`)
  }
  return (TYPES as Record<string, (value: unknown) => boolean>)[type](value)
}

/**
 * 変数の初期値と、リストの要素が取れる型。`TYPES` の名前で挙げる。
 *
 * Scratch の変数は文字・数・真偽しか持てない。対応や並びを書くと公式検証器が弾くが、
 * その申告は生成物の座標（`.targets[0].variables[…][1]`）を指すので、書き手は自分の
 * 書いた鍵へ戻れない。定義の側で見て、書いた場所で申告する。
 */
export const VALUE_TYPES: string[] = ["文字列", "数", "真偽"]

/** 変数の初期値を省略したときの値 */
export const VARIABLE_FALLBACK = 0

/**
 * リストの初期値を省略したときの値。
 *
 * 凍らせるのは、1 つの実体を複数のリストが共有するため。書き換えられると、
 * 初期値を省略した別のリストまで巻き添えで変わる。
 */
export const LIST_FALLBACK: readonly unknown[] = Object.freeze([])

/** 定義に書けるキー 1 つ分 */
export type KeySpec = {
  /** 値の取る型。`TYPES` が持つ名前 */
  type: string
  /** 何を決めるか */
  effect: string
  /** 省略したときに何が起きるか。既定値で表せないもの */
  omitted?: string
  /** 省略したときに使う値。組み立てがここから読む */
  fallback?: string | number | boolean
}

/** 最上位に書けるキー */
export const TOP_KEYS: Record<string, KeySpec> = {
  名前: {
    type: "文字列",
    effect: "作品の呼び名。生成物には現れない（Scratch 3 の project.json は作品名の欄を持たない）",
    omitted: "何も起きない",
  },
  ステージ: {
    type: "対応",
    effect: "ステージのスクリプトと宣言",
    omitted: "スクリプトも宣言も持たないステージになる",
  },
  スプライト: {
    type: "並び",
    effect: "スプライトの一覧。書いた順に重なりが決まる",
    omitted: "スプライトを持たない作品になる",
  },
}

/** ステージとスプライトに共通のキー */
export const TARGET_KEYS: Record<string, KeySpec> = {
  スクリプト: {
    type: "文字列",
    effect:
      "記法ファイルの名前。作品のディレクトリからの相対で、区切りは / で書く（外は指せない）",
    omitted: "スクリプトを持たないターゲットになる",
  },
  変数: {
    type: "対応",
    effect:
      `変数の名前と初期値の組。初期値は ${VALUE_TYPES.join(" / ")} のいずれかで、` +
      `省略すると ${VARIABLE_FALLBACK} になる`,
    omitted: "変数を宣言しない",
  },
  リスト: {
    type: "対応",
    effect:
      `リストの名前と初期値の並びの組。要素は ${VALUE_TYPES.join(" / ")} のいずれかで、` +
      `省略すると ${JSON.stringify(LIST_FALLBACK)} になる`,
    omitted: "リストを宣言しない",
  },
}

/** スプライトに書けるキー */
export const SPRITE_KEYS: Record<string, KeySpec> = {
  名前: {
    type: "文字列",
    effect: "スプライトの名前。記法から変数を引くときの持ち主になる",
    omitted: "組み立てを止める（名前は省けない）",
  },
  ...TARGET_KEYS,
  x: { type: "数", effect: "横の位置", fallback: 0 },
  y: { type: "数", effect: "縦の位置", fallback: 0 },
  表示: { type: "真偽", effect: "画面に見えるか", fallback: true },
  大きさ: { type: "数", effect: "大きさ（百分率）", fallback: 100 },
  向き: { type: "数", effect: "向き（度。90 が右）", fallback: 90 },
}

/**
 * 仕様の一覧を組み立てる単位。書ける場所ごとにキーの表を持つ。
 */
export const LEVELS: { title: string; where: string; keys: Record<string, KeySpec> }[] = [
  { title: "最上位", where: "定義そのもの", keys: TOP_KEYS },
  { title: "ステージ", where: "`ステージ` の中", keys: TARGET_KEYS },
  { title: "スプライト", where: "`スプライト` の各項目", keys: SPRITE_KEYS },
]

/**
 * 省略したときに何が起きるかを 1 つの文字列にする。
 *
 * 既定値を持つキーはその値を出す。持たないキーは `omitted` の散文を出す。両方を
 * 持たないキーは仕様の穴なので、隠さず印を返す（`--check` でなく検査が捕まえる）。
 */
export function omissionOf(spec: KeySpec): string {
  if (spec.fallback !== undefined) return `\`${JSON.stringify(spec.fallback)}\` になる`
  return spec.omitted ?? "(記述が無い)"
}
