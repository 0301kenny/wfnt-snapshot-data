import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  applyDailyDate,
  mergeTwseLegacyInsti,
  parseTwseTwt38uHist,
  parseTwseTwt43uHist,
  parseTwseTwt44uHist,
} from '../scripts/lib/derived.mjs';

const FOREIGN_TRUST_FIELDS = ['', '證券代號', '證券名稱', '買進股數', '賣出股數', '買賣超股數'];
const DEALER_FIELDS = ['證券代號', '證券名稱', '買進股數', '賣出股數', '買賣超股數'];
const T86_FIELDS_A = [
  '證券代號', '證券名稱', '外資買進股數', '外資賣出股數', '外資買賣超股數',
  '投信買進股數', '投信賣出股數', '投信買賣超股數', '自營商買賣超股數',
  '自營商買進股數', '自營商賣出股數', '三大法人買賣超股數',
];

function twt(fields, data, extra = {}) {
  return { stat: 'OK', fields, data, total: data.length, ...extra };
}

// Verbatim real rows from the official 2006-10-16 responses.
const SAMPLE_2006 = {
  twt38u: twt(FOREIGN_TRUST_FIELDS, [
    [' ', '2330  ', '台積電          ', '69,432,000', '13,530,645', '55,901,355'],
    [' ', '2357  ', '華碩            ', '6,369,610', '2,375,170', '3,994,440'],
    [' ', '2854  ', '寶來證          ', '6,010,000', '86,000', '5,924,000'],
    [' ', '2855  ', '統一證          ', '594,000', '25,000', '569,000'],
  ], { date: '20061016' }),
  twt44u: twt(FOREIGN_TRUST_FIELDS, [
    [' ', '2330  ', '台積電          ', '720,000', '510,000', '210,000'],
    [' ', '2854  ', '寶來證          ', '200,000', '1,000', '199,000'],
  ], { date: '20061016' }),
  twt43u: twt(DEALER_FIELDS, [
    ['2330  ', '台積電          ', '1,008,000', '587,000', '421,000'],
    ['1305  ', '華夏            ', '350,000', '7,000', '343,000'],
    ['2357  ', '華碩            ', '55,110', '129,000', '-73,890'],
  ], { date: '20061016' }),
};

// Verbatim real rows from the official 2012-05-02 responses.
const SAMPLE_2012 = {
  twt38u: twt(FOREIGN_TRUST_FIELDS, [
    ['*', '2330  ', '台積電          ', '38,841,300', '32,897,643', '5,943,657'],
    [' ', '3061  ', '璨圓            ', '1,249,000', '388,000', '861,000'],
    [' ', '2323  ', '中環            ', '1,577,000', '238,000', '1,339,000'],
    [' ', '2475  ', '華映            ', '4,672,000', '1,952,000', '2,720,000'],
  ], { date: '20120502' }),
  twt44u: twt(FOREIGN_TRUST_FIELDS, [
    [' ', '2330  ', '台積電          ', '284,000', '272,000', '12,000'],
    [' ', '2323  ', '中環            ', '24,000', '0', '24,000'],
  ], { date: '20120502' }),
  twt43u: twt(DEALER_FIELDS, [
    ['2330  ', '台積電          ', '1,774,000', '1,043,000', '731,000'],
    ['2904  ', '匯僑            ', '0', '50,000', '-50,000'],
    ['3061  ', '璨圓            ', '73,000', '0', '73,000'],
  ], { date: '20120502' }),
  t86: twt(T86_FIELDS_A, [
    ['2330', '台積電          ', '38,841,300', '32,897,643', '5,943,657', '284,000', '272,000', '12,000', '731,000', '1,774,000', '1,043,000', '6,686,657'],
    ['2904', '匯僑            ', '0', '0', '0', '0', '0', '0', '-50,000', '0', '50,000', '-50,000'],
    ['3061', '璨圓            ', '1,249,000', '388,000', '861,000', '0', '0', '0', '73,000', '73,000', '0', '934,000'],
    ['2323', '中環            ', '1,577,000', '238,000', '1,339,000', '24,000', '0', '24,000', '0', '0', '0', '1,363,000'],
    ['2475', '華映            ', '4,672,000', '1,952,000', '2,720,000', '0', '0', '0', '0', '0', '0', '2,720,000'],
  ]),
};

function closeFixture(ids) {
  const tables = Array.from({ length: 9 }, () => ({ fields: [], data: [] }));
  tables[0] = { fields: ['指數', '收盤指數'], data: [['發行量加權股價指數', '8,000.00']] };
  tables[8] = {
    fields: ['證券代號', '證券名稱', '成交股數', '成交筆數', '開盤價', '最高價', '最低價', '收盤價'],
    data: ids.map((id) => [id, `n${id}`, '1', '1', '10', '11', '9', '10']),
  };
  return { stat: 'OK', tables };
}

async function writeRaw(root, dataset, date, value) {
  const path = join(root, 'data', 'raw', dataset, date.slice(0, 4), `${date}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function fileMap(dir, prefix = '') {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fileMap(join(dir, entry.name), rel));
    else result[rel] = (await readFile(join(dir, entry.name))).toString('base64');
  }
  return result;
}

async function withTempRoots(count, fn) {
  const roots = [];
  for (let i = 0; i < count; i += 1) roots.push(await mkdtemp(join(tmpdir(), 'wfnt-legacy-insti-')));
  try {
    await fn(...roots);
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
}

const IDS_2012 = ['2330', '2904', '3061', '2323', '2475'];
const DATE_2012 = '2012-05-02';

async function seedClose(root, date = DATE_2012) {
  await writeRaw(root, 'twse/mi_index_hist', date, closeFixture(IDS_2012));
}

async function seedTriple(root, sample = SAMPLE_2012, date = DATE_2012) {
  await writeRaw(root, 'twse/twt38u_hist', date, sample.twt38u);
  await writeRaw(root, 'twse/twt44u_hist', date, sample.twt44u);
  await writeRaw(root, 'twse/twt43u_hist', date, sample.twt43u);
}

async function readSymbol(root, id) {
  const text = await readFile(join(root, 'data', 'derived', 'symbols', id.slice(0, 2), `${id}.json`), 'utf8');
  const doc = JSON.parse(text);
  const row = doc.rows.find((candidate) => candidate[0] === 20120502);
  return Object.fromEntries(doc.cols.map((col, index) => [col, row[index]]));
}

test('2006-10-16 merge: union by id, absent legs are 0, fi is the sum, ids are trimmed', () => {
  const rows = mergeTwseLegacyInsti(SAMPLE_2006.twt38u, SAMPLE_2006.twt44u, SAMPLE_2006.twt43u);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual(Object.keys(byId).sort(), ['1305', '2330', '2357', '2854', '2855']);
  assert.deepEqual(byId['2330'], { id: '2330', name: '台積電', fi: 56532355, ff: 55901355, ft: 210000, fd: 421000 });
  assert.deepEqual(byId['1305'], { id: '1305', name: '華夏', fi: 343000, ff: 0, ft: 0, fd: 343000 });
  assert.deepEqual(byId['2357'], { id: '2357', name: '華碩', fi: 3920550, ff: 3994440, ft: 0, fd: -73890 });
  assert.deepEqual(byId['2854'], { id: '2854', name: '寶來證', fi: 6123000, ff: 5924000, ft: 199000, fd: 0 });
  assert.deepEqual(byId['2855'], { id: '2855', name: '統一證', fi: 569000, ff: 569000, ft: 0, fd: 0 });
});

test('applyDailyDate on three legacy files is byte-identical to the same day from T86', async () => {
  await withTempRoots(2, async (rootA, rootB) => {
    await seedClose(rootA);
    await writeRaw(rootA, 'twse/t86_hist', DATE_2012, SAMPLE_2012.t86);
    await seedClose(rootB);
    await seedTriple(rootB);
    await applyDailyDate(rootA, DATE_2012, { applySectorIndex: false });
    await applyDailyDate(rootB, DATE_2012, { applySectorIndex: false });
    const treeA = await fileMap(join(rootA, 'data', 'derived'));
    const treeB = await fileMap(join(rootB, 'data', 'derived'));
    assert.ok(Object.keys(treeA).length >= IDS_2012.length);
    assert.deepEqual(treeB, treeA);
    const tsmc = await readSymbol(rootB, '2330');
    assert.deepEqual(
      [tsmc.fi, tsmc.ff, tsmc.ft, tsmc.fd],
      [6686657, 5943657, 12000, 731000],
    );
  });
});

test('T86 wins when present; any missing leg leaves the institutional columns null', async () => {
  await withTempRoots(3, async (rootBoth, rootMissing, rootNone) => {
    const different = {
      twt38u: twt(FOREIGN_TRUST_FIELDS, [[' ', '2330  ', 'x', '1', '1', '111']]),
      twt44u: twt(FOREIGN_TRUST_FIELDS, [[' ', '2330  ', 'x', '1', '1', '222']]),
      twt43u: twt(DEALER_FIELDS, [['2330  ', 'x', '1', '1', '333']]),
    };
    await seedClose(rootBoth);
    await writeRaw(rootBoth, 'twse/t86_hist', DATE_2012, SAMPLE_2012.t86);
    await seedTriple(rootBoth, different);
    await applyDailyDate(rootBoth, DATE_2012, { applySectorIndex: false });
    const both = await readSymbol(rootBoth, '2330');
    assert.deepEqual([both.fi, both.ff, both.ft, both.fd], [6686657, 5943657, 12000, 731000]);

    await seedClose(rootMissing);
    await writeRaw(rootMissing, 'twse/twt38u_hist', DATE_2012, SAMPLE_2012.twt38u);
    await writeRaw(rootMissing, 'twse/twt43u_hist', DATE_2012, SAMPLE_2012.twt43u);
    await applyDailyDate(rootMissing, DATE_2012, { applySectorIndex: false });
    const missing = await readSymbol(rootMissing, '2330');
    assert.deepEqual([missing.fi, missing.ff, missing.ft, missing.fd], [null, null, null, null]);

    await seedClose(rootNone);
    await applyDailyDate(rootNone, DATE_2012, { applySectorIndex: false });
    const none = await readSymbol(rootNone, '2330');
    assert.deepEqual([none.fi, none.ff, none.ft, none.fd], [null, null, null, null]);
  });
});

const PARSERS = [
  ['TWT38U', parseTwseTwt38uHist, FOREIGN_TRUST_FIELDS, [' ', '2330  ', '台積電', '1', '1', '0']],
  ['TWT44U', parseTwseTwt44uHist, FOREIGN_TRUST_FIELDS, [' ', '2330  ', '台積電', '1', '1', '0']],
  ['TWT43U', parseTwseTwt43uHist, DEALER_FIELDS, ['2330  ', '台積電', '1', '1', '0']],
];

for (const [name, parse, fields, row] of PARSERS) {
  test(`${name} parser accepts the verbatim shape and rejects drift`, () => {
    assert.deepEqual(parse(twt(fields, [row])).map((item) => item.id), ['2330']);
    const renamed = fields.map((field, index) => (index === fields.length - 1 ? '買賣超股' : field));
    assert.throws(() => parse(twt(renamed, [row])), /fields/);
    assert.throws(() => parse(twt(fields, [row.slice(0, -1)])), /width/);
    assert.throws(() => parse(twt(fields, [row, row])), /duplicate/);
    assert.throws(() => parse({ ...twt(fields, [row]), stat: '很抱歉，沒有符合條件的資料!' }), /stat/);
  });
}
