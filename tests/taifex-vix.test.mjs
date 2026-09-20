import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runVixBackfill,
  vixBackfillOptionsFromArgs,
  vixDefaultRange,
} from '../scripts/backfill-vix.mjs';
import { buildDerived } from '../scripts/build-derived.mjs';
import {
  applyTaifexVixMonth,
  parseTaifexVixTxt,
  stableDerivedString,
} from '../scripts/lib/derived.mjs';

const silentLogger = { log() {}, warn() {} };
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OFFICIAL_VIX_DIR = join(REPO_ROOT, 'data/raw/taifex/vix_monthly/2026');
const VIX_404_BYTES = Buffer.from(
  'PEhUTUwgIHhtbG5zPSdodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sJyBsYW5nPSd6aC1UVyc+PGhlYWQ+PG1ldGEgaHR0cC1lcXVpdj0nQ29udGVudC1UeXBlJyBjb250ZW50PSd0ZXh0L2h0bWw7IGNoYXJzZXQ9YmlnNScgLz48L2hlYWQ+DQo8dGl0bGU+NDA0PC90aXRsZT4NCjxTVFlMRSB0eXBlPSJ0ZXh0L2NzcyI+DQpib2R5ew0KZm9udC1zaXplOjFlbTsNCiB9DQo8L1NUWUxFPg0KPGJvZHk+DQo8aDE+NDA0PC9oMT4NCrF6wnPE/aq6rbatsbzIrsm1TKprqkGwyKFBIF88YnI+DQq90MJJv++kVaTos3O1sqZerbqttiEhPGJyPg0KPGEgaHJlZj0iaHR0cHM6Ly93d3cudGFpZmV4LmNvbS50dy9jaHQvaW5kZXgiPmh0dHA6Ly93d3cudGFpZmV4LmNvbS50dzwvYT4NCjwvYm9keT4NCjwvaHRtbD4NCg0K',
  'base64',
);

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-taifex-vix-test-'));
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
    url: status === 200 ? 'https://www.taifex.com.tw/file/taifex/404.htm' : '',
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
  };
}

async function officialVixBytes(monthKey) {
  return readFile(join(OFFICIAL_VIX_DIR, `${monthKey}.txt`));
}

async function vixFixture(lines) {
  const official = await officialVixBytes('2026-06');
  const dataOffset = official.indexOf(Buffer.from('20260601\t', 'ascii'));
  assert.notEqual(dataOffset, -1, 'official fixture must contain its first data row');
  return Buffer.concat([
    official.subarray(0, dataOffset),
    Buffer.from(`${lines.join('\r\n')}\r\n`, 'ascii'),
  ]);
}

async function writeVixRaw(root, monthKey, bytes) {
  const path = join(
    root,
    'data',
    'raw',
    'taifex',
    'vix_monthly',
    monthKey.slice(0, 4),
    `${monthKey}.txt`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function readMarket(root) {
  return JSON.parse(await readFile(join(root, 'data/derived/market.json'), 'utf8'));
}

test('TAIFEX VIX parser skips the separator, selects column 3, sorts, and matches all official fixtures', async (t) => {
  const expectations = {
    '2026-06': { count: 21, first: [20260601, 36.54], last: [20260630, 38.55] },
    '2026-07': { count: 22, first: [20260701, 38.12], last: [20260731, 40.77] },
    '2026-08': { count: 21, first: [20260803, 39.46], last: [20260831, 24.45] },
    '2026-09': { count: 14, first: [20260901, 24.91], last: [20260918, 21.22] },
  };
  for (const [month, expected] of Object.entries(expectations)) {
    const bytes = await officialVixBytes(month);
    const lines = new TextDecoder('big5', { fatal: true }).decode(bytes).split(/\r\n|\n|\r/);
    assert.equal(lines[0].startsWith('交易日期'), true);
    assert.equal(lines[1].startsWith('--------'), true);
    const rows = parseTaifexVixTxt(bytes);
    assert.equal(rows.length, expected.count);
    assert.deepEqual(rows[0], expected.first);
    assert.deepEqual(rows.at(-1), expected.last);
  }

  const descending = await vixFixture([
    '20260731\t13450000\t\t\t40.77\t\t40.60',
    '20260601\t13450000\t\t\t36.54\t\t36.52',
  ]);
  assert.deepEqual(parseTaifexVixTxt(descending), [
    [20260601, 36.54],
    [20260731, 40.77],
  ]);
  t.diagnostic('A2_COUNTS=21/22/21/14 A2_SEPARATOR=SKIPPED A2_20260731=40.77 A2_20260601=36.54 A2_20260918=21.22 A2_SORT=ASC');
});

test('TAIFEX VIX parser throws for short and non-numeric data rows', async (t) => {
  const short = await vixFixture(['20260731\t13450000\t\t40.77']);
  assert.throws(
    () => parseTaifexVixTxt(short),
    /has 3 cells, expected at least 4/,
  );
  const nonNumeric = await vixFixture([
    '20260731\t13450000\t\t\tnot-a-number\t\t40.60',
  ]);
  assert.throws(
    () => parseTaifexVixTxt(nonNumeric),
    /non-numeric index at 20260731/,
  );
  t.diagnostic('A3_SHORT_ROW=THREW A3_NON_NUMERIC=THREW');
});

test('HTTP 200 TAIFEX 404 payload retries, fails content validation, and writes no raw', async (t) => {
  await withTempDir(async (root) => {
    assert.equal(VIX_404_BYTES.length, 402);
    assert.equal(
      createHash('sha256').update(VIX_404_BYTES).digest('hex'),
      '99217abd21cae0ec777bf59d2370462836ef7de18d66f5465d6f4919f4fc0fb8',
    );
    const sleeps = [];
    const calls = [];
    let caught;
    try {
      await runVixBackfill({
        rootDir: root,
        fromMonth: '2026-10',
        toMonth: '2026-10',
        delayMs: 0,
        maxRetries: 2,
        retryBaseMs: 25,
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          return responseFor(VIX_404_BYTES, 200);
        },
        sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
        applyTaifexVixMonthImpl: async () => assert.fail('invalid raw must not be applied'),
        logger: silentLogger,
      });
    } catch (error) {
      caught = error;
    }
    assert.match(caught?.message ?? '', /completed with 1 failure/);
    assert.deepEqual(caught.summary.failures, [{
      month: '2026-10',
      error: '2026-10: TAIFEX VIX: response first line is not a VIX header starting with 交易日期',
    }]);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url.endsWith('/202610new.txt'), true);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal('body' in calls[0].options, false);
    assert.deepEqual(sleeps, [25, 50]);
    await assert.rejects(
      readFile(join(root, 'data/raw/taifex/vix_monthly/2026/2026-10.txt')),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      readFile(join(root, 'data/raw/taifex/vix_monthly/2026/2026-10.csv')),
      { code: 'ENOENT' },
    );
    t.diagnostic(`A4_HTTP=200 A4_BYTES=${VIX_404_BYTES.length} A4_FETCH_CALLS=${calls.length} A4_BACKOFFS=${sleeps.join(',')} A4_RAW_EXISTS=false`);
  });
});

test('VIX backfill continues after an unavailable month and reports failure after later months', async (t) => {
  await withTempDir(async (root) => {
    const november = await vixFixture([
      '20261102\t13450000\t\t\t31.25\t\t31.20',
    ]);
    let caught;
    try {
      await runVixBackfill({
        rootDir: root,
        fromMonth: '2026-10',
        toMonth: '2026-11',
        delayMs: 0,
        maxRetries: 0,
        fetchImpl: async (url) => responseFor(
          url.endsWith('/202610new.txt') ? VIX_404_BYTES : november,
        ),
        sleepImpl: async () => {},
        applyTaifexVixMonthImpl: async () => ({ market: false }),
        logger: silentLogger,
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.summary.months, 2);
    assert.equal(caught.summary.failures.length, 1);
    assert.equal(caught.summary.failures[0].month, '2026-10');
    assert.deepEqual(
      await readFile(join(root, 'data/raw/taifex/vix_monthly/2026/2026-11.txt')),
      november,
    );
    t.diagnostic(`REQUIREMENT_8_BEHAVIOR=CONTINUE_THEN_FAIL SUMMARY=${JSON.stringify(caught.summary)}`);
  });
});

test('VIX default four-month range and omitted runner range follow the Taipei clock', async (t) => {
  const september = vixDefaultRange(() => new Date('2026-09-20T00:00:00Z'));
  const october = vixDefaultRange(() => new Date('2026-10-20T00:00:00Z'));
  const taipeiOctoberBoundary = vixDefaultRange(() => new Date('2026-09-30T16:30:00Z'));
  assert.deepEqual(september, { fromMonth: '2026-06', toMonth: '2026-09' });
  assert.deepEqual(october, { fromMonth: '2026-07', toMonth: '2026-10' });
  assert.deepEqual(taipeiOctoberBoundary, october);

  await withTempDir(async (root) => {
    const payload = await vixFixture([
      '20260918\t13450000\t\t\t21.22\t\t21.18',
    ]);
    async function requestedMonths(out, now) {
      const months = [];
      const summary = await runVixBackfill({
        rootDir: out,
        now: () => new Date(now),
        delayMs: 0,
        maxRetries: 0,
        fetchImpl: async (url) => {
          months.push(url.match(/(\d{6})new\.txt$/)[1]);
          return responseFor(payload);
        },
        sleepImpl: async () => {},
        applyTaifexVixMonthImpl: async () => ({ market: false }),
        logger: silentLogger,
      });
      assert.equal(summary.requests, 4);
      return months;
    }
    assert.deepEqual(
      await requestedMonths(join(root, 'september'), '2026-09-20T00:00:00Z'),
      ['202606', '202607', '202608', '202609'],
    );
    assert.deepEqual(
      await requestedMonths(join(root, 'october'), '2026-10-20T00:00:00Z'),
      ['202607', '202608', '202609', '202610'],
    );
  });
  t.diagnostic(`A5_CLOCK_2026_09=${JSON.stringify(september)} A5_CLOCK_2026_10=${JSON.stringify(october)}`);
});

test('VIX GET writes only .txt and byte-identical rerun does not rewrite raw', async (t) => {
  await withTempDir(async (root) => {
    const payload = await officialVixBytes('2026-07');
    const calls = [];
    const options = {
      rootDir: root,
      fromMonth: '2026-07',
      toMonth: '2026-07',
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: async (url, request) => {
        calls.push({ url, request });
        return responseFor(payload);
      },
      sleepImpl: async () => {},
      logger: silentLogger,
    };
    const first = await runVixBackfill(options);
    assert.equal(first.requests, 1);
    assert.equal(first.rawWritten, 1);
    const rawPath = join(root, 'data/raw/taifex/vix_monthly/2026/2026-07.txt');
    assert.deepEqual(await readFile(rawPath), payload);
    await utimes(rawPath, new Date(1_000_000), new Date(1_000_000));
    const rawMtime = (await stat(rawPath)).mtimeMs;
    const firstDerivedBytes = await readFile(join(root, 'data/derived/market.json'));

    const second = await runVixBackfill(options);
    assert.equal(second.requests, 1, 'VIX current-month-safe mode must refetch valid raw');
    assert.equal(second.skipped, 0);
    assert.equal(second.rawWritten, 0);
    assert.equal(second.derivedWritten, 0);
    assert.equal((await stat(rawPath)).mtimeMs, rawMtime);
    assert.deepEqual(await readFile(rawPath), payload);
    assert.deepEqual(await readFile(join(root, 'data/derived/market.json')), firstDerivedBytes);
    assert.equal(calls.length, 2);
    assert.equal(calls.every(({ request }) => request.method === 'GET' && !('body' in request)), true);
    const files = await readdir(join(root, 'data/raw/taifex/vix_monthly/2026'));
    assert.deepEqual(files, ['2026-07.txt']);
    assert.equal(files.filter((file) => file.endsWith('.csv')).length, 0);
    t.diagnostic(`A6_FILES=${files.join(',')} A6_CSV_COUNT=0 A7_SECOND_WRITE=${second.rawWritten} A7_MTIME_UNCHANGED=${(await stat(rawPath)).mtimeMs === rawMtime} A7_BYTES_EQUAL=${(await readFile(rawPath)).equals(payload)}`);
  });
});

test('VIX derived upsert preserves all seven existing series and is byte-idempotent', async (t) => {
  await withTempDir(async (root) => {
    const payload = await officialVixBytes('2026-07');
    await writeVixRaw(root, '2026-07', payload);
    const marketPath = join(root, 'data/derived/market.json');
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
        fut: { cols: ['d', 'net'], rows: [[20260803, -80000]] },
      },
    };
    await mkdir(dirname(marketPath), { recursive: true });
    await writeFile(marketPath, stableDerivedString(preserved));

    const first = await applyTaifexVixMonth(root, '2026-07');
    const firstBytes = await readFile(marketPath);
    const market = JSON.parse(firstBytes);
    assert.deepEqual(first, { rows: 22, market: true });
    assert.deepEqual(market.taifex.vix.cols, ['d', 'vix']);
    assert.equal(market.taifex.vix.rows.length, 22);
    assert.deepEqual(market.taifex.vix.rows.at(-1), [20260731, 40.77]);
    assert.deepEqual(market.twse, preserved.twse);
    assert.deepEqual(market.tpex, preserved.tpex);
    assert.deepEqual(market.taifex.pcr, preserved.taifex.pcr);
    assert.deepEqual(market.taifex.fut, preserved.taifex.fut);

    const second = await applyTaifexVixMonth(root, '2026-07');
    const secondBytes = await readFile(marketPath);
    assert.deepEqual(second, { rows: 22, market: false });
    assert.deepEqual(secondBytes, firstBytes);
    t.diagnostic(`A8_TAIFEX_VIX_ROWS=${market.taifex.vix.rows.length} A8_LAST=${JSON.stringify(market.taifex.vix.rows.at(-1))} A8_SECOND_WRITE=${second.market} A8_BYTES_EQUAL=${secondBytes.equals(firstBytes)} A8_EXISTING_SERIES_PRESERVED=true`);
  });
});

test('buildDerived rebuilds VIX market data from isolated .txt raw', async (t) => {
  await withTempDir(async (root) => {
    await writeVixRaw(root, '2026-07', await officialVixBytes('2026-07'));
    const summary = await buildDerived({ rootDir: root });
    const market = await readMarket(root);
    assert.equal(summary.dailyDates, 0);
    assert.equal(summary.taifexPcrMonths, 0);
    assert.equal(summary.taifexForeignFuturesMonths, 0);
    assert.equal(summary.taifexVixMonths, 1);
    assert.deepEqual(market.taifex.vix.cols, ['d', 'vix']);
    assert.equal(market.taifex.vix.rows.length, 22);
    assert.deepEqual(market.taifex.vix.rows.at(-1), [20260731, 40.77]);
    t.diagnostic(`A9_BUILD_SUMMARY=${JSON.stringify(summary)} A9_TAIFEX_VIX_ROWS=${market.taifex.vix.rows.length} A9_LAST=${JSON.stringify(market.taifex.vix.rows.at(-1))}`);
  });
});

test('VIX CLI uses shared numeric guards and rate-safe defaults', async () => {
  const defaults = vixBackfillOptionsFromArgs({});
  assert.equal(defaults.delayMs, 2000);
  assert.equal(defaults.retryBaseMs, 2000);
  for (const key of ['delay-ms', 'max-retries', 'retry-base-ms']) {
    const options = vixBackfillOptionsFromArgs({ [key]: true });
    const property = key === 'delay-ms'
      ? 'delayMs'
      : key === 'max-retries' ? 'maxRetries' : 'retryBaseMs';
    assert.equal(Number.isNaN(options[property]), true);
    await assert.rejects(runVixBackfill({
      ...options,
      now: () => new Date('2026-09-20T00:00:00Z'),
      fetchImpl: async () => assert.fail('numeric guard must run before fetch'),
      sleepImpl: async () => {},
      logger: silentLogger,
    }), new RegExp(`--${key}`));
  }
});
