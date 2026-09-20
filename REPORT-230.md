# TICKET-230 Executor Report

- status: `READY_FOR_REVIEW`
- attempt: `1`
- branch: `ticket-230`
- base/head at handoff: `9b3fdd23718ebab45c537dfbd084ebf2b2ec1994`
- network: 未打真實網路；回補測試全部使用注入的 `fetchImpl` fixture
- generated data: 未手動修改任何 `data/**`；未對真實 `data/` 執行 `build-derived.mjs`
- commit: 未 commit，改動留在 working tree

## 驗收

### A1 PASS — 既有測試不退步且總數增加

實跑：`rtk node --test tests/`

```text
1..122
# tests 122
# suites 0
# pass 122
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5947.624289
exit=0
```

基線為 114 tests；本次 122 > 114。barrel 守衛亦為第 122 項且通過：

```text
# Subtest: every test module is imported by the test barrel
ok 122 - every test module is imported by the test barrel
```

### A2 PASS — parser、黃金值、降冪轉升冪、尾端逗號

實跑：`rtk node --test tests/taifex-pcr.test.mjs`

```text
# Subtest: TAIFEX PCR parser maps real-format values, accepts the trailing comma, and sorts ascending
ok 1 - TAIFEX PCR parser maps real-format values, accepts the trailing comma, and sorts ascending
# A2_PARSER_ROWS=[[20240201,100.54,111.61],[20240229,105.91,127.09],[20260831,118.35,96.12]]
```

`20260831` 的成交量 PCR `118.35`、OI PCR `96.12` 均符合 HF5；輸入列為降冪，輸出為升冪，且官方格式的尾端逗號未造成欄位位移。

### A3 PASS — 欄數不足與非數字明確拋錯

```text
# Subtest: TAIFEX PCR parser throws for short and non-numeric data rows
ok 2 - TAIFEX PCR parser throws for short and non-numeric data rows
# A3_SHORT_ROW=THREW A3_NON_NUMERIC=THREW
```

實作驗證日期後第 2～7 欄全部為有限數值，不只驗證兩個輸出 ratio 欄。

### A4 PASS — HTTP 200 + 零資料列失敗且不寫 raw

```text
# Subtest: HTTP 200 with zero PCR data rows retries with backoff, fails, and writes no raw
ok 4 - HTTP 200 with zero PCR data rows retries with backoff, fails, and writes no raw
# A4_HTTP=200 A4_ROWS=0 A4_FETCH_CALLS=3 A4_BACKOFFS=25,50 A4_RAW_EXISTS=false
```

fixture 回傳 HTTP 200 錯誤頁；實作依「解析資料列 > 0」判斷合法性，經 25ms、50ms 指數退避後仍失敗，`data/raw/taifex/pcr/2026/2026-08.csv` 不存在。

另驗證失敗月份不阻斷後續月份，最後統一 non-zero/throw：

```text
# PCR_CONTINUE_RESULT={"months":2,"requests":2,"skipped":0,"rawWritten":1,"derivedWritten":1,"rows":2,"failures":[{"month":"2026-07","error":"2026-07: TAIFEX PCR: response has 0 data rows"}]}
```

### A5 PASS — derived upsert 與 byte-level 冪等

```text
# Subtest: TAIFEX PCR derived upsert preserves market series and is byte-idempotent
ok 6 - TAIFEX PCR derived upsert preserves market series and is byte-idempotent
# A5_TAIFEX_PCR={"cols":["d","vol","oi"],"rows":[[20260803,102.71,97.66],[20260831,118.35,96.12]]} A5_SECOND_WRITE=false A5_BYTES_EQUAL=true
```

測試同時確認既有 `twse.index` 列仍保留；第二次套用回報 `market: false` 且檔案 bytes 完全相同。

### A6 PASS — 隔離 tmpdir 從 raw 完整重建

```text
# Subtest: buildDerived rebuilds TAIFEX PCR market data from isolated raw
ok 7 - buildDerived rebuilds TAIFEX PCR market data from isolated raw
# A6_BUILD_SUMMARY={"dailyDates":0,"taifexPcrMonths":1,"monthlyMonths":0,"quarterlySeasons":0,"tdccWeeks":0,"macroSeries":0,"files":1} A6_TAIFEX_PCR={"cols":["d","vol","oi"],"rows":[[20260803,102.71,97.66],[20260831,118.35,96.12]]}
```

測試以 `mkdtemp` 建立只含 `data/raw/taifex/pcr/**` 的隔離 root，再呼叫 `buildDerived({ rootDir })`；未接觸 repo 真實 `data/derived/`。

## 改動檔案

- `AGENTS.md`：只擴充 endpoint allowlist 與 TAIFEX PCR raw 路徑／合法性規則。
- `scripts/endpoints.mjs`：在 `BACKFILL_ENDPOINTS` 末尾追加 `taifex_pcr`，宣告 `cadence: 'monthly'`、`sourceDataset: 'taifex/pcr'` 與固定官方 URL；未加入 `ENDPOINTS`。
- `scripts/backfill-pcr.mjs`：新增專用月回補 CLI；每次 POST 一個完整曆月、保留官方 bytes、合法 raw checkpoint、write-on-change、指數退避、逐月續跑與最終失敗摘要；所有數值旗標走 `parseNumericFlag`。
- `scripts/lib/derived.mjs`：新增 Big5 PCR parser、嚴格欄寬／數值驗證、日期升冪排序、`market.json` 的 `taifex.pcr` template／normalize／updated 參與及共用 upsert/write-on-change 路徑。
- `scripts/build-derived.mjs`：掃描 `data/raw/taifex/pcr/{yyyy}/{yyyy-mm}.csv` 並透過共用 `applyTaifexPcrMonth` 全量重建，摘要增加 `taifexPcrMonths`。
- `tests/backfill.test.mjs`：依授權只在既有 key 清單末尾追加 `taifex_pcr`，並新增 sourceDataset／URL 斷言；`ENDPOINTS.length === 17` 未動。
- `tests/all.mjs`：只追加 `import './taifex-pcr.test.mjs';`，既有 import 順序未動。
- `tests/taifex-pcr.test.mjs`：新增 8 項 fixture-only 測試，覆蓋 A2～A6、POST body/raw bytes/checkpoint、跨月失敗續跑與 shared numeric guard。
- `REPORT-230.md`：本交付報告。

## removed_capabilities

- capability: `none`
  - evidence: `rtk git diff --diff-filter=D --name-only` 無輸出，沒有刪除檔案；`rtk git diff --unified=0 -- tests/backfill.test.mjs tests/all.mjs` 顯示既有測試只有 `4 insertions(+), 0 deletions(-)`；完整 gate 由基線 114/0 增為 122/0；`ENDPOINTS.length === 17` 的既有斷言原封不動。
  - comparison conclusion: 未移除任何既有行為、欄位、輸出或斷言；既有五條 market series 會被 normalize 保留，新增 PCR 測試亦實證保留既有 `twse.index`。
  - successor: `N/A`（零移除，無需承接者）。
  - allowlist_expansion:
    - endpoint rule: 只新增一個官方、backfill-only 的 TAIFEX 月頻 Put/Call Ratio 端點 `https://www.taifex.com.tw/cht/3/pcRatioDown`；未放寬到其他 TAIFEX URL，未進 daily pipeline。
    - raw rule: 只新增 `data/raw/taifex/pcr/{yyyy}/{yyyy-mm}.csv`，要求保存官方 Big5 bytes 且解析資料列必須大於零；未授權或改動 `data/raw/taifex/vix_monthly/**`。

## 票面未明示處的選擇

1. endpoint key 選為 `taifex_pcr`：與既有 snake_case key 慣例及 `sourceDataset: 'taifex/pcr'` 對齊。
2. 選擇新增 `scripts/backfill-pcr.mjs`，不改 `backfill-monthly.mjs`：兩者 HTTP method、raw 格式、成功判準與失敗重試語意不同，獨立腳本可避免改變 MOPS 行為。
3. 有效的既存 raw 作為月 checkpoint：重跑會略過 fetch、重新套用 derived，raw mtime 與 bytes 不變；既存 raw 若解析失敗則重新抓取修復。
4. 月份失敗策略採「記錄後繼續，全部月份結束再拋錯並附 summary」：確保失敗月份可續跑，也不吞錯。
5. 預設 `maxRetries = 4`、`retryBaseMs = 1000`，退避為 1s/2s/4s/8s；這可涵蓋 baseline 記錄的連續四次 522，且仍有有限上限。
6. `market.updated` 納入 `taifex.pcr` 日期：PCR 是 `market.json` 的同型市場級序列；baseline 證明實際 PCR 日期為 TWSE index 子集，因此不會把既有真實市場日期向前推移。
7. parser 對日期後全部六個欄位做有限數值驗證：採較嚴格解讀，避免未輸出的成交量／未平倉量欄位損壞卻被視為合法 raw。

## 最終 scope 稽核

```text
$ rtk git rev-parse HEAD
9b3fdd23718ebab45c537dfbd084ebf2b2ec1994
$ rtk git branch --show-current
ticket-230
$ rtk git diff --check
(no output)
$ rtk git status --short -- data scripts/probe.mjs .github/workflows/probe.yml
(no output)
```

原有未追蹤 `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、`REPORT-194.md` 未碰。
