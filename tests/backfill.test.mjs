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
        fields: ['融券今日餘額', '股票名稱', '融資今日餘額', '股票代號'],
        data: [['120', name, '9,577', code]],
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

function responseFor(bytes, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
  };
}

function fixtureFetcher({ calls = [], fail } = {}) {
  const bodies = {
    MI_INDEX: jsonBytes(miIndexFixture()),
    T86: jsonBytes(t86Fixture()),
    MI_MARGN: jsonBytes(miMargnFixture()),
  };
  return async (url) => {
    calls.push(url);
    if (fail?.(url)) throw new Error('fixture interruption');
    if (url.includes('/MI_INDEX?')) return responseFor(bodies.MI_INDEX);
    if (url.includes('/fund/T86?')) return responseFor(bodies.T86);
    if (url.includes('/MI_MARGN?')) return responseFor(bodies.MI_MARGN);
    throw new Error(`unexpected URL: ${url}`);
  };
}

test('backfill endpoints remain separate from the unchanged daily endpoint list', () => {
  assert.equal(ENDPOINTS.length, 11);
  assert.deepEqual(Object.keys(BACKFILL_ENDPOINTS), [
    'twse_mi_index_hist',
    'twse_t86_hist',
    'twse_mi_margn_hist',
  ]);
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

test('hist replay fills the thirteen-column TWSE row when openapi raw is absent', async () => {
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
        fail: (url) => url.includes('/fund/T86?') && url.includes('date=20260707'),
      }),
      sleepImpl: async () => {},
      logger: silentLogger,
      now: () => new Date('2026-07-19T00:00:00Z'),
    }), /2026-07-07 twse\/t86_hist: fixture interruption/);
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
    assert.equal((await readJson(root, '.backfill-progress.json')).lastDate, '2026-07-07');
  });
});

test('existing openapi TWSE raw skips MI_INDEX and MI_MARGN fetches but still fetches T86', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse/stock_day_all', '2026-07-06', jsonBytes([{
      Code: '2330', Name: '台積電', OpeningPrice: '10', HighestPrice: '11', LowestPrice: '9', ClosingPrice: '10.5', TradeVolume: '100', Transaction: '20',
    }]));
    await writeRaw(root, 'twse/mi_margn', '2026-07-06', jsonBytes([{
      '股票代號': '2330', '股票名稱': '台積電', '融資今日餘額': '30', '融券今日餘額': '40',
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
    assert.equal(calls.length, 1);
    assert.deepEqual(await readFile(join(root, 'data/raw/twse/t86_hist/2026/2026-07-06.json')), t86Bytes);
    const symbol = await readJson(root, 'data/derived/symbols/23/2330.json');
    assert.deepEqual(symbol.rows[0], [20260706, 10, 11, 9, 10.5, 100, 20, 30, 40, 9999, 1200, 400, 300]);
  });
});
