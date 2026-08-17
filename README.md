# gen-scratch-lang

言葉で書いた処理を Scratch のプログラムへ変換する、解析・生成環境。

日本語のブロック記法を入力に、ブロック図（SVG / PNG）と Scratch プロジェクト
（.sb3）を導出する。導出元が 1 つなので、図と実物が食い違わない。逆の向きも持ち、
手元の .sb3 を記法・図・要約・作品定義へ読み解ける。

## 使い方

記法からブロック図を書き出す。

```zsh
node src/cli.ts render <記法ファイル> [--format svg|png]
```

作品のディレクトリから .sb3 を組み立てる。同じ入力からは常に同じバイト列が出る。
組み上がったものは Scratch 公式の検証器へ通してから書き出す。通らなければ書き出さない
（前に成功したときの出力は残るので、成否は終了コードで見る）。

```zsh
node src/cli.ts build projects/<作品名>
```

既にある .sb3 を読み解く。ターゲットごとの記法（.sbk）・スクリプトごとの図・構造の
要約と、組み立て直せる作品定義（project.yaml）をディレクトリへ書き出す。

```zsh
node src/cli.ts read <作品.sb3>
```

Scratch 公式の検証器が弾く作品も、`--anyway` を付ければ検証を飛ばさずに読める
ところまで読む。詳しくは[既にある作品を読み解く](docs/knowledge/reading.md)を見る。

知識層の生成した層（ブロック解説の一覧と作品定義のキーの一覧）を組み立て直す。
`--check` を付けると書き換えず、追跡下のものと一致するかだけを調べる。

```zsh
node src/cli.ts knowledge --check
```

## ドキュメント

- [プロジェクト憲章](docs/charter.md) — 目的・提供価値・非目標
- [言葉から記法を組む手順](docs/knowledge/howto.md) — 手順と自己検査項目
- [既にある作品を読み解く](docs/knowledge/reading.md) — `read` の使い方と止まったときの表
- [作品定義の仕様](docs/knowledge/project-definition.md) — `project.yaml` に書けるキー
- [イディオム集](docs/knowledge/idioms/README.md) — 日常語とブロック構成の組
- [ブロック解説](docs/knowledge/blocks/README.md) — core 9 カテゴリと覆わない範囲
- [作業書](docs/tasks/) — 変更ごとの計画と作業記録

## エージェントから使う

エージェント（Claude Code 等）で作業するときの入口はスキル
[words-to-scratch](.claude/skills/words-to-scratch/SKILL.md) である。言葉から記法を
組む依頼で発火し、記法を書くための知識層のページへ案内する。規則はドキュメントの側が
持ち、スキルは見るものと実行の形だけを持つ。既存の .sb3 を読む向きは対象外である。

## 動かせる環境

ネイティブの依存（canvas・@resvg/resvg-js）を持つため、環境によっては導入時に
ソースからのビルドが要る。実際に検証しているのは次の 2 つに限る。

| 環境 | 検証 |
|---|---|
| Windows x64 / Node 24 | 開発機で常用 |
| Linux x64 / Node 24 | CI で毎回 |

`engines` は Node 26 以降も許すが、26 を回す検証は無い。linux-arm64 や musl（Alpine）では
canvas の prebuild が無く、cairo・pango 等の system library が要る。

記法に書けない文字（改行・制御文字など）は `⟪U+000A⟫` の形の印で表す。この綴りを画面で
読むには、括弧（U+27EA / U+27EB）を持つ書体が要る。手元で確かめた範囲では Segoe UI
Symbol と Cambria が持ち、Consolas・Cascadia・MS Gothic・Meiryo・Yu Gothic・Segoe UI は
持たない（2026-08-23 実測）。持たない書体では豆腐になるが、`grep` や `git diff` は綴りを
そのまま扱えるので、読み書きそのものは成り立つ。

## 開発

Node.js は `package.json` の `engines` が示す版を使う。fnm・nvm を使うなら
`.node-version` が版を指す。ビルド段は持たない。

**手元は下限、CI は下限と最新の両端**で回す。`.node-version` が下限を指すのは、約束した
下限を書き手が毎日踏むためである。下限だけを測ると利用者の大半が動かす版が抜け、最新
だけを測ると宣言した下限が 1 度も走らない。`@types/node` も下限へ揃えてあり、下限に
無い API を使うと `npm run typecheck` がその場で落とす。

実装は TypeScript で書き、`node src/cli.ts` のように**そのまま動かす**。Node が
実行前に型注釈を剥がすためで、トランスパイラもバンドラも挟まない。型検査は
`npm run typecheck` が別に回し、動かす経路では走らない。

このため `engines` の下限は 2 つの意味を持つ。1 つは Node 20 の EOL を避けること
（TASK0005 で 24 へ上げた理由）、もう 1 つは**型剥がしが stable な版であること**である。
型剥がしが既定で有効なのは Node 22.18.0 / 23.6.0 から、stable になるのは 24.12.0 からで
（[Node の仕様](https://nodejs.org/api/typescript.html)）、24.3.0 より前では実行のたびに
experimental の警告が標準エラーへ出る。下限を後者に合わせて `>=24.12.0` にしてある。
下げるなら、EOL だけでなくこちらも見る。

npm は既定では満たさない版でも警告を出すだけで止めないため、`.npmrc` へ
`engine-strict=true` を置いて止めている（置くと `npm ci` が終了コード 1、置かないと
0 を返す。2026-08-25 実測）。

```zsh
npm ci
```

```zsh
npm test
```

```zsh
npm run typecheck
```

ブロックの台帳と選択肢の対応を組み立て直す。組み立てには開発依存の scratch-blocks が
要るため、入口を分けてある。利用者は同梱の台帳をそのまま使う。

```zsh
node tools/cli.ts catalog --check
```

```zsh
node tools/cli.ts options
```

### ドキュメントの中で見出しを指す

別のページの見出しを名指すときは、アンカー付きのリンクで書く。地の文に見出しの名前だけを
書くと、その見出しが改名されたときに宙に浮いたことが誰にも見えない。

```markdown
手順書の[「自己検査項目」](docs/knowledge/howto.md#自己検査項目)を確かめる。
```

`#` の後ろには GitHub が振る見出しの id を書く。作り方は小文字化・記号の除去・空白を
ハイフンへ、の 3 つで、日本語はそのまま残る（`### 6. 生成して検査に掛ける` なら
`#6-生成して検査に掛ける`）。

この形で書かれた参照は `npm test` が見張り、指す先の見出しが消えるか改名されると落ちる。
**この形で書かれていない参照は見張られない。**
