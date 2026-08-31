# REPORT-198

## 結論

- 狀態: **READY_FOR_REVIEW**。
- 完成/未完成: 票面 Scope 1～10 與驗收 1～10 全部完成；未觸發 Stop/Escalate，未 commit。
- 分支/HEAD: `ticket-198` / `4c62eb68d0b94dd301163ed4a30a03b241240436`。
- 測試數: 修改前 `81 tests / 80 pass / 1 fail`；修改後 `90 tests / 90 pass / 0 fail`。沒有刪除、skip、放寬或吞掉測試錯誤。
- 隔離目錄: base 與位元比對 `/tmp/wfnt-198-byte.hISg68`；B 塊 mutation `/tmp/wfnt-198-mutations.JVn3Li`。
- 真 `data/` 只讀；未在 repo 根目錄或任何位置執行 `build-derived`；未修改 WFNT_app；未碰既有 `REPORT-070.md` / `REPORT-189.md` / `REPORT-192.md` / `REPORT-194.md`。

## 實作摘要

- A: 新增 `scripts/lib/cli.mjs::parseNumericFlag`，四支腳本共用同一數值旗標語意；`detect-gaps`、monthly、quarterly 各新增 exported options builder，四份既有 `parseArgs` 本體與錯誤訊息未改。
- B: `BACKFILL_ENDPOINTS` 12 筆全數宣告 `daily` / `monthly` / `quarterly`；原本以 `_hist` 後綴猜日頻的測試拆為 cadence 合法性、raw namespace 登記、daily coverage 等式三條獨立斷言。
- C: `FUNDAMENTAL_SERIES` 集中 valuation / revenue / quarterly 的 key、cols、window、`fundamentalsUpdated` 參與資格及 metadata 覆寫權；upsert/reconcile 改為 registry 迭代，未知 kind 立即 throw，全 registry 皆空才刪檔。
- 文件: `AGENTS.md` 與 `README.md` 同步 cadence、CLI 共用模組與 fundamentals registry 規則。
- 測試 helper: 將 `tests/backfill.test.mjs` 原有 `fileMap` / `writeDerived` 原樣抽到 `tests/derived-test-helpers.mjs`，既有測試及驗收 8 共用同一實作。

## 驗收結果

### 1. `node --test tests/` 全綠且測試數 > 81 — PASS

修改前實跑尾段：

```text
1..81
# tests 81
# suites 0
# pass 80
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3042.161768
```

唯一失敗是票面 HF4：`coverage sources match every daily raw namespace on disk` 將 `twse/quarterly_fin_hist` 誤認為 daily。

最終完整尾段：

```text
ok 90 - monthly revenue warns and deterministically drops rows outside the raw month key
  ---
  duration_ms: 8.952005
  ...
1..90
# tests 90
# suites 0
# pass 90
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3561.927039
```

### 2. A 塊四處裸旗標皆在 fetch 前拒絕 — PASS

全部透過 options builder，run 函式均注入假 `fetchImpl` / `sleepImpl`；實際訊息與 fetch 次數：

```text
[ticket-198 bare monthly delay] message="--delay-ms must be a non-negative number, got: NaN" fetchCalls=0
[ticket-198 bare daily delay] message="--delay-ms must be a non-negative number, got: NaN" fetchCalls=0
[ticket-198 bare daily window] message="--window must be a positive integer, got: NaN" fetchCalls=0
[ticket-198 bare gaps delay] message="--delay-ms must be a non-negative number, got: NaN" fetchCalls=0
```

四條測試皆 pass；沒有腳本在驗證前呼叫 fetch。

### 3. A 塊合法字串正向對照 — PASS

各 run path 在 `<tmpdir>` 完成且假 fetch 為 0 次：

```text
[ticket-198 legal monthly delay] delayMs=0 run=fulfilled
[ticket-198 legal daily delay] delayMs=0 run=fulfilled
[ticket-198 legal daily window] symbolWindow=500 run=fulfilled
[ticket-198 legal gaps delay] delayMs=0 run=fulfilled
```

monthly 以已存在 raw checkpoint 完成，daily backfill 以隔離 checkpoint 完成，gap detector 以隔離 raw coverage 完成；沒有真實網路。

### 4. A 塊 base pre-state — PASS

在 `/tmp/wfnt-198-byte.hISg68/base-code` checkout `4c62eb68d0b94dd301163ed4a30a03b241240436`，只補可注入 builder seam、不套修正；所有 fetch 為假實作。四處在 base 都未被數值 guard 拒絕，而是進入請求流程：

```text
[base bare monthly delay] delayMs=1 validationThrow=false fetchCalls=4 sleep=[1,1,1,1]
[base bare daily delay] delayMs=1 validationThrow=false fetchCalls=4 sleep=[2,4,8,1] terminal="2026-07-06 twse/mi_index_hist: PROBE_NO_NETWORK"
[base bare daily window] symbolWindow=1 validationThrow=false fetchCalls=1 sleep=[3000] terminal="2026-07-06 twse/mi_index_hist: PROBE_NO_NETWORK"
[base bare gaps delay] delayMs=1 validationThrow=false fetchCalls=1 sleep=[1]
```

與驗收 2 修後 `NaN` / `fetchCalls=0` 並陳，HF2/HF3 的 pre-state 判定成立。

### 5. B 塊三條斷言的獨立負向對照 — PASS

三次 mutation 都在 `/tmp/wfnt-198-mutations.JVn3Li` 的獨立 clone，工作 repo 與真 `data/` 未變。

(a) 移除 `twse_monthly_revenue_hist.cadence`：

```text
not ok 1 - every backfill endpoint declares a supported cadence
error: |-
  twse_monthly_revenue_hist has invalid cadence: undefined
  false !== true
1..1
# tests 1
# pass 0
# fail 1
```

(b) 在 temp clone 建立 `data/raw/twse/unregistered_hist/`：

```text
not ok 1 - every raw historical namespace on disk is registered as a backfill endpoint
error: |-
  unregistered raw historical namespaces: twse/unregistered_hist
  + [
  +   'twse/unregistered_hist'
  + ]
  - []
1..1
# tests 1
# pass 0
# fail 1
```

(c) 將 `twse_quarterly_fin_hist.cadence` 由 `quarterly` 改為 `daily`：

```text
not ok 1 - coverage sources exactly match daily backfill endpoints plus each market close source
error: |-
  twse coverage sources drifted from data/raw namespaces
  -   'twse/quarterly_fin_hist',
1..1
# tests 1
# pass 0
# fail 1
```

正向差集亦精確符合 HF5：

```text
daily=["tpex/daily_quotes_hist","tpex/insti_hist","tpex/margin_hist","tpex/pe_hist","twse/bwibbu_hist","twse/mi_index_hist","twse/mi_margn_hist","twse/t86_hist"]
coverage_minus_backfill=["tpex/mainboard_close","twse/stock_day_all"]
backfill_minus_coverage=["tpex/monthly_revenue_hist","tpex/quarterly_fin_hist","twse/monthly_revenue_hist","twse/quarterly_fin_hist"]
daily_count=8
```

### 6. B 塊不再以字串後綴推導 daily — PASS

改寫後完整 helper 與三條斷言原文：

```js
const closeSource = {
  twse: 'twse/stock_day_all',
  tpex: 'tpex/mainboard_close',
};

async function rawHistNamespaces(rootDir = repoRoot) {
  const namespaces = [];
  for (const market of ['twse', 'tpex']) {
    const entries = await readdir(join(rootDir, 'data', 'raw', market), { withFileTypes: true });
    namespaces.push(...entries
      .filter((entry) => entry.isDirectory() && /_hist$/.test(entry.name))
      .map((entry) => `${market}/${entry.name}`));
  }
  return namespaces.sort();
}

test('every backfill endpoint declares a supported cadence', () => {
  const allowed = new Set(['daily', 'monthly', 'quarterly']);
  for (const [key, endpoint] of Object.entries(BACKFILL_ENDPOINTS)) {
    assert.equal(allowed.has(endpoint.cadence), true, `${key} has invalid cadence: ${endpoint.cadence}`);
  }
});

test('every raw historical namespace on disk is registered as a backfill endpoint', async () => {
  const registered = new Set(Object.values(BACKFILL_ENDPOINTS).map((endpoint) => endpoint.sourceDataset));
  const unregistered = (await rawHistNamespaces()).filter((source) => !registered.has(source));
  assert.deepEqual(unregistered, [], `unregistered raw historical namespaces: ${unregistered.join(',')}`);
});

test('coverage sources exactly match daily backfill endpoints plus each market close source', () => {
  for (const market of ['twse', 'tpex']) {
    const dailyNamespaces = Object.values(BACKFILL_ENDPOINTS)
      .filter((endpoint) => endpoint.cadence === 'daily' && endpoint.sourceDataset.startsWith(`${market}/`))
      .map((endpoint) => endpoint.sourceDataset);
    dailyNamespaces.push(closeSource[market]);
    assert.deepEqual(
      [...COVERAGE_SOURCES[market]].sort(),
      dailyNamespaces.sort(),
      `${market} coverage sources drifted from data/raw namespaces`,
    );
  }
});
```

`/_hist$/` 只用於驗收 (b) 找出磁碟上的歷史 raw namespace；daily 分類只讀 `endpoint.cadence === 'daily'`。原文沒有 `endsWith('_hist')` 或任何檔名黑名單。

### 7. C 塊 quarterly-only 刪檔保護 — PASS

目標測試建立 valuation/revenue 空、quarterly 有一列的檔，走 valuation reconcile 後仍存在；再移除最後 revenue 列後仍存在：

```text
[r4-5 quarterly-only-protection] file=present valuation=[] revenue=[] quarterly=[[20251,58.79,48.51,42.98]]
ok 1 - reconcile preserves quarterly-only files and quarterly surviving removal of the last old row
```

檔案存在由測試中的 `await access(path)` 兩次驗證，quarterly 內容以 `assert.deepEqual` 完整比對。

### 8. C 塊 base/current 逐位元相同 — PASS

base/current 各用相同隔離輸入，驅動只走 exported apply 函式；整個 `data/derived` 由原 `tests/backfill.test.mjs` 的 `fileMap` helper 比對。三案輸出：

```text
[ticket-198 bytes valuation-revenue] files=2 base=2c7892a9367a224147c694798941f0173bbd9eec51befb313d6a2bbec31d4068 current=2c7892a9367a224147c694798941f0173bbd9eec51befb313d6a2bbec31d4068 equal=true
[ticket-198 bytes quarterly-only] files=2 base=c7fd0c84b2f6a3ae0ee602b2e49e525aaca6f81a17dcf621c45250afa9844039 current=c7fd0c84b2f6a3ae0ee602b2e49e525aaca6f81a17dcf621c45250afa9844039 equal=true
[ticket-198 bytes valuation-metadata] files=2 base=7317923c465c4b0dbcba9c449036c444c18cccf63e7954b9bc844b8d0c9b69b0 current=7317923c465c4b0dbcba9c449036c444c18cccf63e7954b9bc844b8d0c9b69b0 equal=true
[ticket-198 metadata] market=twse name=台積電 valuationRows=[[20260706,25.1,5.2,1.8]]
```

三案依序涵蓋 valuation + revenue 同檔、quarterly-only、以及先由既有 `writeDerived` 寫 `market: 'tpex'` 再套 TWSE valuation 的 metadata 特例。`assert.deepEqual(currentMap, baseMap)` 全部通過，沒有任何位元差異。

### 9. C 塊未知 kind 必須 throw — PASS

```text
[ticket-198 unknown-kind] Error: unknown fundamental kind: unregistered
ok 2 - reconcile rejects an unregistered fundamental kind
```

測試以 `assert.rejects` 驗證，且 registry lookup 在掃描檔案前執行，不會因空目錄而靜默成功或 fallback 到 quarterly。

### 10. 真 `data/` 零變動與 scope — PASS

開工時戳：`/tmp/ticket-198-start.1KlTei`。

```text
$ find data -type f -newer /tmp/ticket-198-start.1KlTei -print | head
<no output>

$ git status --short -- data
<no output>

$ git diff --check
<no output>
```

`git status --short` 與 `git diff --stat` 見「收工 git 證據」。除四份既有歷史 report 外，所有變更皆為票面 Scope 的程式、測試、文件與 `REPORT-198.md`。

## A / B / C 獨立結論

- A 塊: **PASS**。共用 parser、三個新 builder、既有 backfill builder 收斂完成；四個票面缺陷均有 base/pre-state、修後負向與合法正向證據；quarterly 既有 API 層 `typeof delayMs !== 'number'` guard 保留。
- B 塊: **PASS**。12/12 cadence 合法，8 daily + 2 close 與 `COVERAGE_SOURCES` 精確相等；三條斷言各有獨立 mutation 紅燈證據。
- C 塊: **PASS**。registry 涵蓋三序列必要屬性，未知 kind throw、全序列空才刪、`fundamentalsUpdated` 只含 valuation/revenue；三案 base/current 逐位元相同。

## Hard Facts 實測發現

- 無不符。修改前完整重現 `81 tests / 80 pass / 1 fail`，唯一 fail 與 HF4 相同。
- A 塊搜尋全集仍只有票面四個待收斂位置加上 quarterly 已修位置；收工 `grep`/`rg` 已無 `Number(args[...])` / `Number(args....)` 命中，未發現第五處。
- HF5 的 daily 8 筆、兩個 close 差集、四個非日頻差集均與票面逐字一致，未修改 `COVERAGE_SOURCES` 成員。
- HF7 兩條語意、HF9 真 `data/` 紅線、HF10 無 CI 測試、HF11 四份既有未追蹤 report 均與票面一致。

## 被移除的既有能力

結論: **完全沒有移除既有能力**。唯一刻意不再接受的是票面定義的缺陷輸入「裸數值旗標」；這是修正，不是受支援能力。

- 行為: 合法字串旗標、fallback、range/checkpoint、gap scan、monthly/quarterly backfill、daily pipeline、reconcile 及 metadata 優先權保留。四份 `parseArgs` 本體不動，所有 fetch 及 raw 寫入路徑不動。
- 欄位: `ENDPOINTS` 一字未改；`BACKFILL_ENDPOINTS` 只 additive 新增 cadence。Raw schema、manifest schema、symbols/TDCC/fundamentals derived schema、valuation/revenue/quarterly 的 cols 與欄位順序都未移除。
- 輸出: valuation、revenue、quarterly 三種既有序列由三案 `fileMap` 整目錄逐 byte 比對 base/current，三組 SHA-256 各自完全相等。特別驗證 `updated` 仍只看 valuation/revenue，quarterly-only 仍為 `updated: null`，valuation metadata 仍覆寫 TPEX metadata。
- 既有測試斷言: 沒有刪除、skip 或放寬。舊 gap 後綴猜測斷言依票面拆成三條不同語意的更強斷言；quarterly endpoint deep-equality 加入 cadence；原 `fileMap` / `writeDerived` 僅原樣移至共用 helper，使用點與斷言不變。
- 比對方式: 修改前/後完整測試數、`git diff` 人工逐檔核對、`git diff --check`、A base/current 注入測試、B 三個 mutation、C 三案 `assert.deepEqual(fileMap(...))` + SHA-256。

## 收工 git 證據

`git status --short`：

```text
 M AGENTS.md
 M README.md
 M scripts/backfill-monthly.mjs
 M scripts/backfill-quarterly.mjs
 M scripts/backfill.mjs
 M scripts/detect-gaps.mjs
 M scripts/endpoints.mjs
 M scripts/lib/derived.mjs
 M tests/all.mjs
 M tests/backfill.test.mjs
 M tests/gaps.test.mjs
 M tests/quarterly-backfill.test.mjs
?? REPORT-070.md
?? REPORT-189.md
?? REPORT-192.md
?? REPORT-194.md
?? REPORT-198.md
?? scripts/lib/cli.mjs
?? tests/cli-flags.test.mjs
?? tests/derived-test-helpers.mjs
```

前四份 `REPORT-*.md` 是開工前既有雜訊；其餘皆在票面 Scope。`git diff --stat`（Git 不列未追蹤新檔）：

```text
AGENTS.md                         |   3 +
README.md                         |   6 ++
scripts/backfill-monthly.mjs      |  16 ++++--
scripts/backfill-quarterly.mjs    |  20 +++----
scripts/backfill.mjs              |   5 +-
scripts/detect-gaps.mjs           |  27 +++++----
scripts/endpoints.mjs             |  12 ++++
scripts/lib/derived.mjs           | 112 ++++++++++++++++++++++++--------------
tests/all.mjs                     |   1 +
tests/backfill.test.mjs           |  29 ++--------
tests/gaps.test.mjs               |  47 +++++++++++-----
tests/quarterly-backfill.test.mjs |  10 ++++
12 files changed, 179 insertions(+), 109 deletions(-)
```

未追蹤但屬本票的新檔為 `REPORT-198.md`、`scripts/lib/cli.mjs`、`tests/cli-flags.test.mjs`、`tests/derived-test-helpers.mjs`。收工仍未 commit。
