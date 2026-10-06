# READY_FOR_REVIEW

# TICKET-267 Executor Report

## 1. 設計與實作證據

- Raw 路徑與年度策略:
  - 上市: `data/raw/twse/ex_right/{yyyy}/{yyyy}.json`
  - 上櫃: `data/raw/tpex/ex_right/{yyyy}/{yyyy}.json`
  - 年份從 2021 到台北今日所在年。過去年度檔存在即略過；當年度每次重抓 `01-01` 到台北今日，並以 `writeRawBytesOnChange` 保證相同 bytes 不改寫。
  - TWSE 使用 TWT49U GET；TPEX 使用 exDailyQ POST form。官方 response bytes 經驗證後原樣寫入，未重排或美化。
- 驗證與重試:
  - TWSE 必須 `stat === 'OK'` 且 `fields`、`data` 為陣列。
  - TPEX 必須存在第一個 table、`fields`/`data` 為陣列，且 `data.length === totalCount`。
  - 只有 JSON 無法解析或 TPEX `data.length < totalCount` 視為截斷並重試，總計最多 3 次。
  - HTTP 非成功 status、fetch throw、讀 body 失敗、其他 schema 錯誤均立即失敗，不重試、不 sleep。
  - 同一市場首次年度失敗即停止該市場後續年份；另一市場仍執行。delay 預設 3000 ms、可注入，且只在同市場第二次及後續請求前發生。
- Derived:
  - 輸出 `data/derived/corporate_actions/{p2}/{id}.json`。
  - 形狀為 `{ id, updated, cols: ['d', 'pre', 'ref', 'kind'], rows }`。
  - TWSE `114年10月02日` 與 TPEX `114/10/02` 均轉 ISO；價格移除千分位後轉 number；TPEX `除權`/`除息`/`除權息` 正規化為 `權`/`息`/`權息`。
  - 全量讀兩市場所有年度 raw，日期遞增，同代號同日期由較晚讀到的年度檔覆蓋；沿用 `isDerivedSymbolId` 排除純六碼代號；write-on-change 並移除不再存在的舊 per-symbol 檔。
- Manifest 與 run 接線:
  - `twse_ex_right`、`tpex_ex_right` 可由 `--datasets` 選取且包含在預設執行集合。
  - `normalizeSnapshotManifest` 固定登記兩項，成功形狀為 `{ first, latest, years, ok }`，失敗保留 coverage 並設 `ok: false`、`lastError`。
  - 新增 `paths.corporateActions = 'data/derived/corporate_actions/{p2}/{id}.json'`。
  - 未修改 `TRADING_DATE_DATASET_KEYS`，因此日曆日 `latest` 不影響 `latestTradingDate`。
- 日常與重建同一路徑:
  - `runSnapshot` 在任一 ex_right raw 實際 write-on-change 時呼叫 `applyCorporateActions`。
  - `buildDerived` 無條件呼叫同一 `applyCorporateActions`。
  - fixture 驗證刪除 derived 後重建的 per-symbol bytes 與日常路徑逐位元組相同。

## 2. 消融證據

消融前基準:

```text
node --test tests/ex-right.test.mjs
tests 5 / pass 5 / fail 0 / duration_ms 233.270202
```

十組消融均只暫改實作、執行指定測試、確認紅燈後立即反向 patch 還原；未修改測試期望值。

| # | 暫時消融 | 指定測試結果 | 關鍵失敗證據 |
|---|---|---|---|
| 1 | 拿掉 TPEX `data.length === totalCount` 檢查 | RED，1 fail | 截斷 fixture 只請求 1 次，期望 3 次：`1 !== 3` |
| 2 | 年度失敗後 `continue` 抓後續年份 | RED，1 fail | TPEX 2022/2023 被請求，`true !== false` |
| 3 | HTTP/fetch 錯誤改為重試並 sleep | RED，1 fail | calls 由 `['twse','tpex']` 變成各 3 次 |
| 4 | 停用歷史年度 checkpoint | RED，1 fail | 第二跑重新請求 2021/2022，非僅 2023 |
| 5 | 不移除 TPEX kind 開頭「除」 | RED，1 fail | 6488 列被排除，檔數由期望 2 變 1 |
| 6 | 破壞 TWSE `年月日` parser | RED，1 fail | 2330 列無法產出，檔數由期望 2 變 1 |
| 7 | 不使用 `isDerivedSymbolId` 排除六碼 | RED，1 fail | 純六碼檔被產出，檔數由期望 2 變 3 |
| 8 | `buildDerived` 不呼叫 `applyCorporateActions` | RED，1 fail | rebuild summary `corporateActions` 為 0，期望 2 |
| 9 | `normalizeSnapshotManifest` 不登記兩資料集 | RED，1 fail | 後續只跑 FRED 時 ex_right manifest entry 變 `undefined` |
| 10 | 將 ex_right 誤加到交易日白名單 | RED，1 fail | `latestTradingDate` 由期望 `2021-09-30` 被推進至 `2021-10-02` |

全部還原後:

```text
node --test tests/ex-right.test.mjs
tests 5 / pass 5 / fail 0 / duration_ms 224.464215

node --test tests/
tests 176 / pass 176 / fail 0 / duration_ms 6673.164357
```

## 3. 全套測試前後

改前基線（本工作樹實跑）:

```text
node --test tests/
tests 171 / pass 171 / fail 0 / duration_ms 6179.019495
```

改後最終（消融全部還原後實跑）:

```text
node --test tests/
tests 176 / pass 176 / fail 0 / duration_ms 6673.164357
```

新增 5 條，既有 171 條未刪除、未 skip、未放寬；耗時仍為約 6.7 秒，與基線同量級。

## 4. HF6 兩處既有測試完整 diff

```diff
diff --git a/tests/all.mjs b/tests/all.mjs
index 23e06ee..28eb132 100644
--- a/tests/all.mjs
+++ b/tests/all.mjs
@@ -13,6 +13,7 @@ import './taifex-pcr.test.mjs';
 import './taifex-foreign-futures.test.mjs';
 import './taifex-vix.test.mjs';
 import './taifex-current-month.test.mjs';
+import './ex-right.test.mjs';
 
 import test from 'node:test';
 import assert from 'node:assert/strict';
diff --git a/tests/run.test.mjs b/tests/run.test.mjs
index 1f63a56..f14cbfa 100644
--- a/tests/run.test.mjs
+++ b/tests/run.test.mjs
@@ -282,6 +282,8 @@ test('first run writes raw paths and manifest contract with seventeen datasets',
       'fred_dextaus',
       'fred_t10y2y',
       'fred_vixcls',
+      'twse_ex_right',
+      'tpex_ex_right',
     ]);
     assert.equal(m.datasets.tpex_3insti.ok, true);
     assert.deepEqual(m.datasets.tdcc, {
```

`tests/run.test.mjs` 只在資料集期望陣列尾端追加兩項；`tests/all.mjs` 只新增一行 import。

## 5. 執行邊界聲明

- 未打任何真實網路；所有新增驗證只使用注入 fetch fixture。
- 未修改、建立或刪除真實 repo `data/` 內容。
- 未在 repo 根目錄直接執行 `scripts/run.mjs` 或 `scripts/build-derived.mjs`；所有流程測試均使用 `mkdtemp` 隔離 root。
- 未讀取 `orchestrator-ref.patch`。
- 未新增 npm 相依，未修改 Scope 外檔案，未 commit、未 merge、未 rebase。
- 既有 untracked `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、`REPORT-194.md` 未修改或刪除。
