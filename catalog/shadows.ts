/**
 * 入力に差し込む影ブロックの表と、影ブロックが .sb3 で取る原始値の符号。
 *
 * .sb3 の入力は、値を直に持たず「影ブロック」を 1 枚敷いてその中に持つ。どの影を
 * 敷くかはブロックと入力の組ごとに決まっていて、記法の引数の種別からは決まらない。
 * 実例を挙げる。いずれも記法の上では同じ「数」に見える。
 *
 * | 入力 | 影ブロック |
 * |---|---|
 * | `control_wait` の DURATION | `math_positive_number` |
 * | `control_repeat` の TIMES | `math_whole_number` |
 * | `motion_pointindirection` の DIRECTION | `math_angle` |
 * | `motion_movesteps` の STEPS | `math_number` |
 *
 * 出典は scratch-blocks 0.1.0-prerelease.20221207082607 の
 * `blocks_vertical/default_toolbox.js`。`<block type=...><value name=...>
 * <shadow type=...>` の入れ子を機械で抽出して書き出した。現行の scratch-blocks
 * 2.1.19 はツールボックス定義を持たない（製品版は scratch-gui 側にある）ため、
 * 定義を持っていた最後の系列から取っている。
 *
 * この表は完全ではない。出典のツールボックスは 105 ブロックしか並べておらず、
 * `looks_say`・`looks_think`・`sensing_askandwait`・変数まわりが欠けている。
 * 欠けた入力は記法の引数の種別から補い、補ったことを台帳が申告する。
 */

/** ブロックと入力の組ごとの影ブロック */
export const SHADOWS: Record<string, Record<string, string>> = {
  control_create_clone_of: {
    CLONE_OPTION: "control_create_clone_of_menu",
  },
  control_repeat: {
    TIMES: "math_whole_number",
  },
  control_wait: {
    DURATION: "math_positive_number",
  },
  event_broadcast: {
    BROADCAST_INPUT: "event_broadcast_menu",
  },
  event_broadcastandwait: {
    BROADCAST_INPUT: "event_broadcast_menu",
  },
  event_whengreaterthan: {
    VALUE: "math_number",
  },
  looks_changeeffectby: {
    CHANGE: "math_number",
  },
  looks_changesizeby: {
    CHANGE: "math_number",
  },
  looks_goforwardbackwardlayers: {
    NUM: "math_integer",
  },
  looks_seteffectto: {
    VALUE: "math_number",
  },
  looks_setsizeto: {
    SIZE: "math_number",
  },
  looks_switchbackdropto: {
    BACKDROP: "looks_backdrops",
  },
  looks_switchbackdroptoandwait: {
    BACKDROP: "looks_backdrops",
  },
  looks_switchcostumeto: {
    COSTUME: "looks_costume",
  },
  motion_changexby: {
    DX: "math_number",
  },
  motion_changeyby: {
    DY: "math_number",
  },
  motion_glidesecstoxy: {
    SECS: "math_number",
  },
  motion_glideto: {
    SECS: "math_number",
    TO: "motion_glideto_menu",
  },
  motion_goto: {
    TO: "motion_goto_menu",
  },
  motion_movesteps: {
    STEPS: "math_number",
  },
  motion_pointindirection: {
    DIRECTION: "math_angle",
  },
  motion_pointtowards: {
    TOWARDS: "motion_pointtowards_menu",
  },
  motion_turnleft: {
    DEGREES: "math_number",
  },
  motion_turnright: {
    DEGREES: "math_number",
  },
  operator_add: {
    NUM1: "math_number",
    NUM2: "math_number",
  },
  operator_contains: {
    STRING1: "text",
    STRING2: "text",
  },
  operator_divide: {
    NUM1: "math_number",
    NUM2: "math_number",
  },
  operator_equals: {
    OPERAND1: "text",
    OPERAND2: "text",
  },
  operator_gt: {
    OPERAND1: "text",
    OPERAND2: "text",
  },
  operator_join: {
    STRING1: "text",
    STRING2: "text",
  },
  operator_length: {
    STRING: "text",
  },
  operator_letter_of: {
    LETTER: "math_whole_number",
    STRING: "text",
  },
  operator_lt: {
    OPERAND1: "text",
    OPERAND2: "text",
  },
  operator_mathop: {
    NUM: "math_number",
  },
  operator_mod: {
    NUM1: "math_number",
    NUM2: "math_number",
  },
  operator_multiply: {
    NUM1: "math_number",
    NUM2: "math_number",
  },
  operator_random: {
    FROM: "math_number",
    TO: "math_number",
  },
  operator_round: {
    NUM: "math_number",
  },
  operator_subtract: {
    NUM1: "math_number",
    NUM2: "math_number",
  },
  sensing_coloristouchingcolor: {
    COLOR: "colour_picker",
    COLOR2: "colour_picker",
  },
  sensing_distanceto: {
    DISTANCETOMENU: "sensing_distancetomenu",
  },
  sensing_keypressed: {
    KEY_OPTION: "sensing_keyoptions",
  },
  sensing_of: {
    OBJECT: "sensing_of_object_menu",
  },
  sensing_touchingcolor: {
    COLOR: "colour_picker",
  },
  sensing_touchingobject: {
    TOUCHINGOBJECTMENU: "sensing_touchingobjectmenu",
  },
  sound_changeeffectby: {
    VALUE: "math_number",
  },
  sound_changevolumeby: {
    VOLUME: "math_number",
  },
  sound_play: {
    SOUND_MENU: "sound_sounds_menu",
  },
  sound_playuntildone: {
    SOUND_MENU: "sound_sounds_menu",
  },
  sound_seteffectto: {
    VALUE: "math_number",
  },
  sound_setvolumeto: {
    VOLUME: "math_number",
  },
}

/**
 * 影ブロックが .sb3 で取る原始値の符号と、値を収める欄の名前。
 *
 * 出典は scratch-vm 5.0.300 の `src/serialization/sb3.js`（`compressInputTree`
 * が使う表）。scratch-vm 自体は 24MB あり、この 10 行のために依存へ加えない。
 * 表が指す影ブロックが実在するかは台帳の組み立て時に照合する。
 */
export const PRIMITIVES: Record<string, [number, string]> = {
  math_number: [4, "NUM"],
  math_positive_number: [5, "NUM"],
  math_whole_number: [6, "NUM"],
  math_integer: [7, "NUM"],
  math_angle: [8, "NUM"],
  colour_picker: [9, "COLOUR"],
  text: [10, "TEXT"],
  event_broadcast_menu: [11, "BROADCAST_OPTION"],
  data_variable: [12, "VARIABLE"],
  data_listcontents: [13, "LIST"],
}

/**
 * 記法の引数の種別から影ブロックを補う規則。表に無い入力にだけ使う。
 *
 * `%b`（真偽）と C 型の中身は影を敷かない。`%m.*`（ドロップダウン）は敷く影が
 * ブロックごとに違い規則で決められないため、表に無ければ補わずに失敗させる。
 */
export const FALLBACK: Record<string, string | null> = {
  "%n": "math_number",
  "%s": "text",
  "%c": "colour_picker",
  "%d": "math_number",
}
