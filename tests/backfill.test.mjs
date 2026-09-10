import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  backfillOptionsFromArgs,
  parseTpexSblHist,
  parseTwseSblHist,
  runBackfill,
} from '../scripts/backfill.mjs';
import { buildDerived } from '../scripts/build-derived.mjs';
import { BACKFILL_ENDPOINTS, ENDPOINTS } from '../scripts/endpoints.mjs';
import {
  DEFAULT_SYMBOL_WINDOW,
  DEFAULT_VALUATION_WINDOW,
  DERIVED_INPUT_DATASETS,
  applyDailyDate,
  isTpexDailyQuotesTradingDay,
  parseTpexPeHist,
  parseTpexDailyQuotesHist,
  parseTpexInstiHist,
  parseTpexMarginHist,
  parseTpexSblDerived,
  parseTwseMiMargnHist,
  parseTwseSblDerived,
  parseTwseBwibbuHist,
  parseTwseT86Hist,
} from '../scripts/lib/derived.mjs';
import { fileMap, writeDerived } from './derived-test-helpers.mjs';

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

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), 'utf8'));
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

// Cropped from the official 2026-08-14 BWIBBU_d response captured by smoke A.
function bwibbuFixture({ empty = false } = {}) {
  return {
    stat: 'OK',
    date: '20260814',
    title: '個股日本益比、殖利率及股價淨值比',
    fields: ['證券代號', '證券名稱', '收盤價', '殖利率(%)', '股利年度', '本益比', '股價淨值比', '財報年/季'],
    data: empty ? [] : [['1101', '台泥', '24.25', '3.30', 114, '-', '0.79', '115/2']],
    selectType: 'ALL',
    total: empty ? 0 : 1,
  };
}

function twseSblFixture({
  balance = '7,654',
  sale = '100',
  marginBalance = '106',
  date = '20260706',
} = {}) {
  return {
    stat: 'OK',
    date,
    title: '信用額度總量管制餘額表',
    fields: [
      '代號', '名稱', '前日餘額', '賣出', '買進', '現券', '今日餘額', '次一營業日限額',
      '前日餘額', '當日賣出', '當日還券', '當日調整', '當日餘額', '次一營業日可限額', '備註',
    ],
    data: [[
      '2330', '台積電', '111', '2', '3', '4', marginBalance, '1,000',
      '8,000', sale, '400', '-46', balance, '2,000', '',
    ]],
    groups: [
      { title: '股票', span: 2 },
      { title: '融券', span: 6 },
      { title: '借券賣出', span: 6 },
      { title: '', span: 1 },
    ],
  };
}

// Cropped from official peQryDate responses captured by smoke A/B.
function tpexPeFixture({ year = 2026, empty = false } = {}) {
  const current = year === 2026;
  return {
    tables: [{
      title: '',
      date: current ? '115/08/14' : '110/08/16',
      totalCount: empty ? 0 : 1,
      fields: current
        ? ['股票代號', '公司名稱', '本益比', '每股股利', '股利年度', '殖利率(%)', '股價淨值比', '財報年/季']
        : ['股票代號', '公司名稱', '本益比', '每股股利', '股利年度', '殖利率(%)', '股價淨值比'],
      data: empty ? [] : [current
        ? ['1240', '茂生農經        ', '10.54', '0.50000000', 114, '6.17', '1.67', '115Q2']
        : ['1240', '茂生農經        ', '11.88', '2.50000000', 109, '4.66', '1.52']],
      summary: [],
      notes: [],
      stkCategory: '全部產業',
    }],
    date: current ? '20260814' : '20210816',
    stat: 'ok',
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

function tpexSblFixture({
  balance = '3,210',
  sale = '500',
  marginBalance = '8,765',
  date = '20260706',
} = {}) {
  return {
    stat: 'ok',
    date,
    tables: [{
      title: '上櫃借券賣出餘額',
      date: '115/07/06',
      fields: [
        '股票代號', '股票名稱', '前日餘額', '賣出', '買進', '現券', '當日餘額', '限額',
        '前日餘額', '當日賣出', '當日還券', '當日調整數額', '當日餘額',
        '次一營業日可借券賣出限額', '備註',
      ],
      data: [[
        '5483', '中美晶', '9,000', '500', '250', '10', marginBalance, '20,000',
        '3,000', sale, '250', '-40', balance, '10,000', '',
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
    BWIBBU: jsonBytes(bwibbuFixture()),
    TPEX_DAILY_QUOTES: jsonBytes(tpexDailyFixture({ empty: tpexDailyEmpty })),
    TPEX_INSTI: jsonBytes(tpexInstiFixture()),
    TPEX_MARGIN: jsonBytes(tpexMarginFixture()),
    TPEX_PE: jsonBytes(tpexPeFixture()),
  };
  return async (url) => {
    calls.push(url);
    if (fail?.(url)) throw new Error('fixture interruption');
    if (url.includes('/MI_INDEX?')) return responseFor(bodies.MI_INDEX);
    if (url.includes('/fund/T86?')) return responseFor(bodies.T86);
    if (url.includes('/MI_MARGN?')) return responseFor(bodies.MI_MARGN);
    if (url.includes('/BWIBBU_d?')) return responseFor(bodies.BWIBBU);
    if (url.includes('/TWT93U?')) {
      const date = new URL(url).searchParams.get('date');
      return responseFor(jsonBytes(twseSblFixture({ date })));
    }
    if (url.includes('/afterTrading/dailyQuotes?')) return responseFor(bodies.TPEX_DAILY_QUOTES);
    if (url.includes('/insti/dailyTrade?')) return responseFor(bodies.TPEX_INSTI);
    if (url.includes('/margin/balance?')) return responseFor(bodies.TPEX_MARGIN);
    if (url.includes('/afterTrading/peQryDate?')) return responseFor(bodies.TPEX_PE);
    if (url.includes('/margin/sbl?')) {
      const date = new URL(url).searchParams.get('date').replaceAll('/', '');
      return responseFor(jsonBytes(tpexSblFixture({ date })));
    }
    throw new Error(`unexpected URL: ${url}`);
  };
}

test('backfill endpoints remain separate from the 17-entry snapshot endpoint list', () => {
  assert.equal(ENDPOINTS.length, 17);
  assert.deepEqual(Object.keys(BACKFILL_ENDPOINTS), [
    'twse_monthly_revenue_hist',
    'tpex_monthly_revenue_hist',
    'twse_quarterly_fin_hist',
    'tpex_quarterly_fin_hist',
    'twse_mi_index_hist',
    'twse_t86_hist',
    'twse_mi_margn_hist',
    'twse_bwibbu_hist',
    'twse_sbl_hist',
    'tpex_daily_quotes_hist',
    'tpex_insti_hist',
    'tpex_margin_hist',
    'tpex_pe_hist',
    'tpex_sbl_hist',
  ]);
  assert.equal(BACKFILL_ENDPOINTS.twse_monthly_revenue_hist.sourceDataset, 'twse/monthly_revenue_hist');
  assert.equal(BACKFILL_ENDPOINTS.tpex_monthly_revenue_hist.sourceDataset, 'tpex/monthly_revenue_hist');
  assert.deepEqual(BACKFILL_ENDPOINTS.twse_quarterly_fin_hist, {
    cadence: 'quarterly',
    sourceDataset: 'twse/quarterly_fin_hist',
    url: 'https://mopsov.twse.com.tw/mops/web/ajax_t163sb04',
    typek: 'sii',
  });
  assert.deepEqual(BACKFILL_ENDPOINTS.tpex_quarterly_fin_hist, {
    cadence: 'quarterly',
    sourceDataset: 'tpex/quarterly_fin_hist',
    url: 'https://mopsov.twse.com.tw/mops/web/ajax_t163sb04',
    typek: 'otc',
  });
  assert.equal(
    BACKFILL_ENDPOINTS.twse_monthly_revenue_hist.url(115, 7, 1),
    'https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_7_1.html',
  );
  assert.equal(
    BACKFILL_ENDPOINTS.tpex_monthly_revenue_hist.url(110, 8, 0),
    'https://mopsov.twse.com.tw/nas/t21/otc/t21sc03_110_8_0.html',
  );
  assert.match(BACKFILL_ENDPOINTS.twse_bwibbu_hist.url('20260717'), /BWIBBU_d\?date=20260717&selectType=ALL/);
  assert.match(BACKFILL_ENDPOINTS.twse_sbl_hist.url('20260717'), /TWT93U\?date=20260717&selectType=SLBNLB/);
  assert.match(BACKFILL_ENDPOINTS.tpex_daily_quotes_hist.url('20260717'), /date=2026\/07\/17&type=EW/);
  assert.match(BACKFILL_ENDPOINTS.tpex_insti_hist.url('20260717'), /sect=EW&date=2026\/07\/17/);
  assert.match(BACKFILL_ENDPOINTS.tpex_margin_hist.url('20260717'), /date=2026\/07\/17/);
  assert.match(BACKFILL_ENDPOINTS.tpex_pe_hist.url('20260717'), /peQryDate\?date=2026\/07\/17/);
  assert.match(BACKFILL_ENDPOINTS.tpex_sbl_hist.url('20260717'), /margin\/sbl\?date=2026\/07\/17/);
});

test('securities lending parsers select the borrowing balance and reject response-date drift', () => {
  assert.deepEqual(parseTwseSblHist(twseSblFixture(), '20260706'), [{
    SecuritiesCompanyCode: '2330',
    CompanyName: '台積電',
    SecuritiesBorrowingBalanceOfTheMarketDay: '7,654',
  }]);
  const wrongRepeatedBalance = twseSblFixture();
  wrongRepeatedBalance.data[0][2] = '999,999';
  assert.equal(
    parseTwseSblHist(wrongRepeatedBalance, '20260706')[0].SecuritiesBorrowingBalanceOfTheMarketDay,
    '7,654',
  );
  assert.deepEqual(parseTpexSblHist(tpexSblFixture(), '20260706'), [{
    SecuritiesCompanyCode: '5483',
    CompanyName: '中美晶',
    SecuritiesBorrowingBalanceOfTheMarketDay: '3,210',
  }]);
  const differentTpexBalances = tpexSblFixture({
    marginBalance: 'INDEX_6_MARGIN_BALANCE',
    balance: 'INDEX_12_SBL_BALANCE',
  });
  assert.equal(
    parseTpexSblHist(differentTpexBalances, '20260706')[0].SecuritiesBorrowingBalanceOfTheMarketDay,
    'INDEX_12_SBL_BALANCE',
  );
  assert.throws(() => parseTwseSblHist(twseSblFixture(), '20260707'), /does not match 20260707/);
  assert.throws(() => parseTpexSblHist(tpexSblFixture(), '20260707'), /does not match 20260707/);
});

test('SBL derived parsers isolate borrowing blocks and reject TPEX fields drift', (t) => {
  const twseFixture = twseSblFixture({
    balance: '7,654',
    sale: '1,234',
    marginBalance: '106',
  });
  twseFixture.fields[6] = '當日餘額';
  assert.notEqual(twseFixture.data[0][6], twseFixture.data[0][12]);
  assert.deepEqual(parseTwseSblDerived(twseFixture)[0], {
    SecuritiesCompanyCode: '2330',
    CompanyName: '台積電',
    SecuritiesBorrowingBalanceOfTheMarketDay: 7654,
    SecuritiesBorrowingSaleOfTheMarketDay: 1234,
  });
  const twseGroupDrift = structuredClone(twseFixture);
  twseGroupDrift.groups[1].span = 5;
  twseGroupDrift.groups[2].span = 7;
  assert.throws(() => parseTwseSblDerived(twseGroupDrift), /invalid group 借券賣出/);

  const tpexFixture = tpexSblFixture({
    balance: '3,210',
    sale: '987',
    marginBalance: '8,765',
  });
  assert.notEqual(tpexFixture.tables[0].data[0][6], tpexFixture.tables[0].data[0][12]);
  assert.deepEqual(parseTpexSblDerived(tpexFixture)[0], {
    SecuritiesCompanyCode: '5483',
    CompanyName: '中美晶',
    SecuritiesBorrowingBalanceOfTheMarketDay: 3210,
    SecuritiesBorrowingSaleOfTheMarketDay: 987,
  });
  const tpexFieldsDrift = structuredClone(tpexFixture);
  tpexFieldsDrift.tables[0].fields[9] = '欄位漂移';
  assert.throws(
    () => parseTpexSblDerived(tpexFieldsDrift),
    /TPEX_SBL: fields\[9\] must be 當日賣出/,
  );

  t.diagnostic('TWSE_SBL_GROUP_SELECTION=margin_當日餘額:106,sbl_當日餘額:7654,result:7654; GROUP_DRIFT=THREW');
  t.diagnostic('TPEX_SBL_FIELDS_DRIFT=fields[9]:欄位漂移,RESULT=THREW');
  t.diagnostic('CROSS_MARKET_SBL_BALANCE_SELECTION=twse_margin:106,twse_sbl:7654,tpex_margin:8765,tpex_sbl:3210');
});

test('SBL values project into trailing symbol derived columns for both markets', async (t) => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse/mi_index_hist', '2026-07-06', jsonBytes(miIndexFixture()));
    await writeRaw(root, 'twse/sbl_hist', '2026-07-06', jsonBytes(twseSblFixture({
      balance: '7,654',
      sale: '1,234',
    })));
    await writeRaw(root, 'tpex/daily_quotes_hist', '2026-07-06', jsonBytes(tpexDailyFixture()));
    await writeRaw(root, 'tpex/sbl_hist', '2026-07-06', jsonBytes(tpexSblFixture({
      balance: '3,210',
      sale: '987',
    })));

    await applyDailyDate(root, '2026-07-06');
    const twse = await readJson(root, 'data/derived/symbols/23/2330.json');
    const tpex = await readJson(root, 'data/derived/symbols/54/5483.json');
    const cols = ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd', 'sb', 'ss'];
    assert.deepEqual(twse.cols, cols);
    assert.deepEqual(twse.rows, [[
      20260706, 1080, 1090, 1075, 1085, 32145678, 45210,
      null, null, null, null, null, null, 7654, 1234,
    ]]);
    assert.deepEqual(tpex.cols, cols);
    assert.deepEqual(tpex.rows, [[
      20260706, 244.5, 250, 234.5, 235.5, 32146669, 28003,
      null, null, null, null, null, null, 3210, 987,
    ]]);
    t.diagnostic('SBL_SYMBOL_ROWS=twse:20260706/sb=7654/ss=1234,tpex:20260706/sb=3210/ss=987');
  });
});

test('symbol upsert upgrades every legacy thirteen-column row with trailing nulls', async () => {
  await withTempDir(async (root) => {
    const legacyCols = ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd'];
    const legacyRows = [
      [20260702, 1000, 1010, 990, 1005, 11111111, 12345, 9000, 100, 101, 102, 103, 104],
      [20260703, 1010, 1020, 995, 1015, 22222222, 23456, null, 0, -201, 202, null, -204],
    ];
    await writeDerived(root, 'symbols/23/2330.json', {
      id: '2330', name: '台積電', market: 'twse', updated: '2026-07-03',
      cols: legacyCols, rows: legacyRows,
    });
    await writeRaw(root, 'twse/mi_index_hist', '2026-07-06', jsonBytes(miIndexFixture()));

    await applyDailyDate(root, '2026-07-06');
    const symbol = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.deepEqual(symbol.cols, [...legacyCols, 'sb', 'ss']);
    assert.deepEqual(symbol.rows.map((row) => row.length), [
      symbol.cols.length,
      symbol.cols.length,
      symbol.cols.length,
    ]);
    assert.deepEqual(
      symbol.rows.slice(0, legacyRows.length).map((row) => row.slice(0, legacyCols.length)),
      legacyRows,
    );
    assert.deepEqual(
      symbol.rows.slice(0, legacyRows.length).map((row) => row.slice(legacyCols.length)),
      [[null, null], [null, null]],
    );
  });
});

test('valuation legacy parsers preserve the five-field contract across TWSE and both TPEX schemas', () => {
  assert.deepEqual(parseTwseBwibbuHist(bwibbuFixture())[0], {
    Code: '1101', Name: '台泥', PEratio: null, PBratio: 0.79, DividendYield: 3.3,
  });
  assert.deepEqual(parseTpexPeHist(tpexPeFixture())[0], {
    Code: '1240', Name: '茂生農經', PEratio: 10.54, PBratio: 1.67, DividendYield: 6.17,
  });
  assert.deepEqual(parseTpexPeHist(tpexPeFixture({ year: 2021 }))[0], {
    Code: '1240', Name: '茂生農經', PEratio: 11.88, PBratio: 1.52, DividendYield: 4.66,
  });

  const withoutOptional = tpexPeFixture();
  const optionalIndex = withoutOptional.tables[0].fields.indexOf('每股股利');
  withoutOptional.tables[0].fields.splice(optionalIndex, 1);
  withoutOptional.tables[0].data[0].splice(optionalIndex, 1);
  assert.equal(parseTpexPeHist(withoutOptional)[0].Code, '1240');
  const missingRequired = tpexPeFixture({ year: 2021 });
  missingRequired.tables[0].fields[2] = '漂移';
  assert.throws(() => parseTpexPeHist(missingRequired), /missing field 本益比/);
});

test('valuation legacy parsers match official non-trading response shapes', () => {
  assert.throws(
    () => parseTwseBwibbuHist({ stat: '很抱歉，沒有符合條件的資料!', total: 0 }),
    /stat is not OK/,
  );
  assert.deepEqual(parseTpexPeHist(tpexPeFixture({ empty: true })), []);
});

test('valuation hist readers share the daily fundamental path with TWSE openapi priority and TPEX market metadata', async () => {
  await withTempDir(async (root) => {
    assert.equal(DEFAULT_VALUATION_WINDOW, 1300);
    await writeRaw(root, 'twse/bwibbu_hist', '2026-08-14', jsonBytes(bwibbuFixture()));
    await writeRaw(root, 'twse/bwibbu_all', '2026-08-14', jsonBytes([{
      Code: '1101', Name: 'openapi 台泥', PEratio: '7.5', PBratio: '0.8', DividendYield: '3.2',
    }]));
    await writeRaw(root, 'tpex/pe_hist', '2026-08-14', jsonBytes(tpexPeFixture()));
    await applyDailyDate(root, '2026-08-14');

    const twse = await readJson(root, 'data/derived/fundamentals/11/1101.json');
    assert.equal(twse.name, 'openapi 台泥');
    assert.equal(twse.market, 'twse');
    assert.deepEqual(twse.valuation.rows, [[20260814, 7.5, 0.8, 3.2]]);
    const tpex = await readJson(root, 'data/derived/fundamentals/12/1240.json');
    assert.equal(tpex.name, '茂生農經');
    assert.equal(tpex.market, 'tpex');
    assert.deepEqual(tpex.valuation.rows, [[20260814, 10.54, 1.67, 6.17]]);
  });
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

test('MI_MARGN groups select both repeated balances and hist replay fills the fifteen-column TWSE row', async () => {
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
    assert.deepEqual(symbol.cols, ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd', 'sb', 'ss']);
    assert.deepEqual(symbol.rows, [[20260706, 1080, 1090, 1075, 1085, 32145678, 45210, 9577, 120, 9999, 1200, 400, 300, null, null]]);
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
    assert.deepEqual(symbol.rows[0], [20260706, 10, 11, 9, 10.5, 100, 20, 30, 40, 9999, 1200, 400, 300, null, null]);
  });
});

test('TPEX hist replay fills symbol and market series through the shared daily path', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'tpex/daily_quotes_hist', '2026-07-17', jsonBytes(tpexDailyFixture()));
    await writeRaw(root, 'tpex/insti_hist', '2026-07-17', jsonBytes(tpexInstiFixture()));
    await writeRaw(root, 'tpex/margin_hist', '2026-07-17', jsonBytes(tpexMarginFixture()));
    await applyDailyDate(root, '2026-07-17');

    const symbol = await readJson(root, 'data/derived/symbols/54/5483.json');
    assert.deepEqual(symbol.cols, ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd', 'sb', 'ss']);
    assert.deepEqual(symbol.rows, [[
      20260717, 244.5, 250, 234.5, 235.5, 32146669, 28003,
      13591, 0, 5977305, 4294211, 1729536, -46442, null, null,
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
    assert.deepEqual(symbol.rows, [[20260717, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, null, null]]);
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
      cols: ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd', 'sb', 'ss'], rows,
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
    assert.deepEqual(
      await readFile(join(root, 'data/raw/twse/bwibbu_hist/2026/2026-07-06.json')),
      jsonBytes(bwibbuFixture()),
    );
    assert.deepEqual(
      await readFile(join(root, 'data/raw/tpex/pe_hist/2026/2026-07-06.json')),
      jsonBytes(tpexPeFixture()),
    );
    assert.deepEqual(
      await readFile(join(root, 'data/raw/twse/sbl_hist/2026/2026-07-06.json')),
      jsonBytes(twseSblFixture()),
    );
    assert.deepEqual(
      await readFile(join(root, 'data/raw/tpex/sbl_hist/2026/2026-07-06.json')),
      jsonBytes(tpexSblFixture()),
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

test('existing pure-data raw skips fetch while missing and corrupt datasets are fetched again', async (t) => {
  await withTempDir(async (root) => {
    const options = {
      rootDir: root,
      dates: '2026-07-06',
      delayMs: 0,
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    };
    await runBackfill({ ...options, fetchImpl: fixtureFetcher() });
    const before = await fileMap(join(root, 'data'));

    const secondCalls = [];
    const second = await runBackfill({ ...options, fetchImpl: fixtureFetcher({ calls: secondCalls }) });
    const purePatterns = [
      '/fund/T86?', '/MI_MARGN?', '/BWIBBU_d?',
      '/insti/dailyTrade?', '/margin/balance?', '/afterTrading/peQryDate?',
    ];
    const healthyFetches = Object.fromEntries(
      purePatterns.map((pattern) => [pattern, secondCalls.filter((url) => url.includes(pattern)).length]),
    );
    assert.deepEqual(healthyFetches, Object.fromEntries(purePatterns.map((pattern) => [pattern, 0])));
    assert.equal(second.rawWritten, 0);
    assert.deepEqual(await fileMap(join(root, 'data')), before);

    await rm(join(root, 'data/raw/twse/bwibbu_hist/2026/2026-07-06.json'));
    const thirdCalls = [];
    await runBackfill({ ...options, fetchImpl: fixtureFetcher({ calls: thirdCalls }) });
    assert.deepEqual(
      Object.fromEntries(purePatterns.map((pattern) => [pattern, thirdCalls.filter((url) => url.includes(pattern)).length])),
      Object.fromEntries(purePatterns.map((pattern) => [pattern, pattern === '/BWIBBU_d?' ? 1 : 0])),
    );

    const bwibbuPath = join(root, 'data/raw/twse/bwibbu_hist/2026/2026-07-06.json');
    await writeFile(bwibbuPath, Buffer.from('{"stat":"OK","fields":[],'));
    const fourthCalls = [];
    const fourth = await runBackfill({ ...options, fetchImpl: fixtureFetcher({ calls: fourthCalls }) });
    const corruptFetches = fourthCalls.filter((url) => url.includes('/BWIBBU_d?')).length;
    const otherFetches = purePatterns
      .filter((pattern) => pattern !== '/BWIBBU_d?')
      .reduce((total, pattern) => total + fourthCalls.filter((url) => url.includes(pattern)).length, 0);
    const repaired = (await readFile(bwibbuPath)).equals(jsonBytes(bwibbuFixture()));
    assert.equal(corruptFetches, 1);
    assert.equal(otherFetches, 0);
    assert.equal(repaired, true);
    assert.equal(fourth.rawWritten, 1);
    t.diagnostic(`HEALTHY_SIX_FETCHES=${JSON.stringify(healthyFetches)}`);
    t.diagnostic(`CORRUPT_ENDPOINT_FETCHES=${corruptFetches}`);
    t.diagnostic(`OTHER_FIVE_FETCHES=${otherFetches}`);
    t.diagnostic(`REPAIRED_BYTES_EQUAL_OFFICIAL=${repaired}`);
  });
});

test('existing bearing raw never bypasses TWSE and TPEX trading-day fetches', async () => {
  async function runState(preseedBearingRaw) {
    let result;
    await withTempDir(async (root) => {
      if (preseedBearingRaw) {
        await writeRaw(root, 'twse/mi_index_hist', '2026-07-06', Buffer.from('{"stale":true}\n'));
        await writeRaw(root, 'tpex/daily_quotes_hist', '2026-07-06', Buffer.from('{"stale":true}\n'));
      }
      const calls = [];
      const summary = await runBackfill({
        rootDir: root,
        dates: '2026-07-06',
        delayMs: 0,
        fetchImpl: fixtureFetcher({ calls }),
        sleepImpl: async () => {},
        logger: silentLogger,
        now: () => new Date('2026-07-19T00:00:00Z'),
      });
      result = {
        trading: summary.trading,
        twseBearingFetches: calls.filter((url) => url.includes('/MI_INDEX?')).length,
        tpexBearingFetches: calls.filter((url) => url.includes('/afterTrading/dailyQuotes?')).length,
      };
    });
    return result;
  }

  assert.deepEqual(await runState(false), {
    trading: 1,
    twseBearingFetches: 1,
    tpexBearingFetches: 1,
  });
  assert.deepEqual(await runState(true), {
    trading: 1,
    twseBearingFetches: 1,
    tpexBearingFetches: 1,
  });
});

test('applyDailyDate runs for zero raw writes, derived-input writes, and SBL-only writes', async (t) => {
  await withTempDir(async (root) => {
    let applyCalls = 0;
    const options = {
      rootDir: root,
      dates: '2026-07-06',
      delayMs: 0,
      fetchImpl: fixtureFetcher(),
      sleepImpl: async () => {},
      applyDailyDateImpl: async (...args) => {
        applyCalls += 1;
        return applyDailyDate(...args);
      },
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    };

    await runBackfill(options);
    assert.equal(applyCalls, 1);

    applyCalls = 0;
    const unchanged = await runBackfill(options);
    assert.equal(unchanged.rawWritten, 0);
    assert.equal(applyCalls, 1);
    t.diagnostic(`ZERO_RAW_WRITES_APPLY_CALLS=${applyCalls}`);

    await rm(join(root, 'data/raw/twse/bwibbu_hist/2026/2026-07-06.json'));
    applyCalls = 0;
    const derivedInput = await runBackfill(options);
    assert.equal(derivedInput.rawWritten, 1);
    assert.equal(applyCalls, 1);
    t.diagnostic(`DERIVED_INPUT_WRITE_APPLY_CALLS=${applyCalls}`);

    await rm(join(root, 'data/raw/twse/sbl_hist/2026/2026-07-06.json'));
    await rm(join(root, 'data/raw/tpex/sbl_hist/2026/2026-07-06.json'));
    applyCalls = 0;
    const sblOnly = await runBackfill(options);
    assert.equal(sblOnly.rawWritten, 2);
    assert.equal(applyCalls, 1);
    t.diagnostic(`SBL_ONLY_WRITE_APPLY_CALLS=${applyCalls}`);
  });
});

test('zero raw writes rebuild missing derived outputs', async (t) => {
  await withTempDir(async (root) => {
    const options = {
      rootDir: root,
      dates: '2026-07-06',
      delayMs: 0,
      fetchImpl: fixtureFetcher(),
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    };
    const seeded = await runBackfill({
      ...options,
      applyDailyDateImpl: async () => ({ symbols: 0, fundamentals: 0, market: false }),
    });
    assert.equal(seeded.rawWritten, 10);
    assert.deepEqual(await fileMap(join(root, 'data', 'derived')), {});

    let applyCalls = 0;
    const repaired = await runBackfill({
      ...options,
      applyDailyDateImpl: async (...args) => {
        applyCalls += 1;
        return applyDailyDate(...args);
      },
    });
    const derived = await fileMap(join(root, 'data', 'derived'));
    assert.equal(repaired.rawWritten, 0);
    assert.equal(applyCalls, 1);
    assert.ok(Object.keys(derived).length > 0);

    await rm(join(root, 'data', 'derived'), { recursive: true });
    await rm(join(root, 'data/raw/twse/sbl_hist/2026/2026-07-06.json'));
    await rm(join(root, 'data/raw/tpex/sbl_hist/2026/2026-07-06.json'));
    applyCalls = 0;
    const sblAndMissingDerived = await runBackfill({
      ...options,
      applyDailyDateImpl: async (...args) => {
        applyCalls += 1;
        return applyDailyDate(...args);
      },
    });
    assert.equal(sblAndMissingDerived.rawWritten, 2);
    assert.equal(applyCalls, 1);
    assert.ok(Object.keys(await fileMap(join(root, 'data', 'derived'))).length > 0);
    t.diagnostic(`MISSING_DERIVED_REBUILT=true SEEDED_RAW_WRITTEN=${seeded.rawWritten} ZERO_WRITE_RERUN_RAW_WRITTEN=${repaired.rawWritten} SBL_RERUN_RAW_WRITTEN=${sblAndMissingDerived.rawWritten} APPLY_CALLS=${applyCalls} FILES=${JSON.stringify(Object.keys(derived))}`);
  });
});

test('zero raw writes reapplies a changed symbol window', async (t) => {
  await withTempDir(async (root) => {
    const options = {
      rootDir: root,
      dates: '2026-07-06',
      delayMs: 0,
      fetchImpl: fixtureFetcher(),
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    };
    const initial = await runBackfill({ ...options, symbolWindow: 2 });
    assert.equal(initial.rawWritten, 10);
    const symbolPath = 'symbols/23/2330.json';
    const seeded = await readJson(root, `data/derived/${symbolPath}`);
    const olderRow = [20260703, ...seeded.rows[0].slice(1)];
    await writeDerived(root, symbolPath, { ...seeded, rows: [olderRow, seeded.rows[0]] });
    assert.equal((await readJson(root, `data/derived/${symbolPath}`)).rows.length, 2);

    let applyCalls = 0;
    const resized = await runBackfill({
      ...options,
      symbolWindow: 1,
      applyDailyDateImpl: async (...args) => {
        applyCalls += 1;
        return applyDailyDate(...args);
      },
    });
    const rows = (await readJson(root, `data/derived/${symbolPath}`)).rows;
    assert.equal(resized.rawWritten, 0);
    assert.equal(applyCalls, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0], 20260706);

    await writeDerived(root, symbolPath, { ...seeded, rows: [olderRow, seeded.rows[0]] });
    await rm(join(root, 'data/raw/twse/sbl_hist/2026/2026-07-06.json'));
    await rm(join(root, 'data/raw/tpex/sbl_hist/2026/2026-07-06.json'));
    applyCalls = 0;
    const sblAndResized = await runBackfill({
      ...options,
      symbolWindow: 1,
      applyDailyDateImpl: async (...args) => {
        applyCalls += 1;
        return applyDailyDate(...args);
      },
    });
    const sblRows = (await readJson(root, `data/derived/${symbolPath}`)).rows;
    assert.equal(sblAndResized.rawWritten, 2);
    assert.equal(applyCalls, 1);
    assert.equal(sblRows.length, 1);
    t.diagnostic(`SYMBOL_WINDOW_ROWS_BEFORE=2 ZERO_WRITE_AFTER=${rows.length} SBL_AFTER=${sblRows.length} SEEDED_RAW_WRITTEN=${initial.rawWritten} ZERO_WRITE_RERUN_RAW_WRITTEN=${resized.rawWritten} SBL_RERUN_RAW_WRITTEN=${sblAndResized.rawWritten} APPLY_CALLS=${applyCalls}`);
  });
});

test('SBL-only writes invoke applyDailyDate and remain byte-identical to the base unconditional call', async (t) => {
  await withTempDir(async (root) => {
    const optimizedRoot = join(root, 'optimized');
    const baseRoot = join(root, 'base');
    const options = (rootDir) => ({
      rootDir,
      dates: '2026-07-06',
      delayMs: 0,
      fetchImpl: fixtureFetcher(),
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    });

    await runBackfill(options(optimizedRoot));
    await runBackfill(options(baseRoot));
    const seededOptimized = await fileMap(join(optimizedRoot, 'data', 'derived'));
    const seededBase = await fileMap(join(baseRoot, 'data', 'derived'));
    assert.deepEqual(seededOptimized, seededBase);

    for (const candidateRoot of [optimizedRoot, baseRoot]) {
      await rm(join(candidateRoot, 'data/raw/twse/sbl_hist/2026/2026-07-06.json'));
      await rm(join(candidateRoot, 'data/raw/tpex/sbl_hist/2026/2026-07-06.json'));
    }

    let optimizedApplyCalls = 0;
    const optimized = await runBackfill({
      ...options(optimizedRoot),
      applyDailyDateImpl: async (...args) => {
        optimizedApplyCalls += 1;
        return applyDailyDate(...args);
      },
    });
    assert.equal(optimized.rawWritten, 2);
    assert.equal(optimizedApplyCalls, 1);

    await runBackfill(options(baseRoot));
    await applyDailyDate(baseRoot, '2026-07-06');
    const optimizedDerived = await fileMap(join(optimizedRoot, 'data', 'derived'));
    const baseDerived = await fileMap(join(baseRoot, 'data', 'derived'));
    assert.deepEqual(optimizedDerived, baseDerived);
    t.diagnostic(`SBL_ONLY_DERIVED_TREE_BITWISE_EQUAL=${JSON.stringify(Object.keys(baseDerived))} RAW_WRITTEN=${optimized.rawWritten} OPTIMIZED_APPLY_CALLS=${optimizedApplyCalls}`);
  });
});

test('DERIVED_INPUT_DATASETS exactly matches the namespaces read by applyDailyDate', async (t) => {
  const source = await readFile(new URL('../scripts/lib/derived.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export async function applyDailyDate');
  const end = source.indexOf('\nexport async function applyMonthlyRevenue', start);
  const applySource = source.slice(start, end);
  const actual = [...applySource.matchAll(/read(?:Json|Text)Raw\(rootDir, '([^']+)', isoDate\)/g)]
    .map((match) => match[1]);
  const registered = [...DERIVED_INPUT_DATASETS];
    assert.equal(new Set(actual).size, 18);
  assert.deepEqual([...registered].sort(), [...actual].sort());

  const drifted = registered.filter((dataset) => dataset !== 'twse/mi_index');
  assert.throws(() => assert.deepEqual([...drifted].sort(), [...actual].sort()));
  t.diagnostic(`DERIVED_INPUT_DATASETS_MATCH=true COUNT=${actual.length}`);
  t.diagnostic('NEGATIVE_CONTROL_REMOVE_TWSE_MI_INDEX=ASSERTION_REJECTED');
});

test('checkpoint resumes after interruption without refetching completed dates', async (t) => {
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
    const interruptedCheckpoint = await readJson(root, '.backfill-progress.json');
    assert.deepEqual(interruptedCheckpoint, {
      lastDate: '2026-07-06',
      fromDate: '2026-07-06',
      toDate: '2026-07-07',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });

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
    t.diagnostic(`INTERRUPTED_CHECKPOINT=${JSON.stringify(interruptedCheckpoint)}`);
    t.diagnostic(`RESUME_RESULT=${JSON.stringify({ resumed: summary.resumed, completedDateRefetched: resumedCalls.some((url) => url.includes('20260706') || url.includes('2026/07/06')) })}`);
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

test('existing openapi raw still fetches both valuation histories while preserving TWSE T86 behavior', async () => {
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
    const bodies = {
      T86: jsonBytes(t86Fixture()),
      BWIBBU: jsonBytes(bwibbuFixture()),
      TWSE_SBL: jsonBytes(twseSblFixture()),
      TPEX_PE: jsonBytes(tpexPeFixture()),
      TPEX_SBL: jsonBytes(tpexSblFixture()),
    };
    const summary = await runBackfill({
      rootDir: root,
      fromIso: '2026-07-06',
      toIso: '2026-07-06',
      delayMs: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes('/fund/T86?')) return responseFor(bodies.T86);
        if (url.includes('/BWIBBU_d?')) return responseFor(bodies.BWIBBU);
        if (url.includes('/TWT93U?')) return responseFor(bodies.TWSE_SBL);
        if (url.includes('/afterTrading/peQryDate?')) return responseFor(bodies.TPEX_PE);
        if (url.includes('/margin/sbl?')) return responseFor(bodies.TPEX_SBL);
        throw new Error(`unexpected URL: ${url}`);
      },
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    });
    assert.equal(summary.openApiDays, 1);
    assert.equal(summary.tpexOpenApiDays, 1);
    assert.equal(calls.length, 5);
    assert.equal(calls.filter((url) => url.includes('www.tpex.org.tw')).length, 2);
    assert.deepEqual(await readFile(join(root, 'data/raw/twse/t86_hist/2026/2026-07-06.json')), bodies.T86);
    assert.deepEqual(await readFile(join(root, 'data/raw/twse/bwibbu_hist/2026/2026-07-06.json')), bodies.BWIBBU);
    assert.deepEqual(await readFile(join(root, 'data/raw/tpex/pe_hist/2026/2026-07-06.json')), bodies.TPEX_PE);
    assert.deepEqual(await readFile(join(root, 'data/raw/twse/sbl_hist/2026/2026-07-06.json')), bodies.TWSE_SBL);
    assert.deepEqual(await readFile(join(root, 'data/raw/tpex/sbl_hist/2026/2026-07-06.json')), bodies.TPEX_SBL);
    const symbol = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.deepEqual(symbol.rows[0], [20260706, 10, 11, 9, 10.5, 100, 20, 30, 40, 9999, 1200, 400, 300, 7654, 100]);
  });
});

test('old-format later checkpoint does not block an earlier range while --dates still preserves checkpoint bytes', async (t) => {
  await withTempDir(async (root) => {
    const checkpointPath = join(root, '.backfill-progress.json');
    const checkpointBytes = Buffer.from('{"lastDate":"2026-12-31","updatedAt":"frozen"}\n');
    await writeFile(checkpointPath, checkpointBytes);
    const rangeCalls = [];
    const range = await runBackfill({
      rootDir: root,
      fromIso: '2026-07-06',
      toIso: '2026-07-06',
      delayMs: 0,
      fetchImpl: fixtureFetcher({ calls: rangeCalls }),
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-08-29T00:00:00Z'),
    });
    assert.equal(range.resumed, 0);
    assert.ok(range.rawWritten > 0);
    assert.ok(rangeCalls.length > 0);
    const rangeCheckpoint = await readJson(root, '.backfill-progress.json');
    assert.deepEqual(rangeCheckpoint, {
      lastDate: '2026-07-06',
      fromDate: '2026-07-06',
      toDate: '2026-07-06',
      updatedAt: '2026-08-29T00:00:00.000Z',
    });

    await writeFile(checkpointPath, checkpointBytes);

    const dateCalls = [];
    const explicit = await runBackfill({
      rootDir: root,
      dates: '2026-07-06',
      delayMs: 0,
      fetchImpl: fixtureFetcher({ calls: dateCalls }),
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-08-29T00:00:00Z'),
    });
    assert.equal(explicit.trading, 1);
    assert.equal(explicit.rawWritten, 0);
    assert.ok(dateCalls.length > 0);
    assert.deepEqual(await readFile(checkpointPath), checkpointBytes);
    t.diagnostic('OLD_FORMAT_CHECKPOINT_LOAD=FULFILLED');
    t.diagnostic(`OLD_FORMAT_RANGE_RESULT=${JSON.stringify({ resumed: range.resumed, rawWritten: range.rawWritten, fetchCalls: rangeCalls.length, checkpoint: rangeCheckpoint })}`);
    t.diagnostic(`EXPLICIT_DATES_CHECKPOINT_UNCHANGED=${(await readFile(checkpointPath)).equals(checkpointBytes)}`);
  });
});

test('--dates records a frozen stat failure, continues later dates, then rejects after its summary', async (t) => {
  await withTempDir(async (root) => {
    const calls = [];
    const logs = [];
    const warnings = [];
    const goodFetcher = fixtureFetcher({ calls });
    const nonTradingBytes = await readFile(new URL('./fixtures/twse-mi-index-non-trading.json', import.meta.url));
    let caught;
    try {
      await runBackfill({
        rootDir: root,
        dates: '2026-07-06,2026-07-07',
        delayMs: 0,
        maxRetries: 0,
        fetchImpl: async (url) => {
          if (url.includes('/MI_MARGN?date=20260706')) {
            calls.push(url);
            return responseFor(nonTradingBytes);
          }
          return goodFetcher(url);
        },
        sleepImpl: async () => {},
        logger: {
          log(message) { logs.push(message); },
          warn(message) { warnings.push(message); },
        },
        now: () => new Date('2026-08-29T00:00:00Z'),
      });
    } catch (error) {
      caught = error;
    }
    assert.match(caught?.message ?? '', /--dates completed with 1 failure/);
    assert.equal(caught.summary.failures[0].date, '2026-07-06');
    assert.match(caught.summary.failures[0].error, /MI_MARGN: stat is not OK/);
    assert.ok(calls.some((url) => url.includes('date=20260707')));
    assert.ok(calls.some((url) => url.includes('date=2026/07/07')));
    assert.ok(warnings.some((line) => line.includes('[fail] 2026-07-06')));
    assert.ok(logs.some((line) => line.includes('[done]') && line.includes('failed=1')));
    t.diagnostic(warnings.find((line) => line.includes('[fail] 2026-07-06')));
    t.diagnostic(logs.find((line) => line.includes('[ok] 2026-07-07')));
    t.diagnostic(logs.find((line) => line.includes('[done]')));
  });
});

test('--dates rejects today and future dates before fetching', async () => {
  let calls = 0;
  await assert.rejects(runBackfill({
    dates: '2026-08-29,2026-08-30',
    delayMs: 0,
    fetchImpl: async () => { calls += 1; },
    sleepImpl: async () => {},
    logger: silentLogger,
    now: () => new Date('2026-08-29T00:00:00Z'),
  }), /must be before today \(2026-08-29\)/);
  assert.equal(calls, 0);
});

test('CLI options preserve explicit range flags for --dates conflicts and retain range defaults', async () => {
  let calls = 0;
  const conflicting = backfillOptionsFromArgs({
    dates: '2026-08-18',
    from: '2026-08-01',
    'delay-ms': '0',
  });
  await assert.rejects(runBackfill({
    ...conflicting,
    fetchImpl: async () => { calls += 1; },
    sleepImpl: async () => {},
    logger: silentLogger,
    now: () => new Date('2026-08-29T00:00:00Z'),
  }), /--dates cannot be combined with --from or --to/);
  assert.equal(calls, 0);

  const defaults = backfillOptionsFromArgs({});
  assert.equal(defaults.fromIso, '2024-01-01');
  assert.equal(defaults.toIso, '2024-01-31');
  const explicitOnly = backfillOptionsFromArgs({ dates: '2026-08-18' });
  assert.equal(explicitOnly.fromIso, undefined);
  assert.equal(explicitOnly.toIso, undefined);
});

test('--dates rejects nonexistent calendar dates before fetching and accepts a real date', async () => {
  await withTempDir(async (root) => {
    let calls = 0;
    await assert.rejects(runBackfill({
      rootDir: root,
      dates: '2026-02-29',
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: async () => { calls += 1; },
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-08-29T00:00:00Z'),
    }), /--dates must be YYYY-MM-DD, got: 2026-02-29/);
    assert.equal(calls, 0);

    await assert.rejects(runBackfill({
      rootDir: root,
      dates: '2026-02-28',
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('valid date reached fetch');
      },
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-08-29T00:00:00Z'),
    }), /valid date reached fetch/);
    assert.equal(calls, 1);
  });
});
