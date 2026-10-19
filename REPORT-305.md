READY_FOR_REVIEW

# TICKET-305 r1 Executor Report

## 改動位置

- `scripts/lib/derived.mjs:17`：將 `MACRO_START_DATE` 從 `20210101` 改為 `20061016`。
- `tests/fred.test.mjs:31,95-119,140`：把既有下限前 fixture／斷言改為 `2006-10-13`，並新增手寫期望值的精確邊界測試；測試同時固定 `2006-10-15` 排除、`2006-10-16` 與 `2006-10-17` 納入。
- `README.md:374`：將 FRED derived 日期下限更新為 `20061016`。

以真實 FRED raw 的唯讀副本在暫存 root 執行 `applyMacroSeries`，未寫入真實 `data/`：

```text
DTWEXBGS 20061016 5003
DEXTAUS  20061016 5004
T10Y2Y   20061016 5005
VIXCLS   20061016 5064
```

## 完整測試

在 worktree 執行：

```text
node --test tests/
```

完整摘要：

```text
1..308
# tests 311
# suites 0
# pass 311
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11584.585424
```

## 消融證據

兩組消融皆執行 `node --test tests/fred.test.mjs`，每組只暫改 `MACRO_START_DATE`，完成後均還原為 `20061016`。

### `MACRO_START_DATE = 20061015`

```text
not ok 2 - macro derivation includes exactly the 2006-10-16 date floor
# tests 5
# pass 4
# fail 1
```

失敗原因：結果額外納入手寫 fixture `[20061015, 15]`。還原 `20061016` 後重跑：5 tests / 5 pass / 0 fail。

### `MACRO_START_DATE = 20061017`

```text
not ok 2 - macro derivation includes exactly the 2006-10-16 date floor
# tests 5
# pass 4
# fail 1
```

失敗原因：結果缺少手寫期望值 `[20061016, 16]`。還原 `20061016` 後重跑：5 tests / 5 pass / 0 fail。

## 執行邊界

- 未連網。
- 未在真實 `data/` 執行腳本或寫入資料；`data` symlink 未加入 commit。
- 未操作主目錄分支、未 rebase、未執行 `launchctl`，亦未寫入 `~/Library/**` 或 `~/bin/**`。
