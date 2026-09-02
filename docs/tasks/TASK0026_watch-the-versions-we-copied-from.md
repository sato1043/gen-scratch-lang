---
task: TASK0026
status: planning
features:
 - FEAT0002
requirements:
 - SREQ0002
depends-on:
relates-to:
 - TASK0005
 - TASK0024
user-reach: low
dev-reach: high
drive:
irreversible: low
hazard: none
---

写し元の版で陳腐化を見張る
==========================

## 目的

依存に持たないパッケージから写した表が古びたことを、機械で検知できるようにする。

今は検知できない。`staleProvenance` は各項目の `確認した現行版` を **scratch-blocks の
版**とだけ照合する。scratch-vm や scratch-l10n から写した項目は、写し元が動いても
scratch-blocks が動かない限り申告が出ない。**上流が変わっても緑のままである。**

TASK0024 で写しが増えたことで、この穴が実害を持つ規模になった。

## 目的の外にある事実

写した表は 2026-09-03 時点で 4 件ある。

| 表 | 写し元 | 版 |
|---|---|---|
| `PRIMITIVES` | scratch-vm の `src/serialization/sb3.js` | 5.0.300 |
| `EXTENSION_DEFINITIONS` | scratch-vm の `scratch3_pen/index.js` | 5.0.300 |
| `CORE_EXTENSIONS` | scratch-vm の `src/serialization/sb3.js` | 5.0.300 |
| `MENU_OPTIONS`（pen の色のメニュー） | scratch-l10n の `editor/extensions/ja.json` | 版を持たない |

TASK0024 の CP6 で 5 観点が独立に到達した（互換性が高、移植性・信頼性・保守性・
セキュリティが中）。

最後の 1 件は版を持たない。公式の翻訳が rolling で番号を振らないためで、**版で見張る
設計がそのままでは当たらない**。

## 目標

（planning の途中。以下は候補）

- 写し元ごとの版を持ち、その版で確かめ直しの契機を出す（SREQ0002）
- 版を持たない写し元（scratch-l10n）の扱いを決める（SREQ0002）

## 非目標

- 写しをやめて依存を増やすことは扱わない（scratch-vm は 24MB ある）。
  ただし TASK0024 で `MENU_FIELD_OVERRIDES` を `parse-sb3-blocks` からの導出へ
  移せたように、**依存に一次情報が在るものは導出へ格上げする**のが先である
- 上流の汚染検知は扱わない（同じ出所から作ったオラクルでは原理的にできない）

## 問題

- 写し元の版を機械で引く手段が要る。依存に無いパッケージの版は `package-lock.json` に
  現れない
- 版を持たない写し元（scratch-l10n）には別の契機が要る（内容のハッシュか、日付か）
- 契機が出たあと、何を確かめ直せばよいかを人へ伝える必要がある

## 到達基準

（planning の途中）

## 概要設計

（planning の途中）

## 実装計画

（planning の途中）

## 工数概算

（planning の途中。起票時点では見積もっていない）

## 機能への反映

（planning の途中）

## 裁定記録

- **起票する**（2026-09-02・ユーザー）: TASK0024 の CP6 で「起票の線」の外側と判定した
  - 根拠: `staleProvenance` は scratch-blocks の版しか見ない。別の出典の版を追う仕組みは
    今の設計の内側に無く、新しい設計が要る

## stakeholder 未裁定の残課題

- **版を持たない写し元の扱い**: scratch-l10n は版を持たない。内容のハッシュで見張るか、
  確かめ直しの日付で見張るか
- **導出へ格上げできる範囲を先に洗うか**: 依存に一次情報が在れば写す必要が無い。
  TASK0024 では `parse-sb3-blocks` の `remap` が 1 表を肩代わりした


__END__
