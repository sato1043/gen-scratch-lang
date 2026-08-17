main ブランチ保護の設定
=======================

- 日付: 2026-08-22
- 対象: `sato1043/gen-scratch-lang` の `main`
- 出典: 一次情報（`gh api repos/sato1043/gen-scratch-lang/branches/main/protection`）
- 確度: 高（API から直に引いた値。2026-08-20 に取った写しと 2026-08-22 の再測定が一致）

追跡下のどこにもこの設定が記録されておらず、設定を確かめるには API を叩くしかない状態
だった。設定が変わったときに「いつ何が変わったか」を辿れるよう、時点の事実として残す。


## 現在の値（2026-08-22 測定）

| 項目 | 値 |
|---|---|
| PR 必須 | 有効 |
| 必要な承認レビュー数 | **0** |
| 必須ステータスチェック | `test (24)` / `audit`（strict = 最新の main へ追従を要求）|
| 管理者にも適用（`enforce_admins`）| 有効 |
| linear history 必須 | 有効 |
| force-push | 禁止 |
| ブランチ削除 | 禁止 |

```json
{
  "required_status_checks": { "strict": true, "contexts": ["test (24)", "audit"] },
  "enforce_admins": true,
  "required_approving_review_count": 0,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```


## 規範との照合（2026-08-22 再判定・食い違いは無い）

**実設定は標準規定の「solo 変種」と全項目で一致する。**
`~/.claude/references/git-operation-standards.md` は複数メンテナ前提の既定を書いた後に
「単独メンテナのリポジトリでは次を調整する（solo 変種）」の節を持ち、そこで
`Require approvals は 0（PR 必須は維持）。1 以上だと自分の PR を自分で承認できずマージが
詰む` と定めている。

| 項目 | 規定（solo 変種）| 実設定 | |
|---|---|---|---|
| 必要な承認レビュー数 | 0 | 0 | 一致 |
| PR 必須 | 維持 | 有効 | 一致 |
| force-push | 禁止 | 禁止 | 一致 |
| linear history | 維持 | 有効 | 一致 |
| status check 必須 | 維持 | 有効 | 一致 |
| `enforce_admins` | AI エージェント運用では true | true | 一致 |

**この節は当初「食い違いがある」と書いていた。誤りだった。** CLAUDE.md の要約行
（「main ブランチ保護: PR 必須・レビュー承認 1 名以上・…」）だけを読み、その要約が
名指している参照先を開かずに書いたためである。要約は複数メンテナ前提の既定だけを述べ、
solo 変種に触れていない。**直すべきは実設定でも詳細規定でもなく、要約の側**である
（`~/.claude` の作業として別に扱う）。

## 履歴

- 2026-08-22 記録を起こす。`.claude/tmp/main-protection.json`（2026-08-20 に取った
  写し）が短命な置き場に留まっていたので、再測定して記録層へ移した
- 2026-08-22 「規範との食い違い」の節を撤回し、照合の結果へ書き直した。詳細規定の
  solo 変種を読まずに要約行だけで食い違いを申告していた


## 要裁定の判断点

なし（2026-08-23 検分。保護設定の全 7 項目と、標準規定の solo 変種との照合を見た。
要約行の直しは `~/.claude` 側の作業であり、本リポジトリの作業書が裁定する判断点では
ない）。


__END__
