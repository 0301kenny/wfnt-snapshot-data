READY_FOR_REVIEW

# TICKET-292 Executor Report

## 1. 設計說明

- `scripts/lib/screener-index.mjs` 匯出 `buildScreenerIndex(rootDir)` 與
  `applyScreenerIndex(rootDir)`。前者掃描 `data/derived/symbols/{p2}/*.json`，先以票面規則過濾 id，
  再讀取符合的 symbol 與同 id TDCC 檔並建立固定 26 欄摘要；後者將結果以
  `JSON.stringify(value) + '\n'` 寫入 `data/index/screener.json`。
- 掃描會跳過 `symbols/` 下的非目錄項目，以及 prefix 目錄下的非 `.json` 檔；輸出 rows 依 id
  升冪，`updated` 取所有列 date 最大值。
- 寫入前比較完整 bytes；相同內容回報 `same` 且不改 mtime，不同內容透過既有
  `writeFileEnsured` 暫存檔加 rename 原子發布。
- `scripts/run.mjs` 在所有 daily 日期與 TDCC 週的 derived 套用迴圈結束後、manifest 寫入前，
  若本次至少一次 `applyDailyDate` 或 `applyTdccWeek` 成功，呼叫一次 `applyScreenerIndex`。
  成功 log 為 `[derived] screener index: rows=<N> file=<write|same>`；失敗記錄
  `[error] derived screener index: ...` 並繼續 manifest 與 summary 流程。
- manifest 新增 `paths.screenerIndex = "data/index/screener.json"`。
- `scripts/build-screener-index.mjs` 提供獨立 CLI，支援 `--out <root>`，省略時使用目前目錄；
  未知參數與缺少 `--out` 值會失敗。
- 索引沒有接進 `applyDailyDate`、`buildDerived` 或 `backfill.mjs`，也不位於
  `data/derived/`。

## 2. 基準與 head 測試

- 開票基準 `7f1bb11`（Contract / `baseline.md`）：`200 tests / 200 pass / 0 fail`。
- r2 起始 HEAD：`7889b0254a63f88227d0e1e8d0e7eb971b194c7d`。
- 實作完成、消融前：`node --test tests/` = `213 tests / 213 pass / 0 fail`，
  duration `7831.123253 ms`。
- 五組消融全部還原後的 head 驗證：`node --test tests/` =
  `213 tests / 213 pass / 0 fail`，duration `7859.794554 ms`。
- 新增 13 條測試，涵蓋納入與 kind、兩層 `.DS_Store`、價格與 rolling windows、不足列數、
  法人換算與 streak、融資融券、TDCC 有／無／不足週、排序與 updated、緊湊 JSON 與 mtime、
  CLI、`runSnapshot` 正常呼叫與錯誤隔離。

## 3. 消融表

消融前先確認完整 suite 213/213 綠；每組只暫時改動指定行為，執行對應的新測試，確認紅燈後立即
還原。最後再跑完整 suite 213/213 綠。

| 組別 | 暫時變更 | 新測試結果 |
|---|---|---|
| ① 不跳過 `.DS_Store` | 移除 symbols 第一層非目錄 guard | 紅：`includes stocks and ETFs...`，`ENOTDIR .../symbols/.DS_Store` |
| ② `volAvg20` 改成含 L | window 由 `slice(-21, -1)` 改為 `slice(-20)` | 紅：`computes price and volume windows...`，期望 `50.5`、實得 `51.5` |
| ③ `foreignStreak` 遇 0 不停 | loop 遇 0 改為繼續計數 | 紅：`institutional streak stops at zero...`，期望 `1`、實得 `3` |
| ④ 改用縮排 JSON | 改為 `JSON.stringify(index, null, 2)` | 紅：`writes compact JSON...`，偵測到換行縮排 |
| ⑤ `run.mjs` 不呼叫索引 | 暫時令 screener 呼叫條件永遠為 false | 紅：`runSnapshot writes and logs...`，找不到 screener index log |

沒有任一消融組仍綠，未觸發 Stop 3。

## 4. 效能數字

- 環境：暫存 root；未讀寫 repo 真實 `data/`。
- 合成資料：2,400 個符合規則的 symbol 檔，每檔 300 列，共 720,000 列。
- 操作：只計時執行一次 `buildScreenerIndex(root)`，不含 fixture 建立與清除。
- 結果：輸出 2,400 列，耗時 `787.265 ms`。
- Acceptance 未設效能門檻，本數字僅記錄。

## 5. 執行聲明

- 未碰真實 `data/`；所有測試、runSnapshot 驗證與效能量測均使用暫存 root。
- 未打網路；runSnapshot 測試使用記憶體 fixture fetcher。
- 未修改任何既有 derived 輸出格式或 transformation path；既有 derived 增量／重建測試維持全綠。
- 未修改既有測試、`applyDailyDate`、`buildDerived`、`backfill.mjs`、endpoints、probe artifacts 或
  WFNT_app。
- 未讀取禁止的 `orchestrator-probe-index.mjs`。
- 未修改或刪除工作樹既有的 untracked `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、
  `REPORT-194.md`。
