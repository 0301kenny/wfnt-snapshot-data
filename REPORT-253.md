# READY_FOR_REVIEW

## 實作摘要

- 新增 `applyCapitalEvents(rootDir)`，全量讀取 `data/raw/{twse,tpex}/company_capital/{yyyy}/{date}.json`，輸出單檔 `data/derived/capital_events.json`。
- 輸出固定為 `{ updated, cols, rows }`；`cols` 為 `['id', 'from', 'to', 'before', 'after']`，事件依 `id` 字串遞增、同 `id` 依 `to` 遞增。
- 每個市場各自維護 `lastValidById: Map<id, { date, issued }>`。只有可通過 `isDerivedSymbolId` 且股數可解析並大於 0 的出現才更新 Map；缺列、空字串、`--`、0、負數都不清除或覆寫上一次有效狀態，因此跨快照缺口仍會產生正確的 `from`／`to`。
- `updated` 取兩市場所有可讀 JSON array 快照中最大的檔名日期；兩市場皆無有效快照時回傳 `{ capitalEvents: 0, written: false }`，不寫檔、不拋錯。實際寫入沿用 `writeDerivedJson`，維持 deterministic、write-on-change。
- 日常路徑：`scripts/run.mjs` 在任一 `*_company_capital` 結果為 `write`／`revise`／`forced` 時呼叫 `applyCapitalEvents`；並在 `manifest.paths.insider` 後登記 `manifest.paths.capitalEvents = 'data/derived/capital_events.json'`。
- 重建路徑：`scripts/build-derived.mjs` 無條件呼叫同一個 `applyCapitalEvents`，摘要新增 `capitalEvents` 事件筆數。

## 測試與手算證據

- `tests/capital-events.test.mjs`：上市 3 份、上櫃 2 份 fixture；手寫期望 7 筆事件，涵蓋增加、減少、不變不輸出、公司整列缺席、空字串、`--`、0、負數、上櫃 `IssueShares`、純六碼排除，以及跨缺口 `from` 指向最後一次有效出現。
- 同檔另驗證兩市場皆無有效快照時不產生檔案。
- `tests/run.test.mjs` 的 `capital events reach the daily path and rebuild byte-identically`：先以 `runSnapshot` 跑兩天，再依序確認檔案存在、`rows` 等於手算 `[['2330', 20260706, 20260707, 1000, 1200]]`、manifest 路徑正確；之後刪除 fixture root 的 derived、執行 `buildDerived`，確認摘要計數為 1 且檔案逐位元組相等。

## 消融證據

基準綠：

```text
node --test tests/
tests 164; pass 164; fail 0
```

1. 暫時在每份快照結束後清空 `lastValidById` 並只放回當前快照，使比較退化成只看相鄰快照。

```text
not ok - capital events track the last valid appearance across both market snapshot gaps
Expected capitalEvents: 7; actual: 2
```

2. 暫時移除 `scripts/run.mjs` 呼叫 `applyCapitalEvents` 的整段區塊。

```text
not ok - capital events reach the daily path and rebuild byte-identically
ENOENT: no such file or directory, access '.../data/derived/capital_events.json'
```

3. 暫時把 `scripts/build-derived.mjs` 的呼叫替換為不呼叫投影的 `{ capitalEvents: 0 }`，保留摘要物件形狀，讓測試能抵達重建斷言；這是字面上的「build-derived 不呼叫投影」消融。

```text
not ok - capital events reach the daily path and rebuild byte-identically
Expected values to be strictly equal: 0 !== 1
```

4. 暫時把上櫃 `issued` 欄名由 `IssueShares` 改成上市欄名 `已發行普通股數或TDR原股發行股數`。

```text
not ok - capital events track the last valid appearance across both market snapshot gaps
Expected capitalEvents: 7; actual: 6
```

5. 暫時移除 `manifest.paths.capitalEvents`。

```text
not ok - capital events reach the daily path and rebuild byte-identically
Expected 'data/derived/capital_events.json'; actual: undefined
```

五組消融皆各自單點執行、確認轉紅後立即還原。還原後綠：

```text
node --test --test-name-pattern='capital events' tests/capital-events.test.mjs tests/run.test.mjs
tests 3; pass 3; fail 0

node --test tests/
tests 164; pass 164; fail 0
```

## 改前／改後與既有輸出

- 改前基線：`node --test tests/` = 161 tests / 161 pass / 0 fail。
- 改後最終：`node --test tests/` = 164 tests / 164 pass / 0 fail；新增 3 條，既有 161 條未刪除、未 skip、未放寬。
- 既有 derived 家族（symbols、fundamentals、tdcc、market、macro、insider）轉換碼與輸出格式均未修改。
- 既有輸出守門測試包含：`full build discovers hist dates and exactly matches incremental derived bytes`、`build-derived rebuild matches incremental output and repeated rebuild is byte-level stable`、`derived daily files map fields, market series, and exclude pure six digit symbols`、`derived tdcc computes indicators, excludes six digit symbols, and skips missing total row`、`insider holding projection deduplicates holders, selects point-in-time capital, and rebuilds byte-identically`、`macro derivation enforces the date floor, attribution, adaptive counts, and idempotence`；以上均在最終 164/164 全套測試中通過。

## 邊界聲明

- 未打網路、未執行 repo 根目錄的 `build-derived`、未對真實 `data/` 呼叫新投影函式，也未修改真實 `data/`。
- 未修改 Out of Scope 檔案，未修改或刪除既有 `REPORT-070/189/192/194.md`。
- 未 commit、未 merge、未 rebase、未修改票面；未觸發任何 Stop / Escalate 條款。

## a2

### 狀態

`READY_FOR_REVIEW`

### 改動說明

- `applyCapitalEvents` 現在只在快照至少包含一列有效資料時，才把該快照視為有效並推進 `updated`。有效資料仍須同時滿足公司代號通過 `isDerivedSymbolId`、股數可解析且大於 0。
- 全部列均無效的快照直接略過，不會改動既有的 `lastValidById`；因此既有「最後一次有效出現」追蹤語意不變。
- 新增兩條測試：兩市場僅有無效快照時回傳 `{ capitalEvents: 0, written: false }` 且不產生檔案；有效快照後接無效快照時，手算斷言 `updated` 固定為有效快照日期 `2026-08-01`。
- 未處理 reviewer 提出的上市／上櫃同代號跨市場追蹤；依 Orchestrator 裁決維持 deferred。

### 消融證據

基準綠：

```text
node --test tests/
tests 164; pass 164; fail 0
```

暫時拿掉新增的 `if (snapshot.size === 0) continue;`，只跑兩條 a2 測試，結果為 2 tests / 0 pass / 2 fail；其中一行失敗訊息：

```text
Expected written: false; actual: true (later invalid snapshot also changed updated from 2026-08-01 to 2026-08-02)
```

立即還原守門後：

```text
node --test --test-name-pattern='all invalid|later snapshot' tests/capital-events.test.mjs
tests 2; pass 2; fail 0
```

### 全套測試前後

- a2 改前：`node --test tests/` = 164 tests / 164 pass / 0 fail。
- a2 改後：`node --test tests/` = 166 tests / 166 pass / 0 fail。
- a1 新增的 3 條測試及所有其他既有測試均未修改。
