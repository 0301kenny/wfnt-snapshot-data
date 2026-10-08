import test from 'node:test';
import assert from 'node:assert/strict';
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

function tdccCsv(isoDate, ids = ['2330']) {
  const date = isoDate.replaceAll('-', '');
  const grades = [
    [1, 1, 100, 1], [2, 2, 200, 2], [3, 3, 300, 3], [4, 4, 400, 4],
    [5, 5, 500, 5], [6, 6, 600, 6], [7, 7, 700, 7], [8, 8, 800, 8],
    [12, 12, 1200, 12], [13, 13, 1300, 13], [14, 14, 1400, 14],
    [15, 15, 1500, 15], [17, 100, 10000, 100],
  ];
  return [
    '資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%',
    ...ids.flatMap((id) => grades.map(([grade, holders, shares, ratio]) => (
      [date, id, grade, holders, shares, ratio].join(',')
    ))),
  ].join('\n');
}

async function writeWeek(root, isoDate, ids) {
  const path = join(root, 'data', 'raw', 'tdcc', isoDate.slice(0, 4), `${isoDate}.csv.gz`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, gzipSync(tdccCsv(isoDate, ids)));
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

async function waitForPid(path, pid) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(join(path, 'pid'), 'utf8')).trim() === String(pid)) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for pid ${pid} in ${path}`);
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

test('applyTdccWeek times out without removing a lock owned by a nonexistent pid', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    const path = await createLock(root, 2_147_483_647);
    await assert.rejects(
      applyTdccWeek(root, '2026-10-01', { lockPollMs: 10, lockTimeoutMs: 50 }),
      /busy/,
    );
    assert.equal(await readFile(join(path, 'pid'), 'utf8'), '2147483647\n');
    await assertMissing(join(root, 'data', 'derived', 'tdcc', '23', '2330.json'));
  });
});

test('applyTdccWeek times out without removing an old pidless lock', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    const path = await createLock(root, null);
    const old = new Date(Date.now() - 120_000);
    await utimes(path, old, old);
    await assert.rejects(
      applyTdccWeek(root, '2026-10-01', { lockPollMs: 10, lockTimeoutMs: 50 }),
      /busy/,
    );
    await assert.rejects(mkdir(path), { code: 'EEXIST' });
    await assertMissing(join(path, 'pid'));
  });
});

test('timeout error identifies the busy lock, owner pid, and manual cleanup action', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-01');
    const path = await createLock(root);
    await assert.rejects(
      applyTdccWeek(root, '2026-10-01', { lockPollMs: 10, lockTimeoutMs: 50 }),
      (error) => error.message.includes('busy')
        && error.message.includes(path)
        && error.message.includes(`pid=${process.pid}`)
        && error.message.includes('confirm no TDCC derived writer is running')
        && error.message.includes('remove this lock directory manually'),
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

test('applyTdccWeek does not release a lock whose pid changes while it is held', async () => {
  await withTempRoot(async (root) => {
    const ids = Array.from({ length: 40 }, (_, index) => String(3000 + index));
    await writeWeek(root, '2026-10-01', ids);
    const path = lockPath(root);
    const applying = applyTdccWeek(root, '2026-10-01');
    await waitForPid(path, process.pid);
    await writeFile(join(path, 'pid'), '2147483647\n');
    assert.deepEqual(await applying, { tdcc: 40 });
    assert.equal(await readFile(join(path, 'pid'), 'utf8'), '2147483647\n');
  });
});
