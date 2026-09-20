import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  foreignFuturesBackfillOptionsFromArgs,
  foreignFuturesDefaultRange,
  runForeignFuturesBackfill,
} from '../scripts/backfill-foreign-futures.mjs';
import { runPcrBackfill } from '../scripts/backfill-pcr.mjs';
import { buildDerived } from '../scripts/build-derived.mjs';
import {
  applyTaifexForeignFuturesMonth,
  parseTaifexForeignFuturesCsv,
  stableDerivedString,
} from '../scripts/lib/derived.mjs';

const silentLogger = { log() {}, warn() {} };
const BIG5_HEADER = Buffer.from(
  'a4e9b4c12cb0d3ab7ea657bad92ca8ada5f7a74f2ca668a4e8a5e6a9f6a466bcc62ca668a4e8a5e6a9f6abb4acf9aaf7c34228a464a4b8292caac5a4e8a5e6a9f6a466bcc62caac5a4e8a5e6a9f6abb4acf9aaf7c34228a464a4b8292ca668aac5a5e6a9f6a466bcc6b262c3422ca668aac5a5e6a9f6abb4acf9aaf7c342b262c34228a464a4b8292ca668a4e8a5bca5adaddca466bcc62ca668a4e8a5bca5adaddcabb4acf9aaf7c34228a464a4b8292caac5a4e8a5bca5adaddca466bcc62caac5a4e8a5bca5adaddcabb4acf9aaf7c34228a464a4b8292ca668aac5a5bca5adaddca466bcc6b262c3422ca668aac5a5bca5adaddcabb4acf9aaf7c342b262c34228a464a4b829',
  'hex',
);
const BIG5_IDENTITIES = {
  dealer: Buffer.from('a6dbc0e7b0d3', 'hex'),
  trust: Buffer.from('a7ebab48', 'hex'),
  foreign: Buffer.from('a57eb8eaa4ceb3b0b8ea', 'hex'),
};

function futuresLine(date, identity, net) {
  return Buffer.concat([
    Buffer.from(`${date},TX,`, 'ascii'),
    BIG5_IDENTITIES[identity],
    Buffer.from(`,10,20,30,40,50,60,100000,80,90000,100,${net},120\r\n`, 'ascii'),
  ]);
}

function futuresFixture(records, { header = true } = {}) {
  const chunks = header ? [BIG5_HEADER, Buffer.from('\r\n', 'ascii')] : [];
  for (const { date, net } of records) {
    chunks.push(futuresLine(date, 'dealer', 111));
    chunks.push(futuresLine(date, 'trust', 222));
    chunks.push(futuresLine(date, 'foreign', net));
  }
  return Buffer.concat(chunks);
}

const JULY_DESCENDING = futuresFixture([
  { date: '2026/07/31', net: -82515 },
  { date: '2026/07/01', net: -84168 },
]);
const MARCH_DESCENDING = futuresFixture([
  { date: '2024/03/29', net: -754 },
  { date: '2024/03/01', net: -1493 },
]);

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-taifex-foreign-futures-test-'));
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

async function writeForeignRaw(root, monthKey, bytes = JULY_DESCENDING) {
  const path = join(
    root,
    'data',
    'raw',
    'taifex',
    'foreign_futures',
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

test('TAIFEX foreign futures parser selects only foreign rows at index 13, preserves negatives, and sorts', (t) => {
  const fixture = Buffer.concat([JULY_DESCENDING, MARCH_DESCENDING]);
  const rows = parseTaifexForeignFuturesCsv(fixture);
  assert.deepEqual(rows, [
    [20240301, -1493],
    [20240329, -754],
    [20260701, -84168],
    [20260731, -82515],
  ]);
  assert.equal(rows.every((row) => row[1] < 0), true);
  t.diagnostic(`A2_FOREIGN_FUTURES_ROWS=${JSON.stringify(rows)}`);
});

test('TAIFEX foreign futures parser throws for short and non-numeric foreign rows', (t) => {
  const short = Buffer.concat([
    BIG5_HEADER,
    Buffer.from('\r\n2026/07/31,TX,', 'ascii'),
    BIG5_IDENTITIES.foreign,
    Buffer.from(',1,2\r\n', 'ascii'),
  ]);
  assert.throws(
    () => parseTaifexForeignFuturesCsv(short),
    /has 5 columns, expected at least 15/,
  );
  const nonNumeric = futuresFixture([{ date: '2026/07/31', net: 'not-a-number' }]);
  assert.throws(
    () => parseTaifexForeignFuturesCsv(nonNumeric),
    /non-numeric net open interest at 2026-07-31/,
  );
  t.diagnostic('A3_SHORT_ROW=THREW A3_NON_NUMERIC=THREW');
});

test('foreign futures backfill posts one TXF calendar month, preserves raw bytes, and checkpoints valid raw', async (t) => {
  await withTempDir(async (root) => {
    const calls = [];
    const first = await runForeignFuturesBackfill({
      rootDir: root,
      fromMonth: '2026-07',
      toMonth: '2026-07',
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return responseFor(JULY_DESCENDING);
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
    assert.equal(calls[0].url, 'https://www.taifex.com.tw/cht/3/futContractsDateDown');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)), {
      down_type: '1',
      queryStartDate: '2026/07/01',
      queryEndDate: '2026/07/31',
      commodityId: 'TXF',
    });

    const rawPath = join(root, 'data/raw/taifex/foreign_futures/2026/2026-07.csv');
    assert.deepEqual(await readFile(rawPath), JULY_DESCENDING);
    const rawMtime = (await stat(rawPath)).mtimeMs;
    const derivedPath = join(root, 'data/derived/market.json');
    const derivedBytes = await readFile(derivedPath);
    const second = await runForeignFuturesBackfill({
      rootDir: root,
      fromMonth: '2026-07',
      toMonth: '2026-07',
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
    t.diagnostic(`FOREIGN_FUTURES_POST_BODY=${calls[0].options.body}`);
    t.diagnostic(`FOREIGN_FUTURES_RAW_BYTES_PRESERVED=${(await readFile(rawPath)).equals(JULY_DESCENDING)} CHECKPOINT_MTIME_UNCHANGED=${(await stat(rawPath)).mtimeMs === rawMtime}`);
  });
});

test('HTTP 200 DateTime error retries with backoff, fails, and writes no foreign-futures raw', async (t) => {
  await withTempDir(async (root) => {
    const errorPage = Buffer.from("<html><script>alert('DateTime error')</script></html>");
    const sleeps = [];
    let calls = 0;
    let caught;
    try {
      await runForeignFuturesBackfill({
        rootDir: root,
        fromMonth: '2023-09',
        toMonth: '2023-09',
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
      month: '2023-09',
      error: '2023-09: TAIFEX foreign futures: response has 0 data rows',
    }]);
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [25, 50]);
    await assert.rejects(
      readFile(join(root, 'data/raw/taifex/foreign_futures/2023/2023-09.csv')),
      { code: 'ENOENT' },
    );
    t.diagnostic(`A4_HTTP=200 A4_DATETIME_ERROR=true A4_FETCH_CALLS=${calls} A4_BACKOFFS=${sleeps.join(',')} A4_RAW_EXISTS=false`);
  });
});

test('foreign futures raw validation requires the first line to start with the Big5 日期 header', async () => {
  await withTempDir(async (root) => {
    const noHeader = futuresFixture([{ date: '2026/07/31', net: -82515 }], { header: false });
    let caught;
    try {
      await runForeignFuturesBackfill({
        rootDir: root,
        fromMonth: '2026-07',
        toMonth: '2026-07',
        delayMs: 0,
        maxRetries: 0,
        fetchImpl: async () => responseFor(noHeader),
        sleepImpl: async () => {},
        logger: silentLogger,
      });
    } catch (error) {
      caught = error;
    }
    assert.match(caught.summary.failures[0].error, /first line is not a CSV header/);
    await assert.rejects(
      readFile(join(root, 'data/raw/taifex/foreign_futures/2026/2026-07.csv')),
      { code: 'ENOENT' },
    );
  });
});

test('TAIFEX monthly header policy accepts headerless PCR rows but rejects headerless foreign-futures rows', async (t) => {
  await withTempDir(async (root) => {
    const pcrBytes = Buffer.from('2026/08/31,161117,136134,118.35,61681,64172,96.12,\r\n');
    const pcrRoot = join(root, 'pcr');
    const pcr = await runPcrBackfill({
      rootDir: pcrRoot,
      fromMonth: '2026-08',
      toMonth: '2026-08',
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: async () => responseFor(pcrBytes),
      sleepImpl: async () => {},
      logger: silentLogger,
    });
    assert.equal(pcr.failures.length, 0);
    assert.deepEqual(
      await readFile(join(pcrRoot, 'data/raw/taifex/pcr/2026/2026-08.csv')),
      pcrBytes,
    );

    const foreignBytes = futuresFixture(
      [{ date: '2026/08/31', net: -82515 }],
      { header: false },
    );
    const foreignRoot = join(root, 'foreign');
    let caught;
    try {
      await runForeignFuturesBackfill({
        rootDir: foreignRoot,
        fromMonth: '2026-08',
        toMonth: '2026-08',
        delayMs: 0,
        maxRetries: 0,
        fetchImpl: async () => responseFor(foreignBytes),
        sleepImpl: async () => {},
        logger: silentLogger,
      });
    } catch (error) {
      caught = error;
    }
    assert.match(caught?.summary?.failures?.[0]?.error ?? '', /first line is not a CSV header/);
    await assert.rejects(
      readFile(join(foreignRoot, 'data/raw/taifex/foreign_futures/2026/2026-08.csv')),
      { code: 'ENOENT' },
    );
    t.diagnostic('R001_PCR_HEADERLESS=ACCEPTED R001_FOREIGN_HEADERLESS=REJECTED R001_FOREIGN_RAW_EXISTS=false');
  });
});

test('foreign futures backfill continues after a failed month and reports failures at the end', async (t) => {
  await withTempDir(async (root) => {
    const august = futuresFixture([{ date: '2026/08/03', net: -80000 }]);
    let caught;
    try {
      await runForeignFuturesBackfill({
        rootDir: root,
        fromMonth: '2026-07',
        toMonth: '2026-08',
        delayMs: 0,
        maxRetries: 0,
        fetchImpl: async (_url, options) => {
          const month = new URLSearchParams(options.body).get('queryStartDate').slice(0, 7);
          return responseFor(month === '2026/07' ? Buffer.from('<html>DateTime error</html>') : august);
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
    await assert.rejects(readFile(join(root, 'data/raw/taifex/foreign_futures/2026/2026-07.csv')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(root, 'data/raw/taifex/foreign_futures/2026/2026-08.csv')), august);
    t.diagnostic(`FOREIGN_FUTURES_CONTINUE_RESULT=${JSON.stringify(caught.summary)}`);
  });
});

test('foreign futures default range follows the injected clock instead of a fixed date', (t) => {
  const september = foreignFuturesDefaultRange(() => new Date('2026-09-20T00:00:00Z'));
  const october = foreignFuturesDefaultRange(() => new Date('2026-10-20T00:00:00Z'));
  const taipeiOctoberBoundary = foreignFuturesDefaultRange(() => new Date('2026-09-30T16:30:00Z'));
  assert.deepEqual(september, { fromMonth: '2023-10', toMonth: '2026-08' });
  assert.deepEqual(october, { fromMonth: '2023-11', toMonth: '2026-09' });
  assert.deepEqual(taipeiOctoberBoundary, october);
  assert.notEqual(september.fromMonth, october.fromMonth);
  t.diagnostic(`A5_CLOCK_2026_09=${JSON.stringify(september)} A5_CLOCK_2026_10=${JSON.stringify(october)}`);
});

test('foreign futures runner uses injected now for its omitted from and to defaults', async (t) => {
  await withTempDir(async (root) => {
    async function requestedMonths(rootDir, now) {
      const months = [];
      const summary = await runForeignFuturesBackfill({
        rootDir,
        now: () => new Date(now),
        delayMs: 0,
        maxRetries: 0,
        fetchImpl: async (_url, options) => {
          months.push(new URLSearchParams(options.body).get('queryStartDate').slice(0, 7));
          return responseFor(JULY_DESCENDING);
        },
        sleepImpl: async () => {},
        applyTaifexForeignFuturesMonthImpl: async () => ({ market: false }),
        logger: silentLogger,
      });
      assert.equal(summary.requests, months.length);
      return months;
    }

    const september = await requestedMonths(
      join(root, 'september'),
      '2026-09-20T00:00:00Z',
    );
    const october = await requestedMonths(
      join(root, 'october'),
      '2026-10-20T00:00:00Z',
    );
    assert.equal(september.length, 35);
    assert.equal(october.length, 35);
    assert.deepEqual([september[0], september.at(-1)], ['2023/10', '2026/08']);
    assert.deepEqual([october[0], october.at(-1)], ['2023/11', '2026/09']);
    assert.notDeepEqual(september, october);
    t.diagnostic(`R002_RUNNER_2026_09=${september[0]}..${september.at(-1)} R002_RUNNER_2026_10=${october[0]}..${october.at(-1)} REQUESTS=${september.length}/${october.length}`);
  });
});

test('foreign futures derived upsert preserves all six existing market series and is byte-idempotent', async (t) => {
  await withTempDir(async (root) => {
    await writeForeignRaw(root, '2026-07');
    const marketPath = join(root, 'data', 'derived', 'market.json');
    const preserved = {
      updated: '2026-08-03',
      twse: {
        index: { cols: ['d', 'c'], rows: [[20260803, 24000]] },
        margin: { cols: ['d', 'mb', 'ms'], rows: [[20260803, 1, 2]] },
      },
      tpex: {
        index: { cols: ['d', 'o', 'h', 'l', 'c'], rows: [[20260803, 1, 2, 0, 1]] },
        margin: { cols: ['d', 'mb', 'ms'], rows: [[20260803, 3, 4]] },
        insti: { cols: ['d', 'fi'], rows: [[20260803, 5]] },
      },
      taifex: {
        pcr: { cols: ['d', 'vol', 'oi'], rows: [[20260803, 100, 90]] },
      },
    };
    await mkdir(dirname(marketPath), { recursive: true });
    await writeFile(marketPath, stableDerivedString(preserved));

    const first = await applyTaifexForeignFuturesMonth(root, '2026-07');
    const firstBytes = await readFile(marketPath);
    const market = JSON.parse(firstBytes);
    assert.deepEqual(first, { rows: 2, market: true });
    assert.deepEqual(market.taifex.fut, {
      cols: ['d', 'net'],
      rows: [[20260701, -84168], [20260731, -82515]],
    });
    assert.deepEqual(market.twse, preserved.twse);
    assert.deepEqual(market.tpex, preserved.tpex);
    assert.deepEqual(market.taifex.pcr, preserved.taifex.pcr);

    const second = await applyTaifexForeignFuturesMonth(root, '2026-07');
    const secondBytes = await readFile(marketPath);
    assert.deepEqual(second, { rows: 2, market: false });
    assert.deepEqual(secondBytes, firstBytes);
    t.diagnostic(`A6_TAIFEX_FUT=${JSON.stringify(market.taifex.fut)} A6_SECOND_WRITE=${second.market} A6_BYTES_EQUAL=${secondBytes.equals(firstBytes)} A6_EXISTING_SERIES_PRESERVED=true`);
  });
});

test('buildDerived rebuilds foreign futures market data from isolated raw', async (t) => {
  await withTempDir(async (root) => {
    await writeForeignRaw(root, '2026-07');
    const summary = await buildDerived({ rootDir: root });
    const market = await readMarket(root);
    assert.equal(summary.dailyDates, 0);
    assert.equal(summary.taifexPcrMonths, 0);
    assert.equal(summary.taifexForeignFuturesMonths, 1);
    assert.deepEqual(market.taifex.fut, {
      cols: ['d', 'net'],
      rows: [[20260701, -84168], [20260731, -82515]],
    });
    t.diagnostic(`A7_BUILD_SUMMARY=${JSON.stringify(summary)} A7_TAIFEX_FUT=${JSON.stringify(market.taifex.fut)}`);
  });
});

test('foreign futures CLI numeric flags use the shared bare-flag NaN guard', async () => {
  for (const key of ['delay-ms', 'max-retries', 'retry-base-ms']) {
    const options = foreignFuturesBackfillOptionsFromArgs({
      from: '2026-07',
      to: '2026-07',
      [key]: true,
    });
    assert.equal(Number.isNaN(options[
      key === 'delay-ms' ? 'delayMs' : key === 'max-retries' ? 'maxRetries' : 'retryBaseMs'
    ]), true);
    await assert.rejects(runForeignFuturesBackfill({
      ...options,
      fetchImpl: async () => assert.fail('numeric guard must run before fetch'),
      sleepImpl: async () => {},
      logger: silentLogger,
    }), new RegExp(`--${key}`));
  }
});
