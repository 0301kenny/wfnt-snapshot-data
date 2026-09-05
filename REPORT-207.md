# REPORT-207 — 回補原子寫入、範圍 checkpoint、derived 條件化

## 結論

- 狀態：**READY_FOR_REVIEW**。
- 分支 / base：`ticket-207` / `6b26f2ee8bd69b69b8867eb8c0a8cefd379071aa`。
- 真實網路請求總次數：**0**。所有 backfill 驗收都使用注入的 `fetchImpl`；所有 fixture 與負向對照都位於隔離 tmpdir。
- 未 commit；未修改 WFNT_app；未在 repo 根目錄執行 `build-derived`；真 `data/` 零寫入；`scripts/detect-gaps.mjs` 零修改。
- 沒有刪除測試、加 `skip`、放寬 assertion 或吞錯。沒有觸發 Stop / Escalate。

## 實作摘要

1. `scripts/lib/io.mjs`
   - `writeFileEnsured` 改為在目標同目錄建立 UUID 暫存檔，完整寫入後以 `rename` 原子發布。
   - 成功或失敗都在 `finally` 清理暫存檔；寫入或 rename 失敗會照常向上拋錯。
   - 保留既有兩參數呼叫方式；第三參數只提供測試注入的 `writeFileImpl` / `renameImpl`。
2. `scripts/lib/derived.mjs`
   - 在第 12 行 export `DERIVED_INPUT_DATASETS`，內容為 `applyDailyDate` 實際讀取的 16 個 namespace。
   - `applyDailyDate` 內部計算與 16 條讀取邏輯均未修改。
3. `scripts/backfill.mjs`
   - checkpoint 新增 `fromDate` / `toDate`；只有兩欄都與本次完整範圍完全一致時才套用 `lastDate`。
   - 舊 `{lastDate, updatedAt}` checkpoint 會安全讀入但不套用 resume，處理成功後寫成新格式。
   - 10 個 raw write promise 現在保留實際寫入的 `sourceDataset`；只有寫入集合命中 `DERIVED_INPUT_DATASETS` 才呼叫 `applyDailyDate`。
   - `twse/sbl_hist` / `tpex/sbl_hist` 不在集合內，只有借券寫入時不跑 derived。
   - `--dates` 仍繞過且不更新 checkpoint。

16 個 namespace：

```text
twse/mi_index
twse/stock_day_all
twse/mi_margn
tpex/index
tpex/mainboard_close
tpex/3insti
tpex/margin
twse/bwibbu_all
twse/mi_index_hist
twse/t86_hist
twse/mi_margn_hist
tpex/daily_quotes_hist
tpex/insti_hist
tpex/margin_hist
twse/bwibbu_hist
tpex/pe_hist
```

常數名稱與位置：`DERIVED_INPUT_DATASETS`，`scripts/lib/derived.mjs:12`。

## 測試修改說明

### `tests/backfill.test.mjs`

- 新增 `applyDailyDate` 三情境呼叫次數測試：零 raw 寫入為 0、任一 derived input 寫入為 1、只有兩個 SBL 寫入為 0。
- 新增 unchanged raw 的 derived 等價性測試：相同 fixture 先建立相同 raw / derived 狀態；本票路徑跳過呼叫，base 的無條件語意則直接執行同一個未修改的 `applyDailyDate`；最後對 `data/derived/` 全樹的 Buffer map 做 `deepEqual`。
- 新增 16-namespace pinning：從 `applyDailyDate` 原始碼擷取 16 條 `readJsonRaw` / `readTextRaw` 實際 namespace，與 export 常數做完整集合相等比較。
- 更新既有「中斷後續跑」測試：新增 checkpoint 完整格式斷言，保留「已完成日期不 refetch」的精確斷言。
- 更新既有「較晚 checkpoint / `--dates`」測試：舊格式較晚 checkpoint 現在必須讓較早 range 實際處理；`--dates` 仍精確驗證 checkpoint bytes 不變。
- 於檔首 import `tests/io.test.mjs`，使 `node --test tests/` 經 `tests/package.json` → `tests/all.mjs` 的固定入口時也會執行新 I/O 測試。原因見「票面建議修正」。

### `tests/cli-flags.test.mjs`

- 只修改既有 `legal numeric strings reach all four run paths unchanged` 一處。
- 移除 `{"lastDate":"2026-07-06"}` 的 resume 捷徑。
- 改為在隔離 root 預先建立 7 份有效 raw：兩市場 OpenAPI close、TWSE T86 / BWIBBU / SBL、TPEX PE / SBL。
- 因 raw 已完整存在，測試維持 `fetchCalls === 0`，並改為精確斷言 `backfill.resumed === 0`、`backfill.rawWritten === 0`；數字旗標仍實際抵達 daily run path。

## 票面驗收

### 1. 完整測試 — PASS

執行：

```bash
node --test tests/
```

最終統計：

```text
1..99
# tests 99
# suites 0
# pass 99
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3309.463043
```

base 為 93；本票新增 **6** 條：

- `tests/io.test.mjs`：3 條（成功原子發布、既有目標負向、無目標負向）。
- `tests/backfill.test.mjs`：3 條（呼叫條件三情境、derived 位元組等價、16-set pinning）。

### 2. 原子寫入正負向 — PASS

執行：

```bash
node --test tests/io.test.mjs
```

原始證據：

```text
# SUCCESS_BYTES_EQUAL=true TEMP_FILES=[]
# EXISTING_TARGET_BYTES_UNCHANGED=true TEMP_SAME_DIR=true TEMP_FILES=[]
# ABSENT_TARGET_REMAINS_ABSENT=true TEMP_FILES=[]
1..3
# tests 3
# pass 3
# fail 0
```

失敗 fixture 的 `writeFileImpl` 只把前 4 bytes 寫入 production 產生的暫存路徑後拋錯。兩個負向分別以 `readFile(target)` 與 `access(target)` 驗證原有檔 bytes 完全不變、原本無檔仍為 `ENOENT`；以 `readdir(...).filter(name => name.includes('.tmp-'))` 驗證殘留陣列皆為 `[]`。`TEMP_SAME_DIR=true` 證明暫存檔與目標同目錄。

### 3. checkpoint 解死結且保留續跑 — PASS

執行：

```bash
node --test --test-name-pattern='checkpoint resumes|old-format later checkpoint' tests/backfill.test.mjs
```

解除較晚 checkpoint 對較早 range 的死結：

```text
# OLD_FORMAT_RANGE_RESULT={"resumed":0,"rawWritten":10,"fetchCalls":10,"checkpoint":{"lastDate":"2026-07-06","fromDate":"2026-07-06","toDate":"2026-07-06","updatedAt":"2026-08-29T00:00:00.000Z"}}
```

保留同範圍中斷後續跑能力：

```text
# INTERRUPTED_CHECKPOINT={"lastDate":"2026-07-06","fromDate":"2026-07-06","toDate":"2026-07-07","updatedAt":"2026-07-19T00:00:00.000Z"}
# RESUME_RESULT={"resumed":1,"completedDateRefetched":false}
```

舊格式安全讀取，以及 `--dates` checkpoint bytes 不變：

```text
# OLD_FORMAT_CHECKPOINT_LOAD=FULFILLED
# EXPLICIT_DATES_CHECKPOINT_UNCHANGED=true
1..2
# tests 2
# pass 2
# fail 0
```

### 4. `applyDailyDate` 三情境呼叫次數 — PASS

執行：

```bash
node --test --test-name-pattern='applyDailyDate runs only' tests/backfill.test.mjs
```

原始輸出：

```text
# UNCHANGED_RAW_APPLY_CALLS=0
# DERIVED_INPUT_WRITE_APPLY_CALLS=1
# SBL_ONLY_WRITE_APPLY_CALLS=0
```

三者均由注入的 `applyDailyDateImpl` 在 production `runBackfill` 呼叫邊界直接計數，不以耗時或 derived 檔案數推估。

### 5. derived 全樹逐位元等價 — PASS

執行的逐位元比較測試：

```bash
node --test --test-name-pattern='skipping applyDailyDate on unchanged raw is byte-identical' tests/backfill.test.mjs
```

比較方式：`fileMap` 遞迴讀取 `data/derived/` 全樹，每個 value 都是原始 `Buffer`；以 `assert.deepEqual(optimizedDerived, baseDerived)` 比對完整相對路徑集合及每個檔案的所有 bytes。base 路徑執行本票未修改的 `applyDailyDate`，本票路徑確認實際呼叫次數為 0。

原始輸出：

```text
# DERIVED_TREE_BITWISE_EQUAL=["fundamentals/11/1101.json","fundamentals/12/1240.json","market.json","symbols/23/2330.json","symbols/54/5483.json"] OPTIMIZED_APPLY_CALLS=0
ok 1 - skipping applyDailyDate on unchanged raw is byte-identical to the base unconditional call
# pass 1
# fail 0
```

結論：同一 fixture、同一日期下，base 無條件呼叫與本票零寫入跳過路徑的 `data/derived/` 全樹逐位元相同；未發現等價性反例。

### 6. 16-namespace pinning 與負向對照 — PASS

正向：

```bash
node --test --test-name-pattern='DERIVED_INPUT_DATASETS exactly matches' tests/backfill.test.mjs
```

```text
# DERIVED_INPUT_DATASETS_MATCH=true COUNT=16
# NEGATIVE_CONTROL_REMOVE_TWSE_MI_INDEX=ASSERTION_REJECTED
# pass 1
# fail 0
```

真正轉紅的負向對照只在 `mktemp -d` 副本刪除常數中的 `twse/mi_index`，再執行同一條測試；原工作樹不變。核心命令：

```bash
cp -R scripts tests package.json "$ticket207_tmp/repo/"
perl -0pi -e "s/  .twse\/mi_index.,\n//" "$ticket207_tmp/repo/scripts/lib/derived.mjs"
node --test --test-name-pattern="DERIVED_INPUT_DATASETS exactly matches" "$ticket207_tmp/repo/tests/backfill.test.mjs"
```

原始結果：

```text
not ok 1 - DERIVED_INPUT_DATASETS exactly matches the namespaces read by applyDailyDate
error: Expected values to be strictly deep-equal:
-   'twse/mi_index',
1..1
# tests 1
# pass 0
# fail 1
NEGATIVE_CONTROL_EXIT=1
```

## 票面建議修正

- Scope 允許新增 `tests/io.test.mjs`，Acceptance 1 又要求 `node --test tests/` 收到新增測試；但 repo 的 `tests/package.json` 將目錄入口固定為 `tests/all.mjs`，而 Scope 沒有允許修改 `tests/all.mjs`。本票透過允許修改的 `tests/backfill.test.mjs` import 新測試達成 gate。下個 revision 建議將 `tests/all.mjs` 納入 Scope，讓測試登錄位置回到集中清單。
- `README.md` / `AGENTS.md` 現有文字只描述 range 支援 checkpoint 與 `--dates` 繞過且不更新 checkpoint，並未宣稱全域 `lastDate`；本票後仍正確，因此未修改。

## 收工檢查

- `git diff --check`：無輸出。
- 修改範圍只有：`scripts/lib/io.mjs`、`scripts/lib/derived.mjs`、`scripts/backfill.mjs`、`tests/io.test.mjs`、`tests/backfill.test.mjs`、`tests/cli-flags.test.mjs`、`REPORT-207.md`。
- 未修改既有未追蹤 `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、`REPORT-194.md`。
- 真實網路請求：**0**；真 `data/` 寫入：**0**；commit：**0**。
