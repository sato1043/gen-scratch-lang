---
task: TASK0027
status: planning
features:
requirements:
depends-on:
relates-to:
 - TASK0024
user-reach: low
dev-reach: high
drive:
irreversible: low
hazard: none
---

Windows の合否を機械で測る
==========================

## 目的

Windows で退行が起きたことを、機械で捕まえられるようにする。

今は捕まらない。手元（Windows）は `npm test` の終了コードが常に非 0 で、CI は
`runs-on: ubuntu-latest` だけを回す。**Windows 固有の退行を機械で検知する経路が
どこにも無い。**

README は Windows を「開発機で常用」と書いており、検証している環境として挙げている。
実態は「人が集計行を読んで確かめている」である（TASK0024 で注記を足した）。

## 目的の外にある事実

TASK0024 の CP6 で 2 観点が独立に到達した（移植性・信頼性がともに高）。

終了コードが常に非 0 になるのは `test/read-output.test.ts` がプロセスの終了時に落ちる
ためで、**ファイル内の 20 件はすべて通る**。実装前の版（`78432df`）へ戻しても再現する
既存の挙動である。原因は切り分けていない（symlink を飛ばすと終了コードが 127 から 1 へ
変わるが、ファイル単位の失敗は残る）。

CI へ Windows のランナーを足すだけでは通らない。現行の workflow は 2 ステップが POSIX を
前提にしている（`test ! -d ...`・`--out /tmp/...`）。

## 目標

（planning の途中。以下は候補）

- `test/read-output.test.ts` がプロセス終了時に落ちる原因を切り分ける
- Windows で `npm test` の終了コードが合否を表すようにする
- CI で Windows を回す

## 非目標

- Windows 以外の環境（macOS・musl・arm64）を足すことは扱わない
- テストランナーを取り替えることは扱わない

## 問題

- 原因が切り分けられていない。全テストが通るのにプロセスが非 0 で終わる
- CI へ OS を足すと実行時間と課金が増える。ネイティブ依存（canvas・resvg）の
  ビルドが Windows で通るかも未確認
- workflow の POSIX 依存を解く必要がある

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
  - 根拠: workflow の POSIX 依存を解き、原因不明の異常終了を切り分ける必要がある。
    今の設計の内側では扱えない

## stakeholder 未裁定の残課題

- **CI で Windows を回すか、手元で測れるようにするだけにするか**: 前者は実行時間と
  課金が増える。後者なら終了コードの問題だけを直す
- **原因の切り分けにどこまで手を掛けるか**: 全テストが通るのにプロセスが落ちるので、
  ランナーか Node かネイティブ依存かの層から絞る必要がある


__END__
