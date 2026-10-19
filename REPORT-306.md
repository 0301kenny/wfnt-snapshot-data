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
  - Atomically checkpoints `data/.derived-build/progress.json` after each daily,
    monthly, quarterly, weekly, or singleton stage unit.
  - Resumes from the completed unit list. If a process stops inside a unit, its
    checkpoint is absent and the idempotent unit is applied again.
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
  - CLI options are `--out DIR`, `--build-only`, and `--reset`. `--reset` removes
    only `data/.derived-build/` before starting.
- `scripts/lib/derived.mjs`
  - `applyDailyDate` retains its existing default behavior, with an internal
    `applySectorIndex: false` option for full rebuilds.
  - `buildSectorIndexForDates` accumulates all dates in memory and serializes
    `sector_index.json` once. It shares the parser, ordering, upsert, and serializer
    with incremental `applySectorIndexDate`.
- `tests/build-derived-staged.test.mjs`
  - Adds 13 temporary-root tests covering all Contract acceptance cases, correction
    round 1, post-rename interruption recovery, and explicit `--reset` behavior.
- `tests/all.mjs`, `README.md`, and `AGENTS.md`
  - Import the new test module and document the operator workflow and repository
    invariant.

## Progress file format

`data/.derived-build/progress.json` is pretty-printed JSON with a trailing newline:

```json
{
  "version": 2,
  "startedAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "nonDailyFingerprint": "sha256 hex",
  "inputs": {
    "daily": ["YYYY-MM-DD"],
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

The arrays contain sorted unit keys that were fully applied. `summary` preserves
the base return fields (`dailyDates` through `files`); runtime return values add
`staged`, `switched`, `previousDir`, and, only during post-switch recovery,
`recovered`.

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

## Scope and safety checks

- `git diff --check`: clean.
- Network calls: none.
- Real `data/` scripts: none.
- Main worktree operations: none after reading its required `AGENTS.md`.
- `launchctl`, `~/Library/**`, and `~/bin/**`: untouched.
- Existing tests modified: none.
- Generated `data/**`: not staged or hand-edited.
