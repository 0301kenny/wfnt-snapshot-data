import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSnapshot } from '../scripts/run.mjs';

function jsonBody(rows) {
  return JSON.stringify(rows);
}

function fixtureBodies(overrides = {}) {
  return {
    twse_mi_index: jsonBody([{ '日期': '1150706', '指數': '寶島股價指數', '收盤指數': '1' }]),
    twse_stock_day_all: jsonBody([{ Date: '1150706', Code: '2330', Name: '台積電', TradeVolume: '1', ClosingPrice: '1' }]),
    twse_mi_margn: jsonBody([{ '股票代號': '2330', '股票名稱': '台積電', '融資買進': '1', '融資今日餘額': '1' }]),
    tpex_index: jsonBody([{ Date: '20260706', Open: '1', High: '1', Low: '1', Close: '1' }]),
    tpex_mainboard_close: jsonBody([{ Date: '1150706', SecuritiesCompanyCode: '006201', CompanyName: '元大富櫃50', Close: '1' }]),
    tpex_3insti: jsonBody([{ Date: '1150706', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', TotalDifference: '1' }]),
    tpex_margin: jsonBody([{ Date: '1150706', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', MarginPurchaseBalance: '1' }]),
    ...overrides,
  };
}

const urls = {
  twse_mi_index: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',
  twse_stock_day_all: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  twse_mi_margn: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN',
  tpex_index: 'https://www.tpex.org.tw/openapi/v1/tpex_index',
  tpex_mainboard_close: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  tpex_3insti: 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading',
  tpex_margin: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance',
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}

function fetcherFor(bodies, failures = {}) {
  const byUrl = new Map(Object.entries(urls).map(([key, url]) => [url, key]));
  return async (url) => {
    const key = byUrl.get(url);
    assert.ok(key, `unexpected URL ${url}`);
    if (failures[key]) return response(failures[key].body ?? '', failures[key].status);
    return response(bodies[key]);
  };
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-snapshot-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function manifest(root) {
  return JSON.parse(await readFile(join(root, 'data', 'manifest.json'), 'utf8'));
}

test('anchor date parse failure aborts that market and exits non-zero when both anchors fail', async () => {
  await withTempDir(async (root) => {
    const bodies = fixtureBodies({
      twse_mi_index: jsonBody([{ '日期': 'bad', '指數': '寶島股價指數', '收盤指數': '1' }]),
      tpex_index: jsonBody([{ Date: 'bad', Open: '1', High: '1', Low: '1', Close: '1' }]),
    });
    const summary = await runSnapshot({ rootDir: root, fetcher: fetcherFor(bodies), now: () => new Date('2026-07-06T13:45:00Z') });
    assert.equal(summary.exitCode, 1);
    const m = await manifest(root);
    assert.equal(m.datasets.twse_stock_day_all.ok, false);
    assert.equal(m.datasets.twse_stock_day_all.lastError, 'schema: 日期欄不可解析');
    await assert.rejects(readFile(join(root, 'data', 'raw', 'twse', 'stock_day_all', '2026', '2026-07-06.json')));
  });
});

test('single endpoint failure records deterministic lastError and exits zero', async () => {
  await withTempDir(async (root) => {
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtureBodies(), { tpex_margin: { status: 503 } }),
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    assert.equal(summary.exitCode, 0);
    const m = await manifest(root);
    assert.equal(m.datasets.tpex_margin.ok, false);
    assert.equal(m.datasets.tpex_margin.lastError, 'HTTP 503');
    assert.equal(m.datasets.twse_mi_index.ok, true);
  });
});

test('first run writes raw paths and manifest contract with seven datasets', async () => {
  await withTempDir(async (root) => {
    const summary = await runSnapshot({ rootDir: root, fetcher: fetcherFor(fixtureBodies()), now: () => new Date('2026-07-06T13:45:00Z') });
    assert.equal(summary.exitCode, 0);
    const raw = await readFile(join(root, 'data', 'raw', 'twse', 'stock_day_all', '2026', '2026-07-06.json'), 'utf8');
    assert.equal(raw, fixtureBodies().twse_stock_day_all);
    const m = await manifest(root);
    assert.equal(m.schemaVersion, 1);
    assert.equal(m.generatedAt, '2026-07-06T13:45:00Z');
    assert.equal(m.latestTradingDate, '2026-07-06');
    assert.deepEqual(Object.keys(m.datasets), [
      'twse_mi_index',
      'twse_stock_day_all',
      'twse_mi_margn',
      'tpex_index',
      'tpex_mainboard_close',
      'tpex_3insti',
      'tpex_margin',
    ]);
    assert.equal(m.datasets.tpex_3insti.ok, true);
    assert.equal(m.paths.raw, 'data/raw/{source_dataset}/{yyyy}/{date}.json');
  });
});

test('anchor endpoint with multiple row dates uses max date for raw path', async () => {
  await withTempDir(async (root) => {
    const bodies = fixtureBodies({
      tpex_index: jsonBody([
        { Date: '20260701', Open: '1', High: '1', Low: '1', Close: '1' },
        { Date: '20260702', Open: '1', High: '1', Low: '1', Close: '1' },
        { Date: '20260703', Open: '1', High: '1', Low: '1', Close: '1' },
      ]),
    });
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(bodies),
      datasets: ['tpex_index'],
      now: () => new Date('2026-07-03T13:45:00Z'),
    });
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.results.find((result) => result.key === 'tpex_index').date, '2026-07-03');
    const raw = await readFile(join(root, 'data', 'raw', 'tpex', 'index', '2026', '2026-07-03.json'), 'utf8');
    assert.equal(raw, bodies.tpex_index);
    await assert.rejects(readFile(join(root, 'data', 'raw', 'tpex', 'index', '2026', '2026-07-01.json')));
  });
});

test('same-day rerun is byte-level no-op', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(fixtureBodies()), now: () => new Date('2026-07-06T13:45:00Z') });
    const before = await readFile(join(root, 'data', 'manifest.json'), 'utf8');
    const rawBefore = await readFile(join(root, 'data', 'raw', 'twse', 'mi_index', '2026', '2026-07-06.json'), 'utf8');
    const summary = await runSnapshot({ rootDir: root, fetcher: fetcherFor(fixtureBodies()), now: () => new Date('2026-07-06T14:45:00Z') });
    const after = await readFile(join(root, 'data', 'manifest.json'), 'utf8');
    const rawAfter = await readFile(join(root, 'data', 'raw', 'twse', 'mi_index', '2026', '2026-07-06.json'), 'utf8');
    assert.equal(summary.exitCode, 0);
    assert.equal(after, before);
    assert.equal(rawAfter, rawBefore);
  });
});

test('stale hash guard skips dataset and does not advance manifest', async () => {
  await withTempDir(async (root) => {
    const day1 = fixtureBodies({
      twse_mi_index: jsonBody([{ '日期': '1150703', '指數': '寶島股價指數', '收盤指數': '1' }]),
      twse_stock_day_all: jsonBody([{ Date: '1150703', Code: '2330', Name: '台積電', TradeVolume: '1', ClosingPrice: '1' }]),
      tpex_index: jsonBody([{ Date: '20260703', Open: '1', High: '1', Low: '1', Close: '1' }]),
      tpex_mainboard_close: jsonBody([{ Date: '1150703', SecuritiesCompanyCode: '006201', CompanyName: '元大富櫃50', Close: '1' }]),
      tpex_3insti: jsonBody([{ Date: '1150703', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', TotalDifference: '1' }]),
      tpex_margin: jsonBody([{ Date: '1150703', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', MarginPurchaseBalance: '1' }]),
    });
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(day1), now: () => new Date('2026-07-03T13:45:00Z') });
    const day2 = fixtureBodies({
      twse_stock_day_all: day1.twse_stock_day_all,
    });
    const summary = await runSnapshot({ rootDir: root, fetcher: fetcherFor(day2), now: () => new Date('2026-07-06T13:45:00Z') });
    assert.equal(summary.exitCode, 0);
    const m = await manifest(root);
    assert.equal(m.datasets.twse_stock_day_all.latest, '2026-07-03');
    await assert.rejects(readFile(join(root, 'data', 'raw', 'twse', 'stock_day_all', '2026', '2026-07-06.json')));
  });
});

test('different hash on existing date revises raw', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(fixtureBodies()), now: () => new Date('2026-07-06T13:45:00Z') });
    const revisedBodies = fixtureBodies({
      twse_mi_index: jsonBody([{ '日期': '1150706', '指數': '寶島股價指數', '收盤指數': '2' }]),
    });
    const summary = await runSnapshot({ rootDir: root, fetcher: fetcherFor(revisedBodies), now: () => new Date('2026-07-06T14:45:00Z') });
    assert.equal(summary.exitCode, 0);
    assert.match(summary.commitMessage, /^revise: 2026-07-06/);
    const raw = await readFile(join(root, 'data', 'raw', 'twse', 'mi_index', '2026', '2026-07-06.json'), 'utf8');
    assert.equal(raw, revisedBodies.twse_mi_index);
  });
});
