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

TDCC 股權分散表來源為官方 CSV 端點,預設場次也包含此資料集,但會先看 `data/manifest.json` 的 `datasets.tdcc.latestWeek`:若距台北今日不超過 7 天,直接 skip 且不發 fetch。`--force` 會略過這個 freshness 規則。

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

## Derived data

`data/derived/` 是 App 讀取用的緊湊序列層,由 raw 全量重建而來。Raw 仍是權威位元組;derived 可刪除後用 `node scripts/build-derived.mjs` 重建。`scripts/run.mjs` 在 raw 有 `write`、`revise` 或 `forced` 時,會用同一套 `scripts/lib/derived.mjs` 依日期增量重算。

Derived 代號分桶:

```text
data/derived/symbols/{p2}/{id}.json
data/derived/tdcc/{p2}/{id}.json
data/derived/market.json
```

`{p2}` 是代號前 2 字元原樣,例如 `2330` -> `23`,`00400A` -> `00`。Symbols 與 TDCC derived 都排除純數字 6 碼代號 (`/^\d{6}$/`),其餘代號保留,包含 4 碼股票、特別股、ETF/ETN 等。Raw 不過濾。

### Symbol daily series

`data/derived/symbols/{p2}/{id}.json`:

```json
{
  "id": "2330",
  "name": "台積電",
  "market": "twse",
  "updated": "2026-07-03",
  "cols": ["d", "o", "h", "l", "c", "v", "t", "mb", "ms", "fi"],
  "rows": [[20260703, 1080, 1090, 1075, 1085, 32145678, 45210, 9577, 120, null]]
}
```

- `d`:西元 `yyyymmdd` 整數;`updated` 是 rows 最大日期 ISO。
- `o/h/l/c`:開高低收,照 raw 數字單位。
- `v`:成交股數;`t`:成交筆數。
- `mb/ms`:融資/融券今日餘額,單位張。
- `fi`:三大法人合計買賣超,單位股。TWSE 個股法人欄位不存在,固定 `null`;TPEX 取 `TotalDifference`。
- Rows 依 `d` 升冪,rolling window 預設 480 筆交易日。

### TDCC weekly series

`data/derived/tdcc/{p2}/{id}.json`:

```json
{
  "id": "2330",
  "updated": "2026-07-03",
  "cols": ["w", "big1000", "big400", "retail", "holders", "avgShares"],
  "rows": [[20260703, 47.1, 61.3, 8.2, 512345, 5123]]
}
```

- `w`:TDCC CSV `資料日期` 的 `yyyymmdd` 整數。
- `big1000`:分級 15 的占比,千張以上。
- `big400`:分級 12+13+14+15 占比,400 張以上。
- `retail`:分級 1+2+3 占比,10 張以下。
- `holders`:分級 17 合計人數。
- `avgShares`:分級 17 股數除以人數,四捨五入整數;人數為 0 時為 `null`。
- 分級 16 差異數調整不參與加總。缺分級 17 的證券會跳過。
- Rows 依 `w` 升冪,rolling window 預設 64 週。

### Market series

`data/derived/market.json`:

```json
{
  "updated": "2026-07-03",
  "twse": {
    "index": { "cols": ["d", "c"], "rows": [[20260703, 52227.97]] },
    "margin": { "cols": ["d", "mb", "ms"], "rows": [] }
  },
  "tpex": {
    "index": { "cols": ["d", "o", "h", "l", "c"], "rows": [] },
    "margin": { "cols": ["d", "mb", "ms"], "rows": [] },
    "insti": { "cols": ["d", "fi"], "rows": [] }
  }
}
```

- `twse.index`:發行量加權股價指數收盤值;TWSE 官方指數端點無 OHLC。
- `tpex.index`:TPEX 指數 OHLC;raw 單檔含多日,derived 逐列 upsert。
- `twse.margin` / `tpex.margin`:由個股融資融券餘額列加總的推算聚合值,單位張。
- `tpex.insti`:TPEX 個股 `TotalDifference` 加總,單位股。
- Market rows 全量保留,不設 rolling window。

## Operations

本 repo 零 secret。GitHub Actions 使用預設 `GITHUB_TOKEN` push 自己,權限只需要 `contents: write`。

手動執行:

```bash
node scripts/run.mjs
node scripts/run.mjs --datasets=twse_mi_index,tpex_index
node scripts/run.mjs --force
node scripts/build-derived.mjs
```

測試:

```bash
node --test tests/
```

端點失敗會隔離到單一 dataset,manifest 以確定性 `lastError` 記錄,同日後續場次會自動重試。整個 job 只在兩個 anchor 都失敗或零端點成功時失敗。

## History policy

本 repo 的 git 歷史不是永久保存機制。權威留存是目前 working tree 中的快照資料與後續發佈封存;允許年度 squash 或重置歷史以控制 repo 體積。
