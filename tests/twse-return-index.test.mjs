import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BACKFILL_ENDPOINTS } from '../scripts/endpoints.mjs';
import {
  runTwseReturnIndexBackfill,
  twseReturnIndexBackfillOptionsFromArgs,
} from '../scripts/backfill-twse-return-index.mjs';

const FIELDS = ['日　期', '發行量加權股價報酬指數'];
const NOW = () => new Date('2026-10-17T04:00:00Z');
const silent = { log() {}, warn() {}, error() {} };

// Verbatim leading rows of the official 2006-10 response (two-digit ROC year is space-padded).
const ROWS_2006 = [[' 95/10/02', '7,957.37'], [' 95/10/03', '7,952.72'], [' 95/10/31', '8,027.01']];
const ROWS_2026 = [['115/10/01', '111,811.08'], ['115/10/30', '104,547.47']];

function body(rows, extra = {}) {
  return Buffer.from(JSON.stringify({ stat: 'OK', title: 't', date: '20061016', fields: FIELDS, data: rows, total: rows.length, ...extra }));
}

function response(bytes, ok = true) {
  return {
    ok,
    status: ok ? 200 : 503,
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-twse-return-index-test-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const histPath = (root, month) => join(root, 'data/raw/twse/mfi94u_hist', month.slice(0, 4), `${month}.json`);

async function exists(path) {
  try { await readFile(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function put(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function options(root, month, fetcher, extra = {}) {
  return { rootDir: root, fromMonth: month, toMonth: month, delayMs: 0, now: NOW, fetcher, logger: silent, ...extra };
}

test('return index endpoint is monthly and queries the first day of the month', () => {
  const endpoint = BACKFILL_ENDPOINTS.twse_mfi94u_hist;
  assert.equal(endpoint.cadence, 'monthly');
  assert.equal(endpoint.sourceDataset, 'twse/mfi94u_hist');
  assert.equal(
    endpoint.url('2006-10'),
    'https://www.twse.com.tw/rwd/zh/TAIEX/MFI94U?date=20061001&response=json',
  );
});

test('2006-10 response with space-padded ROC dates is stored byte-identical, and no derived appears', async () => {
  await withTempDir(async (root) => {
    const bytes = body(ROWS_2006);
    const summary = await runTwseReturnIndexBackfill(options(root, '2006-10', async () => response(bytes)));
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.rawWritten, 1);
    assert.deepEqual(await readFile(histPath(root, '2006-10')), bytes);
    assert.deepEqual(await readdir(join(root, 'data')), ['raw']);
  });
});

test('three-digit ROC years (2026-10) are accepted', async () => {
  await withTempDir(async (root) => {
    const bytes = body(ROWS_2026);
    const summary = await runTwseReturnIndexBackfill(options(root, '2026-10', async () => response(bytes)));
    assert.equal(summary.failures.length, 0);
    assert.deepEqual(await readFile(histPath(root, '2026-10')), bytes);
  });
});

test('a row dated outside the queried month fails the month and writes nothing', async () => {
  await withTempDir(async (root) => {
    const bytes = body([...ROWS_2006.slice(0, 2), [' 95/11/01', '1.00']]);
    const summary = await runTwseReturnIndexBackfill(options(root, '2006-10', async () => response(bytes)));
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].month, '2006-10');
    assert.equal(await exists(histPath(root, '2006-10')), false);
  });
});

test('invalid shapes fail the month and the run continues with the next month', async () => {
  const bad = {
    stat: Buffer.from(JSON.stringify({ stat: 'ERR', fields: FIELDS, data: ROWS_2006 })),
    fields: Buffer.from(JSON.stringify({ stat: 'OK', fields: ['日期', '指數'], data: ROWS_2006 })),
    empty: body([]),
    width: body([[' 95/10/02', '1', 'x']]),
    unparseable: body([['95-10-02', '1']]),
  };
  for (const [name, bytes] of Object.entries(bad)) {
    await withTempDir(async (root) => {
      const good = body([[' 95/11/01', '1.00']]);
      const summary = await runTwseReturnIndexBackfill({
        ...options(root, '2006-10', async (url) => response(url.includes('=20061001') ? bytes : good)),
        toMonth: '2006-11',
      });
      assert.equal(summary.failures.length, 1, name);
      assert.equal(await exists(histPath(root, '2006-10')), false, name);
      assert.equal(await exists(histPath(root, '2006-11')), true, name);
    });
  }
});

test('an HTTP error fails the month without writing', async () => {
  await withTempDir(async (root) => {
    const summary = await runTwseReturnIndexBackfill(options(root, '2006-10', async () => response(Buffer.from('x'), false)));
    assert.equal(summary.failures.length, 1);
    assert.equal(await exists(histPath(root, '2006-10')), false);
  });
});

test('a historical month with valid raw is skipped without a request', async () => {
  await withTempDir(async (root) => {
    const bytes = body(ROWS_2006);
    await put(histPath(root, '2006-10'), bytes);
    let calls = 0;
    const summary = await runTwseReturnIndexBackfill(options(root, '2006-10', async () => { calls += 1; return response(bytes); }));
    assert.equal(calls, 0);
    assert.equal(summary.skipped, 1);
  });
});

test('a historical month with invalid raw is refetched and repaired', async () => {
  await withTempDir(async (root) => {
    await put(histPath(root, '2006-10'), Buffer.from('{broken'));
    const bytes = body(ROWS_2006);
    let calls = 0;
    await runTwseReturnIndexBackfill(options(root, '2006-10', async () => { calls += 1; return response(bytes); }));
    assert.equal(calls, 1);
    assert.deepEqual(await readFile(histPath(root, '2006-10')), bytes);
  });
});

test('the Taipei current month is requested even when raw exists, and rewrites on change only', async () => {
  await withTempDir(async (root) => {
    await put(histPath(root, '2026-10'), body(ROWS_2026.slice(0, 1)));
    const fresh = body(ROWS_2026);
    let calls = 0;
    const fetcher = async () => { calls += 1; return response(fresh); };
    const first = await runTwseReturnIndexBackfill(options(root, '2026-10', fetcher));
    assert.equal(calls, 1);
    assert.equal(first.rawWritten, 1);
    assert.deepEqual(await readFile(histPath(root, '2026-10')), fresh);
    const second = await runTwseReturnIndexBackfill(options(root, '2026-10', fetcher));
    assert.equal(calls, 2);
    assert.equal(second.rawWritten, 0);
  });
});

test('--to later than the Taipei current month is rejected', async () => {
  await withTempDir(async (root) => {
    await assert.rejects(
      runTwseReturnIndexBackfill(options(root, '2026-11', async () => assert.fail('no request'))),
      /current month/,
    );
    assert.throws(
      () => twseReturnIndexBackfillOptionsFromArgs({ from: '2026-10', to: '2026-11' }, { now: NOW }),
      /current month/,
    );
    assert.throws(
      () => twseReturnIndexBackfillOptionsFromArgs({ from: '2026-10', to: '2026-10', 'delay-ms': true }, { now: NOW }),
      /delay-ms/,
    );
  });
});

test('CLI rejects a future --to before any request', async () => {
  const script = fileURLToPath(new URL('../scripts/backfill-twse-return-index.mjs', import.meta.url));
  await withTempDir(async (root) => {
    const child = spawnSync(process.execPath, [script, '--from', '2099-01', '--to', '2099-02', '--out', root], { encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.equal(await exists(join(root, 'data')), false);
  });
});
