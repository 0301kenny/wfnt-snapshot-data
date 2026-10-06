import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDerived } from '../scripts/build-derived.mjs';
import { applyCorporateActions } from '../scripts/lib/derived.mjs';
import { runSnapshot } from '../scripts/run.mjs';

const TWSE_FIELDS = ['資料日期', '股票代號', '除權息前收盤價', '除權息參考價', '權/息'];
const TPEX_FIELDS = ['除權息日期', '代號', '除權息前收盤價', '除權息參考價', '權/息'];

function twseBody(data = []) {
  return JSON.stringify({ stat: 'OK', fields: TWSE_FIELDS, data });
}

function tpexBody(data = [], totalCount = data.length) {
  return JSON.stringify({ date: '115/10/02', tables: [{ totalCount, fields: TPEX_FIELDS, data }] });
}

function response(body, status = 200) {
  const bytes = Buffer.from(body, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function requestInfo(url, options = {}) {
  if (url.includes('/TWT49U?')) {
    const parsed = new URL(url);
    return { market: 'twse', year: Number(parsed.searchParams.get('startDate').slice(0, 4)), end: parsed.searchParams.get('endDate') };
  }
  assert.equal(url, 'https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(options.body);
  return { market: 'tpex', year: Number(body.get('startDate').slice(0, 4)), end: body.get('endDate') };
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-ex-right-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeRaw(root, market, year, body) {
  const dir = join(root, 'data', 'raw', market, 'ex_right', String(year));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${year}.json`), body);
}

test('annual ex_right snapshots checkpoint history, refresh current year, and delay only between requests', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    const sleeps = [];
    const bodies = new Map();
    const fetcher = async (url, options) => {
      const info = requestInfo(url, options);
      calls.push(info);
      const body = info.market === 'twse'
        ? `${twseBody([['110年01月02日', '2330', '1', '2', '息']])}\n`
        : `${tpexBody([['110/01/02', '6488 ', '3', '4', '除權']])}\n`;
      bodies.set(`${info.market}-${info.year}`, body);
      return response(body);
    };
    const options = {
      rootDir: root,
      datasets: ['twse_ex_right', 'tpex_ex_right'],
      fetcher,
      now: () => new Date('2023-10-02T04:00:00Z'),
      exRightDelayMs: 17,
      exRightSleep: async (ms) => sleeps.push(ms),
    };
    const first = await runSnapshot(options);
    assert.equal(first.exitCode, 0);
    assert.deepEqual(calls, [
      { market: 'twse', year: 2021, end: '20211231' },
      { market: 'twse', year: 2022, end: '20221231' },
      { market: 'twse', year: 2023, end: '20231002' },
      { market: 'tpex', year: 2021, end: '2021/12/31' },
      { market: 'tpex', year: 2022, end: '2022/12/31' },
      { market: 'tpex', year: 2023, end: '2023/10/02' },
    ]);
    assert.deepEqual(sleeps, [17, 17, 17, 17]);
    assert.equal(
      await readFile(join(root, 'data/raw/tpex/ex_right/2022/2022.json'), 'utf8'),
      bodies.get('tpex-2022'),
    );

    calls.length = 0;
    sleeps.length = 0;
    const second = await runSnapshot(options);
    assert.equal(second.exitCode, 0);
    assert.deepEqual(calls, [
      { market: 'twse', year: 2023, end: '20231002' },
      { market: 'tpex', year: 2023, end: '2023/10/02' },
    ]);
    assert.deepEqual(sleeps, []);
    assert.deepEqual(second.results.map((item) => [item.key, item.status]), [
      ['twse_ex_right', 'same'],
      ['tpex_ex_right', 'same'],
    ]);
  });
});

test('truncated TPEX responses retry three times, fail-stop that market, and preserve a later complete retry byte-for-byte', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    const short = tpexBody([['110/01/02', '6488', '3', '4', '除息']], 2);
    const summary = await runSnapshot({
      rootDir: root,
      datasets: ['twse_ex_right', 'tpex_ex_right'],
      now: () => new Date('2023-10-02T04:00:00Z'),
      exRightDelayMs: 0,
      exRightSleep: async () => {},
      fetcher: async (url, options) => {
        const info = requestInfo(url, options);
        calls.push(info);
        return response(info.market === 'twse' ? twseBody() : short);
      },
    });
    assert.equal(summary.exitCode, 0);
    assert.equal(calls.filter((item) => item.market === 'tpex' && item.year === 2021).length, 3);
    assert.equal(calls.some((item) => item.market === 'tpex' && item.year > 2021), false);
    assert.equal(calls.filter((item) => item.market === 'twse').length, 3);
    await assert.rejects(access(join(root, 'data/raw/tpex/ex_right/2021/2021.json')));
  });

  await withTempDir(async (root) => {
    let tpex2021Calls = 0;
    const complete = `${tpexBody([['110/01/02', '6488 ', '3', '4', '除權息']])}\n`;
    const summary = await runSnapshot({
      rootDir: root,
      datasets: ['tpex_ex_right'],
      now: () => new Date('2021-10-02T04:00:00Z'),
      exRightDelayMs: 0,
      exRightSleep: async () => {},
      fetcher: async () => {
        tpex2021Calls += 1;
        return response(tpex2021Calls === 1 ? '{"tables":[' : complete);
      },
    });
    assert.equal(summary.exitCode, 0);
    assert.equal(tpex2021Calls, 2);
    assert.equal(await readFile(join(root, 'data/raw/tpex/ex_right/2021/2021.json'), 'utf8'), complete);
  });
});

test('HTTP and fetch failures make one request per market with no retry sleep', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    const sleeps = [];
    const summary = await runSnapshot({
      rootDir: root,
      datasets: ['twse_ex_right', 'tpex_ex_right'],
      now: () => new Date('2021-10-02T04:00:00Z'),
      exRightDelayMs: 99,
      exRightSleep: async (ms) => sleeps.push(ms),
      fetcher: async (url, options) => {
        const info = requestInfo(url, options);
        calls.push(info.market);
        if (info.market === 'twse') return response('', 503);
        throw new Error('offline fixture');
      },
    });
    assert.equal(summary.exitCode, 1);
    assert.deepEqual(calls, ['twse', 'tpex']);
    assert.deepEqual(sleeps, []);
    assert.match(summary.results[0].error, /HTTP 503/);
    assert.match(summary.results[1].error, /fetch: offline fixture/);
  });
});

test('corporate action derivation parses both ROC formats, normalizes values, sorts and deduplicates, and excludes six-digit ids', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', 2025, twseBody([
      ['114年10月02日', '2330', '1,005.5', '1,000', '息'],
      ['114年01月03日', '2330', '900', '880', '權'],
      ['114年05月01日', '123456', '10', '9', '息'],
    ]));
    await writeRaw(root, 'twse', 2026, twseBody([
      ['114年10月02日', '2330', '1,006', '1,001', '權息'],
    ]));
    await writeRaw(root, 'tpex', 2025, tpexBody([
      ['114/02/04', '6488 ', '2,000', '1,950.5', '除權息'],
    ]));

    const first = await applyCorporateActions(root);
    assert.deepEqual(first, { corporateActions: 2, written: 2 });
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data/derived/corporate_actions/23/2330.json'), 'utf8')),
      {
        id: '2330',
        updated: '2025-10-02',
        cols: ['d', 'pre', 'ref', 'kind'],
        rows: [
          ['2025-01-03', 900, 880, '權'],
          ['2025-10-02', 1006, 1001, '權息'],
        ],
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data/derived/corporate_actions/64/6488.json'), 'utf8')),
      {
        id: '6488',
        updated: '2025-02-04',
        cols: ['d', 'pre', 'ref', 'kind'],
        rows: [['2025-02-04', 2000, 1950.5, '權息']],
      },
    );
    await assert.rejects(access(join(root, 'data/derived/corporate_actions/12/123456.json')));
    assert.deepEqual(await applyCorporateActions(root), { corporateActions: 2, written: 0 });
  });
});

test('run manifest registration preserves latestTradingDate and buildDerived recreates identical corporate action bytes', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data/manifest.json'), `${JSON.stringify({
      generatedAt: '2021-10-01T00:00:00Z',
      latestTradingDate: '2021-09-30',
      datasets: {
        twse_mi_index: { first: '2021-09-30', latest: '2021-09-30', days: 1, ok: true },
      },
    }, null, 2)}\n`);
    const summary = await runSnapshot({
      rootDir: root,
      datasets: ['twse_ex_right', 'tpex_ex_right'],
      now: () => new Date('2021-10-02T04:00:00Z'),
      exRightDelayMs: 0,
      exRightSleep: async () => {},
      fetcher: async (url, options) => {
        const info = requestInfo(url, options);
        return response(info.market === 'twse'
          ? twseBody([['110年10月02日', '2330', '600', '590', '息']])
          : tpexBody([['110/09/01', '6488 ', '800', '780', '除權']]));
      },
    });
    assert.equal(summary.exitCode, 0);
    const manifest = JSON.parse(await readFile(join(root, 'data/manifest.json'), 'utf8'));
    assert.deepEqual(manifest.datasets.twse_ex_right, {
      first: '2021-01-01', latest: '2021-10-02', years: 1, ok: true,
    });
    assert.deepEqual(manifest.datasets.tpex_ex_right, {
      first: '2021-01-01', latest: '2021-10-02', years: 1, ok: true,
    });
    assert.equal(manifest.paths.corporateActions, 'data/derived/corporate_actions/{p2}/{id}.json');
    assert.equal(manifest.latestTradingDate, '2021-09-30');

    await runSnapshot({
      rootDir: root,
      datasets: ['fred_t10y2y'],
      now: () => new Date('2021-10-02T04:00:00Z'),
      fetcher: async () => response('observation_date,T10Y2Y\n2021-10-01,1.25\n'),
    });
    const normalized = JSON.parse(await readFile(join(root, 'data/manifest.json'), 'utf8'));
    assert.deepEqual(normalized.datasets.twse_ex_right, manifest.datasets.twse_ex_right);
    assert.deepEqual(normalized.datasets.tpex_ex_right, manifest.datasets.tpex_ex_right);

    const path = join(root, 'data/derived/corporate_actions/23/2330.json');
    const incremental = await readFile(path);
    await rm(join(root, 'data/derived'), { recursive: true, force: true });
    const rebuilt = await buildDerived({ rootDir: root });
    assert.equal(rebuilt.corporateActions, 2);
    assert.deepEqual(await readFile(path), incremental);
  });
});
