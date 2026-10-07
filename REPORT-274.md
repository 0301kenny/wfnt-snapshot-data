BLOCKED

# TICKET-274 Executor Report

## Blocker

觸發 Contract `Stop / Escalate` 第 2 條。

Hard Fact 5 聲明「無任何測試讀集保 derived 欄位或列」，但現況中的既有測試 `tests/run.test.mjs:634` 會以 `deepEqual` 比對完整 TDCC derived payload，並固定期待 6 欄 `cols` 與 6 欄 row。加入核准的尾欄 `holders50` 後，完整測試因此有 1 項失敗：實際 payload 多出 `cols[6] = "holders50"` 與 row 第 7 值 `175`。

Acceptance 1 要求完整測試全綠，但 Contract 同時將「既有測試」列為 Out of Scope，且 Stop 2 禁止修改既有測試。故在核准 Scope 內無法完成 Acceptance；依條款停手，未修改 `tests/run.test.mjs`，也未自行修正票面。

## Design implemented before blocker

- `TDCC_COLS` 尾端新增 `holders50`。
- `applyTdccWeek` 將持股分級 1～8 的 `人數` 相加；缺少分級以 0 計。人數沿用 `compactNumber`，因此可解析千分位。
- `upsertTdcc` 寫出前以 `padRowsToWidth(..., 7)` 補齊列寬，既有 6 欄列尾端補 `null`。
- `scripts/rebuild-tdcc-derived.mjs` 支援 `--out <root>`；只移除該 root 的 `data/derived/tdcc`，依日期升冪重播全部 `data/raw/tdcc/**/*.csv.gz`，不處理其他 derived 類型。
- 新增 6 項測試，全部使用暫存 root 與手寫小型 CSV.gz fixture；期望值均手算寫死。

## Test evidence

| 階段 | 指令 | 結果 |
| --- | --- | --- |
| base `1dbeaac` | `node --test tests/` | 178 tests / 178 pass / 0 fail |
| 新測試基準 | `node --test tests/tdcc-holders50.test.mjs` | 6 tests / 6 pass / 0 fail |
| 五組消融還原後 | `node --test tests/tdcc-holders50.test.mjs` | 6 tests / 6 pass / 0 fail |
| head 完整測試 | `node --test tests/` | 184 tests / 183 pass / 1 fail |
| blocker 定位 | `node --test tests/run.test.mjs` | 35 tests / 34 pass / 1 fail；失敗為既有 TDCC 完整 payload 斷言 |

## Ablation evidence

每組都從新測試全綠狀態暫改，執行 `node --test tests/tdcc-holders50.test.mjs`，記錄後立即還原。五組都使新測試變紅。

| 消融 | 新測試結果 | 失敗數 |
| --- | --- | ---: |
| 分級範圍 1～8 改為 1～7 | 2 pass / 4 fail | 4 |
| 分級範圍 1～8 改為 1～9 | 2 pass / 4 fail | 4 |
| 移除 `padRowsToWidth` | 5 pass / 1 fail | 1 |
| 重建腳本只跑最新一週 | 5 pass / 1 fail | 1 |
| `compactNumber` 不移除千分位逗號 | 5 pass / 1 fail | 1 |

## Scope and safety statement

- 未碰真實 `data/`；所有寫入與重建測試都在系統暫存 root。
- 未打真實網路；測試使用本地 fixture／既有 mock。
- 既有 6 欄的計算與語意未變，只新增尾欄；重建測試亦驗證前 6 欄逐值不變。
- 未執行真實 repo 的 `run.mjs`、`build-derived.mjs` 或 `rebuild-tdcc-derived.mjs`。
- 未修改任何既有測試、Out of Scope 檔案或既有 untracked `REPORT-*.md`。
