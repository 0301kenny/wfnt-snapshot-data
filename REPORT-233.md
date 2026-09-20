# TICKET-233 Executor Report

- Status: `READY_FOR_REVIEW`
- Attempt: `1`
- Branch / base: `ticket-233` / `a359035`
- Network: 未使用真實網路；所有 request 都由注入的 `fetchImpl` fixture 回應。
- Data safety: 未手動修改 `data/**`，未對真實 `data/` 執行 `build-derived.mjs`，未修改 `data/raw/taifex/vix_monthly/**`。
- Commit: 未 commit，改動留在 working tree。

## 實作摘要

1. 外資期貨預設範圍的 `toMonth` 改為台北時區當月；起點仍是動態往回三年後的第一個完整月份，沒有寫死日期。
2. 當執行範圍包含當月時，從同一 `rootDir` 的 `data/raw/taifex/pcr/{yyyy}/{yyyy-mm}.csv` 解析該月資料，取最大交易日作為外資期貨 `queryEndDate`；歷史月份仍使用月底。
3. 共用 monthly runner 新增 `refreshExistingRawForMonth(monthKey)`，原本的 `refreshExistingRaw` 布林與預設值不變。PCR 與外資期貨只 refresh 台北時區當月；VIX 仍以既有 `refreshExistingRaw: true` 全範圍 refresh。
4. refresh 後仍先做既有內容驗證，再由 byte equality 決定是否寫 raw；既有 `!response.ok` 快速失敗與「資料列 > 0／外資首行 `日期,`」判準未更動。
5. `README.md` 已改成「當月終點必須是已有資料的交易日，來源為 PCR raw 末交易日」，不再宣稱只要終點不在未來即可。

## A1～A10 驗收

### A1 PASS — 全套測試增加且無退步

命令：

```text
node --test tests/
```

實跑輸出（尾段）：

```text
1..154
# tests 154
# suites 0
# pass 154
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7689.885964
```

基線為 146 pass / 0 fail；本次為 **154 pass / 0 fail**，總數增加 8。

### A2 PASS — 當月終點取自 PCR raw 末交易日

測試使用開票 evidence `pcr_future.bin` 的 byte-identical base64 fixture，並固定驗證 818 bytes 與 SHA-256 `65f5396d6781a2baa24e2e302f36f74004a3064583b0def7cd4e4d933649905b`。

實跑輸出：

```text
ok 1 - TICKET-233 A2 uses the last date in current-month PCR raw as the foreign-futures query end
# A2_QUERY_END=2026/09/18 PCR_EVIDENCE_BYTES=818
```

### A3 PASS — 週日不使用今天作終點

注入時鐘為 `2026-09-20`（週日）。

實跑輸出：

```text
ok 2 - TICKET-233 A3 does not substitute Sunday today for the last PCR trading date
# A3_TODAY=2026/09/20 A3_QUERY_END=2026/09/18
```

### A4 PASS — 歷史月份維持月底

實跑輸出：

```text
ok 3 - TICKET-233 A4 keeps calendar month-end for historical foreign-futures requests
# A4_QUERY_END=2026/07/31
```

### A5 PASS — PCR 依賴缺失或無資料列時不猜日期

選擇的行為是 **fail-fast**：整次外資期貨 invocation 在任何 fetch 前 reject。缺檔與可讀但零資料列兩種形狀都有覆蓋，請求數皆為 0。

實跑輸出：

```text
ok 4 - TICKET-233 A5 fails before fetch when current-month PCR raw is missing or has no rows
# A5_MISSING=FAILED A5_ZERO_ROWS=FAILED A5_REQUESTS=0
```

### A6 PASS — PCR 與外資期貨當月檔每次重新取得

兩者都先放入有效當月 raw，再執行一次；fixture bytes 相同，因此有 request、沒有 skip，也沒有不必要的 raw rewrite。

實跑輸出：

```text
ok 5 - TICKET-233 A6 refreshes existing current-month PCR and foreign-futures raw
# A6_PCR_REQUESTS=1 A6_FOREIGN_REQUESTS=1
```

該測試另斷言兩者皆為 `skipped=0`、`rawWritten=0`。

### A7 PASS — 只有當月 refresh，歷史月份仍 checkpoint

實跑輸出：

```text
ok 6 - TICKET-233 A7 refreshes only the current month and checkpoints historical months
# A7_PCR=1/2 A7_FOREIGN=1/2 A7_SKIPPED=1/1
```

PCR 與外資期貨各跑 2 個月，都只有 1 個 request、1 個歷史月份 skip；總請求數不等於總月份數。

### A8 PASS — write-on-change 與 `market.json` 冪等

同一外資 payload 連跑兩次，第二次仍有當月 request，但不重寫 raw 或 derived；`market.json` bytes 相同，既有 `taifex.pcr` 與 `taifex.vix` series 完整保留。

實跑輸出：

```text
ok 7 - TICKET-233 A8 current-month refresh is byte-idempotent and preserves PCR and VIX series
# A8_SECOND_RAW_WRITTEN=0 A8_SECOND_DERIVED_WRITTEN=0 A8_MARKET_BYTES_EQUAL=true A8_PCR_VIX_PRESERVED=true
```

### A9 PASS — VIX 測試零 diff 且單檔全綠

命令與輸出：

```text
$ git diff --stat -- tests/taifex-vix.test.mjs
(無輸出)

$ node --test tests/taifex-vix.test.mjs
1..10
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 206.32232
```

另執行 `git diff --name-only -- data tests/taifex-vix.test.mjs scripts/backfill-vix.mjs`，輸出為空。

### A10 PASS — README 因果已修正

改後 `README.md:235-236`：

```text
- **外資期貨當月查詢終點必須是已有資料的交易日**，因此取同月 PCR raw 的最後交易日；
  PCR raw 缺失或無當月資料時明確失敗，不以月底或今天猜測。歷史月份仍用月底，預設 `toMonth` 可含當月。
```

這與 HF1 一致：`2026/09/20` 雖不是未來但仍是週日，不能作為終點；PCR raw 的末日 `20260918` 才能轉成可用的 `2026/09/18`。

## PCR 依賴缺失的選擇

選擇 **fail-fast，整次 invocation reject，且在 fetch 前停止**，而不是把該月改用月底/今天，也不是靜默略過。

理由：

- PCR raw 是當月合法 query end 的唯一票面授權來源；缺少它時沒有安全的替代值。
- 本地依賴錯誤不應進入 HTTP retry，否則只會產生無效請求並掩蓋資料前置條件。
- 對 default range 而言，當月是必要目標；直接回傳清楚錯誤比產生看似成功但仍落後的結果更安全。

測試位於 `tests/taifex-current-month.test.mjs` 的 `TICKET-233 A5 ...`，同時覆蓋 ENOENT 與零資料列，並斷言 `requests=0`。

## 受保護測試檔逐項說明

### `tests/taifex-pcr.test.mjs`

**零改動。** `git diff -- tests/taifex-pcr.test.mjs` 無輸出。當月 refresh 的新驗收放在新增測試檔，既有 PCR assertion 全部保留。

### `tests/taifex-foreign-futures.test.mjs`

沒有刪除、skip、todo 或放寬任何既有 assertion。每一處改動如下：

1. 新增 `writeCurrentPcrDependency(root, monthKey)`：default runner 現在依法包含當月，而當月 query end 又依法必須來自 PCR raw；既有隔離 runner 測試若不補本地 dependency fixture，就無法走到它原本要驗的 default-range request assertions。
2. `foreignFuturesDefaultRange` 的兩個精確期望值分別由 `2026-08`／`2026-09` 更新為 `2026-09`／`2026-10`：這是實作要求 4 的直接 contract 變更，仍是 exact equality，沒有放寬。
3. default runner 測試在每個 temp root 寫入對應當月 PCR fixture：這是新必要前置條件，只提供本地合法末交易日，沒有繞過 production path。
4. 精確 request count 由 35 更新為 36，末月由前月更新為當月：起點計算未變，新增的正是 contract 要求納入的當月；assertion 仍精確，沒有放寬。

## 票面未明說而採取的選擇

1. **缺少 PCR raw 採 fail-fast，而非 per-month summary failure。** 理由與測試見上節；這是票面明確交由 Executor 選擇的分支。
2. **末交易日取目標月份日期的最大值。** 不依賴 raw 原始排序；若 PCR raw 只有其他月份資料，視同「該月零資料列」明確失敗。
3. **當月定義使用注入時鐘的台北日期。** PCR 與外資期貨採同一規則，月界測試仍由既有 suite 覆蓋。
4. **共用 runner 以新增 callback 擴充，而非把既有 boolean 改成 union type。** 這可維持既有預設與 VIX `refreshExistingRaw: true` 完全相容，並只為 PCR/外資提供當月粒度。
5. **evidence 以 base64 內嵌測試。** 測試同時鎖 bytes 與 SHA-256，避免 CI 依賴 sibling repo 的絕對路徑。

## Scope / safety 稽核

Executor 改動檔案：

```text
README.md
scripts/backfill-foreign-futures.mjs
scripts/backfill-pcr.mjs
scripts/lib/taifex-monthly-backfill.mjs
tests/all.mjs
tests/taifex-foreign-futures.test.mjs
tests/taifex-current-month.test.mjs
REPORT-233.md
```

以上全在票面 Scope。既有未追蹤的 `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、`REPORT-194.md` 原封不動保留。

`ENDPOINTS.length=17` 與 backfill registry 鍵清單由 A1 既有測試持續保護；本票未修改 endpoint registry。

## removed_capabilities

```json
[]
```

沒有移除 capability；歷史 checkpoint、VIX 全 refresh、HTTP 非 2xx 快速失敗、內容合法性驗證、retry/backoff、write-on-change 均保留。

## Attempt 2

- Status: `READY_FOR_REVIEW`
- Base HEAD: `ce212d4`
- Scope: 只修正 Orchestrator O-001；未改用月底或今天作後備，未更動 `if (!response.ok) throw`。
- Network / data / commit: 未使用真實網路，未修改 `data/**`，未 commit。

### O-001 修正

把當月 PCR query-end 解析從 monthly runner 呼叫前，延後到 runner 執行當月份、建立 request body 時。共用 runner 現在會等待同步或非同步的 `requestBodyForMonth`；因此 PCR 缺檔、解析失敗或該月零資料列的錯誤，都由既有的逐月 `try/catch` 記入 `summary.failures`。歷史月份先照常完成，整個範圍結束後才由既有機制拋出帶完整 `summary` 的錯誤。

PCR 依賴失敗發生在實際 request 與 request 計數之前；當月不會送出請求，更不會用月底或今天猜測終點。既有 HTTP 非 2xx 快速失敗判斷未改。

### A5' PASS — 當月失敗，歷史月照跑

命令：

```text
rtk node --test tests/taifex-current-month.test.mjs
```

實跑輸出：

```text
ok 4 - TICKET-233 A5' records current-month PCR missing file as a failure after historical months
# A5_MISSING=FAILED A5_HISTORICAL_REQUESTS=3 A5_CURRENT_REQUESTS=0 A5_FALLBACK_REQUESTS=0 A5_FAILURES=[{"month":"2026-09","error":"TAIFEX foreign futures 2026-09: PCR raw is required but missing"}]
ok 5 - TICKET-233 A5' records current-month PCR parse failure as a failure after historical months
# A5_PARSE_FAILURE=FAILED A5_HISTORICAL_REQUESTS=3 A5_CURRENT_REQUESTS=0 A5_FALLBACK_REQUESTS=0 A5_FAILURES=[{"month":"2026-09","error":"TAIFEX foreign futures 2026-09: PCR raw is invalid: TAIFEX PCR: non-numeric volume ratio at 2026-09-18"}]
ok 6 - TICKET-233 A5' records current-month PCR zero rows for the month as a failure after historical months
# A5_ZERO_ROWS=FAILED A5_HISTORICAL_REQUESTS=3 A5_CURRENT_REQUESTS=0 A5_FALLBACK_REQUESTS=0 A5_FAILURES=[{"month":"2026-09","error":"TAIFEX foreign futures 2026-09: PCR raw has 0 data rows for the month"}]
1..10
# tests 10
# pass 10
# fail 0
```

三個案例都以注入 fetcher 跑 `2026-06..2026-09`，並精確斷言歷史 request 為：

```text
2026/06/01..2026/06/30
2026/07/01..2026/07/31
2026/08/01..2026/08/31
```

三個歷史 raw 均成功產生；`2026-09` 各自出現在 `summary.failures`，最後整體拋錯。`A5_CURRENT_REQUESTS=0` 與 `A5_FALLBACK_REQUESTS=0` 證明沒有任何 request 使用 `2026/09/20` 或 `2026/09/30` 作後備。

### A1' PASS — 全套測試

命令：

```text
rtk node --test tests/
```

實跑輸出（尾段）：

```text
1..156
# tests 156
# suites 0
# pass 156
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6242.451721
```

總數 156，大於 a1 的 154，且 fail = 0。

### A9' PASS — 受保護測試零 diff

命令與輸出：

```text
$ rtk git diff --stat -- tests/taifex-vix.test.mjs tests/taifex-pcr.test.mjs
(無輸出)
```

另以兩檔合跑確認：

```text
1..19
# tests 19
# pass 19
# fail 0
```

### a1 測試調整說明

只有 `tests/taifex-current-month.test.mjs` 的 a1 A5 測試因行為 contract 改變而調整：

1. a1 原測試使用只有當月的範圍，預期 runner 啟動前整次 fail-fast 且總 request 為 0；O-001 明令改為月份層級 failure，因此這個 invocation-level 預期不再正確。
2. 原本一個 A5 測試覆蓋「缺檔／零資料列」兩種形狀；本輪改成三個 A5' 測試，補上「解析失敗」，每個都跑含三個歷史月與當月的範圍，並鎖定歷史成功、當月 failure、範圍結束後非零、無日期後備。
3. a1 的 A2、A3、A4、A6、A7、A8 與 default-range 測試不需調整；`tests/taifex-foreign-futures.test.mjs`、`tests/taifex-pcr.test.mjs`、`tests/taifex-vix.test.mjs` 本輪皆未修改。

### removed_capabilities

```json
[]
```

沒有移除 capability；歷史 checkpoint、當月 refresh、PCR 交易日終點、無後備猜測、HTTP 非 2xx 快速失敗、內容驗證、retry/backoff、write-on-change 與範圍結束後的 failure summary 均保留。
