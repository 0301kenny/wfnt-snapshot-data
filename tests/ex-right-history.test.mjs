import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exRightBackfillOptionsFromArgs, runExRightBackfill } from '../scripts/backfill-ex-right.mjs';
import { applyCorporateActions } from '../scripts/lib/derived.mjs';
import { fetchExRightDataset } from '../scripts/lib/ex-right.mjs';

const TWSE_FIELDS = ['資料日期', '股票代號', '除權息前收盤價', '除權息參考價', '權/息'];
const TPEX_FIELDS = ['除權息日期', '代號', '除權息前收盤價', '除權息參考價', '權/息'];

function twseBody(year, data = []) {
  return JSON.stringify({ stat: 'OK', endDate: `${year}1231`, fields: TWSE_FIELDS, data });
}

function tpexBody(year, data = []) {
  return JSON.stringify({
    date: `${year}0101~${year}1231`,
    tables: [{ totalCount: data.length, fields: TPEX_FIELDS, data }],
  });
}

function response(body) {
  const bytes = Buffer.from(body);
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function requestYear(url, options = {}) {
  if (url.includes('/TWT49U?')) return Number(new URL(url).searchParams.get('startDate').slice(0, 4));
  return Number(new URLSearchParams(options.body).get('startDate').slice(0, 4));
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-ex-right-history-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('fetchExRightDataset keeps the 2021 default when startYear is omitted', async () => {
  await withTempDir(async (root) => {
    const years = [];
    const result = await fetchExRightDataset(root, 'twse_ex_right', '2023-10-02', {
      delayMs: 0,
      sleepImpl: async () => {},
      fetcher: async (url, options) => {
        const year = requestYear(url, options);
        years.push(year);
        return response(twseBody(year));
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(years, [2021, 2022, 2023]);
  });
});

test('early ex-right CLI requests only its explicit range, skips empty raw, and derives early events once', async () => {
  await withTempDir(async (root) => {
    const years = [];
    const logs = [];
    let applyCalls = 0;
    const summary = await runExRightBackfill({
      rootDir: root,
      market: 'tpex',
      fromYear: 2006,
      toYear: 2007,
      delayMs: 0,
      now: () => new Date('2026-10-17T04:00:00Z'),
      fetcher: async (url, options) => {
        const year = requestYear(url, options);
        years.push(year);
        return response(tpexBody(year, year === 2006
          ? [['095/10/02', '6488 ', '100', '95.5', '除權息']]
          : []));
      },
      sleepImpl: async () => {},
      applyCorporateActionsImpl: async (target) => {
        applyCalls += 1;
        return applyCorporateActions(target);
      },
      logger: { log: (line) => logs.push(line) },
    });
    assert.deepEqual(years, [2006, 2007]);
    assert.equal(applyCalls, 1);
    assert.equal(summary.empty, 1);
    assert.equal(logs.includes('[empty] tpex 2007'), true);
    assert.equal(
      JSON.parse(await readFile(join(root, 'data/raw/tpex/ex_right/2006/2006.json'), 'utf8')).date,
      '20060101~20061231',
    );
    await assert.rejects(access(join(root, 'data/raw/tpex/ex_right/2007/2007.json')), { code: 'ENOENT' });
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'data/derived/corporate_actions/64/6488.json'), 'utf8')).rows,
      [['2006-10-02', 100, 95.5, '權息']],
    );
  });
});

test('early ex-right backfill retains the historical December 31 checkpoint', async () => {
  await withTempDir(async (root) => {
    let requests = 0;
    const options = {
      rootDir: root,
      market: 'twse',
      fromYear: 2006,
      toYear: 2006,
      delayMs: 0,
      now: () => new Date('2026-10-17T04:00:00Z'),
      fetcher: async () => {
        requests += 1;
        return response(twseBody(2006, [['095年10月02日', '2330', '100', '98', '息']]));
      },
      sleepImpl: async () => {},
    };
    await runExRightBackfill(options);
    await runExRightBackfill(options);
    assert.equal(requests, 1);
  });
});

test('early ex-right CLI rejects the Taipei current year and bare numeric flags before fetch', async () => {
  const now = () => new Date('2026-10-17T04:00:00Z');
  assert.throws(
    () => exRightBackfillOptionsFromArgs({ market: 'twse', 'from-year': '2006', 'to-year': '2026' }, { now }),
    /must be before Taipei current year 2026/,
  );
  assert.throws(
    () => exRightBackfillOptionsFromArgs({ market: 'twse', 'from-year': true, 'to-year': '2007' }, { now }),
    /got: NaN/,
  );
  let fetchCalls = 0;
  await assert.rejects(
    runExRightBackfill({
      rootDir: '/tmp/not-used-wfnt-ex-right-history',
      market: 'twse',
      fromYear: 2006,
      toYear: 2026,
      delayMs: 0,
      now,
      fetcher: async () => { fetchCalls += 1; },
    }),
    /must be before Taipei current year 2026/,
  );
  assert.equal(fetchCalls, 0);
});
