import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildDerived } from '../scripts/build-derived.mjs';
import { applyDailyDate } from '../scripts/lib/derived.mjs';
import { runSnapshot } from '../scripts/run.mjs';

function jsonBody(rows) {
  return JSON.stringify(rows);
}

function rawJsonArray(rows) {
  return `[
${rows.join(',\n')}
]`;
}

function fixtureBodies(overrides = {}) {
  return {
    twse_mi_index: jsonBody([{ '日期': '1150706', '指數': '寶島股價指數', '收盤指數': '1' }]),
    twse_stock_day_all: jsonBody([{ Date: '1150706', Code: '2330', Name: '台積電', TradeVolume: '1', ClosingPrice: '1' }]),
    twse_bwibbu_all: jsonBody([{ Date: '1150706', Code: '2330', Name: '台積電', PEratio: '25.1', PBratio: '5.2', DividendYield: '1.8' }]),
    twse_mi_margn: jsonBody([{ '股票代號': '2330', '股票名稱': '台積電', '融資買進': '1', '融資今日餘額': '1' }]),
    tpex_index: jsonBody([{ Date: '20260706', Open: '1', High: '1', Low: '1', Close: '1' }]),
    tpex_mainboard_close: jsonBody([{ Date: '1150706', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', Close: '1' }]),
    tpex_3insti: jsonBody([{ Date: '1150706', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', TotalDifference: '1' }]),
    tpex_margin: jsonBody([{ Date: '1150706', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', MarginPurchaseBalance: '1' }]),
    twse_monthly_revenue: jsonBody([{ '資料年月': '11506', '公司代號': '2330', '公司名稱': '台積電', '營業收入-當月營收': '123456789', '營業收入-去年同月增減(%)': '12.3', '營業收入-上月比較增減(%)': '-1.2' }]),
    tpex_monthly_revenue: jsonBody([{ '資料年月': '11506', '公司代號': '6488', '公司名稱': '環球晶', '營業收入-當月營收': '543210', '營業收入-去年同月增減(%)': '4.5', '營業收入-上月比較增減(%)': '2.1' }]),
    tdcc: '資料日期,證券代號,持股分級,人數\n20260704,2330,1,1\n20260704,0050,2,3\n',
    ...overrides,
  };
}

const urls = {
  twse_mi_index: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',
  twse_stock_day_all: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  twse_bwibbu_all: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  twse_mi_margn: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN',
  tpex_index: 'https://www.tpex.org.tw/openapi/v1/tpex_index',
  tpex_mainboard_close: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  tpex_3insti: 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading',
  tpex_margin: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance',
  twse_monthly_revenue: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
  tpex_monthly_revenue: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O',
  tdcc: 'https://opendata.tdcc.com.tw/getOD.ashx?id=1-5',
};

function response(body, status = 200) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return bytes.toString('utf8');
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function fetcherFor(bodies, failures = {}, calls = []) {
  const byUrl = new Map(Object.entries(urls).map(([key, url]) => [url, key]));
  return async (url) => {
    const key = byUrl.get(url);
    assert.ok(key, `unexpected URL ${url}`);
    calls.push({ key, url });
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

async function readJson(root, path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

async function fileMap(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = {};
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await fileMap(path, base));
    } else {
      result[path.slice(base.length + 1)] = await readFile(path, 'utf8');
    }
  }
  return result;
}

function tdccFixture(date = '20260704') {
  return [
    '資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%',
    `${date},2330,1,100,10000,1.10`,
    `${date},2330,2,50,20000,2.20`,
    `${date},2330,3,25,30000,3.30`,
    `${date},2330,12,5,400000,12.10`,
    `${date},2330,13,4,300000,13.20`,
    `${date},2330,14,3,200000,14.30`,
    `${date},2330,15,2,1000000,15.40`,
    `${date},2330,16,1,-1,-9.99`,
    `${date},2330,17,200,2000000,100.00`,
    `${date},123456,15,1,1000000,90.00`,
    `${date},123456,17,1,1000000,100.00`,
    `${date},2881A,1,1,100,1.00`,
    '',
  ].join('\n');
}

function derivedBodies(overrides = {}) {
  return fixtureBodies({
    twse_mi_index: jsonBody([
      { '日期': '1150706', '指數': '寶島股價指數', '收盤指數': '1' },
      { '日期': '1150706', '指數': '發行量加權股價指數', '收盤指數': '52227.97' },
    ]),
    twse_stock_day_all: jsonBody([
      {
        Date: '1150706',
        Code: '2330',
        Name: '台積電',
        TradeVolume: '32,145,678',
        TradeValue: '1',
        OpeningPrice: '1080',
        HighestPrice: '1090',
        LowestPrice: '1075',
        ClosingPrice: '1085',
        Change: '+1',
        Transaction: '45,210',
      },
      {
        Date: '1150706',
        Code: '123456',
        Name: '排除六碼',
        TradeVolume: '1',
        TradeValue: '1',
        OpeningPrice: '1',
        HighestPrice: '1',
        LowestPrice: '1',
        ClosingPrice: '1',
        Change: '0',
        Transaction: '1',
      },
    ]),
    twse_mi_margn: jsonBody([
      { '股票代號': '2330', '股票名稱': '台積電', '融資買進': '1', '融資今日餘額': '9,577', '融券今日餘額': '' },
      { '股票代號': '123456', '股票名稱': '排除六碼', '融資買進': '1', '融資今日餘額': '1', '融券今日餘額': '1' },
    ]),
    tpex_index: jsonBody([
      { Date: '20260704', Open: '420', High: '430', Low: '410', Close: '425' },
      { Date: '20260706', Open: '430', High: '440', Low: '429', Close: '431.23' },
    ]),
    tpex_mainboard_close: jsonBody([
      {
        Date: '1150706',
        SecuritiesCompanyCode: '00679B',
        CompanyName: '元大美債20年',
        Close: '49.30',
        Open: '48.30',
        High: '49.37',
        Low: '48.30',
        TradingShares: '216,609',
        TransactionNumber: '242',
      },
      {
        Date: '1150706',
        SecuritiesCompanyCode: '654321',
        CompanyName: '排除上櫃六碼',
        Close: '1',
        Open: '1',
        High: '1',
        Low: '1',
        TradingShares: '1',
        TransactionNumber: '1',
      },
    ]),
    tpex_3insti: rawJsonArray([
      '{"Date":"1150706","SecuritiesCompanyCode":"00679B","CompanyName":"元大美債20年","Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference":"999","ForeignInvestorsInclude MainlandAreaInvestors-Difference":"111","SecuritiesInvestmentTrustCompanies-Difference":"222","Dealers -Difference":"333","Dealers-Difference":"444","TotalDifference":"5,677,787"}',
      '{"Date":"1150706","SecuritiesCompanyCode":"654321","CompanyName":"排除上櫃六碼","TotalDifference":"1"}',
    ]),
    tpex_margin: jsonBody([
      { Date: '1150706', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', MarginPurchaseBalance: '5,949', ShortSaleBalance: '9' },
      { Date: '1150706', SecuritiesCompanyCode: '654321', CompanyName: '排除上櫃六碼', MarginPurchaseBalance: '1', ShortSaleBalance: '1' },
    ]),
    tdcc: tdccFixture(),
    ...overrides,
  });
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

test('first run writes raw paths and manifest contract with eleven datasets', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    const bodies = fixtureBodies();
    const summary = await runSnapshot({ rootDir: root, fetcher: fetcherFor(bodies, {}, calls), now: () => new Date('2026-07-06T13:45:00Z') });
    assert.equal(summary.exitCode, 0);
    assert.ok(calls.some((call) => call.key === 'tdcc'));
    const raw = await readFile(join(root, 'data', 'raw', 'twse', 'stock_day_all', '2026', '2026-07-06.json'), 'utf8');
    assert.equal(raw, bodies.twse_stock_day_all);
    const tdccRaw = await readFile(join(root, 'data', 'raw', 'tdcc', '2026', '2026-07-04.csv.gz'));
    assert.equal(gunzipSync(tdccRaw).toString('utf8'), bodies.tdcc);
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
      'tdcc',
      'twse_bwibbu_all',
      'twse_monthly_revenue',
      'tpex_monthly_revenue',
    ]);
    assert.equal(m.datasets.tpex_3insti.ok, true);
    assert.deepEqual(m.datasets.tdcc, {
      firstWeek: '2026-07-04',
      latestWeek: '2026-07-04',
      weeks: 1,
      ok: true,
    });
    assert.equal(m.paths.raw, 'data/raw/{source_dataset}/{yyyy}/{date}.json');
    assert.equal(m.paths.rawTdcc, 'data/raw/tdcc/{yyyy}/{date}.csv.gz');
    assert.equal(m.paths.rawMonthly, 'data/raw/{source_dataset}/{yyyy}/{yyyy}-{mm}.json');
    assert.equal(m.paths.symbol, 'data/derived/symbols/{p2}/{id}.json');
    assert.equal(m.paths.tdcc, 'data/derived/tdcc/{p2}/{id}.json');
    assert.equal(m.paths.market, 'data/derived/market.json');
    assert.equal(m.paths.fundamentals, 'data/derived/fundamentals/{p2}/{id}.json');
  });
});

test('fresh tdcc latestWeek skips default fetch and leaves manifest unchanged', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(fixtureBodies()), now: () => new Date('2026-07-06T13:45:00Z') });
    const before = await readFile(join(root, 'data', 'manifest.json'), 'utf8');
    const calls = [];
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtureBodies(), {}, calls),
      now: () => new Date('2026-07-09T01:00:00Z'),
    });
    const after = await readFile(join(root, 'data', 'manifest.json'), 'utf8');
    assert.equal(summary.exitCode, 0);
    assert.equal(after, before);
    assert.equal(calls.some((call) => call.key === 'tdcc'), false);
  });
});

test('stale tdcc latestWeek is fetched by default', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(fixtureBodies()), now: () => new Date('2026-07-06T13:45:00Z') });
    const calls = [];
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtureBodies(), {}, calls),
      now: () => new Date('2026-07-12T01:00:00Z'),
    });
    assert.equal(summary.exitCode, 0);
    assert.ok(calls.some((call) => call.key === 'tdcc'));
  });
});

test('explicit tdcc run bypasses freshness skip and same content is byte-level no-op', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtureBodies()),
      datasets: ['tdcc'],
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    const before = await readFile(join(root, 'data', 'manifest.json'), 'utf8');
    const rawBefore = await readFile(join(root, 'data', 'raw', 'tdcc', '2026', '2026-07-04.csv.gz'));
    const calls = [];
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtureBodies(), {}, calls),
      datasets: ['tdcc'],
      now: () => new Date('2026-07-09T01:00:00Z'),
    });
    const after = await readFile(join(root, 'data', 'manifest.json'), 'utf8');
    const rawAfter = await readFile(join(root, 'data', 'raw', 'tdcc', '2026', '2026-07-04.csv.gz'));
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.results.find((result) => result.key === 'tdcc').status, 'same');
    assert.equal(calls.some((call) => call.key === 'tdcc'), true);
    assert.equal(after, before);
    assert.deepEqual(rawAfter, rawBefore);
  });
});

test('tdcc schema failure records lastError while daily endpoints still succeed', async () => {
  await withTempDir(async (root) => {
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtureBodies({ tdcc: '證券代號,持股分級\n2330,1\n' })),
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    assert.equal(summary.exitCode, 0);
    const m = await manifest(root);
    assert.equal(m.datasets.tdcc.ok, false);
    assert.equal(m.datasets.tdcc.lastError, 'schema: 缺少欄位 資料日期');
    assert.equal(m.datasets.twse_mi_index.ok, true);
    await assert.rejects(readFile(join(root, 'data', 'raw', 'tdcc', '2026', '2026-07-04.csv.gz')));
  });
});

test('different tdcc content on same week revises compressed raw', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtureBodies()),
      datasets: ['tdcc'],
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    const revisedTdcc = '資料日期,證券代號,持股分級,人數\n20260704,2330,1,9\n20260704,0050,2,3\n';
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtureBodies({ tdcc: revisedTdcc })),
      datasets: ['tdcc'],
      now: () => new Date('2026-07-06T14:45:00Z'),
    });
    assert.equal(summary.exitCode, 0);
    assert.match(summary.commitMessage, /revise/);
    assert.match(summary.commitMessage, /tdcc/);
    const raw = await readFile(join(root, 'data', 'raw', 'tdcc', '2026', '2026-07-04.csv.gz'));
    assert.equal(gunzipSync(raw).toString('utf8'), revisedTdcc);
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
      tpex_mainboard_close: jsonBody([{ Date: '1150703', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', Close: '1' }]),
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

test('derived daily files map fields, market series, and exclude pure six digit symbols', async () => {
  await withTempDir(async (root) => {
    const summary = await runSnapshot({ rootDir: root, fetcher: fetcherFor(derivedBodies()), now: () => new Date('2026-07-06T13:45:00Z') });
    assert.equal(summary.exitCode, 0);

    const twse = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.deepEqual(twse, {
      id: '2330',
      name: '台積電',
      market: 'twse',
      updated: '2026-07-06',
      cols: ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd'],
      rows: [[20260706, 1080, 1090, 1075, 1085, 32145678, 45210, 9577, null, null, null, null, null]],
    });
    const tpex = await readJson(root, 'data/derived/symbols/00/00679B.json');
    assert.deepEqual(tpex, {
      id: '00679B',
      name: '元大美債20年',
      market: 'tpex',
      updated: '2026-07-06',
      cols: ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd'],
      rows: [[20260706, 48.3, 49.37, 48.3, 49.3, 216609, 242, 5949, 9, 5677787, 111, 222, 333]],
    });
    await assert.rejects(readFile(join(root, 'data', 'derived', 'symbols', '12', '123456.json')));
    await assert.rejects(readFile(join(root, 'data', 'derived', 'symbols', '65', '654321.json')));

    const market = await readJson(root, 'data/derived/market.json');
    assert.equal(market.updated, '2026-07-06');
    assert.deepEqual(market.twse.index, { cols: ['d', 'c'], rows: [[20260706, 52227.97]] });
    assert.deepEqual(market.tpex.index.rows, [
      [20260704, 420, 430, 410, 425],
      [20260706, 430, 440, 429, 431.23],
    ]);
    assert.deepEqual(market.twse.margin.rows, [[20260706, 9578, 1]]);
    assert.deepEqual(market.tpex.margin.rows, [[20260706, 5950, 10]]);
    assert.deepEqual(market.tpex.insti.rows, [[20260706, 5677788]]);
  });
});

test('derived tpex institution columns normalize whitespace, keep first collision, and leave missing data null', async () => {
  await withTempDir(async (root) => {
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(fixtureBodies({
        tpex_mainboard_close: jsonBody([
          { Date: '1150706', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', Close: '1', Open: '1', High: '1', Low: '1', TradingShares: '1', TransactionNumber: '1' },
          { Date: '1150706', SecuritiesCompanyCode: '00700B', CompanyName: '七百B', Close: '1', Open: '1', High: '1', Low: '1', TradingShares: '1', TransactionNumber: '1' },
          { Date: '1150706', SecuritiesCompanyCode: '00800B', CompanyName: '八百B', Close: '1', Open: '1', High: '1', Low: '1', TradingShares: '1', TransactionNumber: '1' },
        ]),
        tpex_3insti: rawJsonArray([
          '{"Date":"1150706","SecuritiesCompanyCode":"00679B","CompanyName":"元大美債20年","Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference":"999","ForeignInvestorsInclude MainlandAreaInvestors-Difference":"111","SecuritiesInvestmentTrustCompanies-Difference":"222","Dealers -Difference":"333","Dealers-Difference":"444","TotalDifference":"5677787"}',
          '{"Date":"1150706","SecuritiesCompanyCode":"00800B","CompanyName":"八百B","ForeignInvestorsInclude MainlandAreaInvestors-Difference":"88","Dealers-Difference":"99","TotalDifference":"777"}',
        ]),
        tpex_margin: jsonBody([
          { Date: '1150706', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', MarginPurchaseBalance: '1', ShortSaleBalance: '2' },
          { Date: '1150706', SecuritiesCompanyCode: '00700B', CompanyName: '七百B', MarginPurchaseBalance: '3', ShortSaleBalance: '4' },
          { Date: '1150706', SecuritiesCompanyCode: '00800B', CompanyName: '八百B', MarginPurchaseBalance: '5', ShortSaleBalance: '6' },
        ]),
      })),
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    assert.equal(summary.exitCode, 0);

    const withAll = await readJson(root, 'data/derived/symbols/00/00679B.json');
    assert.deepEqual(withAll.rows[0].slice(9), [5677787, 111, 222, 333]);

    const missingRow = await readJson(root, 'data/derived/symbols/00/00700B.json');
    assert.deepEqual(missingRow.rows[0].slice(7, 13), [3, 4, null, null, null, null]);

    const missingField = await readJson(root, 'data/derived/symbols/00/00800B.json');
    assert.deepEqual(missingField.rows[0].slice(9), [777, 88, null, 99]);
  });
});

test('derived daily append is ascending and injectable window trims oldest row', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(derivedBodies()), now: () => new Date('2026-07-06T13:45:00Z') });
    const day2 = derivedBodies({
      twse_mi_index: jsonBody([{ '日期': '1150707', '指數': '發行量加權股價指數', '收盤指數': '2' }]),
      twse_stock_day_all: jsonBody([{
        Date: '1150707',
        Code: '2330',
        Name: '台積電',
        TradeVolume: '2',
        TradeValue: '1',
        OpeningPrice: '2',
        HighestPrice: '3',
        LowestPrice: '1',
        ClosingPrice: '2',
        Change: '0',
        Transaction: '2',
      }]),
      twse_mi_margn: jsonBody([{ '股票代號': '2330', '股票名稱': '台積電', '融資買進': '1', '融資今日餘額': '2', '融券今日餘額': '3' }]),
      tpex_index: jsonBody([{ Date: '20260707', Open: '1', High: '1', Low: '1', Close: '1' }]),
      tpex_mainboard_close: jsonBody([{ Date: '1150707', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', Close: '2', Open: '2', High: '2', Low: '2', TradingShares: '2', TransactionNumber: '2' }]),
      tpex_3insti: jsonBody([{ Date: '1150707', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', TotalDifference: '2' }]),
      tpex_margin: jsonBody([{ Date: '1150707', SecuritiesCompanyCode: '00679B', CompanyName: '元大美債20年', MarginPurchaseBalance: '2', ShortSaleBalance: '2' }]),
    });
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(day2), now: () => new Date('2026-07-07T13:45:00Z') });
    let twse = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.deepEqual(twse.rows.map((row) => row[0]), [20260706, 20260707]);

    await applyDailyDate(root, '2026-07-06', { symbolWindow: 1 });
    await applyDailyDate(root, '2026-07-07', { symbolWindow: 1 });
    twse = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.deepEqual(twse.rows.map((row) => row[0]), [20260707]);
  });
});

test('derived same-day rerun is byte-level no-op and revise recomputes that date', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(derivedBodies()), now: () => new Date('2026-07-06T13:45:00Z') });
    const before = await fileMap(join(root, 'data', 'derived'));
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(derivedBodies()), now: () => new Date('2026-07-06T14:45:00Z') });
    assert.deepEqual(await fileMap(join(root, 'data', 'derived')), before);

    const revised = derivedBodies({
      twse_stock_day_all: jsonBody([{
        Date: '1150706',
        Code: '2330',
        Name: '台積電',
        TradeVolume: '32,145,678',
        TradeValue: '1',
        OpeningPrice: '1080',
        HighestPrice: '1090',
        LowestPrice: '1075',
        ClosingPrice: '1099',
        Change: '+1',
        Transaction: '45,210',
      }]),
    });
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(revised), now: () => new Date('2026-07-06T15:45:00Z') });
    const twse = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.equal(twse.rows[0][4], 1099);
  });
});

test('derived margin failure leaves nulls and later margin raw converges same date row', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(derivedBodies(), { tpex_margin: { status: 503 } }),
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    let tpex = await readJson(root, 'data/derived/symbols/00/00679B.json');
    assert.deepEqual(tpex.rows[0].slice(7, 9), [null, null]);

    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(derivedBodies()),
      datasets: ['tpex_margin'],
      now: () => new Date('2026-07-06T14:45:00Z'),
    });
    tpex = await readJson(root, 'data/derived/symbols/00/00679B.json');
    assert.deepEqual(tpex.rows[0].slice(7, 9), [5949, 9]);
  });
});

test('derived tdcc computes indicators, excludes six digit symbols, and skips missing total row', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(derivedBodies()),
      datasets: ['tdcc'],
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    const tdcc = await readJson(root, 'data/derived/tdcc/23/2330.json');
    assert.deepEqual(tdcc, {
      id: '2330',
      updated: '2026-07-04',
      cols: ['w', 'big1000', 'big400', 'retail', 'holders', 'avgShares'],
      rows: [[20260704, 15.4, 55, 6.6, 200, 10000]],
    });
    await assert.rejects(readFile(join(root, 'data', 'derived', 'tdcc', '12', '123456.json')));
    await assert.rejects(readFile(join(root, 'data', 'derived', 'tdcc', '28', '2881A.json')));
  });
});

test('build-derived rebuild matches incremental output and repeated rebuild is byte-level stable', async () => {
  await withTempDir(async (root) => {
    await runSnapshot({ rootDir: root, fetcher: fetcherFor(derivedBodies()), now: () => new Date('2026-07-06T13:45:00Z') });
    const incremental = await fileMap(join(root, 'data', 'derived'));
    await rm(join(root, 'data', 'derived'), { recursive: true, force: true });
    const summary = await buildDerived({ rootDir: root });
    assert.ok(summary.files > 0);
    const rebuilt = await fileMap(join(root, 'data', 'derived'));
    assert.deepEqual(rebuilt, incremental);
    await buildDerived({ rootDir: root });
    assert.deepEqual(await fileMap(join(root, 'data', 'derived')), rebuilt);
  });
});

test('bwibbu raw produces valuation fundamentals, nulls invalid numbers, and excludes pure six digit ids', async () => {
  await withTempDir(async (root) => {
    const bodies = fixtureBodies({
      twse_bwibbu_all: jsonBody([
        { Date: '1150706', Code: '2330', Name: '台積電', PEratio: '25.1', PBratio: 'bad', DividendYield: '--' },
        { Date: '1150706', Code: '2317', Name: '鴻海', PEratio: '12', PBratio: '2', DividendYield: '3' },
        { Date: '1150706', Code: '123456', Name: '排除六碼', PEratio: '1', PBratio: '1', DividendYield: '1' },
      ]),
    });
    const summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(bodies),
      datasets: ['twse_bwibbu_all'],
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    assert.equal(summary.exitCode, 0);
    assert.equal(
      await readFile(join(root, 'data', 'raw', 'twse', 'bwibbu_all', '2026', '2026-07-06.json'), 'utf8'),
      bodies.twse_bwibbu_all,
    );
    assert.deepEqual(await readJson(root, 'data/derived/fundamentals/23/2330.json'), {
      id: '2330',
      name: '台積電',
      market: 'twse',
      updated: '2026-07-06',
      valuation: { cols: ['d', 'per', 'pbr', 'dy'], rows: [[20260706, 25.1, null, null]] },
      revenue: { cols: ['m', 'rev', 'yoy', 'mom'], rows: [] },
    });
    await assert.rejects(readFile(join(root, 'data', 'derived', 'fundamentals', '12', '123456.json')));

    const revised = fixtureBodies({
      twse_bwibbu_all: jsonBody([
        { Date: '1150706', Code: '2330', Name: '台積電', PEratio: '26', PBratio: '5', DividendYield: '2' },
      ]),
    });
    const revisedSummary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(revised),
      datasets: ['twse_bwibbu_all'],
      now: () => new Date('2026-07-06T14:45:00Z'),
    });
    assert.equal(revisedSummary.results.find((result) => result.key === 'twse_bwibbu_all').status, 'revise');
    await assert.rejects(readFile(join(root, 'data', 'derived', 'fundamentals', '23', '2317.json')));
    const incremental = await fileMap(join(root, 'data', 'derived'));
    await buildDerived({ rootDir: root });
    assert.deepEqual(await fileMap(join(root, 'data', 'derived')), incremental);
  });
});

test('monthly revenue writes, revises, no-ops, and advances month manifest deterministically', async () => {
  await withTempDir(async (root) => {
    const firstBodies = fixtureBodies({
      twse_monthly_revenue: jsonBody([
        { '資料年月': '11506', '公司代號': '2330', '公司名稱': '台積電', '營業收入-當月營收': '123456789', '營業收入-去年同月增減(%)': '12.3', '營業收入-上月比較增減(%)': '-1.2' },
        { '資料年月': '11506', '公司代號': '2317', '公司名稱': '鴻海', '營業收入-當月營收': '500', '營業收入-去年同月增減(%)': '5', '營業收入-上月比較增減(%)': '6' },
      ]),
    });
    let summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(firstBodies),
      datasets: ['twse_monthly_revenue'],
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    assert.equal(summary.results[0].status, 'write');
    let m = await manifest(root);
    assert.deepEqual(m.datasets.twse_monthly_revenue, {
      firstMonth: '2026-06', latestMonth: '2026-06', months: 1, ok: true,
    });
    const before = await fileMap(join(root, 'data'));
    summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(firstBodies),
      datasets: ['twse_monthly_revenue'],
      now: () => new Date('2026-07-06T14:45:00Z'),
    });
    assert.equal(summary.results[0].status, 'same');
    assert.deepEqual(await fileMap(join(root, 'data')), before);

    const revised = fixtureBodies({
      twse_monthly_revenue: jsonBody([{ '資料年月': '11506', '公司代號': '2330', '公司名稱': '台積電', '營業收入-當月營收': '999', '營業收入-去年同月增減(%)': '1', '營業收入-上月比較增減(%)': '2' }]),
    });
    summary = await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(revised),
      datasets: ['twse_monthly_revenue'],
      now: () => new Date('2026-07-06T15:45:00Z'),
    });
    assert.equal(summary.results[0].status, 'revise');
    assert.equal(
      await readFile(join(root, 'data', 'raw', 'twse', 'monthly_revenue', '2026', '2026-06.json'), 'utf8'),
      revised.twse_monthly_revenue,
    );
    assert.deepEqual((await readJson(root, 'data/derived/fundamentals/23/2330.json')).revenue.rows, [[202606, 999, 1, 2]]);
    await assert.rejects(readFile(join(root, 'data', 'derived', 'fundamentals', '23', '2317.json')));
    const incremental = await fileMap(join(root, 'data', 'derived'));
    await buildDerived({ rootDir: root });
    assert.deepEqual(await fileMap(join(root, 'data', 'derived')), incremental);

    const nextMonth = fixtureBodies({
      twse_monthly_revenue: jsonBody([{ '資料年月': '11507', '公司代號': '2330', '公司名稱': '台積電', '營業收入-當月營收': '1000', '營業收入-去年同月增減(%)': '3', '營業收入-上月比較增減(%)': '4' }]),
    });
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(nextMonth),
      datasets: ['twse_monthly_revenue'],
      now: () => new Date('2026-08-06T13:45:00Z'),
    });
    m = await manifest(root);
    assert.deepEqual(m.datasets.twse_monthly_revenue, {
      firstMonth: '2026-06', latestMonth: '2026-07', months: 2, ok: true,
    });
    assert.deepEqual((await readJson(root, 'data/derived/fundamentals/23/2330.json')).revenue.rows.map((row) => row[0]), [202606, 202607]);
  });
});

test('tpex revenue creates empty valuation, maps invalid numbers to null, and excludes pure six digit ids', async () => {
  await withTempDir(async (root) => {
    const bodies = fixtureBodies({
      tpex_monthly_revenue: jsonBody([
        { '資料年月': '11506', '公司代號': '6488', '公司名稱': '環球晶', '營業收入-當月營收': '543,210', '營業收入-去年同月增減(%)': 'bad', '營業收入-上月比較增減(%)': '--' },
        { '資料年月': '11506', '公司代號': '123456', '公司名稱': '排除六碼', '營業收入-當月營收': '1' },
      ]),
    });
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(bodies),
      datasets: ['tpex_monthly_revenue'],
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    assert.deepEqual(await readJson(root, 'data/derived/fundamentals/64/6488.json'), {
      id: '6488',
      name: '環球晶',
      market: 'tpex',
      updated: '2026-06-01',
      valuation: { cols: ['d', 'per', 'pbr', 'dy'], rows: [] },
      revenue: { cols: ['m', 'rev', 'yoy', 'mom'], rows: [[202606, 543210, null, null]] },
    });
    await assert.rejects(readFile(join(root, 'data', 'derived', 'fundamentals', '12', '123456.json')));
  });
});

test('monthly revenue resolves same id and month collision in favor of twse rows', async () => {
  await withTempDir(async (root) => {
    const bodies = fixtureBodies({
      twse_monthly_revenue: jsonBody([
        { '資料年月': '11506', '公司代號': '6488', '公司名稱': '上市優先', '營業收入-當月營收': '111', '營業收入-去年同月增減(%)': '1', '營業收入-上月比較增減(%)': '2' },
      ]),
      tpex_monthly_revenue: jsonBody([
        { '資料年月': '11506', '公司代號': '6488', '公司名稱': '上櫃候選', '營業收入-當月營收': '999', '營業收入-去年同月增減(%)': '9', '營業收入-上月比較增減(%)': '8' },
      ]),
    });
    await runSnapshot({
      rootDir: root,
      fetcher: fetcherFor(bodies),
      datasets: ['twse_monthly_revenue', 'tpex_monthly_revenue'],
      now: () => new Date('2026-07-06T13:45:00Z'),
    });
    const fundamental = await readJson(root, 'data/derived/fundamentals/64/6488.json');
    assert.equal(fundamental.name, '上市優先');
    assert.equal(fundamental.market, 'twse');
    assert.deepEqual(fundamental.revenue.rows, [[202606, 111, 1, 2]]);
  });
});

test('monthly revenue warns and deterministically drops rows outside the raw month key', async () => {
  await withTempDir(async (root) => {
    const bodies = fixtureBodies({
      twse_monthly_revenue: jsonBody([
        { '資料年月': '11506', '公司代號': '2330', '公司名稱': '台積電', '營業收入-當月營收': '100' },
        { '資料年月': '11505', '公司代號': '2317', '公司名稱': '鴻海', '營業收入-當月營收': '200' },
        { '資料年月': 'bad', '公司代號': '2303', '公司名稱': '聯電', '營業收入-當月營收': '300' },
      ]),
    });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await runSnapshot({
        rootDir: root,
        fetcher: fetcherFor(bodies),
        datasets: ['twse_monthly_revenue'],
        now: () => new Date('2026-07-06T13:45:00Z'),
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(warnings, [
      '[warn] derived: monthly revenue dataset=twse/monthly_revenue monthKey=2026-06 drops rowMonth=2026-05 count=1',
      '[warn] derived: monthly revenue dataset=twse/monthly_revenue monthKey=2026-06 drops rowMonth=invalid count=1',
    ]);
    assert.deepEqual((await readJson(root, 'data/derived/fundamentals/23/2330.json')).revenue.rows, [[202606, 100, null, null]]);
    await assert.rejects(readFile(join(root, 'data', 'derived', 'fundamentals', '23', '2317.json')));
    await assert.rejects(readFile(join(root, 'data', 'derived', 'fundamentals', '23', '2303.json')));
  });
});
