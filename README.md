# wfnt-snapshot-data

TW Stock Radar 的每日官方開放資料快照服務。

- 資料來源:TWSE OpenAPI、TPEX OpenAPI、TDCC 開放資料——全部為官方公開的**盤後**資料,本 repo 只做每日留存,不即時、不推播。
- `scripts/probe.mjs` + `probe` workflow 只做連通性煙霧驗證。
- `scripts/run.mjs` + `snapshot` workflow 會在每個平日台北 17:37/19:37/21:37 抓取 7 個日更端點,並在週六/日台北 10:37 視需要抓取 TDCC 週更端點,把官方 response body 原樣落地到 `data/raw/`,並維護 `data/manifest.json`。

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

## TDCC weekly snapshot

週更資料集:

- `tdcc`

TDCC 股權分散表來源為官方 CSV 端點,預設場次也包含此資料集,但會先看 `data/manifest.json` 的 `datasets.tdcc.latestWeek`:若距台北今日不超過 7 天,直接 skip 且不發 fetch。`--datasets=tdcc`、`SNAPSHOT_DATASETS=tdcc` 或 `--force` 會略過這個 freshness 規則。

Raw 路徑固定為:

```text
data/raw/tdcc/{yyyy}/{date}.csv.gz
```

其中 `date` 取 CSV 全列 `資料日期` 欄可解析西元 `YYYYMMDD` 的最大日期。落地檔以 gzip 壓縮,但 raw 權威位元組以 gunzip 後內容為準;gunzip 後必須等於官方 CSV response body,不過濾、不重排、不改換行。

Manifest 的 TDCC 條目使用週語意:

```json
{
  "firstWeek": null,
  "latestWeek": null,
  "weeks": 0,
  "ok": false
}
```

TDCC 不參與 TWSE/TPEX anchor 機制,也不納入 `latestTradingDate`。

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
