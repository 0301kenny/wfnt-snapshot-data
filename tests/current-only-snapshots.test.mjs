import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSnapshot } from '../scripts/run.mjs';

const DAILY = [
  ['twse_material_info', 'twse/material_info'],
  ['tpex_material_info', 'tpex/material_info'],
  ['twse_exright_forecast', 'twse/exright_forecast'],
  ['tpex_exright_forecast', 'tpex/exright_forecast'],
  ['twse_trading_halt', 'twse/trading_halt'],
  ['twse_margin_suspension', 'twse/margin_suspension'],
  ['tpex_trading_halt', 'tpex/trading_halt'],
  ['tpex_short_suspension', 'tpex/short_suspension'],
  ['twse_sbl_available', 'twse/sbl_available'],
];

const MONTHLY = [
  ['twse_holiday_schedule', 'twse/holiday_schedule'],
  ['twse_agm_notice', 'twse/agm_notice'],
  ['twse_agm_dates', 'twse/agm_dates'],
  ['twse_dividend', 'twse/dividend'],
  ['tpex_dividend', 'tpex/dividend'],
];

const CURRENT_ONLY_KEYS = [...DAILY, ...MONTHLY].map(([key]) => key);
const EMPTY_OK_KEYS = DAILY.slice(0, 8).map(([key]) => key);

const URLS = {
  twse_mi_index: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',
  twse_stock_day_all: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  twse_mi_margn: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN',
  tpex_index: 'https://www.tpex.org.tw/openapi/v1/tpex_index',
  tpex_mainboard_close: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  twse_material_info: 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L',
  tpex_material_info: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O',
  twse_exright_forecast: 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL',
  tpex_exright_forecast: 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost',
  twse_trading_halt: 'https://openapi.twse.com.tw/v1/exchangeReport/TWTAWU',
  twse_margin_suspension: 'https://openapi.twse.com.tw/v1/exchangeReport/BFI84U',
  tpex_trading_halt: 'https://www.tpex.org.tw/openapi/v1/tpex_spendi_today',
  tpex_short_suspension: 'https://www.tpex.org.tw/openapi/v1/tpex_margin_trading_term',
  twse_sbl_available: 'https://openapi.twse.com.tw/v1/SBL/TWT96U',
  twse_holiday_schedule: 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule',
  twse_agm_notice: 'https://openapi.twse.com.tw/v1/opendata/t187ap38_L',
  twse_agm_dates: 'https://openapi.twse.com.tw/v1/opendata/t187ap41_L',
  twse_dividend: 'https://openapi.twse.com.tw/v1/opendata/t187ap45_L',
  tpex_dividend: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap39_O',
};

function json(rows) {
  return JSON.stringify(rows);
}

function fixtures(overrides = {}, anchorDate = '2026-10-30') {
  const compact = anchorDate.replaceAll('-', '');
  const roc = `${Number(compact.slice(0, 4)) - 1911}${compact.slice(4)}`;
  return {
    twse_mi_index: json([{ '日期': roc, '指數': '寶島股價指數', '收盤指數': '1' }]),
    twse_stock_day_all: json([{ Date: roc, Code: '2330', Name: '台積電', TradeVolume: '1', ClosingPrice: '1' }]),
    twse_mi_margn: json([{ '股票代號': '2330', '股票名稱': '台積電', '融資買進': '1', '融資今日餘額': '1' }]),
    tpex_index: json([{ Date: compact, Open: '1', High: '1', Low: '1', Close: '1' }]),
    tpex_mainboard_close: json([{ Date: roc, SecuritiesCompanyCode: '6488', CompanyName: '環球晶', Close: '1' }]),
    twse_material_info: json([{ '出表日期': '0990101', '發言日期': '0990101', '公司代號': '2330', '主旨 ': '甲' }]),
    tpex_material_info: json([{ Date: '20100101', '發言日期': '0990101', SecuritiesCompanyCode: '6488', '主旨': '乙' }]),
    twse_exright_forecast: json([{ Date: '20100101', Code: '2330', Name: '台積電', Exdividend: '息' }]),
    tpex_exright_forecast: json([{ ExRrightsExDividendDate: '20100101', SecuritiesCompanyCode: '6488', ExRrightsExDividend: '息' }]),
    twse_trading_halt: json([{ Code: '2330', Name: '台積電', TradingHaltDate: '20100101' }]),
    twse_margin_suspension: json([{ Code: '2330', Name: '台積電', StartDate: '20100101', EndDate: '20100102' }]),
    tpex_trading_halt: json([{ Date: '20100101', SecuritiesCompanyCode: '6488', CompanyName: '環球晶' }]),
    tpex_short_suspension: json([{ Date: '20100101', SecuritiesCompanyCode: '6488', ShortSaleSuspensionStartDate: '20100101' }]),
    twse_sbl_available: json([{ TWSECode: '2330', TWSEAvailableVolume: '1000' }]),
    twse_holiday_schedule: json([{ Name: '中華民國開國紀念日', Date: '20260101' }]),
    twse_agm_notice: json([{ '出表日期': '0990101', '公司代號': '2330' }]),
    twse_agm_dates: json([{ '出表日期': '0990101', '公司代號': '2330', '開會日期': '0990201' }]),
    twse_dividend: json([{ '出表日期': '0990101', '公司代號': '2330', '股利年度': '98' }]),
    tpex_dividend: json([{ '出表日期': '1100804', '公司代號': '6488', '股利年度': '109' }]),
    ...overrides,
  };
}

function response(body, status = 200) {
  const bytes = Buffer.from(body ?? '', 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function fetcherFor(bodies, failures = {}, calls = []) {
  const byUrl = new Map(Object.entries(URLS).map(([key, url]) => [url, key]));
  return async (url) => {
    const key = byUrl.get(url);
    assert.ok(key, `unexpected URL ${url}`);
    calls.push(key);
    if (failures[key]) return response(failures[key].body, failures[key].status);
    return response(bodies[key]);
  };
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-current-only-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readManifest(root) {
  return JSON.parse(await readFile(join(root, 'data', 'manifest.json'), 'utf8'));
}

async function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, base));
    else files.push(path.slice(base.length + 1));
  }
  return files.sort();
}

function dailyPath(root, sourceDataset, date = '2026-10-30') {
  return join(root, 'data', 'raw', sourceDataset, date.slice(0, 4), `${date}.json`);
}

function monthlyPath(root, sourceDataset, month = '2026-11') {
  return join(root, 'data', 'raw', sourceDataset, month.slice(0, 4), `${month}.json`);
}

test('all 14 current-only endpoints preserve response bytes at anchor-date or Taipei-run-month paths', async () => {
  await withTempDir(async (root) => {
    const bodies = fixtures();
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(bodies),
      datasets: CURRENT_ONLY_KEYS,
      now: () => new Date('2026-10-31T16:30:00Z'),
    });
    assert.equal(summary.exitCode, 0);
    for (const [key, sourceDataset] of DAILY) {
      assert.deepEqual(await readFile(dailyPath(root, sourceDataset)), Buffer.from(bodies[key]));
    }
    for (const [key, sourceDataset] of MONTHLY) {
      assert.deepEqual(await readFile(monthlyPath(root, sourceDataset)), Buffer.from(bodies[key]));
    }
    console.log(`TICKET_299_DRY_RUN_FILES=${JSON.stringify(await listFiles(join(root, 'data')))}`);
  });
});

test('only the eight approved daily endpoints accept an empty JSON array', async () => {
  await withTempDir(async (root) => {
    for (const key of EMPTY_OK_KEYS) {
      const summary = await runSnapshot({
        rootDir: root,
        fetcher: fetcherFor(fixtures({ [key]: '[]' })),
        datasets: [key],
        now: () => new Date('2026-10-30T12:00:00Z'),
      });
      assert.equal(summary.results.find((result) => result.key === key)?.ok, true, key);
    }
    const manifestAfterAllowed = await readManifest(root);
    for (const key of EMPTY_OK_KEYS) assert.equal(manifestAfterAllowed.datasets[key].ok, true, key);

    const sbl = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtures({ twse_sbl_available: '[]' })),
      datasets: ['twse_sbl_available'],
      now: () => new Date('2026-10-30T12:00:00Z'),
    });
    assert.equal(sbl.results.find((result) => result.key === 'twse_sbl_available')?.error, 'schema: JSON 不是非空陣列');
    await assert.rejects(readFile(dailyPath(root, 'twse/sbl_available')));

    const existing = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtures({ twse_mi_margn: '[]' })),
      datasets: ['twse_mi_margn'],
      now: () => new Date('2026-10-30T12:00:00Z'),
    });
    assert.equal(existing.results.find((result) => result.key === 'twse_mi_margn')?.error, 'schema: JSON 不是非空陣列');
    await assert.rejects(readFile(dailyPath(root, 'twse/mi_margn')));
  });
});

test('current-only writes leave derived bytes unchanged and call no daily or monthly derived transform', async () => {
  await withTempDir(async (root) => {
    const derivedDir = join(root, 'data', 'derived');
    const sentinel = join(derivedDir, 'sentinel.bin');
    await mkdir(derivedDir, { recursive: true });
    await writeFile(sentinel, Buffer.from([0, 1, 2, 255]));
    const before = await readFile(sentinel);
    let dailyCalls = 0;
    let monthlyCalls = 0;
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtures()),
      datasets: CURRENT_ONLY_KEYS,
      now: () => new Date('2026-10-31T16:30:00Z'),
      applyDailyDateImpl: async () => { dailyCalls += 1; },
      applyMonthlyRevenueImpl: async () => { monthlyCalls += 1; },
    });
    assert.equal(dailyCalls, 0);
    assert.equal(monthlyCalls, 0);
    assert.deepEqual(await readFile(sentinel), before);
    assert.deepEqual(await readdir(derivedDir), ['sentinel.bin']);
  });
});

test('current-only daily writes do not advance manifest latestTradingDate', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtures()),
      datasets: ['twse_mi_index'],
      now: () => new Date('2026-10-30T12:00:00Z'),
      applyDailyDateImpl: async () => ({ symbols: 0, fundamentals: 0, market: false }),
    });
    assert.equal((await readManifest(root)).latestTradingDate, '2026-10-30');

    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtures({}, '2026-10-31')),
      datasets: DAILY.map(([key]) => key),
      now: () => new Date('2026-10-31T12:00:00Z'),
    });
    assert.equal((await readManifest(root)).latestTradingDate, '2026-10-30');
  });
});

test("tpex dividend ignores old 出表日期 and uses the injected clock's Taipei month", async () => {
  await withTempDir(async (root) => {
    const bodies = fixtures();
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(bodies),
      datasets: ['tpex_dividend'],
      now: () => new Date('2026-10-31T16:30:00Z'),
    });
    assert.deepEqual(await readFile(monthlyPath(root, 'tpex/dividend')), Buffer.from(bodies.tpex_dividend));
    await assert.rejects(readFile(monthlyPath(root, 'tpex/dividend', '2021-08')));
  });
});

test('same-month rerun is same without rewriting and changed content is revise', async () => {
  await withTempDir(async (root) => {
    const path = monthlyPath(root, 'twse/agm_notice');
    const firstBodies = fixtures();
    const first = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(firstBodies),
      datasets: ['twse_agm_notice'],
      now: () => new Date('2026-10-31T16:30:00Z'),
    });
    assert.equal(first.results.find((result) => result.key === 'twse_agm_notice')?.status, 'write');
    const oldTime = new Date('2000-01-01T00:00:00Z');
    await utimes(path, oldTime, oldTime);

    const same = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(firstBodies),
      datasets: ['twse_agm_notice'],
      now: () => new Date('2026-11-01T01:00:00Z'),
    });
    assert.equal(same.results.find((result) => result.key === 'twse_agm_notice')?.status, 'same');
    assert.equal((await stat(path)).mtimeMs, oldTime.getTime());

    const revisedBody = json([{ '出表日期': '0990101', '公司代號': '2317' }]);
    const revised = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtures({ twse_agm_notice: revisedBody })),
      datasets: ['twse_agm_notice'],
      now: () => new Date('2026-11-01T02:00:00Z'),
    });
    assert.equal(revised.results.find((result) => result.key === 'twse_agm_notice')?.status, 'revise');
    assert.deepEqual(await readFile(path), Buffer.from(revisedBody));
    assert.notEqual((await stat(path)).mtimeMs, oldTime.getTime());
  });
});

test('one new endpoint HTTP 500 records only its error while other new and existing datasets write', async () => {
  await withTempDir(async (root) => {
    const selected = [...CURRENT_ONLY_KEYS, 'twse_stock_day_all', 'tpex_mainboard_close'];
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtures(), { twse_material_info: { status: 500 } }),
      datasets: selected,
      now: () => new Date('2026-10-31T16:30:00Z'),
      applyDailyDateImpl: async () => ({ symbols: 0, fundamentals: 0, market: false }),
    });
    assert.equal(summary.exitCode, 0);
    assert.deepEqual(summary.results.filter((result) => !result.ok).map((result) => result.key), ['twse_material_info']);
    assert.equal((await readManifest(root)).datasets.twse_material_info.lastError, 'HTTP 500');
    await assert.rejects(readFile(dailyPath(root, 'twse/material_info')));
    await readFile(dailyPath(root, 'tpex/material_info'));
    await readFile(dailyPath(root, 'twse/stock_day_all'));
    await readFile(dailyPath(root, 'tpex/mainboard_close'));
  });
});

test('--datasets equivalent selects one new endpoint plus only its required market anchor', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtures(), {}, calls),
      datasets: ['twse_material_info'],
      now: () => new Date('2026-10-30T12:00:00Z'),
    });
    assert.deepEqual(calls, ['twse_mi_index', 'twse_material_info']);
    await readFile(dailyPath(root, 'twse/material_info'));
    await assert.rejects(readFile(dailyPath(root, 'twse/exright_forecast')));
  });
});
