import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { dirname, join, relative, resolve, sep } from "node:path"
import JSZip from "jszip"
import { loadCatalog } from "../src/catalog.ts"
import { parseNotation } from "../src/parse.ts"
import { readSb3 } from "../src/read.ts"
import { buildProject } from "../src/project.ts"
import { serializeScripts } from "../src/serialize.ts"
import { officialProblems } from "../src/validate.ts"

/**
 * 書いた人が知識層へ辿り着けること、手順書の案内が実装と食い違わないことを見張る。
 *
 * どちらも放っておくと減る側の性質である。ページを足した人がリンクを足し忘れても、
 * 申告の名前を変えた人が手順書を直し忘れても、今までは誰も気づかなかった。
 *
 * **手順書の表が実装を覆っているかは見ていない**（守備範囲）。表は全種を載せない方針で、
 * 見るのは 2 つ ── 表が挙げた申告が実在するか（逆向きのドリフト）と、実装の申告が増えたか
 * （この向きのドリフトの契機）。
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const run = promisify(execFile)

/** 入口。ここから markdown のリンクを辿れる範囲が「導線」にあたる */
const ENTRY = "README.md"

/** 導線が覆うべき範囲。記法を書くために読むページはすべてこの下にある */
const KNOWLEDGE = "docs/knowledge"

const LINK = /\[[^\]]*\]\(([^)]+)\)/g

/**
 * コードフェンスの中を落とす。実行例に現れる括弧を リンクと読まないため。
 */
function withoutFences(text: string): string {
  let inside = false
  return text
    .split(/\r?\n/)
    .filter(line => {
      if (/^\s*```/.test(line)) {
        inside = !inside
        return false
      }
      return !inside
    })
    .join("\n")
}

/**
 * markdown が指すローカルの相対リンクを集める。
 *
 * `#` の後ろは捨てない。見出しを名指す参照はここを通って照合へ回る。
 *
 * `page` は根からの相対パス
 * `root` は走査の根。較正では一時ディレクトリを渡す
 */
function targetsOf(page: string, root: string): { path: string, anchor: string }[] {
  const text = withoutFences(readFileSync(join(root, page), "utf8"))
  const found: { path: string, anchor: string }[] = []
  for (const [, target] of text.matchAll(LINK)) {
    const [head, ...rest] = target.split("#")
    const path = head.trim()
    const anchor = rest.join("#").trim()
    // スキームを持つもの（http: 等）と、行き先を持たない目印は導線の外
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) continue
    if (path === "" && anchor === "") continue
    found.push({ path, anchor })
  }
  return found
}

/** 見出しを名指す参照。`from` が書き、`to` の `anchor` を指す */
type HeadingReference = { from: string; to: string; anchor: string }

/**
 * 入口から辿れるページ、指す先が無いリンク、見出しを名指す参照を集める。
 *
 * 参照は指す先のファイルが無くても数える。数えないと、リンク切れが 1 件出ただけで
 * 下の較正（抜き出しの取りこぼしを測る等号）が同時に崩れ、落ちた理由が読めなくなる。
 * ファイルの実在は `broken` の側が見る。
 *
 * `root` は走査の根。省略するとリポジトリの根。
 */
function reachable(
  entry: string,
  root: string = ROOT,
): { seen: Set<string>; broken: string[]; references: HeadingReference[] } {
  const seen = new Set([entry])
  const queue = [entry]
  const broken: string[] = []
  const references: HeadingReference[] = []

  while (queue.length > 0) {
    const page = queue.pop() as string
    // 辿るのは markdown だけ。ディレクトリや画像は行き止まりとして数える
    if (!page.endsWith(".md")) continue

    for (const { path: target, anchor } of targetsOf(page, root)) {
      // 行き先を書かない参照（`#見出し`）は同じページを指す
      const absolute = target === "" ? join(root, page) : resolve(dirname(join(root, page)), target)
      const next = relative(root, absolute).split(sep).join("/")
      if (anchor !== "") references.push({ from: page, to: next, anchor })
      if (target === "") continue
      if (!existsSync(absolute)) {
        broken.push(`${page} -> ${target}`)
        continue
      }
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return { seen, broken, references }
}

/**
 * ディレクトリの下にある markdown を再帰で集める。
 */
function pagesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return pagesUnder(path)
    return entry.name.endsWith(".md") ? [path] : []
  })
}

test("README から知識層の全ページへ辿れる", () => {
  const pages = pagesUnder(KNOWLEDGE)
  // 走査が空だと、以下の照合は 1 件も見ないまま緑になる
  assert.ok(pages.length >= 15, `知識層のページが ${pages.length} 件しかない`)

  const { seen } = reachable(ENTRY)
  assert.deepEqual(
    pages.filter(page => !seen.has(page)),
    [],
    "README から辿れないページがある",
  )
})

test("markdown のリンクが実在するファイルを指す", () => {
  const { broken, seen } = reachable(ENTRY)
  assert.ok(seen.size > 1, "入口から 1 ページも辿れていない")
  assert.deepEqual(broken, [], "指す先が無いリンクがある")
})

/**
 * ページの見出しから、GitHub が振る id の集合を作る。**許す側の列挙**である。
 *
 * 作り方は小文字化・記号の除去・空白をハイフンへ、の 3 つ。日本語の見出しはそのまま
 * 残り、変換が効くのは番号の前置と括弧・読点である（`### 6. 生成して検査に掛ける` が
 * `6-生成して検査に掛ける` になる）。導線の見出し 76 件のうち 23 件がこの変換で素の
 * 文字列から動いた（2026-08-24 実測）ので、素の一致では足りない。
 *
 * 守備範囲を 2 つ宣言する。
 *
 * - **atx（行頭の `#`）だけを見る**。下線で書く見出し（setext）は数えない。ページの
 *   題にしか使われておらず、題を指すならファイルへリンクすれば足りる
 * - **同じ id が 2 つあるときの連番（`-1`）は作らない**。導線の 20 ページに重複は
 *   0 件だった（同日実測）。重複が生まれたら、2 つめを指す参照はここで落ちる
 *
 * どちらも、外れたときに黙るのでなく落ちる側へ倒してある。
 */
function headingIds(page: string, root: string): Set<string> {
  const text = withoutFences(readFileSync(join(root, page), "utf8"))
  const ids = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const found = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (!found) continue
    ids.add(
      found[1]
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
        .replace(/\s+/g, "-"),
    )
  }
  return ids
}

/**
 * アンカーを持つローカルリンクの数を、走査とは別の道で数える。
 *
 * 走査が抜き出した件数とここが食い違えば、抜き出しが取りこぼしている。件数の床だけを
 * 置くと、床を満たしたまま 1 件が抜ける経路が空席として残る。
 */
function anchoredLinksIn(pages: Iterable<string>, root: string): number {
  let count = 0
  for (const page of pages) {
    if (!page.endsWith(".md")) continue
    const text = withoutFences(readFileSync(join(root, page), "utf8"))
    for (const [, target] of text.matchAll(LINK)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      const at = target.indexOf("#")
      if (at < 0 || target.slice(at + 1).trim() === "") continue
      count += 1
    }
  }
  return count
}

/**
 * 指す先に見出しが無い参照を挙げる。
 *
 * ファイルが無いものは外す ──「markdown のリンクが実在するファイルを指す」が拾うので、
 * ここで二重に挙げると 1 つの綻びが 2 か所で落ちて理由が読みにくくなる。数からは外さない
 * （上の等号が崩れる）。
 */
function lostReferences(references: HeadingReference[], root: string): string[] {
  return references
    .filter(reference => existsSync(join(root, reference.to)))
    .filter(reference => !headingIds(reference.to, root).has(reference.anchor))
    .map(reference => `${reference.from} -> ${reference.to}#${reference.anchor}`)
}

/**
 * 導線に書かれた、見出しを名指す参照の数。
 *
 * **見るのは記法（`パス#見出しの id`）で書かれた参照だけである**（守備範囲）。地の文へ
 * 見出しの名前を書いた形は捕まらない。語から推定する道は起票時に測って塞がっていた ──
 * 「」で囲まれた語 440 件のうち実在する見出しと一致したのは 23 件（5%）で、しかも
 * **改名した参照ほど一致しなくなる**。壊れたものだけが視界から消えるので、0 件が
 * 「健全」と読めてしまう（2026-08-23 実測）。書き手に記法を課す側へ寄せた。
 *
 * 6 件はいずれもスキルが持つ（`SKILL.md`）。手順書の 4 件と README の 2 件で、記法を
 * 置くまでは地の文の「」だった。参照が増えたらこの数を上げる ── 下げる向きに動いたら
 * 抜き出しが狭まった疑いがある。
 */
const HEADING_REFERENCES = 6

test("見出しを名指す参照が、実在する見出しを指す", () => {
  const { seen, references } = reachable(ENTRY)

  // 較正。抜き出しが空だと、以下の照合は 1 件も見ないまま緑になる
  assert.ok(
    references.length >= HEADING_REFERENCES,
    `見出しを名指す参照を ${references.length} 件しか拾えていない`,
  )
  // 床だけだと、1 件抜けても他が増えれば通る空席が残る
  assert.equal(
    references.length,
    anchoredLinksIn(seen, ROOT),
    "抜き出せなかった見出し参照がある",
  )

  assert.deepEqual(lostReferences(references, ROOT), [], "指す先に、その見出しが無い")
})

/**
 * 案内のページが「止まったとき」の表に挙げた申告を取り出す。
 *
 * 表の 1 列目のコード表記だけを見る。実装の申告と綴りが一致することを下の検査が測るため、
 * 表の書き方（バッククォートで囲む）がそのまま機械可読の印になっている。
 *
 * 表は 2 ページにある ── 書く側（howto.md）と読む側（reading.md）。読む側は TASK0013 で
 * 起こした。ページを引数に取るのは、検査がページごとに床を置くためである。合計へ
 * 床を置くと、片方の表の抽出が壊れてももう片方が床を満たし、黙って見張りから外れる。
 *
 * `name` は知識層のページ名
 */
function announcedInGuide(name: string): string[] {
  const guide = readFileSync(join(ROOT, KNOWLEDGE, name), "utf8")
  // 見出しの深さはページごとに違う（howto は ###・reading は ##）ので、どちらも受ける
  const section = guide.split(/\r?\n#{2,3} 止まったとき/)[1]?.split(/\r?\n#{2,3} /)[0] ?? ""
  return section
    .split(/\r?\n/)
    .filter(line => line.startsWith("| `"))
    .flatMap(line => [...line.split("|")[1].matchAll(/`([^`]+)`/g)].map(m => m[1]))
}

/**
 * 実装が出す申告を、実物を動かして集める。
 *
 * 綴りをソースから正規表現で拾うと、組み立てて作る申告（`変数が宣言されていない`）を
 * 取り落とす。壊れた入力を通して出てきたものだけを数えれば、その心配が無い。
 */
async function announcedByCode(): Promise<Set<string>> {
  const catalog = loadCatalog()
  const names = {
    idFor: (kind: string, name: string) => (kind === "broadcast" ? `broadcast:${name}` : null),
  }

  const broken = [
    "そんなブロックはない",
    "[エンター v] キーが押されたとき",
    "[はじめ] を送る",
    "<[はい] かつ [いいえ]>",
    "(スコア) と言う",
    "(記録) を [記録 v] に追加する",
    // 台帳が引数名を取れない 2 件は、記法から呼ぶとここで止まる
    "背景が [背景1 v] になったとき",
    // 形の崩れたブロック定義。`定義` だけで作るブロックの見出しが無い
    "定義",
    // 真偽を取る引数を書いたブロック定義。扱わないので申告して止まる
    "定義 しらべる <ある?>",
    // 括弧を空で書いた引数。名前が無いと本体から参照できない
    ["定義 えがく ()", "(1) 歩動かす"].join("\n"),
    // 文字として存在しない番号を印へ書いた記法。手順書が案内する申告なので、実物が
    // 出ることをここで確かめる
    `[あ${String.fromCodePoint(0x27ea)}U+110000${String.fromCodePoint(0x27eb)}い] と言う`,
  ]

  const kinds = new Set<string>()
  for (const code of broken) {
    const doc = await parseNotation(code)
    const { problems } = serializeScripts(doc, { catalog, names, warped: [] })
    for (const problem of problems) kinds.add(problem.kind)
  }
  // 作品定義の側で立つ申告。記法だけでは出ない ── `再描画しないブロック` は
  // 定義が持つので、`serializeScripts` を通しても届かない
  const dir = mkdtempSync(join(tmpdir(), "gen-scratch-guide-"))
  writeFileSync(
    join(dir, "project.yaml"),
    [
      "名前: ためし",
      "スプライト:",
      "  - 名前: ネコ",
      "    スクリプト: neko.sbk",
      "    再描画しないブロック:",
      "      - 12",
      "      - 記法に無い名前",
    ].join("\n"),
  )
  // 綴りの同じ定義を 2 つ置く。これも作品定義の側（`buildProject`）で立つ
  writeFileSync(
    join(dir, "neko.sbk"),
    [
      "緑の旗が押されたとき",
      "定義 えがく",
      "(1) 歩動かす",
      "",
      "定義 えがく",
      "(2) 歩動かす",
    ].join("\n"),
  )
  for (const problem of (await buildProject(dir)).problems) kinds.add(problem.kind)

  // 出荷経路の最後に置いた検証器。zip でも JSON でもないバイト列で拒否させる
  for (const problem of await officialProblems(Buffer.from("not a zip"), "測定")) {
    kinds.add(problem.kind)
  }

  // 読む側の申告。読み取りのページ（reading.md）の表が挙げる綴りも、実物から出す
  for (const problem of (await readSb3(Buffer.from("not a zip"), "測定", {})).problems) {
    kinds.add(problem.kind)
  }
  // Scratch 2 の形をした zip。形の検査は逃げ道を通しても掛かるので、旗を立てて
  // 検証器の拒否を越え、形の申告まで届かせる
  const zip = new JSZip()
  zip.file("project.json", JSON.stringify({ objName: "Stage", children: [] }))
  const sb2 = await zip.generateAsync({ type: "nodebuffer" })
  for (const problem of (await readSb3(sb2, "測定", { anyway: true })).problems) {
    kinds.add(problem.kind)
  }
  return kinds
}

/**
 * 実装が出す申告の綴り。日本語を含むものだけを申告として数える（`kind` は種別の値にも
 * 使われており、英字だけのものは申告でない）。
 *
 * 申告の作り方は 2 通りある。`{ kind: "…" }` と書く形と、`problemOf` へ名前を渡す形で
 * ある。後者を見ないと、読み取りの経路が申告を増やしてもこの見張りが黙る（実際に
 * 2 件が見えなかった。2026-08-20）。作り方を増やしたらここも増やす。
 */
const ANNOUNCEMENT = [
  /kind:\s*(['"`])([^'"`\n]*[ぁ-んァ-ヶ一-龠][^'"`\n]*)\1/g,
  /problemOf\([^,]+,\s*(['"`])([^'"`\n]*[ぁ-んァ-ヶ一-龠][^'"`\n]*)\1/g,
]

/**
 * 実装が出す申告の種類。手順書の表が覆う数ではない。
 *
 * 表は全種を載せない。20 を超える表は引く道具でなくなるので、載せるのは書き手が実際に
 * 出会うものに絞る。代わりに種類が増えたことだけを捕まえ、増えたときに「この申告を表へ
 * 載せるか」を書き手へ判断させる。この作業を起票させたのは、実装が停止を増やしたのに
 * 手順書が追いつかなかった向きのドリフトであり、その契機をここで作る。
 *
 * 35 から 44 へ動かしたのは読み取りの経路の 9 種である。内訳は受け入れ検査の 4 種
 * （`zip として読めない`・`zip のエントリが多すぎる`・`project.json が大きすぎる`・
 * `受け入れ検査を通せない`）、読解の 3 種（`読み取れない .sb3`・`記法へ戻せない`・
 * `ターゲットのブロックの表が無い`）、書き出しの 2 種
 * （`読み取りの結果を書き出せない`・`図の本数が上限を超えた`）である。このうち読解の
 * 2 種は、走査を `problemOf` まで広げるまで見えていなかった。
 *
 * 44 から 47 へ動かしたのは、逃げ道（`--anyway`）が自分で確かめるようになった 3 種である。
 * 検証器を止める理由から降ろした代わりに、検証器が守っていたものを引き継いだ ──
 * 読み取りが要求する形（`読み取れる形をしていない`）・宣言の値の形
 * （`宣言の値が読める形をしていない`）・扱う件数（`ターゲットが多すぎる`）。
 *
 * 47 から 51 へ動かしたのは、書き出しを不可分にしたときの 4 種である。書き出し先の
 * 検分（`書き出し先を見られない`・`書き出し先に前回の成果物が残っている`・
 * `書き出し先が読み取りの置き場に見えない`）と、組み上がったものを置き場へ移す段
 * （`読み取りの結果を置き場へ移せない`）。
 *
 * **表へは載せない。** 表が覆うのは記法と定義を「書く」側が出会う停止であり、上の 16 種は
 * いずれも .sb3 を「読む」側で立つ。手順書は書く側の道具なので、読む側の停止を混ぜると
 * 引く道具でなくなる。読み取りの手順書を別に起こすかは、実物の .sb3 を読ませてから決める
 * （2026-08-20 の判断）。
 *
 * 51 から 52 へ動かしたのは最上位の受け口（`内部で例外が出た`）である。**これも表へは
 * 載せない。** 表は「何を見れば直せるか」を引く道具で、この 1 種だけは書き手の側に直す
 * ものが無い ── 立ったらこちらの落ち度であり、申告自身がそう名乗る（2026-08-22 の判断）。
 *
 * 52 から 53 へ動かしたのは、出力が逃がし方を名乗らないことの申告
 * （`逃がし方を名乗らない出力がある`）である。**これも表へは載せない** ── 読み取りの
 * 出力を足す実装者へ向けた砦で、記法や定義を書く人には立たない（2026-08-22 の判断）。
 *
 * 53 から 54 へ動かしたのは、読み取りの描画経路が `render` と同じ砦を通るようにした
 * ときの 1 種（`記法を図にできない`）である。**これも表へは載せない** ── 読む側で立つ
 * （上の 16 種と同じ理由。2026-08-22 の判断）。`render` の側は同じ砦を通るが、申告の形を
 * 取らず地の文で述べるので種類には数えない。
 *
 * 54 から 55 へ動かしたのは、同じ名前の宣言を捨てたことの申告
 * （`同じ名前の宣言が 2 つある`）である。**これも表へは載せない** ── 読む側で立つ。
 * 捨てた事実を黙ると、要約が数えた宣言の数と作品定義に並ぶ数が食い違い、その差の理由が
 * どこにも残らない（2026-08-22 の判断）。
 *
 * 55 から 56 へ動かしたのは、名前が文字列でない宣言を落としたことの申告
 * （`宣言の名前が文字列でない`）である。**これも表へは載せない** ── 前の 1 種と同じ
 * 家族で、Scratch は作らず細工した .sb3 でしか立たない。同じ関数の他の 2 経路が申告
 * するのにここだけ黙っていたのを揃えた（CP6 の指摘。2026-08-22 の判断）。
 *
 * 56 から 57 へ動かしたのは、指せない符号位置の印を書いたときの申告
 * （`印が指せない符号位置を書いている`）である。**これは表へ載せる** ── 印は利用者が
 * 手書きできる記法であり、この申告は細工でなく手書きの誤りに対して出る
 * （2026-08-23 の判断）。
 *
 * 57 から 58 へ動かしたのは、書き出す量が上限を超えたことの申告
 * （`書き出す量が上限を超えた`）である。**これは表へは載せない** ── 図の本数の上限と
 * 同じ家族で、普通の作品では立たない（2026-08-23 の判断）。
 *
 * 読み取りの手順書は TASK0013 で起こした（`docs/knowledge/reading.md`）。読む側で立つ
 * 申告のうち利用者が実際に出会う 3 種はそちらの表が持ち、上の照合（案内のページが
 * 挙げる申告を、実装が実際に出す）は 2 ページの表を読む（2026-08-24）。
 *
 * 60 から 63 へ動かしたのは、ブロック定義まわりの 3 種
 * （`再描画しないブロックの書き方が違う`・`再描画しないブロックの名前が記法に無い`・
 * `真偽の引数は扱えない`）である。**3 種とも表へ載せる** ── どれも手書きの誤りに
 * 対して出る（作品定義の書き間違い・綴りの取り違え・引数を `<>` で書いた）。
 * 前 2 種は当初載せ忘れており、CP6 の使用性が指摘した（2026-09-03 の判断）。
 *
 * 64 から 66 へ動かしたのは、CP6 の測り直しで塞いだ 2 種
 * （`ブロック定義の引数に名前が無い`・`定義がスクリプトの途中にある`）である。
 * **2 種とも表へ載せる** ── どちらも手書きの誤りに対して出て、それまでは申告 0 件で
 * 通っていた（2026-09-04 の判断）。
 *
 * 63 から 64 へ動かしたのは、綴りの同じブロック定義が 2 つあることの申告
 * （`同じ綴りのブロック定義が 2 つある`）である。**これも表へ載せる** ── 手書きの
 * 誤りに対して出るうえ、黙って通すと .sb3 を開くまで気づけない（2026-09-04 の判断）。
 */
const ANNOUNCEMENT_KINDS = 66

test("実装が出す申告の種類が増えていない", () => {
  const kinds = new Set<string>()
  for (const name of readdirSync(join(ROOT, "src"))) {
    if (!name.endsWith(".mjs") && !name.endsWith(".ts")) continue
    const source = readFileSync(join(ROOT, "src", name), "utf8")
    for (const pattern of ANNOUNCEMENT) {
      for (const [, , kind] of source.matchAll(pattern)) kinds.add(kind)
    }
  }

  // 走査が空だと、以下の照合は何も見ないまま緑になる
  assert.ok(kinds.size > 0, "申告を 1 件も拾えていない")
  assert.equal(
    kinds.size,
    ANNOUNCEMENT_KINDS,
    "申告の種類が動いた。手順書の「詰まったときに見るもの」へ載せるかを決める",
  )
})

/**
 * 検査のソースが、追跡外の書き出し先を指している綴り。
 *
 * 追跡外の生成物へ依存すると、手元にたまたま在る機械でだけ緑になる。綴りを組み立てて
 * 作るのは、この検出器自身の説明文が走査に当たらないようにするためである。
 */
const UNTRACKED_DIR = "out"
const UNTRACKED_OUTPUT = new RegExp(
  `["'\`]([^"'\`\\n]*\\.\\./${UNTRACKED_DIR}/[^"'\`\\n]*)["'\`]`,
  "g",
)

test("検査が追跡外の生成物に依存しない", () => {
  // `out/` は追跡外で、そこへ置かれる作品を作る段はどこにも無い。検査がそれを読むと、
  // 手元にたまたま在る機械でだけ緑になる（CP6 で実測。隠して走らせると 3 ファイルが
  // 落ちた）。測定器そのものが機械に依存していた
  const found = []
  let scanned = 0
  for (const name of readdirSync(join(ROOT, "test"))) {
    if (!name.endsWith(".mjs") && !name.endsWith(".ts")) continue
    scanned += 1
    const source = readFileSync(join(ROOT, "test", name), "utf8")
    for (const [, path] of source.matchAll(UNTRACKED_OUTPUT)) {
      found.push(`${name}: ${path}`)
    }
  }

  // 走査が空だと、以下の照合は何も見ないまま緑になる
  assert.ok(scanned >= 15, `検査ファイルが ${scanned} 件しかない`)
  assert.deepEqual(found, [], "追跡外の out/ を読む検査がある。入力は追跡下から組み立てる")
})

test("実装のソースに制御文字が紛れていない", () => {
  // NUL が 1 バイト入ると git がそのファイルを binary と見なし、差分が読めなくなる。
  // 落ちるわけでも検査が赤くなるわけでもないので、レビューで気づく手立てが無い
  // （2026-08-19 に実際に紛れ込ませた。区切りのつもりで書いた 1 文字だった）
  const dirty = []
  let scanned = 0
  for (const dir of ["src", "tools", "test"]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!name.endsWith(".mjs") && !name.endsWith(".ts")) continue
      scanned += 1
      // 改行とタブは除く。それ以外の C0 制御文字と DEL はソースに現れる理由が無い
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
        readFileSync(join(ROOT, dir, name), "utf8"),
      )) {
        dirty.push(`${dir}/${name}`)
      }
    }
  }

  assert.ok(scanned >= 15, `走査できたのが ${scanned} ファイルしかない`)
  assert.deepEqual(dirty, [], "ソースに制御文字が入っている")
})

test("案内のページが挙げる申告を、実装が実際に出す", async () => {
  // 床はページごとに置く。合計に置くと、片方の表の抽出が壊れても緑のままになる
  const floors = { "howto.md": 6, "reading.md": 3 }
  const announced = Object.entries(floors).flatMap(([name, floor]) => {
    const kinds = announcedInGuide(name)
    // 表を読み落とすと、照合は 0 件を突き合わせて緑になる
    assert.ok(kinds.length >= floor, `${name} の表から ${kinds.length} 件しか読めていない`)
    return kinds
  })

  const actual = await announcedByCode()
  assert.ok(actual.size >= 6, `実物から ${actual.size} 種の申告しか出ていない`)

  assert.deepEqual(
    announced.filter(kind => !actual.has(kind)),
    [],
    "案内のページが、実装の出さない申告を案内している",
  )
})

test("同じ走査が、壊れたリンクと辿れないページを実際に見つける", () => {
  // 測定器の較正。本物が 0 件なのはリンクが健全だからであって、走査が何も見ていない
  // からではないことを、既知の答えを持つ入力で確かめる
  const root = mkdtempSync(join(tmpdir(), "gen-scratch-"))
  mkdirSync(join(root, "下"), { recursive: true })
  writeFileSync(
    join(root, "README.md"),
    ["[生きている](下/ある.md)", "[死んでいる](下/ない.md)", "```", "[枠の中](こ.md)", "```"].join("\n"),
  )
  writeFileSync(join(root, "下", "ある.md"), "中身")
  writeFileSync(join(root, "下", "はぐれ.md"), "どこからも指されない")

  const { seen, broken } = reachable("README.md", root)
  assert.deepEqual(broken, ["README.md -> 下/ない.md"], "壊れたリンクを見つけていない")
  assert.ok(seen.has("下/ある.md"), "生きているリンクを辿れていない")
  assert.ok(!seen.has("下/はぐれ.md"), "指されていないページを辿ったことにしている")
  // コードフェンスの中は導線でない。落とさないと実行例の括弧をリンクと読む
  assert.ok(!broken.some(line => line.includes("こ.md")), "フェンスの中をリンクと読んでいる")
})

test("同じ走査が、宙に浮いた見出し参照を実際に見つける", () => {
  // 測定器の較正。本物が 0 件なのは参照が生きているからであって、走査が見出しを 1 つも
  // 数えていないからではないことを、既知の答えを持つ入力で確かめる
  const root = mkdtempSync(join(tmpdir(), "gen-scratch-"))
  mkdirSync(join(root, "下"), { recursive: true })
  writeFileSync(
    join(root, "README.md"),
    [
      "## この場",
      "[生きている](下/ある.md#いる見出し)",
      "[宙に浮いている](下/ある.md#いない見出し)",
      "[番号つき](下/ある.md#6-番号つきの見出し)",
      "[同じページ](#この場)",
      "[ページごと無い](下/ない.md#どこか)",
      "[アンカーを持たない](下/ある.md)",
      "```",
      "[枠の中](下/ある.md#枠)",
      "```",
    ].join("\n"),
  )
  writeFileSync(join(root, "下", "ある.md"), ["## いる見出し", "", "### 6. 番号つきの見出し"].join("\n"))

  const { seen, references } = reachable("README.md", root)
  // フェンスの中とアンカーを持たないものは数に入らない。ページごと無いものは数える
  assert.equal(references.length, 5, "見出しを名指す参照を 5 件拾えていない")
  assert.equal(references.length, anchoredLinksIn(seen, root), "抜き出しが取りこぼしている")

  // 番号の前置は id へ落ちて一致し、ページごと無いものはリンク切れの側へ回る
  assert.deepEqual(
    lostReferences(references, root),
    ["README.md -> 下/ある.md#いない見出し"],
    "宙に浮いた見出し参照だけを挙げていない",
  )
})

/**
 * エージェント向けのスキル。README から指されているので、上の導線の走査にも載る ──
 * スキルの中のリンク切れは「markdown のリンクが実在するファイルを指す」が拾う。
 * その依存は暗黙なので、下の「スキルが README から辿れる」で明示して見張る。
 *
 * ここで別に見るのは、リンクでない綴り、すなわちスキルが案内するコマンドである。手順書の
 * 申告は実物を動かして照合しているのに、コマンドの綴りには相当物が無かった。綴りを
 * 変えた人が気づかないまま、動かない例を配ることになる。
 *
 * 守備範囲は 3 つに限る。
 *
 * - **見るのはサブコマンドの綴りだけ**。同じ行の旗（`--format png`）も、引数の形も
 *   照合しない。旗は `flagGate()` の側が持っており、ここへ二重に置くと出典が割れる
 * - **実装がサブコマンドを増やしたことは見ていない**。見るのは 1 方向、スキルが書いた
 *   綴りが実物に在るか。逆向きは、スキルが全サブコマンドを載せない設計なので照合の
 *   相手が居ない
 * - **散文の重複は見ていない**。スキルが知識層の規則を写していないことは、この検査では
 *   測れない（語でなく意味の照合になる）。人が読むときの約束として残す
 */
const SKILL = ".claude/skills/words-to-scratch/SKILL.md"

/** 受け口が知らない綴りを拒むときの申告。`src/cli.ts` が出す */
const UNKNOWN_COMMAND = "知らないコマンド"

/**
 * スキルが案内する `node src/cli.ts <サブコマンド>` の綴りを集める。
 *
 * コードフェンスの中だけに絞らない。地の文で案内しても綴りは綴りであり、絞ると
 * 走査から外れる書き方が生まれる。
 *
 * 綴りと一緒に、`src/cli.ts` が何回現れたかも返す。両者が食い違えば、抜き出しが
 * 取りこぼしている（`npm run` 経由・行の継続・大文字・区切りが `\` 等）。件数の床だけを
 * 置くと、床を満たしたまま 1 件が抜ける経路が空席として残る。
 */
function commandsInSkill(): { mentioned: number, commands: string[] } {
  const text = readFileSync(join(ROOT, SKILL), "utf8")
  return {
    mentioned: (text.match(/src\/cli\.ts/g) ?? []).length,
    commands: [...text.matchAll(/src\/cli\.ts\s+([a-z][a-z-]*)/g)].map(found => found[1]),
  }
}

test("スキルが README から辿れる", () => {
  // 上の導線の走査は README を根に取る。スキルがそこから辿れなくなると、リンク切れの
  // 見張りだけが黙って外れる（検査は全部緑のまま守備範囲が消える）
  const { seen } = reachable(ENTRY)
  assert.ok(seen.has(SKILL), "README からスキルへ辿れない。リンク切れの見張りが外れている")
})

test("スキルが案内するコマンドを、実物が受け取る", async () => {
  const { mentioned, commands } = commandsInSkill()
  // 抜き出しが空だと、以下の照合は 1 件も見ないまま緑になる
  assert.ok(mentioned > 0, "スキルが `src/cli.ts` を 1 度も書いていない")
  assert.equal(commands.length, mentioned, "抜き出せなかった綴りがある")

  const refused = []
  const unmeasured = []
  for (const command of new Set(commands)) {
    // ソースの分岐を正規表現で拾うと、綴りが合っていることでなく正規表現が当たった
    // ことを測ってしまう。実物へ渡して、受け口が知らないコマンドとして拒まないかを見る
    try {
      await run(process.execPath, [CLI, command, "--help"])
    } catch (error) {
      // 落ちた理由を捨てない。ネイティブ依存の読み込み失敗・入口の不在・時間切れは
      // 綴りの誤りと区別が付かない形で落ちるので、握り潰すと保守者をスキルの修正へ
      // 誤って誘導する
      const said = `${(error as any).stdout ?? ""}${(error as any).stderr ?? ""}`
      if (said.includes(UNKNOWN_COMMAND)) refused.push(command)
      else unmeasured.push(`${command}: ${String((error as any).message).slice(0, 120)}`)
    }
  }

  // 綴りの当否を測れなかった方を先に挙げる。緑でないことより、測れていないことの方が
  // 見えにくい
  assert.deepEqual(unmeasured, [], "綴りの当否を測れていない。実物が起動していない")
  assert.deepEqual(refused, [], "スキルが、実物の受け取らないコマンドを案内している")
})
