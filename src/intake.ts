/**
 * 外部入力を受け入れてよいかを、中身を展開する前に見る。
 *
 * 上限は「外部入力が最初に触れる場所」に置く。読み取りの経路（`openSb3`）と公式検証器へ
 * 渡す経路（`officialProblems`）は同じ .sb3 を別々に受け取るので、片方の内側に置いた上限は
 * もう片方を素通しする。通す順序を変えただけで迂回できる上限は、上限が無いのと変わらない
 * （2026-08-18 の CP6 で実測。以下は 2026-08-20 に測り直した値）。
 *
 * 下の表は本作業で塞ぐ前の値である（Node 20.19.1。`officialProblems` は Node 24.19.0 でも
 * 1798 ms・RSS +777 MB を費やして通した）。
 *
 * | 入力 | `openSb3` | `officialProblems` |
 * |---|---|---|
 * | project.json が膨らむ .sb3（生 1.4 MB → 216 MB）| 114 ms・RSS +28 MB で拒否 | 2271 ms・RSS +676 MB を費やして通す |
 * | 素材だけが膨らむ .sb3（生 197 KB → 展開後 200 MB）| 19 ms・RSS +4 MB で通す | 46 ms・RSS +2 MB で通す |
 * | エントリ 300,001 件（生 31.9 MB）| 2679 ms・RSS +364 MB で通す | 2681 ms・RSS +369 MB で通す |
 *
 * **見るのは zip のセントラルディレクトリだけで、1 バイトも展開しない。** 展開してから大きさを
 * 見る形では、その時点で資源を使い切っている。
 *
 * **申告された大きさは攻撃者が書ける。** ここで見るのは安く弾くための早期の目であって、
 * 保証ではない。実際に展開しながら打ち切る `readWithin`（`roundtrip.ts`）が最後の砦で
 * あり続ける。両方が要る ── こちらは検証器へ渡す経路のように、こちらが展開を握れない
 * 相手にも掛かる。
 *
 * **素材の展開後の総量も見る。** かつては見なかった ── どの経路もその量を払わなかった
 * ためで、「素材を読む経路を足すときに引き直す」と条件を付けてあった（2026-08-20 の裁定）。
 * TASK0025 が読み取りへ素材を展開する経路を足したので、条件どおり引き直した
 * （`ASSET_TOTAL_LIMIT`）。
 */

export type Problem = {
  kind: string
  subject: string
  detail?: string
}

/**
 * project.json の展開後の大きさの上限。
 *
 * Scratch 3.0 自身の上限に合わせる（非圧縮の project.json が 5 MB。素材は 1 件 10 MB で、
 * プロジェクト全体の上限は無い）。出典は Scratch Wiki "Project File Size" と Scratch Team の
 * 回答を含む議論（確度は二次情報。2026-08-18 参照）。
 *
 * ここを超えるものは Scratch でも開けないので弾いてよく、下回るものは正当な作品なので
 * 弾いてはならない。自分たちが生成する作品の大きさ（実測で最大 4 KB）を基準に倍率で置くと、
 * 他者の作品を弾く線になる。
 */
export const PROJECT_JSON_LIMIT = 5 * 1024 * 1024

/**
 * 素材 1 件の大きさの上限。
 *
 * 出典は project.json と同じ（Scratch Wiki "Project File Size"）。Scratch 自身が素材
 * 1 件を 10 MB までとしているので、これを超える素材を収めた .sb3 はそもそも Scratch で
 * 扱えない。自分たちの生成物の大きさを基準に倍率で置くと、Scratch が受け取る素材を
 * 弾く線になる。
 *
 * 縛るのは生成の側（利用者が定義に書いた素材を読むとき）である。読み取りの側は
 * 他人の .sb3 から来るので、`ASSET_TOTAL_LIMIT` が展開後の総量で縛る。
 */
export const ASSET_FILE_LIMIT = 10 * 1024 * 1024

/**
 * 素材の展開後の総量の上限。
 *
 * **落ちる点が無いので「実測の 1/10」では導けない。** 既存の 2 つ（エントリ数・入れ子の深さ）は
 * 落ちる点を測ってその 1/10 に置いたが、素材の展開は落ちない ── 250 KB の zip から
 * 4 GB を展開しても通り、費用は量に比例するだけだった（2026-09-04 実測・Node 24.12.0）。
 *
 * | 展開後 | 生の大きさ | 展開の時間 |
 * |---|---|---|
 * | 100 MB | 101 KB | 316 ms |
 * | 500 MB | 499 KB | 1,696 ms |
 * | 1,000 MB | 997 KB | 2,910 ms |
 * | 4,000 MB | 3,987 KB | 11,658 ms |
 *
 * 同じ 50 MB を 4 回測った散らばりは 1.31 倍（167〜218 ms）で、上の差は量の違いに読める。
 *
 * 導くのは**費用の予算**からにする。約 2.9 ms/MB なので、256 MB で約 750 ms である。
 * これはエントリ数の上限が払う費用（約 210 ms）と同じ桁で、対話的な道具として待てる。
 *
 * 正当な作品を弾かないことも見る。Scratch 自身が素材 1 件を 10 MB までとしているので、
 * この線は最大の素材 25 件ぶんに当たる。自分たちの生成物は数 KB である。
 *
 * **これは落ちるのを防ぐ線ではなく、他人の .sb3 が命じられる仕事の量を縛る線である。**
 */
export const ASSET_TOTAL_LIMIT = 256 * 1024 * 1024

/**
 * zip のエントリ数の上限。
 *
 * 現象から導く。エントリ 300,001 件の .sb3 で `JSZip.loadAsync` が 2087 ms・RSS +441 MB を
 * 費やし、読み取りと検証器の双方がその費用を払ったうえで通した（2026-08-20 実測・Node
 * 24.19.0。Node 20.19.1 では 2776 ms・RSS +368 MB）。費用はほぼ線形で、1 件あたり約 7 µs・
 * 約 1.5 KB である。
 *
 * 線はその 1/10 に置く。入れ子の深さの上限と同じ割合で揃えてあり、片方だけを別の割合で
 * 動かすと、どの検査がどれだけの余裕で通っているのかが読めなくなる。この線での費用は
 * 約 210 ms・RSS +44 MB になる。
 *
 * 正当な作品を弾かないことも見る。.sb3 のエントリは project.json 1 件と素材であり、
 * 素材が 3 万件ある作品は Scratch のエディタでは作れない。自分たちの生成物は 2〜3 件。
 */
export const ARCHIVE_ENTRY_LIMIT = 30_000

/** zip のセントラルディレクトリの終端（End of Central Directory）の目印 */
const EOCD_SIGNATURE = 0x06054b50

/** 終端の最小の長さ。注記が無いときの長さでもある */
const EOCD_MIN = 22

/** 終端に続く注記の最大の長さ。長さの欄が 2 バイトなので上限が決まる */
const COMMENT_MAX = 0xffff

/** セントラルディレクトリの 1 件ぶんのヘッダの目印 */
const CD_SIGNATURE = 0x02014b50

/** ヘッダ 1 件の最小の長さ。名前・追加欄・注記はこの後ろに続く */
const CD_MIN = 46

/**
 * ZIP64 の印。欄に収まらない値をこの値で埋め、本当の値を追加欄へ置く決まりになっている。
 *
 * 追加欄は読まない。印が立っているなら本当の値はこの印以上であり、こちらの上限
 * （project.json 5 MB）はこの印よりはるかに小さい。印をそのまま値として扱っても
 * 判定は変わらず、読む処理を増やさずに済む。
 */
const ZIP64_SIZE = 0xffffffff

/**
 * project.json を探す規則。公式検証器（`scratch-parser`）と同じ形にしてある。
 *
 * 検証器は 1 段のディレクトリを許し、当たった先頭 1 件を読む。こちらが名前の完全一致で
 * 探すと、両方を収めた zip で「検証器が見たもの」と「こちらが読むもの」が別になる。
 */
const PROJECT_JSON = /^([^/]*\/)?project\.json$/

/**
 * 上限として使えない値を止める。
 *
 * `NaN` との比較は常に false になり、`Infinity` は何も超えない。どちらも上限を黙って
 * 無効にする。守るはずの値が守らない状態は、上限が無いことより悪い。
 */
export function refuseBadLimit(limit: unknown): void {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    throw new Error(`上限の値が使えない: ${String(limit)}`)
  }
}

/**
 * 受け取ったバイト列を、開いてよいかどうか見る。
 *
 * zip でないバイト列も受ける。`officialProblems` は project.json を直に渡される経路を
 * 持っており、そちらにも量の目が要る。
 *
 * `subject` は報告に出す対象の名。戻りは受け入れてよければ空の配列。
 */
export function acceptArchive(
  bytes: Buffer,
  subject: string,
  // 既定は分割代入で与える。`??` で書くと `null` を「渡されなかった」と読み、上限として
  // 使えない値が黙って既定へ戻る
  {
    entries: entryLimit = ARCHIVE_ENTRY_LIMIT,
    projectJson: jsonLimit = PROJECT_JSON_LIMIT,
    assets: assetLimit = ASSET_TOTAL_LIMIT,
  }: { entries?: number; projectJson?: number; assets?: number } = {},
): Problem[] {
  refuseBadLimit(entryLimit)
  refuseBadLimit(jsonLimit)
  refuseBadLimit(assetLimit)

  // zip かどうかは先頭の目印でなく、セントラルディレクトリの終端が在るかで決める。目印で
  // 決めると、頭に 1 バイト足すだけでこの検査を飛び越せる ── zip の読み手は終端を
  // 後ろから探すので、頭が汚れていても開ける（2026-08-20 に実測して確かめた）
  const end = eocdAt(bytes)
  if (end < 0) {
    // zip として読めないなら、渡されたバイト列そのものが展開される量である
    if (bytes.length > jsonLimit) {
      return [
        {
          kind: "project.json が大きすぎる",
          subject,
          detail: `${bytes.length} バイトあり、上限 ${jsonLimit} バイトを超えた`,
        },
      ]
    }
    return []
  }

  // 終端が名乗る件数は見ない。読み手がそれを無視するので、見ても守備範囲にならない
  // （下の `listedSizes` に理由を書いた）
  const listed = listedSizes(bytes, end, entryLimit)
  if ("error" in listed) {
    return [{ kind: "zip として読めない", subject, detail: listed.error }]
  }
  if (listed.tooMany) {
    return [
      {
        kind: "zip のエントリが多すぎる",
        subject,
        detail: `上限 ${entryLimit} 件を超えた`,
      },
    ]
  }

  // 素材の総量も見る。project.json だけを見ていたころは、素材だけが膨らむ .sb3 が
  // 素通りした（生 197 KB → 展開後 200 MB。2026-08-20 実測）。名乗りは攻撃者が書けるので
  // これは安く弾く早期の目であり、実際に展開しながら打ち切る側（`openAssets`）が砦になる
  if (listed.assets > assetLimit) {
    const shown = listed.zip64 ? `${listed.assets} バイト以上` : `${listed.assets} バイト`
    return [
      {
        kind: "素材が大きすぎる",
        subject,
        detail: `展開後に${shown}あり、上限 ${assetLimit} バイトを超えた`,
      },
    ]
  }

  // 当たりが複数あるときは大きい方で見る。読む側がどれを選ぶかはここでは決めないので、
  // 小さい方で通すと、選ばれた方が上限を超えていても素通りする
  const largest = Math.max(0, ...listed.sizes)
  if (largest > jsonLimit) {
    const shown = listed.zip64 ? `${largest} バイト以上` : `${largest} バイト`
    return [
      {
        kind: "project.json が大きすぎる",
        subject,
        detail: `${shown}あり、上限 ${jsonLimit} バイトを超えた`,
      },
    ]
  }

  return []
}

/**
 * セントラルディレクトリの終端を探す。見つからなければ -1 を返す。
 *
 * 後ろから探す。目印だけでは足りない ── 同じ 4 バイトが中身や注記の側に現れうるので、
 * 記録が名乗る注記の長さが実際の残りと一致することも見る。
 */
function eocdAt(bytes: Buffer): number {
  const least = Math.max(0, bytes.length - EOCD_MIN - COMMENT_MAX)
  /** 注記の長さが合わなかった当たり。読み手が拾う側の候補として控える */
  let loose = -1

  for (let at = bytes.length - EOCD_MIN; at >= least; at -= 1) {
    if (bytes.readUInt32LE(at) !== EOCD_SIGNATURE) continue
    // 注記の長さが実際の残りと合う当たりを最良とする。目印は中身にも現れうるので、
    // 合うことが「本物の終端」の手掛かりになる
    if (bytes.readUInt16LE(at + 20) === bytes.length - at - EOCD_MIN) return at
    if (loose < 0) loose = at
  }

  // 合う当たりが無くても諦めない。**読み手（JSZip 3.10.1）は長さの一致を求めない**ので、
  // ここで諦めると読み手が開ける zip を「zip でない」と読み、上限が丸ごと外れる。
  // 末尾に 1 バイト足すだけで受け入れ検査 3 種が素通りしていた（CP6 で実測。
  // エントリ 31,000 件の zip が通った）。頭に足す細工は塞いであったのに、尾が開いていた
  return loose
}

/**
 * セントラルディレクトリを歩いて、件数と、project.json が名乗る展開後の大きさを集める。
 *
 * **名乗る件数を信じない。** zip の読み手（JSZip 3.10.1 `lib/zipEntries.js` の
 * `readCentralDir`）は終端が名乗る件数を読み飛ばし、ヘッダの目印が続く限り読み進める。
 * 名乗りを信じて数えると、1 件と名乗って 10 万件を収めた zip が上限を素通りし、その後で
 * 読み手が全件ぶんの費用を払う。読み手と同じ数え方をして初めて上限が上限になる。
 *
 * 歩くのは上限を 1 つ超えるところまでで打ち切る。全部歩くと、上限が守ろうとしている費用を
 * この走査自身が払う。ヘッダ 1 件は 46 バイト以上なので、打ち切りまでの読み取りは
 * 上限 3 万件でも 1.4 MB に収まる。
 *
 * `end` は終端の位置、`limit` はエントリ数の上限。
 */
function listedSizes(
  bytes: Buffer,
  end: number,
  limit: number,
): { sizes: number[]; assets: number; zip64: boolean; tooMany: boolean } | { error: string } {
  const span = bytes.readUInt32LE(end + 12)
  const start = bytes.readUInt32LE(end + 16)
  if (start === ZIP64_SIZE || span === ZIP64_SIZE) {
    return { error: "zip の目次（セントラルディレクトリ）が ZIP64 で、位置を読めない" }
  }
  if (start + span > bytes.length) {
    return { error: "zip の目次（セントラルディレクトリ）が、ファイルの外を指している" }
  }

  const sizes = []
  /** project.json 以外が名乗る展開後の大きさの合計。素材の総量に当たる */
  let assets = 0
  let zip64 = false
  let at = start
  let seen = 0
  // 目印が続く限り読む。終端は別の目印なので、そこで自然に止まる
  while (at + CD_MIN <= end && bytes.readUInt32LE(at) === CD_SIGNATURE) {
    seen += 1
    if (seen > limit) return { sizes, assets, zip64, tooMany: true }

    const size = bytes.readUInt32LE(at + 24)
    const nameLength = bytes.readUInt16LE(at + 28)
    const extraLength = bytes.readUInt16LE(at + 30)
    const commentLength = bytes.readUInt16LE(at + 32)
    const nameAt = at + CD_MIN
    if (nameAt + nameLength > bytes.length) {
      return { error: `${seen} 件目の名前が範囲の外へ出ている` }
    }

    const name = bytes.toString("utf8", nameAt, nameAt + nameLength)
    if (PROJECT_JSON.test(name)) {
      sizes.push(size)
    } else {
      // ディレクトリの見出し（末尾が `/`）は中身を持たないが、名乗る大きさは 0 なので
      // 足しても変わらない。分けずに済ませる
      assets += size
    }
    if (size === ZIP64_SIZE) zip64 = true
    at = nameAt + nameLength + extraLength + commentLength
  }

  // 1 件も読めないのは、位置がずれているか中身が zip でないかである。読み手は
  // ここで「壊れている」と言って止まるので、こちらも通さない
  if (seen === 0) {
    return { error: "zip の目次（セントラルディレクトリ）に、読める見出しが 1 件も無い" }
  }
  return { sizes, assets, zip64, tooMany: false }
}
