READY_FOR_REVIEW

# TICKET-276 Executor Report

## 設計說明

- 鎖路徑固定為 `<root>/data/derived/.tdcc.lock`，以不帶 `recursive` 的 `mkdir` 原子取得，成功後在鎖目錄內寫入目前程序的 `pid`。
- `applyTdccWeek` 在讀取週 raw、解析、逐檔 read-modify-write 的整個期間持鎖；三個既有呼叫端未修改。
- 鎖被仍存活的 PID 持有時，每 `lockPollMs` 輪詢一次，預設 200 ms。
- PID 檔指向不存在的程序，或沒有 PID 且鎖目錄 mtime 超過 60 秒時，會先取得 `.tdcc.lock.break`，在拆鎖鎖內重新判定主鎖仍為殘留後才清除；拆鎖鎖 mtime 超過 10 秒時可直接清除。較新的無 PID 主鎖視為 busy。
- 等待超過 `lockTimeoutMs`（預設 300000 ms）會拋錯；錯誤訊息同時包含 `busy` 與鎖路徑，且不刪除仍存活程序持有的鎖。
- 取得鎖後由 `finally` 釋放；釋放前讀取 PID，只有 PID 等於本程序才刪除，因此 raw 缺失或處理過程拋錯會釋放自己的鎖，但不會刪除已由其他程序接管的鎖。

## 測試證據

指令皆在 `/Users/zhengweizhu/Projects/wfnt-snapshot-data` 執行；所有測試資料均位於 `mkdtemp` 暫存 root。

| 階段 | 指令 | 結果 |
| --- | --- | --- |
| base `51f16fd` | `node --test tests/` | 185 tests / 185 pass / 0 fail |
| head（消融前） | `node --test tests/` | 192 tests / 192 pass / 0 fail |
| 還原五組消融後專項 | `node --test tests/tdcc-lock.test.mjs` | 7 tests / 7 pass / 0 fail |
| 首輪 head `6602289` | `node --test tests/` | 192 tests / 192 pass / 0 fail |

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

## 修正輪（P1 compare-and-delete）

### 變更

- 修正 `6602289` 中「判定主鎖殘留」與「刪除主鎖」之間的競態：等待者必須先用原子 `mkdir` 取得 `data/derived/.tdcc.lock.break`，持有拆鎖鎖時重新判定主鎖，只有仍為殘留才刪除。拿不到拆鎖鎖時按原輪詢流程等待後重試；超過 10 秒的拆鎖鎖可直接清除。
- 修正 `finally` 的無條件主鎖刪除：釋放前讀取 `pid`，僅在等於本程序 PID 時刪除主鎖。
- 新增兩個僅供測試的內部 hook，分別固定「初次判定殘留後、取得拆鎖鎖前」及「釋放前」的競態位置；production 呼叫端未傳入也未修改。
- 新增兩條決定性測試，由獨立 Node 子程序實際接管主鎖：第一條驗證重新判定會保留新 owner 且等待者不會進入寫入；第二條驗證 `finally` 不會刪除其他程序的新鎖。測試順序由 IPC 與 hook 同步，不依賴計時巧合。
- DEFERRED P2「21:15 排程鎖逾時後該週 derived 永久缺失」未在本輪處理。

### 測試結果

| 階段 | 指令 | 結果 |
| --- | --- | --- |
| 正式實作專項 | `node --test tests/tdcc-lock.test.mjs` | 9 tests / 9 pass / 0 fail |
| 最終完整測試 | `node --test tests/` | 194 tests / 194 pass / 0 fail |

### 修正輪消融

每組均單獨改動正式實作、執行 `node --test tests/tdcc-lock.test.mjs`，記錄後還原。新增兩組及受影響的原五組全部為紅。

| 消融組 | 專項結果 | 失敗條數 |
| --- | --- | ---: |
| 新 1. 拿掉持拆鎖鎖後的重新判定 | 8 pass / 1 fail | 1 |
| 新 2. 釋放時不檢查 PID | 8 pass / 1 fail | 1 |
| 原 1. 拿掉取鎖，直接執行 | 2 pass / 7 fail | 7 |
| 原 2. 拿掉 `finally` 釋放 | 5 pass / 4 fail | 4 |
| 原 3. 殘留判定改為一律不清除 | 6 pass / 3 fail | 3 |
| 原 4. 殘留判定改為一律清除（含活 PID） | 5 pass / 4 fail | 4 |
| 原 5. 逾時改為不拋錯、直接執行 | 6 pass / 3 fail | 3 |

七組消融後已完整還原正式實作；還原後專項與全套結果如上。

## 範圍聲明

- 未碰觸真實 `data/`，未在 repo root 執行 `run.mjs`、`build-derived` 或重建腳本。
- 未打網路。
- 未修改三個呼叫端、其他 derived、manifest、endpoints、既有測試斷言或歷史 `REPORT-*.md`；`tests/all.mjs` 僅新增 Contract 指定的一行 import。
- `applyTdccWeek` 的 derived 輸出不變（相同 raw 仍產生相同 schema、列與 bytes）；新增內容僅為跨程序互斥、鎖等待／殘留／逾時處理、兩個逾時選項，以及僅供競態測試的內部 hooks。
