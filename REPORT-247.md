READY_FOR_REVIEW

# TICKET-247 Executor Report

## 1. 設計與接線

- 新函式：`applyInsiderHoldingMonth(rootDir, monthKey, { insiderWindow = 60 } = {})`，位於 `scripts/lib/derived.mjs`。輸出 `data/derived/insider/<代號前兩碼>/<代號>.json`，沿用 `writeDerivedJson` 與 `upsertRows`，月份升冪、同月覆寫、保留 60 個月，`updated` 取最後一列月份的 `YYYY-MM-01`。
- 去重鍵是 `(公司代號, 姓名)`。每個姓名第一列的 `目前持股` 與 `設質股數` 只取一次；重複列中任一 `職稱` 含「董事」，該姓名即納入董事口徑。關係人欄位未使用。
- 股本時間序列分市場解讀：TWSE 使用 `公司代號` / `出表日期` / `已發行普通股數或TDR原股發行股數`；TPEX 使用 `SecuritiesCompanyCode` / `Date` / `IssueShares`。對持股檔 `出表日期`，先取日期小於等於它的最新股本；若全部都較晚，取最早一份。無該公司股本或已發行股數小於等於 0 時不產檔。
- 日常路徑：`scripts/run.mjs:552-584` 只收集本次寫入／修訂／強制寫入的 `*_insider_holding` 月份，並呼叫共用投影函式。
- 重建路徑：`scripts/build-derived.mjs:42-45,174-183` 聯集兩市場 `insider_holding` 月份後呼叫同一函式；摘要新增 `insiderMonths`。
- 百分比四捨五入至小數兩位。持股口徑分母為 0 時對應設質比為 `null`；fixture 手算值包含 `[202606, 0, null, 0, null, 2000]`。

## 2. 消融證據

共用指定測試：

`node --test --test-name-pattern="insider holding projection" tests/run.test.mjs`

- 基準綠：`1 tests / 1 pass / 0 fail`。
- ① 拿掉姓名去重，將同名列直接加總：紅。關鍵失敗：實際列 `[202606,30,50,50,45,4000]` 不等於手算 `[202606,15,50,20,37.5,4000]`。
- ② `run.mjs` 不呼叫投影：紅。關鍵失敗：`ENOENT ... data/derived/insider/23/2330.json`（日常路徑抵達斷言）。
- ③ `build-derived.mjs` 不呼叫投影：紅。關鍵失敗：刪除 derived 並重建後 `ENOENT ... data/derived/insider/23/2330.json`。
- ④ TPEX 已發行股數改用 TWSE 欄名：紅。關鍵失敗：`ENOENT ... data/derived/insider/64/6488.json`。
- ⑤ 分母改為永遠取最新一份：紅。關鍵失敗：TWSE 實際列變為 `[202606,7.5,50,10,37.5,8000]`，不等於應取 2026-06-15 股本的手算列。
- 五組均是照 Contract 字面進行，沒有替換。每組後即還原；全部還原後綠：`1 tests / 1 pass / 0 fail`。

## 3. 全套測試計數

- 改前：`node --test tests/` = `156 tests / 156 pass / 0 fail`。
- 改後：`node --test tests/` = `157 tests / 157 pass / 0 fail`。
- 新增 1 條測試，無刪除、skip 或放寬既有斷言。

## 4. 既有 derived 家族不變

本次未修改 symbols、fundamentals、tdcc、market、macro 或 TAIFEX 的轉換邏輯，也未修改 `DERIVED_INPUT_DATASETS`。守門證據包含：

- `tests/run.test.mjs:473`：`derived daily files map fields, market series, and exclude pure six digit symbols`。
- `tests/run.test.mjs:631`：`derived tdcc computes indicators, excludes six digit symbols, and skips missing total row`。
- `tests/run.test.mjs:651`：`build-derived rebuild matches incremental output and repeated rebuild is byte-level stable`。
- `tests/run.test.mjs:826` 起的 monthly revenue 寫入／修訂／no-op 與衝突測試。
- `tests/quarterly-backfill.test.mjs` 的 quarterly 投影、保留與 rebuild 測試。
- `tests/taifex-pcr.test.mjs`、`tests/taifex-foreign-futures.test.mjs`、`tests/taifex-vix.test.mjs` 的 TAIFEX 投影／rebuild 與幂等測試。
- `tests/fred.test.mjs:95` 的 macro 投影、幂等與 rebuild 測試。
- 最終全套 157/157 全綠，上述守門測試均未改寫。

## 5. 抵達、邊界與工作樹

- 新測試 `tests/run.test.mjs:665` 先以 `runSnapshot` 寫出，再斷言 TWSE 手算列 `[202606,15,50,20,37.5,4000]` 與 TPEX 手算列 `[202606,10,10,20,15,5000]`；之後刪除臨時 fixture 的 derived、呼叫 `buildDerived`，先再驗手算值，再驗兩路徑檔案逐位元組相等。
- 同一 fixture 同時覆蓋 TWSE/TPEX 欄名、姓名去重、「有小於等於出表日→取最新」、「全部較晚→取最早」、缺股本、零已發行股數，以及持股口徑分母為 0 時設質比 `null`。
- 未使用網路，未在 repo 根目錄執行 `build-derived`，未對真實 `data/` 呼叫新投影，未修改真實 `data/`。
- 未讀取 `orchestrator-ref.patch`；未 commit、merge、rebase 或開新分支。
- 歷史遺留的 `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、`REPORT-194.md` 均未修改或刪除。
