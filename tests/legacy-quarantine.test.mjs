import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseTwseSblHist } from '../scripts/backfill.mjs';
import { parseTpexInstiHist, parseTwseT86Hist } from '../scripts/lib/derived.mjs';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const CLI_PATH = join(REPO_ROOT, 'scripts/promote-quarantine.mjs');

const T86_A_FIELDS = [
  '證券代號', '證券名稱', '外資買進股數', '外資賣出股數', '外資買賣超股數',
  '投信買進股數', '投信賣出股數', '投信買賣超股數', '自營商買賣超股數',
  '自營商買進股數', '自營商賣出股數', '三大法人買賣超股數',
];
const T86_B_FIELDS = [
  '證券代號', '證券名稱', '外資買進股數', '外資賣出股數', '外資買賣超股數',
  '投信買進股數', '投信賣出股數', '投信買賣超股數', '自營商買賣超股數',
  '自營商買進股數(自行買賣)', '自營商賣出股數(自行買賣)', '自營商買賣超股數(自行買賣)',
  '自營商買進股數(避險)', '自營商賣出股數(避險)', '自營商買賣超股數(避險)',
  '三大法人買賣超股數',
];
const T86_A_ROW = [
  '2330', '台積電          ', '26,129,290', '30,119,500', '-3,990,210', '402,000',
  '573,000', '-171,000', '168,000', '1,152,000', '984,000', '-3,993,210',
];
const T86_B_ROW = [
  '2330', '台積電          ', '14,505,000', '8,718,208', '5,786,792', '46,000',
  '215,000', '-169,000', '-1,663,000', '75,000', '516,000', '-441,000', '145,000',
  '1,367,000', '-1,222,000', '3,954,792',
];
const SBL_FIELDS = [
  '代號', '名稱', '前日餘額', '賣出', '買進', '現券', '今日餘額', '次一營業日限額',
  '前日餘額', '賣出', '庫存異動', '今日餘額', '可使用額度', '備註',
];
const SBL_ROW = [
  '2330', '台積電', '1,747,000', '152,000', '915,000', '6,000', '978,000',
  '6,407,487,678', '57,589,000', '300,000', '0', '57,889,000', '768,898,521', ' ',
];
const TPEX_FIELDS = [
  '代號', '名稱', '外資及陸資買股數', '外資及陸資賣股數', '外資及陸資淨買股數',
  '投信買進股數', '投信賣股數', '投信淨買股數', '自營淨買股數',
  '自營商(自行買賣)買股數', '自營商(自行買賣)賣股數', '自營商(自行買賣)淨買股數',
  '自營商(避險)買股數', '自營商(避險)賣股數', '自營商(避險)淨買股數',
  '三大法人買賣超股數',
];
const TPEX_ROW = [
  '5483', '中美晶', '2,238,000', '287,000', '1,951,000', '0', '0', '0', '442,000',
  '0', '0', '0', '575,000', '133,000', '442,000', '2,393,000',
];

function t86Fixture(fields = T86_A_FIELDS, row = T86_A_ROW) {
  return { stat: 'OK', date: '20130709', fields, data: [row] };
}

function sblFixture(fields = SBL_FIELDS) {
  return {
    stat: 'OK',
    date: '20080707',
    fields,
    groups: [
      { title: '股票', span: 2 },
      { title: '融券', span: 6 },
      { title: '借券賣出', span: 5 },
      { title: '', span: 1 },
    ],
    data: [SBL_ROW],
  };
}

function tpexFixture(fields = TPEX_FIELDS) {
  return {
    stat: 'ok',
    date: '20160707',
    tables: [{}, { title: '三大法人買賣明細資訊', fields, data: [TPEX_ROW] }],
  };
}

function jsonBytes(value) {
  return Buffer.from(` ${JSON.stringify(value)}\r\n`);
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-promote-quarantine-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeQuarantine(root, dataset, iso, bytes) {
  const path = join(root, 'data/history-backfill/quarantine', dataset, iso.slice(0, 4), `${iso}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function fileExists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function runCli(root, ...args) {
  return spawnSync(process.execPath, [CLI_PATH, '--out', root, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

test('legacy T86 A and B fixtures map institution values exactly', () => {
  assert.deepEqual(parseTwseT86Hist(t86Fixture())[0], {
    id: '2330', name: '台積電', fi: -3993210, ff: -3990210, ft: -171000, fd: 168000,
  });
  assert.deepEqual(parseTwseT86Hist({
    stat: 'OK', date: '20160707', fields: T86_B_FIELDS, data: [T86_B_ROW],
  })[0], {
    id: '2330', name: '台積電', fi: 3954792, ff: 5786792, ft: -169000, fd: -1663000,
  });
});

test('legacy TWT93U fixture selects index 11 and keeps the response-date guard', () => {
  assert.deepEqual(parseTwseSblHist(sblFixture(), '20080707'), [{
    SecuritiesCompanyCode: '2330',
    CompanyName: '台積電',
    SecuritiesBorrowingBalanceOfTheMarketDay: '57,889,000',
  }]);
  assert.throws(() => parseTwseSblHist(sblFixture(), '20080708'), /does not match 20080708/);
});

test('legacy TPEX institution fixture maps total and three institution values', () => {
  assert.deepEqual(parseTpexInstiHist(tpexFixture())[0], {
    SecuritiesCompanyCode: '5483',
    CompanyName: '中美晶',
    TotalDifference: 2393000,
    'ForeignInvestorsIncludeMainlandAreaInvestors-Difference': 1951000,
    'SecuritiesInvestmentTrustCompanies-Difference': 0,
    'Dealers-Difference': 442000,
  });
});

test('each legacy parser rejects a one-character field drift and wrong row width', () => {
  const t86Fields = [...T86_A_FIELDS];
  t86Fields[4] = '外資買賣超股數改';
  assert.throws(() => parseTwseT86Hist(t86Fixture(t86Fields)), /missing field/);
  const sblFields = [...SBL_FIELDS];
  sblFields[11] = '今日餘額改';
  assert.throws(() => parseTwseSblHist(sblFixture(sblFields), '20080707'), /fields length must be 15/);
  const tpexFields = [...TPEX_FIELDS];
  tpexFields[15] = '三大法人買賣超股數改';
  assert.throws(() => parseTpexInstiHist(tpexFixture(tpexFields)), /tables\[0\] is invalid/);

  assert.throws(() => parseTwseT86Hist({ ...t86Fixture(), data: [T86_A_ROW.slice(0, -1)] }), /width must be 12/);
  assert.throws(() => parseTwseSblHist({ ...sblFixture(), data: [SBL_ROW.slice(0, -1)] }, '20080707'), /width must be 14/);
  assert.throws(() => parseTpexInstiHist({ ...tpexFixture(), tables: [{}, { ...tpexFixture().tables[1], data: [TPEX_ROW.slice(0, -1)] }] }), /width must be 16/);
});

test('promotion CLI copies exact bytes, preserves quarantine, and then skips identical raw', async () => {
  await withTempDir(async (root) => {
    const bytes = jsonBytes(t86Fixture());
    const quarantine = await writeQuarantine(root, 'twse/t86_hist', '2013-07-09', bytes);
    const raw = join(root, 'data/raw/twse/t86_hist/2013/2013-07-09.json');
    const first = runCli(root, '--dataset', 'twse/t86_hist');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /copied=1 identical=0 validation_failed=0 conflicts=0/);
    assert.deepEqual(await readFile(raw), bytes);
    assert.deepEqual(await readFile(quarantine), bytes);
    const second = runCli(root, '--dataset', 'twse/t86_hist');
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /copied=0 identical=1 validation_failed=0 conflicts=0/);
  });
});

test('promotion CLI never overwrites conflicting raw and exits non-zero', async () => {
  await withTempDir(async (root) => {
    await writeQuarantine(root, 'twse/t86_hist', '2013-07-09', jsonBytes(t86Fixture()));
    const raw = join(root, 'data/raw/twse/t86_hist/2013/2013-07-09.json');
    const existing = Buffer.from('different raw bytes\n');
    await mkdir(dirname(raw), { recursive: true });
    await writeFile(raw, existing);
    const result = runCli(root, '--dataset', 'twse/t86_hist');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /conflicts=1/);
    assert.deepEqual(await readFile(raw), existing);
  });
});

test('promotion CLI rejects invalid quarantine and dry-run writes no raw', async () => {
  await withTempDir(async (root) => {
    const drifted = [...T86_A_FIELDS];
    drifted[4] = '漂移';
    await writeQuarantine(root, 'twse/t86_hist', '2013-07-09', jsonBytes(t86Fixture(drifted)));
    const invalid = runCli(root, '--dataset', 'twse/t86_hist');
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.match(invalid.stdout, /validation_failed=1/);
    assert.equal(await fileExists(join(root, 'data/raw/twse/t86_hist/2013/2013-07-09.json')), false);
  });
  await withTempDir(async (root) => {
    await writeQuarantine(root, 'twse/t86_hist', '2013-07-09', jsonBytes(t86Fixture()));
    const result = runCli(root, '--dataset', 'twse/t86_hist', '--dry-run');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /copied=1.*dry_run=true/);
    assert.equal(await fileExists(join(root, 'data/raw/twse/t86_hist/2013/2013-07-09.json')), false);
  });
});

test('promotion CLI refuses a history runner lock held by a live pid', async () => {
  await withTempDir(async (root) => {
    const lock = join(root, 'data/history-backfill/.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    const result = runCli(root, '--dataset', 'twse/t86_hist');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /lock held by live pid/);
    assert.equal(await fileExists(lock), true);
  });
});
