READY_FOR_REVIEW

# TICKET-274 Executor Report

## r2 change

r2 將原先衝突的 Hard Fact 5 更正，並明確允許修改 `tests/run.test.mjs` 中 `derived tdcc computes indicators, excludes six digit symbols, and skips missing total row` 的期望 payload。依唯一允許範圍，僅將 `cols` 尾端加上 `holders50`，並將該 fixture 手算的人數合計 `100 + 50 + 25 = 175` 加到 row 尾端；該檔其他內容及其他既有測試均未修改。

## 修正輪

- 移除重建開始前刪除整個 `data/derived/tdcc` 的步驟，改為直接依日期升冪逐週呼叫 `applyTdccWeek`；中途失敗或中斷時，既有 derived 不會先被清空。
- 新增行為測試：重建前放入一個所有 raw 週檔都不含的 symbol derived，重建後驗證該檔仍存在且逐位元組不變。
- README 補充重建腳本不可與每日排程同時執行。

## Design

- `TDCC_COLS` 尾端新增 `holders50`。
- `applyTdccWeek` 將持股分級 1～8 的 `人數` 相加；缺少分級以 0 計。人數沿用 `compactNumber`，因此可解析千分位。
- `upsertTdcc` 寫出前以 `padRowsToWidth(..., 7)` 補齊列寬，既有 6 欄列尾端補 `null`。
- `scripts/rebuild-tdcc-derived.mjs` 支援 `--out <root>`；保留既有 TDCC derived，依日期升冪重播全部 `data/raw/tdcc/**/*.csv.gz`，由 `applyTdccWeek` upsert 並原子寫檔，不處理其他 derived 類型。
- 新增 7 項測試，全部使用暫存 root 與手寫小型 CSV.gz fixture；期望值均手算寫死，並透過 `applyTdccWeek` 及重建腳本 CLI 的 public behavior 驗證。

## Test evidence

| 階段 | 指令 | 結果 |
| --- | --- | --- |
| base `1dbeaac` | `node --test tests/` | 178 tests / 178 pass / 0 fail |
| r1 head（修正前既有期望） | `node --test tests/` | 184 tests / 183 pass / 1 fail；r2 允許的既有 TDCC payload 期望尚未更新 |
| r2 head | `node --test tests/` | 184 tests / 184 pass / 0 fail |
| r2 新測試還原後 | `node --test tests/tdcc-holders50.test.mjs` | 6 tests / 6 pass / 0 fail |
| 修正輪 head | `node --test tests/` | 185 tests / 185 pass / 0 fail |
| 修正輪 targeted | `node --test tests/tdcc-holders50.test.mjs` | 7 tests / 7 pass / 0 fail |

## Ablation evidence

修正輪 head 重新執行原五組消融及新增的刪除步驟消融；每組只暫改指定機制，執行 `node --test tests/tdcc-holders50.test.mjs`，記錄後立即還原。六組都使新測試變紅，最後還原後為 7/7 綠。

| 消融 | 新測試結果 | 失敗數 |
| --- | --- | ---: |
| 分級範圍 1～8 改為 1～7 | 3 pass / 4 fail | 4 |
| 分級範圍 1～8 改為 1～9 | 3 pass / 4 fail | 4 |
| 移除 `padRowsToWidth` | 6 pass / 1 fail | 1 |
| 重建腳本只跑最新一週 | 6 pass / 1 fail | 1 |
| `compactNumber` 不移除千分位逗號 | 6 pass / 1 fail | 1 |
| 重建前加回刪除整個 TDCC derived | 6 pass / 1 fail | 1 |

## Scope and safety statement

- 未碰真實 `data/`；所有寫入與重建測試都在系統暫存 root。
- 未打真實網路；測試使用本地 fixture／既有 mock。
- 既有 6 欄的計算與語意未變，只新增尾欄；重建測試亦驗證前 6 欄逐值不變。
- 未執行真實 repo 的 `run.mjs`、`build-derived.mjs` 或 `rebuild-tdcc-derived.mjs`。
- 除 r2 Contract 明確允許的 `tests/run.test.mjs` 單一期望 payload 外，未修改其他既有測試、Out of Scope 檔案或既有 untracked `REPORT-*.md`。
