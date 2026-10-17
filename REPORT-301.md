READY_FOR_REVIEW

# TICKET-301 r1 Executor Report

## 1. Definition locations

- Full-table parser and six-kind header classification: `scripts/lib/derived.mjs:239-307` (`parseMopsQuarterlyFinTables` starts at line 255).
- Financial single-quarter net margin and general-industry-compatible quarterly update: `scripts/lib/derived.mjs:2144-2256` (`applyQuarterlyFinancials`; margin rows are built at lines 2242-2249).
- All-industry single-quarter EPS differencing, 24-quarter upsert, sorting, `updated`, and write-on-change serialization: `scripts/lib/derived.mjs:2191-2200,2258-2281`; columns are declared at line 64.
- Write-on-change merge that replaces only quarterly derived content: `scripts/lib/derived.mjs:1556-1586`.
- Offline rebuild CLI, ascending two-market season union, isolated scratch derivation, and `--out`: `scripts/rebuild-quarterly.mjs:7-76` (`rebuildQuarterly` starts at line 40).

## 2. Full test suite

Command run in `/Users/zhengweizhu/Projects/wfnt-snapshot-data-t301`:

```text
node --test tests/
```

Final summary:

```text
1..278
# tests 278
# suites 0
# pass 278
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The original 265 tests were not edited. `tests/all.mjs` only imports the new test module.

## 3. Ablation evidence

Each ablation was applied temporarily to `scripts/lib/derived.mjs`, tested against `tests/quarterly-financial-eps.test.mjs`, then reverted.

1. Bank revenue changed from `利息淨收益 + 利息以外淨損益` to only `利息淨收益`.
   - Red: 2 tests / 0 pass / 2 fail.
   - Parser expected `100`, actual `80`; bank net margins expected `10` and `13.64`, actual `12.5` and `16.67`.
   - After restore: 2 tests / 2 pass / 0 fail.
2. EPS Q2 changed from cumulative differencing to using the cumulative value directly.
   - Red: 1 test / 0 pass / 1 fail.
   - 2330 2025-Q2 expected `3`, actual `5`.
   - After restore: 1 test / 1 pass / 0 fail.
3. The financial `singleQuarterRevenue <= 0` guard was disabled while retaining the general-industry guard.
   - Red: 1 test / 0 pass / 1 fail.
   - 2890 incorrectly gained `[20252,null,null,-10]`.
   - After restore: 1 test / 1 pass / 0 fail.

The final full-suite green result after all restores is the summary in section 2.

## 4. Isolated real-raw rehearsal

Only these four real raw files were read and copied into a temporary root; all derived writes stayed under `/tmp/wfnt-t301-evidence.AuqLIG`:

```text
data/raw/{twse,tpex}/quarterly_fin_hist/2026/2026-Q1.html
data/raw/{twse,tpex}/quarterly_fin_hist/2026/2026-Q2.html
```

Command:

```text
node scripts/rebuild-quarterly.mjs --out /tmp/wfnt-t301-evidence.AuqLIG
```

Stdout:

```text
quarterly: seasons=2 fundamentals=3905 eps=3911
```

2026-Q2 derived observations:

```json
{"id":"2882","quarterly":[],"eps":[]}
{"id":"2330","quarterly":[[20262,67.72,60.34,55.64]],"eps":[[20262,27.25]]}
```

Thus 2330 has 2026-Q2 net margin `55.64` and single-quarter EPS `27.25`. The supplied 2026-Q2 TWSE raw has no 2882 company row (while Q1 does), so the specified previous/current-row rule produces no 2882 Q2 margin or EPS entry; the empty arrays above are the observed output rather than a parser or runner failure.

## 修正輪（accepted findings）

### 修正內容

- Finding 1：全表 parser 的 EPS 欄位依序採用 `基本每股盈餘（元）`、`基本每股盈餘`；兩欄皆不存在時為 `null`。新增保險新格式 Q1 直接值、Q2 累計差分與無 EPS 欄位測試。
- Finding 2：全表 parser 的所有 kind 恢復與 base 相同的 `/^\d{4}$/` 公司代號限制。新增一般業 `ABCD`、`12345` 均跳過並與 `parseMopsQuarterlyFinHtml` 輸出代號一致的測試。

### 完整測試摘要

```text
node --test tests/
1..281
# tests 281
# suites 0
# pass 281
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 13136.843507
```

### 修正輪消融

1. 暫時改回只認 `基本每股盈餘（元）`。
   - Red：1 test / 0 pass / 1 fail。
   - 保險新格式 2851 預期 `[[20251,0.4],[20252,0.5]]`，實際為 `undefined`。
   - 還原別名 fallback 後：1 test / 1 pass / 0 fail。
2. 暫時恢復 `/^[A-Za-z0-9]+$/` 英數代號。
   - Red：1 test / 0 pass / 1 fail。
   - 預期只有 `2330`，實際額外接受 `ABCD`、`12345`。
   - 還原 `/^\d{4}$/` 後：1 test / 1 pass / 0 fail。

### 修正輪 Required Evidence 4

只讀真實 Q1/Q2 raw 並複製到 `/tmp/wfnt-t301-fix-evidence.lIkMP7`，所有 derived 寫入均留在該暫存 root。

```text
node scripts/rebuild-quarterly.mjs --out /tmp/wfnt-t301-fix-evidence.lIkMP7
quarterly: seasons=2 fundamentals=3905 eps=3922
```

保險業 2026-Q2 單季 EPS：

```json
{"id":"2816","eps":[[20262,6.06]]}
{"id":"2850","eps":[[20262,4.52]]}
```
