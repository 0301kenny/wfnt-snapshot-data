import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runSnapshot } from '../scripts/run.mjs';
import {
  SCREENER_COLS,
  applyScreenerIndex,
  buildScreenerIndex,
} from '../scripts/lib/screener-index.mjs';

const execFileAsync = promisify(execFile);
const SYMBOL_COLS = ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd', 'sb', 'ss'];
const TDCC_COLS = ['w', 'big1000', 'big400', 'retail', 'holders', 'avgShares', 'holders50'];

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-screener-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function row(overrides = {}) {
  const values = {
    d: 20261013, o: 10, h: 12, l: 9, c: 11, v: 12000, t: 1,
    mb: 20, ms: 3, fi: 0, ff: 1000, ft: -1000, fd: 500, sb: 0, ss: 0,
    ...overrides,
  };
  return SYMBOL_COLS.map((column) => values[column]);
}

async function writeSymbol(root, id, rows, { name = `name-${id}`, market = 'twse' } = {}) {
  const dir = join(root, 'data', 'derived', 'symbols', id.slice(0, 2));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify({
    id, name, market, updated: '2026-10-13', cols: SYMBOL_COLS, rows,
  }));
}

async function writeTdcc(root, id, rows) {
  const dir = join(root, 'data', 'derived', 'tdcc', id.slice(0, 2));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify({
    id, updated: '2026-10-10', cols: TDCC_COLS, rows,
  }));
}

function record(index, id) {
  const values = index.rows.find((candidate) => candidate[0] === id);
  return Object.fromEntries(index.cols.map((column, offset) => [column, values[offset]]));
}

test('includes stocks and ETFs, excludes other ids, skips .DS_Store, and sorts rows', async () => {
  await withTempDir(async (root) => {
    for (const id of ['2330', '0050', '00878', '00632R', '030001', '02001L', '2002A']) {
      await writeSymbol(root, id, [row({ d: id === '2330' ? 20261012 : 20261013 })]);
    }
    await writeFile(join(root, 'data', 'derived', 'symbols', '.DS_Store'), 'noise');
    await writeFile(join(root, 'data', 'derived', 'symbols', '23', '.DS_Store'), 'noise');
    const index = await buildScreenerIndex(root);
    assert.deepEqual(index.rows.map((item) => item[0]), ['0050', '00632R', '00878', '2330']);
    assert.deepEqual(index.rows.map((item) => item[3]), ['etf', 'etf', 'etf', 'stock']);
    assert.equal(index.updated, '2026-10-13');
    assert.deepEqual(index.cols, SCREENER_COLS);
  });
});

test('computes price and volume windows with volAvg20 excluding latest row', async () => {
  await withTempDir(async (root) => {
    const rows = Array.from({ length: 61 }, (_, offset) => {
      const value = offset + 1;
      return row({ d: 20260800 + value, c: value, h: value + 2, l: value - 2, v: value * 1000 });
    });
    await writeSymbol(root, '2330', rows);
    const item = record(await buildScreenerIndex(root), '2330');
    assert.deepEqual(
      [item.close, item.chgPct, item.volume, item.volAvg20, item.ma20, item.ma60, item.high60, item.low60],
      [61, 1.67, 61, 50.5, 51.5, 31.5, 63, 0],
    );
  });
});

test('returns null for unavailable rolling windows while keeping chgPct', async () => {
  await withTempDir(async (root) => {
    await writeSymbol(root, '2330', [row({ c: 10 }), row({ c: 12 }), row({ c: 15 })]);
    const item = record(await buildScreenerIndex(root), '2330');
    assert.equal(item.chgPct, 25);
    assert.deepEqual(
      [item.volAvg20, item.ma20, item.ma60, item.high60, item.low60, item.marginChg5],
      [null, null, null, null, null, null],
    );
  });
});

test('converts institutional flows and counts positive and negative streaks', async () => {
  await withTempDir(async (root) => {
    await writeSymbol(root, '2330', [
      row({ ff: -1, ft: 5 }), row({ ff: 1000, ft: -4 }), row({ ff: 2000, ft: -3 }), row({ ff: 2600, ft: -2 }),
    ]);
    const item = record(await buildScreenerIndex(root), '2330');
    assert.deepEqual(
      [item.foreignNet, item.trustNet, item.dealerNet, item.foreignStreak, item.trustStreak],
      [3, -0, 1, 3, -3],
    );
  });
});

test('institutional streak stops at zero or null and is zero when latest is zero', async () => {
  await withTempDir(async (root) => {
    await writeSymbol(root, '2303', [row({ ff: 1 }), row({ ff: 0 }), row({ ff: 2 })]);
    await writeSymbol(root, '2317', [row({ ff: 1 }), row({ ff: null }), row({ ff: 2 })]);
    await writeSymbol(root, '2412', [row({ ff: 1 }), row({ ff: 0 })]);
    const index = await buildScreenerIndex(root);
    assert.equal(record(index, '2303').foreignStreak, 1);
    assert.equal(record(index, '2317').foreignStreak, 1);
    assert.equal(record(index, '2412').foreignStreak, 0);
  });
});

test('computes margin balances and five-row change', async () => {
  await withTempDir(async (root) => {
    await writeSymbol(root, '2330', [10, 20, 30, 40, 50, 75].map((mb) => row({ mb, ms: mb / 5 })));
    const item = record(await buildScreenerIndex(root), '2330');
    assert.deepEqual([item.marginBalance, item.marginChg5, item.shortBalance], [75, 65, 15]);
  });
});

test('joins latest TDCC values and computes four-week changes', async () => {
  await withTempDir(async (root) => {
    await writeSymbol(root, '2330', [row()]);
    await writeTdcc(root, '2330', [
      [20260912, 10.11, 20, 8.88, 1, 1, 1],
      [20260919, 11, 20, 8, 1, 1, 1],
      [20260926, 12, 20, 7, 1, 1, 1],
      [20261003, 13, 20, 6, 1, 1, 1],
      [20261010, 14.56, 20, 5.43, 1, 1, 1],
    ]);
    const item = record(await buildScreenerIndex(root), '2330');
    assert.deepEqual(
      [item.big1000, item.big1000Chg4w, item.retail, item.retailChg4w, item.tdccWeek],
      [14.56, 4.45, 5.43, -3.45, '2026-10-10'],
    );
  });
});

test('uses null TDCC fields when missing and null changes with only three weeks', async () => {
  await withTempDir(async (root) => {
    await writeSymbol(root, '2330', [row()]);
    await writeSymbol(root, '2317', [row()]);
    await writeTdcc(root, '2317', [
      [20260926, 10, 20, 8, 1, 1, 1],
      [20261003, 11, 20, 7, 1, 1, 1],
      [20261010, 12, 20, 6, 1, 1, 1],
    ]);
    const index = await buildScreenerIndex(root);
    assert.deepEqual(
      ['big1000', 'retail', 'big1000Chg4w', 'retailChg4w', 'tdccWeek'].map((key) => record(index, '2330')[key]),
      [null, null, null, null, null],
    );
    assert.deepEqual(
      [record(index, '2317').big1000Chg4w, record(index, '2317').retailChg4w],
      [null, null],
    );
  });
});

test('writes compact JSON and preserves mtime when content is unchanged', async () => {
  await withTempDir(async (root) => {
    await writeSymbol(root, '2330', [row()]);
    assert.deepEqual(await applyScreenerIndex(root), { rows: 1, written: true });
    const path = join(root, 'data', 'index', 'screener.json');
    const content = await readFile(path, 'utf8');
    const before = (await stat(path)).mtimeMs;
    assert.equal(content.includes('\n  '), false);
    assert.equal(content.endsWith('\n'), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await applyScreenerIndex(root), { rows: 1, written: false });
    assert.equal((await stat(path)).mtimeMs, before);
  });
});

test('CLI writes an index under --out', async () => {
  await withTempDir(async (root) => {
    await writeSymbol(root, '2330', [row()]);
    const { stdout } = await execFileAsync(process.execPath, ['scripts/build-screener-index.mjs', '--out', root], {
      cwd: process.cwd(),
    });
    assert.match(stdout, /screener index: rows=1 file=write/);
    assert.equal(JSON.parse(await readFile(join(root, 'data', 'index', 'screener.json'))).rows.length, 1);
  });
});

test('CLI rejects unknown arguments', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/build-screener-index.mjs', '--wat'], { cwd: process.cwd() }),
    (error) => error.code === 1 && /unknown argument: --wat/.test(error.stderr),
  );
});

const STOCK_DAY_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const MI_INDEX_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX';

function stockDayFetcher() {
  const stockBody = Buffer.from(JSON.stringify([{
    Date: '1151013', Code: '2330', Name: '台積電', TradeVolume: '1000', TradeValue: '1',
    OpeningPrice: '10', HighestPrice: '12', LowestPrice: '9', ClosingPrice: '11', Change: '+1', Transaction: '1',
  }]));
  return async (url) => {
    assert.ok([STOCK_DAY_URL, MI_INDEX_URL].includes(url));
    const body = url === STOCK_DAY_URL
      ? stockBody
      : Buffer.from(JSON.stringify([{ '日期': '1151013', '指數': '寶島股價指數', '收盤指數': '1' }]));
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      },
    };
  };
}

async function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    return { value: await fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('runSnapshot writes and logs the index after a daily derived apply', async () => {
  await withTempDir(async (root) => {
    const result = await captureConsole(() => runSnapshot({
      rootDir: root,
      fetcher: stockDayFetcher(),
      datasets: ['twse_mi_index', 'twse_stock_day_all'],
      now: () => new Date('2026-10-13T14:00:00Z'),
    }));
    assert.equal(result.value.exitCode, 0);
    assert.ok(result.logs.some((line) => line.includes('[derived] screener index: rows=1 file=write')));
    assert.equal(JSON.parse(await readFile(join(root, 'data', 'index', 'screener.json'))).rows.length, 1);
    const manifest = JSON.parse(await readFile(join(root, 'data', 'manifest.json')));
    assert.equal(manifest.paths.screenerIndex, 'data/index/screener.json');
  });
});

test('runSnapshot isolates screener write errors and preserves other derived output', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'index'), 'blocks directory creation');
    const result = await captureConsole(() => runSnapshot({
      rootDir: root,
      fetcher: stockDayFetcher(),
      datasets: ['twse_mi_index', 'twse_stock_day_all'],
      now: () => new Date('2026-10-13T14:00:00Z'),
    }));
    assert.equal(result.value.exitCode, 0);
    assert.ok(result.errors.some((line) => line.includes('[error] derived screener index:')));
    assert.equal(JSON.parse(await readFile(join(root, 'data', 'derived', 'symbols', '23', '2330.json'))).id, '2330');
    assert.equal(JSON.parse(await readFile(join(root, 'data', 'manifest.json'))).paths.screenerIndex, 'data/index/screener.json');
  });
});
