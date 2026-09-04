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

/**
 * 素材として認める形式。公式検証器の schema の enum と同じ綴りにする。
 *
 * **認める側を挙げる。** 弾く側を挙げる形にすると、書き手が思い付いた綴り（`jpe`・
 * `wave2`）を先回りできず、素通しに気づくのは Scratch が開けない .sb3 が出た後になる。
 *
 * 写しなので古びうる。上流と一致することは検査が照合する（`test/asset.test.ts`）。
 * 出典は `node_modules/scratch-parser/lib/sb3_definitions.json` の
 * `definitions.costume.properties.dataFormat.enum` と `definitions.sound.…`。
 */
export const COSTUME_FORMATS: string[] = ["png", "svg", "jpeg", "jpg", "bmp", "gif"]
export const SOUND_FORMATS: string[] = ["wav", "wave", "mp3"]

/**
 * 中身から属性を導ける形式。
 *
 * ここに無い形式は、属性を書かなければ組み立てを止める。往復では属性が project.json から
 * 来るので導出を通らず、この一覧は往復に影響しない。
 */
export const DERIVABLE_FORMATS: string[] = ["svg", "png", "wav"]

/**
 * zip に収める素材の名前（`md5ext`）が取る形。
 *
 * 出典は公式検証器の schema（`definitions.costume.properties.md5ext.pattern` と
 * `definitions.sound.…`）。音の側が拡張子に数字を許す（`mp3`）ぶん広いので、そちらを
 * 使う ── コスチュームの形はこの部分集合になる。
 *
 * **これは書き込み先の安全を、こちらの側で持つための検査である。** 名前は project.json が
 * 名乗る値で、逃げ道（`--anyway`）を通れば検証器の判定を経ずにここへ届く。`../` を
 * 含む名前を素材のファイル名として使えば、書き出し先の外へ書くことになる。
 *
 * 今は zip の読み手（JSZip 3.10.1）が名前を正規化するため、`../` を含む名前は
 * そもそもエントリに当たらない（2026-09-04 実測。バイト列で組んだ zip でも
 * `../../../slipped.txt` は `slipped.txt` として現れた）。**依存の挙動に頼らない** ──
 * 読み手が変われば守りが消えるので、自分の側でも形を見る。
 */
export const MD5EXT = /^[a-fA-F0-9]{32}\.[a-zA-Z0-9]+$/

/**
 * `bitmapResolution` の既定値。**形式に依らず 1 である。**
 *
 * 1 度 2 へ変えて、実機で戻した（2026-09-04）。経緯を残す ── 同じ取り違えを繰り返さない
 * ため。
 *
 * scratch-vm の `load-costume.js` は、ビットマップを取り込むとき `bitmapResolution = 2` を
 * 立てる。これは事実である。**ただし同じ経路で画像を 2 倍へ拡大している**
 * （`costume.bitmapResolution === 1 ? 2 : 1` の倍率）。「2 倍に拡大する」と「解像度 2 で
 * 半分に戻す」が対になって元の大きさになる。
 *
 * **こちらは素材を拡大しない**（`素材を変換しない` は憲章から継いだ非目標）。対の片方だけを
 * 持ってくると、絵は半分の大きさで出る。48×48 の PNG と SVG を並べた作品を Scratch
 * エディタで開いて実測した ── 解像度 2 の PNG は、解像度 1 の SVG のちょうど半分だった。
 *
 * **一次情報の値は、その値が成り立つ前提ごと写す。** 前提（2 倍の拡大）を欠いたまま値だけを
 * 採ると、出典が正しくても結果は誤る。
 */
export const BITMAP_RESOLUTION_FALLBACK = 1

/**
 * SVG の `bitmapResolution`。倍率を持たないので常に 1。
 *
 * **今はビットマップ側と同じ値だが、分けたままにする。** ビットマップの既定を動かす理由
 * （Scratch の取り込みに合わせる等）は SVG に掛からない。1 つの定数を共有していると、
 * 片方の都合で動かしたときに SVG が黙って巻き添えになる（CP6 で 4 観点が指摘した形）。
 */
export const SVG_RESOLUTION = 1

/** 素材（コスチューム・音）の項に共通のキー */
export const ASSET_KEYS: Record<string, KeySpec> = {
  ファイル: {
    type: "文字列",
    effect:
      "素材のファイル名。作品のディレクトリからの相対で、区切りは / で書く（外は指せない）",
    omitted: "組み立てを止める（ファイルは省けない）",
  },
  名前: {
    type: "文字列",
    effect: "Scratch の中での呼び名。記法から名前で引くときの綴りになる",
    omitted: "ファイル名の幹を使う",
  },
}

/**
 * コスチュームの項に書けるキー。
 *
 * 属性の綴りは .sb3 のままにする。この 3 つに定訳が無く、訳語を造ると辞書でも検索でも
 * 引けない語が増えるため（読み取りの `FIELD_NAMES` が「覆っていない欄は生綴りのまま
 * 出す」と決めているのと同じ扱い）。
 */
export const COSTUME_KEYS: Record<string, KeySpec> = {
  ...ASSET_KEYS,
  bitmapResolution: {
    type: "数",
    effect: "絵の 1 単位が何画素かの倍率。2 なら絵は半分の大きさで表示される",
    omitted:
      `${BITMAP_RESOLUTION_FALLBACK} になる（素材を拡大しないので、絵は元の画素数で出る）`,
  },
  rotationCenterX: {
    type: "数",
    effect: "回転の中心の横位置。絵の画素で数える",
    omitted:
      "絵の真ん中（svg は viewBox の原点を足した値）。導けない形式では組み立てを止める",
  },
  rotationCenterY: {
    type: "数",
    effect: "回転の中心の縦位置。絵の画素で数える",
    omitted:
      "絵の真ん中（svg は viewBox の原点を足した値）。導けない形式では組み立てを止める",
  },
}

/** 音の項に書けるキー */
export const SOUND_KEYS: Record<string, KeySpec> = {
  ...ASSET_KEYS,
  rate: {
    type: "数",
    effect: "1 秒あたりのサンプル数（Hz）。サンプリングレートのこと。誤ると音程がずれる",
    omitted: "wav は中身から導く。導けない形式では組み立てを止める",
  },
  sampleCount: {
    type: "数",
    effect: "サンプルの総数。音の長さを決める。誤ると途中で切れる",
    omitted: "wav は中身から導く。導けない形式では組み立てを止める",
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
  再描画しないブロック: {
    type: "並び",
    effect:
      "実行中に画面を再描画しないブロック定義の名前。重い描画をフレーム数の縛りから" +
      "外す。記法はスクリプトしか表せないので、この指定は定義が持つ",
    omitted: "どの定義も 1 巡ごとに画面を更新する（Scratch のエディタと同じ既定）",
  },
  コスチューム: {
    type: "並び",
    effect:
      `見た目の一覧。書いた順に番号が付く。各項は ${Object.keys(COSTUME_KEYS).join(" / ")} ` +
      `を書ける対応で、形式は ${COSTUME_FORMATS.join(" / ")} のいずれか`,
    omitted: "自前の四角 1 種を持つ（Scratch の既定素材は同梱しない）",
  },
  音: {
    type: "並び",
    effect:
      `鳴らせる音の一覧。各項は ${Object.keys(SOUND_KEYS).join(" / ")} を書ける対応で、` +
      `形式は ${SOUND_FORMATS.join(" / ")} のいずれか`,
    omitted: "音を持たない",
  },
  今のコスチューム: {
    type: "数",
    effect: "はじめに見えているコスチュームの番号。1 始まりで、コスチュームの並びを数える",
    fallback: 1,
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
  { title: "コスチュームの項", where: "`コスチューム` の各項目", keys: COSTUME_KEYS },
  { title: "音の項", where: "`音` の各項目", keys: SOUND_KEYS },
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
