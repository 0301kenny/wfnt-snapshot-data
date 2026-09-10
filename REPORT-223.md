# TICKET-223 Executor Report

**狀態：READY_FOR_REVIEW**

TICKET-223 實作與 attempt a2 修正均已完成。完整測試在真實 `ticket-223` repo 工作樹全綠；變更保留在 working tree，沒有 commit。全程未使用真實網路、未執行 repo root 的 `build-derived`、未修改真實 `data/`，歷史 `REPORT-070/189/192/194.md` 均未碰觸。

## attempt a2 修正內容

1. `tests/cli-flags.test.mjs`：依 2026-09-10 Scope 擴張授權，只替既有 `twse/sbl_hist` fixture 補上 HF5 的真實 `groups`：`股票:2`、`融券:6`、`借券賣出:6`、空白尾欄 `:1`。沒有放寬 production parser，也沒有修改該檔其他斷言、fixture 或測試邏輯；原 `not ok 9` 最終為 `ok 9`。
2. `tests/run.test.mjs`：兩個法人四欄斷言由 `slice(9)` 精確化為 `slice(9, 13)`。期望陣列仍分別是 `[5677787, 111, 222, 333]` 與 `[777, 88, null, 99]`，內容與長度均未改，只排除新增在尾端的 SBL 兩欄，且日後再追加欄位也不會使法人斷言失效；原 `not ok 94` 最終為 `ok 94`。

## Required Evidence 1 — 完整測試尾段

基線在真實 repo 複驗為 `102 tests / 102 pass / 0 fail`。a1 新增 2 條測試，最終在真實 repo 工作樹執行 `node --test tests/`，共 104 條且全綠：

```text
1..104
# tests 104
# suites 0
# pass 104
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3373.892265
```

兩條新增測試：

1. `SBL derived parsers isolate borrowing blocks and reject TPEX fields drift`
2. `SBL values project into trailing symbol derived columns for both markets`

## Required Evidence 2 — 驗收 3 消融對照

attempt a2 暫時將 `applyDailyDate` 兩市場寫入的 `sb`／`ss` 改為固定 `null`，執行指定 projection test 後得到 exit code 1 與以下實際失敗；隨即以反向 patch 還原 production 投影邏輯：

```text
not ok 1 - SBL values project into trailing symbol derived columns for both markets
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    ...
    +     null,
    +     null
    -     7654,
    -     1234
# tests 1
# pass 0
# fail 1
```

還原後正向 projection test 與完整 suite 均通過，實際 diagnostic 為：

```text
ok 25 - SBL values project into trailing symbol derived columns for both markets
# SBL_SYMBOL_ROWS=twse:20260706/sb=7654/ss=1234,tpex:20260706/sb=3210/ss=987
```

該測試對兩市場完整 15 欄 `cols` 與完整 `rows` 做 `assert.deepEqual`，不是子集或長度斷言；消融確實使具體日期、symbol 與數值斷言轉紅。

## Required Evidence 3 — 驗收 4 三組負向對照

attempt a2 重跑 targeted fixture test 已全綠，實際 diagnostics：

```text
ok 1 - SBL derived parsers isolate borrowing blocks and reject TPEX fields drift
# TWSE_SBL_GROUP_SELECTION=margin_當日餘額:106,sbl_當日餘額:7654,result:7654; GROUP_DRIFT=THREW
# TPEX_SBL_FIELDS_DRIFT=fields[9]:欄位漂移,RESULT=THREW
# CROSS_MARKET_SBL_BALANCE_SELECTION=twse_margin:106,twse_sbl:7654,tpex_margin:8765,tpex_sbl:3210
```

- TWSE：fixture 讓融券區與借券賣出區同名 `當日餘額` 分別為 106／7,654，解析結果為借券區 7,654；另將 group span 從 6/6 竄改為 5/7，實際拋錯。
- TPEX：完整 15 欄序列通過後才使用固定 index 9／12；將 `fields[9]` 改成 `欄位漂移` 時，實際拋出 `TPEX_SBL: fields[9] must be 當日賣出`。
- 共同：TWSE 106 vs 7,654、TPEX 8,765 vs 3,210，兩市場結果皆取借券賣出區，沒有誤取融券區。

## Required Evidence 4 — legacy test 42／45 語意改寫

- 原 test 42 改名為 `applyDailyDate runs for zero raw writes, derived-input writes, and SBL-only writes`；SBL-only 的 `applyCalls` 精確預期由 0 改為 1。實際 diagnostic：`SBL_ONLY_WRITE_APPLY_CALLS=1`。
- 原 test 45 改名為 `SBL-only writes invoke applyDailyDate and remain byte-identical to the base unconditional call`；`optimizedApplyCalls` 精確預期由 0 改為 1，並保留與 base unconditional call 的完整 derived tree bytes 比對。實際 diagnostic：`RAW_WRITTEN=2 OPTIMIZED_APPLY_CALLS=1`。

這是 TICKET-223 明文推翻 TICKET-207 Acceptance 第 4 項「只有 SBL 寫入時呼叫次數為 0」的邊界；新語意是 SBL 已成為 derived input，因此 SBL-only 寫入必須觸發 `applyDailyDate`。

## Required Evidence 5 — 呼叫次數與四年效能量級

fixture 實測 SBL-only write 的 `applyDailyDate` 呼叫次數由舊語意 **0 次／日**變為 **1 次／日**：

```text
# ZERO_RAW_WRITES_APPLY_CALLS=1
# DERIVED_INPUT_WRITE_APPLY_CALLS=1
# SBL_ONLY_WRITE_APPLY_CALLS=1
```

依 Contract／BACKLOG 記載的 17.5 秒／日與約 1,003 天估算：

```text
1,003 calls × 17.5 seconds = 17,552.5 seconds
                           ≈ 292.5 minutes
                           ≈ 4.88 hours
```

這是產生 SBL derived 的必要代價，不列為迴歸，也未用其他實作閃避。

## Required Evidence 6 — HF4／HF9 六條狀態

最終完整 suite 中，六條預期轉紅項目均已轉綠：

1. HF4 `backfill.test.mjs` TWSE exact cols／rows（原 :558）：**PASS**，測試名稱同步改為 `fifteen-column`。
2. HF4 `backfill.test.mjs` TPEX exact cols／rows（原 :588）：**PASS**。
3. HF4 `run.test.mjs` derived daily files exact object（原 :480/:489，同一測試）：**PASS**。
4. HF9 legacy test 42，SBL-only 必須呼叫：**PASS**，`SBL_ONLY_WRITE_APPLY_CALLS=1`。
5. HF9 legacy test 45，SBL-only automatic call 與 unconditional base bytes 相同：**PASS**，`OPTIMIZED_APPLY_CALLS=1`。
6. HF9 legacy test 46，registry 與函式 body raw reads 完全相等：**PASS**，`DERIVED_INPUT_DATASETS_MATCH=true COUNT=18`；只把硬編計數 16 改成 18，集合相等斷言與 `drifted` 負向對照未修改。

完整 suite 最終為 `104 pass / 0 fail`。

## Required Evidence 7 — 新增 cols

`SYMBOL_COLS` 由 13 欄擴為 15 欄，僅在尾端追加：

```text
['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd', 'sb', 'ss']
```

- `sb`（index 13，第 14 欄）：借券賣出當日餘額，單位股。
- `ss`（index 14，第 15 欄）：當日借券賣出，單位股。

不含任何可用限額欄位。缺少對應 raw 時寫 `null`。

## Required Evidence 8 — HF11 字面 raw reads

兩行皆位於 `applyDailyDate` 函式本體內，目前為 `scripts/lib/derived.mjs:1046-1047`：

```js
readJsonRaw(rootDir, 'twse/sbl_hist', isoDate),
readJsonRaw(rootDir, 'tpex/sbl_hist', isoDate),
```

靜態守衛實測抓到 18 個唯一 namespace，registry exact-match 與既有 `drifted` 負向對照皆通過。

## Required Evidence 9 — 報告位置

本報告位於執行 repo 根目錄：

```text
/Users/zhengweizhu/Projects/wfnt-snapshot-data/REPORT-223.md
```
