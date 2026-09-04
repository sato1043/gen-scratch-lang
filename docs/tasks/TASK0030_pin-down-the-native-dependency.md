---
task: TASK0030
status: planning
features:
requirements:
depends-on:
relates-to:
 - TASK0005
 - TASK0028
user-reach: low
dev-reach: high
drive:
irreversible: low
hazard: none
---

ネイティブ依存の取得経路を確かめる
==================================

## 目的

`canvas` のネイティブ実体が、lockfile の保証の外側で取得され実行されている状態を確かめ、
必要なら断つ。

TASK0025 の CP6（2026-09-04）で攻撃面の供給網の観点が指摘し、再評価層が
`canvas@3.2.3` の install script を一次情報で確認した。**素材の往復とは別の設計**なので
そこでは扱わず、起票して分ける。

## 目的の外にある事実

TASK0028（写した値のライセンス）が `scratch-parser` の AGPL 宣言を扱う。あちらは
**ライセンスの宣言と実態**、こちらは**取得経路の保証**で、対象も手当ても違う。

## 目標

（planning の途中。以下は候補であり確定していない）

- `canvas` が実際に要るかを確かめる
- 要らないなら外す。要るなら取得経路の保証を確かめる

## 非目標

- 依存を最新へ追随させる作業ではない（TASK0005 が上流の版ずれを扱う）
- ライセンスの整理はしない（TASK0028）

## 問題

- `canvas` は `src/` から 1 度も import されていない（実測 2026-09-04）。直接の依存として
  `package.json` に載っているが、使っているのは jsdom で、しかも try/catch の中で
  読めなければ黙って諦める形である ── **欠けても検査は全件緑になる**
- ネイティブ実体は install script（`prebuild-install`）が GitHub Releases から取得する。
  lockfile の `integrity` は npm の tarball にしか掛からないので、この経路は保証の外にある
- 外してよいかは、jsdom が `canvas` を使う経路を実際に通っているかで決まる。通っていない
  ことを測ってから外す

## 到達基準

（planning の途中。目標の確定後に書く）

## 概要設計

（planning の途中）

## 実装計画

（planning の途中）

## 工数概算

（planning の途中。起票時点では見積もっていない）

## 機能への反映

（planning の途中）

## 裁定記録

- **起票する**（2026-09-04・ユーザー）: TASK0025 の CP6 の指摘のうち、これだけを別作業へ
  分ける
  - 根拠: 依存の構成の判断であり、素材の往復の設計の内側に無い。ほかの 11 束は今の設計の
    内側なので TASK0025 で塞いだ

## stakeholder 未裁定の残課題

- **`canvas` を外すか、保証を足すか**: 外すのが最も単純だが、jsdom が必要とする経路が
  実在するなら外せない
- **同じ形の依存がほかにあるか**: install script を持つ依存を洗い出すかどうか


__END__
