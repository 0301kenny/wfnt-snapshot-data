import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyDailyDate,
  applySectorIndexDate,
  parseTwseSectorIndexes,
  parseTwseSectorIndexesHist,
} from '../scripts/lib/derived.mjs';
import { rebuildSectorIndex } from '../scripts/rebuild-sector-index.mjs';

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-sector-index-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(root, dataset, date, value) {
  const dir = join(root, 'data', 'raw', dataset, date.slice(0, 4));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${date}.json`), JSON.stringify(value));
}

function hist(rows, fields = ['指數', '收盤指數']) {
  const tables = Array(9).fill(null);
  tables[0] = { title: '價格指數(臺灣證券交易所)', fields, data: rows };
  tables[8] = {
    title: '每日收盤行情',
    fields: ['證券代號', '證券名稱', '成交股數', '成交筆數', '開盤價', '最高價', '最低價', '收盤價'],
    data: [],
  };
  return { stat: 'OK', tables };
}

test('sector OpenAPI parser keeps only names ending in 類指數 and valid numeric closes', () => {
  assert.deepEqual(parseTwseSectorIndexes([
    { '指數': '半導體類指數', '收盤指數': '1,614.47' },
    { '指數': '發行量加權股價指數', '收盤指數': '20,000' },
    { '指數': '半導體類報酬指數', '收盤指數': '2' },
    { '指數': '臺灣50指數', '收盤指數': '3' },
    { '指數': '食品類指數', '收盤指數': '--' },
  ]), [['半導體類指數', 1614.47]]);
});

test('sector historical parser locates reordered fields and filters non-sector rows', () => {
  assert.deepEqual(parseTwseSectorIndexesHist(hist([
    ['1,234.5', '水泥類指數'],
    ['20,000', '加權股價指數'],
  ], ['收盤指數', '指數'])), [['水泥類指數', 1234.5]]);
});

test('daily sector derivation prefers OpenAPI and historical raw fills absent dates', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, 'twse/mi_index', '2026-07-16', [
      { '指數': '半導體類指數', '收盤指數': '1,614.47' },
    ]);
    await writeJson(root, 'twse/mi_index_hist', '2026-07-16', hist([['半導體類指數', '999']]));
    await writeJson(root, 'twse/mi_index_hist', '2026-07-15', hist([['半導體類指數', '1,600']]));
    await applySectorIndexDate(root, '2026-07-15');
    await applyDailyDate(root, '2026-07-16');
    const output = JSON.parse(await readFile(join(root, 'data', 'derived', 'sector_index.json')));
    assert.deepEqual(output, {
      updated: '2026-07-16',
      names: ['半導體類指數'],
      series: { '半導體類指數': { cols: ['d', 'c'], rows: [[20260715, 1600], [20260716, 1614.47]] } },
    });
  });
});

test('sector rerun is byte-stable, revision replaces the date, and an empty table changes nothing', async () => {
  await withTempRoot(async (root) => {
    const path = join(root, 'data', 'derived', 'sector_index.json');
    await writeJson(root, 'twse/mi_index', '2026-07-16', [{ '指數': '水泥類指數', '收盤指數': '100' }]);
    await applySectorIndexDate(root, '2026-07-16');
    const first = await readFile(path);
    await applySectorIndexDate(root, '2026-07-16');
    assert.deepEqual(await readFile(path), first);
    await writeJson(root, 'twse/mi_index', '2026-07-16', [{ '指數': '水泥類指數', '收盤指數': '101' }]);
    await applySectorIndexDate(root, '2026-07-16');
    assert.deepEqual(JSON.parse(await readFile(path)).series['水泥類指數'].rows, [[20260716, 101]]);
    const revised = await readFile(path);
    await writeJson(root, 'twse/mi_index_hist', '2006-10-16', hist([]));
    await applySectorIndexDate(root, '2006-10-16');
    assert.deepEqual(await readFile(path), revised);
  });
});

test('sector-only rebuild matches incremental bytes and preserves every other derived file', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, 'twse/mi_index', '2026-07-16', [{ '指數': '食品類指數', '收盤指數': '2' }]);
    await writeJson(root, 'twse/mi_index_hist', '2026-07-15', hist([['水泥類指數', '1']]));
    await applySectorIndexDate(root, '2026-07-15');
    await applySectorIndexDate(root, '2026-07-16');
    const expected = await readFile(join(root, 'data', 'derived', 'sector_index.json'));
    const other = join(root, 'data', 'derived', 'keep.json');
    await writeFile(other, '{"keep":true}\n');
    const beforeStat = await stat(other);
    const beforeBytes = await readFile(other);
    await rebuildSectorIndex({ rootDir: root });
    assert.deepEqual(await readFile(join(root, 'data', 'derived', 'sector_index.json')), expected);
    assert.deepEqual(await readFile(other), beforeBytes);
    assert.equal((await stat(other)).mtimeMs, beforeStat.mtimeMs);
  });
});
