---
task: TASK0022
status: planning
features:
requirements:
depends-on:
 - TASK0008
relates-to:
user-reach: low
dev-reach: medium
drive:
irreversible: low
hazard: none
---

型だけの import を、構文で見分けられるようにする
================================================

## 目的

型としてしか使わない import を、値の import と構文で分ける。今は
`verbatimModuleSyntax` を立てていないので、型だけの import を値として書いても
型検査が通る。

TASK0008 で全ファイルを `.ts` へ移し、型の import が 20 箇所以上増えた。書き方は
`import { type X }` と `import type { X }` が混在しており、どちらでも通るため
**書き手が選ぶたびに揺れる**（CP6 の移植性が指摘）。

型剥がしで実行するので、値として書かれた型だけの import は実行時に残り、存在しない
export を読みに行く経路になりうる。

## 目標

- `verbatimModuleSyntax` を立て、型だけの import が構文で見分けられる状態にする
- 既存の import をその規則へ揃える
- 揃えたことが破壊で確かめられる（規則から外れた書き方が落ちる）

## 非目標

- import の並び順・グルーピングの整形をしない
- 依存の構成を変えない

## 問題

- **波及が全ファイルへ及ぶ。** TASK0008 と同じ規模の機械的な書き換えになる。
  変換器を書くなら、変換とは別に照合を置く（TASK0008 で有効だった形）
- **上流の型定義が `verbatimModuleSyntax` と噛み合うかを測っていない。**
  `types/externals.d.ts` の ambient 宣言と、CommonJS な依存の読み込みが影響を受けうる

## 到達基準

- [ ] `verbatimModuleSyntax` が立ち、型検査が 0 件
- [ ] 規則から外れた書き方を 1 つ置くと落ちることを確かめてある
- [ ] 自動テストが終了コード 0 で通り、スキップ 0 件
