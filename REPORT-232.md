# TICKET-232 Executor Report

- Status: **READY_FOR_REVIEW**
- Branch: `ticket-232`
- Base: `fc28da6bddea3a2348a44f13669628fcbf1ea874`
- Network: 未使用真實網路；所有抓取測試皆注入 fixture fetcher。
- Commit: 未 commit，改動留在 working tree。
- Generated data: 未手動編輯 `data/**`，也未對真實 `data/` 執行 `build-derived.mjs`。

## 實作摘要

- `BACKFILL_ENDPOINTS.taifex_vix_monthly` 宣告官方 VIXTWN 月檔 URL、`cadence: 'monthly'` 與 `sourceDataset: 'taifex/vix_monthly'`；`ENDPOINTS.length` 維持 17，backfill registry 由 16 增至 17。
- 新增 `scripts/backfill-vix.mjs`：GET、無 body、台北時區動態四個月範圍、預設跨請求 delay 2000 ms、預設 retry base 2000 ms、可由既有 CLI 數值旗標調整。
- 最小參數化共用 `scripts/lib/taifex-monthly-backfill.mjs`，新增 request method、raw extension、header prefix 與 refresh-existing-raw 選項。所有舊預設仍是 POST、`.csv`、`日期,` header policy、有效 raw checkpoint。
- VIX 使用 `refreshExistingRaw: true`。原因是當月檔會增長，不能因本機已有有效檔就永遠跳過；每次仍 fetch/validate，再以 byte equality 決定是否寫入。
- parser 驗證首行 `交易日期`，regex 只收 8 位日期開頭的 tab 資料列，跳過 `--------`，濾空 cell 後要求官方四欄，取第 3 欄並升冪排序。
- derived 寫入既有 `data/derived/market.json` 的 `taifex.vix`，`cols: ["d","vix"]`；沿用 `upsertSeries`、deterministic write-on-change，並接入 `buildDerived({ rootDir })`。

## A1-A10 驗收

### A1 PASS — 全套測試增加且零失敗

執行：

```text
$ rtk node --test tests/
...
1..145
# tests 145
# suites 0
# pass 145
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6541.617689
EXIT_CODE=0
```

基線為 136 tests；現在 145，總數增加 9，且 fail = 0。

### A2 PASS — parser、分隔線、第 3 欄、排序與四月列數

執行：`rtk node --test tests/taifex-vix.test.mjs`

```text
ok 1 - TAIFEX VIX parser skips the separator, selects column 3, sorts, and matches all official fixtures
# A2_COUNTS=21/22/21/14 A2_SEPARATOR=SKIPPED A2_20260731=40.77 A2_20260601=36.54 A2_20260918=21.22 A2_SORT=ASC
```

fixture 直接讀取 repo 內四個受保護官方 raw；每檔另斷言首行是 `交易日期`、第二行是 `--------`。另以含 header + separator 的降冪構造 payload 驗證輸出升冪。`20260731` 明確得到 40.77，不是第 4 欄的 40.60。

### A3 PASS — 欄數不足與非數字明確拋錯

```text
ok 2 - TAIFEX VIX parser throws for short and non-numeric data rows
# A3_SHORT_ROW=THREW A3_NON_NUMERIC=THREW
```

### A4 PASS — HTTP 200 的 404.htm 判失敗且不寫 raw

測試內嵌的是 `evidence/202610.bin` exact bytes：402 bytes，SHA-256 `99217abd21cae0ec777bf59d2370462836ef7de18d66f5465d6f4919f4fc0fb8`。fetch response 同時帶 HTTP 200 與 404 final URL；production 判斷只依內容 header + parsed row，沒有依賴 bytes 長度或 final URL。

```text
ok 3 - HTTP 200 TAIFEX 404 payload retries, fails content validation, and writes no raw
# A4_HTTP=200 A4_BYTES=402 A4_FETCH_CALLS=3 A4_BACKOFFS=25,50 A4_RAW_EXISTS=false
```

測試另斷言 `.txt` 與 `.csv` 均不存在，且 derived apply 完全沒有被呼叫。

### A5 PASS — 台北時區動態四個月範圍

```text
ok 5 - VIX default four-month range and omitted runner range follow the Taipei clock
# A5_CLOCK_2026_09={"fromMonth":"2026-06","toMonth":"2026-09"} A5_CLOCK_2026_10={"fromMonth":"2026-07","toMonth":"2026-10"}
```

除純 range function 外，也實際省略 `fromMonth` / `toMonth` 跑 injected runner，分別觀察到 URL 月份 `202606..202609` 與 `202607..202610`；另驗證 UTC 2026-09-30 16:30 已依台北時間移到 10 月範圍。

### A6 PASS — raw 只落 `.txt`，零 `.csv`

```text
ok 6 - VIX GET writes only .txt and byte-identical rerun does not rewrite raw
# A6_FILES=2026-07.txt A6_CSV_COUNT=0 A7_SECOND_WRITE=0 A7_MTIME_UNCHANGED=true A7_BYTES_EQUAL=true
```

隔離 tmpdir 實跑後完整列出該年 VIX raw，只有 `2026-07.txt`。測試也斷言 request 是 GET 且 request object 沒有 body。

真實資料樹唯讀檢查：

```text
$ rtk rg --files data/raw/taifex/vix_monthly -g '*.csv'
<no output>
EXIT_CODE=1  # rg 的 no-match
```

### A7 PASS — raw write-on-change 冪等

使用注入的固定官方 fixture 連跑兩次；第二次仍實際 fetch（避免 checkpoint 假通過），但 byte 相同所以 `rawWritten=0`。第一次後先將 tmp raw mtime 設成固定舊值，第二次仍完全相同。

```text
ok 6 - VIX GET writes only .txt and byte-identical rerun does not rewrite raw
# A6_FILES=2026-07.txt A6_CSV_COUNT=0 A7_SECOND_WRITE=0 A7_MTIME_UNCHANGED=true A7_BYTES_EQUAL=true
```

### A8 PASS — `taifex.vix` upsert、七條舊序列保留、byte 冪等

```text
ok 7 - VIX derived upsert preserves all seven existing series and is byte-idempotent
# A8_TAIFEX_VIX_ROWS=22 A8_LAST=[20260731,40.77] A8_SECOND_WRITE=false A8_BYTES_EQUAL=true A8_EXISTING_SERIES_PRESERVED=true
```

測試 seed TWSE 2 條、TPEX 3 條、TAIFEX PCR/FUT 2 條，共七條既有序列；VIX upsert 後逐一 deep-equal，第二次 `market: false` 且 `market.json` bytes 完全相同。

### A9 PASS — 隔離 raw 完整重建

只在 `mkdtemp` root 放 `data/raw/taifex/vix_monthly/2026/2026-07.txt`，再呼叫 `buildDerived({ rootDir })`；沒有對真實 `data/` 執行 build。

```text
ok 8 - buildDerived rebuilds VIX market data from isolated .txt raw
# A9_BUILD_SUMMARY={"dailyDates":0,"taifexPcrMonths":0,"taifexForeignFuturesMonths":0,"taifexVixMonths":1,"monthlyMonths":0,"quarterlySeasons":0,"tdccWeeks":0,"macroSeries":0,"files":1} A9_TAIFEX_VIX_ROWS=22 A9_LAST=[20260731,40.77]
```

### A10 PASS — PCR／外資期貨受保護測試零 diff 且各自全綠

```text
$ rtk git diff --stat -- tests/taifex-pcr.test.mjs tests/taifex-foreign-futures.test.mjs
<stdout empty>
EXIT_CODE=0
```

```text
$ rtk node --test tests/taifex-pcr.test.mjs
1..9
# tests 9
# pass 9
# fail 0
# skipped 0
# todo 0
EXIT_CODE=0
```

```text
$ rtk node --test tests/taifex-foreign-futures.test.mjs
1..13
# tests 13
# pass 13
# fail 0
# skipped 0
# todo 0
EXIT_CODE=0
```

兩個 production wrapper `scripts/backfill-pcr.mjs` 與 `scripts/backfill-foreign-futures.mjs` 也完全未修改。

## 實作要求第 8 點：範圍內 404 頁行為

選擇：**該月完成所有 retry 後記為 failure、不寫／不覆寫 raw，繼續處理後續月份；範圍結束後帶完整 summary 拋錯，CLI 因此非零退出。**

理由：一個月暫時未產生或已超出保留期，不應阻止範圍內其他仍可取得月份落地；但也不能把缺月靜默當成功。這同時保有最大可取得資料與明確操作告警。

測試：`VIX backfill continues after an unavailable month and reports failure after later months`。

```text
ok 4 - VIX backfill continues after an unavailable month and reports failure after later months
# REQUIREMENT_8_BEHAVIOR=CONTINUE_THEN_FAIL SUMMARY={"months":2,"requests":2,"skipped":0,"rawWritten":1,"derivedWritten":0,"rows":1,"failures":[{"month":"2026-10","error":"2026-10: TAIFEX VIX: response first line is not a VIX header starting with 交易日期"}]}
```

## 變更檔案與原因

- `AGENTS.md`：只增列 VIXTWN 官方 endpoint 白名單與 `.txt` raw 路徑／有效性規則兩項。
- `scripts/endpoints.mjs`：只在既有 16 個 backfill keys 後追加 `taifex_vix_monthly`。
- `scripts/lib/taifex-monthly-backfill.mjs`：最小參數化 request method、URL function、raw extension、header prefix 與 refresh 模式；舊預設不變。
- `scripts/backfill-vix.mjs`：新增 VIXTWN CLI/wrapper、台北動態四月範圍與 rate-safe defaults。
- `scripts/lib/derived.mjs`：新增 VIX parser、`taifex.vix` market template/normalization/update-date participation 與月檔 apply。
- `scripts/build-derived.mjs`：共用月檔 listing 支援副檔名，掃描 VIX `.txt` 並完整重建。
- `tests/backfill.test.mjs`：依票面授權，只在 registry key 清單末尾與 registry assertions 追加 VIX 契約；`ENDPOINTS.length === 17` 既有斷言未改。
- `tests/all.mjs`：只追加一行 `taifex-vix.test.mjs` import；既有 import 順序未動。
- `tests/taifex-vix.test.mjs`：新增 A2-A9、CLI guard、GET/no-body、retry 與 requirement 8 行為測試。
- `REPORT-232.md`：本報告。

## removed_capabilities

```yaml
removed_capabilities: []
```

- `AGENTS.md` 是 additive allowlist change：只加入官方 TAIFEX VIXTWN 月檔與其 raw 規則，沒有移除或放寬任何既有來源限制。
- PCR／外資期貨沒有能力流失：兩個 wrapper 未改；共用 runner 對它們的 default 仍為 POST、`.csv`、既有 body、既有 header policy、有效 raw checkpoint、既有 retry/write-on-change/continue-then-fail。兩個受保護測試檔零 diff，且 9/9、13/13 全綠。
- `ENDPOINTS` 每日流程維持 17 且未接入 VIX backfill endpoint；沒有改 `scripts/run.mjs`。

## 票面未完全指定的選擇

1. **名稱**：registry key 選 `taifex_vix_monthly`、CLI 選 `scripts/backfill-vix.mjs`，與 `sourceDataset: taifex/vix_monthly` 及既有 `backfill-pcr.mjs` 命名一致。
2. **有效 raw 是否 checkpoint**：VIX 每次 refresh；PCR／外資期貨維持 checkpoint。VIX 當月仍會增長，否則重跑無法更新。
3. **預設間隔**：delay 與 retry base 均選 2000 ms，高於 1500 ms 下限，呼應 baseline 成功實測；仍可用 shared numeric flags 調整。
4. **欄數**：資料列濾除空 tab cell 後要求至少 4 欄，而不只要求能讀到第 3 欄；官方 shape 明定四欄，缺第 4 欄視為 schema truncation，避免接受破損 raw。
5. **旗標部分覆寫**：`--from` 或 `--to` 可各自單獨提供，未提供的一端採當下台北時區預設，沿用外資期貨 wrapper 的既有模式。
6. **fixture 放置**：正例直接唯讀 repo 既有四個受保護 official raw；負例把 `evidence/202610.bin` exact bytes 以 base64 內嵌並鎖 SHA-256，避免測試依賴 sibling repo 絕對路徑。
7. **provenance**：腳本完全不讀寫 `_provenance.json`；它不屬可重建 raw，且含不可得月份與非冪等時間資訊。

## 安全與完整性稽核

受保護 raw 最終 SHA-256（與開工前一致）：

```text
b7fa355126982960b0e50ec38f69cb72a501813632cd76e556fd3e4040c7cbcc  data/raw/taifex/vix_monthly/2026/2026-06.txt
44295fcc5903ef01dd6e2c40d92175161f08011891c3c078a74c72cd0393a526  data/raw/taifex/vix_monthly/2026/2026-07.txt
70a46d07f9bd1672d11b82dd27c8321e5228836d2401d3a6f3f001aaf6fed2c8  data/raw/taifex/vix_monthly/2026/2026-08.txt
f4a0910c333c22be03f3663183eccd2a7ad37fef417a9ad59e2cf5a87f07f60b  data/raw/taifex/vix_monthly/2026/2026-09.txt
d6a20391212edc8614f7529362540bfeea563f7f1608cee62de3ac6167dc1b8a  data/raw/taifex/vix_monthly/2026/_provenance.json
```

```text
$ rtk git diff --check
<stdout empty>
EXIT_CODE=0
```

開工前既有的 `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、`REPORT-194.md` 仍為未追蹤檔，未修改或刪除。

## Attempt 2

- Status: **READY_FOR_REVIEW**
- Start HEAD: `7742b224378f984aa819b1768e6c6bc6aeb47066`
- Network: 未使用真實網路；fetch 全部由測試注入。
- Commit: 未 commit，改動留在 working tree。

### O-001 — 正例 fixture 不再依賴 `data/`

`tests/taifex-vix.test.mjs` 移除 `REPO_ROOT`／`OFFICIAL_VIX_DIR` 與從 `data/raw/taifex/vix_monthly/2026` 讀檔的路徑，改為內嵌四份官方正例的 base64。每次取用 fixture 都斷言 byte length 與 SHA-256：

```text
2026-06  856 bytes  b7fa355126982960b0e50ec38f69cb72a501813632cd76e556fd3e4040c7cbcc
2026-07  890 bytes  44295fcc5903ef01dd6e2c40d92175161f08011891c3c078a74c72cd0393a526
2026-08  856 bytes  70a46d07f9bd1672d11b82dd27c8321e5228836d2401d3a6f3f001aaf6fed2c8
2026-09  618 bytes  f4a0910c333c22be03f3663183eccd2a7ad37fef417a9ad59e2cf5a87f07f60b
TOTAL    3220 bytes
```

內嵌 bytes 已逐檔與 `evidence/202606.bin`～`202609.bin` 及既有受保護 raw 比對，四檔皆 byte-equal。聚焦實跑：

```text
$ rtk node --test tests/taifex-vix.test.mjs
ok 1 - TAIFEX VIX parser skips the separator, selects column 3, sorts, and matches all official fixtures
# A2_COUNTS=21/22/21/14 A2_SEPARATOR=SKIPPED A2_20260731=40.77 A2_20260601=36.54 A2_20260918=21.22 A2_SORT=ASC
...
1..10
# tests 10
# pass 10
# fail 0
# duration_ms 213.857094
EXIT_CODE=0
```

### R-001-derived — HTTP 503 retry、月份失敗、零 raw

新增獨立測試，注入 `status: 503`、`ok: false` 的 response，設定 `maxRetries: 2`。斷言三次 fetch 均為 GET、兩次退避為 25/50 ms、最終 summary 將 `2026-10` 記為 `HTTP 503` failure、derived apply 不得執行，且整個 `data/raw` 目錄不存在。

```text
ok 4 - HTTP 503 retries, fails the month, and writes no raw
# R001_DERIVED_HTTP=503 FETCH_CALLS=3 BACKOFFS=25,50 RAW_EXISTS=false
```

保留 `scripts/lib/taifex-monthly-backfill.mjs` 的 `if (!response.ok) throw new Error(...)`，也未改 `requestBodyForMonth` 的兩條參數驗證；Attempt 2 沒有修改任何 production code。

### A11 — 無 `data/` repo 複本

執行方式：

```text
$ rtk rsync -a --exclude=data/ --exclude=.git/ ./ /tmp/wfnt-ticket-232-a11.c9uH6m/
A11_DATA_DIR_ABSENT=true
$ cd /tmp/wfnt-ticket-232-a11.c9uH6m
$ rtk node --test tests/
```

本票 VIX 測試結果：#108～#117 共 10 項全部 `ok`，含正例 parser、HTTP 200/404、HTTP 503、動態月份、`.txt`/no `.csv`、write-on-change、derived 與 rebuild；無任何 VIX 紅項。

完整失敗清單（僅以下三項）：

```text
not ok 15 - every raw historical namespace on disk is registered as a backfill endpoint
error: ENOENT: no such file or directory, scandir '<a11-copy>/data/raw/twse'

not ok 23 - TWSE weighted index parsers agree on both available overlapping raw dates
error: ENOENT: no such file or directory, open '<a11-copy>/data/raw/twse/mi_index/2026/2026-08-14.json'

not ok 24 - merged TWSE weighted index raw dates match the margin date oracle
error: ENOENT: no such file or directory, scandir '<a11-copy>/data/raw/twse/mi_index'
```

完整計數：

```text
1..146
# tests 146
# suites 0
# pass 143
# fail 3
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3846.99306
EXIT_CODE=1
```

上述三項皆是票面明列、因排除整個 `data/` 而產生的既有依賴；剩餘紅項不含 VIX 測試，A11 對本票新增 VIX 測試為 PASS。

### 完整環境 `node --test tests/`

```text
$ rtk node --test tests/
1..146
# tests 146
# suites 0
# pass 146
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6497.194013
EXIT_CODE=0
```

### removed_capabilities

```yaml
removed_capabilities: []
```

Attempt 2 只改測試 fixture 的承載方式並增加非 2xx 覆蓋；未移除或放寬任何 production 能力、驗證、endpoint、raw/derived 行為或既有斷言。
