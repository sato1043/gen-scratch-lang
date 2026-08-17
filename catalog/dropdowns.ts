/**
 * ドロップダウンの日本語ラベルと .sb3 の内部値の対応。
 *
 * 記法は選択肢を日本語のまま書く（`[右向き矢印 v]`）が、.sb3 は内部値で持つ
 * （`right arrow`）。scratchblocks は選択肢を訳さず書かれた文字列をそのまま運ぶため、
 * この対応はどこからも降ってこない。
 *
 * 内部値の出典は scratch-blocks 2.1.19 のブロック定義（`[Blockly.Msg.X, '値']` の組）。
 * 日本語ラベルの出典は scratch-l10n 6.1.110 の `editor/blocks/ja.json`。Scratch の
 * 日本語 UI が実際に見せる語であり、記法もそれに合わせる。両者を機械で突き合わせて
 * 書き出した。取り出しの際は選択肢の要素数と読めた組の数を照合している
 * （値に `don't rotate` のような ` ' ` を含む綴りがあり、単引用符だけを見ると
 * 黙って落ちる）。
 *
 * 表はブロックと欄の組で引く。同じ欄の名前でもブロックが違えば別の選択肢を持つ。
 */

/**
 * 機械で書き出した選択肢。ブロック → 欄 → 日本語ラベル → 内部値
 */
export const OPTIONS: Record<string, Record<string, Record<string, string>>> = {
  data_listindexall: {
    INDEX: {
      "1": "1",
      "最後": "last",
      "すべて": "all",
    },
  },
  data_listindexrandom: {
    INDEX: {
      "1": "1",
      "最後": "last",
      "乱数": "random",
    },
  },
  event_touchingobjectmenu: {
    TOUCHINGOBJECTMENU: {
      "マウスのポインター": "_mouse_",
      "端": "_edge_",
    },
  },
  event_whengreaterthan: {
    WHENGREATERTHANMENU: {
      "音量": "LOUDNESS",
      "タイマー": "TIMER",
    },
  },
  event_whenkeypressed: {
    KEY_OPTION: {
      "0": "0",
      "1": "1",
      "2": "2",
      "3": "3",
      "4": "4",
      "5": "5",
      "6": "6",
      "7": "7",
      "8": "8",
      "9": "9",
      "スペース": "space",
      "上向き矢印": "up arrow",
      "下向き矢印": "down arrow",
      "右向き矢印": "right arrow",
      "左向き矢印": "left arrow",
      "どれかの": "any",
      "a": "a",
      "b": "b",
      "c": "c",
      "d": "d",
      "e": "e",
      "f": "f",
      "g": "g",
      "h": "h",
      "i": "i",
      "j": "j",
      "k": "k",
      "l": "l",
      "m": "m",
      "n": "n",
      "o": "o",
      "p": "p",
      "q": "q",
      "r": "r",
      "s": "s",
      "t": "t",
      "u": "u",
      "v": "v",
      "w": "w",
      "x": "x",
      "y": "y",
      "z": "z",
    },
  },
  looks_backdropnumbername: {
    NUMBER_NAME: {
      "番号": "number",
      "名前": "name",
    },
  },
  looks_changeeffectby: {
    EFFECT: {
      "色": "COLOR",
      "魚眼レンズ": "FISHEYE",
      "渦巻き": "WHIRL",
      "ピクセル化": "PIXELATE",
      "モザイク": "MOSAIC",
      "明るさ": "BRIGHTNESS",
      "幽霊": "GHOST",
    },
  },
  looks_costumenumbername: {
    NUMBER_NAME: {
      "番号": "number",
      "名前": "name",
    },
  },
  looks_goforwardbackwardlayers: {
    FORWARD_BACKWARD: {
      "手前に出す": "forward",
      "奥に下げる": "backward",
    },
  },
  looks_gotofrontback: {
    FRONT_BACK: {
      "最前面": "front",
      "最背面": "back",
    },
  },
  looks_seteffectto: {
    EFFECT: {
      "色": "COLOR",
      "魚眼レンズ": "FISHEYE",
      "渦巻き": "WHIRL",
      "ピクセル化": "PIXELATE",
      "モザイク": "MOSAIC",
      "明るさ": "BRIGHTNESS",
      "幽霊": "GHOST",
    },
  },
  motion_align_scene: {
    ALIGNMENT: {
      "左下": "bottom-left",
      "右下": "bottom-right",
      "中央": "middle",
      "左上": "top-left",
      "右上": "top-right",
    },
  },
  motion_setrotationstyle: {
    STYLE: {
      "左右のみ": "left-right",
      "回転しない": "don't rotate",
      "自由に回転": "all around",
    },
  },
  operator_mathop: {
    OPERATOR: {
      "絶対値": "abs",
      "切り下げ": "floor",
      "切り上げ": "ceiling",
      "平方根": "sqrt",
      "sin": "sin",
      "cos": "cos",
      "tan": "tan",
      "asin": "asin",
      "acos": "acos",
      "atan": "atan",
      "ln": "ln",
      "log": "log",
      "e ^": "e ^",
      "10 ^": "10 ^",
    },
  },
  sensing_current: {
    CURRENTMENU: {
      "年": "YEAR",
      "月": "MONTH",
      "日": "DATE",
      "曜日": "DAYOFWEEK",
      "時": "HOUR",
      "分": "MINUTE",
      "秒": "SECOND",
    },
  },
  sensing_keyoptions: {
    KEY_OPTION: {
      "0": "0",
      "1": "1",
      "2": "2",
      "3": "3",
      "4": "4",
      "5": "5",
      "6": "6",
      "7": "7",
      "8": "8",
      "9": "9",
      "スペース": "space",
      "上向き矢印": "up arrow",
      "下向き矢印": "down arrow",
      "右向き矢印": "right arrow",
      "左向き矢印": "left arrow",
      "どれかの": "any",
      "a": "a",
      "b": "b",
      "c": "c",
      "d": "d",
      "e": "e",
      "f": "f",
      "g": "g",
      "h": "h",
      "i": "i",
      "j": "j",
      "k": "k",
      "l": "l",
      "m": "m",
      "n": "n",
      "o": "o",
      "p": "p",
      "q": "q",
      "r": "r",
      "s": "s",
      "t": "t",
      "u": "u",
      "v": "v",
      "w": "w",
      "x": "x",
      "y": "y",
      "z": "z",
    },
  },
  sensing_setdragmode: {
    DRAG_MODE: {
      "できる": "draggable",
      "できない": "not draggable",
    },
  },
  sound_changeeffectby: {
    EFFECT: {
      "ピッチ": "PITCH",
      "左右にパン": "PAN",
    },
  },
  sound_seteffectto: {
    EFFECT: {
      "ピッチ": "PITCH",
      "左右にパン": "PAN",
    },
  },
}

/**
 * メニューの影ブロックが持つ、決まった選択肢。
 *
 * これらのメニューは選択肢を 2 種類混ぜる。スプライト名やコスチューム名のように作品
 * ごとに決まるものと、「マウスのポインター」のようにどの作品でも同じものである。後者
 * だけが内部値を持ち、記法に書いた日本語を訳さずに .sb3 へ入れると壊れた値になる。
 *
 * 内部値の出典は scratch-blocks 0.1.0-prerelease.20221207082607 の
 * `blocks_vertical/*.js`（`[Blockly.Msg.X, '値']` の組）。現行の 2.1.19 はメニューの
 * 定義が空で、中身を scratch-gui が実行時に埋めるため取れない。日本語ラベルの出典は
 * 現行 2.1.19 が同梱する `msg/scratch_msgs.js` の `locales['ja']`。10 組すべてで
 * ラベルが引けることを確かめて書き出した。
 */
export const MENU_OPTIONS: Record<string, Record<string, Record<string, string>>> = {
  control_create_clone_of_menu: {
    CLONE_OPTION: {
      自分自身: "_myself_",
    },
  },
  motion_glideto_menu: {
    TO: {
      "マウスのポインター": "_mouse_",
      "どこかの場所": "_random_",
    },
  },
  motion_goto_menu: {
    TO: {
      "マウスのポインター": "_mouse_",
      "どこかの場所": "_random_",
    },
  },
  motion_pointtowards_menu: {
    TOWARDS: {
      "マウスのポインター": "_mouse_",
      "どれかの向き": "_random_",
    },
  },
  sensing_distancetomenu: {
    DISTANCETOMENU: {
      "マウスのポインター": "_mouse_",
    },
  },
  sensing_touchingobjectmenu: {
    TOUCHINGOBJECTMENU: {
      "マウスのポインター": "_mouse_",
      端: "_edge_",
    },
  },
}

/**
 * 機械で書き出せなかったぶんの補足。出典を各項目に記す。
 *
 * 手で書くのはここだけに留める。表の側を手で直すと、書き出し直したときに消える。
 */
export const SUPPLEMENT: Record<string, Record<string, Record<string, string>>> = {
  // control_stop は選択肢を変数で組み立てるため、値が文字列として現れない。
  // 出典は scratch-blocks 2.1.19 の control.ts が置く定数
  // （ALL_SCRIPTS / THIS_SCRIPT / OTHER_SCRIPTS）
  control_stop: {
    STOP_OPTION: {
      すべてを止める: "all",
      このスクリプトを止める: "this script",
      スプライトの他のスクリプトを止める: "other scripts in sprite",
    },
  },

  // 背景のメニュー（looks_backdrops）は定義が空で、選択肢は scratch-gui が実行時に埋める。
  // 背景の名前に混じって決まった選択肢を 3 つ持つ。内部値の出典は parse-sb3-blocks 0.5.2 の
  // `allMenus.looks_switchbackdropto`、日本語ラベルの出典は scratch-blocks 2.1.19 の
  // `msg/scratch_msgs.js` の `locales['ja']`（LOOKS_NEXTBACKDROP 等。MENU_OPTIONS と同じ出典）
  looks_switchbackdropto: {
    BACKDROP: {
      次の背景: "next backdrop",
      前の背景: "previous backdrop",
      どれかの背景: "random backdrop",
    },
  },
  looks_switchbackdroptoandwait: {
    BACKDROP: {
      次の背景: "next backdrop",
      前の背景: "previous backdrop",
      どれかの背景: "random backdrop",
    },
  },
}

/**
 * 選択肢が固定されておらず、書かれた名前をそのまま内部値にする種別。
 *
 * 変数・リスト・コスチューム・音・背景・メッセージ・スプライトは、作品ごとに名前が
 * 決まる。表で引く対象ではなく、記法に書いた文字列がそのまま値になる。
 */
export const NAME_KINDS: string[] = [
  "%m.backdrop",
  "%m.broadcast",
  "%m.costume",
  "%m.list",
  "%m.location",
  "%m.sound",
  "%m.spriteOnly",
  "%m.spriteOrMouse",
  // 触れた判定の相手にはスプライト名を書ける。MENU_OPTIONS が「決まった選択肢と作品ごとの
  // 名前を混ぜる」と述べる 6 件のうち、ここだけが名前の口を持たず記法から書けなかった
  "%m.touching",
  "%m.var",
]
