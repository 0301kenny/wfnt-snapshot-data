import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { applyTdccWeek } from '../scripts/lib/derived.mjs';

const TDCC_COLS = ['w', 'big1000', 'big400', 'retail', 'holders', 'avgShares', 'holders50'];

async function withTempRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-tdcc-lock-test-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function tdccCsv(isoDate) {
  const date = isoDate.replaceAll('-', '');
  const grades = [
    [1, 1, 100, 1], [2, 2, 200, 2], [3, 3, 300, 3], [4, 4, 400, 4],
    [5, 5, 500, 5], [6, 6, 600, 6], [7, 7, 700, 7], [8, 8, 800, 8],
    [12, 12, 1200, 12], [13, 13, 1300, 13], [14, 14, 1400, 14],
    [15, 15, 1500, 15], [17, 100, 10000, 100],
  ];
  return [
    '資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%',
    ...grades.map(([grade, holders, shares, ratio]) => (
      [date, '2330', grade, holders, shares, ratio].join(',')
    )),
  ].join('\n');
}

async function writeWeek(root, isoDate) {
  const path = join(root, 'data', 'raw', 'tdcc', isoDate.slice(0, 4), `${isoDate}.csv.gz`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, gzipSync(tdccCsv(isoDate)));
}

function lockPath(root) {
  return join(root, 'data', 'derived', '.tdcc.lock');
}

async function createLock(root, pid = process.pid) {
  const path = lockPath(root);
  await mkdir(path, { recursive: true });
  if (pid !== null) await writeFile(join(path, 'pid'), `${pid}\n`);
  return path;
}

async function readSeries(root) {
  const path = join(root, 'data', 'derived', 'tdcc', '23', '2330.json');
  return JSON.parse(await readFile(path, 'utf8'));
}

function expectedRow(isoDate) {
  return [Number(isoDate.replaceAll('-', '')), 15, 54, 6, 100, 100, 36];
}

async function assertMissing(path) {
  await assert.rejects(readFile(path), { code: 'ENOENT' });
}

async function startLockOwner(path) {
  const source = `
    import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
    const lockPath = process.env.TDCC_TEST_LOCK_PATH;
    process.on('message', (message) => {
      if (message === 'acquire') {
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath);
        writeFileSync(lockPath + '/pid', process.pid + '\\n');
        process.send({ type: 'acquired', pid: process.pid });
      }
    });
    process.send({ type: 'ready' });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TDCC_TEST_LOCK_PATH: path },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const [ready] = await once(child, 'message');
  assert.deepEqual(ready, { type: 'ready' });
  return {
    child,
    async acquire() {
      const acquired = once(child, 'message');
      child.send('acquire');
      const [message] = await acquired;
      assert.equal(message.type, 'acquired');
      assert.equal(message.pid, child.pid);
    },
  };
}

async function stopLockOwner(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('applyTdccWeek waits for a live owner and then writes the expected series', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    const path = await createLock(root);
    const release = setTimeout(() => void rm(path, { recursive: true, force: true }), 300);
    const startedAt = Date.now();
    try {
      assert.deepEqual(
        await applyTdccWeek(root, '2026-10-01', { lockPollMs: 20, lockTimeoutMs: 1_000 }),
        { tdcc: 1 },
      );
    } finally {
      clearTimeout(release);
    }
    assert.ok(Date.now() - startedAt >= 250);
    assert.deepEqual(await readSeries(root), {
      id: '2330', updated: '2026-10-01', cols: TDCC_COLS, rows: [expectedRow('2026-10-01')],
    });
  });
});

test('applyTdccWeek removes a lock owned by a nonexistent pid without waiting', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    const path = await createLock(root, 2_147_483_647);
    const startedAt = Date.now();
    await applyTdccWeek(root, '2026-10-01', { lockPollMs: 20, lockTimeoutMs: 1_000 });
    assert.ok(Date.now() - startedAt < 250);
    await assertMissing(path);
    assert.deepEqual((await readSeries(root)).rows, [expectedRow('2026-10-01')]);
  });
});

test('applyTdccWeek removes an old pidless lock as stale', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    const path = await createLock(root, null);
    const old = new Date(Date.now() - 120_000);
    await utimes(path, old, old);
    await applyTdccWeek(root, '2026-10-01', { lockPollMs: 20, lockTimeoutMs: 1_000 });
    await assertMissing(path);
    assert.deepEqual((await readSeries(root)).rows, [expectedRow('2026-10-01')]);
  });
});

test('applyTdccWeek treats a fresh pidless lock as busy until timeout', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    const path = await createLock(root, null);
    await assert.rejects(
      applyTdccWeek(root, '2026-10-01', { lockPollMs: 10, lockTimeoutMs: 50 }),
      (error) => error.message.includes('busy') && error.message.includes(path),
    );
    await assertMissing(join(root, 'data', 'derived', 'tdcc', '23', '2330.json'));
  });
});

test('applyTdccWeek times out on a live owner without deleting its lock', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    const path = await createLock(root);
    await assert.rejects(
      applyTdccWeek(root, '2026-10-01', { lockPollMs: 10, lockTimeoutMs: 50 }),
      (error) => error.message.includes('busy') && error.message.includes(path),
    );
    assert.equal(await readFile(join(path, 'pid'), 'utf8'), `${process.pid}\n`);
  });
});

test('applyTdccWeek releases its lock when the raw week is missing', async () => {
  await withTempRoot(async (root) => {
    const path = lockPath(root);
    await assert.rejects(
      applyTdccWeek(root, '2026-10-01', { lockPollMs: 10, lockTimeoutMs: 50 }),
      { code: 'ENOENT' },
    );
    await assertMissing(path);
  });
});

test('concurrent applyTdccWeek calls preserve both weeks', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    await writeWeek(root, '2026-10-08');
    assert.deepEqual(
      await Promise.all([
        applyTdccWeek(root, '2026-10-01', { lockPollMs: 10, lockTimeoutMs: 1_000 }),
        applyTdccWeek(root, '2026-10-08', { lockPollMs: 10, lockTimeoutMs: 1_000 }),
      ]),
      [{ tdcc: 1 }, { tdcc: 1 }],
    );
    assert.deepEqual((await readSeries(root)).rows, [
      expectedRow('2026-10-01'),
      expectedRow('2026-10-08'),
    ]);
    await assertMissing(lockPath(root));
  });
});

test('stale cleanup rechecks under the break lock and preserves a replacement owner', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    const path = await createLock(root, 2_147_483_647);
    const owner = await startLockOwner(path);
    let staleDetections = 0;
    try {
      await assert.rejects(
        applyTdccWeek(root, '2026-10-01', {
          lockPollMs: 10,
          lockTimeoutMs: 50,
          _testHooks: {
            afterStaleDetected: async () => {
              staleDetections += 1;
              await owner.acquire();
            },
          },
        }),
        (error) => error.message.includes('busy') && error.message.includes(path),
      );
      assert.equal(staleDetections, 1);
      assert.equal(await readFile(join(path, 'pid'), 'utf8'), `${owner.child.pid}\n`);
      await assertMissing(join(root, 'data', 'derived', 'tdcc', '23', '2330.json'));
    } finally {
      await stopLockOwner(owner.child);
    }
  });
});

test('release preserves a main lock that another process acquired', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    const path = lockPath(root);
    const owner = await startLockOwner(path);
    try {
      assert.deepEqual(
        await applyTdccWeek(root, '2026-10-01', {
          _testHooks: { beforeRelease: () => owner.acquire() },
        }),
        { tdcc: 1 },
      );
      assert.equal(await readFile(join(path, 'pid'), 'utf8'), `${owner.child.pid}\n`);
    } finally {
      await stopLockOwner(owner.child);
    }
  });
});
