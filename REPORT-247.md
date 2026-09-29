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

## a2

READY_FOR_REVIEW

### 四項修正設計

- F1 增量補投影：`runSnapshot` 收集本次狀態為 `write`／`revise`／`forced` 的 `*_company_capital` 市場，從該市場磁碟上的 `insider_holding` raw 找出最新月份，加入既有 `changedInsiderMonthsForDerived` 集合，再由同一個 `applyInsiderHoldingMonth` 投影。持股 raw 本次為 `same` 也能在股本到達時補檔；月份集合仍會去重。
- F2 設質缺值：`aggregateInsiderRows` 只要求 `目前持股` 可解析；`設質股數` 保留 `null`。彙總時董事與全部內部人各自追蹤 pledge completeness：持股一律納入，該口徑只要包含一位設質不可解析的持有人，該口徑設質比為 `null`。姓名去重、第一列持股／設質取值與任一列董事身分的 a1 規則不變。
- F3 六碼排除：在建立公司彙總前呼叫既有 `isDerivedSymbolId(id)`，純數字六碼代號不進入 insider derived；規則與 symbols、fundamentals、TDCC 相同。
- F4 單檔解析：`capitalFileDateAtReportDate(dates, reportDate)` 只用已排序的 raw 檔名日期選檔，仍採「不晚於出表日的最新檔，若全較晚則最早檔」。`readCompanyCapitalFile` 只解析選中的一份檔案，並以市場各自欄名建立公司股本 map；同一市場／同一選檔日期以 cache 共用。選中檔缺公司或股本不大於 0 仍不產檔。

### 追加驗收 8～12

- 驗收 8：第一次只寫持股且無股本，確認不產檔；第二次同一持股回應為 `same`、股本為 `write`，確認產生手算列 `[202606,25,20,25,20,2000]`；刪除臨時 derived 後 `buildDerived` 重建，內容及 bytes 均與增量相同。
- 驗收 9：董事持股 600／設質 300，加上一位經理人持股 200／設質空字串，手算列為 `[202606,15,50,20,null,4000]`，證明缺設質者的持股仍計入且只污染所屬口徑的設質比。
- 驗收 10：持股與股本都有 `123456` 時，斷言 `data/derived/insider/12/123456.json` 不存在。
- 驗收 11：股本目錄同時有 2026-06-15 與 2026-06-25，持股出表日為 2026-06-20；將不應選取的 06-25 檔改為損壞 JSON 後，投影仍以 06-15 股本成功寫出手算列 `[202606,15,50,15,50,4000]`。
- 驗收 12：a1 測試完整保留；新增 4 條後全套由 a1 的 157 條增至 161 條，無刪除、skip 或放寬既有斷言。

### 追加消融 ⑥～⑨

共同基準與還原命令：

`node --test --test-name-pattern='insider holding|company capital write' tests/run.test.mjs`

- 基準綠：`5 tests / 5 pass / 0 fail`。
- ⑥ 照字面拿掉股本寫入觸發，只跑驗收 8：紅，`1 tests / 0 pass / 1 fail`。關鍵失敗：第二次持股為 `same` 後，`ENOENT ... data/derived/insider/23/2330.json`。
- ⑦ 照字面把設質缺值改回整位持有人略過，只跑驗收 9：紅，`1 tests / 0 pass / 1 fail`。關鍵失敗：實際 `insPct=15, insPledgePct=50`，不等於手算 `insPct=20, insPledgePct=null`。
- ⑧ 照字面拿掉六碼排除，只跑驗收 10：紅，`1 tests / 0 pass / 1 fail`。關鍵失敗：`Missing expected rejection.`，代表 `123456.json` 被錯誤產生。
- ⑨ 照字面改回讀取全部股本檔，只跑驗收 11：紅，`1 tests / 0 pass / 1 fail`。關鍵失敗：未選取的 06-25 損壞檔觸發 `SyntaxError: Expected property name or '}' in JSON at position 1`，後續斷言得到 `ENOENT`。
- 四組均逐項還原；還原後綠：`5 tests / 5 pass / 0 fail`。

### 全套與不變式

- a2 改後：`node --test tests/` = `161 tests / 161 pass / 0 fail`；a1 為 `157 / 157 / 0`，開票前為 `156 / 156 / 0`。
- a1 已通過的姓名去重、TWSE/TPEX 欄名、股本時間點規則、輸出形狀與 byte-identical rebuild 測試仍為綠；新程式仍由 `applyInsiderHoldingMonth` 同時服務增量與重建。
- 既有 derived 家族未改；守門仍由 `derived daily files map fields...`、`derived tdcc computes indicators...`、`build-derived rebuild matches incremental output...`、monthly/quarterly/TAIFEX/FRED 各自的 rebuild 與幂等測試涵蓋。
- 全程只在測試臨時目錄寫 fixture；未打網路、未修改真實 `data/`、未在 repo 根目錄執行 `build-derived`，也未讀取 `orchestrator-ref.patch`。
