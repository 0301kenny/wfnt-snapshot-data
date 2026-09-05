# wfnt-snapshot-data

TW Stock Radar 的每日官方開放資料快照服務。

- 資料來源:TWSE OpenAPI、TPEX OpenAPI、TDCC 開放資料,以及僅供歷史回補的 TWSE/TPEX legacy 與 MOPS 端點——全部為官方公開的**盤後**資料,本 repo 只做留存,不即時、不推播。
- `scripts/probe.mjs` + `probe` workflow 只做連通性煙霧驗證。
- `scripts/run.mjs` + `snapshot` workflow 會在每個平日台北 17:37/19:37/21:37 抓取 12 個日更端點與 4 個月更端點,並在週六/日台北 10:37 視需要抓取 TDCC 週更端點,把官方 response body 原樣落地到 `data/raw/`,並維護 `data/manifest.json`。

## Daily snapshot

日更資料集:

- `twse_mi_index`
- `twse_stock_day_all`
- `twse_bwibbu_all` (`https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL`)
- `twse_mi_margn`
- `tpex_index`
- `tpex_mainboard_close`
- `tpex_3insti`
- `tpex_margin`
- `twse_insider_transfer`
- `tpex_insider_transfer`
- `twse_company_capital`
- `tpex_company_capital`

Raw 路徑固定為:

```text
data/raw/{source_dataset}/{yyyy}/{date}.json
```

Raw 檔是權威層,內容保持官方回應位元組,不重排、不美化、不過濾。`data/manifest.json` 只在資料或狀態實際變更時改寫;同日 no-op 重跑不得產生 diff。

`twse_bwibbu_all` 是上市個股估值日更資料,以全列 `Date` 最大值決定 raw 日期,不作 anchor;列日期不可用時才 fallback 到 TWSE anchor 日。

## Current-only insider and company snapshots

只能從開始抓取日起前向累積的 MOPS OpenAPI 資料集:

- `twse_insider_holding`（月更，`t187ap11_L`）
- `tpex_insider_holding`（月更，`mopsfin_t187ap11_O`）
- `twse_insider_transfer`（日更事件流，`t187ap12_L`）
- `tpex_insider_transfer`（日更事件流，`mopsfin_t187ap12_O`）
- `twse_company_capital`（日更，`t187ap03_L`）
- `tpex_company_capital`（日更，`mopsfin_t187ap03_O`）

這六支端點沒有歷史回補與 derived 轉換。月更持股 raw 使用月頻路徑，四支日更 raw 使用一般日頻路徑；上市與上櫃的欄名逐端點獨立驗證，不假設跨市場一致。

## TWSE/TPEX daily historical backfill

`scripts/backfill.mjs` 只供授權的歷史回補批次使用,不參與 `scripts/run.mjs` 日更流程。它依日抓取官方 TWSE legacy `MI_INDEX`、`T86`、`MI_MARGN`、`BWIBBU_d` 與 TPEX legacy `dailyQuotes`、`dailyTrade`、`balance`、`peQryDate`,把 response body 原樣 bytes 寫入:

```text
data/raw/twse/mi_index_hist/{yyyy}/{date}.json
data/raw/twse/t86_hist/{yyyy}/{date}.json
data/raw/twse/mi_margn_hist/{yyyy}/{date}.json
data/raw/twse/bwibbu_hist/{yyyy}/{date}.json
data/raw/tpex/daily_quotes_hist/{yyyy}/{date}.json
data/raw/tpex/insti_hist/{yyyy}/{date}.json
data/raw/tpex/margin_hist/{yyyy}/{date}.json
data/raw/tpex/pe_hist/{yyyy}/{date}.json
```

TWSE 與 TPEX 各自獨立判斷交易日與 openapi 是否存在。當日已有 `twse/stock_day_all` raw 時,MI_INDEX 與 MI_MARGN 不重複抓取,T86 仍會抓取以補 TWSE 法人欄位,BWIBBU_d 也一律抓取以補估值歷史;已有 `tpex/mainboard_close` raw 時則跳過 dailyQuotes、dailyTrade、balance 三個 TPEX legacy 端點,但 peQryDate 仍一律抓取。Derived 優先使用已有 openapi,只在對應 openapi 缺席時以 hist 補位,並共用日更的單一轉換路徑。範圍回補支援 checkpoint、固定 delay、指數退避與 write-on-change。

所有 backfill-only 來源都在 `scripts/endpoints.mjs` 的 `BACKFILL_ENDPOINTS` 宣告 cadence；8 個 legacy JSON 來源為 `daily`、兩個月營收來源為 `monthly`、兩個季度財報來源為 `quarterly`。缺口覆蓋只取 `daily` 項目再加上各市場 close source。

手動用法(預設寫本 repo `data/`;`--out` 可指向 scratch root):

```bash
node scripts/backfill.mjs --from 2021-07-01 --to 2026-06-30
node scripts/backfill.mjs --from 2021-07-01 --to 2021-07-31 --out ./.backfill-out
```

`scripts/detect-gaps.mjs` 依市場分開計算已覆蓋日期。TWSE 覆蓋是 `mi_index_hist`、`t86_hist`、`mi_margn_hist`、`bwibbu_hist` 與 `stock_day_all` 的聯集;TPEX 覆蓋是 `daily_quotes_hist`、`insti_hist`、`margin_hist`、`pe_hist` 與 `mainboard_close` 的聯集。它會掃描工作日,再以官方 TWSE `MI_INDEX` 判定候選日是否為交易日;預設範圍是兩市場已覆蓋的最小日到最大日,`--from` / `--to` 可覆寫,`--delay-ms` 預設 3000。

上述腳本與日／月／季回補腳本的數值旗標共用 `scripts/lib/cli.mjs`;裸旗標不會被當成數值 `1`,而會由既有的數值驗證訊息拒絕。

明確非交易日會快取到目標 root 的 `.gap-scan-cache.json`,並保留官方 `stat` 原文;請求失敗、逾時或非 200 不會寫入快取。今天與未來日期不納入候選。偵測不可與 `backfill.mjs` 併行。

`backfill.mjs --dates` 只處理逗號分隔清單,繞過現有 checkpoint 且不改寫 `.backfill-progress.json`;單日失敗會繼續後續日期,最後彙總並以非 0 結束。清單不得包含今天或未來日期。偵測後直接補洞的一行原文為:

```bash
dates="$(node scripts/detect-gaps.mjs --dates-only)" && node scripts/backfill.mjs --dates "$dates"
```

隔離 root 的對應用法:

```bash
node scripts/detect-gaps.mjs --from 2026-08-01 --to 2026-08-28 --out /tmp/wfnt-gap-scan
dates="$(node scripts/detect-gaps.mjs --dates-only --out /tmp/wfnt-gap-scan)" && node scripts/backfill.mjs --dates "$dates" --out /tmp/wfnt-gap-scan
```

## Monthly revenue snapshot

月更資料集:

- `twse_monthly_revenue` (`https://openapi.twse.com.tw/v1/opendata/t187ap05_L`)
- `tpex_monthly_revenue` (`https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O`)

這兩個 OpenAPI 端點只提供最新一期。歷史月份由 backfill-only 的 `twse_monthly_revenue_hist` 與 `tpex_monthly_revenue_hist` 補位,分別使用 MOPS 官方 `sii` 與 `otc` 路徑:

```text
https://mopsov.twse.com.tw/nas/t21/{sii|otc}/t21sc03_{roc_year}_{month}_{0|1}.html
```

民國年與月份不補零;每月每市場各抓 `_0` 國內公司與 `_1` 外國企業兩份 big5 HTML。這些 backfill-only 端點不會加入 `scripts/run.mjs` 日更清單。

每個平日場次都會抓取月營收,不作 freshness skip,因為同一申報月內官方內容可能陸續增加。兩者不參與市場 anchor,也不納入 `latestTradingDate`。月鍵取全列可解析 `資料年月` 的最大值,把民國 `yyyMM` 轉成西元 `YYYY-MM`;同一 raw 若夾帶其他月份或不可解析月份的列,derived 會記錄含 dataset、月鍵、列月份與筆數的 warning 並固定排除那些列,raw 權威檔仍保持官方位元組不變。

Raw 路徑固定為:

```text
data/raw/{source_dataset}/{yyyy}/{yyyy}-{mm}.json
```

MOPS 歷史 raw 路徑固定為:

```text
data/raw/twse/monthly_revenue_hist/{yyyy}/{yyyy-mm}_{0|1}.html
data/raw/tpex/monthly_revenue_hist/{yyyy}/{yyyy-mm}_{0|1}.html
```

每個 HTML 檔保持單一官方 response body 的原始 bytes,不轉碼、不合併、不轉成 JSON。`scripts/backfill-monthly.mjs` 以目標檔存在作 checkpoint;短回應、缺少營收統計表標題、解析失敗或 0 資料列都不落 raw。手動回補須指定月份範圍,`--delay-ms` 預設 3000:

```bash
node scripts/backfill-monthly.mjs --from 2023-08 --to 2026-07
node scripts/backfill-monthly.mjs --from 2026-04 --to 2026-06 --out /tmp/wfnt-monthly-smoke
```

Derived 對每個市場、每個月份優先讀取既有 OpenAPI JSON;該月 OpenAPI raw 不存在時才解析兩份 MOPS hist HTML。兩條來源共用 `scripts/lib/derived.mjs` 的單一月營收轉換路徑。

同月官方 body 位元組改變時覆寫同一檔並記為 `revise`;位元組相同時不寫檔。跨月則建立新檔。Manifest 條目使用月語意:

```json
{
  "firstMonth": null,
  "latestMonth": null,
  "months": 0,
  "ok": false
}
```

## Quarterly financial backfill

`scripts/backfill-quarterly.mjs` 只供授權的歷史季度回補使用,不加入 `scripts/run.mjs` 日更清單。它以 POST form 呼叫 MOPS 官方 `ajax_t163sb04`,上市使用 `TYPEK=sii`,上櫃使用 `TYPEK=otc`;回應是 UTF-8 HTML。每季、每市場各保留一份官方 response body 原始 bytes:

```text
data/raw/twse/quarterly_fin_hist/{yyyy}/{yyyy-Qn}.html
data/raw/tpex/quarterly_fin_hist/{yyyy}/{yyyy-Qn}.html
```

回補範圍用 `--from YYYY-Qn --to YYYY-Qn` 指定,`--from` 必須是 Q1,因為 Q2/Q3/Q4 的單季數字由同年前一季累計值差分取得。`--delay-ms` 預設 3000;目標檔已存在就跳過。可用 `--out` 將所有 raw 寫到隔離 root:

```bash
node scripts/backfill-quarterly.mjs --from 2021-Q1 --to 2026-Q2
node scripts/backfill-quarterly.mjs --from 2025-Q1 --to 2025-Q2 --out /tmp/wfnt-quarterly-backfill --delay-ms 3000
```

解析只選 header 含 `營業毛利（毛損）` 的一般業表,以 header 文字定位營業收入、營業毛利、營業利益與本期淨利。Q1 直接使用累計絕對數;其餘季度先對四個絕對數做差分再計算三率。前一季 raw 或同代號前一季列缺席、必要值缺失、單季營業收入非正數時不產出該季列。

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

Fundamentals 的 valuation、revenue、quarterly 序列由 `scripts/lib/derived.mjs` 的單一 registry 定義欄位、rolling window、`updated` 參與資格與 metadata 優先權；目前只有 valuation 與 revenue 參與 `updated` 日期。

Derived 代號分桶:

```text
data/derived/symbols/{p2}/{id}.json
data/derived/tdcc/{p2}/{id}.json
data/derived/fundamentals/{p2}/{id}.json
data/derived/market.json
```

`{p2}` 是代號前 2 字元原樣,例如 `2330` -> `23`,`00400A` -> `00`。Symbols、TDCC 與 fundamentals derived 都排除純數字 6 碼代號 (`/^\d{6}$/`),其餘代號保留,包含 4 碼股票、特別股、ETF/ETN 等。Raw 不過濾。

### Symbol daily series

`data/derived/symbols/{p2}/{id}.json`:

```json
{
  "id": "2330",
  "name": "台積電",
  "market": "twse",
  "updated": "2026-07-03",
  "cols": ["d", "o", "h", "l", "c", "v", "t", "mb", "ms", "fi", "ff", "ft", "fd"],
  "rows": [[20260703, 1080, 1090, 1075, 1085, 32145678, 45210, 9577, 120, null, null, null, null]]
}
```

- `d`:西元 `yyyymmdd` 整數;`updated` 是 rows 最大日期 ISO。
- `o/h/l/c`:開高低收,照 raw 數字單位。
- `v`:成交股數;`t`:成交筆數。
- `mb/ms`:融資/融券今日餘額,單位張。
- `fi`:三大法人合計買賣超,單位股。TWSE 取 T86 `三大法人買賣超股數`;TPEX 取 `TotalDifference`。
- `ff`:外資(含陸資)買賣超,單位股。TWSE 為 T86 `外陸資買賣超股數(不含外資自營商)` 加 `外資自營商買賣超股數`;TPEX 來源欄位以去空白後的 `ForeignInvestorsIncludeMainlandAreaInvestors-Difference` 縮寫版為準,不取含 `(Foreign Dealers excluded)` 的長版。
- `ft`:投信買賣超,單位股。TWSE 取 T86 `投信買賣超股數`;TPEX 取 `SecuritiesInvestmentTrustCompanies-Difference`;缺欄時為 `null`。
- `fd`:自營商買賣超,單位股。TWSE 取 T86 `自營商買賣超股數`;TPEX 取 `Dealers-Difference`;缺欄時為 `null`。
- Rows 依 `d` 升冪,rolling window 預設 1300 筆交易日。

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

### Fundamentals series

`data/derived/fundamentals/{p2}/{id}.json`:

```json
{
  "id": "2330",
  "name": "台積電",
  "market": "twse",
  "updated": "2026-07-16",
  "valuation": { "cols": ["d", "per", "pbr", "dy"], "rows": [[20260716, 25.1, 5.2, 1.8]] },
  "revenue": { "cols": ["m", "rev", "yoy", "mom"], "rows": [[202606, 123456789, 12.3, -1.2]] },
  "quarterly": { "cols": ["q", "gm", "om", "nm"], "rows": [[20252, 58.62, 49.63, 42.57]] }
}
```

- `name` / `market`:來源列公司名稱與資料集市場。若同代號跨來源碰撞,TWSE metadata 優先;TWSE 與 TPEX 皆有估值來源。
- `updated`:valuation 最大 `d` 轉 ISO 日期與 revenue 最大 `m` 轉該月 1 日後,取兩者較新值;因此僅有月營收時例如 `202606` 為 `2026-06-01`。Quarterly 不參與 `updated`,避免季度鍵改變既有日期語意。此規則不依執行時間,可確定性重建。
- `d`:西元 `yyyymmdd` 整數;`per` / `pbr` / `dy` 分別是 `PEratio` / `PBratio` / `DividendYield`。TWSE 估值採 openapi 優先、legacy fallback;TPEX 估值只有 legacy 來源。Rolling window 1300 筆。
- `m`:西元 `yyyymm` 整數;`rev` 是 `營業收入-當月營收` 的千元原值,不換算;`yoy` / `mom` 分別是去年同月與上月比較增減百分比。月營收採 OpenAPI 優先、MOPS hist fallback。Rolling window 36 筆。
- `q`:西元年乘 10 加季別,例如 2025Q1 為 `20251`;`gm` / `om` / `nm` 是差分後單季毛利率、營益率、淨利率,百分比四捨五入至小數 2 位。只涵蓋 MOPS 一般業表,rolling window 24 季。
- 所有數值會移除千分位逗號後轉 Number;空字串、`--`、非有限數或不可解析值為 `null`。Rows 依 `d` / `m` / `q` 升冪並以同鍵 upsert。

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
node scripts/detect-gaps.mjs
node scripts/backfill.mjs --dates 2026-08-17,2026-08-18 --out /tmp/wfnt-daily-hole-fill
node scripts/backfill-monthly.mjs --from 2023-08 --to 2026-07 --out /tmp/wfnt-monthly-backfill
node scripts/backfill-quarterly.mjs --from 2021-Q1 --to 2026-Q2 --out /tmp/wfnt-quarterly-backfill
node scripts/build-derived.mjs
```

測試:

```bash
node --test tests/
```

端點失敗會隔離到單一 dataset,manifest 以確定性 `lastError` 記錄,同日後續場次會自動重試。整個 job 只在兩個 anchor 都失敗或零端點成功時失敗。

## History policy

本 repo 的 git 歷史不是永久保存機制。權威留存是目前 working tree 中的快照資料與後續發佈封存;允許年度 squash 或重置歷史以控制 repo 體積。
