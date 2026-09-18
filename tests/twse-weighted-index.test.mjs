import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDailyDate,
  parseTwseWeightedIndex,
  parseTwseWeightedIndexHist,
} from '../scripts/lib/derived.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function weightedIndexHistFixture({
  close = '17,789.25',
  fields = ['指數', '收盤指數', '漲跌(+/-)', '漲跌點數'],
} = {}) {
  const cells = {
    '指數': '發行量加權股價指數',
    '收盤指數': close,
    '漲跌(+/-)': '+',
    '漲跌點數': '1.00',
  };
  return {
    stat: 'OK',
    tables: [{
      title: '價格指數(臺灣證券交易所)',
      fields,
      data: [fields.map((field) => cells[field] ?? '')],
    }],
  };
}

async function writeJsonRaw(root, sourceDataset, date, value) {
  const path = join(root, 'data', 'raw', sourceDataset, date.slice(0, 4), `${date}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-weighted-index-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rawDates(sourceDataset) {
  const base = join(repoRoot, 'data', 'raw', sourceDataset);
  const dates = new Set();
  for (const year of await readdir(base, { withFileTypes: true })) {
    if (!year.isDirectory()) continue;
    for (const file of await readdir(join(base, year.name), { withFileTypes: true })) {
      if (file.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(file.name)) {
        dates.add(file.name.slice(0, -5));
      }
    }
  }
  return dates;
}

async function readRaw(sourceDataset, date) {
  const path = join(repoRoot, 'data', 'raw', sourceDataset, date.slice(0, 4), `${date}.json`);
  return JSON.parse(await readFile(path, 'utf8'));
}

test('TWSE weighted index parsers handle daily and reordered historical shapes', (t) => {
  const daily = [
    { '指數': '寶島股價指數', '收盤指數': '1' },
    { '指數': '發行量加權股價指數', '收盤指數': '46,940.49' },
  ];
  const dailyValue = parseTwseWeightedIndex(daily);
  assert.equal(dailyValue, 46940.49);

  const historical = weightedIndexHistFixture({
    fields: ['漲跌點數', '收盤指數', '指數', '漲跌(+/-)'],
  });
  const historicalValue = parseTwseWeightedIndexHist(historical);
  t.diagnostic(`daily=${dailyValue}; historicalReordered=${historicalValue}`);
  assert.equal(historicalValue, 17789.25);
});

test('TWSE weighted index parsers agree on both available overlapping raw dates', async (t) => {
  for (const date of ['2026-08-14', '2026-08-17']) {
    const dailyValue = parseTwseWeightedIndex(await readRaw('twse/mi_index', date));
    const historicalValue = parseTwseWeightedIndexHist(await readRaw('twse/mi_index_hist', date));
    t.diagnostic(`${date}: daily=${dailyValue} hist=${historicalValue}`);
    assert.equal(dailyValue, historicalValue);
  }
});

test('merged TWSE weighted index raw dates match the margin date oracle', async (t) => {
  const dailyDates = await rawDates('twse/mi_index');
  const historicalDates = await rawDates('twse/mi_index_hist');
  const candidateDates = [...new Set([...dailyDates, ...historicalDates])].sort();
  const indexByDate = new Map();

  for (const date of candidateDates) {
    const value = dailyDates.has(date)
      ? parseTwseWeightedIndex(await readRaw('twse/mi_index', date))
      : parseTwseWeightedIndexHist(await readRaw('twse/mi_index_hist', date));
    assert.notEqual(value, null, `weighted index missing on ${date}`);
    indexByDate.set(Number(date.replaceAll('-', '')), value);
  }

  const market = JSON.parse(await readFile(join(repoRoot, 'data', 'derived', 'market.json'), 'utf8'));
  const indexDates = [...indexByDate.keys()].sort((a, b) => a - b);
  const marginDates = market.twse.margin.rows.map((row) => row[0]).sort((a, b) => a - b);
  const indexSet = new Set(indexDates);
  const marginSet = new Set(marginDates);
  const onlyInIndex = indexDates.filter((date) => !marginSet.has(date));
  const onlyInMargin = marginDates.filter((date) => !indexSet.has(date));

  t.diagnostic(`merged rows=${indexDates.length}`);
  t.diagnostic(`only in index=${onlyInIndex.length}; only in margin=${onlyInMargin.length}`);
  t.diagnostic(`20210719=${indexByDate.get(20210719)}`);
  assert.equal(indexDates.length, 1253);
  assert.deepEqual(onlyInIndex, []);
  assert.deepEqual(onlyInMargin, []);
  assert.equal(indexByDate.get(20210719), 17789.25);
});

test('applyDailyDate uses daily weighted index before historical fallback and is idempotent', async (t) => {
  await withTempDir(async (root) => {
    await writeJsonRaw(root, 'twse/stock_day_all', '2021-07-19', []);
    await writeJsonRaw(root, 'twse/mi_index_hist', '2021-07-19', weightedIndexHistFixture());
    await applyDailyDate(root, '2021-07-19');

    await writeJsonRaw(root, 'twse/stock_day_all', '2026-09-07', []);
    await writeJsonRaw(root, 'twse/mi_index', '2026-09-07', [
      { '指數': '發行量加權股價指數', '收盤指數': '20,000.50' },
    ]);
    await writeJsonRaw(root, 'twse/mi_index_hist', '2026-09-07', weightedIndexHistFixture({ close: '19,000.25' }));
    await applyDailyDate(root, '2026-09-07');

    const marketPath = join(root, 'data', 'derived', 'market.json');
    const market = JSON.parse(await readFile(marketPath, 'utf8'));
    t.diagnostic(`historicalFallback=${market.twse.index.rows[0][1]}; dailyPriority=${market.twse.index.rows[1][1]}`);
    assert.deepEqual(market.twse.index.rows, [
      [20210719, 17789.25],
      [20260907, 20000.5],
    ]);

    const before = await readFile(marketPath);
    await applyDailyDate(root, '2026-09-07');
    const after = await readFile(marketPath);
    t.diagnostic(`secondRunByteIdentical=${before.equals(after)}`);
    assert.deepEqual(after, before);
  });
});
