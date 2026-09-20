import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  pcrBackfillOptionsFromArgs,
  runPcrBackfill,
} from '../scripts/backfill-pcr.mjs';
import { buildDerived } from '../scripts/build-derived.mjs';
import {
  applyTaifexPcrMonth,
  parseTaifexPcrCsv,
  stableDerivedString,
} from '../scripts/lib/derived.mjs';

const silentLogger = { log() {}, warn() {} };
const BIG5_HEADER = Buffer.from(
  'a4e9b4c12cbde6c576a6a8a5e6b6712cb652c576a6a8a5e6b6712cb652bde6c576a6a8a5e6b671a4f1b276252cbde6c576a5bca5adaddcb6712cb652c576a5bca5adaddcb6712cb652bde6c576a5bca5adaddcb671a4f1b27625',
  'hex',
);

function pcrFixture(rows) {
  return Buffer.concat([
    BIG5_HEADER,
    Buffer.from(`\r\n${rows.join('\r\n')}\r\n`, 'ascii'),
  ]);
}

const AUGUST_DESCENDING = pcrFixture([
  '2026/08/31,161117,136134,118.35,61681,64172,96.12,',
  '2026/08/03,100,200,102.71,300,400,97.66,',
]);
const AUGUST_ASCENDING_ROWS = [
  [20260803, 102.71, 97.66],
  [20260831, 118.35, 96.12],
];

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-taifex-pcr-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function responseFor(bytes, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
  };
}

async function writePcrRaw(root, monthKey, bytes = AUGUST_DESCENDING) {
  const path = join(
    root,
    'data',
    'raw',
    'taifex',
    'pcr',
    monthKey.slice(0, 4),
    `${monthKey}.csv`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function readMarket(root) {
  return JSON.parse(await readFile(join(root, 'data', 'derived', 'market.json'), 'utf8'));
}

test('TAIFEX PCR parser maps real-format values, accepts the trailing comma, and sorts ascending', (t) => {
  const fixture = pcrFixture([
    '2026/08/31,161117,136134,118.35,61681,64172,96.12,',
    '2024/02/29,1,1,105.91,1,1,127.09,',
    '2024/02/01,1,1,100.54,1,1,111.61,',
  ]);
  assert.equal(fixture.subarray(0, 16).toString('hex'), 'a4e9b4c12cbde6c576a6a8a5e6b6712c');
  const rows = parseTaifexPcrCsv(fixture);
  assert.deepEqual(rows, [
    [20240201, 100.54, 111.61],
    [20240229, 105.91, 127.09],
    [20260831, 118.35, 96.12],
  ]);
  t.diagnostic(`A2_PARSER_ROWS=${JSON.stringify(rows)}`);
});

test('TAIFEX PCR parser throws for short and non-numeric data rows', (t) => {
  assert.throws(
    () => parseTaifexPcrCsv(Buffer.from('2026/08/31,1,2,118.35,3,4\r\n')),
    /has 6 columns, expected at least 7/,
  );
  assert.throws(
    () => parseTaifexPcrCsv(Buffer.from('2026/08/31,not-a-number,2,118.35,3,4,96.12,\r\n')),
    /non-numeric put volume at 2026-08-31/,
  );
  t.diagnostic('A3_SHORT_ROW=THREW A3_NON_NUMERIC=THREW');
});

test('TAIFEX PCR parser rejects an illegal Big5 byte sequence', (t) => {
  assert.throws(
    () => parseTaifexPcrCsv(Buffer.from([0x81])),
    /TAIFEX PCR: invalid big5 CSV/,
  );
  t.diagnostic('BIG5_INVALID_BYTES=81 RESULT=THREW_INVALID_BIG5_CSV');
});

test('PCR backfill posts one calendar month, preserves raw bytes, and checkpoints valid raw', async (t) => {
  await withTempDir(async (root) => {
    const calls = [];
    const first = await runPcrBackfill({
      rootDir: root,
      fromMonth: '2026-08',
      toMonth: '2026-08',
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return responseFor(AUGUST_DESCENDING);
      },
      sleepImpl: async () => {},
      logger: silentLogger,
    });
    assert.deepEqual(first, {
      months: 1,
      requests: 1,
      skipped: 0,
      rawWritten: 1,
      derivedWritten: 1,
      rows: 2,
      failures: [],
    });
    assert.equal(calls[0].url, 'https://www.taifex.com.tw/cht/3/pcRatioDown');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)), {
      down_type: '1',
      queryStartDate: '2026/08/01',
      queryEndDate: '2026/08/31',
    });

    const rawPath = join(root, 'data/raw/taifex/pcr/2026/2026-08.csv');
    assert.deepEqual(await readFile(rawPath), AUGUST_DESCENDING);
    const rawMtime = (await stat(rawPath)).mtimeMs;
    const derivedPath = join(root, 'data/derived/market.json');
    const derivedBytes = await readFile(derivedPath);
    const second = await runPcrBackfill({
      rootDir: root,
      fromMonth: '2026-08',
      toMonth: '2026-08',
      delayMs: 0,
      fetchImpl: async () => assert.fail('valid raw checkpoint must prevent refetch'),
      sleepImpl: async () => {},
      logger: silentLogger,
    });
    assert.deepEqual(second, {
      months: 1,
      requests: 0,
      skipped: 1,
      rawWritten: 0,
      derivedWritten: 0,
      rows: 2,
      failures: [],
    });
    assert.equal((await stat(rawPath)).mtimeMs, rawMtime);
    assert.deepEqual(await readFile(derivedPath), derivedBytes);
    t.diagnostic(`PCR_POST_BODY=${calls[0].options.body}`);
    t.diagnostic(`PCR_RAW_BYTES_PRESERVED=${(await readFile(rawPath)).equals(AUGUST_DESCENDING)} CHECKPOINT_MTIME_UNCHANGED=${(await stat(rawPath)).mtimeMs === rawMtime}`);
  });
});

test('HTTP 200 with zero PCR data rows retries with backoff, fails, and writes no raw', async (t) => {
  await withTempDir(async (root) => {
    const errorPage = Buffer.from('<html><body>query range error</body></html>');
    const sleeps = [];
    let calls = 0;
    let caught;
    try {
      await runPcrBackfill({
        rootDir: root,
        fromMonth: '2026-08',
        toMonth: '2026-08',
        delayMs: 0,
        maxRetries: 2,
        retryBaseMs: 25,
        fetchImpl: async () => {
          calls += 1;
          return responseFor(errorPage, 200);
        },
        sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
        logger: silentLogger,
      });
    } catch (error) {
      caught = error;
    }
    assert.match(caught?.message ?? '', /completed with 1 failure/);
    assert.deepEqual(caught.summary.failures, [{
      month: '2026-08',
      error: '2026-08: TAIFEX PCR: response has 0 data rows',
    }]);
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [25, 50]);
    await assert.rejects(
      readFile(join(root, 'data/raw/taifex/pcr/2026/2026-08.csv')),
      { code: 'ENOENT' },
    );
    t.diagnostic(`A4_HTTP=200 A4_ROWS=0 A4_FETCH_CALLS=${calls} A4_BACKOFFS=${sleeps.join(',')} A4_RAW_EXISTS=false`);
  });
});

test('PCR backfill continues after a failed month and reports all failures at the end', async (t) => {
  await withTempDir(async (root) => {
    let caught;
    try {
      await runPcrBackfill({
        rootDir: root,
        fromMonth: '2026-07',
        toMonth: '2026-08',
        delayMs: 0,
        maxRetries: 0,
        fetchImpl: async (_url, options) => {
          const month = new URLSearchParams(options.body).get('queryStartDate').slice(0, 7);
          return responseFor(month === '2026/07' ? Buffer.from('<html>error</html>') : AUGUST_DESCENDING);
        },
        sleepImpl: async () => {},
        logger: silentLogger,
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.summary.months, 2);
    assert.equal(caught.summary.failures.length, 1);
    assert.equal(caught.summary.failures[0].month, '2026-07');
    await assert.rejects(readFile(join(root, 'data/raw/taifex/pcr/2026/2026-07.csv')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(root, 'data/raw/taifex/pcr/2026/2026-08.csv')), AUGUST_DESCENDING);
    t.diagnostic(`PCR_CONTINUE_RESULT=${JSON.stringify(caught.summary)}`);
  });
});

test('TAIFEX PCR derived upsert preserves market series and is byte-idempotent', async (t) => {
  await withTempDir(async (root) => {
    await writePcrRaw(root, '2026-08');
    const marketPath = join(root, 'data', 'derived', 'market.json');
    await mkdir(dirname(marketPath), { recursive: true });
    await writeFile(marketPath, stableDerivedString({
      updated: '2026-08-03',
      twse: {
        index: { cols: ['d', 'c'], rows: [[20260803, 24000]] },
        margin: { cols: ['d', 'mb', 'ms'], rows: [] },
      },
      tpex: {
        index: { cols: ['d', 'o', 'h', 'l', 'c'], rows: [] },
        margin: { cols: ['d', 'mb', 'ms'], rows: [] },
        insti: { cols: ['d', 'fi'], rows: [] },
      },
    }));

    const first = await applyTaifexPcrMonth(root, '2026-08');
    const firstBytes = await readFile(marketPath);
    const market = JSON.parse(firstBytes);
    assert.deepEqual(first, { rows: 2, market: true });
    assert.deepEqual(market.taifex.pcr, {
      cols: ['d', 'vol', 'oi'],
      rows: AUGUST_ASCENDING_ROWS,
    });
    assert.deepEqual(market.twse.index.rows, [[20260803, 24000]]);
    assert.equal(market.updated, '2026-08-31');

    const second = await applyTaifexPcrMonth(root, '2026-08');
    const secondBytes = await readFile(marketPath);
    assert.deepEqual(second, { rows: 2, market: false });
    assert.deepEqual(secondBytes, firstBytes);
    t.diagnostic(`A5_TAIFEX_PCR=${JSON.stringify(market.taifex.pcr)} A5_SECOND_WRITE=${second.market} A5_BYTES_EQUAL=${secondBytes.equals(firstBytes)}`);
  });
});

test('buildDerived rebuilds TAIFEX PCR market data from isolated raw', async (t) => {
  await withTempDir(async (root) => {
    await writePcrRaw(root, '2026-08');
    const summary = await buildDerived({ rootDir: root });
    const market = await readMarket(root);
    assert.equal(summary.dailyDates, 0);
    assert.equal(summary.taifexPcrMonths, 1);
    assert.deepEqual(market.taifex.pcr, {
      cols: ['d', 'vol', 'oi'],
      rows: AUGUST_ASCENDING_ROWS,
    });
    t.diagnostic(`A6_BUILD_SUMMARY=${JSON.stringify(summary)} A6_TAIFEX_PCR=${JSON.stringify(market.taifex.pcr)}`);
  });
});

test('PCR CLI numeric flags use the shared bare-flag NaN guard', async () => {
  for (const key of ['delay-ms', 'max-retries', 'retry-base-ms']) {
    const options = pcrBackfillOptionsFromArgs({
      from: '2026-08',
      to: '2026-08',
      [key]: true,
    });
    assert.equal(Number.isNaN(options[
      key === 'delay-ms' ? 'delayMs' : key === 'max-retries' ? 'maxRetries' : 'retryBaseMs'
    ]), true);
    await assert.rejects(runPcrBackfill({
      ...options,
      fetchImpl: async () => assert.fail('numeric guard must run before fetch'),
      sleepImpl: async () => {},
      logger: silentLogger,
    }), new RegExp(`--${key}`));
  }
});
