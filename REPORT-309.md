# READY_FOR_REVIEW

TICKET-309 r1 已依 Contract 實作。未觸發 Stop / Escalate 條款；全程未連網、未在真實 `data/` 執行腳本，也未寫入 worktree 的 `data` symlink。

## 1. 改動位置

- `scripts/lib/derived.mjs`
  - `parseTwseT86Hist` 只在欄名逐字等於 T86 舊版 A 或 B 時使用舊版 mapping，並嚴格檢查列寬。
  - `parseTpexInstiHist` 只在 `tables[1].fields` 逐字等於 TPEX 法人舊版時使用舊版 mapping，並嚴格檢查列寬。
- `scripts/backfill.mjs`
  - `parseTwseSblHist` 支援 TWT93U 14 欄舊版，借券賣出今日餘額取第 11 index，保留日期檢查並嚴格檢查列寬。
- `scripts/lib/history-backfill.mjs`
  - 匯出 history runner 共用的 payload 驗證入口與 lock 生命週期；runner 本身改用同一入口。
- `scripts/promote-quarantine.mjs`
  - 新增離線 promotion CLI，限定三個 dataset；支援重複 `--dataset`、`--dry-run` 與 `--out`。
  - 逐檔檢查「有資料列 + runner 同一 parser（含 TWT93U 日期）」，以 exclusive hard-link publish 避免覆寫，寫後重讀 SHA-256。
  - raw 相同略過，不同報衝突且 exit non-zero；隔離檔不刪不改，不寫 derived/progress，不連網，與 runner 共用 `.lock`。
- `tests/legacy-quarantine.test.mjs`
  - 新增逐字真實 fixture、三種舊版 parser 正/負向、列寬、日期、複製/相同/衝突/驗證失敗/dry-run/live lock 測試。
- `tests/history-backfill.test.mjs`
  - 僅將原本已變成可解析的 TWT93U 舊版隔離範例，換成一個仍有資料但欄名漂移的 14 欄形狀；原測試斷言未刪改。
- `tests/all.mjs`、`README.md`、`AGENTS.md`
  - 加入測試 import、CLI 用法與 repo 不可變規則。

全隔離區以共用驗證器唯讀掃描結果：

```text
{"dataset":"twse/t86_hist","files":1390,"valid":1390,"failed":0}
{"dataset":"twse/sbl_hist","files":1348,"valid":1348,"failed":0}
{"dataset":"tpex/insti_hist","files":767,"valid":767,"failed":0}
```

另以三個 parser 掃描全部列的輸出數值欄：

```text
{"dataset":"twse/t86_hist","files":1390,"rows":8666170,"nulls":0}
{"dataset":"twse/sbl_hist","files":1348,"rows":964277,"nulls":0}
{"dataset":"tpex/insti_hist","files":767,"rows":350870,"nulls":0}
```

## 2. 完整測試摘要

在 worktree root 執行 `node --test tests/`：

```text
1..339
# tests 342
# suites 0
# pass 342
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 15849.63567
```

## 3. 消融證據

每組都先做單一暫時變更、執行指定測試得到 exit 1，然後以 patch 還原。

1. 移除 T86 舊版分支（暫時關閉 branch）
   - 紅：`legacy T86 A and B fixtures map institution values exactly`
   - 錯誤：`T86: missing field 外陸資買賣超股數(不含外資自營商)`
2. 移除 TPEX 舊版分支（暫時關閉 branch）
   - 紅：`legacy TPEX institution fixture maps total and three institution values`
   - 錯誤：`TPEX_INSTI: tables[0] is invalid`
3. TWT93U 舊版改取 index 12
   - 紅：`legacy TWT93U fixture selects index 11 and keeps the response-date guard`
   - 實際錯誤值：`768,898,521`；期望：`57,889,000`
4. promotion CLI 改成 raw 已存在不同 bytes 時仍覆寫
   - 紅：`promotion CLI never overwrites conflicting raw and exits non-zero`
   - 實際 exit `0`；期望 exit `1`

四組全數還原後執行：

```text
node --test tests/legacy-quarantine.test.mjs tests/history-backfill.test.mjs
1..27
# tests 27
# pass 27
# fail 0
# duration_ms 1464.372985
```

`git diff --check` 無輸出。

## 4. 暫存 root CLI stdout 原文

暫存 root 各放入一個 Contract 真實樣本，先 dry-run，再實際複製；執行後刪除該暫存 root。

```text
DRY_RUN_STDOUT
[promote-quarantine] dataset=twse/t86_hist copied=1 identical=0 validation_failed=0 conflicts=0 dry_run=true
[promote-quarantine] dataset=twse/sbl_hist copied=1 identical=0 validation_failed=0 conflicts=0 dry_run=true
[promote-quarantine] dataset=tpex/insti_hist copied=1 identical=0 validation_failed=0 conflicts=0 dry_run=true
EXIT=0
COPY_STDOUT
[promote-quarantine] dataset=twse/t86_hist copied=1 identical=0 validation_failed=0 conflicts=0
[promote-quarantine] dataset=twse/sbl_hist copied=1 identical=0 validation_failed=0 conflicts=0
[promote-quarantine] dataset=tpex/insti_hist copied=1 identical=0 validation_failed=0 conflicts=0
EXIT=0
```
