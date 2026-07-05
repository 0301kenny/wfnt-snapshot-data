# wfnt-snapshot-data

TW Stock Radar 的每日官方開放資料快照服務。

- 資料來源:TWSE OpenAPI、TPEX OpenAPI、TDCC 開放資料——全部為官方公開的**盤後**資料,本 repo 只做每日留存,不即時、不推播。
- `scripts/probe.mjs` + `probe` workflow 只做連通性煙霧驗證。
- `scripts/run.mjs` + `snapshot` workflow 會在每個平日台北 17:37/19:37/21:37 抓取 7 個日更端點,把官方 response body 原樣落地到 `data/raw/`,並維護 `data/manifest.json`。

## Daily snapshot

日更資料集:

- `twse_mi_index`
- `twse_stock_day_all`
- `twse_mi_margn`
- `tpex_index`
- `tpex_mainboard_close`
- `tpex_3insti`
- `tpex_margin`

Raw 路徑固定為:

```text
data/raw/{source_dataset}/{yyyy}/{date}.json
```

Raw 檔是權威層,內容保持官方回應位元組,不重排、不美化、不過濾。`data/manifest.json` 只在資料或狀態實際變更時改寫;同日 no-op 重跑不得產生 diff。

## Operations

本 repo 零 secret。GitHub Actions 使用預設 `GITHUB_TOKEN` push 自己,權限只需要 `contents: write`。

手動執行:

```bash
node scripts/run.mjs
node scripts/run.mjs --datasets=twse_mi_index,tpex_index
node scripts/run.mjs --force
```

測試:

```bash
node --test tests/
```

端點失敗會隔離到單一 dataset,manifest 以確定性 `lastError` 記錄,同日後續場次會自動重試。整個 job 只在兩個 anchor 都失敗或零端點成功時失敗。

## History policy

本 repo 的 git 歷史不是永久保存機制。權威留存是目前 working tree 中的快照資料與後續發佈封存;允許年度 squash 或重置歷史以控制 repo 體積。
