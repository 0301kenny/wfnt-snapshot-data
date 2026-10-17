# READY_FOR_REVIEW

TICKET-300 r1 已依 Contract 完成。未觸發任何 Stop / Escalate 條款；未連網、未在真實 `data/` 執行 runner 或 derived script，所有寫入演練都使用暫存 root 與注入的假 fetch。

## 1. 定義與接線位置

- Reference endpoint：`scripts/endpoints.mjs:333` 的 `REFERENCE_ENDPOINTS.twse_industry_mi_index`。
- 類股 parser：`scripts/lib/derived.mjs:408` 的 `parseTwseSectorIndexes`、`:420` 的 `parseTwseSectorIndexesHist`。
- 類股共用逐日轉換：`scripts/lib/derived.mjs:813` 的 `applySectorIndexDate`；`applyDailyDate` 於 `:1697` 呼叫。
- 類股獨立重建 CLI：`scripts/rebuild-sector-index.mjs:20` 的 `rebuildSectorIndex`，只刪除並重建 `sector_index.json`。
- 產業最新股本選取：`scripts/lib/derived.mjs:852` 的 `latestCompanyIndustryRows`。
- 產業共用轉換：`scripts/lib/derived.mjs:917` 的 `applyIndustryIndex`。
- 日更接線：`scripts/run.mjs:445` 注入 `applyIndustryIndexImpl`，`:702` 在 company-capital 變更時呼叫。
- 全量接線：`scripts/build-derived.mjs:189` 呼叫 `applyIndustryIndex`。
- 產業獨立建立 CLI：`scripts/build-industry-index.mjs:18` 的 `buildIndustryIndex`。
- 名稱回補參數與 runner：`scripts/backfill-industry-names.mjs:60` 的 `industryNameBackfillOptionsFromArgs`、`:71` 的 `runIndustryNameBackfill`。

## 2. 完整測試摘要

在 worktree 根目錄執行：

```text
$ node --test tests/
1..265
# tests 265
# suites 0
# pass 265
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11557.277733
```

基線為 250/250；新增 15 個測試後為 265/265。既有測試未修改，`tests/all.mjs` 僅新增兩個 import。

## 3. 消融證據

三組消融都只暫改實作，觀察指定新測試轉紅後立即還原。

1. 類股不排除非「類指數」列：將 `!name.endsWith('類指數')` 暫時移除後，`sector OpenAPI parser keeps only...` 失敗，actual 額外出現 `發行量加權股價指數`、`半導體類報酬指數`、`臺灣50指數`；exit 1，0 pass / 1 fail。
2. `rebuild-sector-index` 先刪整個 `derived`：將單檔 `rm(.../sector_index.json)` 暫改為遞迴刪除 `data/derived` 後，`sector-only rebuild matches...` 因 `keep.json` 為 ENOENT 失敗；exit 1，0 pass / 1 fail。
3. 產業同代號改為上櫃優先：將市場處理順序暫改為 `['twse', 'tpex']` 後，`6488` actual 成為 `['6488', 'tpex', '33']`，不符合預期 `['6488', 'twse', '24']`；exit 1，0 pass / 1 fail。

還原後執行：

```text
$ node --test tests/sector-index.test.mjs tests/industry-index.test.mjs
1..15
# tests 15
# pass 15
# fail 0
```

其後完整套件亦為 265/265 綠，見上一節。

## 4. 名稱回補 CLI 隔離演練

以 `mkdtemp` 暫存 root 建立兩市場假 `company_capital` raw，透過 `NODE_OPTIONS=--import=<temporary fake-fetch.mjs>` 注入假 fetch，實際執行：

```text
node scripts/backfill-industry-names.mjs --date 2026-10-16 --out <temporary-root> --delay-ms 0
```

exit code：`0`

stdout 原文：

```text
[write] 01: data/raw/twse/industry_mi_index/2026/2026-10-16_01.json
[write] 32: data/raw/twse/industry_mi_index/2026/2026-10-16_32.json
industry names: date=2026-10-16 codes=2 written=2 skipped=0 failed=0
```

產出檔案清單：

```text
data/raw/twse/industry_mi_index/2026/2026-10-16_01.json
data/raw/twse/industry_mi_index/2026/2026-10-16_32.json
```
