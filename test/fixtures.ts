/**
 * 検査が使う .sb3 を、追跡下の入力からその場で組み立てる。
 *
 * 以前は `out/neko-to-score.sb3` を直に読んでいた。`out/` は追跡外で、この作品を作る段も
 * どこにも無かったため、**手元にたまたま在る機械でしか検査が成り立たなかった**
 * （CP6 で実測。隠して走らせると 3 ファイルが落ちる）。数は正しく数えていたが、数えた
 * 対象が他の機械には無かった。
 *
 * 追跡下の `projects/neko-to-score` から毎回組み立てる。生成の向き（`buildProject` →
 * `packSb3`）は TASK0001 が持っており、読み取りの検査はその出口を入力に取る。
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildProject } from "../src/project.ts"
import { packSb3 } from "../src/sb3.ts"
import { loadCatalog } from "../src/catalog.ts"
import type JSZip from "jszip"

/** 追跡下の作品。読み取りの検査の入力はここから作る */
const SOURCE = fileURLToPath(new URL("../projects/neko-to-score", import.meta.url))

/** 組み立てた結果。1 回のプロセスで作り直さない */
let cached: Buffer | null = null

/**
 * 台帳を読み出す。読めなければその場で投げる。
 *
 * `loadCatalog` は読めないときに `raw` を null で返す。検査はどれも読めた前提で書いて
 * あるので、null のまま先へ進むと「照合したが差が無かった」と「そもそも台帳が無かった」
 * が同じ緑に見える。ここで止めれば、以降は読めた形として扱える。
 */
export function catalogOrStop(): Omit<ReturnType<typeof loadCatalog>, "raw"> &
  { raw: NonNullable<ReturnType<typeof loadCatalog>["raw"]> } {
  const loaded = loadCatalog()
  if (!loaded.raw) {
    throw new Error(`検査の台帳を読めない: ${JSON.stringify(loaded.problems)}`)
  }
  return { ...loaded, raw: loaded.raw }
}

/**
 * 申告の説明を取り出す。無ければその場で止める。
 *
 * `detail` は持つものだけ添える約束なので、型の上では省ける。`String(...)` で包んで
 * 逃げると、無いときに `"undefined"` という文字列になり、照合が偶然通る。
 */
export function detailOf(problem: { detail?: string } | undefined): string {
  if (!problem?.detail) throw new Error("申告が説明を持たない")
  return problem.detail
}

/**
 * ステージ側／スプライト側のターゲットを取る。居なければその場で止める。
 *
 * 検査はどれも「居る」前提で中身を見る。undefined のまま先へ進むと、記法が空だったのか
 * ターゲット自体が無かったのかが同じ形で現れて、落ちた理由が読めない。
 */
export function spriteOf<T extends { isStage: boolean }>(targets: T[]): T {
  const found = targets.find(target => !target.isStage)
  if (!found) throw new Error("ステージでないターゲットが無い")
  return found
}

export function stageOf<T extends { isStage: boolean }>(targets: T[]): T {
  const found = targets.find(target => target.isStage)
  if (!found) throw new Error("ステージのターゲットが無い")
  return found
}

/**
 * .sb3 の中の `project.json` を、本文と読んだ形の双方で取り出す。
 *
 * `zip.file` は無いときに null を返す。検査はどれも在る前提で欄を触るので、null のまま
 * 進むと「欄が空だった」と「project.json ごと無かった」が同じ落ち方になる。
 *
 * 読んだ形は `targets` を持つ緩い形として受ける。.sb3 の中身は Scratch 側の形であり、
 * こちらの型ではないので、欄を数え上げた型を置くと写しが二重になって古びる。
 */
export async function projectJsonIn(zip: JSZip): Promise<{
  source: string
  project: { targets: any[], [key: string]: any }
}> {
  const entry = zip.file("project.json")
  if (!entry) throw new Error(".sb3 に project.json が無い")
  const source = await entry.async("string")
  return { source, project: JSON.parse(source) }
}

/**
 * 追跡下の作品を .sb3 のバイト列にする。
 *
 * 組み立てに失敗したら投げる。検査の入力が作れないことを緑のまま進めると、
 * 「読めた」を測っているのか「入力が空だった」を測っているのかが混ざる。
 */
export async function ourSb3(): Promise<Buffer> {
  if (cached) return cached

  const { project, assets, problems } = await buildProject(SOURCE)
  if (problems.length > 0 || !project) {
    throw new Error(`検査の入力を組み立てられない: ${JSON.stringify(problems)}`)
  }
  cached = await packSb3({ project, assets })
  return cached
}

/**
 * 同じ .sb3 をファイルとして置く。入口（CLI）へ渡す検査が使う。
 *
 * 戻りは書き出したパス
 */
export async function ourSb3File(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-fixture-"))
  const path = join(dir, "neko-to-score.sb3")
  writeFileSync(path, await ourSb3())
  return path
}
