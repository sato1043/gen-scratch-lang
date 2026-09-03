/**
 * カスタムブロック（利用者が自分で作るブロック）の、記法の側の定義。
 *
 * 台帳は scratchblocks の定義表を回して組み立てる。そこに `custom` のカテゴリは
 * 1 件も無い（実測 2026-09-03・scratchblocks 3.7.1・233 件中 0 件）。`定義` は表を
 * 通らず構文として解析されており、`else` や `end` と同じ層にある。定義表を回す
 * ループでは拾えないため、ここに置いて合流させる。
 *
 * ペンとは塞がり方が逆である ── ペンは記法が上流に在り opcode が無かった。ここは
 * 記法の側だけが無く、opcode と引数名は scratch-blocks に在る。
 *
 * **引数は台帳では解けない。** 綴りも引数の数も利用者が決めるので、「識別子 →
 * opcode + 引数」の固定の対応表には原理的に収まらない。3 件とも `args: null`
 * （引数を解けない）で置き、覆わない範囲へ申告させる。生成側はこの欄を引かず、
 * 解析器が返す綴り（`info.call`）から mutation を組む。
 */

/**
 * 記法の側の定義。形は scratchblocks の定義表の項に合わせ、機械で導けない opcode を
 * 同じ行へ置く（例外表の `override` と同じ役割を、記法ごと持ち込む場合の形）。
 *
 * `args: null` は「引数を解けない」を意味する。上流の定義に引数が在っても、記法の
 * 側から引数を組み立てる経路が無い限り解けたことにならない ── `procedures_definition`
 * は上流で `custom_block` を持つが、それはエディタがプロトタイプを差す口であって、
 * この台帳の `statement`（C 型の中身）とは別の概念である。写す先の意味に合わない値を
 * 写さない。
 */
export const PROCEDURE_COMMANDS = [
  {
    id: "PROCEDURES_DEFINITION",
    selector: "procDef",
    // 綴りに印を置かない。`定義` の後に続くのは値でなくプロトタイプで、値の置き場を
    // 表す印では書けない
    spec: "define",
    inputs: [],
    shape: "define-hat",
    category: "custom",
    opcode: "procedures_definition",
    args: null,
    argsBy: "利用者",
  },
  {
    id: "PROCEDURES_CALL",
    selector: "call",
    // 綴りも引数の数も利用者が決める。印を 1 つ置くと、印の数と引数の数が食い違う
    spec: "",
    inputs: [],
    shape: "stack",
    category: "custom",
    opcode: "procedures_call",
    args: null,
    argsBy: "利用者",
  },
  {
    // 上流は引数の参照へ識別子を付けない（解析結果も selector だけを持つ）。台帳は
    // 識別子で項を引くため selector を識別子として使う。生成側はこの項を引かず、
    // カテゴリ（`custom-arg`）と selector で見分ける
    id: "getParam",
    selector: "getParam",
    spec: "",
    inputs: [],
    shape: "reporter",
    category: "custom-arg",
    opcode: "argument_reporter_string_number",
    args: null,
    argsBy: "利用者",
  },
]

/** ブロック定義の opcode。読み取りの被覆と、記法から止まることを検査が固定するのに使う */
export const PROCEDURE_OPCODES = PROCEDURE_COMMANDS.map(c => c.opcode)
