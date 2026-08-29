# REPORT-195

## 結論

- 狀態: **BLOCKED**。
- 停止原因: 已達票面規定的第 3 修正輪,驗收 4 仍因 Contract 與官方固化回應矛盾而失敗;依規則立即停手,未再修改 production/test。
- 分支/HEAD: `ticket-195` / `6e32b780b53070366b0e524d3ca8b03fdd2949d6`。
- 測試數: 修改前 `63 pass / 0 fail`;季度目標測試最終 `12 tests / 11 pass / 1 fail`;未取得最終全套綠燈。
- 未 commit;未修改 WFNT_app;未在 repo 根目錄執行 `build-derived`;未對真 `data/` 寫檔;未碰既有 `REPORT-070.md` / `REPORT-189.md` / `REPORT-192.md` / `REPORT-194.md`。

## Blocker:票面驗收 4 與官方回應矛盾

固化 fixture 的 header/anchor 列取自 Orchestrator 開票前留在 `/tmp` 的官方 UTF-8 回應:

- `/tmp/t163_sii_114_01.html` (1,586,884 bytes)
- `/tmp/t163_sii_114_02.html` (1,629,240 bytes)
- `/tmp/t163_otc_114_02.html` (1,329,316 bytes)

官方 `otc/114/Q2` 第一張表 header 實際同時含:

```text
營業利益
本期淨利（淨損）
```

所以相對四個必要概念欄,實際只缺:

```text
營業收入
營業毛利（毛損）
```

但票面驗收 4 明定 OTC 第一張表應缺三欄:

```text
營業收入
營業毛利（毛損）
本期淨利（淨損）
```

這與官方回應原文直接矛盾。最終重現:

```bash
node --test tests/quarterly-backfill.test.mjs
```

實際 fail:

```text
not ok 4 - taking the first 公司代號 header fails in both markets while production selection succeeds
Expected values to be strictly deep-equal:
+ actual - expected
  [
    '營業收入',
    '營業毛利（毛損）',
-   '本期淨利（淨損）'
  ]
1..12
# tests 12
# pass 11
# fail 1
```

建議後續: Orchestrator 發新 revision,將 OTC 負向對照改成官方原文可證明的缺欄集合,或提供其參考實作所用的另一份官方 fixture 原文與 SHA-256。Contract 未修訂前不應改 production 判別式或捏造 header 讓測試通過。

## 實作摘要(已留在 working tree,尚未完成驗收)

- `scripts/endpoints.mjs`:新增 MOPS `ajax_t163sb04` 的 `sii` / `otc` 兩個 backfill-only endpoint。
- `scripts/backfill-quarterly.mjs`:新增 `--from` / `--to` / `--out` / `--delay-ms`,POST form、Q1 起算限制、raw checkpoint、UTF-8 一般業表驗證與原始 bytes 落地。
- `scripts/lib/derived.mjs`:新增一般業多表 parser、header 文字索引、單季絕對數差分、三率、`quarterly` 序列、window 24、TWSE 優先、reconcile 第三分支與三序列皆空才刪檔。
- `scripts/build-derived.mjs`:全量重建會發現並套用 `quarterly_fin_hist` 季鍵;僅在測試 temp root 內呼叫。
- `tests/fixtures/mops-quarterly-2025.mjs`:固化官方 30 欄 header、SII 六表/OTC 兩表形態及 1101/2330 錨點列。
- `tests/quarterly-backfill.test.mjs`:新增 12 條季度解析、差分、負向對照、reconcile、CLI、隔離串接與既有序列保護測試。
- `tests/backfill.test.mjs` / `tests/run.test.mjs`:同步新增 backfill allowlist 與 fundamentals `quarterly` 空序列欄位。
- `AGENTS.md` / `README.md`:同步端點、CLI、raw 路徑、序列鍵與 `q` 編碼。

## 驗收結果

### 1. `node --test tests/` 全綠且 > 63 — FAIL

基線實跑:

```text
1..63
# tests 63
# pass 63
# fail 0
# duration_ms 2833.515498
```

第一次修改後全套尾段(當時既有 endpoint allowlist 尚未同步;之後已機械性修正):

```text
1..63
# tests 63
# pass 62
# fail 1
# duration_ms 2494.72616
```

季度目標最終尾段:

```text
1..12
# tests 12
# pass 11
# fail 1
# duration_ms 487.164092
```

依第 3 修正輪停止規則,未再執行最終全套。

### 2. HF5 六組黃金錨點 — PASS

官方固化絕對數與實算:

```text
1101 Q1 absolute=[34956255,5893708,2301470,768392] rates=[16.86,6.58,2.2]
1101 Q2 cumulative=[70310678,11240554,3415898,1498464]
1101 Q2 single(diff)=[35354423,5346846,1114428,730072] rates=[15.12,3.15,2.07]
2330 Q1 absolute=[839253664,493395076,407080808,360732661] rates=[58.79,48.51,42.98]
2330 Q2 cumulative=[1773045533,1040764314,870504446,758226085]
2330 Q2 single(diff)=[933791869,547369238,463423638,397493424] rates=[58.62,49.63,42.57]
```

目標測試 `HF5 golden anchors produce all six exact single-quarter margin groups` 通過。

### 3. Q2 累計負向對照 — PASS

```text
2330 single=[58.62,49.63,42.57] cumulative=[58.7,49.1,42.76]
1101 single=[15.12,3.15,2.07] cumulative=[15.99,4.86,2.13]
```

`1101` 營益率確為單季 `3.15` 對累計 `4.86`。

### 4. HF3 第一張表負向對照 — FAIL / BLOCKER

SII 第一張表四個概念欄全缺,符合票面。OTC 官方第一張表含 `營業利益` 與 `本期淨利（淨損）`,與票面要求的缺三欄集合不符。完整 fail 見上方 Blocker。

### 5. HF2 header 插欄負向對照 — PASS

fixture 對一般業區段 header 與全部資料列同步插入第 3 欄,所有列寬均為 31:

```text
header-indexed 2330 revenue=839253664 grossProfit=493395076
hard-coded row[2]=999
```

目標測試通過。

### 6. HF7 刪檔保護 — PASS

目標測試建立季度-only 檔,先跑 valuation reconcile,再建立最後一列 revenue 並讓 revenue reconcile 移除;兩次後檔案都存在,內容保留:

```json
{"cols":["q","gm","om","nm"],"rows":[[20251,58.79,48.51,42.98]]}
```

### 7. 前一季缺席 — PASS

只放 `2025-Q2` raw 時輸出:

```text
[warn] derived: quarterly dataset=twse/quarterly_fin_hist seasonKey=2025-Q2 previous raw missing; skipped=2
```

`2330.json` 與 `1101.json` 皆 `ENOENT`,沒有累計頂替或 null 列。

### 8. `--from` 非 Q1 拒絕 — PASS

CLI 目標測試實際 spawn 子程序,exit 非 0,stderr 含:

```text
Error: --from must start at Q1 because later quarters require same-year cumulative differencing, got: 2025-Q2
```

### 9. 隔離 backfill → apply 串接 — FAIL(行為通過,Required Evidence 未完成)

目標測試在 `mkdtemp` 隔離 root 內通過,證明兩份 raw 與 derived `2330` / `1240` quarterly 列產出;但因第 3 修正輪立即停手,未另留持久 `<tmpdir>` 的 `find` 輸出,故按 Required Evidence 判 FAIL。

已通過的 derived 片段:

```json
{"cols":["q","gm","om","nm"],"rows":[[20251,58.79,48.51,42.98]]}
```

### 10. 真 `data/` 零變動與 scope — PASS

開工時戳:

```text
/var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/ticket-195-start.XXXXXX.AaCYFIAz
```

```bash
find data -type f -newer /var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/ticket-195-start.XXXXXX.AaCYFIAz
```

輸出為空。未在 repo 根目錄執行 `build-derived`;所有測試寫入都在 `mkdtemp` root。

## 既有能力移除檢查

結論: **沒有移除任何既有行為、欄位、輸出或測試斷言**。

- 行為: `ENDPOINTS` 日更清單仍 11 項;季度 endpoint 只加入 `BACKFILL_ENDPOINTS`;未改 `scripts/run.mjs`、既有 backfill 或 workflow。
- 欄位/輸出: fundamentals 僅新增 `quarterly`;`valuation` / `revenue` 的 cols、rows、排序、window 與 `updated` 計算未改。
- 既有測試:未刪除、skip、放寬任何 assertion;只在 endpoint allowlist 加新 key,並在兩個完整 fundamentals 期望物件加入空 `quarterly` 欄。
- valuation/revenue 位元級比對:目標測試先序列化既有兩個 subtree,執行 `applyQuarterlyFinancials`,再以 `JSON.stringify({valuation,revenue})` 逐 byte 比對,結果相等;`updated` 仍為 `2026-07-01`。季度目標 11/12 中此測試通過。
- 第一次修改後全套測試中,除 endpoint allowlist 的新 key 期望尚未同步外,其餘 62 條既有測試全通過;該 allowlist 後續已只新增票面要求的兩個 key/assertion。

## Hard Facts 不符實測

唯一發現:票面驗收 4 對 OTC 第一張表的缺欄描述不符官方 `otc/114/Q2` 回應。一般業 30 欄 header、SII/OTC 表順序、四個絕對數與 HF5 六組三率均吻合。

## Working tree

`git status --short`(包含本報告):

```text
 M AGENTS.md
 M README.md
 M scripts/build-derived.mjs
 M scripts/endpoints.mjs
 M scripts/lib/derived.mjs
 M tests/backfill.test.mjs
 M tests/run.test.mjs
?? REPORT-070.md
?? REPORT-189.md
?? REPORT-192.md
?? REPORT-194.md
?? REPORT-195.md
?? scripts/backfill-quarterly.mjs
?? tests/fixtures/mops-quarterly-2025.mjs
?? tests/quarterly-backfill.test.mjs
```

`git diff --stat`(Git 不列未追蹤新檔):

```text
AGENTS.md                 |   5 +-
README.md                 |  27 ++++++-
scripts/build-derived.mjs |  46 +++++++++++-
scripts/endpoints.mjs     |  10 +++
scripts/lib/derived.mjs   | 180 +++++++++++++++++++++++++++++++++++++++++++++-
tests/backfill.test.mjs   |  12 ++++
tests/run.test.mjs        |   2 +
7 files changed, 271 insertions(+), 11 deletions(-)
```

## r2

### r2 結論

- 狀態: **READY_FOR_REVIEW**;r2 結論取代上方 r1 的 BLOCKED 結論。
- r2 修正輪:2 輪。第 1 輪完成 production/test 共用必要欄位 mapping;第 2 輪在全套指令只發現 63 條後,補上 `tests/all.mjs` 對新測試的匯入。未達 3 輪停止線。
- 測試數:修改前 `63 pass / 0 fail`;最終 `75 pass / 0 fail`。
- 未 commit;未修改 WFNT_app;未在 repo 根目錄執行 `build-derived`;未對真 `data/` 寫檔;所有新 raw/derived 驗收寫入均在 `/tmp/ticket-195-r2-e2e.hFqGNV`。

### r2-0 驗收 4 欄位集合更正 — PASS

以 fixture 第一個 `公司代號` header 和 production `MOPS_QUARTERLY_FIELDS` 實跑:

```text
sii first header columns=22
  missing(4)=["營業收入","營業毛利（毛損）","營業利益（損失）","本期淨利（淨損）"]
  present(0)=[]
otc first header columns=22
  missing(3)=["營業收入","營業毛利（毛損）","營業利益（損失）"]
  present(1)=["本期淨利（淨損）"]
```

結果與 r2-0 兩組權威值逐字相同,fixture 無需調整。

### r2-1 測試 helper 依賴 production 定義 — PASS

Production 必要欄位只定義一次,parser 的一般業判別與索引 mapping 都使用它:

```js
export const MOPS_QUARTERLY_FIELDS = {
  id: '公司代號',
  name: '公司名稱',
  revenue: '營業收入',
  grossProfit: '營業毛利（毛損）',
  operatingIncome: '營業利益（損失）',
  netIncome: '本期淨利（淨損）',
};

if (!cells.includes(MOPS_QUARTERLY_FIELDS.grossProfit)) continue;
indexes = requiredFieldIndexes(header, MOPS_QUARTERLY_FIELDS, 'MOPS quarterly financials');
```

`firstHeaderMissing` 不再寫欄名原文:

```js
const required = [
  MOPS_QUARTERLY_FIELDS.revenue,
  MOPS_QUARTERLY_FIELDS.grossProfit,
  MOPS_QUARTERLY_FIELDS.operatingIncome,
  MOPS_QUARTERLY_FIELDS.netIncome,
];
return required.filter((field) => !first.includes(field));
```

暫時把 production `operatingIncome` 從 `營業利益（損失）` 改為同樣存在於一般業表的 `營業成本`,不改測試 helper 或 assertion,目標測試仍通過:

```text
23:  operatingIncome: '營業成本',
ok 1 - taking the first 公司代號 header fails in both markets while production selection succeeds
1..1
# tests 1
# pass 1
# fail 0
```

示範後已恢復 `operatingIncome: '營業利益（損失）'`,再跑目標測試仍 `1 pass / 0 fail`,且最終全套綠燈。

### r2-2 隔離串接持久目錄證據 — PASS

使用固化 fixture 與 injected fetch 在 `/tmp/ticket-195-r2-e2e.hFqGNV` 執行 `runQuarterlyBackfill` → `applyQuarterlyFinancials`,全程無網路:

```text
backfill={"seasons":1,"requests":2,"skipped":0,"rawWritten":2,"rows":3}
apply={"fundamentals":3}
1240 quarterly={"cols":["q","gm","om","nm"],"rows":[[20251,14.95,5.78,7.4]]}
2330 quarterly={"cols":["q","gm","om","nm"],"rows":[[20251,58.79,48.51,42.98]]}
```

`find /tmp/ticket-195-r2-e2e.hFqGNV -print` 完整輸出:

```text
/tmp/ticket-195-r2-e2e.hFqGNV
/tmp/ticket-195-r2-e2e.hFqGNV/data
/tmp/ticket-195-r2-e2e.hFqGNV/data/derived
/tmp/ticket-195-r2-e2e.hFqGNV/data/derived/fundamentals
/tmp/ticket-195-r2-e2e.hFqGNV/data/derived/fundamentals/11
/tmp/ticket-195-r2-e2e.hFqGNV/data/derived/fundamentals/11/1101.json
/tmp/ticket-195-r2-e2e.hFqGNV/data/derived/fundamentals/23
/tmp/ticket-195-r2-e2e.hFqGNV/data/derived/fundamentals/23/2330.json
/tmp/ticket-195-r2-e2e.hFqGNV/data/derived/fundamentals/12
/tmp/ticket-195-r2-e2e.hFqGNV/data/derived/fundamentals/12/1240.json
/tmp/ticket-195-r2-e2e.hFqGNV/data/raw
/tmp/ticket-195-r2-e2e.hFqGNV/data/raw/tpex
/tmp/ticket-195-r2-e2e.hFqGNV/data/raw/tpex/quarterly_fin_hist
/tmp/ticket-195-r2-e2e.hFqGNV/data/raw/tpex/quarterly_fin_hist/2025
/tmp/ticket-195-r2-e2e.hFqGNV/data/raw/tpex/quarterly_fin_hist/2025/2025-Q1.html
/tmp/ticket-195-r2-e2e.hFqGNV/data/raw/twse
/tmp/ticket-195-r2-e2e.hFqGNV/data/raw/twse/quarterly_fin_hist
/tmp/ticket-195-r2-e2e.hFqGNV/data/raw/twse/quarterly_fin_hist/2025
/tmp/ticket-195-r2-e2e.hFqGNV/data/raw/twse/quarterly_fin_hist/2025/2025-Q1.html
```

### r2-3 全套綠燈 — PASS

`tests/package.json` 的目錄入口是 `tests/all.mjs`;r2 已加入 `import './quarterly-backfill.test.mjs'`,所以下列 raw proxy 實際執行的就是票面指定的 `node --test tests/`,且包含季度測試 12 條。最終完整尾段:

```text
# Subtest: monthly revenue resolves same id and month collision in favor of twse rows
ok 74 - monthly revenue resolves same id and month collision in favor of twse rows
  ---
  duration_ms: 6.292502
  ...
# Subtest: monthly revenue warns and deterministically drops rows outside the raw month key
ok 75 - monthly revenue warns and deterministically drops rows outside the raw month key
  ---
  duration_ms: 4.830544
  ...
1..75
# tests 75
# suites 0
# pass 75
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2574.310761
```

### r1 驗收 1~10 最終狀態

1. **PASS** — r2 實跑完整 `node --test tests/`: `75 pass / 0 fail`,大於 63。
2. **PASS** — 引用上方 r1 「驗收 2」實跑證據;2330/1101 Q1/Q2 六組單季三率逐值等於 HF5。
3. **PASS** — 引用上方 r1 「驗收 3」;Q2 累計負向值與差分後單季值兩組並陳且不同。
4. **PASS** — r2-0 實跑集合為 SII 缺 4、OTC 缺 3;正式判別式下目標測試通過。暫時移除 `cells.includes(MOPS_QUARTERLY_FIELDS.grossProfit)` 、改成取第一張表時,測試真實轉紅:

   ```text
   not ok 1 - taking the first 公司代號 header fails in both markets while production selection succeeds
   error: 'MOPS quarterly financials: missing field 營業收入'
   1..1
   # tests 1
   # pass 0
   # fail 1
   exit=1
   ```

   示範後已恢復判別式。
5. **PASS** — 引用上方 r1 「驗收 5」;全表同步插欄後 header 定位仍得 `839253664`/`493395076`,硬寫 `[2]` 得 `999`。
6. **PASS** — 引用上方 r1 「驗收 6」;valuation/revenue 皆空而只有 quarterly 的檔案經 reconcile 後仍存在,季度列完整。
7. **PASS** — 引用上方 r1 「驗收 7」;只有 Q2 raw 而無 Q1 時無 quarterly 檔或 null 列。
8. **PASS** — 引用上方 r1 「驗收 8」;`--from 2025-Q2` 在 fetch 前以非 0 exit 拒絕。
9. **PASS** — r2-2 補跑的隔離串接產生兩份 raw 與 1101/1240/2330 三份 derived fundamentals;完整 `find` 與 1240/2330 JSON 片段見上。
10. **PASS** — 真 `data/` 零變動,scope 正確。對 r1 開工時戳執行:

   ```text
   find data -type f -newer /var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/ticket-195-start.XXXXXX.AaCYFIAz -print
   (no output)
   exit=0
   ```

### 既有能力移除與位元級相容性

結論: **沒有移除任何既有能力、測試、序列欄位或輸出行為**。

- 檔案刪除檢查:`git diff --diff-filter=D --name-only` 輸出為空。
- 測試 gate 比對:原 63 條全數仍在最終 75 條中通過;未刪測試、未 skip、未放寬 assertion。`tests/all.mjs` 只新增季度測試 import。
- 端點/排程比對:日更 `ENDPOINTS` 與 `scripts/run.mjs` 未動;季度只新增至 `BACKFILL_ENDPOINTS` 與手動/全量 derived 路徑。
- valuation/revenue 位元級驗證:`full build discovers quarters while incremental quarterly preserves old sequence bytes and updated` 先對既有 `{valuation,revenue}` 做 `JSON.stringify`,執行 `applyQuarterlyFinancials`,再對同一序列化字串做 strict equality;結果逐 byte 相同,`updated` 仍是 `2026-07-01`。該測試在最終全套為 `ok 51`。
- reconcile 只將刪檔條件從「valuation/revenue 皆空」擴成「三序列皆空」;不改 valuation/revenue 列的 cols、排序、window 或 `updated` 語意。

### r2 最終 working tree

本票改動檔案:

```text
AGENTS.md
README.md
REPORT-195.md
scripts/backfill-quarterly.mjs
scripts/build-derived.mjs
scripts/endpoints.mjs
scripts/lib/derived.mjs
tests/all.mjs
tests/backfill.test.mjs
tests/fixtures/mops-quarterly-2025.mjs
tests/quarterly-backfill.test.mjs
tests/run.test.mjs
```

`git status --short`:

```text
 M AGENTS.md
 M README.md
 M scripts/build-derived.mjs
 M scripts/endpoints.mjs
 M scripts/lib/derived.mjs
 M tests/all.mjs
 M tests/backfill.test.mjs
 M tests/run.test.mjs
?? REPORT-070.md
?? REPORT-189.md
?? REPORT-192.md
?? REPORT-194.md
?? REPORT-195.md
?? scripts/backfill-quarterly.mjs
?? tests/fixtures/mops-quarterly-2025.mjs
?? tests/quarterly-backfill.test.mjs
```

`REPORT-070.md` / `REPORT-189.md` / `REPORT-192.md` / `REPORT-194.md` 是票面 HF10 指定的既有未追蹤雜訊,本票未修改。

`git diff --stat`(Git 不列未追蹤新檔):

```text
AGENTS.md                 |   5 +-
README.md                 |  27 ++++++-
scripts/build-derived.mjs |  46 +++++++++++-
scripts/endpoints.mjs     |  10 +++
scripts/lib/derived.mjs   | 185 +++++++++++++++++++++++++++++++++++++++++++++-
tests/all.mjs             |   1 +
tests/backfill.test.mjs   |  12 +++
tests/run.test.mjs        |   2 +
8 files changed, 277 insertions(+), 11 deletions(-)
```

`git diff --check` 輸出為空,exit 0。
