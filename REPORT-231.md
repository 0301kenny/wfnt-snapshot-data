# TICKET-231 Executor Report

Status: **READY_FOR_REVIEW**  
Branch: `ticket-231`  
Base HEAD: `3ff1e31c2b53ac62a080f257f780c4c3cd12cb9a`  
Final test count: **133 pass / 0 fail** (baseline: 123 pass / 0 fail)

No real network request was made. No command ran `build-derived.mjs` against the real `data/` tree. No `data/**` file, including `data/raw/taifex/vix_monthly/**`, was edited. No commit was created.

## Acceptance

### A1 — PASS: existing tests do not regress and total tests increased

Command and actual final summary:

```text
$ rtk node --test tests/
1..133
# tests 133
# suites 0
# pass 133
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7444.320664
exit_code=0
```

`133 > 123`, and the barrel drift guard also ran as test 133:

```text
# Subtest: every test module is imported by the test barrel
ok 133 - every test module is imported by the test barrel
```

### A2 — PASS: parser selects foreign rows, index 13, negative values, ascending order

Command: `rtk node --test tests/taifex-foreign-futures.test.mjs`

Actual output:

```text
# Subtest: TAIFEX foreign futures parser selects only foreign rows at index 13, preserves negatives, and sorts
ok 1 - TAIFEX foreign futures parser selects only foreign rows at index 13, preserves negatives, and sorts
# A2_FOREIGN_FUTURES_ROWS=[[20240301,-1493],[20240329,-754],[20260701,-84168],[20260731,-82515]]
```

The Big5 fixture contains dealer, investment-trust, and foreign-investor rows for every date, in descending date order. Only the foreign row is emitted, and all four HF5 measured values are asserted.

### A3 — PASS: short and non-numeric rows throw explicitly

Actual output from the same test command:

```text
# Subtest: TAIFEX foreign futures parser throws for short and non-numeric foreign rows
ok 2 - TAIFEX foreign futures parser throws for short and non-numeric foreign rows
# A3_SHORT_ROW=THREW A3_NON_NUMERIC=THREW
```

The exact assertions require `has 5 columns, expected at least 15` and `non-numeric net open interest at 2026-07-31`.

### A4 — PASS: HTTP 200 DateTime error fails, retries, and writes no raw

Actual output from the same test command:

```text
# Subtest: HTTP 200 DateTime error retries with backoff, fails, and writes no foreign-futures raw
ok 4 - HTTP 200 DateTime error retries with backoff, fails, and writes no foreign-futures raw
# A4_HTTP=200 A4_DATETIME_ERROR=true A4_FETCH_CALLS=3 A4_BACKOFFS=25,50 A4_RAW_EXISTS=false
```

There is an additional negative control proving that even parseable data rows are rejected when the first line is not the Big5 `日期,` header:

```text
# Subtest: foreign futures raw validation requires the first line to start with the Big5 日期 header
ok 5 - foreign futures raw validation requires the first line to start with the Big5 日期 header
```

### A5 — PASS: default backfill start follows an injected clock

Actual output from the same test command:

```text
# Subtest: foreign futures default range follows the injected clock instead of a fixed date
ok 7 - foreign futures default range follows the injected clock instead of a fixed date
# A5_CLOCK_2026_09={"fromMonth":"2023-10","toMonth":"2026-08"} A5_CLOCK_2026_10={"fromMonth":"2023-11","toMonth":"2026-09"}
```

The test also checks the Asia/Taipei month boundary (`2026-09-30T16:30:00Z` is October 1 in Taipei).

### A6 — PASS: `taifex.fut` upsert and byte idempotence

Actual output from the same test command:

```text
# Subtest: foreign futures derived upsert preserves all six existing market series and is byte-idempotent
ok 8 - foreign futures derived upsert preserves all six existing market series and is byte-idempotent
# A6_TAIFEX_FUT={"cols":["d","net"],"rows":[[20260701,-84168],[20260731,-82515]]} A6_SECOND_WRITE=false A6_BYTES_EQUAL=true A6_EXISTING_SERIES_PRESERVED=true
```

The seeded `twse.index`, `twse.margin`, `tpex.index`, `tpex.margin`, `tpex.insti`, and `taifex.pcr` series are all compared after the upsert. The second run returns `market: false` and leaves bytes identical.

### A7 — PASS: isolated full rebuild from foreign-futures raw

Actual output from the same test command:

```text
# Subtest: buildDerived rebuilds foreign futures market data from isolated raw
ok 9 - buildDerived rebuilds foreign futures market data from isolated raw
# A7_BUILD_SUMMARY={"dailyDates":0,"taifexPcrMonths":0,"taifexForeignFuturesMonths":1,"monthlyMonths":0,"quarterlySeasons":0,"tdccWeeks":0,"macroSeries":0,"files":1} A7_TAIFEX_FUT={"cols":["d","net"],"rows":[[20260701,-84168],[20260731,-82515]]}
```

The test creates a fresh `mkdtemp` root containing only `data/raw/taifex/foreign_futures/**`; the repository's real `data/` is not used.

### A8 — PASS: PCR test file unchanged and standalone suite green

Required diff-stat command; stdout is empty and exit code is 0:

```text
$ rtk proxy git diff --stat -- tests/taifex-pcr.test.mjs
```

Standalone actual summary:

```text
$ rtk node --test tests/taifex-pcr.test.mjs
1..9
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 167.571808
pcr_exit_code=0
```

Representative shared-path evidence from that unchanged suite:

```text
# PCR_RAW_BYTES_PRESERVED=true CHECKPOINT_MTIME_UNCHANGED=true
# A4_HTTP=200 A4_ROWS=0 A4_FETCH_CALLS=3 A4_BACKOFFS=25,50 A4_RAW_EXISTS=false
# A5_TAIFEX_PCR={"cols":["d","vol","oi"],"rows":[[20260803,102.71,97.66],[20260831,118.35,96.12]]} A5_SECOND_WRITE=false A5_BYTES_EQUAL=true
```

## Files changed

- `AGENTS.md` — expanded the TAIFEX endpoint allowlist wording and added the foreign-futures raw-path/validation rule; no existing rule was removed.
- `scripts/endpoints.mjs` — appended `taifex_foreign_futures` to `BACKFILL_ENDPOINTS` with monthly cadence, the contracted source dataset, and official URL.
- `scripts/lib/taifex-monthly-backfill.mjs` — new shared implementation for month validation/iteration, calendar request bodies, Big5 header plus data-row validation, raw pathing, read-valid checkpointing, write-on-change, exponential backoff, per-month continuation, summaries, and long-option parsing.
- `scripts/backfill-pcr.mjs` — reduced to a PCR adapter over the shared implementation while retaining its exports, endpoint, request body, parser, derived callback injection, CLI flags, defaults, messages, and behavior.
- `scripts/backfill-foreign-futures.mjs` — new TXF foreign-futures monthly adapter, dynamic Asia/Taipei default range, POST form parameters, injectable clock/fetch/sleep/derived hooks, and shared numeric CLI guards.
- `scripts/lib/derived.mjs` — added strict foreign-futures Big5 parser, `taifex.fut` schema (`["d","net"]`), market normalization/update participation, and monthly upsert through the existing `upsertSeries` and write-on-change path; PCR Big5 decoding now uses the shared helper.
- `scripts/build-derived.mjs` — discovers `foreign_futures` monthly CSV raw and replays it into `market.json`; reports `taifexForeignFuturesMonths`.
- `tests/backfill.test.mjs` — only appended the new registry key and its cadence/source/URL assertions; `ENDPOINTS.length` remains 17 and existing key order/content is unchanged.
- `tests/all.mjs` — only appended the new test-module import.
- `tests/taifex-foreign-futures.test.mjs` — new 10-test fixture suite covering A2–A7 plus POST/raw/checkpoint behavior, strict header validation, per-month continuation, and bare numeric flag guards.
- `REPORT-231.md` — this acceptance report.

## `removed_capabilities`

```yaml
removed_capabilities: []
```

- `AGENTS.md` allowlist: one official TAIFEX backfill endpoint was added; no endpoint or permission was removed.
- PCR common-module extraction: no supported PCR behavior or public export was removed. The unchanged 9-test PCR suite passes. The shared raw validator additionally enforces the official `日期,` header, so malformed/headerless bytes that are not valid official raw are rejected; this is validation hardening, not removal of a supported capability.
- Existing six `market.json` series retain their columns and rows during `taifex.fut` upserts; no daily pipeline endpoint or derived transformation was removed.

## Choices made where the contract left latitude

1. **Dynamic default range:** use the first complete calendar month after the approximately three-year rolling boundary, and end at the previous complete calendar month. This avoids predictable HTTP-200 DateTime errors at the partial oldest month and avoids future dates in the incomplete current month. Both boundaries use Asia/Taipei calendar time and move with the injected clock. Explicit `--from` / `--to` still override them.
2. **Shared seam shape:** use one adapter-driven monthly runner rather than inheritance or a second script copy. PCR and foreign futures share iteration, pathing, validation, checkpointing, byte-preserving writes, retry/backoff, continuation, and summary behavior; only endpoint/form/parser/derived adapters differ.
3. **Validation order:** parse first and report zero data rows before checking the header. This preserves PCR's existing error text for HTTP-200 HTML pages while still enforcing the contracted first-line marker for any otherwise parseable response.
4. **Full rebuild order:** replay PCR first and foreign futures second. Both normalize and preserve the other series, and `market.updated` is recomputed as the maximum date across all seven market series, so the order does not alter final bytes.
5. **Test fixtures:** embed official-format Big5 header/identity bytes and HF5 measured values directly in the new test module. This keeps acceptance offline and avoids adding a fixture format or dependency.

