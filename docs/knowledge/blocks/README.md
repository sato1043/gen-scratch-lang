ブロック解説
============

Scratch のブロックを、カテゴリごとに解説する。扱うのは core の 9 カテゴリと、扱うと
裁定した拡張機能（ペン）と、ブロック定義である。各ページは 2 層でできている。カテゴリが
何をするかの説明は人が書き、それ以外は台帳から生成する。一覧を手で書くと台帳と
二重管理になるためである。

生成する側は 3 つでできている。引数の欄の読み方を述べる凡例と、記法・opcode・形・引数の
4 列を持つ一覧と、選択肢が長い引数だけを回す末尾の表である。引数の型と選択肢の綴りは
この一覧にあり、この索引ページには無い。

| ページ | 中身 |
|---|---|
| [動き](motion.md) | 位置と向きを変える |
| [見た目](looks.md) | 吹き出し・コスチューム・大きさ・効果 |
| [音](sound.md) | 音を鳴らす・音量 |
| [イベント](events.md) | スクリプトの起点・メッセージ |
| [制御](control.md) | 待つ・繰り返す・条件・クローン |
| [調べる](sensing.md) | 触れた・キー・マウス・タイマー |
| [演算](operators.md) | 四則・比較・論理・文字列・乱数 |
| [変数](variables.md) | 1 つの値を覚える |
| [リスト](list.md) | 並んだ値を覚える |
| [ペン](pen.md) | 線を引く・スタンプ |
| [ブロック定義](custom.md) | 処理にまとまりと名前を与える |
| [ブロック定義の引数](custom-arg.md) | 定義したブロックが受け取る値 |

一覧を組み立て直して差分が無いことを確かめるには、リポジトリの根で次を実行する。

```zsh
node src/cli.ts knowledge --check
```


## 覆わない範囲

ここに挙げたものは解説が扱わない。0 件を装わず、群ごとに件数と一覧を残す。

<!-- 台帳から生成: ここから -->
### core の外のカテゴリ（93 件）

- `boost`: 12 件
- `ev3`: 11 件
- `faceSensing`: 9 件
- `gdxfor`: 9 件
- `grey`: 2 件
- `makeymakey`: 2 件
- `microbit`: 10 件
- `music`: 7 件
- `obsolete`: 10 件
- `translate`: 2 件
- `tts`: 3 件
- `video`: 4 件
- `wedo`: 12 件

### ドロップダウンの選択肢（3 件）

- `SENSING_OF_COSTUMENUMBER` — ブロックでなく sensing_of のドロップダウンの選択肢
- `SENSING_OF_BACKDROPNAME` — ブロックでなく sensing_of のドロップダウンの選択肢
- `SENSING_OF_BACKDROPNUMBER` — ブロックでなく sensing_of のドロップダウンの選択肢

### ブロックでない記法（2 件）

- `CONTROL_ELSE` — ブロックでなく記法の部品。C 型ブロックの中身を 2 つに割る綴りで、解析の時点で「もし〜なら」へ吸収され、独立したブロックとしては現れない
- `scratchblocks:end` — ブロックでなく記法の部品。C 型ブロックの終わりを示す綴りで、解析の時点で閉じ役として消費される

### 今の Scratch で置けない記法（6 件）

- `go to front` — Scratch 2 の記法。3.0 では looks_gotofrontback が前面と背面を選択肢で兼ねる
- `go back %1 layers` — Scratch 2 の記法。3.0 では looks_goforwardbackwardlayers が前後を選択肢で兼ねる
- `set tempo to %1 bpm` — Scratch 2 の記法。3.0 ではテンポは音楽の拡張機能へ移った
- `pen.changeHue` — Scratch 3 のパレットに出ない（scratch-vm が hideFromPalette を付ける）。色相を 0〜100 の数で動かす Scratch 2 由来の指定で、3.0 では pen_changePenColorParamBy が色・鮮やかさ・明るさ・透明度を選択肢で兼ねる
- `pen.changeShade` — Scratch 3 のパレットに出ない（scratch-vm が hideFromPalette を付ける）。濃さは 3.0 の色の指定に無い概念で、明るさへ置き換わった
- `pen.setShade` — Scratch 3 のパレットに出ない（scratch-vm が hideFromPalette を付ける）。濃さは 3.0 の色の指定に無い概念で、明るさへ置き換わった

### 綴りが衝突して呼べない記法（1 件）

- `pen.setColor` — 日本語の綴り「ペンの色を%1にする」が pen.setHue と重なり、解析器は pen.setHue を選ぶ。同じ opcode（pen_setPenColorToColor）はそちらの綴りから呼べるため、こちらは台帳に置かない。置くと opcode が 2 度現れる

### 引数名を取れないブロック（2 件）

- `EVENT_WHENBACKDROPSWITCHESTO`
- `SENSING_OF`

### 引数を利用者が決めるブロック（3 件）

- `PROCEDURES_DEFINITION`
- `PROCEDURES_CALL`
- `getParam`

### 選択肢を補足で埋めた入力（3 件）

- `LOOKS_SWITCHBACKDROPTO` の入力 `BACKDROP`
- `LOOKS_SWITCHBACKDROPTOANDWAIT` の入力 `BACKDROP`
- `CONTROL_STOP` の入力 `STOP_OPTION`

### 影ブロックを規則で補った入力（29 件）

- `MOTION_GOTOXY` の入力 `X`（影は `math_number`）
- `MOTION_GOTOXY` の入力 `Y`（影は `math_number`）
- `MOTION_GLIDESECSTOXY` の入力 `X`（影は `math_number`）
- `MOTION_GLIDESECSTOXY` の入力 `Y`（影は `math_number`）
- `MOTION_SETX` の入力 `X`（影は `math_number`）
- `MOTION_SETY` の入力 `Y`（影は `math_number`）
- `LOOKS_SAYFORSECS` の入力 `MESSAGE`（影は `text`）
- `LOOKS_SAYFORSECS` の入力 `SECS`（影は `math_number`）
- `LOOKS_SAY` の入力 `MESSAGE`（影は `text`）
- `LOOKS_THINKFORSECS` の入力 `MESSAGE`（影は `text`）
- `LOOKS_THINKFORSECS` の入力 `SECS`（影は `math_number`）
- `LOOKS_THINK` の入力 `MESSAGE`（影は `text`）
- `pen.setColorParam` の入力 `VALUE`（影は `math_number`）
- `pen.changeColorParam` の入力 `VALUE`（影は `math_number`）
- `pen.setHue` の入力 `COLOR`（影は `colour_picker`）
- `pen.changeSize` の入力 `SIZE`（影は `math_number`）
- `pen.setSize` の入力 `SIZE`（影は `math_number`）
- `SENSING_ASKANDWAIT` の入力 `QUESTION`（影は `text`）
- `DATA_SETVARIABLETO` の入力 `VALUE`（影は `text`）
- `DATA_CHANGEVARIABLEBY` の入力 `VALUE`（影は `math_number`）
- `DATA_ADDTOLIST` の入力 `ITEM`（影は `text`）
- `DATA_DELETEOFLIST` の入力 `INDEX`（影は `math_number`）
- `DATA_INSERTATLIST` の入力 `ITEM`（影は `text`）
- `DATA_INSERTATLIST` の入力 `INDEX`（影は `math_number`）
- `DATA_REPLACEITEMOFLIST` の入力 `INDEX`（影は `math_number`）
- `DATA_REPLACEITEMOFLIST` の入力 `ITEM`（影は `text`）
- `DATA_ITEMOFLIST` の入力 `INDEX`（影は `math_number`）
- `DATA_ITEMNUMOFLIST` の入力 `ITEM`（影は `text`）
- `DATA_LISTCONTAINSITEM` の入力 `ITEM`（影は `text`）

### 台帳から到達しない opcode（40 件）

- `argument_editor_boolean`
- `argument_editor_string_number`
- `argument_reporter_boolean`
- `control_all_at_once`
- `control_clear_counter`
- `control_create_clone_of_menu`
- `control_for_each`
- `control_get_counter`
- `control_incr_counter`
- `control_while`
- `data_listcontents`
- `data_listindexall`
- `data_listindexrandom`
- `data_variable`
- `event_broadcast_menu`
- `event_touchingobjectmenu`
- `event_whentouchingobject`
- `looks_backdrops`
- `looks_changestretchby`
- `looks_costume`
- `looks_hideallsprites`
- `looks_setstretchto`
- `motion_align_scene`
- `motion_glideto_menu`
- `motion_goto_menu`
- `motion_pointtowards_menu`
- `motion_scroll_right`
- `motion_scroll_up`
- `motion_xscroll`
- `motion_yscroll`
- `pen_menu_colorParam`
- `procedures_declaration`
- `procedures_prototype`
- `sensing_distancetomenu`
- `sensing_keyoptions`
- `sensing_loud`
- `sensing_of_object_menu`
- `sensing_touchingobjectmenu`
- `sensing_userid`
- `sound_sounds_menu`

### 素の綴りでは呼べないブロック（1 件）

同じ日本語ラベルを持つ組が 6 組ある。多くは引数の形で分かれるので
両方を呼べる。分ける手掛かりを綴りの中に持たない組だけがここへ残る。
**カテゴリを明示すれば呼べる**ものも含むので、下の規則と併せて読む ── 素の綴りを
解析器へ通して確かめた結果であり、「どう書いても呼べない」ではない。

| 綴り | 記法から呼べる | 呼べない |
|---|---|---|
| `%1 の効果を %2 ずつ変える` | `LOOKS_CHANGEEFFECTBY` / `SOUND_CHANGEEFFECTBY` | （無し） |
| `%1 の効果を %2 にする` | `LOOKS_SETEFFECTTO` / `SOUND_SETEFFECTO` | （無し） |
| `音量` | `SOUND_VOLUME` | `SENSING_LOUDNESS` |
| `%2 の %1` | `SENSING_OF` / `OPERATORS_MATHOP` | （無し） |
| `%1 の長さ` | `OPERATORS_LENGTH` / `DATA_LENGTHOFLIST` | （無し） |
| `%1 に %2 が含まれる` | `OPERATORS_CONTAINS` / `DATA_LISTCONTAINSITEM` | （無し） |

### 綴りの重なりを解く規則（3 件）

同じ綴りで解析されたブロックを、引数の形やカテゴリの明示で分ける。分けた結果は図と
.sb3 の双方に効く。

| 解析器が返す | 読み替える先 | 分ける手掛かり |
|---|---|---|
| `SENSING_OF` | `OPERATORS_MATHOP` | 「%2 の %1」を sensing_of と operator_mathop が共有する。解析器は sensing_of を選ぶ。属性の取得は第 1 位置に**対象**の選択肢を取り（日本語は「対象 の 属性」の順）、数学の関数は数を取るので、第 1 位置の形と末尾の名の 2 つで分かれる |
| `OPERATORS_LENGTH` | `DATA_LENGTHOFLIST` | 「%1 の長さ」を operator_length と data_lengthoflist が共有する。解析器は operator_length を選ぶ。文字の長さは値を取り、リストの長さはリストの名前を選択肢で取るので、引数の形で分かれる |
| `SOUND_VOLUME` | `SENSING_LOUDNESS` | 「音量」を sound_volume と sensing_loudness が共有する。どちらも引数を持たないため綴りの中に手掛かりが無い。記法のカテゴリの明示（`:: sensing`）だけが分ける |
<!-- 台帳から生成: ここまで -->

__END__
