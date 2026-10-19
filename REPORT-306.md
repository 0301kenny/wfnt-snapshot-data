# BLOCKED

TICKET-306 r1 Executor status: `BLOCKED`.

## Stop trigger

Contract Stop / Escalate 3 was triggered: Hard Fact 8 does not match base commit `7bc16ac2dcada9a5df47d5b11e88045be5a5d265` in the required worktree.

Hard Fact 8 states that the existing tests calling `buildDerived({ rootDir })` are at `tests/run.test.mjs:696-705,746,848` and `tests/taifex-vix.test.mjs:414-417`. On the stated base, `tests/run.test.mjs` also contains existing calls at lines 904, 1054, 1092, and 1143:

```text
tests/run.test.mjs:701:    const summary = await buildDerived({ rootDir: root });
tests/run.test.mjs:705:    await buildDerived({ rootDir: root });
tests/run.test.mjs:746:    const summary = await buildDerived({ rootDir: root });
tests/run.test.mjs:848:    const rebuiltSummary = await buildDerived({ rootDir: root });
tests/run.test.mjs:904:    await buildDerived({ rootDir: root });
tests/run.test.mjs:1054:    await buildDerived({ rootDir: root });
tests/run.test.mjs:1092:    await buildDerived({ rootDir: root });
tests/run.test.mjs:1143:    await buildDerived({ rootDir: root });
tests/taifex-vix.test.mjs:417:    const summary = await buildDerived({ rootDir: root });
```

Because the Contract declares itself the only authority and requires an immediate stop when any Hard Fact is false, no implementation, production code change, test change, ablation, or CLI exercise was performed.

## Environment evidence

- Worktree: `/Users/zhengweizhu/Projects/wfnt-snapshot-data-t306`
- Branch: `ticket-306`
- HEAD before this report: `7bc16ac2dcada9a5df47d5b11e88045be5a5d265`
- `data` is the untracked symlink `data -> ../wfnt-snapshot-data/data`; it was not written or staged.
- Baseline command before the stop: `node --test tests/`
- Baseline result: 315 tests, 315 pass, 0 fail.

## Required Evidence disposition

The Contract's implementation evidence, four ablations, and temporary-root CLI transcripts are not applicable because Stop 3 prohibited proceeding past the Hard Fact audit. Continuing merely to manufacture those artifacts would violate the Contract.

## Escalation needed

The Orchestrator must reconcile Hard Fact 8 with base `7bc16ac` and issue an authoritative Contract revision or explicit direction before implementation can resume.
