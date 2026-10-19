# READY_FOR_REVIEW

TICKET-306 r2 Executor status: `READY_FOR_REVIEW`.

No Stop / Escalate clause was triggered. All work and exercises used the
`/Users/zhengweizhu/Projects/wfnt-snapshot-data-t306` worktree and temporary roots.
The worktree `data -> ../wfnt-snapshot-data/data` symlink was read only for the
initial path check; no script was run against it, and it was not staged.

## Implementation

- `scripts/build-derived.mjs`
  - Stages output at `data/.derived-build/root/data/derived/`.
  - Creates `data/.derived-build/root/data/raw` as a read-only-use symlink to the
    selected root's `data/raw`; every existing `apply*` function therefore keeps
    using its `rootDir` contract without a second transformation path.
  - Appends each completed daily unit and its raw metadata to
    `data/.derived-build/daily-progress.jsonl`; non-daily units remain atomically
    checkpointed in `data/.derived-build/progress.json`.
  - Resumes from the completed unit list. If a process stops inside a unit, its
    checkpoint is absent and the idempotent unit is applied again.
  - Records size, nanosecond mtime/ctime, and inode metadata for all 18 raw files
    that `applyDailyDate` can read on each completed date. A later addition,
    modification, or deletion throws `ChangedDailyRawError` with every affected
    date before sector work or switching; checks use filesystem metadata, never
    rescan raw file contents, and run only three times in an unchanged build.
  - Fingerprints every non-daily input byte with SHA-256. A change before switch
    restores the daily-only checkpoint at `data/.derived-build/daily-base/`, keeps
    completed daily dates, and reruns only non-daily stages from current raw.
  - Re-scans daily source dates before switching. Newer dates are applied to the
    restored daily-only checkpoint, that checkpoint is refreshed, and all
    non-daily stages rerun in the original from-zero order. A newly discovered
    unapplied date at or before the latest applied date throws `OlderDailyRawError`
    and lists the dates without modifying active or staged derived bytes.
  - CLI protection throws `SwitchWindowError` at Taipei 21:00-22:00 every day and
    Sunday 10:00-11:00. Programmatic `buildDerived({ rootDir })` calls do not enable
    the clock guard, so existing tests are time-independent.
  - Switches by renaming active derived to
    `data/derived.prev-<Taipei YYYYMMDDHHmm>[-N]`, then renaming staged derived to
    `data/derived`. It never deletes a `derived.prev-*` tree. A rename failure
    restores the old active tree. A stop after the new tree is renamed but before
    staging cleanup is recognized and finalized on the next run.
  - Replaces staged snapshots through `.replace-next` and `.replace-previous`
    siblings. At every interruption point either the target or its complete
    previous snapshot remains, and the next invocation recovers it before reading
    progress.
  - CLI options are `--out DIR`, `--build-only`, and `--reset`. `--reset` removes
    only `data/.derived-build/` before starting.
- `scripts/lib/derived.mjs`
  - `applyDailyDate` retains its existing default behavior, with an internal
    `applySectorIndex: false` option for full rebuilds.
  - `buildSectorIndexForDates` accumulates all dates in memory and serializes
    `sector_index.json` once. It shares the parser, ordering, upsert, and serializer
    with incremental `applySectorIndexDate`.
- `tests/build-derived-staged.test.mjs`
  - Adds 19 temporary-root tests covering all Contract acceptance cases, correction
    rounds 1 through 3, post-rename interruption recovery, and explicit `--reset`
    behavior.
- `tests/all.mjs`, `README.md`, and `AGENTS.md`
  - Import the new test module and document the operator workflow and repository
    invariant.

## Progress file format

`data/.derived-build/progress.json` is pretty-printed JSON with a trailing newline.
Daily completion and raw state are intentionally excluded so non-daily checkpoint
writes do not carry the growing metadata map:

```json
{
  "version": 4,
  "startedAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "nonDailyFingerprint": "sha256 hex",
  "inputs": {
    "daily": [],
    "tpexIndex": ["YYYY-MM"],
    "pcr": ["YYYY-MM"],
    "foreignFutures": ["YYYY-MM"],
    "vix": ["YYYY-MM"],
    "monthly": ["YYYY-MM"],
    "insider": ["YYYY-MM"],
    "quarterly": ["YYYY-Qn"],
    "tdcc": ["YYYY-MM-DD"]
  },
  "completed": {
    "daily": ["YYYY-MM-DD"],
    "sector": true,
    "dailyBase": true,
    "tpexIndex": [],
    "pcr": [],
    "foreignFutures": [],
    "vix": [],
    "monthly": [],
    "insider": [],
    "capital": true,
    "industry": true,
    "corporate": true,
    "quarterly": [],
    "tdcc": [],
    "macro": true
  },
  "summary": {},
  "ready": true
}
```

`data/.derived-build/daily-progress.jsonl` is append-only during the daily phase;
each compact line is one independently recoverable daily checkpoint:

```json
{"date":"YYYY-MM-DD","state":{"twse/mi_index":{"size":"decimal bytes","mtimeNs":"decimal nanoseconds","ctimeNs":"decimal nanoseconds","ino":"decimal inode"},"twse/sbl_hist":null}}
```

On resume, valid complete lines rebuild the in-memory `completed.daily` list and
raw-state map; a partial trailing line is discarded so that date is idempotently
reapplied. The non-daily arrays contain sorted unit keys that were fully applied.
`summary` preserves the base return fields (`dailyDates` through `files`); runtime
return values add `staged`, `switched`, `previousDir`, and, only during post-switch
recovery, `recovered`.

## Test suite

Baseline before implementation:

```text
1..312
# tests 315
# suites 0
# pass 315
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11828.084421
```

Final command in the worktree:

```text
$ node --test tests/
1..331
# tests 334
# suites 0
# pass 334
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 14956.503653
```

No pre-existing test file was changed; only the Contract-authorized import was
added to `tests/all.mjs`.

## Required ablations

Each ablation was applied temporarily, its targeted test was run, and the patch
was reversed immediately. The same test passed after restoration.

1. Resume changed to discard progress and start from the first day:

   ```text
   not ok 1 - daily interruption preserves active bytes, resumes identically, and skips completed dates
   expected: ['2026-01-03', '2026-01-04']
   actual:   ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']
   # pass 0
   # fail 1
   ```

   Restored result: the same test passed (`pass 1`, `fail 0`).

2. Both older-date rejection checks removed (and the corresponding retry branch
   disabled so the ablated program could reach switch):

   ```text
   not ok 1 - a newly discovered older date refuses switching and leaves active and staged bytes unchanged
   error: 'Missing expected rejection.'
   # pass 0
   # fail 1
   ```

   Restored result: the same test passed (`pass 1`, `fail 0`).

3. Switch-window reason forced to `null`:

   ```text
   not ok 1 - both protected CLI windows retain progress and an allowed rerun switches without daily redo
   error: 'Missing expected rejection (SwitchWindowError).'
   # pass 0
   # fail 1
   ```

   Restored result: the same test passed (`pass 1`, `fail 0`).

4. F-221 reverted to call the daily sector writer for every date:

   ```text
   not ok 1 - F-221 writes sector output once for 10 and 40 days and matches incremental bytes
   error: |-
     10 days

     10 !== 1
   # pass 0
   # fail 1
   ```

   Restored result: the same 10/40-day test passed (`pass 1`, `fail 0`).

## Temporary-root CLI transcripts

All three roots were made with `mktemp -d` under `/tmp` and removed after the
exercise. They contained no production data.

Complete build and switch:

```text
$ node scripts/build-derived.mjs --out /tmp/wfnt-t306-cli-full.uTncoB
derived daily_dates=0 tpex_index_months=0 taifex_pcr_months=0 taifex_foreign_futures_months=0 taifex_vix_months=0 monthly_months=0 insider_months=0 capital_events=0 industries=0 corporate_actions=0 quarterly_seasons=0 tdcc_weeks=0 macro_series=0 files=0 staged=false switched=true
```

Build only, followed by resume and switch:

```text
$ node scripts/build-derived.mjs --out /tmp/wfnt-t306-cli-resume.opEi6D --build-only
derived daily_dates=0 tpex_index_months=0 taifex_pcr_months=0 taifex_foreign_futures_months=0 taifex_vix_months=0 monthly_months=0 insider_months=0 capital_events=0 industries=0 corporate_actions=0 quarterly_seasons=0 tdcc_weeks=0 macro_series=0 files=0 staged=true switched=false
$ node scripts/build-derived.mjs --out /tmp/wfnt-t306-cli-resume.opEi6D
derived daily_dates=0 tpex_index_months=0 taifex_pcr_months=0 taifex_foreign_futures_months=0 taifex_vix_months=0 monthly_months=0 insider_months=0 capital_events=0 industries=0 corporate_actions=0 quarterly_seasons=0 tdcc_weeks=0 macro_series=0 files=0 staged=false switched=true
```

Injected Taipei 21:30 clock through the exported CLI runner (exit 1):

```text
$ node --input-type=module --eval 'import { runBuildDerivedCli } from "./scripts/build-derived.mjs"; try { await runBuildDerivedCli(["--out", "/tmp/wfnt-t306-cli-blocked.nSjY73"], { now: () => new Date("2026-10-19T13:30:00Z") }); } catch (error) { console.log(error.message); process.exitCode = 1; }'
derived switch refused: Taipei daily protection window 21:00-22:00
```

## 修正輪 1

### O-001

- 新增 daily-only checkpoint：`data/.derived-build/daily-base/`。逐日與 sector
  完成後先保存此樹，之後才進入月／單例／季／週／macro 階段。
- 非逐日 raw 指紋變動時，工作樹只以 daily-only checkpoint 還原 staged
  derived，保留 `completed.daily`，重置並重跑非逐日 inputs、completed flags
  與 summary；不再刪除整個 `data/.derived-build/`。
- 重收非逐日 inputs 時以變動前後兩次 SHA-256 相等為穩定條件，避免 inputs
  清單與其基準指紋來自不同 raw 時點。
- 進度格式升為 version 2，新增 `completed.dailyBase`；version 1 進度須由操作員
  使用既有 `--reset` 明確放棄，避免把已含非逐日輸出的 staged tree 誤認為
  daily-only checkpoint。
- 新測試 `non-daily raw change after partial daily progress reruns only non-daily work`
  在第 2/4 個逐日 checkpoint 後新增月營收並中斷。續跑只觀察到第 3、4 日，
  且切換結果與同 raw 從零重建逐位元組相同。

消融：三處處理暫時還原為 `rm(buildDir) + continue`，新增測試轉紅：

```text
not ok 1 - non-daily raw change after partial daily progress reruns only non-daily work
expected: ['2026-01-03', '2026-01-04']
actual:   ['2026-01-03', '2026-01-04',
           '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']
# pass 0
# fail 1
```

還原後同測試：`pass 1`, `fail 0`。

### O-002

- 較新逐日日期不再直接套在已完成的非逐日輸出上。流程改為：還原
  daily-only checkpoint → 套用所有 newer dates → 更新 sector → 原子刷新
  daily-only checkpoint → 重置並依既有順序重跑全部非逐日階段。
- 新測試 `newer daily valuation catch-up reruns monthly work and matches from-zero bytes`
  使用同一 TWSE 代號的 valuation 與月營收 metadata。修正後結果名稱為
  `monthly final`，整棵 derived 與同 raw 從零重建逐位元組相同。

消融：暫時還原為在非逐日階段後直接套 newer dates，測試轉紅；唯一差異檔為
`fundamentals/23/2330.json`，實際 metadata 名稱 `new valuation`，預期為
`monthly final`：

```text
not ok 1 - newer daily valuation catch-up reruns monthly work and matches from-zero bytes
error: Expected values to be strictly deep-equal
# pass 0
# fail 1
```

還原後同測試：`pass 1`, `fail 0`。

修正輪最終完整測試摘要：

```text
$ node --test tests/
1..325
# tests 328
# suites 0
# pass 328
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12603.16363
```

依交付指示，本修正輪未建立 commit，變更保留於工作樹供 Orchestrator 代 commit。

## 修正輪 2

### R-1

- `DAILY_SOURCES` 新增 `twse/sbl_hist` 與 `tpex/sbl_hist`，現與
  `applyDailyDate` 實際讀取的 18 個 dataset 完全一致。
- progress 格式升為 version 3，新增 `dailyRawState`。每個已完成日期記錄各逐日
  raw 的 size、mtimeNs、ctimeNs、inode；不存在的檔案記為 `null`。後續檢查只
  stat 這些已知路徑，不讀逐日 raw 內容。
- raw 在套用後新增、修改或刪除時，`ChangedDailyRawError` 以
  `CHANGED_DAILY_RAW` 非 0 結束並列出所有受影響日期。檢查位於續跑入口、每個
  checkpoint hook 後、補齊前及切換前，因此拒絕後不再改 staged 或 active tree。
- 日期補齊仍只接受嚴格晚於最新已套用日期的日期；更舊未套用日期維持既有
  `OlderDailyRawError` 行為。
- 新測試分別在逐日階段完成後新增同日 `twse/sbl_hist`、修改同日既有
  `twse/mi_index`，均驗證非 0 rejection、錯誤日期及 active/staged 位元組不變。

消融 1：暫時從 `DAILY_SOURCES` 拿掉 `twse/sbl_hist`，新增測試轉紅：

```text
not ok 1 - adding sbl raw for an applied date refuses switching and preserves active and staged bytes
error: 'Missing expected rejection.'
# pass 0
# fail 1
```

還原後同測試：`pass 1`, `fail 0`。

消融 2：暫時將已套用日期變動檢查改為 no-op，新增測試轉紅：

```text
not ok 1 - modifying raw for an applied date refuses switching and preserves active and staged bytes
error: 'Missing expected rejection.'
# pass 0
# fail 1
```

還原後同測試：`pass 1`, `fail 0`。

### O-003

- `replaceDirectory` 先把完整新 snapshot 複製到固定 `.replace-next` sibling，再把
  舊 target 改名為 `.replace-previous`，最後才把新 snapshot 改名為 target。
- 重跑時先執行 recovery：危險點中斷若 target 不存在便把完整
  `.replace-previous` 改回；若新 target 已存在則清掉內部舊備份。過程不會刪除
  active `derived` 或任何 `derived.prev-*`。
- 新測試在 `daily-base` 舊 target 已移走、新 target 尚未改名時注入中斷；重跑
  完成且結果與一次跑完逐位元組相同，`phase=daily` 的重做清單為空。

消融 3：暫時還原為先刪 target 再改名 temporary，新增測試轉紅：

```text
not ok 1 - snapshot replacement interruption recovers without redoing applied daily dates
error: "ENOENT: no such file or directory, lstat '.../data/.derived-build/daily-base'"
# pass 0
# fail 1
```

還原後同測試：`pass 1`, `fail 0`。

### R-2（人類接受殘餘風險）

`README.md` 已明載：正式切換的兩次目錄改名之間若程序終止，
`data/derived/` 會暫時不存在；重跑同一指令即完成切換，舊版位於
`data/derived.prev-*`。依裁決未修改正式切換程式。

修正輪 2 最終完整測試摘要：

```text
$ node --test tests/
1..328
# tests 331
# suites 0
# pass 331
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 15290.790718
```

依交付指示，本修正輪未建立 commit，變更保留於工作樹供 Orchestrator 代 commit。

## 修正輪 3

### O-004

- 進度格式升為 version 4。逐日完成狀態與 18 個 raw 路徑的 stat metadata 改存於
  append-only `data/.derived-build/daily-progress.jsonl`，每完成一天只追加一行 compact
  JSON；`progress.json` 不再包含成長中的 `dailyRawState` 或 `completed.daily`。
- 續跑會讀取 journal 的完整有效行，重建記憶體內的已完成日期與 raw 狀態；若最後
  一行因中斷而不完整便截去該行，該日期由既有 idempotent daily apply 重做。
- 若 catch-up journal 已寫入但主 progress 尚未更新就中斷，續跑會由 journal 補回
  新日期、還原 `daily-base`，再重置非逐日階段，維持從零套用順序。
- 完整已套用日期檢查從每個 checkpoint 移除。無 raw 變動的一次建置固定執行三次：
  續跑入口、逐日階段結束、切換前；最後一次位於 `switchDerived` 前。補齊完成另做
  一次固定邊界檢查，不隨逐日天數增加。
- 新增 10/40 天測試：兩組完整檢查皆為 3 次；逐日 progress append 的最大單筆
  bytes 在 40 天組不超過 10 天組的 2 倍。另在第 2 天 checkpoint 修改第 1 天 raw，
  驗證在 sector 與切換前以 `ChangedDailyRawError` 拒絕且 active tree 不變。
- 修正輪 2 的新增／修改 raw 拒絕測試與 snapshot replacement recovery 測試均維持
  全綠。

消融 1：暫時把完整檢查放回每個逐日 checkpoint，10/40 天測試轉紅：

```text
not ok 1 - completed daily raw full-check count is constant for 10 and 40 days
expected: [13, 13]
actual:   [13, 43]
# pass 0
# fail 1
```

還原後同測試：`pass 1`, `fail 0`，實際計數為 `[3, 3]`。

消融 2：暫時改回每完成一天就以縮排 JSON 整份寫入含累積
`dailyRawState`／`completed.daily` 的進度，10/40 天測試轉紅：

```text
not ok 1 - daily progress append size stays bounded for 10 and 40 days
error: '31481 > 8711 * 2'
# pass 0
# fail 1
```

還原後同測試：`pass 1`, `fail 0`。

修正輪 3 最終完整測試摘要：

```text
$ node --test tests/
1..331
# tests 334
# suites 0
# pass 334
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 14956.503653
```

依交付指示，本修正輪未建立 commit，變更保留於工作樹供 Orchestrator 代 commit。

## Scope and safety checks

- `git diff --check`: clean.
- Network calls: none.
- Real `data/` scripts: none.
- Main worktree operations: none after reading its required `AGENTS.md`.
- `launchctl`, `~/Library/**`, and `~/bin/**`: untouched.
- Existing tests modified: none.
- Generated `data/**`: not staged or hand-edited.
