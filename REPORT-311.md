# REPORT-311

status: READY_FOR_REVIEW

Executor: Claude cc-executor (fallback after codex quota exhaustion; codex produced zero output, so this
is single-author work from base 7664a8e).

## 1. Changes

- `scripts/endpoints.mjs`: four daily `BACKFILL_ENDPOINTS` (`twse_qfiis_hist`, `twse_twt53u_hist`,
  `twse_twtb4u_hist`, `twse_bfiauu_hist`) after `twse_sbl_hist`; monthly `twse_mfi94u_hist` at the end.
- `scripts/lib/history-backfill.mjs`: `parseTwseStructure` (stat OK, a table whose first field is
  證券代號, every row width = its table's fields); four `DAILY_ENDPOINTS` entries; `minIso` support
  (twtb4u `2014-01-06`, skipped before recordEndpoint so nothing is requested or counted). Old progress
  files already tolerated by `recordEndpoint` (`??=`).
- `scripts/detect-gaps.mjs`: `COVERAGE_SOURCES.twse` gains the four datasets.
- `scripts/backfill-twse-return-index.mjs` (new): monthly CLI + `runTwseReturnIndexBackfill`,
  `twseReturnIndexBackfillOptionsFromArgs`, `validateTwseReturnIndexMonth`. Raw only.
- Tests: `tests/twse-w3-daily.test.mjs`, `tests/twse-return-index.test.mjs` (new);
  `tests/all.mjs` (imports only); `tests/backfill.test.mjs` key list (authorized lines only);
  `tests/history-backfill.test.mjs`: `fixtureFetcher` gains `w3` option + 4 URL branches, `30` -> `42`,
  four tests appended at file end.
- `README.md`, `AGENTS.md`: documentation of the new endpoints/rules.

removed_capabilities: none (comparison: `git diff --numstat` shows deletions only on the 2 authorized
test lines (`30`->`42`, none other) and 2 AGENTS.md/README replaced-in-place sentence fragments).

## 2. `node --test tests/` (worktree)

```
# tests 376
# pass 376
# fail 0
```
Baseline 352; +24 (oracle >= 362).

## 3. Ablations (each restored afterwards; final run 376/376 green)

1. Remove the twtb4u 2014-01-06 lower bound (`minIso` check): red -
   `W3 daily endpoints: three run on every trading day, day trading only from 2014-01-06`,
   `W3 day trading is neither requested nor counted before 2014-01-06`.
2. Validation ignores row width: red - `W3 empty block-trade day is unavailable and unwritten; malformed
   rows are quarantined`, `one row with the wrong width quarantines the response`,
   `width is checked on every table of a multi-table response`.
3. Monthly date not trimmed (leading space breaks the ROC regex): red - `2006-10 response with
   space-padded ROC dates is stored byte-identical, and no derived appears`, `invalid shapes fail the
   month and the run continues with the next month`, `a historical month with valid raw is skipped
   without a request`, `a historical month with invalid raw is refetched and repaired`.
4. Current month also skipped when raw exists: red - `the Taipei current month is requested even when
   raw exists, and rewrites on change only`.

## 4. Monthly runner on a temp root (no network; fetcher reads local sample files)

```
[backfill-twse-return-index] range 2006-10..2006-10 out=<scratch>/root.Zcz7 delay=0ms
[ok] 2006-10 rows=20
[done] months=1 requests=1 skipped=0 rawWritten=1 rows=20 failed=0
[backfill-twse-return-index] range 2006-10..2006-10 out=<scratch>/root.Zcz7 delay=0ms
[skip] 2006-10 rows=20
[done] months=1 requests=0 skipped=1 rawWritten=0 rows=20 failed=0
```
The CLI has no fetcher injection point, so this uses `runTwseReturnIndexBackfill`. Only
`data/raw/twse/mfi94u_hist/2006/2006-10.json` was created.

## Notes

- Test fixtures embed rows copied verbatim from the Contract's Hard Facts / samples (space-padded
  dates, total row); the sample files themselves live outside this repo.
- No Stop/Escalate clause triggered.
