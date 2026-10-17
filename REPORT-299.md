# READY_FOR_REVIEW

TICKET-299 r2 已依核准 Contract 實作。14 個官方只給當期的端點已加入每日排程；9 個日更端點使用市場錨點日，5 個月更端點使用執行當下台北年月，全部只保存官方 response bytes，不觸發 derived／screener，也不影響 `latestTradingDate`。

未觸發任何 Stop / Escalate 條款。全程未連網、未執行 `launchctl`、未寫入真實 `data/`，也未在主目錄 `/Users/zhengweizhu/Projects/wfnt-snapshot-data` 修改檔案或操作分支。所有 runner 演練皆使用測試暫存 root 與注入的假 fetch。

## Required Evidence 1：實作位置

### 新端點宣告

- `scripts/endpoints.mjs:141-279`：14 個端點的固定 `key`、`sourceDataset`、URL 與 `requiredFields`。
- 九個日更端點宣告 `rawOnly: true` 與 `useAnchorDate: true`；五個月更端點宣告 `rawOnly: true`、`cadence: 'monthly'` 與 `useCurrentTaipeiMonth: true`。
- `scripts/run.mjs:132-153`：既有動態 manifest 正規化會把新增日更與月更 key 分別建立為 daily／monthly entry；沒有把任何新 key 加入 `scripts/lib/manifest.mjs:14` 的 `TRADING_DATE_DATASET_KEYS`。

### 空陣列放行

- `scripts/endpoints.mjs:147,157,167,177,187,197,207,217`：只有 Contract 指定的八支端點宣告 `allowEmpty: true`。
- `scripts/endpoints.mjs:431-435`：`validateRows` 只對這些端點接受 `[]` 並直接成功；非空陣列仍走首列 object、required fields 與日期驗證，未標記端點仍維持原錯誤 `schema: JSON 不是非空陣列`。

### 月鍵

- `scripts/run.mjs:427`：以注入的 `now()` 經 `taipeiIsoDate` 固定本次執行的台北年月。
- `scripts/run.mjs:511-519`：有 `useCurrentTaipeiMonth` 的五支新端點使用該年月；既有月更端點仍從全列 `資料年月` 最大值取月鍵。
- `scripts/run.mjs:267-280`：沿用既有 write-on-change 月檔寫入，同內容為 `same`、不同內容為 `revise`。

### derived 排除

- `scripts/run.mjs:135`：由端點 metadata 建立 `RAW_ONLY_KEYS`。
- `scripts/run.mjs:609-620`：日更與月更 derived 變更集合都排除 `RAW_ONLY_KEYS`。
- `scripts/run.mjs:424-425,649,658`：daily／monthly derived 函式可注入；新測試以 spy 證明只有新資料集變更時兩者呼叫數皆為 0，且 `data/derived/**` bytes 不變。
- `scripts/lib/manifest.mjs:14,89-91` 保持原樣；`latestTradingDate` 仍只由既有白名單計算。

## Required Evidence 2：完整測試

在 worktree 根目錄執行 `node --test tests/`（`data` symlink 僅由既有三項 oracle 測試唯讀）：

```text
1..247
# tests 247
# suites 0
# pass 247
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10308.456754
```

新增的 `tests/current-only-snapshots.test.mjs` 共 8 項，涵蓋 Contract Acceptance 所列八組情境；完整總數由基線 239 增至 247。

## Required Evidence 3：三組消融

每組都以 `apply_patch` 暫時移除單一行為、執行指定測試取得紅燈，再以 `apply_patch` 還原並確認綠燈。以下為紅燈關鍵原文與還原後摘要。

### A. 拿掉 derived 排除

暫時移除 `changedDailyDatesForDerived` 與 `changedMonthsForDerived` 的 `!RAW_ONLY_KEYS.has(result.key)`，執行：

```text
$ node --test --test-name-pattern='leave derived bytes unchanged' tests/current-only-snapshots.test.mjs
# Subtest: current-only writes leave derived bytes unchanged and call no daily or monthly derived transform
not ok 1 - current-only writes leave derived bytes unchanged and call no daily or monthly derived transform
  error: |-
    Expected values to be strictly equal:

    1 !== 0
  expected: 0
  actual: 1
1..1
# tests 1
# pass 0
# fail 1
```

還原後：

```text
1..1
# tests 1
# pass 1
# fail 0
```

### B. 拿掉空陣列放行

暫時把 `validateRows` 還原成所有空陣列皆拒絕，執行：

```text
$ node --test --test-name-pattern='eight approved daily endpoints accept' tests/current-only-snapshots.test.mjs
# [fail] twse_material_info: schema: JSON 不是非空陣列
# Subtest: only the eight approved daily endpoints accept an empty JSON array
not ok 1 - only the eight approved daily endpoints accept an empty JSON array
  error: |-
    twse_material_info

    false !== true
  expected: true
  actual: false
1..1
# tests 1
# pass 0
# fail 1
```

還原後：

```text
1..1
# tests 1
# pass 1
# fail 0
```

### C. 月鍵改讀 `出表日期`

暫時把 current-only 月鍵改為 `parseRocMonth(String(row['出表日期']).slice(0, 5))`，執行：

```text
$ node --test --test-name-pattern='tpex dividend ignores old' tests/current-only-snapshots.test.mjs
# [write] tpex_dividend: 2021-08
# Subtest: tpex dividend ignores old 出表日期 and uses the injected clock's Taipei month
not ok 1 - tpex dividend ignores old 出表日期 and uses the injected clock's Taipei month
  error: "ENOENT: no such file or directory, open '.../data/raw/tpex/dividend/2026/2026-11.json'"
1..1
# tests 1
# pass 0
# fail 1
```

還原後：

```text
# [write] tpex_dividend: 2026-11
1..1
# tests 1
# pass 1
# fail 0
```

三組消融還原後再完成 Required Evidence 2 的全套 247／247 綠燈；工作樹中沒有殘留消融變更。

## Required Evidence 4：暫存 root／假 fetch 演練

入口：`runSnapshot`；root 由 `mkdtemp` 建立；fetcher 完全注入、無網路；注入時鐘為 `2026-10-31T16:30:00Z`（台北 `2026-11-01 00:30`）；兩市場 anchor 皆為 `2026-10-30`。

執行指令：

```text
node --test --test-name-pattern='all 14 current-only endpoints preserve' tests/current-only-snapshots.test.mjs
```

`runSnapshot` stdout 原文：

```text
[write] twse_material_info: 2026-10-30
[write] tpex_material_info: 2026-10-30
[write] twse_exright_forecast: 2026-10-30
[write] tpex_exright_forecast: 2026-10-30
[write] twse_trading_halt: 2026-10-30
[write] twse_margin_suspension: 2026-10-30
[write] tpex_trading_halt: 2026-10-30
[write] tpex_short_suspension: 2026-10-30
[write] twse_sbl_available: 2026-10-30
[write] twse_holiday_schedule: 2026-11
[write] twse_agm_notice: 2026-11
[write] twse_agm_dates: 2026-11
[write] twse_dividend: 2026-11
[write] tpex_dividend: 2026-11
```

產出檔案清單（相對於暫存 root 的 `data/`）：

```text
manifest.json
raw/tpex/dividend/2026/2026-11.json
raw/tpex/exright_forecast/2026/2026-10-30.json
raw/tpex/material_info/2026/2026-10-30.json
raw/tpex/short_suspension/2026/2026-10-30.json
raw/tpex/trading_halt/2026/2026-10-30.json
raw/twse/agm_dates/2026/2026-11.json
raw/twse/agm_notice/2026/2026-11.json
raw/twse/dividend/2026/2026-11.json
raw/twse/exright_forecast/2026/2026-10-30.json
raw/twse/holiday_schedule/2026/2026-11.json
raw/twse/margin_suspension/2026/2026-10-30.json
raw/twse/material_info/2026/2026-10-30.json
raw/twse/sbl_available/2026/2026-10-30.json
raw/twse/trading_halt/2026/2026-10-30.json
```

測試逐一以 `Buffer` 比對 14 份 raw 與假官方回應，皆逐 byte 相等；anchor response 只用於決定日期，不會額外落地。
