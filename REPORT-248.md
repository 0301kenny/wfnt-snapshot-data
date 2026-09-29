READY_FOR_REVIEW

# TICKET-248 Execution Report

## 1. Diff summary

- `scripts/run.mjs`: added `manifest.paths.insider = 'data/derived/insider/{p2}/{id}.json';` beside the existing derived path assignments.
- `tests/run.test.mjs`: added one exact-equality assertion for `m.paths.insider` in the existing manifest contract assertion group.
- Implementation diff: 2 files changed, 2 insertions.
- No real `data/` files were modified, and `build-derived` was not run.

## 2. Ablation evidence

Command:

```sh
node --test --test-name-pattern="first run writes raw paths and manifest contract" tests/run.test.mjs
```

- With the `manifest.paths.insider` assignment removed temporarily: 1 test, 0 pass, 1 fail; exit code 1.
- Failure message: `Expected values to be strictly equal: actual undefined, expected 'data/derived/insider/{p2}/{id}.json'` (`ERR_ASSERTION`, `tests/run.test.mjs:300:12`).
- After restoring the assignment: the targeted test passed (1 test, 1 pass, 0 fail; exit code 0).

## 3. Full test suite

Command:

```sh
node --test tests/
```

Result: exit code 0; tests 161; pass 161; fail 0; cancelled 0; skipped 0; todo 0.

## 4. Review status

All three acceptance criteria are satisfied. Changes remain uncommitted in the `ticket-248` working tree for Orchestrator review.
