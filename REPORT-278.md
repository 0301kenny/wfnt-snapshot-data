# READY_FOR_REVIEW

## 設計說明

- `scripts/lib/derived.mjs` 新增 `data/derived/.tdcc-applied-weeks.json`。紀錄以排序後的 ISO 週日期陣列儲存，透過既有原子寫入工具發布；已存在的週不重寫紀錄檔。
- `applyTdccWeek` 只在 raw 讀取、解析與所有 symbol upsert 都成功後，才於既有 TDCC lock 內記錄該週。取得鎖失敗、raw 讀取／解析失敗或 derived 寫入失敗都不會提前標記完成。
- 新增 `pendingTdccWeeks(rootDir)`，回傳「raw 已存在、完成紀錄不存在」的週；紀錄檔不存在時視為全部 raw 週待補。
- `scripts/run.mjs` 將本次 `write/revise/forced` 週與 pending 週合併成去重集合，因此 TDCC freshness skip 或 raw `same` 仍會補寫先前失敗週。
- `tests/tdcc-pending.test.mjs` 以暫存 root 與手寫小型 CSV.gz 覆蓋 Contract 指定的五種情境；README 已補上自動補寫行為與紀錄檔位置。

## 測試證據

| 階段 | 指令 | 結果 |
| --- | --- | --- |
| base `e3141d3` | `node --test tests/` | 192 tests / 192 pass / 0 fail |
| head（消融前） | `node --test tests/` | 197 tests / 197 pass / 0 fail |
| 四組消融還原後 head | `node --test tests/` | 197 tests / 197 pass / 0 fail |
| 最終新測試 | `node --test tests/tdcc-pending.test.mjs` | 5 tests / 5 pass / 0 fail |

## 消融表

消融均只暫時修改實作，執行 `node --test tests/tdcc-pending.test.mjs` 後立即還原；基準先確認為 5/5 綠，四組皆以 exit code 1 紅燈，最後還原為 5/5 綠。

| 組別 | 暫時消融 | 結果 | 被捕捉的行為 |
| --- | --- | --- | --- |
| ① | 移除成功後的已寫週記錄 | 紅：3 pass / 2 fail | 成功週沒有紀錄；`runSnapshot` 補寫後也沒有紀錄 |
| ② | 把已寫週記錄移到 raw 讀取／解析前 | 紅：4 pass / 1 fail | 壞 gzip raw 被錯誤標記完成，不再 pending |
| ③ | `run.mjs` 不併入 pending 週 | 紅：4 pass / 1 fail | raw `same` 時未補寫 derived，也未建立完成紀錄 |
| ④ | pending 查詢忽略完成紀錄、永遠回傳全部 raw | 紅：3 pass / 2 fail | 已成功週仍被列為 pending；其中「寫一週後不再待補」測試紅燈 |

## 執行聲明

- 未修改或執行真實 `data/`；所有新增情境都使用系統暫存 root。
- 未打網路；`runSnapshot` 層級測試使用本地 stub fetcher。
- 未在 repo 根目錄執行 `run.mjs`、`build-derived` 或 TDCC 重建腳本。
- 既有 derived 資料檔輸出格式與內容不變；只新增 TDCC 已套用週的內部完成紀錄。
- 未修改既有測試案例或斷言；只按 Scope 在 `tests/all.mjs` 增加新測試 import。未修改鎖機制、manifest、endpoints、probe artifacts 或其他 Out of Scope 檔案。
