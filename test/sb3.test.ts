import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import JSZip from "jszip"
import { buildProject } from "../src/project.ts"
import { packSb3 } from "../src/sb3.ts"
import { officialProblems } from "../src/validate.ts"
import { projectJsonIn } from "./fixtures.ts"

const run = promisify(execFile)
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const ROOT = fileURLToPath(new URL("..", import.meta.url))

/**
 * 作品を一時ディレクトリへ書いて .sb3 まで組み立てる。
 */
async function pack(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-"))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  const built = await buildProject(dir)
  assert.deepEqual(built.problems, [])
  return { ...built, bytes: await packSb3(built) }
}

const SAMPLE = {
  "project.yaml": [
    "名前: ためし",
    "ステージ:",
    "  スクリプト: stage.sbk",
    "  変数:",
    "    スコア: 0",
    "スプライト:",
    "  - 名前: ネコ",
    "    スクリプト: neko.sbk",
  ].join("\n"),
  "stage.sbk": ["[はじめ v] を受け取ったとき", "[スコア v] を (0) にする"].join("\n"),
  "neko.sbk": ["緑の旗が押されたとき", "[はじめ v] を送る", "(10) 歩動かす"].join("\n"),
}

/**
 * .sb3 を公式検証器へ通す。呼び出しは本体側の部品を使う。テスト専用の呼び方を
 * 持つと、テストで通ったものが出荷経路では別の呼ばれ方をする。
 *
 * 戻りは弾いた理由。通れば null
 */
async function official(bytes: Buffer): Promise<string | null> {
  const [problem] = await officialProblems(bytes, "ためし")
  return problem?.detail ?? null
}

/**
 * .sb3 を開いて中身を差し替え、詰め直す。
 */
async function rezip(bytes: Buffer, mutate: (zip: JSZip) => unknown): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes)
  await mutate(zip)
  return zip.generateAsync({ type: "nodebuffer" })
}

/** 2 体のスプライトが同じコスチュームを持つ作品 */
const TWO_SPRITES = {
  "project.yaml": [
    "スプライト:",
    "  - 名前: ネコ",
    "    スクリプト: neko.sbk",
    "  - 名前: イヌ",
    "    スクリプト: neko.sbk",
  ].join("\n"),
  "neko.sbk": "(10) 歩動かす",
}

test("同じ作品から 2 回作った .sb3 がバイト単位で一致する", async () => {
  const first = await pack(SAMPLE)
  const second = await pack(SAMPLE)
  assert.equal(Buffer.compare(first.bytes, second.bytes), 0, ".sb3 が 2 回で違う")
})

test("zip の日時が固定され、生成した時刻に依らない", async () => {
  const { bytes } = await pack(SAMPLE)

  // 先頭のローカルファイルヘッダの更新日時（署名 4 + 版 2 + 旗 2 + 方式 2 の後ろ）。
  // 期待値は実装から借りず、固定日時 2000-01-01T00:00:00Z を DOS 形式へ手で直したもの。
  // 時刻 = 0、日付 = (2000-1980)<<9 | 1<<5 | 1 = 0x2821。いずれも下位バイトが先
  assert.deepEqual([...bytes.subarray(10, 14)], [0x00, 0x00, 0x21, 0x28])

  // 全エントリを読み戻して確かめる。読み出しは書き出しとは別の実装を通る
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files)
  assert.ok(names.length >= 2, `エントリが少ない: ${names.join(", ")}`)
  for (const name of names) {
    assert.equal(zip.files[name].date.toISOString(), "2000-01-01T00:00:00.000Z", name)
  }
})

test("読み戻すと project.json と全ターゲットの素材が揃う", async () => {
  const { project, assets, bytes } = await pack(SAMPLE)
  const zip = await JSZip.loadAsync(bytes)

  const { project: stored } = await projectJsonIn(zip)
  assert.deepEqual(stored, project, "収めた project.json が組み立てと違う")

  // コスチュームが指す素材がすべて入っている。1 つでも欠けると Scratch で絵が出ない
  for (const target of project.targets) {
    for (const costume of target.costumes) {
      assert.ok(zip.file(costume.md5ext), `${target.name} の素材が .sb3 に無い`)
    }
  }
  assert.equal(Object.keys(zip.files).length, assets.length + 1, "余分なエントリがある")
})

test("同じ素材を持つスプライトが並んでも 2 度収めない", async () => {
  const { project, assets, bytes } = await pack(TWO_SPRITES)

  const [, neko, inu] = project.targets
  assert.equal(neko.costumes[0].md5ext, inu.costumes[0].md5ext, "前提が崩れている")
  // ステージの背景とスプライトの絵で 2 件。スプライトが 2 体でも増えない
  assert.equal(assets.length, 2)

  const zip = await JSZip.loadAsync(bytes)
  const expected = [...assets.map(a => a.name), "project.json"].sort()
  assert.deepEqual(Object.keys(zip.files).sort(), expected)
})

test("素材を渡された順に依らず、名前の順で収める", async () => {
  const bytes = Buffer.from("<svg/>", "utf8")
  const packed = await packSb3({
    project: { targets: [], meta: {} },
    assets: [{ name: "b.svg", bytes }, { name: "a.svg", bytes }],
  })

  const zip = await JSZip.loadAsync(packed)
  assert.deepEqual(Object.keys(zip.files), ["project.json", "a.svg", "b.svg"])
})

test("素材の名前が重複したまま渡されたら黙って詰めずに止める", async () => {
  const bytes = Buffer.from("<svg/>", "utf8")
  await assert.rejects(
    () => packSb3({ project: { targets: [], meta: {} }, assets: [
      { name: "a.svg", bytes },
      { name: "a.svg", bytes },
    ] }),
    /素材の名前が重複している/,
  )
})

test("生成した .sb3 が公式検証器を通る", async () => {
  const { bytes } = await pack(SAMPLE)
  assert.equal(await official(bytes), null)
})

/**
 * 公式検証器の守備範囲。壊した .sb3 を与えて実測した結果を置く
 * （2026-08-17・scratch-parser 6.0.1）。
 *
 * `caught: false` は「見ていない」ことの記録である。安全網に数えないために残し、
 * 代わりに何が見張るかを `guarded` に書く。検証器が厳しくなればこの検査が落ち、
 * 記録が古びたことが分かる。
 */
const COVERAGE: {
  name: string
  caught: boolean
  /** 検証器が捕まえない壊し方を、代わりに何が見張っているか */
  guarded?: string
  make: (good: Buffer) => Promise<Buffer>
}[] = [
  {
    name: "project.json を抜く",
    caught: true,
    make: good => rezip(good, z => z.remove("project.json")),
  },
  {
    name: "project.json が壊れた JSON",
    caught: true,
    make: good => rezip(good, z => z.file("project.json", "{ こわれ")),
  },
  {
    name: "コスチュームを 0 個にする",
    caught: true,
    make: good =>
      rezip(good, async z => {
        const { project } = await projectJsonIn(z)
        for (const target of project.targets) target.costumes = []
        z.file("project.json", JSON.stringify(project))
      }),
  },
  {
    name: "途中で切った zip",
    caught: true,
    make: async good => good.subarray(0, Math.floor(good.length / 2)),
  },
  {
    name: "zip でないバイト列",
    caught: true,
    make: async () => Buffer.from("これは zip ではない", "utf8"),
  },
  {
    name: "素材を抜く",
    caught: false,
    guarded: "「読み戻すと素材が揃う」検査（このファイル）",
    make: good =>
      rezip(good, z => {
        for (const name of Object.keys(z.files)) {
          if (name !== "project.json") z.remove(name)
        }
      }),
  },
  {
    name: "実在しない opcode",
    caught: false,
    guarded: "台帳の整合検査と往復検査",
    make: good =>
      rezip(good, async z => {
        const { source: text } = await projectJsonIn(z)
        z.file("project.json", text.replace(/"motion_movesteps"/, '"nonexistent_block"'))
      }),
  },
]

test("公式検証器が .sb3 の何を見て何を見ないかを測る", async () => {
  const { bytes } = await pack(SAMPLE)

  for (const item of COVERAGE) {
    const error = await official(await item.make(bytes))
    if (item.caught) {
      assert.notEqual(error, null, `${item.name} を通してしまう`)
    } else {
      assert.equal(error, null, `${item.name} を弾くようになった。守備範囲の記録が古い`)
    }
  }
})

test("CLI が .sb3 を書き出す", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "gen-scratch-")), "neko.sb3")
  const { stdout } = await run(
    process.execPath,
    [CLI, "build", "projects/neko-to-score", "--out", out],
    { cwd: ROOT },
  )

  assert.match(stdout, /素材 \d+ 件/)
  const bytes = readFileSync(out)
  const head = [...bytes.subarray(0, 4)]
  assert.deepEqual(head, [0x50, 0x4b, 0x03, 0x04], "zip になっていない")
  const zip = await JSZip.loadAsync(bytes)
  assert.ok(zip.file("project.json"), "project.json が入っていない")
})
