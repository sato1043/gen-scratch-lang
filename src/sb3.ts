/**
 * project.json と素材を .sb3（zip）へ収める。
 *
 * 同じ入力からは常に同じバイト列を出す。無作為な ID を振らないのと同じ理由で、
 * 生成物の差分が読める状態を保つため。zip で揺れうるのは次の 4 つに限られる
 * （出典は JSZip 3.10.1 の `lib/generate/ZipFileWorker.js` の `generateZipParts`。
 * 残りのヘッダ項目は名前と中身から決まる）。
 *
 * | 揺れる元 | 固定の仕方 |
 * |---|---|
 * | 更新日時（既定は生成時の時刻）| 全エントリへ同じ日時を与える |
 * | エントリの並び（挿入順に書かれる）| project.json を先頭、素材は名前の昇順 |
 * | 同じ名前の重複 | 呼び出し元が一意にする。重複したら止める |
 * | 圧縮とプラットフォーム | 明示して既定に依存しない |
 */
import JSZip from "jszip"

/**
 * zip へ書き込む更新日時。
 *
 * 値そのものに意味は無く、固定であることだけが要る。JSZip は日時を `getUTC*` で
 * 読むため、この 1 つの値がどの時間帯でも同じバイトになる。
 */
const FIXED_DATE = new Date(Date.UTC(2000, 0, 1))

/** .sb3 の中で project.json が置かれる名前 */
const PROJECT_ENTRY = "project.json"

export type Asset = {
  /** zip での名前（中身の md5 + 拡張子）*/
  name: string
  bytes: Buffer
}

/**
 * project.json と素材を .sb3 のバイト列にする。
 *
 * 引数は `buildProject` の戻り。
 */
export async function packSb3({
  project,
  assets,
}: {
  project: any
  assets: Asset[]
}): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(PROJECT_ENTRY, JSON.stringify(project), { date: FIXED_DATE })

  const seen = new Set([PROJECT_ENTRY])
  const order = (a: Asset, b: Asset) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  for (const asset of [...assets].sort(order)) {
    // 同じ名前を 2 度入れると、zip としては通るのに中身が二重になる。黙って通さない
    if (seen.has(asset.name)) throw new Error(`素材の名前が重複している: ${asset.name}`)
    seen.add(asset.name)
    zip.file(asset.name, asset.bytes, { date: FIXED_DATE, binary: true })
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
    streamFiles: false,
  })
}
