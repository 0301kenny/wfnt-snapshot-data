# TICKET-228 Executor Report

- Status: `READY_FOR_REVIEW`
- Attempt: `2`
- Branch: `ticket-228`
- Base: `d2a0f66`
- Network: 未使用真實網路；全部 FRED 驗收均使用注入 fixture fetcher。
- Data safety: 未手動修改任何 `data/**`；未對真實 repo 執行 `node scripts/build-derived.mjs`。A8 只在 `mkdtemp` 隔離目錄呼叫 `buildDerived({ rootDir })`。
- Commit: 未 commit，改動留在 working tree。

## 驗收 A1-A13

### A1 PASS — 既有測試不得退步

實跑：

```text
$ node --test tests/
1..114
# tests 114
# suites 0
# pass 114
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6167.078892
```

結果符合 `pass > 109`、`fail = 0`。既有 `ENDPOINTS.length === 17` 與 `BACKFILL_ENDPOINTS` 14 鍵斷言均維持原值；另加 `SERIES_ENDPOINTS` 的鍵與 URL 精確斷言。四個 FRED 測試與一個 barrel 漂移守衛均已進入實際 gate。

### A2 PASS — parser 正確排除空字串與 `.`

實跑：

```text
ok 1 - FRED parser skips empty and dot values and resolves the series column by header
# A2_A3_ROWS=[[20251224,0.68],[20251226,0.68]] EMPTY_PRESENT=false DOT_PRESENT=false
```

fixture 的 `2025-12-25,` 與 `2025-12-29,.` 均未出現在 rows；前後有效值皆為 `0.68`。同一測試另確認非缺值的非數字內容會明確拋出 `non-numeric value`。

### A3 PASS — parser 不依賴欄位位置

實跑 fixture header 為 `observation_date,IGNORED,T10Y2Y`；輸出仍為：

```text
# A2_A3_ROWS=[[20251224,0.68],[20251226,0.68]] EMPTY_PRESENT=false DOT_PRESENT=false
```

若寫死 `cells[1]`，值會是 `999`；實跑結果為正確的 `0.68`。

### A4 PASS — derived 列數等於 raw 合格列數

預期值由測試內獨立依 raw header、缺值規則及 `d >= 20210101` 自適應計算，未寫死實際全歷史列數。

```text
# A4_COUNTS={"DTWEXBGS":{"rawEligible":2,"derived":2},"DEXTAUS":{"rawEligible":2,"derived":2},"T10Y2Y":{"rawEligible":2,"derived":2},"VIXCLS":{"rawEligible":2,"derived":2}}
```

### A5 PASS — CBOE 標註

```text
# A5_VIX_ATTRIBUTION=CBOE
```

`macro.json.series.VIXCLS.attribution` 字面等於 `CBOE`。

### A6 PASS — 日期下限生效

```text
# A6_BELOW_FLOOR_PRESENT=false AT_FLOOR_PRESENT=true
```

fixture 的 `2020-12-31` 被排除；`2021-01-04` 保留。

### A7 PASS — 冪等

```text
# A7_SECOND_WRITTEN=false BYTE_IDENTICAL=true
# RAW_RERUN_STATUS=same RAW_BYTE_IDENTICAL=true MANIFEST_BYTE_IDENTICAL=true
```

同一 raw fixture 第二次衍生時 `written=false`，`macro.json` byte 零差異；相同官方 response 再跑 snapshot 時 raw status 為 `same`，raw 與 manifest 皆 byte-identical。

### A8 PASS — 從 raw 完整重建

隔離 tmpdir 只放 `data/raw/fred/*.csv`，呼叫 `buildDerived({ rootDir })`：

```text
# A8_REBUILD={"dailyDates":0,"monthlyMonths":0,"quarterlySeasons":0,"tdccWeeks":0,"macroSeries":4,"files":1} BYTE_IDENTICAL=true
```

重建產生唯一 derived 檔 `macro.json`，四序列內容與增量產出 byte-identical，A4 計數維持一致。

### A9 PASS — 單一序列失敗不影響其他三條

注入 `fred_t10y2y` HTTP 500：

```text
# A9_RESULT=[{"key":"fred_dtwexbgs","ok":true,"status":"write"},{"key":"fred_dextaus","ok":true,"status":"write"},{"key":"fred_t10y2y","ok":false,"error":"HTTP 500"},{"key":"fred_vixcls","ok":true,"status":"write"}]
# A9_RAW={"fred_dtwexbgs":"byte-equal","fred_dextaus":"byte-equal","fred_t10y2y":"missing","fred_vixcls":"byte-equal"} MANIFEST_OK={"fred_dtwexbgs":true,"fred_dextaus":true,"fred_t10y2y":false,"fred_vixcls":true}
```

三條成功 raw 與 fixture bytes 完全相同；失敗序列未落 raw 且 manifest 記錄 `HTTP 500`。

### A10 PASS — manifest 不污染 `latestTradingDate`

台股最新日設為 `2026-01-01`，FRED 末筆設為較晚的 `2026-01-02`：

```text
# A10_TAIWAN_LATEST=2026-01-01 FRED_LAST=2026-01-02 HAS_LATEST_FIELD=false
```

FRED manifest 使用 `lastObservation`，不含 `latest`，因此 `latestTradingDate` 未前進。

新增 FRED 測試整體實跑摘要：

```text
1..4
# tests 4
# pass 4
# fail 0
# skipped 0
# todo 0
# duration_ms 143.220446
```

### A11 PASS — gate 涵蓋新測試

`tests/all.mjs` 在既有九行之後 import `./fred.test.mjs`；實際 gate 顯示 FRED 測試為第 110～113 項，漂移守衛為第 114 項：

```text
# Subtest: FRED parser skips empty and dot values and resolves the series column by header
ok 110 - FRED parser skips empty and dot values and resolves the series column by header
# Subtest: macro derivation enforces the date floor, attribution, adaptive counts, and idempotence
ok 111 - macro derivation enforces the date floor, attribution, adaptive counts, and idempotence
# Subtest: snapshot isolates one failed FRED series and preserves successful official bytes
ok 112 - snapshot isolates one failed FRED series and preserves successful official bytes
# Subtest: FRED observations later than Taiwan data do not advance latestTradingDate
ok 113 - FRED observations later than Taiwan data do not advance latestTradingDate
# Subtest: every test module is imported by the test barrel
ok 114 - every test module is imported by the test barrel
1..114
# tests 114
# pass 114
# fail 0
```

實際總數 `114 > 109`；測試本身未寫死 114。

### A12 PASS — 漂移守衛負向對照

暫時移除 `tests/all.mjs` 的 `import './fred.test.mjs';` 後實跑 `node --test tests/`：

```text
# Subtest: every test module is imported by the test barrel
not ok 110 - every test module is imported by the test barrel
  error: |-
    test modules missing from tests/all.mjs: fred.test.mjs
    + actual - expected

    + [
    +   'fred.test.mjs'
    + ]
    - []
1..110
# tests 110
# pass 109
# fail 1
# skipped 0
# todo 0
# duration_ms 6150.166539
```

命令 exit code 為 `1`，缺漏檔名明確出現在 assertion message。負向對照後已把 import 加回。

### A13 PASS — 恢復後重跑 A1

```text
# Subtest: FRED observations later than Taiwan data do not advance latestTradingDate
ok 113 - FRED observations later than Taiwan data do not advance latestTradingDate
# Subtest: every test module is imported by the test barrel
ok 114 - every test module is imported by the test barrel
1..114
# tests 114
# suites 0
# pass 114
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6167.078892
```

## 修改檔案

- `AGENTS.md`：只修改 HF9 指定的兩條規則，將白名單精確增列四條 FRED series endpoint，並禁止 registry 外的 FRED 序列。
- `scripts/endpoints.mjs`：新增獨立 `SERIES_ENDPOINTS` 與 lookup；未改 `ENDPOINTS`/`BACKFILL_ENDPOINTS` 內容。
- `scripts/lib/derived.mjs`：新增 header-driven FRED CSV parser、`20210101` 日期下限及共用 `applyMacroSeries()`，沿用 `stableDerivedString` 與 write-on-change。
- `scripts/run.mjs`：擴充 dataset 選擇、獨立執行四條 FRED、覆寫式 raw write、逐序列錯誤隔離、manifest 更新與增量 macro 建置。
- `scripts/build-derived.mjs`：將 `applyMacroSeries()` 接入全量重建，回報 `macroSeries`。
- `scripts/lib/manifest.mjs`：新增 series entry schema、success setter，以及 raw/macro path contract；`refreshLatestTradingDate()` 的既有 `latest` 邏輯未改。
- `tests/backfill.test.mjs`：依授權新增 `SERIES_ENDPOINTS` 鍵清單與 URL 精確斷言；既有 17/14 斷言原樣保留。
- `tests/run.test.mjs`：只在既有 manifest 鍵清單尾端追加四個 FRED key。
- `tests/fred.test.mjs`：新增 A2-A10 的無網路 fixture 驗收，以及非數字顯式錯誤與 raw byte-preservation 檢查。
- `tests/all.mjs`：在既有九個 barrel 成員之後加入 `fred.test.mjs`，並新增以磁碟實況和 import 集合差集比對的漂移守衛。
- `REPORT-228.md`：本交付報告。

## removed_capabilities 申報

```yaml
removed_capabilities:
  - capability: none
    evidence:
      comparison: "逐檔檢查 git diff d2a0f66 -- AGENTS.md scripts/endpoints.mjs scripts/lib/derived.mjs scripts/run.mjs scripts/build-derived.mjs scripts/lib/manifest.mjs tests/all.mjs tests/backfill.test.mjs tests/run.test.mjs，並直接檢查新增 tests/fred.test.mjs"
      conclusion: "沒有移除既有行為、欄位、輸出或測試斷言；ENDPOINTS 仍為 17、BACKFILL_ENDPOINTS 鍵與順序不變、manifest 原 17 鍵內容與順序不變且只在尾端增列四鍵。舊 endpoint 的 retry 仍為 3 次；build-derived CLI 的原摘要欄位全數保留，只追加 macro_series。node --test tests/ 為 114 pass / 0 fail。"
    hunk: null
    successor: null
  allowlist_changes:
    - rule: "AGENTS.md endpoint allowlist"
      before: "僅允許原 daily/monthly/weekly/MOPS/legacy endpoints"
      after: "額外且僅允許 SERIES_ENDPOINTS 內四條 FRED full-history endpoints"
      evidence: "AGENTS.md 第一條規則 hunk"
    - rule: "AGENTS.md no-other-URLs rule"
      before: "Do not add other URLs or undocumented data sources."
      after: "仍禁止其他 URL/未文件化來源，並明文禁止 SERIES_ENDPOINTS 外的 FRED series。"
      evidence: "AGENTS.md 第四條規則 hunk"
```

### Attempt 2 removed_capabilities

```yaml
removed_capabilities_attempt_2:
  - capability: none
    evidence:
      comparison: "比較 attempt 2 前後 tests/all.mjs；既有九個 import 的內容與相對順序逐行相同，只在其後追加 fred.test.mjs 與集合差集守衛。tests/package.json 未修改。"
      negative_control: "暫移 fred import 時守衛以 fred.test.mjs 明確轉紅；恢復後 114 pass / 0 fail。"
      conclusion: "本輪未移除任何測試入口、測試行為、欄位、輸出或既有 assertion。"
    hunk: null
    successor: null
```

比對亦確認沒有新增 `skip`/`todo`、沒有刪除或放寬既有 assertion，且 `git diff --check` 無錯誤。

## 票面未明說時的實作選擇

1. Registry key 採 `fred_dtwexbgs`、`fred_dextaus`、`fred_t10y2y`、`fred_vixcls`；series ID 保留官方大寫字面，raw 檔名使用官方 ID。
2. `macro.json` 採 `{ "series": { SERIES_ID: { attribution, cols, rows } } }`，共同欄位為 `cols: ["d", "v"]`；日期存 `YYYYMMDD` 整數，與既有 derived 緊湊 row 風格一致。
3. 非 VIX attribution 分別使用 `Federal Reserve` 與 `Federal Reserve Bank of St. Louis`；VIX 嚴格使用票面要求的 `CBOE`。
4. Manifest series 欄位採 `firstObservation`、`lastObservation`、`observations`、`ok`，避免任何 `latest` 欄位；另增 `paths.rawFred` 與 `paths.macro`。
5. FRED response 若沒有任何有效 observation，視為明確 schema failure，不覆寫既有 raw；缺某個 raw 時 `applyMacroSeries()` 只輸出目前存在的 series，讓 A9 的其餘三條仍可用。
6. FRED 每條請求採一次 attempt；四條彼此獨立，避免一條不可用拖住其餘序列。原 17 endpoint 仍沿用既有三次 retry，未改其能力。
7. FRED 的 `--force` 仍會強制發 request，但相同 response bytes 不重寫 raw；這依票面「內容相同則不寫」優先於既有 JSON raw 的 forced rewrite 表現。

## Scope 與工作樹核對

- 所有本票改動均位於 Scope 允許清單。
- Attempt 2 額外修改的 `tests/all.mjs` 由 r2 明確授權；既有九個 import 順序未改。
- `tests/package.json` 未修改，repo 內未發現第二份測試登記表。
- 未修改 `scripts/probe.mjs`、`.github/workflows/probe.yml` 或任何 WFNT_app 檔案。
- 未修改 `data/**`。
- 工作樹原有未追蹤 `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、`REPORT-194.md` 均未觸碰。
