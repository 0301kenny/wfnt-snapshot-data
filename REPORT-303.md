# READY_FOR_REVIEW

TICKET-303 r1 已依 Contract 實作於 `ticket-303` worktree。未連網、未執行任何腳本於真實 `data/`；所有寫入演練均使用暫存 root 與注入的假 fetch。worktree 根目錄的 `data` symlink 未加入 commit。

## 1. 改動位置

- `scripts/endpoints.mjs:430`：新增 monthly backfill-only `tpex_index_hist` registry 項目，月查詢固定使用該月 1 日。
- `scripts/lib/derived.mjs:173`、`:1714`：新增櫃買歷史指數合法性/列解析與 `applyTpexIndexMonth`；數值經 `compactNumber`，同日存在 `tpex/index` OpenAPI raw 時不覆蓋。
- `scripts/backfill-tpex-index.mjs:1`：新增 `--from/--to/--out/--delay-ms` CLI；歷史月 checkpoint、台北當月 refresh、raw bytes 原樣與 write-on-change、逐月 derived、失敗彙總後非 0 exit。
- `scripts/build-derived.mjs:143`：每日 raw 套用後逐月重建 `tpex/index_hist`，與增量共用 `applyTpexIndexMonth`。
- `scripts/lib/ex-right.mjs:191`：`fetchExRightDataset` 新增 `startYear`/`endYear`，預設仍為 2021 到當年；供歷史 CLI 使用的 empty 控制不改日更預設。
- `scripts/backfill-ex-right.mjs:1`：新增 market/year range CLI；只允許早於台北當年的年度、0 列記 `[empty]` 且不寫 raw、完成後只呼叫一次 `applyCorporateActions`。
- `tests/tpex-index-hist.test.mjs`、`tests/ex-right-history.test.mjs`：新增假 fetch＋暫存 root 覆蓋；`tests/all.mjs` 只新增兩個 import；`tests/backfill.test.mjs:340` 只在 registry key 清單末尾加入 `tpex_index_hist`。
- `README.md:64`、`:137` 與 `AGENTS.md:15`：補上 CLI、raw/derived、checkpoint、優先序與日更邊界。

## 2. 完整測試摘要

工作目錄：`/Users/zhengweizhu/Projects/wfnt-snapshot-data-t303`

命令：

```text
node --test tests/
```

原始摘要：

```text
1..307
# tests 310
# suites 0
# pass 310
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12602.018145
```

基線既有測試仍綠，總數由 296 增至 310，符合 `>= 306`。

## 3. 消融證據

三組皆只暫時拿掉單一保護，確認測試轉紅後立即還原；每組還原後同一 targeted test 為 `pass 1 / fail 0`，最後完整 suite 亦為 310/310 綠。

### A. 拿掉 OpenAPI 同日優先

暫時令 `applyTpexIndexMonth` 不檢查 `data/raw/tpex/index/{date}.json`。

```text
$ node --test --test-name-pattern="same-day TPEX OpenAPI" tests/tpex-index-hist.test.mjs
not ok 1 - same-day TPEX OpenAPI index raw wins over historical monthly values
# tests 1
# pass 0
# fail 1
```

差異顯示實際值退回歷史月檔 `[20061002,1,2,0.5,1.5]`，不再是 OpenAPI `[20061002,10,20,5,15]`。還原後：

```text
# tests 1
# pass 1
# fail 0
```

### B. 0 列也寫檔

暫時移除 `skipEmpty` 分支的 `continue`。

```text
$ node --test --test-name-pattern="skips empty raw" tests/ex-right-history.test.mjs
not ok 1 - early ex-right CLI requests only its explicit range, skips empty raw, and derives early events once
error: 'Missing expected rejection.'
# tests 1
# pass 0
# fail 1
```

此失敗表示不應存在的 `2007.json` 被寫出。還原後：

```text
# tests 1
# pass 1
# fail 0
```

### C. 不傳 startYear 時改從 2006 起

暫時把 `fetchExRightDataset` 的 `startYear` 預設改成 2006。

```text
$ node --test --test-name-pattern="keeps the 2021 default" tests/ex-right-history.test.mjs
not ok 1 - fetchExRightDataset keeps the 2021 default when startYear is omitted
actual: [2006,2007,2008,2009,2010,2011,2012,2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023]
expected: [2021,2022,2023]
# tests 1
# pass 0
# fail 1
```

還原為 `EX_RIGHT_START_YEAR` 後：

```text
# tests 1
# pass 1
# fail 0
```

## 4. 兩支 CLI 暫存 root＋假 fetch 演練

兩次均以 `node --import /tmp/wfnt-ticket303-evidence.DU8pDy/fake-fetch.mjs` 注入假 fetch；沒有網路請求。

### 櫃買指數月回補

命令參數：`scripts/backfill-tpex-index.mjs --from 2006-10 --to 2006-10 --out /tmp/wfnt-ticket303-evidence.DU8pDy/tpex --delay-ms 0`

stdout 原文：

```text
[backfill-tpex-index] range 2006-10..2006-10 out=/tmp/wfnt-ticket303-evidence.DU8pDy/tpex delay=0ms
[ok] 2006-10 rows=1
[done] months=1 requests=1 skipped=0 rawWritten=1 derivedWritten=1 rows=1 failed=0
```

產出檔案清單：

```text
/tmp/wfnt-ticket303-evidence.DU8pDy/tpex/data/raw/tpex/index_hist/2006/2006-10.json
/tmp/wfnt-ticket303-evidence.DU8pDy/tpex/data/derived/market.json
```

### 除權息早年回補

命令參數：`scripts/backfill-ex-right.mjs --market twse --from-year 2006 --to-year 2007 --out /tmp/wfnt-ticket303-evidence.DU8pDy/ex-right --delay-ms 0`

stdout 原文：

```text
[backfill-ex-right] market=twse range=2006..2007 out=/tmp/wfnt-ticket303-evidence.DU8pDy/ex-right delay=0ms
[empty] twse 2007
[done] market=twse years=2 rawWritten=1 empty=1 corporateActions=1 derivedWritten=1
```

產出檔案清單：

```text
/tmp/wfnt-ticket303-evidence.DU8pDy/ex-right/data/raw/twse/ex_right/2006/2006.json
/tmp/wfnt-ticket303-evidence.DU8pDy/ex-right/data/derived/corporate_actions/23/2330.json
```
