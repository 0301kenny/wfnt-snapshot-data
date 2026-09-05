# REPORT-206 — 修正輪 a2

## 結論

- 狀態: **READY_FOR_REVIEW**。
- 分支 / base: `ticket-206` / `2f4d03317c851f0fd0897786b65291f0084332e0`。
- 本輪失敗次數: **0**。
- 真實網路請求總數: **4**，未超過 a2 硬上限 15；四次皆 HTTP 200，沒有遇到 520 或 `ECONNRESET`。
- 未 commit；真 `data/` 零寫入；未在 repo 根目錄執行 `build-derived`；未修改 `scripts/lib/derived.mjs`、WFNT_app 或 Contract。
- 真實網路與本地驗收寫入均只發生在隔離 tmpdir。

## a2 逐處修改

本輪保留 a1 已經仲裁正確的 B 塊、TWSE parser、兩個 registry、端點接線與測試骨架；沒有重寫或重構。a2 只有以下變更：

1. `scripts/backfill.mjs` 的 `parseTpexSblHist`
   - 將實際欄名改為 `股票代號`、`股票名稱`。
   - 依實測完整 15 欄逐位置驗證 schema，並要求每筆 row 寬度為 15。
   - 移除會命中第一個同名欄位的 `indexOf('當日餘額')`；借券餘額固定取 `row[12]`，代號與名稱固定取 `row[0]`、`row[1]`，與已確認正確的 TWSE parser 策略一致。
   - 保留 `stat === 'ok'` 與 response `date === expectedYmd` 防呆。
2. `tests/backfill.test.mjs`
   - 將 TPEX SBL fixture 更新為實測 15 欄。
   - fixture 的 index 6 融券餘額與 index 12 借券餘額預設即不同。
   - 新增 O-002 負向對照：index 6 為 `INDEX_6_MARGIN_BALANCE`、index 12 為 `INDEX_12_SBL_BALANCE`，精確斷言 parser 回傳後者；沒有放寬既有 assertion。
3. `REPORT-206.md`
   - 覆蓋 a1 的 BLOCKED 報告，保留 a1 已驗證通過的證據並補入 a2 修正與完整驗收結果。

## 三筆 accepted finding 的處置

### O-001 — 已修正

`parseTpexSblHist` 現在驗證真實欄名 `股票代號`／`股票名稱`，不再尋找不存在的 `代號`／`名稱`。真實網路驗收兩天均成功通過 parser：

```text
SHAPE_2 market=tpex fields=15 rows=929 date=20260813
SHAPE_4 market=tpex fields=15 rows=929 date=20260814
```

兩次 TPEX body 都完成 raw write，證明不再拋 `TPEX_SBL: missing field 代號`。

### O-002 — 已修正

production 固定取 `row[12]`，不使用 `indexOf`。負向對照原始輸出：

```text
INPUT_INDEX_6=INDEX_6_MARGIN_BALANCE
INPUT_INDEX_12=INDEX_12_SBL_BALANCE
PARSER_OUTPUT=INDEX_12_SBL_BALANCE
ASSERT_INDEX_12=pass
```

此對照能區分 index 6 的融券餘額與 index 12 的借券餘額；並已納入 `tests/backfill.test.mjs` 的 test 19。

### O-003 — 已處置，維持函式內驗證

沒有修改 `scripts/lib/derived.mjs`。既有 `requiredTpexLegacyTable` 是該模組未 export 的私有函式，且只驗證 `stat` 與 `tables[0].data`，不驗證本端點所需的完整 15 欄位置；`requiredFieldIndexes` 同樣未 export，且其 `indexOf` 語意無法區分兩個 `當日餘額`。在禁止擴 Scope 修改 `derived.mjs` 的前提下，helper 語意與可見性均不相容，因此依 finding 允許的處置維持手刻，並採與 TWSE 相同的完整位置驗證。

## a1 已驗證內容（本輪保留）

兩支借券端點最終契約：

```text
key=twse_sbl_hist
sourceDataset=twse/sbl_hist
url=(ymd) => https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=${ymd}&selectType=SLBNLB&response=json
parser=parseTwseSblHist

key=tpex_sbl_hist
sourceDataset=tpex/sbl_hist
url=(ymd) => https://www.tpex.org.tw/www/zh-tw/margin/sbl?date=${ymd.slice(0,4)}/${ymd.slice(4,6)}/${ymd.slice(6,8)}&response=json
parser=parseTpexSblHist
```

- 兩者均為 `cadence: daily`，namespace 均以 `_hist` 結尾，並已加入各自市場的 `COVERAGE_SOURCES`。
- `ENDPOINTS` 仍為 17 筆；`BACKFILL_ENDPOINTS` 的 14-key 完整 `deepEqual` assertion 保留。
- B 塊只讓純資料端點在 fetch 前檢查 raw；MI_INDEX 與 TPEX dailyQuotes 兩支承重 fetch 不經 skip helper。
- `twseOpenApiCloseExists`／`tpexOpenApiCloseExists` 的資料源判定沒有修改。
- raw response bytes 仍由 `writeRawBytesOnChange` 原樣保存；未建立第二條 derived transformation path。
- `tests/backfill.test.mjs` 的 a1 測試骨架、URL/registry/raw-bytes/date-drift/B 塊/承重路徑精確斷言全部保留。

## 票面驗收

### 1. 完整測試 — PASS

執行 `node --test tests/`：

```text
1..93
# tests 93
# suites 0
# pass 93
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2971.804314
```

總數等於 a1 的 93，且高於 base 的 90；沒有刪測試、skip 或放寬 assertion。

### 2. 兩交易日真實 fetch 與 raw bytes — PASS

隔離 root：

```text
/var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-206-a2-network-H14n5x
```

以 production `runBackfill` 對 `2026-08-13,2026-08-14` 執行一次。前置既有官方 raw 只複製進隔離 root，使真實請求精確限制為兩天各兩支借券端點。四次 production request 均驗證 `backfill.mjs` 的 Chrome/120 UA：

```text
NETWORK_REQUEST_1 ua_ok=true url=https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=20260813&selectType=SLBNLB&response=json
NETWORK_RESPONSE_1 status=200 bytes=155158
SHAPE_1 market=twse fields=15 rows=1299 date=20260813
NETWORK_REQUEST_2 ua_ok=true url=https://www.tpex.org.tw/www/zh-tw/margin/sbl?date=2026/08/13&response=json
NETWORK_RESPONSE_2 status=200 bytes=99190
SHAPE_2 market=tpex fields=15 rows=929 date=20260813
NETWORK_REQUEST_3 ua_ok=true url=https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=20260814&selectType=SLBNLB&response=json
NETWORK_RESPONSE_3 status=200 bytes=155496
SHAPE_3 market=twse fields=15 rows=1299 date=20260814
NETWORK_REQUEST_4 ua_ok=true url=https://www.tpex.org.tw/www/zh-tw/margin/sbl?date=2026/08/14&response=json
NETWORK_RESPONSE_4 status=200 bytes=99328
SHAPE_4 market=tpex fields=15 rows=929 date=20260814
[done] trading=2 skipped=0 resumed=0 rawWritten=4 derivedSymbolsWritten=5360 failed=0
```

實際檔案路徑、bytes 與官方 body 比對：

```text
RAW path=/var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-206-a2-network-H14n5x/data/raw/twse/sbl_hist/2026/2026-08-13.json bytes=155158 equals_official=true
RAW path=/var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-206-a2-network-H14n5x/data/raw/tpex/sbl_hist/2026/2026-08-13.json bytes=99190 equals_official=true
RAW path=/var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-206-a2-network-H14n5x/data/raw/twse/sbl_hist/2026/2026-08-14.json bytes=155496 equals_official=true
RAW path=/var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-206-a2-network-H14n5x/data/raw/tpex/sbl_hist/2026/2026-08-14.json bytes=99328 equals_official=true
NETWORK_REQUESTS_TOTAL=4
```

### 3. B 塊正向與負向 — PASS

使用本地官方 response bytes 注入 `fetchImpl`，新增真實網路請求為 0。原始輸出：

```text
POSITIVE_SIX={"/fund/T86?":0,"/MI_MARGN?":0,"/BWIBBU_d?":0,"/insti/dailyTrade?":0,"/margin/balance?":0,"/afterTrading/peQryDate?":0}
POSITIVE_EXISTING_FILES_UNCHANGED=true
NEGATIVE_DELETE_TWSE_BWIBBU={"/fund/T86?":0,"/MI_MARGN?":0,"/BWIBBU_d?":1,"/insti/dailyTrade?":0,"/margin/balance?":0,"/afterTrading/peQryDate?":0}
LOCAL_FETCH_ONLY=true REAL_NETWORK_REQUESTS_ADDED=0
```

### 4. 承重路徑抵達證明 — PASS

同一個本地官方 bytes harness 的兩狀態輸出：

```text
BEARING_RAW_ABSENT={"trading":1,"twseBearingFetches":1,"tpexBearingFetches":1}
BEARING_RAW_EXISTS={"trading":1,"twseBearingFetches":1,"tpexBearingFetches":1}
BEARING_SAME_CONCLUSION=true
```

raw 已存在時仍各抓承重端點一次，且交易日判定與 raw 不存在時相同。

### 5. OpenAPI 資料源判定未受影響 — PASS

執行：

```bash
git diff -U0 2f4d033 -- scripts/backfill.mjs | rg '^[+-].*(twseOpenApiCloseExists|tpexOpenApiCloseExists)'
```

原始輸出為空；兩個判定行都不在 diff 中。

## 收工檢查

- `git diff --check`: 無輸出。
- `git status --short -- data scripts/lib/derived.mjs`: 無輸出，真 `data/` 與 `derived.mjs` 未變。
- a1 Scope 檔案仍為 `README.md`、`scripts/endpoints.mjs`、`scripts/backfill.mjs`、`scripts/detect-gaps.mjs`、`tests/backfill.test.mjs`；本輪另覆寫本報告。
- 既有未追蹤 `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、`REPORT-194.md` 未動。
- 修正輪 a2 已達 READY_FOR_REVIEW；工作樹依指示保留未 commit。
