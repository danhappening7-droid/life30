# life30 — 12の未来へ、私たちはどこに向かうのか

『LIFE 3.0』第5章の12シナリオ分岐図サイト。Cloudflare Workers（静的アセット）で配信。

- `life30-deploy_1/index.html` … 一般向け
- `life30-deploy_1/forTeen.html` … 小学生・中学生向け
- `life30-deploy_1/favicon.*`, `icon-*.png` … アイコン
- `wrangler.jsonc` … Cloudflare の設定（`life30-deploy_1/` をそのまま配信）

`main` ブランチに push すると Cloudflare Workers Builds が自動でデプロイします。
