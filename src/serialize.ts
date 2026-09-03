/**
 * 記法の中間表現を .sb3 のブロックの表へ直列化する。
 *
 * .sb3 のブロックは値を直に持たない。入力には「影ブロック」を 1 枚敷き、その中に値を
 * 置く。何を敷くかは台帳が持ち、影ブロックのどの欄へ値を置くかは規則で決まる。
 *
 * 入力の形は影とブロックの有無で 3 通りに分かれる（scratch-vm 5.0.300 の
 * `src/serialization/sb3.js` の `serializeInputs`）。
 *
 * | 形 | 条件 | 表し方 |
 * |---|---|---|
 * | 1 | ブロックと影が同一（覆われていない影）| `[1, 影]` |
 * | 2 | 影が無い（真偽・C 型の中身）| `[2, ブロック]` |
 * | 3 | 両方あって別（影を覆うブロック）| `[3, ブロック, 影]` |
 */
import { createHash } from "node:crypto"
import { PRIMITIVES } from "../catalog/shadows.ts"
import {
  CATALOG_KEYS,
  type CatalogArgument,
  type Entry,
  type LoadedCatalog,
} from "./catalog.ts"
import { PREFIXES, isKind, restored, unrestorable } from "./notation.ts"

/**
 * 名前と ID の組を値に取る原始値。符号の大小では決まらないため opcode で挙げる。
 * 出典は scratch-vm 5.0.300 の `src/serialization/sb3.js` の
 * `serializePrimitiveBlock`。
 */
const NAMED_PRIMITIVES = new Set([
  "event_broadcast_menu",
  "data_variable",
  "data_listcontents",
])

/**
 * 記法の引数の種別のうち、名前と ID の組を要するもの。
 *
 * 変数・リストは作品が宣言し、放送は記法から集める。記法が値を持てないもの
 * （変数とリストの初期値）は定義の側が持つ、という切り分けに従う。
 */
const NAMED_KINDS: Record<string, string> = {
  [`${PREFIXES.MENU}.var`]: "variable",
  [`${PREFIXES.MENU}.list`]: "list",
  [`${PREFIXES.MENU}.broadcast`]: "broadcast",
}

/**
 * ブロックを覆われたときに、下に残る影が取る既定値。
 *
 * 出典は scratch-vm 5.0.300 の `src/serialization/sb2.js`（`shadowObscured` の分岐）。
 * 影は覆われていても消えず、値だけが既定へ戻る。
 */
const OBSCURED: Record<string, string | number> = {
  NUM: 10,
  TEXT: "",
  COLOUR: "#990000",
}

/** 台帳が識別子を持たない記法のうち、原始値として扱うもの（許可リスト）*/
const REPORTERS: Record<string, { primitive: string; kind: string; name?: string }> = {
  readVariable: { primitive: "data_variable", kind: "variable" },
  contentsOfList: { primitive: "data_listcontents", kind: "list" },
}

/**
 * 表を、外から来たキーで引く。表の持ち物だけを見る。
 *
 * 素朴に引くと原型の名前（`constructor`・`toString` 等）が値として返り、関数を値と取り違えた
 * まま先へ進む。台帳の綴りで影ブロックを引く経路では実際に例外で抜けた（CP6 で実測）。
 * `optionValue` と `typeOf` が既に `Object.hasOwn` で塞いでおり、規則をここへ揃える。
 */
function lookup<T>(table: Record<string, T>, key: unknown): T | undefined {
  const name = String(key)
  return Object.hasOwn(table, name) ? table[name] : undefined
}

/**
 * 印を符号位置へ復す。指せない符号位置の印が残っていれば申告して null を返す。
 *
 * 記法と作品定義は人も書くので、桁が合っているだけの綴り（`⟪U+110000⟫`・`⟪U+D800⟫`）
 * が入りうる。復す側で黙って通すと、上限超えは実行時例外になって「こちらの落ち度で
 * ある」と申告され、孤立サロゲートは不正な UTF-16 のまま .sb3 へ入る。入力の誤りと
 * して、書いた場所を示して止める。
 *
 * 戻りは復した綴り。指せない印があれば null
 */
function restoredOrFail(text: string, ctx: Failing, site: Site): string | null {
  const stuck = unrestorable(text)
  if (stuck.length === 0) return restored(text)

  ctx.fail({
    kind: "印が指せない符号位置を書いている",
    subject: stuck.join(" "),
    where: site.label,
    blockIndex: site.blockIndex,
    detail: "符号位置は U+10FFFF までで、U+D800〜U+DFFF は単独で書けない",
  })
  return null
}

/** スクリプトを縦に並べるときの 1 段ぶんの高さの目安。重なりを避けるためだけに使う */
const ROW = 48

/**
 * 記法での書かれ方の類。
 *
 * 同じ綴りが 3 つの役を兼ねる ── 突き合わせの比較の鍵・手掛かりの表の鍵・利用者へ出す
 * 申告の部品である。裸の文字列で散らすと、1 字ずれたときに比較が常に不一致になるか、
 * 手掛かりが黙って消える。
 */
const AS = Object.freeze({ MENU: "メニュー", VALUE: "値", COLOUR: "色" })

/**
 * 記法の子の書かれ方を、台帳と突き合わせられる類へ畳む表。
 *
 * 数と文字を 1 つの類にするのは、Scratch が文字の欄へ数を書くことを許すためである。
 * 分けて数えると正当な記法を止める（追跡下の記法で 5 件が当たった。2026-08-18 実測）。
 * ドロップダウンは `dropdown` と `number-dropdown` の 2 綴りを取るため末尾で見分ける。
 */
const WRITTEN_AS: Record<string, string> = { number: AS.VALUE, string: AS.VALUE, color: AS.COLOUR }

/**
 * 記法の子が知らない形だったときの前置き。突き合わせの側がこの綴りで見分ける。
 *
 * 解析器が形を増やしたことに気づく唯一の手掛かりなので、綴りを 1 か所で持つ。
 */
export const UNKNOWN_SHAPE = "知らない形"

/** 噛み合わない書き方を直すときの手掛かり */
const NOTATION_HINTS: Record<string, string> = {
  [AS.MENU]: "選択肢は [なにか v] の形で書く",
  [AS.VALUE]: "値は (1) か [文字] の形で書く",
  [AS.COLOUR]: "色は [#ff0000] の形で書く",
}

export type Problem = {
  kind: string
  subject: string
  detail?: string
  /** 問題のあるブロックの記法。行番号を引くのに使う */
  where?: string
  /**
   * 問題の出どころのブロックを、辿った順の通し番号で同定する。1 つのブロックが
   * 複数の問題を出したとき、行を引き直さず 1 度だけ引くために使う
   */
  blockIndex?: number
}

/**
 * 突き合わせと手掛かりが読む引数の欄。台帳の項目のうち、実際に触る 3 つだけを要る。
 *
 * `kind` と `options` を省ける形にしてあるのは、どちらも「無い」を意味のある値として
 * 読む（欄でない・選択肢を持たない）ためである。全欄を求めると、呼ぶ側が測りたい欄と
 * 関係ない欄まで組み立てることになり、検査の意図が埋め草に紛れる。
 */
type ArgShape = {
  kind?: CatalogArgument["kind"]
  notation: CatalogArgument["notation"]
  options?: CatalogArgument["options"]
}

/**
 * 記法の子のうち、引数かどうかを見分けるのに要る印。
 *
 * 値を書いた子（`(1)`・`[あか]`）は `isInput`、ブロックを差した子（変数・演算）は
 * `isBlock` を持つ。両方が引数になりうるので、どちらかを持てば引数として数える。
 */
type Child = { isInput?: boolean, isBlock?: boolean }

/** 申告が指す引数の置き場 */
type Site = {
  /** 引数を持つブロックの記法 */
  label: string
  /** 記法での位置（`%1` の番号）*/
  position: number
  /** 出どころのブロックの通し番号 */
  blockIndex: number
  /** 書き手が実際に書いた綴り */
  written?: string | null
}

/** 作品が宣言した名前から ID を引くもの */
type Names = {
  idFor: (kind: string, name: string) => string | null
}

/** 直列化の途中で書き溜める状態。1 回の直列化の中だけで生きる */
type State = {
  blocks: Record<string, any>
  problems: Problem[]
  /** 採番の連番。表へ載せたブロックにだけ付く */
  count: number
  /** 見たブロックの数。表へ載る前に止まったものも数える */
  seenBlocks: number
}

/** 日本語の綴りが複数のブロックで重なっているもの */
type SharedLabels = { sharedLabels: Set<string> }

/** 申告を書き溜める口 */
type Failing = { fail: (problem: Problem) => void }

/**
 * 直列化の道具一式。1 回の直列化の中を持ち回る。
 *
 * `serializeScripts` がその場で組み立てるので、形は完全に分かっている。受け取る側が
 * `any` で受けていたころは、欄の綴りを間違えても `undefined` が返るだけで、値が
 * 入っていないのか綴りが違うのかが同じ顔で出ていた。
 */
type Ctx = SharedLabels &
  Failing & {
    catalog: LoadedCatalog
    names: Names
    state: State
    nextId: () => string
    nextBlockIndex: () => number
    /** 画面を再描画しないブロック定義の綴り。作品定義が挙げる */
    warped: Set<string>
  }

/**
 * Document の全スクリプトを直列化する。
 *
 * 問題は投げずに集めて返す。1 件目で止めると、直せる誤りが 1 つずつしか見えない。
 *
 * `doc` はscratchblocks の Document
 */
export function serializeScripts(
  doc: any,
  // `warped` は省けない。省けると、渡し忘れが「どの定義も再描画する」へ黙って倒れる
  // ── 生成物は成立し検証器も通るので、遅くなったことでしか気づけない。指定が無い
  // ことを言いたい呼び出しは空の並びを渡す（CP6 の保守性・設計原則が指摘）
  context: { catalog: LoadedCatalog, names: Names, warped: string[] },
): { blocks: Record<string, any>, problems: Problem[] } {
  const state: State = { blocks: {}, problems: [], count: 0, seenBlocks: 0 }
  const ctx: Ctx = {
    ...context,
    warped: new Set(context.warped),
    state,
    sharedLabels: sharedLabelsOf(context.catalog),
    nextId: () => `b${(state.count += 1)}`,
    // ID とは別に数える。ID は表へ載せたブロックにしか付かず、載せる前に止まった
    // ブロックの問題が同定を持てない
    nextBlockIndex: () => (state.seenBlocks += 1),
    fail: (problem: Problem) => state.problems.push(problem),
  }

  let y = 0
  for (const script of doc.scripts) {
    emitStack(script.blocks, ctx, { parent: null, topLevel: true, x: 0, y })
    // 帽子は通常のブロックより高く、ブロックの間にも隙間が空く。1 段ぶんの余白では
    // 足りずに次の帽子が触れるので、2 段ぶん空ける
    y += (rows(script.blocks) + 2) * ROW
  }
  return { blocks: state.blocks, problems: state.problems }
}

/**
 * 縦に連なるブロックの並びを直列化し、先頭のブロックの ID を返す。
 */
function emitStack(blocks: any[], ctx: Ctx, place: { parent: string | null, topLevel: boolean, x?: number, y?: number }): string | null {
  let first = null
  let previous = null

  for (const block of blocks) {
    const id = emitBlock(block, ctx, {
      parent: previous ?? place.parent,
      topLevel: place.topLevel && previous === null,
      x: place.x,
      y: place.y,
    })
    if (id === null) continue

    if (previous === null) first = id
    else ctx.state.blocks[previous].next = id
    previous = id
  }
  return first
}

/**
 * ブロック 1 つを直列化して ID を返す。台帳で解けなければ問題を記録して null を返す。
 */
function emitBlock(block: any, ctx: Ctx, place: { parent: string | null, topLevel: boolean, x?: number, y?: number }): string | null {
  const label = describe(block)
  // 問題を出す前に採る。台帳で解けずに戻る経路でも同定が要る
  const blockIndex = ctx.nextBlockIndex()
  const identifier = block.info?.id

  // ブロック定義は台帳の引き当てを通らない。綴りも引数の数も利用者が決めるので、
  // 「識別子 → opcode + 引数」の対応表に収まらない
  const category = String(block.info?.category ?? "")
  if (category === "custom" || category === "custom-arg") {
    return emitCustomBlock(block, ctx, place, blockIndex, label)
  }

  if (!identifier) {
    // 変数とリストのレポーターは識別子を持たない。値として使うぶんは原始値へ畳むが、
    // 単独でスクリプトの先頭に置かれた場合はここへ来る
    ctx.fail({
      kind: "台帳に無いブロック",
      subject: label,
      where: label,
      blockIndex,
      detail: lookup(REPORTERS, block.info?.selector)
        ? "変数とリストのレポーターは値としてのみ扱える"
        : "識別子を持たない記法",
    })
    return null
  }

  const entry = ctx.catalog.byIdentifier.get(identifier)
  if (!entry) {
    ctx.fail({
      kind: "台帳に無いブロック",
      subject: label,
      where: label,
      blockIndex,
      detail: `識別子 ${identifier} が台帳に無い`,
    })
    return null
  }

  // 引数を解けない項は、台帳に載っていても記法から組み立てられない。先に見ないと
  // 下の枝が「中身の数が合わない」と申告し、中身を書いていない利用者を誤誘導する
  if (entry.args === null && (entry.alsoCovers ?? []).length === 0) {
    ctx.fail({
      kind: "台帳が引数を解けないブロック",
      subject: label,
      where: label,
      blockIndex,
      detail:
        `${identifier} は台帳に載っているが引数を解けない。` +
        `記法からは書けない（覆わない範囲の「引数名を取れないブロック」を参照）`,
    })
    return null
  }

  const children = block.children ?? []
  const scripts = children.filter((child: any) => child.isScript)
  const variant = variantFor(entry, scripts.length)
  if (!variant) {
    // 記法からは到達しない。中身の数が合わないのは引数を解けない項だけで、それは
    // 上の枝が先に捕まえる（2026-09-03 に測った）。`alsoCovers` が増えて中身の数の
    // 種類が変わったときの備えとして残す
    ctx.fail({
      kind: "中身の数に合う opcode が無い",
      subject: label,
      where: label,
      blockIndex,
      detail:
        `${identifier} は中身を ${scripts.length} つ持つが、` +
        `台帳のどの opcode もその数の置き場を持たない`,
    })
    return null
  }

  const id = ctx.nextId()
  ctx.state.blocks[id] = {
    opcode: variant.opcode,
    // next と parent は null でも省かない。省くと実行の挙動が変わる
    // （scratch-vm の serializeBlock の注記）
    next: null,
    parent: place.parent,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: place.topLevel,
    ...(place.topLevel ? { x: place.x ?? 0, y: place.y ?? 0 } : {}),
  }

  const given = values(children)
  const order = slotOrder(block, given.length)
  if (order === null) {
    ctx.fail({
      kind: "引数の並び順を決められない",
      subject: label,
      where: label,
      blockIndex,
      detail: `記法の綴りから ${given.length} 個の引数の順を読めない`,
    })
    return null
  }

  fill(variant, arrange(given, order), scripts, ctx, id, label, blockIndex)
  return id
}

/**
 * ブロック定義とその呼び出しを直列化する。
 *
 * 台帳を引かない。綴りと引数の数を利用者が決めるので、「識別子 → opcode + 引数」の
 * 対応表に収まらない ── 台帳が持つのは opcode と、引数を利用者が決めるという申告だけ
 * である。
 *
 * 綴りと引数名は解析器が決めた値（`info.call` / `info.names`）から取る。定義と
 * 呼び出しを結ぶのはこの綴りだけなので、両側で別々に組み直すと結び付かない。
 */
function emitCustomBlock(
  block: any,
  ctx: Ctx,
  place: { parent: string | null, topLevel: boolean, x?: number, y?: number },
  blockIndex: number,
  label: string,
): string | null {
  const info = block.info ?? {}
  const children = block.children ?? []

  if (info.shape === "define-hat") {
    // 綴りと引数名は解析器が既に決めている（`info.call` / `info.names`）。子から
    // 組み直すと、解析器が定義と呼び出しを結ぶのに使った正規化（大小・空白・記号）を
    // こちらが持たないぶんだけ綴りが割れる。実測 2026-09-03: `定義 Draw (n)` と
    // `draw (5)` を解析器は結ぶが、組み直した綴りは割れて呼び出しが死んだ
    return emitDefinition(block, ctx, place, blockIndex, label)
  }

  if (info.id === "PROCEDURES_CALL") {
    return emitCall(block, ctx, place, blockIndex, label)
  }

  if (info.selector === "getParam") {
    const name = textOf(children[0])
    if (name === undefined || name === "") {
      ctx.fail({
        kind: "ブロック定義の形が読めない",
        subject: label,
        where: label,
        blockIndex,
        detail: "引数の名前を読めない",
      })
      return null
    }
    const id = ctx.nextId()
    // 定義の側で宣言した名前をそのまま持つ。Scratch は名前で引数を引くので、
    // 定義と綴りが違うと実行時に空の値になる
    ctx.state.blocks[id] = {
      opcode: "argument_reporter_string_number",
      next: null,
      parent: place.parent,
      inputs: {},
      fields: { VALUE: [name, null] },
      shadow: false,
      topLevel: place.topLevel,
      ...(place.topLevel ? { x: place.x ?? 0, y: place.y ?? 0 } : {}),
    }
    return id
  }

  ctx.fail({
    kind: "ブロック定義の形が読めない",
    subject: label,
    where: label,
    blockIndex,
    detail: `${info.shape ?? "形の無い部品"} は扱えない`,
  })
  return null
}

/**
 * プロトタイプの中身から、呼び出しの綴りと引数名を読む。
 *
 * `proccode` はラベルを並べ、引数の位置へ `%s` を置いた綴りである。Scratch は
 * これで定義と呼び出しを結ぶので、両者が 1 文字でも違えば別のブロックになる。
 */
function procedureShape(
  info: { call?: unknown, names?: unknown } | undefined,
  ctx: Failing,
  site: Site,
): { proccode: string, names: string[] } | null {
  const call = typeof info?.call === "string" ? info.call : ""
  if (call === "") return null

  // 真偽の引数は扱わない。黙って文字の引数へ倒すと、Scratch では値の入らない
  // ブロックが出て、しかも生成は成功する（作業書の非目標は書き分けを免除するが、
  // 黙ることは免除していない）
  if (call.includes("%b")) {
    ctx.fail({
      kind: "真偽の引数は扱えない",
      subject: site.label,
      where: site.label,
      blockIndex: site.blockIndex,
      detail: "ブロック定義の引数は <> でなく () か [] で書く",
    })
    return null
  }

  // 上流の綴りを Scratch の綴りへ直す。上流は数と文字を分けるが、Scratch の
  // `argument_reporter_string_number` はどちらも `%s` で表す
  const proccode = call.replace(/%[ns]/g, "%s")
  const names = (Array.isArray(info?.names) ? info.names : []).map(String)

  // 名前の無い引数は、本体から参照する手が無い。Scratch は引数を名前で引くので、
  // 空の名前を持つ引数は置き場だけがあって値を取り出せない状態になる。生成物は
  // 成立し公式検証器も通るため、開くまで気づけない（CP6 で実測）
  const 名無し = names.filter(name => name.trim() === "").length
  if (名無し > 0) {
    ctx.fail({
      kind: "ブロック定義の引数に名前が無い",
      subject: site.label,
      where: site.label,
      blockIndex: site.blockIndex,
      detail: `${名無し} 個の引数が名前を持たない。括弧の中に名前を書く`,
    })
    return null
  }
  return { proccode, names }
}

/**
 * ブロック定義の綴りと引数名を、印から符号位置へ復す。
 *
 * 記法の他の綴り（値・欄・変数の名前）はすべて `restoredOrFail` を通っている。
 * ここを通さないと、`⟪U+000A⟫` と書いた綴りが印のまま .sb3 へ入り、Scratch の
 * 画面には印の文字列が出る（同じ記法から出た図とも食い違う）。
 *
 * 戻りは復した組。指せない印があれば null（`restoredOrFail` が申告する）
 */
function restoredSpelling(
  shape: { proccode: string, names: string[] },
  ctx: Failing,
  site: Site,
): { proccode: string, names: string[] } | null {
  const proccode = restoredOrFail(shape.proccode, ctx, site)
  if (proccode === null) return null
  const names: string[] = []
  for (const name of shape.names) {
    const restoredName = restoredOrFail(name, ctx, site)
    if (restoredName === null) return null
    names.push(restoredName)
  }
  return { proccode, names }
}

/** 記法の部品が持つ綴りを取る。ラベルと値で置き場が違う */
function textOf(node: { value?: unknown, label?: { value?: unknown } } | undefined) {
  const text = node?.value ?? node?.label?.value
  return typeof text === "string" ? text : undefined
}

/**
 * 作品定義に書いたブロック定義の名前を、内部の綴り（`proccode`）へ直す。
 *
 * 利用者は記法へ書いたのと同じ形（`しかくをかく (へん)`）で書く。`%s` は Scratch の
 * 内部の綴りで、画面のどこにも現れない ── それを作品定義へ書かせると、写すだけで
 * 済むはずのものを覚え直させることになる。
 *
 * 引数の位置は括弧で見分ける。中身の名前は捨てる ── 定義側と呼び出し側で引数名が
 * 違っても Scratch は同じブロックとして扱うので、綴りの一致に名前は要らない。
 *
 * **記法の側と同じゆれを吸収する。** 記法は解析器が全角の括弧を直し空白を畳んでから
 * 定義と呼び出しを結ぶ。こちらが吸収しないと、画面で見分けの付かない 2 つの綴りを
 * 並べて「記法に無い」と申告することになる（CP6 で実測。全角の括弧も二重の空白も
 * 止まっていた）。
 */
export function asProccode(written: string): string {
  return written
    // 全角の括弧を半角へ。日本語入力では全角が既定で出る
    .replace(/[（［]/g, "(")
    .replace(/[）］]/g, ")")
    .replace(/[([][^()[\]]*[)\]]/g, "%s")
    // 空白を 1 つへ畳む。全角の空白も空白として扱う
    .replace(/[\s　]+/g, " ")
    .trim()
}

/**
 * 引数の ID を綴りと位置から導く。
 *
 * 無作為に振ると同じ入力から同じ .sb3 が出ない。定義と呼び出しが同じ ID を使う
 * 必要もあり、両者で別々に採ると引数が結びつかない。ブロックの ID（`b1`）とは
 * 別の名前空間にして衝突を避ける。
 *
 * **綴りは要約して持つ。** そのまま埋めると `argumentids` が引数の数 × 綴りの長さで
 * 増える ── 引数を N 個持つブロックは、N 個の ID それぞれに綴り全体を抱えるので
 * 二乗で伸びる（N=100/200/400 で ×3.93・×3.96 を実測。CP6）。要約なら長さが一定で、
 * 決定性も定義と呼び出しの一致も保たれる。
 */
function argumentId(proccode: string, index: number): string {
  const mark = createHash("sha256").update(proccode).digest("hex").slice(0, 12)
  return `arg:${mark}:${index}`
}

/** 定義の帽子と、その中のプロトタイプを組み立てる */
function emitDefinition(
  hat: { info?: { call?: unknown, names?: unknown } },
  ctx: Ctx,
  place: { parent: string | null, topLevel: boolean, x?: number, y?: number },
  blockIndex: number,
  label: string,
): string | null {
  const site = { label, position: 0, blockIndex }
  const shape = procedureShape(hat.info, ctx, site)
  if (!shape) {
    // `procedureShape` は真偽の引数を自分で申告する。綴りを取れなかったときだけ
    // ここが申告する（申告を 2 件並べない）
    if (typeof hat.info?.call !== "string" || hat.info.call === "") {
      ctx.fail({
        kind: "ブロック定義の形が読めない",
        subject: label,
        where: label,
        blockIndex,
        detail: "作るブロックの綴りを読めない",
      })
    }
    return null
  }
  const spelling = restoredSpelling(shape, ctx, site)
  if (!spelling) return null
  const { proccode, names } = spelling

  const id = ctx.nextId()
  const prototype = ctx.nextId()
  ctx.state.blocks[id] = {
    opcode: "procedures_definition",
    next: null,
    parent: place.parent,
    inputs: { custom_block: [1, prototype] },
    fields: {},
    shadow: false,
    topLevel: place.topLevel,
    ...(place.topLevel ? { x: place.x ?? 0, y: place.y ?? 0 } : {}),
  }

  // 引数はプロトタイプの中に影として差す。呼び出し側は同じ ID を鍵に値を入れるので、
  // 並びが食い違うと引数が入れ替わる（公式検証器は構造しか見ないので気づかない）
  const inputs: Record<string, any> = {}
  names.forEach((name, index) => {
    const slot = argumentId(proccode, index)
    const reporter = ctx.nextId()
    inputs[slot] = [1, reporter]
    ctx.state.blocks[reporter] = {
      opcode: "argument_reporter_string_number",
      next: null,
      parent: prototype,
      inputs: {},
      fields: { VALUE: [name, null] },
      shadow: true,
      topLevel: false,
    }
  })

  // プロトタイプは影として定義の中に差す。呼び出しと同じ mutation を持ち、
  // 両者の綴りが食い違うと Scratch が別のブロックとして扱う
  ctx.state.blocks[prototype] = {
    opcode: "procedures_prototype",
    next: null,
    parent: id,
    inputs,
    fields: {},
    shadow: true,
    topLevel: false,
    mutation: procedureMutation(proccode, names, ctx.warped.has(proccode)),
  }
  return id
}

/** 呼び出しを組み立てる */
function emitCall(
  block: any,
  ctx: Ctx,
  place: { parent: string | null, topLevel: boolean, x?: number, y?: number },
  blockIndex: number,
  label: string,
): string | null {
  // 綴りは解析器が既に決めている。子から組み直すと引数がブロック（変数・演算・
  // レポーター）のときに `isInput` が立たず、綴りからも値からも同時に落ちる
  // （実測 2026-09-03: `えがく (スコア)` が `えがく` になり、定義に結び付かなかった）
  const site = { label, position: 0, blockIndex }
  const shape = procedureShape(block.info, ctx, site)
  if (!shape) {
    if (typeof block.info?.call !== "string" || block.info.call === "") {
      ctx.fail({
        kind: "ブロック定義の形が読めない",
        subject: label,
        where: label,
        blockIndex,
        detail: "呼び出しの綴りを読めない",
      })
    }
    return null
  }
  const spelling = restoredSpelling(shape, ctx, site)
  if (!spelling) return null
  const { proccode, names } = spelling

  // 引数は解析器が数えた位置に居る。値を持つ子（`isInput`）とブロックの子の
  // 両方が引数になりうるので、ラベルでない子をすべて拾う
  const given: Child[] = (block.children ?? []).filter(
    (child: Child) => child.isInput || child.isBlock,
  )
  if (given.length !== names.length) {
    ctx.fail({
      kind: "引数の数が記法と合わない",
      subject: label,
      where: label,
      blockIndex,
      detail: `綴りは ${names.length} 個の引数を持つが記法は ${given.length} 個渡す`,
    })
    return null
  }

  const id = ctx.nextId()
  // 定義と同じ規則で ID を導く。ここで別々に採ると、定義の引数と呼び出しの値が
  // 結びつかず、Scratch は既定値を使う（呼び出しに書いた値が黙って消える）
  const inputs: Record<string, any> = {}
  given.forEach((child, index) => {
    const value = inputValue(
      // 呼び出しの引数は文字の影を敷く。Scratch のエディタが作る .sb3 と同じ形で、
      // 影が無いと値を直接書けない。台帳から引かず組み立てるのは、綴りも数も
      // 利用者が決めるためである
      {
        name: argumentId(proccode, index),
        kind: "input",
        notation: "%s",
        shadow: "text",
        shadowFrom: null,
        shadowField: null,
        options: null,
        optionsFrom: null,
        namesAllowed: false,
      },
      child,
      ctx,
      id,
      { label, position: index + 1, blockIndex },
    )
    if (value) inputs[argumentId(proccode, index)] = value
  })

  ctx.state.blocks[id] = {
    opcode: "procedures_call",
    next: null,
    parent: place.parent,
    inputs,
    fields: {},
    shadow: false,
    topLevel: place.topLevel,
    ...(place.topLevel ? { x: place.x ?? 0, y: place.y ?? 0 } : {}),
    // 引数名は解析器が呼び出しの側にも持たせる（`info.names`）。定義と同じ名前を
    // 書いて、Scratch のエディタが作る .sb3 と同じ形にする。
    //
    // **以前は「呼び出しの記法からは読めない」として空で置いていた。** 綴りを子から
    // 組み直していたころの制約で、解析器の値を使うようになった時点で偽になっていた
    // （CP6 の測り直しで発覚。2026-09-04）。空でも実機で値は渡るので、害があったのは
    // 宣言の側だけである
    mutation: procedureMutation(proccode, names, ctx.warped.has(proccode)),
  }
  return id
}

/**
 * 定義と呼び出しが共有する mutation。
 *
 * 1 か所で組むのは、定義と呼び出しで別々に作ると綴りや引数の並びが食い違うためである。
 * 食い違っても構造は正しいので、公式検証器は通してしまう。
 *
 * `warp` は作品定義の `再描画しないブロック` が決める。記法はスクリプトしか表せず、
 * この指定はブロック 1 つでなく定義そのものに掛かるためである。
 */
function procedureMutation(proccode: string, names: string[], warp: boolean) {
  return {
    tagName: "mutation",
    children: [],
    proccode,
    argumentids: JSON.stringify(names.map((_, index) => argumentId(proccode, index))),
    argumentnames: JSON.stringify(names),
    // 既定値は空文字にする。Scratch のエディタが作る .sb3 と同じ形
    argumentdefaults: JSON.stringify(names.map(() => "")),
    // 定義と呼び出しで食い違うと Scratch は定義の側を見る。同じ値を入れて揃える
    warp: warp ? "true" : "false",
  }
}

/**
 * 記法が引数を並べる順を、英語の記法の `%1 %2` の順へ直す表を作る。
 *
 * 日本語のラベルは語順が違い、引数を入れ替えて並べるものがある（`%2 の %1 番目` 等。
 * 台帳の 128 件のうち 8 件）。台帳の引数は英語の順に並ぶため、表示の順で素朴に
 * 対応させると隣の引数へ値が入る。
 *
 * この誤りは下流のどの検査にも掛からない。公式検証は構造しか見ず、往復検査は
 * ブロックの識別子列で比べるため、引数が入れ替わっても一致する。ここで防ぐしかない。
 *
 * 綴りは解析器が照合に使ったもの（`info.language`）から取る。台帳の日本語ラベルを
 * 使うと、解析器の辞書とずれたときに気づけない。
 *
 * `count` は値として渡された子の数
 * 戻りは表示の位置から英語の記法の位置へ引く表
 */
function slotOrder(block: any, count: number): number[] | null {
  if (count === 0) return []

  const spec = block.info?.language?.commands?.[block.info?.id]
  if (!spec) return null

  const order = [...spec.matchAll(/%(\d+)/g)].map(match => Number(match[1]) - 1)
  if (order.length !== count) return null
  // 位置の取り違えを黙って通さない。順序が 0..count-1 の並べ替えでなければ諦める
  if (new Set(order).size !== count) return null
  if (order.some(slot => slot < 0 || slot >= count)) return null
  return order
}

/**
 * 表示の順で並んだ子を、英語の記法の順へ並べ替える。
 */
function arrange(given: any[], order: number[]) {
  const bySlot: any[] = []
  order.forEach((slot, display) => {
    bySlot[slot] = given[display]
  })
  return bySlot
}

/**
 * 引数を埋める。値と中身は台帳の引数の並びに順で対応する。
 *
 * `given` は値として渡された子（入力と入れ子のブロック）
 * `scripts` はC 型の中身
 * `label` は問題の報告に使う記法の文字列
 * `blockIndex` は問題の出どころを同定する通し番号
 */
function fill(
  variant: { opcode: string, args: CatalogArgument[], ja?: string | null },
  given: any[],
  scripts: any[],
  ctx: Ctx,
  id: string,
  label: string,
  blockIndex: number,
) {
  const slots = variant.args.filter(arg => arg.kind !== "statement")
  if (slots.length !== given.length) {
    ctx.fail({
      kind: "引数の数が記法と合わない",
      subject: label,
      where: label,
      blockIndex,
      detail: `台帳は ${slots.length} 個の引数を持つが記法は ${given.length} 個渡す`,
    })
    return
  }

  const block = ctx.state.blocks[id]
  let slot = 0
  let nest = 0

  for (const arg of variant.args) {
    if (arg.kind === "statement") {
      const script = scripts[nest]
      nest += 1
      const first = emitStack(script?.blocks ?? [], ctx, {
        parent: id,
        topLevel: false,
      })
      // 空の中身は入力を持たない。`[2, null]` と書くと空でないものとして扱われる
      if (first !== null) block.inputs[arg.name] = [2, first]
      continue
    }

    const child = given[slot]
    // 記法での位置。台帳の引数の並びは英語の記法の `%1 %2` に対応し、
    // ブロック解説の一覧も同じ番号で引数を示す
    const position = slot + 1
    slot += 1

    const mismatch = mismatchOf(arg, child, ctx, variant.ja)
    if (mismatch) {
      ctx.fail({
        kind: "引数の書き方が台帳と噛み合わない",
        subject: subjectOf({ label, position, written: literal(child) }),
        where: label,
        blockIndex,
        detail: mismatch,
      })
      // 埋めずに次へ移る。埋めると同じ引数について 2 通りの申告が並び、どちらを
      // 直せばよいのか読めなくなる
      continue
    }

    if (arg.kind === "field") {
      const site = { label, position, blockIndex, written: literal(child) }
      const value = fieldValue(arg, child, ctx, site)
      if (value !== null) block.fields[arg.name] = value
      continue
    }

    const input = inputValue(arg, child, ctx, id, {
      label,
      position,
      blockIndex,
      written: literal(child),
    })
    if (input !== null) block.inputs[arg.name] = input
  }
}

/**
 * 記法の書き方と台帳の引数が噛み合わないかを見る。噛み合えば null を返す。
 *
 * 記法は書き方で意味が変わる。`[なにか v]` はドロップダウン、`[なにか]` は文字、
 * `(1)` は数、`[#ff0000]` は色である。台帳はどれを受ける欄かを持つのに、これまで
 * 突き合わせていなかった。日本語の綴りが衝突するブロックを取り違えたとき、書き方の
 * 食い違いが唯一の手掛かりになりうる。
 *
 * 知らない形の申告は検査から呼べるよう export する。実物の記法からは作れない
 * （作れたら知っている形である）ので、外から形を渡して測る以外に確かめようがない。
 *
 * `arg` は台帳の引数
 * `child` は記法の子
 * `ja` はこのブロックの日本語ラベル
 * 戻りは噛み合わなければ理由
 */
export function mismatchOf(arg: ArgShape, child: any, ctx: SharedLabels, ja: string | null | undefined): string | null {
  const written = writtenAs(child)
  if (written === null) return null

  // 知らない形は、突き合わせの外に置いた引数でも申告する。期待の側の null で先に返すと、
  // 外した引数の範囲だけ未知の形が素通りし、解析器が形を増やしたことに誰も気づかない
  if (written.startsWith(UNKNOWN_SHAPE)) {
    return `${written}が書かれている。記法の書き方を確かめる`
  }

  // 数にドロップダウンが付く入力だけ、書かれ方でなく書かれた値で見る。上流に
  // ドロップダウンの定義が無いので、選択肢の見た目か素の文字かは問題でなく、
  // 「数として読めるか」だけが問題になる（`[右]` も `[右 v]` も同じ誤り）
  if (isKind(arg.notation, PREFIXES.NUMBER_MENU)) return numberMismatch(child)

  const want = expectedAs(arg)
  if (want === null || written === want) return null

  // `#` に 16 進が続く綴りは、どの欄に書かれていても解析器が色と読む。値の欄では
  // 正当な文字（`[#ff0000] と言う`）なので止めない
  if (want === AS.VALUE && written === AS.COLOUR) return null

  const hint = valueHint(arg, written, ctx, ja)
  return `${want}を受ける欄に${written}が書かれている。${hint}`.trim()
}

/**
 * 値の欄へ別の書き方をしたときの手掛かりを選ぶ。
 *
 * `arg` は台帳の引数
 * `written` は記法での書かれ方
 */
function valueHint(arg: ArgShape, written: string, ctx: SharedLabels, ja: string | null | undefined): string {
  const want = expectedAs(arg)
  if (want !== AS.VALUE || written !== AS.MENU) return hintFor(want ?? "")
  return menuInValueHint(ctx, ja)
}

/**
 * 数にドロップダウンが付く入力へ書かれた値が、数として読めるかを見る。
 *
 * 上流 `scratch-blocks` は該当の 5 引数をいずれも素の入力として定義し、ドロップダウンを
 * 持たない（2026-08-19 実測）。よって `[右 v]`（選択肢の見た目）も `[右]`（素の文字）も
 * 同じ誤りで、どちらも `math_angle` へ「右」という文字が入った .sb3 が問題 0 件で出ていた。
 *
 * 書かれ方でなく書かれた値で見るのは、この 2 つを 1 つの規則で捕まえるためである。書かれ方
 * で見ると綴りの軸しか塞がらず、素の文字で書く軸が開いたまま残る（CP6 で実測）。
 *
 * `child` は記法の子
 * 戻りは数として読めれば null
 */
function numberMismatch(child: any): string | null {
  const text = literal(child)
  // ブロックが差されていればこの検査の外。空欄は別の経路が受け持つ
  if (text === null || text.trim() === "") return null
  if (Number.isFinite(Number(text))) return null
  return `数を受ける欄に「${text}」が書かれている。${NUMBER_HINT}`
}

/** 数の欄へ数でない値を書いたときの手掛かり */
const NUMBER_HINT = "選択肢の見た目でも書けるが値は文字として入るため、数そのものを書く"

/**
 * 書き方の類から手掛かりを引く。持たない類は隠さず印を返す。
 *
 * `?? ""` で空へ落とすと、類を 1 つ足して表への追記を忘れたときに、手掛かりの無い申告が
 * 黙って出る。仕様の穴は隠さず見せる（`definition.ts` の `omissionOf` と同じ形）。
 * 表の持ち物だけを見るのは、原型の名前（`toString` 等）が手掛かりとして通らないようにするため。
 *
 * `want` は台帳が期待する書き方の類
 */
function hintFor(want: string): string {
  return Object.hasOwn(NOTATION_HINTS, want) ? NOTATION_HINTS[want] : `(${want} の手掛かりが無い)`
}

/**
 * 値の欄へメニューを書いたときの手掛かり。
 *
 * `v` を外せとは言わない。日本語の綴りが重なるブロックでは、外した綴りが別のブロックと
 * して読まれ、問題 0 件のまま意図と違う .sb3 が出る（`([記録 v] の長さ)` を止めたあと
 * `([記録] の長さ)` へ直すと、リストの長さでなく文字列の長さになる。2026-08-18 実測）。
 *
 * `ja` はこのブロックの日本語ラベル。
 */
function menuInValueHint(ctx: SharedLabels, ja: string | null | undefined) {
  if (ja && ctx.sharedLabels?.has(ja)) {
    return (
      "この綴りは台帳で重なっており、別のブロックとして読まれた疑いがある。" +
      "v を外すと重なった側のブロックになるため、意図したブロックの綴りを確かめる"
    )
  }
  return "この欄は値を受ける。選択肢のつもりなら、意図したブロックの綴りを確かめる"
}

/**
 * 日本語の綴りが 2 件以上のブロックで重なっているものを集める。
 *
 * 重なる綴りは記法から一方しか呼べない（TASK0001 で 6 組と実測）。手掛かりを出すとき、
 * 重なっているかどうかで言うべきことが変わるため、事実として持つ。
 */
function sharedLabelsOf(catalog: LoadedCatalog): Set<string> {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const block of catalog?.raw?.[CATALOG_KEYS.BLOCKS] ?? []) {
    if (!block.ja) continue
    if (seen.has(block.ja)) shared.add(block.ja)
    seen.add(block.ja)
  }
  return shared
}

/**
 * 台帳の引数が期待する書かれ方。突き合わせない引数は null を返す。
 *
 * 検査から呼べるよう export する。突き合わせの外に置いた引数（真偽・数にドロップダウンが
 * 付く入力）を規則の側から測れないと、除外が正しいかを緑では確かめられない。
 *
 * `arg` は台帳の引数
 */
export function expectedAs(arg: ArgShape): string | null {
  // 真偽の入力は「影を持たない入力に値を書けない」が受け持つ。二重に申告しない
  if (isKind(arg.notation, PREFIXES.BOOLEAN)) return null
  if (arg.kind === "field" || arg.options) return AS.MENU
  // 選択肢が作品ごとに決まるメニュー（放送・音・コスチューム）は台帳の選択肢が空になる。
  // 選択肢の有無でなく記法の綴りで見分ける
  if (isKind(arg.notation, PREFIXES.MENU)) return AS.MENU
  if (isKind(arg.notation, PREFIXES.COLOUR)) return AS.COLOUR
  return AS.VALUE
}

/**
 * 記法の子がどう書かれたか。ブロックが差されていれば null（この検査の外）。
 *
 * 知らない形は黙って通さない。解析器が形を増やしたとき、素通しすると検査が静かに
 * 効かなくなる。この「素通ししない」判断を検査から測れるよう export する。
 *
 * `child` は記法の子
 */
export function writtenAs(child: any): string | null {
  if (child === undefined || child.isBlock || child.value?.isBlock) return null
  // 子は入力かブロックしか無く、個数も呼ぶ側が揃えてあるので、ここへは来ない。
  // 解析器が子の種類を増やしたときの保険として残す
  if (!child.isInput) return null

  const shape = String(child.shape ?? "")
  if (shape.endsWith("dropdown")) return AS.MENU
  return lookup(WRITTEN_AS, shape) ?? `${UNKNOWN_SHAPE}（${shape || "無い"}）`
}

/**
 * 欄の値を決める。欄は影を敷かず、ブロックに値を直接書く。
 *
 * `arg` は台帳の引数
 * `child` は記法の子
 */
function fieldValue(arg: CatalogArgument, child: any, ctx: Ctx, site: Site): any[] | null {
  const text = literal(child)
  if (text === null) {
    ctx.fail({
      kind: "欄にブロックを差せない",
      subject: subjectOf(site),
      where: site.label,
      blockIndex: site.blockIndex,
      detail: "この引数は値を直接書く欄で、ブロックを入れる場所ではない",
    })
    return null
  }

  const chosen = optionValue(arg, text, ctx, site)
  if (chosen === null) return null

  // 記法へ載せるために印へ変えた符号位置を、.sb3 へ入れる前に復す。名前も値も同じ
  // 規則で復す ── 名前を突き合わせる相手（作品定義）も同じ規則で復すので、綴りは
  // 揃ったまま元へ戻る
  const value = restoredOrFail(chosen, ctx, site)
  if (value === null) return null

  const kind = lookup(NAMED_KINDS, arg.notation)
  if (!kind) return [value, null]

  const id = ctx.names.idFor(kind, value)
  if (id === null) {
    ctx.fail({
      // 申告は記法に書かれている綴りで指す。復した後の綴りを渡すと、記法にも作品定義に
      // も実在しない文字列を指し、その申告を頼りに直そうとしても当たらない（CP6 で実測）
      kind: `${noun(kind)}が宣言されていない`,
      subject: chosen,
      where: site.label,
      blockIndex: site.blockIndex,
    })
    return null
  }
  return [value, id]
}

/**
 * 入力の値を決める。影の有無と、ブロックが差されているかで形が 3 通りに分かれる。
 *
 * `arg` は台帳の引数
 * `child` は記法の子
 * `parent` は入力を持つブロックの ID
 */
function inputValue(arg: CatalogArgument, child: any, ctx: Ctx, parent: string, site: Site): any[] | null {
  const nested = asBlock(child)
  const reporter = nested ? null : asReporter(child)

  if (nested || reporter) {
    const inner = nested
      ? emitBlock(nested, ctx, { parent, topLevel: false })
      : namedPrimitive(reporter as any, ctx, site)
    if (inner === null) return null

    // 影を持たない入力（真偽・C 型の中身）はブロックだけを収める
    if (!arg.shadow) return [2, inner]

    const beneath = obscured(arg, ctx, parent, site)
    return beneath === null ? null : [3, inner, beneath]
  }

  const text = literal(child)
  if (text === null) return null

  if (!arg.shadow) {
    // 真偽の入力に値は書けない。空の `<>` は子ごと現れないためここへ来ない
    ctx.fail({
      kind: "影を持たない入力に値を書けない",
      subject: subjectOf(site),
      where: site.label,
      blockIndex: site.blockIndex,
      detail: `${arg.notation} はブロックだけを受ける`,
    })
    return null
  }

  const filled = optionValue(arg, text, ctx, site)
  if (filled === null) return null
  const shadow = shadowFor(arg, filled, ctx, parent, site)
  return shadow === null ? null : [1, shadow]
}

/**
 * 影ブロックを作る。原始値へ畳めるものは配列で表し、畳めないもの（メニュー）は
 * ブロックとして表に足して ID を返す。
 *
 * `arg` は台帳の引数
 * `value` は欄へ置く値
 */
function shadowFor(arg: CatalogArgument, value: string, ctx: Ctx, parent: string, site: Site): any[] | string | null {
  // 印を復すのは .sb3 へ入れる直前の 1 か所にする（`fieldValue` と同じ理由）
  const spelling = restoredOrFail(value, ctx, site)
  if (spelling === null) return null
  const primitive = lookup(PRIMITIVES, arg.shadow)
  if (primitive) {
    const [code] = primitive
    // ここへ来た時点で影の綴りは表の鍵として引けている（`lookup` が返した）
    const shadow = String(arg.shadow)
    if (!NAMED_PRIMITIVES.has(shadow)) return [code, spelling]

    const kind = kindOfPrimitive(shadow)
    const id = ctx.names.idFor(kind, spelling)
    if (id === null) {
      ctx.fail({
        // 申告は記法の綴りで指す（`fieldValue` と同じ理由）
        kind: `${noun(kind)}が宣言されていない`,
        subject: value,
        where: site.label,
        blockIndex: site.blockIndex,
      })
      return null
    }
    return [code, spelling, id]
  }

  // メニューの影は原始値へ畳めない。ブロックとして表に置く
  const id = ctx.nextId()
  ctx.state.blocks[id] = {
    opcode: arg.shadow,
    next: null,
    parent,
    inputs: {},
    fields: { [fieldNameOf(arg)]: [spelling, null] },
    shadow: true,
    topLevel: false,
  }
  return id
}

/**
 * 影ブロックの値を置く欄の名前を決める。
 *
 * 出典は scratch-vm 5.0.300 の `src/serialization/sb2.js`。「影ブロックの欄名は入力名と
 * 一致する。ただし次を除く」とあり、除外は原始値の表が持つ欄名に一致する。よって
 * 表を手で書かずに済む。
 *
 * `arg` は台帳の引数
 */
function fieldNameOf(arg: CatalogArgument) {
  const primitive = lookup(PRIMITIVES, arg.shadow)
  if (primitive) return primitive[1]
  // メニューの影は規則（欄の名前は入力名と同じ）で決まる。規則から外れるものだけ
  // 台帳が持つ。拡張機能のメニューは欄の名前が入力名と別に決まる
  return arg.shadowField ?? arg.name
}

/**
 * 覆われた入力の下に残る影を作る。影は消えず、値だけが既定へ戻る。
 */
function obscured(arg: CatalogArgument, ctx: Ctx, parent: string, site: Site) {
  const field = fieldNameOf(arg)
  const value = lookup(OBSCURED, field) ?? ""
  return shadowFor(arg, String(value), ctx, parent, site)
}

/**
 * 日本語のラベルを内部値へ直す。表を持たない引数は書かれた名前がそのまま値になる。
 */
function optionValue(arg: CatalogArgument, text: string, ctx: Ctx, site: Site): string | null {
  if (!arg.options) return text

  // 表の持ち物だけを見る。素朴に引くと Object.prototype の名前（`toString` 等）が
  // 解決済みの値として通り、欄が壊れた .sb3 が問題 0 件で出る
  if (Object.hasOwn(arg.options, text)) return arg.options[text]
  // 決まった選択肢と作品ごとの名前を混ぜて取るドロップダウンは、表に無い綴りが
  // スプライト名やコスチューム名でありうる。名前として通す
  if (arg.namesAllowed) return text

  // 個数だけを返すと、書き手は直す手掛かりを持たないまま止まる。台帳が綴りを持っている
  // のだから並べる。最も長い欄（キー）でも 42 件・105 文字で 1 行に収まる（2026-08-19 実測）
  ctx.fail({
    kind: "選択肢に無いラベル",
    subject: subjectOf(site),
    where: site.label,
    blockIndex: site.blockIndex,
    detail: `${text} は選択肢に無い。書けるのは ${Object.keys(arg.options).join("・")}`,
  })
  return null
}

/**
 * 変数・リストのレポーターを原始値へ畳む。
 */
function namedPrimitive(reporter: { primitive: string, kind: string, name: string }, ctx: Ctx, site: Site): any[] | null {
  const [code] = lookup(PRIMITIVES, reporter.primitive) ?? []
  // 記法から読んだ名前も印を持ちうる（`(スコア)` の形）。他の 2 経路と同じ規則で復す
  const name = restoredOrFail(reporter.name, ctx, site)
  if (name === null) return null
  const id = ctx.names.idFor(reporter.kind, name)
  if (id === null) {
    ctx.fail({
      // 申告は記法の綴りで指す（`fieldValue` と同じ理由）
      kind: `${noun(reporter.kind)}が宣言されていない`,
      subject: reporter.name,
      where: site.label,
      blockIndex: site.blockIndex,
    })
    return null
  }
  return [code, name, id]
}

/**
 * 記法の子のうち、値として渡されるものを順に拾う。
 *
 * 入れ子のブロックは `isBlock` として直に現れることも、入力の中身として現れることも
 * ある。どちらも 1 つの引数を占める。
 */
function values(children: any[]) {
  return children.filter(child => child.isInput || child.isBlock)
}

/** 子がブロックなら取り出す。変数・リストのレポーターは含めない */
function asBlock(child: any) {
  const block = child.isBlock ? child : child.isInput && child.value?.isBlock ? child.value : null
  if (!block) return null
  return REPORTERS[block.info?.selector] && !block.info?.id ? null : block
}

/** 子が変数・リストのレポーターなら、その種別と名前を返す */
function asReporter(child: any) {
  const block = child.isBlock ? child : child.isInput && child.value?.isBlock ? child.value : null
  if (!block || block.info?.id) return null
  const reporter = REPORTERS[block.info?.selector]
  if (reporter) return { ...reporter, name: nameOf(block) }
  // リスト内容のレポーターは選択子も持たない。カテゴリで見分ける
  if (block.info?.category === "list") {
    return { ...REPORTERS.contentsOfList, name: nameOf(block) }
  }
  return null
}

/** レポーターが指す名前を取り出す */
function nameOf(block: any) {
  return (block.children ?? [])
    .filter(
      (child: any) => !child.isInput && !child.isBlock && !child.isScript,
    )
    .map((child: any) => String(child.value ?? ""))
    .join("")
    .trim()
}

/** 子が値なら文字列を返す。ブロックなら null */
function literal(child: any) {
  if (child === undefined) return ""
  if (child.isBlock) return null
  if (child.isInput) return child.value?.isBlock ? null : String(child.value ?? "")
  return String(child.value ?? "")
}

/**
 * 中身の数に合う opcode を選ぶ。記法は 1 つでも .sb3 は中身の数で別の opcode を取る。
 *
 * `entry` は台帳の項目
 * `scripts` は中身の数
 */
function variantFor(
  entry: Entry,
  scripts: number,
): { opcode: string, args: CatalogArgument[], ja?: string | null } | null {
  const candidates = [
    { opcode: entry.opcode, args: entry.args },
    ...(entry.alsoCovers ?? []),
  ]
  // 並びであることまで見る。`!== null` だけだと欠落・数・文字・対応が素通りし、
  // `filter` が TypeError を外へ出す（6 形のうち 4 形。CP6 で実測）
  const found = candidates.find(
    (candidate): candidate is { opcode: string, args: CatalogArgument[] } =>
      Array.isArray(candidate.args) &&
      candidate.args.filter((arg: CatalogArgument) => arg.kind === "statement").length === scripts,
  )
  // 手掛かりを出すのに日本語ラベルが要る。`alsoCovers` の候補は持たないので項目から取る
  return found ? { ...found, ja: entry.ja } : null
}

/** 原始値の opcode から、宣言を引く種別へ直す */
function kindOfPrimitive(opcode: string) {
  if (opcode === "data_variable") return "variable"
  if (opcode === "data_listcontents") return "list"
  return "broadcast"
}

/**
 * 報告に使う文字列を組み立てる。行の引き当てには関わらないので通し番号は要らない。
 *
 * 引数は記法での位置（`%1`）で名指す。`.sb3` での欄の名前（`FROM`・`DURATION`）は
 * 生成物の側の綴りで、記法を書く人はどこにも見ていない。ブロック解説の一覧が同じ番号で
 * 引数を示すので、申告から一覧を引ける。
 *
 * 番号だけでは足りない。日本語のラベルは語順を入れ替えるものがあり（台帳 128 件のうち
 * 8 件）、そこでは書き手の行の左から 2 つ目が `%1` になる。番号を引くのに一覧を開く
 * ことになるので、書かれた綴りを添えて行の中で見つけられるようにする。
 */
function subjectOf(site: { label: string, position: number, written?: string | null }) {
  const written = site.written ? `「${site.written}」` : ""
  return `${site.label} の %${site.position}${written}`
}

/** 宣言を促す報告に使う、種別の呼び名 */
function noun(kind: string) {
  if (kind === "variable") return "変数"
  if (kind === "list") return "リスト"
  return "放送"
}

/** スクリプトが縦に取る段の数を数える。並べる位置を決めるためだけの目安 */
function rows(blocks: any[]) {
  let count = 0
  for (const block of blocks) {
    count += 1
    for (const child of block.children ?? []) {
      // 中身のほかに、下で閉じる腕のぶんの高さを数える。数え落とすと、中身を持つ
      // ブロックのあるスクリプトへ次の帽子が食い込む（2026-09-02 に実機で出た）
      if (child.isScript) count += rows(child.blocks) + 1
    }
  }
  return count
}

/** 問題の報告に使う、記法の 1 行目 */
function describe(block: any) {
  return String(block.stringify?.() ?? "").split("\n")[0].trim()
}
