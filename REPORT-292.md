BLOCKED — Contract Stop 1 / Stop 2

# TICKET-292 Executor Report

## Blocker

現況無法在既定 Scope 內同時滿足 Contract 與既有測試：

- `tests/run.test.mjs` 的既有測試 `build-derived rebuild matches incremental output and repeated rebuild is byte-level stable` 會在 `runSnapshot` 後保存整個 `data/derived` 檔案集合，刪除 `data/derived`，執行 `buildDerived`，再斷言重建後的完整檔案集合與增量結果完全相等。
- Contract 要求 `runSnapshot` 在任一 daily derived 或 TDCC 週成功套用後產生 `data/derived/screener_index.json`。
- 同一 Contract 又明令索引不得接進 `buildDerived`，且 Out of Scope 明令不得修改既有測試。

因此實作後，既有測試的 incremental 集合必有 `screener_index.json`，但 rebuilt 集合依 Contract 不得有該檔，完整集合斷言必然失敗。可行修正至少需要修改既有測試，或讓 `buildDerived` 產生索引；兩者都觸發 Stop 2。這也使 Acceptance 1 在 Scope 內無解，觸發 Stop 1。Executor 已立即停止，未自行修改票面或擴張 Scope。

## 1. 設計說明

未進入實作。原 Contract 指定的介面為 `scripts/lib/screener-index.mjs` 匯出 `buildScreenerIndex` 與 `applyScreenerIndex(rootDir)`，並在 `scripts/run.mjs` 的 derived 收尾段，於本次有 daily 日期或 TDCC 週成功套用時呼叫。由於上述既有 full-tree rebuild 斷言與禁止接入 `buildDerived` 的規則衝突，沒有建立模組或修改呼叫點。

## 2. 基準與 head 測試

- 基準 HEAD：`7f1bb11d9332aa3ad1730860a912073a5213d79c`
- 分支：`ticket-292`
- 修改前執行 `node --test tests/`：200 tests / 200 pass / 0 fail，exit 0，duration 7613.165448 ms。
- Head：只新增本報告，未修改程式或測試；因觸發 Stop 後不得繼續實作，head 的程式與基準相同，未重複執行測試。

## 3. 消融表

未執行。Stop 1 / Stop 2 在實作前已觸發；沒有建立新測試或程式，因此無可合法消融的實作。依「立刻停手」要求，未以修改既有測試或 `buildDerived` 的方式繞過 blocker。

| 組別 | 結果 |
|---|---|
| 基準綠 | 未執行新測試；repo 基準 200/200 綠 |
| 不跳過 `.DS_Store` | 未執行，已觸發 Stop |
| `volAvg20` 改成含 L | 未執行，已觸發 Stop |
| `foreignStreak` 遇 0 不停 | 未執行，已觸發 Stop |
| 改用縮排 JSON | 未執行，已觸發 Stop |
| `run.mjs` 不呼叫 `applyScreenerIndex` | 未執行，已觸發 Stop |
| 還原後綠 | 未執行，已觸發 Stop |

## 4. 效能數字

未量測。由於在實作前觸發 Stop，沒有 `buildScreenerIndex` 可在暫存 root 上合法執行；未建立替代實作或擴張 Scope。

## 5. 執行聲明

- 未碰真實 `data/`。
- 未打網路。
- 未修改任何既有 derived 輸出或 transformation path。
- 未修改既有測試、`applyDailyDate`、`buildDerived` 或 `backfill.mjs`。
- 未讀取禁止的 `orchestrator-probe-index.mjs`。
- 未修改 WFNT_app。

