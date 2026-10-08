READY_FOR_REVIEW

# TICKET-276 Executor Report

## 設計說明

- 鎖路徑固定為 `<root>/data/derived/.tdcc.lock`，以不帶 `recursive` 的 `mkdir` 原子取得，成功後在鎖目錄內寫入目前程序的 `pid`。
- `applyTdccWeek` 在讀取週 raw、解析、逐檔 read-modify-write 的整個期間持鎖；三個既有呼叫端未修改。
- 鎖被仍存活的 PID 持有時，每 `lockPollMs` 輪詢一次，預設 200 ms。
- PID 檔指向不存在的程序時會清除殘留鎖後重試；沒有 PID 檔時，只有鎖目錄 mtime 超過 60 秒才會清除，較新的無 PID 鎖視為 busy。
- 等待超過 `lockTimeoutMs`（預設 300000 ms）會拋錯；錯誤訊息同時包含 `busy` 與鎖路徑，且不刪除仍存活程序持有的鎖。
- 取得鎖後由 `finally` 一律釋放，因此 raw 缺失或處理過程拋錯也不會留下鎖。

## 測試證據

指令皆在 `/Users/zhengweizhu/Projects/wfnt-snapshot-data` 執行；所有測試資料均位於 `mkdtemp` 暫存 root。

| 階段 | 指令 | 結果 |
| --- | --- | --- |
| base `51f16fd` | `node --test tests/` | 185 tests / 185 pass / 0 fail |
| head（消融前） | `node --test tests/` | 192 tests / 192 pass / 0 fail |
| 還原五組消融後專項 | `node --test tests/tdcc-lock.test.mjs` | 7 tests / 7 pass / 0 fail |
| 最終 head | `node --test tests/` | 192 tests / 192 pass / 0 fail |

新測試使用手寫小型 CSV 後 gzip，期望列固定手算為 `[20261001, 15, 54, 6, 100, 100, 36]`（第二週日期相應為 `20261008`），沒有從被測程式反推期望值。

## 消融證據

每組均從正式實作單獨改動，執行 `node --test tests/tdcc-lock.test.mjs`，記錄後立即還原；五組的新測試皆為紅。

| 消融組 | 專項結果 | 失敗條數 |
| --- | --- | ---: |
| 1. 拿掉取鎖，直接執行 | 1 pass / 6 fail | 6 |
| 2. 拿掉 `finally` 釋放 | 3 pass / 4 fail | 4 |
| 3. 殘留判定改為一律不清除 | 5 pass / 2 fail | 2 |
| 4. 殘留判定改為一律清除（含活 PID） | 4 pass / 3 fail | 3 |
| 5. 逾時改為不拋錯、直接執行 | 5 pass / 2 fail | 2 |

消融後已完整還原正式實作；還原後專項與全套結果見上一節。

## 範圍聲明

- 未碰觸真實 `data/`，未在 repo root 執行 `run.mjs`、`build-derived` 或重建腳本。
- 未打網路。
- 未修改三個呼叫端、其他 derived、manifest、endpoints、既有測試斷言或歷史 `REPORT-*.md`；`tests/all.mjs` 僅新增 Contract 指定的一行 import。
- `applyTdccWeek` 的 derived 輸出不變（相同 raw 仍產生相同 schema、列與 bytes）；新增內容僅為跨程序互斥、鎖等待／殘留／逾時處理，以及兩個第三參數選項。
