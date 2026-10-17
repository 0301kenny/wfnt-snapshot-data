# BLOCKED

觸發 Stop / Escalate **2**（同時使 Stop 1 成立）：若要讓 Contract 的完整驗收變綠，必須修改 Scope 外的既有測試 `tests/backfill.test.mjs`；依票面要求已立即停止，未實作、未放寬斷言、未擴張 Scope。

## Blocker

- Contract 要求 14 個新端點宣告在 `scripts/endpoints.mjs` 的 `ENDPOINTS`；基線共有 17 筆，因此實作後必為 31 筆。
- `tests/backfill.test.mjs:320-322` 是既有測試，硬斷言 `ENDPOINTS.length === 17`。
- Scope 的測試檔只允許 `tests/run.test.mjs`、新檔 `tests/current-only-snapshots.test.mjs` 與 `tests/all.mjs`；`tests/backfill.test.mjs` 不在 Scope 內。
- Contract 另明定 `tests/run.test.mjs` 只准新增 test，Stop 2 明定不得靠修改既有 test 或 Out of Scope 檔案變綠。

因此有且只有下列兩種直接結果，兩者都不符合 Contract：

1. 合法新增 14 筆 `ENDPOINTS`：既有 `tests/backfill.test.mjs` 必定失敗（預期 17、實際 31）。
2. 修改該斷言為 31：修改 Scope 外既有 test，直接觸發 Stop 2。

未採用偽造 `ENDPOINTS.length`、另建旁路 registry 或跳過測試等規避方式，因為這些做法會違反端點宣告 Hard Fact、完整驗收或 Contract 的唯一權威地位。

## Required Evidence 狀態

### 1. 程式位置

未產生實作位置：Stop 2 在動手前已觸發。衝突位置如下：

- 新端點指定宣告位置：`scripts/endpoints.mjs` 的 `ENDPOINTS`。
- 阻擋斷言：`tests/backfill.test.mjs:320-322`。

空陣列放行、月鍵與 derived 排除均未實作，避免在已觸發 Stop 後繼續改動。

### 2. 完整測試摘要

變更前於 worktree 執行：

```text
1..239
# tests 239
# suites 0
# pass 239
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10219.04881
```

未在真實 `data/` 執行任何 runner、backfill 或 derived 腳本；測試只依既有測試設計讀取 symlink 中的 fixture/oracle 資料。

### 3. 三組消融

未執行。消融以完成 Scope 內實作為前提；Stop 2 要求立即停止，不能先實作再製造消融證據。

### 4. 暫存 root 假 fetch 演練

未執行。新端點 runner 未實作，且 Stop 2 要求立即停止。

## 請 Orchestrator 裁決

需修訂 Contract，至少採取其中一項後才能重新執行：

- 將 `tests/backfill.test.mjs` 納入 Scope，並明確授權把既有 17-entry 斷言更新為 31；或
- 由票面指定另一個不違反 Hard Facts 的端點 registry 與相應測試契約。

本次未連網、未寫入真實 `data/`、未操作主目錄、未執行 `launchctl`，也未修改任何實作或既有測試檔案。
