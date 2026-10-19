# READY_FOR_REVIEW

TICKET-304 r1 已依 Contract 實作，未觸發 Stop / Escalate。本文只回報實作與證據，不宣告驗收結果。

## 改動位置

- `scripts/lib/date.mjs:24`：`parseRocDate` 的 slash 形式年份由 3 位放寬為 2～3 位；compact 形式仍只接受 7 位 `YYYMMDD`。
- `scripts/lib/derived.mjs:1215-1218`：`parseTwseCorporateActionDate` 的 `YY年MM月DD日` 年份由 3 位放寬為 2～3 位。
- `tests/date.test.mjs:11-20`：新增 2 位民國年、非法日期、`parseTradingDate` 與 compact 不擴張的測試。
- `tests/ex-right-roc-short-year.test.mjs:1-67`：新增暫存 root 整合測試；同一 fixture root 同時含上市 `95年01月10日`／`100年01月05日` 與上櫃 `99/01/14`／`100/01/05`，並透過 `applyCorporateActions` 驗證 ISO 日期輸出。
- `tests/all.mjs:24`：只新增上述測試模組的 import。

## 完整測試摘要

在 worktree `/Users/zhengweizhu/Projects/wfnt-snapshot-data-t304` 執行：

```text
$ node --test tests/
1..311
# tests 314
# suites 0
# pass 314
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 13143.802005
```

所有測試 fixture 與 derived 輸出都位於系統暫存 root；未在 worktree 的 `data` symlink 所指向的真實資料目錄執行腳本。

## 消融證據

### 只還原上市解析點

暫時把 `scripts/lib/derived.mjs` 的 `parseTwseCorporateActionDate` 年份 regex 還原為 `\d{3}`，保留 `parseRocDate` 修正，再執行：

```text
$ node --test tests/ex-right-roc-short-year.test.mjs
# tests 2
# pass 1
# fail 1
```

轉紅的測試：

```text
TWSE corporate actions include two-digit ROC years and retain three-digit years
```

失敗差異顯示 `2006-01-10` 事件消失；TPEX 測試仍綠。恢復上市修正後，同一命令為 2／2 綠。

### 只還原上櫃 slash 解析點

暫時把 `scripts/lib/date.mjs` 的 slash 年份 regex 還原為 `\d{3}`，保留上市 regex 修正，再執行：

```text
$ node --test --test-name-pattern=TPEX tests/ex-right-roc-short-year.test.mjs
# tests 1
# pass 0
# fail 1
```

轉紅的測試：

```text
TPEX corporate actions include two-digit ROC years and retain three-digit years
```

失敗差異顯示 `2010-01-14` 事件消失。恢復 slash 修正後，完整新測試檔為 2／2 綠。

## 邊界確認

- 未連網。
- 未修改或 stage `data` symlink／任何生成資料。
- 未修改既有測試斷言；`tests/date.test.mjs` 只新增測試，`tests/all.mjs` 只新增 import。
- 未修改 Scope 外檔案、未操作主目錄分支、未 rebase、未 merge。
