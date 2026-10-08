import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { applyTdccWeek, pendingTdccWeeks } from '../scripts/lib/derived.mjs';
import { runSnapshot } from '../scripts/run.mjs';

async function withTempRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-tdcc-pending-test-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function tdccCsv(isoDate) {
  const date = isoDate.replaceAll('-', '');
  return [
    '資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%',
    `${date},2330,1,10,100,1.5`,
    `${date},2330,15,2,2000,20`,
    `${date},2330,17,20,4000,100`,
    '',
  ].join('\n');
}

function rawWeekPath(root, isoDate) {
  return join(root, 'data', 'raw', 'tdcc', isoDate.slice(0, 4), `${isoDate}.csv.gz`);
}

function appliedWeeksPath(root) {
  return join(root, 'data', 'derived', '.tdcc-applied-weeks.json');
}

async function writeWeek(root, isoDate, bytes = gzipSync(tdccCsv(isoDate))) {
  const path = rawWeekPath(root, isoDate);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function readAppliedWeeks(root) {
  return JSON.parse(await readFile(appliedWeeksPath(root), 'utf8'));
}

function response(body) {
  const bytes = Buffer.from(body, 'utf8');
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

async function runTwseSnapshot(root) {
  const bodies = new Map([
    [
      'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',
      JSON.stringify([{ '日期': '1151005', '指數': '寶島股價指數', '收盤指數': '1' }]),
    ],
    [
      'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      JSON.stringify([{
        Date: '1151005',
        Code: '2330',
        Name: '台積電',
        TradeVolume: '100',
        ClosingPrice: '50',
      }]),
    ],
  ]);
  return runSnapshot({
    rootDir: root,
    datasets: ['twse_stock_day_all'],
    now: () => new Date('2026-10-05T13:45:00Z'),
    fetcher: async (url) => {
      assert.ok(bodies.has(url), `unexpected URL ${url}`);
      return response(bodies.get(url));
    },
  });
}

test('missing applied-weeks record leaves every raw TDCC week pending', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-09-24');
    await writeWeek(root, '2026-10-02');

    assert.deepEqual(await pendingTdccWeeks(root), ['2026-09-24', '2026-10-02']);
    await assert.rejects(readFile(appliedWeeksPath(root)), { code: 'ENOENT' });
  });
});

test('truncated applied-weeks record is treated as empty and repaired after apply', async (t) => {
  await withTempRoot(async (root) => {
    const warnings = [];
    t.mock.method(console, 'warn', (message) => warnings.push(String(message)));
    await writeWeek(root, '2026-09-24');
    await writeWeek(root, '2026-10-02');
    await mkdir(dirname(appliedWeeksPath(root)), { recursive: true });
    await writeFile(appliedWeeksPath(root), '["2026-09-24"');

    assert.deepEqual(await pendingTdccWeeks(root), ['2026-09-24', '2026-10-02']);
    assert.deepEqual(await applyTdccWeek(root, '2026-09-24'), { tdcc: 1 });
    assert.deepEqual(await readAppliedWeeks(root), ['2026-09-24']);
    assert.deepEqual(await pendingTdccWeeks(root), ['2026-10-02']);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((warning) => (
      warning.includes('invalid TDCC applied weeks record')
      && warning.includes('treating as empty')
      && !warning.includes('\n')
    )));
  });
});

test('successful apply records only that TDCC week and removes it from pending', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-09-24');
    await writeWeek(root, '2026-10-02');

    assert.deepEqual(await applyTdccWeek(root, '2026-09-24'), { tdcc: 1 });
    assert.deepEqual(await readAppliedWeeks(root), ['2026-09-24']);
    assert.deepEqual(await pendingTdccWeeks(root), ['2026-10-02']);
  });
});

test('busy TDCC lock does not record the failed week and leaves it pending', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-02');
    const lockPath = join(root, 'data', 'derived', '.tdcc.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'pid'), `${process.pid}\n`);

    await assert.rejects(
      applyTdccWeek(root, '2026-10-02', { lockPollMs: 5, lockTimeoutMs: 20 }),
      /busy/,
    );
    assert.deepEqual(await pendingTdccWeeks(root), ['2026-10-02']);
    await assert.rejects(readFile(appliedWeeksPath(root)), { code: 'ENOENT' });
  });
});

test('unreadable TDCC raw is not recorded and remains pending', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-02', Buffer.from('not gzip'));

    await assert.rejects(applyTdccWeek(root, '2026-10-02'));
    assert.deepEqual(await pendingTdccWeeks(root), ['2026-10-02']);
    await assert.rejects(readFile(appliedWeeksPath(root)), { code: 'ENOENT' });
  });
});

test('runSnapshot applies and records an existing same TDCC raw week', async () => {
  await withTempRoot(async (root) => {
    const csv = tdccCsv('2026-10-02');
    await writeWeek(root, '2026-10-02', gzipSync(csv));

    const summary = await runSnapshot({
      rootDir: root,
      datasets: ['tdcc'],
      now: () => new Date('2026-10-05T13:45:00Z'),
      fetcher: async () => ({
        ok: true,
        status: 200,
        async arrayBuffer() {
          const bytes = Buffer.from(csv, 'utf8');
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      }),
    });

    assert.equal(summary.results.find((result) => result.key === 'tdcc').status, 'same');
    assert.deepEqual(await readAppliedWeeks(root), ['2026-10-02']);
    assert.deepEqual(await pendingTdccWeeks(root), []);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data', 'derived', 'tdcc', '23', '2330.json'), 'utf8')),
      {
        id: '2330',
        updated: '2026-10-02',
        cols: ['w', 'big1000', 'big400', 'retail', 'holders', 'avgShares', 'holders50'],
        rows: [[20261002, 20, 20, 1.5, 20, 200, 10]],
      },
    );
  });
});

test('runSnapshot repairs a corrupt record while writing other derived and manifest data', async () => {
  await withTempRoot(async (root) => {
    await writeWeek(root, '2026-10-02');
    await mkdir(dirname(appliedWeeksPath(root)), { recursive: true });
    await writeFile(appliedWeeksPath(root), '["2026-10-02"');

    const summary = await runTwseSnapshot(root);

    assert.equal(summary.exitCode, 0);
    assert.deepEqual(await readAppliedWeeks(root), ['2026-10-02']);
    assert.deepEqual(await pendingTdccWeeks(root), []);
    assert.equal(
      JSON.parse(await readFile(join(root, 'data', 'manifest.json'), 'utf8'))
        .datasets.twse_stock_day_all.latest,
      '2026-10-05',
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data', 'derived', 'symbols', '23', '2330.json'), 'utf8'))
        .rows[0].slice(0, 6),
      [20261005, null, null, null, 50, 100],
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data', 'derived', 'tdcc', '23', '2330.json'), 'utf8'))
        .rows,
      [[20261002, 20, 20, 1.5, 20, 200, 10]],
    );
  });
});

test('runSnapshot isolates pending lookup errors from other derived and manifest writes', async (t) => {
  await withTempRoot(async (root) => {
    const errors = [];
    t.mock.method(console, 'error', (message) => errors.push(String(message)));
    const tdccRawPath = join(root, 'data', 'raw', 'tdcc');
    await mkdir(dirname(tdccRawPath), { recursive: true });
    await writeFile(tdccRawPath, 'not a directory');

    const summary = await runTwseSnapshot(root);

    assert.equal(summary.exitCode, 0);
    assert.equal(
      JSON.parse(await readFile(join(root, 'data', 'manifest.json'), 'utf8'))
        .datasets.twse_stock_day_all.latest,
      '2026-10-05',
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data', 'derived', 'symbols', '23', '2330.json'), 'utf8'))
        .rows[0].slice(0, 6),
      [20261005, null, null, null, 50, 100],
    );
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('derived tdcc pending'));
    assert.equal(errors[0].includes('\n'), false);
  });
});
