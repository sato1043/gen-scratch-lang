/**
 * ドロップダウンの選択肢を上流から書き出し直す。
 *
 * 追跡下の `catalog/dropdowns.ts` の `OPTIONS` は機械で書き出した結果を写したもの
 * だが、書き出す手順が残っていなかった。上流が変われば古びるのに、古びたことに
 * 気づく手段が無い。
 *
 * 出典は scratch-blocks 一式に閉じる。内部値はブロック定義の `[Blockly.Msg.X, '値']`
 * の組から、日本語ラベルは同梱の `msg/scratch_msgs.js` の `locales['ja']` から取る。
 * 両方が同じ版から来るため、版のずれが起きない。
 *
 * 読み方は字句走査に留め、定義を評価しない（`opcodes.ts` と同じ理由）。取りこぼしは
 * 黙って減るので、選択肢の要素数と読めた組の数を必ず照合する。
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { packageRoot } from "./opcodes.ts"

/** ブロック定義の始まり。ここから次の始まりまでを 1 ブロックの本文として切る */
const BLOCK_HEAD = /^Blockly\.Blocks\.([A-Za-z0-9_]+) = \{/gm

/** 欄の名前。選択肢より前の直近のものが、その選択肢の持ち主にあたる */
const FIELD_NAME = /\bname: '([A-Za-z0-9_]+)'/g

/**
 * 選択肢 1 組。ラベルは訳される識別子か、綴りをそのまま見せるリテラル。
 *
 * 値は単引用符と二重引用符の双方で書かれる。`"don't rotate"` のように綴りへ単引用符を
 * 含むものがあり、単引用符だけを見ると黙って落ちる。
 */
const OPTION =
  /\[\s*(?:Blockly\.Msg\.([A-Z0-9_]+)|'([^']*)'|"([^"]*)")\s*,\s*(?:'([^']*)'|"([^"]*)")\s*\]/g

/** 日本語の見出しの始まり。`KEY: '値',` が並ぶ */
const JAPANESE_HEAD = "ScratchMsgs.locales['ja'] = {"

/** 見出し 1 行 */
const MESSAGE_LINE = /^([A-Z0-9_]+): *(?:'([^']*)'|"([^"]*)")/

type Problem = {
  kind: string
  subject: string
  detail: string
}

/**
 * 同梱の日本語の見出しを読む。
 *
 * `root` はscratch-blocks の置き場
 */
export function japaneseMessages(root: string): Record<string, string> {
  const source = readFileSync(join(root, "msg", "scratch_msgs.js"), "utf8")
  const head = source.indexOf(JAPANESE_HEAD)
  if (head === -1) throw new Error("同梱の見出しに ja が無い")

  const from = source.indexOf("{", head) + 1
  const to = source.indexOf("\n}", from)
  const messages: Record<string, string> = {}
  for (const line of source.slice(from, to).split("\n")) {
    const match = MESSAGE_LINE.exec(line.trim())
    if (match) messages[match[1]] = match[2] ?? match[3]
  }
  return messages
}

/**
 * 配列を丸ごと切り出す。選択肢の要素も配列なので、深さを数えて閉じ括弧を選ぶ。
 * 引用符の中の括弧は数えない。
 *
 * `at` は開き括弧の位置
 * 戻りは読み切れなければ null
 */
function sliceArray(source: string, at: number): string | null {
  let depth = 0
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === "'" || ch === '"') {
      const end = source.indexOf(ch, i + 1)
      if (end === -1) return null
      i = end
      continue
    }
    if (ch === "[") depth += 1
    else if (ch === "]") {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  return null
}

/**
 * 配列のトップレベルの要素数を数える。読めた組の数と突き合わせる較正に使う。
 *
 * **要素の形を見ないで数える。** 以前は開き括弧の数で数えていたが、それは組を読み取る側
 * （`OPTION`）と同じ手掛かりに依っていた。括弧で始まらない要素（spread・識別子・関数
 * 呼び出し・`.concat`）は両方から見えず、取りこぼしても差が出ない（実測 2026-08-18・
 * CP6 レビュー指摘。4 形すべてで問題 0 件のまま通った）。
 *
 * 区切りの数で数えれば、要素が何で書かれていても 1 つとして立つ。読み取る側と数え方が
 * 違うことが、この照合が成り立つ条件である。
 */
export function countChoices(array: string): number {
  let depth = 0
  let commas = 0
  let filled = false

  for (let i = 0; i < array.length; i += 1) {
    const ch = array[i]
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = array.indexOf(ch, i + 1)
      if (end === -1) break
      i = end
      filled = true
      continue
    }
    if (ch === "[" || ch === "{" || ch === "(") {
      depth += 1
      if (depth > 1) filled = true
      continue
    }
    if (ch === "]" || ch === "}" || ch === ")") {
      depth -= 1
      if (depth === 0) break
      continue
    }
    if (depth === 1 && ch === ",") {
      commas += 1
      filled = false
      continue
    }
    if (depth >= 1 && !" \t\r\n".includes(ch)) filled = true
  }

  // 末尾の区切りは要素を増やさない。中身が続いていたぶんだけ足す
  return commas + (filled ? 1 : 0)
}

/**
 * 1 ブロックの本文から、ドロップダウンの欄と選択肢を読む。
 */
function dropdownsIn(body: string, opcode: string, problems: Problem[]): { name: string, choices: { identifier?: string, literal?: string, value: string }[] }[] {
  const found = []
  let at = 0
  for (;;) {
    const head = body.indexOf("options: [", at)
    if (head === -1) break
    const arrayAt = body.indexOf("[", head)
    at = arrayAt + 1

    const array = sliceArray(body, arrayAt)
    if (array === null) {
      problems.push({
        kind: "選択肢の配列を読み切れない",
        subject: opcode,
        detail: "閉じ括弧が見つからない。上流の書き方が変わった疑いがある",
      })
      continue
    }

    const names = [...body.slice(0, head).matchAll(FIELD_NAME)]
    const name = names.at(-1)?.[1]
    if (name === undefined) {
      problems.push({
        kind: "選択肢の持ち主が分からない",
        subject: opcode,
        detail: "選択肢より前に欄の名前が無い",
      })
      continue
    }

    const choices = [...array.matchAll(OPTION)].map(match => ({
      identifier: match[1],
      literal: match[2] ?? match[3],
      value: match[4] ?? match[5],
    }))

    // 配列の外側で足される形（`[...].concat(EXTRA)`）は、切り出しが配列で終わるため
    // 中身の照合では捕まらない。続きがあること自体を申告する
    const after = body.slice(arrayAt + array.length)
    if (/^\s*\./.test(after)) {
      problems.push({
        kind: "選択肢の配列に続きがある",
        subject: opcode,
        detail: "配列の後ろで選択肢を足しており、読み取りが全体を覆っていない",
      })
    }

    // 取りこぼしは黙って減る。並んでいる数と読めた数が合うことを毎回確かめる
    const listed = countChoices(array)
    if (listed !== choices.length) {
      problems.push({
        kind: "選択肢を読み落としている",
        subject: `${opcode}.${name}`,
        detail: `並んでいるのは ${listed} 組、読めたのは ${choices.length} 組`,
      })
    }

    found.push({ name, choices })
    at = arrayAt + array.length
  }
  return found
}

/**
 * 上流から選択肢の対応を書き出す。
 */
export function deriveOptions(): { options: Record<string, Record<string, Record<string, string>>>, problems: Problem[] } {
  const root = packageRoot()
  const messages = japaneseMessages(root)
  const dir = join(root, "src", "blocks")

  const problems: Problem[] = []
  const options: Record<string, Record<string, Record<string, string>>> = {}

  for (const file of readdirSync(dir).filter(n => n.endsWith(".ts")).sort()) {
    const source = readFileSync(join(dir, file), "utf8")
    const heads = [...source.matchAll(BLOCK_HEAD)]
    heads.forEach((head, i) => {
      const opcode = head[1]
      const body = source.slice(head.index, heads[i + 1]?.index ?? source.length)

      for (const field of dropdownsIn(body, opcode, problems)) {
        const pairs: Record<string, string> = {}
        for (const choice of field.choices) {
          const label = choice.identifier
            ? messages[choice.identifier]
            : choice.literal
          if (label === undefined) {
            problems.push({
              kind: "選択肢の日本語が引けない",
              subject: `${opcode}.${field.name}`,
              detail: `見出し ${choice.identifier} が同梱の ja に無い`,
            })
            continue
          }
          pairs[label] = choice.value
        }
        if (Object.keys(pairs).length === 0) continue
        options[opcode] ??= {}
        options[opcode][field.name] = pairs
      }
    })
  }
  return { options, problems }
}

/**
 * 書き出したものと追跡下の表を突き合わせる。
 *
 * 追跡下にしか無い組も、上流にしか無い組も、値の食い違いも別々に挙げる。1 つの数へ
 * 束ねると、増えたのか減ったのか書き換わったのかが読めなくなる。
 *
 * `tracked` は追跡下の表
 * `derived` は書き出したもの
 */
export function compareOptions(tracked: Record<string, Record<string, Record<string, string>>>, derived: Record<string, Record<string, Record<string, string>>>): { kind: string, at: string, detail: string }[] {
  const differences = []
  const fields = new Set<string>()
  for (const [opcode, byField] of Object.entries(tracked)) {
    for (const field of Object.keys(byField)) fields.add(`${opcode}.${field}`)
  }
  for (const [opcode, byField] of Object.entries(derived)) {
    for (const field of Object.keys(byField)) fields.add(`${opcode}.${field}`)
  }

  for (const at of [...fields].sort()) {
    const [opcode, field] = at.split(".")
    const here = tracked[opcode]?.[field]
    const there = derived[opcode]?.[field]

    if (here === undefined) {
      differences.push({
        kind: "上流にしか無い欄",
        at,
        detail: `${Object.keys(there).length} 組が追跡下に無い`,
      })
      continue
    }
    if (there === undefined) {
      differences.push({
        kind: "追跡下にしか無い欄",
        at,
        detail: `${Object.keys(here).length} 組が上流から導けない`,
      })
      continue
    }

    for (const label of [...new Set([...Object.keys(here), ...Object.keys(there)])].sort()) {
      if (!(label in here)) {
        differences.push({ kind: "上流にしか無い組", at, detail: `${label} => ${there[label]}` })
      } else if (!(label in there)) {
        differences.push({ kind: "追跡下にしか無い組", at, detail: `${label} => ${here[label]}` })
      } else if (here[label] !== there[label]) {
        differences.push({
          kind: "値が食い違う",
          at,
          detail: `${label}: 追跡下 ${here[label]} / 上流 ${there[label]}`,
        })
      }
    }
  }
  return differences
}
