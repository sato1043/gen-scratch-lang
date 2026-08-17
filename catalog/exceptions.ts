/**
 * 台帳の例外表。手で書く唯一の生成元。
 *
 * 台帳の他の欄はすべて機械で導く。ここに置くのは導けないものだけに限る。導ける
 * ものを書くと、上流が変わったときに手書きが黙って古びる。
 *
 * 各項目には理由を書く。理由の書けない項目は、導けないのではなく調べていない。
 */

type Exception = {
  /** scratchblocks の識別子で指すもの */
  identifier?: string
  /** 識別子を持たない記法を Scratch 2 の selector で指すもの */
  selector?: string
  kind: "override" | "option" | "not-a-block" | "legacy"
  /** kind が override のときの opcode */
  opcode?: string
  /** 同じ記法が中身の形によって取る別の opcode */
  alsoCovers?: string[]
  /** なぜ機械で導けないか */
  reason: string
}

export const EXCEPTIONS: Exception[] = [
  {
    identifier: "CONTROL_IF",
    kind: "override",
    opcode: "control_if",
    alsoCovers: ["control_if_else"],
    reason:
      "scratch-blocks では control_if と control_if_else の双方が CONTROL_IF を" +
      "見出しに使う。記法は両者を 1 つのブロックで表し、中身を 2 つ持つときが" +
      "control_if_else に当たる。どちらになるかは中身の数で決まり、識別子では決まらない",
  },
  {
    identifier: "CONTROL_ELSE",
    kind: "not-a-block",
    reason:
      "ブロックでなく記法の部品。C 型ブロックの中身を 2 つに割る綴りで、解析の" +
      "時点で「もし〜なら」へ吸収され、独立したブロックとしては現れない",
  },
  {
    identifier: "SENSING_OF",
    kind: "override",
    opcode: "sensing_of",
    reason:
      "scratch-blocks の定義が空で、選択肢を実行時に scratch-gui が埋める。" +
      "opcode 名は定義の見出しにあるが、見出しと識別子を結ぶ記述が無い",
  },
  {
    identifier: "EVENT_WHENBACKDROPSWITCHESTO",
    kind: "override",
    opcode: "event_whenbackdropswitchesto",
    reason: "SENSING_OF と同じく定義が空。背景の一覧を実行時に埋めるため",
  },
  {
    identifier: "SENSING_OF_COSTUMENUMBER",
    kind: "option",
    reason: "ブロックでなく sensing_of のドロップダウンの選択肢",
  },
  {
    identifier: "SENSING_OF_BACKDROPNAME",
    kind: "option",
    reason: "ブロックでなく sensing_of のドロップダウンの選択肢",
  },
  {
    identifier: "SENSING_OF_BACKDROPNUMBER",
    kind: "option",
    reason: "ブロックでなく sensing_of のドロップダウンの選択肢",
  },
  {
    identifier: "scratchblocks:end",
    kind: "not-a-block",
    reason:
      "ブロックでなく記法の部品。C 型ブロックの終わりを示す綴りで、解析の時点で" +
      "閉じ役として消費される",
  },
  {
    selector: "comeToFront",
    kind: "legacy",
    reason:
      "Scratch 2 の記法。3.0 では looks_gotofrontback が前面と背面を選択肢で兼ねる",
  },
  {
    selector: "goBackByLayers:",
    kind: "legacy",
    reason:
      "Scratch 2 の記法。3.0 では looks_goforwardbackwardlayers が前後を選択肢で兼ねる",
  },
  {
    selector: "setTempoTo:",
    kind: "legacy",
    reason: "Scratch 2 の記法。3.0 ではテンポは音楽の拡張機能へ移った",
  },
]
