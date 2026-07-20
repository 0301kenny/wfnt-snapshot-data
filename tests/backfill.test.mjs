import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBackfill } from '../scripts/backfill.mjs';
import { buildDerived } from '../scripts/build-derived.mjs';
import { BACKFILL_ENDPOINTS, ENDPOINTS } from '../scripts/endpoints.mjs';
import {
  DEFAULT_SYMBOL_WINDOW,
  applyDailyDate,
  isTpexDailyQuotesTradingDay,
  parseTpexDailyQuotesHist,
  parseTpexInstiHist,
  parseTpexMarginHist,
  parseTwseMiMargnHist,
  parseTwseT86Hist,
  stableDerivedString,
} from '../scripts/lib/derived.mjs';

const silentLogger = { log() {}, warn() {} };

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-backfill-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeRaw(root, sourceDataset, date, body) {
  const path = join(root, 'data', 'raw', sourceDataset, date.slice(0, 4), `${date}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return path;
}

async function writeDerived(root, relativePath, value) {
  const path = join(root, 'data', 'derived', relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableDerivedString(value));
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), 'utf8'));
}

async function fileMap(dir, base = dir) {
  const result = {};
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fileMap(path, base));
    else result[path.slice(base.length + 1)] = await readFile(path);
  }
  return result;
}

function jsonBytes(value) {
  return Buffer.from(` ${JSON.stringify(value)}\r\n`, 'utf8');
}

function miIndexFixture({ code = '2330', name = '台積電' } = {}) {
  const tables = Array.from({ length: 9 }, () => ({ fields: [], data: [] }));
  tables[8] = {
    fields: ['收盤價', '證券名稱', '成交筆數', '最低價', '證券代號', '成交股數', '最高價', '開盤價'],
    data: [['1,085', name, '45,210', '1,075', code, '32,145,678', '1,090', '1,080']],
  };
  return { stat: 'OK', tables };
}

function miMargnFixture({ code = '2330', name = '台積電' } = {}) {
  return {
    stat: 'OK',
    tables: [
      { fields: [], data: [] },
      {
        fields: [
          '代號', '名稱',
          '買進', '賣出', '現金償還', '前日餘額', '今日餘額', '次一營業日限額',
          '買進', '賣出', '現券償還', '前日餘額', '今日餘額', '次一營業日限額',
          '資券互抵', '註記',
        ],
        groups: [
          { title: '股票', span: 2 },
          { title: '融資', span: 6 },
          { title: '融券', span: 6 },
          { title: '', span: 1 },
          { title: '', span: 1 },
        ],
        data: [[
          code, name,
          '1,000', '900', '0', '9,477', '9,577', '100,000',
          '10', '5', '0', '115', '120', '20,000',
          '0', '',
        ]],
      },
    ],
  };
}

function t86Fixture({ code = '2330', name = '台積電', invalid = false } = {}) {
  return {
    stat: 'OK',
    fields: [
      '三大法人買賣超股數',
      '證券名稱',
      '外資自營商買賣超股數',
      '證券代號',
      '自營商買賣超股數',
      '外陸資買賣超股數(不含外資自營商)',
      '投信買賣超股數',
    ],
    data: [[
      '9,999',
      name,
      '200',
      code,
      invalid ? 'bad' : '300',
      invalid ? 'oops' : '1,000',
      invalid ? '--' : '400',
    ]],
  };
}

function tpexDailyFixture({ year = 2026, empty = false, invalid = false } = {}) {
  const fields = [
    '代號', '名稱', '收盤', '漲跌', '開盤', '最高', '最低', '均價', '成交股數',
    '成交金額(元)', '成交筆數', '最後買價', year === 2021 ? '最後買量(千股)' : '最後買量(張數)',
    '最後賣價', year === 2021 ? '最後賣量(千股)' : '最後賣量(張數)', '發行股數',
    '次日 參考價', '次日 漲停價', '次日 跌停價',
  ];
  const row = year === 2021
    ? ['5483', '中美晶', '216.00', '-1.00 ', '217.00', '219.50', '213.50', '216.10', '9,083,340', '1,962,954,778', '5,835', '216.00', '56', '216.50', '42', '586,221,651', '216.00', '237.50', '194.50']
    : ['5483', '中美晶', '235.50', '-23.50 ', '244.50', '250.00', '234.50', '239.67', '32,146,669', '7,704,727,259', '28,003', '235.50', '24', '236.00', '60', '641,221,651', '235.50', '259.00', '212.00'];
  if (invalid) {
    row[4] = 'bad';
    row[8] = '--';
  }
  return { stat: 'ok', tables: [{ title: '上櫃股票行情', fields, data: empty ? [] : [row] }] };
}

function tpexInstiFixture() {
  return {
    stat: 'ok',
    tables: [{
      title: '三大法人買賣明細資訊',
      fields: [
        '代號', '名稱',
        '買進股數', '賣出股數', '買賣超股數',
        '買進股數', '賣出股數', '買賣超股數',
        '買進股數', '賣出股數', '買賣超股數',
        '買進股數', '賣出股數', '買賣超股數',
        '買進股數', '賣出股數', '買賣超股數',
        '買進股數', '賣出股數', '買賣超股數',
        '買進股數', '賣出股數', '買賣超股數',
        '三大法人買賣超股數合計',
      ],
      data: [[
        '5483', '中美晶',
        '12,893,325', '8,599,114', '4,294,211',
        '0', '0', '0',
        '12,893,325', '8,599,114', '4,294,211',
        '1,730,936', '1,400', '1,729,536',
        '435,000', '378,545', '56,455',
        '209,932', '312,829', '-102,897',
        '644,932', '691,374', '-46,442',
        '5,977,305',
      ]],
    }],
  };
}

function tpexMarginFixture({ invalid = false } = {}) {
  return {
    stat: 'ok',
    tables: [{
      title: '上櫃股票融資融券餘額',
      fields: [
        '代號', '名稱', '前資餘額(張)', '資買', '資賣', '現償', '資餘額', '資屬證金',
        '資使用率(%)', '資限額', '前券餘額(張)', '券賣', '券買', '券償', '券餘額',
        '券屬證金', '券使用率(%)', '券限額', '資券相抵(張)', '備註',
      ],
      data: [[
        '5483', '中美晶', '15,059', '870', '2,329', '9', invalid ? 'bad' : '13,591',
        '352', '8.47', '160,305', '148', '0', '124', '24', invalid ? '--' : '0',
        '0', '0.0', '160,305', '0', 'X',
      ]],
    }],
  };
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

function fixtureFetcher({ calls = [], fail, tpexDailyEmpty = false } = {}) {
  const bodies = {
    MI_INDEX: jsonBytes(miIndexFixture()),
    T86: jsonBytes(t86Fixture()),
    MI_MARGN: jsonBytes(miMargnFixture()),
    TPEX_DAILY_QUOTES: jsonBytes(tpexDailyFixture({ empty: tpexDailyEmpty })),
    TPEX_INSTI: jsonBytes(tpexInstiFixture()),
    TPEX_MARGIN: jsonBytes(tpexMarginFixture()),
  };
  return async (url) => {
    calls.push(url);
    if (fail?.(url)) throw new Error('fixture interruption');
    if (url.includes('/MI_INDEX?')) return responseFor(bodies.MI_INDEX);
    if (url.includes('/fund/T86?')) return responseFor(bodies.T86);
    if (url.includes('/MI_MARGN?')) return responseFor(bodies.MI_MARGN);
    if (url.includes('/afterTrading/dailyQuotes?')) return responseFor(bodies.TPEX_DAILY_QUOTES);
    if (url.includes('/insti/dailyTrade?')) return responseFor(bodies.TPEX_INSTI);
    if (url.includes('/margin/balance?')) return responseFor(bodies.TPEX_MARGIN);
    throw new Error(`unexpected URL: ${url}`);
  };
}

test('backfill endpoints remain separate from the unchanged daily endpoint list', () => {
  assert.equal(ENDPOINTS.length, 11);
  assert.deepEqual(Object.keys(BACKFILL_ENDPOINTS), [
    'twse_mi_index_hist',
    'twse_t86_hist',
    'twse_mi_margn_hist',
    'tpex_daily_quotes_hist',
    'tpex_insti_hist',
    'tpex_margin_hist',
  ]);
  assert.match(BACKFILL_ENDPOINTS.tpex_daily_quotes_hist.url('20260717'), /date=2026\/07\/17&type=EW/);
  assert.match(BACKFILL_ENDPOINTS.tpex_insti_hist.url('20260717'), /sect=EW&date=2026\/07\/17/);
  assert.match(BACKFILL_ENDPOINTS.tpex_margin_hist.url('20260717'), /date=2026\/07\/17/);
});

test('TPEX daily parser handles both probed field-name variants and invalid numbers', () => {
  assert.equal(isTpexDailyQuotesTradingDay(tpexDailyFixture({ empty: true })), false);
  assert.equal(isTpexDailyQuotesTradingDay(tpexDailyFixture({ year: 2021 })), true);
  assert.deepEqual(parseTpexDailyQuotesHist(tpexDailyFixture({ year: 2021 }))[0], {
    SecuritiesCompanyCode: '5483',
    CompanyName: '中美晶',
    Open: 217,
    High: 219.5,
    Low: 213.5,
    Close: 216,
    TradingShares: 9083340,
    TransactionNumber: 5835,
  });
  assert.deepEqual(parseTpexDailyQuotesHist(tpexDailyFixture())[0], {
    SecuritiesCompanyCode: '5483',
    CompanyName: '中美晶',
    Open: 244.5,
    High: 250,
    Low: 234.5,
    Close: 235.5,
    TradingShares: 32146669,
    TransactionNumber: 28003,
  });
  const invalid = parseTpexDailyQuotesHist(tpexDailyFixture({ invalid: true }))[0];
  assert.equal(invalid.Open, null);
  assert.equal(invalid.TradingShares, null);
});

test('TPEX daily parser follows field names when fields and rows are reordered', () => {
  const fixture = tpexDailyFixture();
  fixture.tables[0].fields.reverse();
  fixture.tables[0].data[0].reverse();
  assert.deepEqual(parseTpexDailyQuotesHist(fixture)[0], {
    SecuritiesCompanyCode: '5483',
    CompanyName: '中美晶',
    Open: 244.5,
    High: 250,
    Low: 234.5,
    Close: 235.5,
    TradingShares: 32146669,
    TransactionNumber: 28003,
  });
});

test('TPEX institution fixed blocks match the probe and reject schema drift', () => {
  assert.deepEqual(parseTpexInstiHist(tpexInstiFixture())[0], {
    SecuritiesCompanyCode: '5483',
    CompanyName: '中美晶',
    TotalDifference: 5977305,
    'ForeignInvestorsIncludeMainlandAreaInvestors-Difference': 4294211,
    'SecuritiesInvestmentTrustCompanies-Difference': 1729536,
    'Dealers-Difference': -46442,
  });

  const shortFields = structuredClone(tpexInstiFixture());
  shortFields.tables[0].fields.pop();
  assert.throws(() => parseTpexInstiHist(shortFields), /fields length must be 24/);
  const wrongTotal = structuredClone(tpexInstiFixture());
  wrongTotal.tables[0].fields[23] = '漂移';
  assert.throws(() => parseTpexInstiHist(wrongTotal), /fields\[23\] must be/);
  const shortRow = structuredClone(tpexInstiFixture());
  shortRow.tables[0].data[0].pop();
  assert.throws(() => parseTpexInstiHist(shortRow), /data\[0\] width must be 24/);
});

test('TPEX margin parser selects named balances and maps invalid numbers to null', () => {
  assert.deepEqual(parseTpexMarginHist(tpexMarginFixture())[0], {
    SecuritiesCompanyCode: '5483',
    CompanyName: '中美晶',
    MarginPurchaseBalance: 13591,
    ShortSaleBalance: 0,
  });
  const invalid = parseTpexMarginHist(tpexMarginFixture({ invalid: true }))[0];
  assert.equal(invalid.MarginPurchaseBalance, null);
  assert.equal(invalid.ShortSaleBalance, null);
});

test('TPEX margin parser follows field names when fields and rows are reordered', () => {
  const fixture = tpexMarginFixture();
  fixture.tables[0].fields.reverse();
  fixture.tables[0].data[0].reverse();
  assert.deepEqual(parseTpexMarginHist(fixture)[0], {
    SecuritiesCompanyCode: '5483',
    CompanyName: '中美晶',
    MarginPurchaseBalance: 13591,
    ShortSaleBalance: 0,
  });
});

test('T86 parser uses field names, sums foreign columns, removes commas, and maps invalid cells to null', () => {
  const [valid] = parseTwseT86Hist(t86Fixture());
  assert.deepEqual(valid, {
    id: '2330',
    name: '台積電',
    fi: 9999,
    ff: 1200,
    ft: 400,
    fd: 300,
  });
  const [invalid] = parseTwseT86Hist(t86Fixture({ invalid: true }));
  assert.deepEqual(invalid, {
    id: '2330',
    name: '台積電',
    fi: 9999,
    ff: null,
    ft: null,
    fd: null,
  });
});

test('MI_MARGN groups select both repeated balances and hist replay fills the thirteen-column TWSE row', async () => {
  const [margin] = parseTwseMiMargnHist(miMargnFixture());
  assert.deepEqual(margin, {
    '股票代號': '2330',
    '股票名稱': '台積電',
    '融資今日餘額': '9,577',
    '融券今日餘額': '120',
  });
  const missingGroups = miMargnFixture();
  delete missingGroups.tables[1].groups;
  assert.throws(() => parseTwseMiMargnHist(missingGroups), /MI_MARGN: groups is not an array/);

  await withTempDir(async (root) => {
    await writeRaw(root, 'twse/mi_index_hist', '2026-07-06', jsonBytes(miIndexFixture()));
    await writeRaw(root, 'twse/mi_margn_hist', '2026-07-06', jsonBytes(miMargnFixture()));
    await writeRaw(root, 'twse/t86_hist', '2026-07-06', jsonBytes(t86Fixture()));
    await applyDailyDate(root, '2026-07-06');
    const symbol = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.deepEqual(symbol.cols, ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd']);
    assert.deepEqual(symbol.rows, [[20260706, 1080, 1090, 1075, 1085, 32145678, 45210, 9577, 120, 9999, 1200, 400, 300]]);
  });
});

test('openapi close and margin beat hist while T86 supplies TWSE institution columns', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse/stock_day_all', '2026-07-06', jsonBytes([{
      Code: '2330', Name: '台積電', OpeningPrice: '10', HighestPrice: '11', LowestPrice: '9', ClosingPrice: '10.5', TradeVolume: '100', Transaction: '20',
    }]));
    await writeRaw(root, 'twse/mi_margn', '2026-07-06', jsonBytes([{
      '股票代號': '2330', '股票名稱': '台積電', '融資今日餘額': '30', '融券今日餘額': '40',
    }]));
    await writeRaw(root, 'twse/mi_index_hist', '2026-07-06', jsonBytes(miIndexFixture()));
    await writeRaw(root, 'twse/mi_margn_hist', '2026-07-06', jsonBytes(miMargnFixture()));
    await writeRaw(root, 'twse/t86_hist', '2026-07-06', jsonBytes(t86Fixture()));
    await applyDailyDate(root, '2026-07-06');
    const symbol = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.deepEqual(symbol.rows[0], [20260706, 10, 11, 9, 10.5, 100, 20, 30, 40, 9999, 1200, 400, 300]);
  });
});

test('TPEX hist replay fills symbol and market series through the shared daily path', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'tpex/daily_quotes_hist', '2026-07-17', jsonBytes(tpexDailyFixture()));
    await writeRaw(root, 'tpex/insti_hist', '2026-07-17', jsonBytes(tpexInstiFixture()));
    await writeRaw(root, 'tpex/margin_hist', '2026-07-17', jsonBytes(tpexMarginFixture()));
    await applyDailyDate(root, '2026-07-17');

    const symbol = await readJson(root, 'data/derived/symbols/54/5483.json');
    assert.deepEqual(symbol.cols, ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd']);
    assert.deepEqual(symbol.rows, [[
      20260717, 244.5, 250, 234.5, 235.5, 32146669, 28003,
      13591, 0, 5977305, 4294211, 1729536, -46442,
    ]]);
    const market = await readJson(root, 'data/derived/market.json');
    assert.deepEqual(market.tpex.margin.rows, [[20260717, 13591, 0]]);
    assert.deepEqual(market.tpex.insti.rows, [[20260717, 5977305]]);
  });
});

test('same-day TPEX openapi values beat all hist values', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'tpex/daily_quotes_hist', '2026-07-17', jsonBytes(tpexDailyFixture()));
    await writeRaw(root, 'tpex/insti_hist', '2026-07-17', jsonBytes(tpexInstiFixture()));
    await writeRaw(root, 'tpex/margin_hist', '2026-07-17', jsonBytes(tpexMarginFixture()));
    await writeRaw(root, 'tpex/mainboard_close', '2026-07-17', jsonBytes([{
      SecuritiesCompanyCode: '5483', CompanyName: 'openapi', Open: '1', High: '2', Low: '3', Close: '4', TradingShares: '5', TransactionNumber: '6',
    }]));
    await writeRaw(root, 'tpex/margin', '2026-07-17', jsonBytes([{
      SecuritiesCompanyCode: '5483', MarginPurchaseBalance: '7', ShortSaleBalance: '8',
    }]));
    await writeRaw(root, 'tpex/3insti', '2026-07-17', jsonBytes([{
      SecuritiesCompanyCode: '5483',
      TotalDifference: '9',
      'ForeignInvestorsIncludeMainlandAreaInvestors-Difference': '10',
      'SecuritiesInvestmentTrustCompanies-Difference': '11',
      'Dealers-Difference': '12',
    }]));
    await applyDailyDate(root, '2026-07-17');

    const symbol = await readJson(root, 'data/derived/symbols/54/5483.json');
    assert.equal(symbol.name, 'openapi');
    assert.deepEqual(symbol.rows, [[20260717, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]);
    const market = await readJson(root, 'data/derived/market.json');
    assert.deepEqual(market.tpex.margin.rows, [[20260717, 7, 8]]);
    assert.deepEqual(market.tpex.insti.rows, [[20260717, 9]]);
  });
});

test('default symbol window trims a greater-than-1300-row fixture to 1300', async () => {
  await withTempDir(async (root) => {
    assert.equal(DEFAULT_SYMBOL_WINDOW, 1300);
    const rows = [];
    const cursor = new Date('2020-01-01T00:00:00Z');
    for (let index = 0; index < 1300; index += 1) {
      const ymd = Number(cursor.toISOString().slice(0, 10).replaceAll('-', ''));
      rows.push([ymd, 1, 1, 1, 1, 1, 1, null, null, null, null, null, null]);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    await writeDerived(root, 'symbols/23/2330.json', {
      id: '2330', name: '台積電', market: 'twse', updated: '2023-07-23',
      cols: ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd'], rows,
    });
    await writeRaw(root, 'twse/mi_index_hist', '2026-07-06', jsonBytes(miIndexFixture()));
    await applyDailyDate(root, '2026-07-06');
    const symbol = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.equal(symbol.rows.length, 1300);
    assert.equal(symbol.rows[0][0], rows[1][0]);
    assert.equal(symbol.rows.at(-1)[0], 20260706);
  });
});

test('full build discovers hist dates and exactly matches incremental derived bytes', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse/mi_index_hist', '2026-07-06', jsonBytes(miIndexFixture()));
    await writeRaw(root, 'twse/mi_margn_hist', '2026-07-06', jsonBytes(miMargnFixture()));
    await writeRaw(root, 'twse/t86_hist', '2026-07-06', jsonBytes(t86Fixture()));
    await writeRaw(root, 'tpex/daily_quotes_hist', '2026-07-06', jsonBytes(tpexDailyFixture()));
    await writeRaw(root, 'tpex/insti_hist', '2026-07-06', jsonBytes(tpexInstiFixture()));
    await writeRaw(root, 'tpex/margin_hist', '2026-07-06', jsonBytes(tpexMarginFixture()));
    await applyDailyDate(root, '2026-07-06');
    const incremental = await fileMap(join(root, 'data', 'derived'));
    const first = await buildDerived({ rootDir: root });
    assert.equal(first.dailyDates, 1);
    assert.deepEqual(await fileMap(join(root, 'data', 'derived')), incremental);
    await buildDerived({ rootDir: root });
    assert.deepEqual(await fileMap(join(root, 'data', 'derived')), incremental);
  });
});

test('backfill preserves response bytes and a second fixture run is a complete no-op', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    const fetchImpl = fixtureFetcher({ calls });
    const options = {
      rootDir: root,
      fromIso: '2026-07-06',
      toIso: '2026-07-06',
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    };
    await runBackfill(options);
    const miBytes = jsonBytes(miIndexFixture());
    assert.deepEqual(
      await readFile(join(root, 'data/raw/twse/mi_index_hist/2026/2026-07-06.json')),
      miBytes,
    );
    assert.deepEqual(
      await readFile(join(root, 'data/raw/tpex/daily_quotes_hist/2026/2026-07-06.json')),
      jsonBytes(tpexDailyFixture()),
    );
    assert.deepEqual(
      await readFile(join(root, 'data/raw/tpex/insti_hist/2026/2026-07-06.json')),
      jsonBytes(tpexInstiFixture()),
    );
    assert.deepEqual(
      await readFile(join(root, 'data/raw/tpex/margin_hist/2026/2026-07-06.json')),
      jsonBytes(tpexMarginFixture()),
    );
    assert.ok(calls.some((url) => url.includes('date=2026/07/06')));
    const before = await fileMap(join(root, 'data'));
    const callCount = calls.length;
    const second = await runBackfill(options);
    assert.equal(second.resumed, 1);
    assert.equal(calls.length, callCount);
    assert.deepEqual(await fileMap(join(root, 'data')), before);
  });
});

test('checkpoint resumes after interruption without refetching completed dates', async () => {
  await withTempDir(async (root) => {
    const firstCalls = [];
    await assert.rejects(runBackfill({
      rootDir: root,
      fromIso: '2026-07-06',
      toIso: '2026-07-07',
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: fixtureFetcher({
        calls: firstCalls,
        fail: (url) => url.includes('/insti/dailyTrade?') && url.includes('date=2026/07/07'),
      }),
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    }), /2026-07-07 tpex\/insti_hist: fixture interruption/);
    assert.equal((await readJson(root, '.backfill-progress.json')).lastDate, '2026-07-06');

    const resumedCalls = [];
    const summary = await runBackfill({
      rootDir: root,
      fromIso: '2026-07-06',
      toIso: '2026-07-07',
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: fixtureFetcher({ calls: resumedCalls }),
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:01:00Z'),
    });
    assert.equal(summary.resumed, 1);
    assert.ok(resumedCalls.length > 0);
    assert.equal(resumedCalls.some((url) => url.includes('date=20260706')), false);
    assert.equal(resumedCalls.some((url) => url.includes('date=2026/07/06')), false);
    assert.equal((await readJson(root, '.backfill-progress.json')).lastDate, '2026-07-07');
  });
});

test('TPEX non-trading response does not write legacy raw or fetch its detail endpoints', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse/stock_day_all', '2026-07-19', jsonBytes([{
      Code: '2330', Name: '台積電', OpeningPrice: '10', HighestPrice: '11', LowestPrice: '9', ClosingPrice: '10.5', TradeVolume: '100', Transaction: '20',
    }]));
    const calls = [];
    await runBackfill({
      rootDir: root,
      fromIso: '2026-07-19',
      toIso: '2026-07-19',
      delayMs: 0,
      fetchImpl: fixtureFetcher({ calls, tpexDailyEmpty: true }),
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    });
    assert.equal(calls.filter((url) => url.includes('www.tpex.org.tw')).length, 1);
    assert.equal(calls.some((url) => url.includes('/insti/dailyTrade?')), false);
    assert.equal(calls.some((url) => url.includes('/margin/balance?')), false);
    await assert.rejects(readFile(join(root, 'data/raw/tpex/daily_quotes_hist/2026/2026-07-19.json')));
    await assert.rejects(readFile(join(root, 'data/raw/tpex/insti_hist/2026/2026-07-19.json')));
    await assert.rejects(readFile(join(root, 'data/raw/tpex/margin_hist/2026/2026-07-19.json')));
  });
});

test('existing openapi raw preserves TWSE T86 behavior and skips all three TPEX legacy fetches', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse/stock_day_all', '2026-07-06', jsonBytes([{
      Code: '2330', Name: '台積電', OpeningPrice: '10', HighestPrice: '11', LowestPrice: '9', ClosingPrice: '10.5', TradeVolume: '100', Transaction: '20',
    }]));
    await writeRaw(root, 'twse/mi_margn', '2026-07-06', jsonBytes([{
      '股票代號': '2330', '股票名稱': '台積電', '融資今日餘額': '30', '融券今日餘額': '40',
    }]));
    await writeRaw(root, 'tpex/mainboard_close', '2026-07-06', jsonBytes([{
      SecuritiesCompanyCode: '5483', CompanyName: '中美晶', Open: '1', High: '1', Low: '1', Close: '1', TradingShares: '1', TransactionNumber: '1',
    }]));
    const calls = [];
    const t86Bytes = jsonBytes(t86Fixture());
    const summary = await runBackfill({
      rootDir: root,
      fromIso: '2026-07-06',
      toIso: '2026-07-06',
      delayMs: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        assert.match(url, /\/fund\/T86\?/);
        return responseFor(t86Bytes);
      },
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    });
    assert.equal(summary.openApiDays, 1);
    assert.equal(summary.tpexOpenApiDays, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls.some((url) => url.includes('www.tpex.org.tw')), false);
    assert.deepEqual(await readFile(join(root, 'data/raw/twse/t86_hist/2026/2026-07-06.json')), t86Bytes);
    const symbol = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.deepEqual(symbol.rows[0], [20260706, 10, 11, 9, 10.5, 100, 20, 30, 40, 9999, 1200, 400, 300]);
  });
});
