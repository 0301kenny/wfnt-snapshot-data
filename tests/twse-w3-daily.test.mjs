import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKFILL_ENDPOINTS } from '../scripts/endpoints.mjs';
import { COVERAGE_SOURCES } from '../scripts/detect-gaps.mjs';
import { validateHistoryBackfillBytes } from '../scripts/lib/history-backfill.mjs';

const bytes = (value) => Buffer.from(JSON.stringify(value));
const kind = (dataset, value, iso = '2009-03-06') => (
  validateHistoryBackfillBytes(dataset, bytes(value), iso).kind
);

// Field lists are cut from the official samples (2006 = 11 columns, 2026 = 12 columns).
const QFIIS_11 = [
  '證券代號', '證券名稱', '國際證券編碼', '發行股數', '外資尚可投資股數', '全體外資持有股數',
  '外資尚可投資比率', '全體外資持股比率', '法令投資上限比率', '與前日異動原因(註)',
  '最近一次上市公司申報外資持股異動日期',
];
const QFIIS_12 = [...QFIIS_11.slice(0, 9), '陸資法令投資上限比率', ...QFIIS_11.slice(9)];
const BLOCK_5 = ['證券代號', '證券名稱', '成交價', '成交股數', '成交金額'];
const BLOCK_6 = ['證券代號', '證券名稱', '交易別', '成交價', '成交股數', '成交金額'];
const BLOCK_7 = ['證券代號', '證券名稱', '交易別', '交割期別', '成交價', '成交股數', '成交金額'];
const row = (width) => Array.from({ length: width }, (_, index) => (index === 0 ? '2330' : String(index)));
const flat = (fields, data = [row(fields.length)]) => ({ stat: 'OK', fields, data });

test('W3 daily endpoints are registered as daily backfill sources and in TWSE coverage', () => {
  const expected = {
    twse_qfiis_hist: ['twse/qfiis_hist', 'MI_QFIIS?date=20140106&selectType=ALLBUT0999&response=json'],
    twse_twt53u_hist: ['twse/twt53u_hist', 'TWT53U?date=20140106&selectType=ALL&response=json'],
    twse_twtb4u_hist: ['twse/twtb4u_hist', 'TWTB4U?date=20140106&selectType=All&response=json'],
    twse_bfiauu_hist: ['twse/bfiauu_hist', 'BFIAUU?date=20140106&selectType=S&response=json'],
  };
  for (const [key, [dataset, tail]] of Object.entries(expected)) {
    assert.equal(BACKFILL_ENDPOINTS[key].cadence, 'daily');
    assert.equal(BACKFILL_ENDPOINTS[key].sourceDataset, dataset);
    assert.ok(BACKFILL_ENDPOINTS[key].url('20140106').endsWith(tail), key);
    assert.ok(COVERAGE_SOURCES.twse.includes(dataset), dataset);
  }
});

test('foreign holding accepts 11 and 12 column layouts', () => {
  assert.equal(kind('twse/qfiis_hist', flat(QFIIS_11)), 'valid');
  assert.equal(kind('twse/qfiis_hist', flat(QFIIS_12)), 'valid');
});

test('block trades accept 5, 6 and 7 column layouts including the total row', () => {
  for (const fields of [BLOCK_5, BLOCK_6, BLOCK_7]) {
    assert.equal(kind('twse/bfiauu_hist', flat(fields)), 'valid', String(fields.length));
  }
  const withTotal = flat(BLOCK_7, [
    ['2330', '台積電', '配對交易', 'T+2日交割', '47.40', '640,000', '30,336,000'],
    ['總計', '', '', '', '', '640,000', '30,336,000'],
  ]);
  assert.equal(kind('twse/bfiauu_hist', withTotal), 'valid');
});

test('day trading accepts the two-table layout', () => {
  const payload = {
    stat: 'OK',
    tables: [
      { fields: ['當日沖銷交易總成交股數', '占比'], data: [['43,571,000', '0.77']] },
      { fields: ['證券代號', '證券名稱', '當日沖銷交易成交股數'], data: [['2330', '台積電', '1']] },
    ],
  };
  assert.equal(kind('twse/twtb4u_hist', payload, '2014-03-07'), 'valid');
});

test('empty block-trade day and the non-trading odd-lot reply are unavailable', () => {
  assert.equal(kind('twse/bfiauu_hist', flat(BLOCK_5, []), '2006-12-08'), 'unavailable');
  assert.equal(kind('twse/twt53u_hist', { stat: '很抱歉，沒有符合條件的資料!', total: null }), 'unavailable');
  assert.equal(kind('twse/twtb4u_hist', { stat: '查詢日期小於103年1月6日，請重新查詢!' }, '2009-10-05'), 'unavailable');
});

test('one row with the wrong width quarantines the response', () => {
  const data = [row(5), row(5), row(4)];
  assert.equal(kind('twse/bfiauu_hist', flat(BLOCK_5, data)), 'quarantined');
  assert.equal(kind('twse/twt53u_hist', flat(['證券代號', '證券名稱'], [['2330', 'x', 'extra']])), 'quarantined');
});

test('width is checked on every table of a multi-table response', () => {
  const payload = {
    stat: 'OK',
    tables: [
      { fields: ['當日沖銷交易總成交股數', '占比'], data: [['1']] },
      { fields: ['證券代號', '證券名稱'], data: [['2330', 'x']] },
    ],
  };
  assert.equal(kind('twse/twtb4u_hist', payload, '2014-03-07'), 'quarantined');
});

test('a response without a 證券代號 first-field table is quarantined', () => {
  assert.equal(kind('twse/qfiis_hist', flat(['代號', '名稱'], [['2330', 'x']])), 'quarantined');
  const payload = { stat: 'OK', tables: [{ fields: ['A', 'B'], data: [['1', '2']] }] };
  assert.equal(kind('twse/twtb4u_hist', payload, '2014-03-07'), 'quarantined');
});

test('a non-OK stat that still carries rows is quarantined', () => {
  assert.equal(kind('twse/qfiis_hist', { ...flat(QFIIS_11), stat: 'ERROR' }), 'quarantined');
});
