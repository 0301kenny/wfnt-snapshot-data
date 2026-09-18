# TICKET-226 執行報告

執行日期：2026-09-18  
執行 repo：`/Users/zhengweizhu/Projects/wfnt-snapshot-data`  
執行分支：`ticket-226`

## 結果摘要

- 實作完成：`market.twse.index` 現在由日更 `twse/mi_index` 優先、`twse/mi_index_hist` fallback。
- 新增扁平日更與歷史價格指數表 parser；歷史 parser 依 `fields` 找欄位，並正確移除千分位逗號。
- `parseTwseMiIndexHist` 與 `requiredLegacyTable` 的既有語意未變。
- A1、A2、A4、A5 通過。
- A3 依票面指定日期無法通過：磁碟上 `2026-09-07`、`2026-09-08` 的日更 raw 均不存在。實際兩個重疊日是 `2026-08-14`、`2026-08-17`，兩來源值皆一致。未修改驗收條件來宣告 A3 通過。

## A1 既有測試不得退步：PASS

命令：

```text
node --test tests/
```

實跑輸出：

```text
1..109
# tests 109
# suites 0
# pass 109
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7892.710546
```

基線 105 個測試全部保留通過，另新增 4 個測試。

## A2 新 parser 對兩種形狀都正確：PASS

命令：

```text
node --test tests/twse-weighted-index.test.mjs
```

相關實跑輸出：

```text
# Subtest: TWSE weighted index parsers handle daily and reordered historical shapes
ok 1 - TWSE weighted index parsers handle daily and reordered historical shapes
# daily=46940.49; historicalReordered=17789.25
```

此 fixture 同時驗證：

- 扁平陣列可抽出 `發行量加權股價指數`。
- 歷史 `tables` 形狀的 `"17,789.25"` 轉為 `17789.25`。
- 歷史 fixture 將 `fields` 改成 `漲跌點數, 收盤指數, 指數, 漲跌(+/-)`，仍取得正確數值。

## A3 兩來源重疊日期的值一致：原條件未達

以唯讀 Node 檢查票面指定的 `2026-09-07`、`2026-09-08`，命令 exit code 為 1。實跑輸出：

```text
2026-09-07 daily=MISSING hist=present
2026-09-08 daily=MISSING hist=present
actual overlap count=2 dates=2026-08-14,2026-08-17
  2026-08-14 daily=45811.01 hist=45811.01 equal=true
  2026-08-17 daily=45857.27 hist=45857.27 equal=true
```

磁碟上 `twse/mi_index` 的 14 個日期為：

```text
2026-07-03, 2026-07-06, 2026-07-07, 2026-07-08, 2026-07-09,
2026-07-13, 2026-07-14, 2026-07-15, 2026-07-16, 2026-07-17,
2026-08-14, 2026-08-17, 2026-09-09, 2026-09-10
```

因此票面所稱 `2026-09-07`、`2026-09-08`「兩來源皆有」與目前磁碟內容不符；未以 fixture 假造這兩個日更 raw，也未把真正重疊日替代成原 A3 的 PASS。

## A4 合併後的日期集合：PASS

命令：

```text
node --test tests/twse-weighted-index.test.mjs
```

相關實跑輸出：

```text
# Subtest: merged TWSE weighted index raw dates match the margin date oracle
ok 3 - merged TWSE weighted index raw dates match the margin date oracle
# merged rows=1253
# only in index=0; only in margin=0
# 20210719=17789.25
```

驗證以唯讀方式掃描真實 raw；未寫入 `data/**`。

## A5 冪等：PASS

命令：

```text
node --test tests/twse-weighted-index.test.mjs
```

相關實跑輸出：

```text
# Subtest: applyDailyDate uses daily weighted index before historical fallback and is idempotent
ok 4 - applyDailyDate uses daily weighted index before historical fallback and is idempotent
# historicalFallback=17789.25; dailyPriority=20000.5
# secondRunByteIdentical=true
```

此項在隔離 tmpdir 內執行；同時驗證只有歷史 raw 時可 fallback、兩來源同時存在時日更值優先，以及同一天第二次執行沒有 byte 差異。

## 限制遵循

- 未使用網路。
- 未執行 `node scripts/build-derived.mjs`，也未對真實 `data/derived/` 做全量重建。完整測試內既有的 rebuild 測試只操作測試 tmpdir。
- 未手動編輯任何 `data/**`。
- 未建立分支、未切換 main、未 commit。
