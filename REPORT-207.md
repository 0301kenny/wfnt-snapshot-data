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

---

# a2 修正輪 — accepted findings F-1～F-4

## 狀態

- **READY_FOR_REVIEW**。
- a2 base / 目前分支：`f159d2aac8abaf16413e516b7c837a8431832aa4` / `ticket-207`。
- 未 reset、未 commit、未碰 main；未修改 WFNT_app、`scripts/detect-gaps.mjs` 或本輪三項「不做」。
- 真實網路請求總次數：**0**。所有 backfill 都使用注入的 fixture fetch；所有寫入與負向對照都在 `mkdtemp` / `/tmp/ticket207-*.XXXXXX` 隔離目錄。未在 repo 根目錄執行 `build-derived`，真 `data/` 零寫入。

## 四筆 finding 的修正與證據

### F-1（P1）零寫入等價性與 SBL 收益同時保留

`scripts/backfill.mjs:457-464` 現在把 skip 條件收窄為：

```js
const derivedInputTouched = writtenDatasets.some((dataset) => DERIVED_INPUT_DATASETS.has(dataset));
const canSkipDerived = writtenDatasets.length > 0
  && !derivedInputTouched
  && symbolWindow === DEFAULT_SYMBOL_WINDOW
  && await fileExists(join(rootDir, 'data', 'derived', 'market.json'));
```

因此：

- 本次 raw **零寫入**：一定 apply，不能再由空陣列的 `.some()` 誤判為可跳過。
- 任一 16-namespace derived input 寫入：一定 apply。
- 本次有實際寫入、寫入集合只有 `twse/sbl_hist` / `tpex/sbl_hist`、使用預設 window、且 derived baseline 的 `market.json` 存在：才跳過，保留本票省下約 17.5 秒／日的目標。
- derived 全缺失或使用非預設 `symbolWindow` 時，即使同次還有 SBL-only 寫入也會 apply；兩個反例的組合邊界同樣被測試覆蓋。

兩個 reviewer 反例已各自成為獨立測試，且 fixture 的初次 run 明確寫入全部 10 筆 legacy raw：

```text
# MISSING_DERIVED_REBUILT=true SEEDED_RAW_WRITTEN=10 ZERO_WRITE_RERUN_RAW_WRITTEN=0 SBL_RERUN_RAW_WRITTEN=2 APPLY_CALLS=1 FILES=["fundamentals/11/1101.json","fundamentals/12/1240.json","market.json","symbols/23/2330.json","symbols/54/5483.json"]
# SYMBOL_WINDOW_ROWS_BEFORE=2 ZERO_WRITE_AFTER=1 SBL_AFTER=1 SEEDED_RAW_WRITTEN=10 ZERO_WRITE_RERUN_RAW_WRITTEN=0 SBL_RERUN_RAW_WRITTEN=2 APPLY_CALLS=1
```

呼叫矩陣與 SBL-only 位元組等價性：

```text
# ZERO_RAW_WRITES_APPLY_CALLS=1
# DERIVED_INPUT_WRITE_APPLY_CALLS=1
# SBL_ONLY_WRITE_APPLY_CALLS=0
# SBL_ONLY_DERIVED_TREE_BITWISE_EQUAL=["fundamentals/11/1101.json","fundamentals/12/1240.json","market.json","symbols/23/2330.json","symbols/54/5483.json"] RAW_WRITTEN=2 OPTIMIZED_APPLY_CALLS=0
```

逐位元比較仍使用 `fileMap` 遞迴讀取 `data/derived/` 全樹為原始 `Buffer` map，再以 `assert.deepEqual` 比較完整相對路徑集合及所有 bytes；base 側在相同 SBL-only fixture 後額外執行未修改的 `applyDailyDate`。

### F-2（P2）成功路徑移除無用清理 syscall

`scripts/lib/io.mjs:22-32` 已把清理從 `finally` 移至 `catch`。成功 write + rename 後直接 return，不再呼叫 `rm`。測試以注入的 `rmImpl` 直接計數，不以耗時推估：

```text
# SUCCESS_BYTES_EQUAL=true CLEANUP_CALLS=0 TEMP_FILES=[]
```

既有兩條失敗路徑負向測試未刪除、未放寬，仍證明既有目標 bytes 不變、無目標仍不存在、同目錄暫存與零殘留：

```text
# EXISTING_TARGET_BYTES_UNCHANGED=true TEMP_SAME_DIR=true TEMP_FILES=[]
# ABSENT_TARGET_REMAINS_ABSENT=true TEMP_FILES=[]
```

### F-3（P3）清理錯誤不再遮蔽主錯誤

失敗路徑會 best-effort 清理，再無條件重拋原始 write / rename error。測試令 write 拋出 `ORIGINAL_WRITE_FAILURE`，令 cleanup 完成刪除後另拋 `CLEANUP_FAILURE`，呼叫端收到的仍是同一個原始 Error object：

```text
# RECEIVED_ERROR=ORIGINAL_WRITE_FAILURE CLEANUP_CALLS=1 TEMP_FILES=[]
```

### F-4（P3）I/O 測試由集中入口顯式登錄

- `tests/all.mjs:4` 現在顯式 `import './io.test.mjs'`。
- 已移除 `tests/backfill.test.mjs` 對 `io.test.mjs` 的間接 import。
- a1 為 99 tests；a2 新增 3 tests 後集中入口為 102 tests。隔離副本只移除 `tests/all.mjs` 該 import 時，總數精確降為 98，證明四條 I/O 測試確由集中入口收進 gate：

```text
1..98
# tests 98
# pass 98
# fail 0
```

## 每條修正測試的負向對照原始輸出

所有負向對照都在隔離副本執行，production working tree 未被回退。

### F-1a：回退成 a1 的空陣列 `.some()` 條件

回退：`const canSkipDerived = !derivedInputTouched;`（等價於 a1 的空陣列 `.some()` 判斷）。兩個 reviewer 反例同時轉紅：

```text
not ok 1 - zero raw writes rebuild missing derived outputs
error: Expected values to be strictly equal:
0 !== 1
expected: 1
actual: 0

not ok 2 - zero raw writes reapplies a changed symbol window
error: Expected values to be strictly equal:
0 !== 1
expected: 1
actual: 0

1..2
# tests 2
# pass 0
# fail 2
NEGATIVE_CONTROL_EXIT=1
```

### F-1b：把最佳化整個拿掉

改成 `const canSkipDerived = false;`，SBL-only 收益測試確實轉紅：

```text
not ok 1 - applyDailyDate runs for zero raw writes and derived-input writes but skips SBL-only writes
error: Expected values to be strictly equal:
1 !== 0
expected: 0
actual: 1
# ZERO_RAW_WRITES_APPLY_CALLS=1
# DERIVED_INPUT_WRITE_APPLY_CALLS=1
1..1
# tests 1
# pass 0
# fail 1
NEGATIVE_CONTROL_EXIT=1
```

### F-1c：只做 accepted finding 的最小 non-empty 收窄、移除 baseline / window guard

改成 `const canSkipDerived = writtenDatasets.length > 0 && !derivedInputTouched;`。零寫入部分先通過後，兩條測試都在各自的 SBL-only 組合邊界轉紅，證明新增 guard 不是無效 fixture：

```text
not ok 1 - zero raw writes rebuild missing derived outputs
error: Expected values to be strictly equal:
0 !== 1
expected: 1
actual: 0
stack: tests/backfill.test.mjs:906:12

not ok 2 - zero raw writes reapplies a changed symbol window
error: Expected values to be strictly equal:
0 !== 1
expected: 1
actual: 0
stack: tests/backfill.test.mjs:960:12

1..2
# tests 2
# pass 0
# fail 2
NEGATIVE_CONTROL_EXIT=1
```

### F-2 / F-3：回退成 `finally` 清理

成功路徑計數與原錯誤保留兩條都轉紅；兩條既有中斷／零殘留測試仍綠，證明它們沒有被放寬：

```text
not ok 1 - writeFileEnsured atomically publishes the exact requested bytes
error: Expected values to be strictly equal:
1 !== 0
expected: 0
actual: 1

ok 2 - interrupted atomic write preserves an existing target and removes its partial temp file
# EXISTING_TARGET_BYTES_UNCHANGED=true TEMP_SAME_DIR=true TEMP_FILES=[]
ok 3 - interrupted atomic write leaves an absent target absent and removes its partial temp file
# ABSENT_TARGET_REMAINS_ABSENT=true TEMP_FILES=[]

not ok 4 - cleanup failure never replaces the original write failure
error: Expected "actual" to be reference-equal to "expected":
+ [Error: CLEANUP_FAILURE]
- [Error: ORIGINAL_WRITE_FAILURE]

1..4
# tests 4
# pass 2
# fail 2
NEGATIVE_CONTROL_EXIT=1
```

### F-4：移除集中入口登錄

原始摘要即前述 `98 / 98 / 0`；相對現版 `102 / 102 / 0` 少四條，負向對照成立。

### 驗收 6 的既有 drift 負向對照重跑

隔離副本從 `DERIVED_INPUT_DATASETS` 移除 `twse/mi_index`：

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

## a2 新增／修改測試清單與理由

相對 a1 新增 **3** 條：

- `tests/backfill.test.mjs:863`：10 筆 raw 已存在、derived 全缺失、rerun 零 raw 寫入時必須重建。
- `tests/backfill.test.mjs:912`：10 筆 raw 已存在、`symbolWindow` 從 2 改 1、rerun 零 raw 寫入時必須裁成 1 row。
- `tests/io.test.mjs:78`：write 與 cleanup 同時 reject 時，原始 write error 必須保持 reference-equal。

修改而未增加條數：

- `tests/backfill.test.mjs:820`：a1 三情境矩陣改為 a2 正確語意（零寫入 1、derived input 寫入 1、SBL-only 寫入 0）。
- `tests/backfill.test.mjs:966`：a1 的無效「零寫入 skip」等價性 fixture 改成真正會 skip 的 SBL-only fixture；仍逐位元比較 base / optimized 全樹。
- `tests/io.test.mjs:21`：成功測試新增 `rmImpl` 呼叫計數，直接釘住 F-2。
- `tests/all.mjs:4` / `tests/backfill.test.mjs:1-3`：I/O 測試改由集中入口顯式登錄，移除間接登錄。

`tests/cli-flags.test.mjs`、a1 的 checkpoint 測試與 16-namespace 測試本輪不需改碼；均已重跑確認仍綠。

## 票面驗收 1～6 重跑

### 1. 完整 gate — PASS

```text
1..102
# tests 102
# suites 0
# pass 102
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4406.169718
```

相對原始 base 93 條，TICKET-207 累計新增 9 條；相對 a1 99 條，本輪新增 3 條。沒有刪除、skip 或放寬 assertion。

### 2. 原子寫入正負向 — PASS

```text
# SUCCESS_BYTES_EQUAL=true CLEANUP_CALLS=0 TEMP_FILES=[]
# EXISTING_TARGET_BYTES_UNCHANGED=true TEMP_SAME_DIR=true TEMP_FILES=[]
# ABSENT_TARGET_REMAINS_ABSENT=true TEMP_FILES=[]
# RECEIVED_ERROR=ORIGINAL_WRITE_FAILURE CLEANUP_CALLS=1 TEMP_FILES=[]
1..4
# tests 4
# pass 4
# fail 0
```

### 3. checkpoint 解死結、續跑與舊格式 — PASS

```text
# INTERRUPTED_CHECKPOINT={"lastDate":"2026-07-06","fromDate":"2026-07-06","toDate":"2026-07-07","updatedAt":"2026-07-19T00:00:00.000Z"}
# RESUME_RESULT={"resumed":1,"completedDateRefetched":false}
# OLD_FORMAT_CHECKPOINT_LOAD=FULFILLED
# OLD_FORMAT_RANGE_RESULT={"resumed":0,"rawWritten":10,"fetchCalls":10,"checkpoint":{"lastDate":"2026-07-06","fromDate":"2026-07-06","toDate":"2026-07-06","updatedAt":"2026-08-29T00:00:00.000Z"}}
# EXPLICIT_DATES_CHECKPOINT_UNCHANGED=true
1..2
# tests 2
# pass 2
# fail 0
```

### 4. apply 呼叫矩陣 — PASS（依 a2 accepted finding 校正零寫入分支）

```text
# ZERO_RAW_WRITES_APPLY_CALLS=1
# DERIVED_INPUT_WRITE_APPLY_CALLS=1
# SBL_ONLY_WRITE_APPLY_CALLS=0
```

a1 票面把「raw 完整且零寫入」列為 0 的文字已由 F-1 仲裁證明違反等價性；a2 依 accepted finding 將它校正為 1。驗收 4 的實際收益仍由「借券有寫入、其他零寫入」的 0 次呼叫保留。

### 5. derived 等價性 — PASS

在唯一 skip 分支（預設 window、baseline 存在的 SBL-only 寫入）上，optimized 實際 `APPLY_CALLS=0`；同 fixture 的 base 無條件 apply 後，`data/derived/` 全樹路徑與 Buffer bytes 完全相等。零寫入的兩個 reviewer 反例不再 skip；即使它們各自與 SBL-only 寫入同時發生，也會重建缺失 derived 或套用新 window。

### 6. 16-namespace pinning — PASS

```text
# DERIVED_INPUT_DATASETS_MATCH=true COUNT=16
# NEGATIVE_CONTROL_REMOVE_TWSE_MI_INDEX=ASSERTION_REJECTED
1..1
# tests 1
# pass 1
# fail 0
```

常數仍名為 `DERIVED_INPUT_DATASETS`，位於 `scripts/lib/derived.mjs:12`；`applyDailyDate` 的計算與 16 條讀取未修改。

## 殘留不等價情境判斷

在 production 可達的正常前置狀態中未發現新的不等價：零寫入與 derived-input 寫入都回到 base 的 apply；唯一 skip 是 SBL-only 寫入，測試已證明 derived 全樹與 base 位元組相同。

仍有一個需要明示的外部狀態邊界：若 `market.json` 尚在，但 `data/derived/` 的其他個別檔案已被局部刪除／手動破壞，而同一次執行又恰好只有 SBL raw 寫入，現條件仍會 skip，base 則可能修復該日涉及的檔案。完整 derived 缺失與所有非預設 window 已由新 guard 處理。剩餘邊界判斷可接受的理由是：唯一 skip 分支以「derived input 未變且既有 derived 是正常管線產物」為前置；raw 是 authoritative，外部局部破壞的完整修復出口仍是隔離執行 `build-derived`。若要在 `market.json` 存在時仍對任意局部外部破壞做嚴格證明，就必須增加逐檔完整性狀態標記或每次重算；前者超出本輪四筆 finding，後者會直接消滅驗收 4 的 SBL 收益，因此本輪未自行擴大。

## a2 收工檢查

- `git diff --check`：無輸出。
- a2 修改檔案只有：`scripts/backfill.mjs`、`scripts/lib/io.mjs`、`tests/backfill.test.mjs`、`tests/io.test.mjs`、`tests/all.mjs`、`REPORT-207.md`；皆在 a2 Scope。
- `scripts/lib/derived.mjs` 與 `tests/cli-flags.test.mjs` 是 a1 既有內容，本輪未修改；各自驗收仍綠。
- 四份既有未追蹤歷史報告 `REPORT-070.md`、`REPORT-189.md`、`REPORT-192.md`、`REPORT-194.md` 未修改。
- 真實網路請求：**0**；真 `data/` 寫入：**0**；commit：**0**。
