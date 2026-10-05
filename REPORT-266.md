# READY_FOR_REVIEW (a2)

## 1. 設計與實作

- `scripts/lib/manifest.mjs:88` 將 `refreshLatestTradingDate` 從掃描 `manifest.datasets` 全部條目，改為只掃描 `DATASET_KEYS` 各條目的 `latest`。
- 採白名單是為了讓核心 TWSE/TPEX 行情成為唯一判準；現有與未來新增的非交易資料集預設不會推進 `latestTradingDate`。`tdcc` 雖在 `DATASET_KEYS`，但只有 `latestWeek` 而沒有 `latest`，不會參與最大值。
- 既有污染值不需 migration：`scripts/run.mjs` 每次執行尾端都會呼叫 `refreshLatestTradingDate`，再以新舊 manifest 字串判斷是否寫回。測試在保留 `twse_company_capital.latest = 2026-07-11` 的情況下，第二次只跑無關的 `tpex_index`，證明 `latestTradingDate` 會回到核心行情最大值 `2026-07-06`。
- `tests/run.test.mjs:1163` 起在檔尾新增三條測試，涵蓋週末出表、既有污染改正、TPEX 單獨推進；所有期望日期均為手寫字串。

## 2. 消融證據

指定測試命令均使用 fixture fetcher，沒有真實網路請求。

### 基準綠（正式白名單）

命令：

```text
node --test --test-name-pattern='weekend report dates|repairs a weekend-polluted|newer TPEX core' tests/run.test.mjs
```

結果：exit 0；3 tests / 3 pass / 0 fail。

### 消融 1：退回取全部資料集

暫改為 `Object.values(manifest.datasets).map((entry) => entry.latest)`，執行驗收 1、2：exit 1；2 tests / 0 pass / 2 fail。

- 驗收 1：expected `2026-07-06`，actual `2026-07-12`。
- 驗收 2：expected `2026-07-06`，actual `2026-07-11`。

### 消融 2：白名單加入兩市場 company capital

暫將 `twse_company_capital`、`tpex_company_capital` 加入白名單，執行驗收 1、2：exit 1；2 tests / 0 pass / 2 fail。

- 驗收 1：expected `2026-07-06`，actual `2026-07-12`。
- 驗收 2：expected `2026-07-06`，actual `2026-07-11`。

### 消融 3：白名單加入兩市場 insider transfer

暫將 `twse_insider_transfer`、`tpex_insider_transfer` 加入白名單，執行驗收 1：exit 1；1 test / 0 pass / 1 fail。

- expected `2026-07-06`，actual `2026-07-12`。

### 消融 4：只取上市資料集

暫將白名單過濾為 `key.startsWith('twse_')`，執行驗收 3：exit 1；1 test / 0 pass / 1 fail。

- expected `2026-07-07`，actual `2026-07-06`。

### 還原後綠

還原正式 `DATASET_KEYS` 白名單後重跑三條指定測試：exit 0；3 tests / 3 pass / 0 fail。

## 3. 全套測試

- 改前：`node --test tests/` → 166 tests / 166 pass / 0 fail / 0 skipped。
- 改後：`node --test tests/` → 169 tests / 169 pass / 0 fail / 0 skipped。
- 既有 166 條測試沒有刪除、skip 或放寬。

## 4. README.md 完整 diff

```diff
diff --git a/README.md b/README.md
index 8abf896..331d725 100644
--- a/README.md
+++ b/README.md
@@ -31,7 +31,7 @@ data/raw/{source_dataset}/{yyyy}/{date}.json
 
 Raw 檔是權威層,內容保持官方回應位元組,不重排、不美化、不過濾。`data/manifest.json` 只在資料或狀態實際變更時改寫;同日 no-op 重跑不得產生 diff。
 
-`twse_bwibbu_all` 是上市個股估值日更資料,以全列 `Date` 最大值決定 raw 日期,不作 anchor;列日期不可用時才 fallback 到 TWSE anchor 日。
+`twse_bwibbu_all` 是上市個股估值日更資料,以全列 `Date` 最大值決定 raw 日期,不作 anchor;列日期不可用時才 fallback 到 TWSE anchor 日,且不納入 `latestTradingDate`。
 
 ## Current-only insider and company snapshots
 
@@ -44,7 +44,7 @@ Raw 檔是權威層,內容保持官方回應位元組,不重排、不美化、不過濾。
 - `twse_company_capital`（日更，`t187ap03_L`）
 - `tpex_company_capital`（日更，`mopsfin_t187ap03_O`）
 
-這六支端點沒有歷史回補與 derived 轉換。月更持股 raw 使用月頻路徑，四支日更 raw 使用一般日頻路徑；上市與上櫃的欄名逐端點獨立驗證，不假設跨市場一致。
+這六支端點都沒有歷史回補,也不納入 `latestTradingDate`。月更持股會產生 `data/derived/insider/`,股本會投影到 `data/derived/capital_events.json` 並供 insider 計算使用,insider transfer 則沒有 derived 轉換。月更持股 raw 使用月頻路徑,四支日更 raw 使用一般日頻路徑；上市與上櫃的欄名逐端點獨立驗證,不假設跨市場一致。
 
 ## TWSE/TPEX daily historical backfill
```

## 5. 邊界聲明

- 未修改、產生或刪除真實 `data/` 內容；`git diff --name-only -- data` 無輸出。
- 未打真實網路；新增測試全部使用 fixture fetcher。
- 未在 repo 根目錄執行 `scripts/run.mjs` 或 `build-derived`。
- 未修改 Scope 外檔案、未修改既有測試、未讀取 `orchestrator-ref.patch`、未 commit。
- 歷史遺留的 untracked `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、`REPORT-194.md` 均未修改或刪除。

## a2 修正

### 修改內容

- `scripts/lib/manifest.mjs:14` 新增具名白名單 `TRADING_DATE_DATASET_KEYS = [...DATASET_KEYS, 'twse_bwibbu_all']`；`:90` 的 `refreshLatestTradingDate` 只讀這個白名單。既有 `DATASET_KEYS` 核心交易資料加上以全列 `Date` 取得交易日的 `twse_bwibbu_all`，而 current-only 出表資料仍預設排除。
- `README.md:34` 改為說明 `twse_bwibbu_all` 納入 `latestTradingDate`，日期取自全列 `Date` 且為交易日；`:47` 的 Current-only 六支端點「不納入」敘述維持不變。
- `tests/run.test.mjs:1259` 起只在檔尾新增兩條測試，a1 三條及其他既有測試未修改：
  - 全新 root 只跑 `twse_bwibbu_all`，fixture `Date = 1150706`，斷言 `latestTradingDate = '2026-07-06'`。
  - 全新 root 只跑 `twse_company_capital`，fixture `出表日期 = 1150711`，斷言資料集 `latest = '2026-07-11'` 且 `latestTradingDate = null`。

### 消融證據

先以正式白名單執行 a1 三條加 a2 兩條指定測試：exit 0；5 tests / 5 pass / 0 fail。

1. 退回掃描全部 `manifest.datasets`：a1 驗收 1、2 皆紅，exit 1；2 tests / 0 pass / 2 fail；actual 分別為 `2026-07-12`、`2026-07-11`，expected 均為 `2026-07-06`。
2. 白名單加入兩市場 `company_capital`：a1 驗收 1、2 皆紅，exit 1；2 tests / 0 pass / 2 fail；actual 分別為 `2026-07-12`、`2026-07-11`。同一消融另跑 a1 週末測試與 a2 company-capital-only 測試：2 tests / 0 pass / 2 fail，後者 actual `2026-07-11`、expected `null`。
3. 白名單加入兩市場 `insider_transfer`：a1 驗收 1 紅，exit 1；1 test / 0 pass / 1 fail；actual `2026-07-12`、expected `2026-07-06`。
4. 白名單只取 `twse_` 資料集：a1 驗收 3 紅，exit 1；1 test / 0 pass / 1 fail；actual `2026-07-06`、expected `2026-07-07`。
5. 白名單拿掉 `twse_bwibbu_all`：a2 第一條新測試紅，exit 1；1 test / 0 pass / 1 fail；actual `null`、expected `2026-07-06`。
6. 白名單加入兩市場 `company_capital`：a2 第二條新測試與 a1 週末測試皆紅，exit 1；2 tests / 0 pass / 2 fail；actual 分別為 `2026-07-11`、`2026-07-12`。

最後還原正式白名單再跑五條指定測試：exit 0；5 tests / 5 pass / 0 fail。

### 完整測試與邊界

- 改前（a1 head `92d8053`）：`node --test tests/` → 169 tests / 169 pass / 0 fail / 0 skipped。
- 改後：`node --test tests/` → 171 tests / 171 pass / 0 fail / 0 skipped。
- 全程只使用 fixture，未打網路；未修改真實 `data/`，未在 repo 根目錄執行 `run.mjs` 或 `build-derived`，未 commit。
