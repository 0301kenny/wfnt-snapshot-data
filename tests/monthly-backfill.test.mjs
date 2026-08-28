import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMonthlyBackfill } from '../scripts/backfill-monthly.mjs';
import { buildDerived } from '../scripts/build-derived.mjs';
import {
  parseMopsMonthlyRevenue,
  validateMopsMonthlyRevenueHtml,
} from '../scripts/lib/derived.mjs';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const officialFixturePath = join(fixtureDir, 'mops-monthly-revenue-otc-112-08.fragment.html');
const shellFixturePath = join(fixtureDir, 'mops-monthly-revenue-empty-shell.html');
const silentLogger = { log() {}, warn() {} };

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-monthly-backfill-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

async function writeRaw(root, sourceDataset, monthKey, suffix, bytes) {
  const path = join(root, 'data', 'raw', sourceDataset, monthKey.slice(0, 4), `${monthKey}${suffix}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function listFiles(dir, base = dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, base));
    else if (entry.isFile()) files.push(path.slice(base.length + 1));
  }
  return files;
}

test('MOPS parser maps all 11 columns from an exact official big5 response fragment', async () => {
  // Exact bytes 0..57394 from the 2026-08-28 response at:
  // https://mopsov.twse.com.tw/nas/t21/otc/t21sc03_112_8_0.html
  const bytes = await readFile(officialFixturePath);
  const rows = parseMopsMonthlyRevenue(bytes, '11208');
  assert.equal(rows.length, 118);
  assert.deepEqual(rows.find((row) => row['公司代號'] === '1264'), {
    '公司代號': '1264',
    '公司名稱': '德麥',
    '營業收入-當月營收': 512933,
    '營業收入-上月營收': 451975,
    '營業收入-去年當月營收': 456315,
    '營業收入-上月比較增減(%)': 13.48,
    '營業收入-去年同月增減(%)': 12.4,
    '累計營業收入-當月累計營收': 3669920,
    '累計營業收入-去年累計營收': 3311228,
    '累計營業收入-前期比較增減(%)': 10.83,
    '備註': '-',
    '資料年月': '11208',
  });
  const blank = rows.find((row) => row['公司代號'] === '4168');
  assert.equal(blank['公司名稱'], '醣聯');
  assert.equal(blank['營業收入-上月比較增減(%)'], null);
  assert.equal(blank['營業收入-去年同月增減(%)'], 171.42);
  assert.equal(blank['累計營業收入-前期比較增減(%)'], -94.06);
  assert.ok(rows.every((row) => /^\d{4}$/.test(row['公司代號'])));
  assert.equal(validateMopsMonthlyRevenueHtml(bytes, '11208').length, 118);
});

test('same official row proves case-sensitive td matching silently shifts columns', async () => {
  const bytes = await readFile(officialFixturePath);
  const productionRow = parseMopsMonthlyRevenue(bytes, '11208')
    .find((row) => row['公司代號'] === '1264');
  assert.ok(productionRow);
  assert.equal(productionRow['營業收入-去年同月增減(%)'], 12.4);
  assert.notEqual(productionRow['營業收入-去年同月增減(%)'], 3669920);

  const html = new TextDecoder('big5').decode(bytes);
  const rowHtml = html.match(/<tr\b[^>]*><td[^>]*>\s*1264\s*<\/td>[\s\S]*?<\/tr>/i)?.[0];
  assert.ok(rowHtml);
  const cells = (flags) => [...rowHtml.matchAll(new RegExp('<td\\b[^>]*>([\\s\\S]*?)<\\/td>', flags))]
    .map((match) => match[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim());
  const insensitive = cells('gi');
  const sensitive = cells('g');
  assert.equal(insensitive.length, 11);
  assert.equal(insensitive[6], '12.40');
  assert.equal(sensitive.length, 10);
  assert.equal(sensitive[6], '3,669,920');
  assert.equal(sensitive[9], '-');
  assert.equal(Number.isNaN(Number(sensitive[9])), true);
});

test('monthly backfill preserves four official bodies and existing files are checkpoints', async () => {
  await withTempDir(async (root) => {
    const bytes = await readFile(officialFixturePath);
    const calls = [];
    const first = await runMonthlyBackfill({
      rootDir: root,
      fromMonth: '2023-08',
      toMonth: '2023-08',
      delayMs: 0,
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        calls.push(url);
        return responseFor(bytes);
      },
      logger: silentLogger,
    });
    assert.deepEqual(first, { months: 1, requests: 4, skipped: 0, rawWritten: 4, rows: 472 });
    assert.equal(calls.length, 4);
    const rawDir = join(root, 'data', 'raw');
    assert.deepEqual(await listFiles(rawDir), [
      'tpex/monthly_revenue_hist/2023/2023-08_0.html',
      'tpex/monthly_revenue_hist/2023/2023-08_1.html',
      'twse/monthly_revenue_hist/2023/2023-08_0.html',
      'twse/monthly_revenue_hist/2023/2023-08_1.html',
    ]);
    for (const path of await listFiles(rawDir)) {
      assert.deepEqual(await readFile(join(rawDir, path)), bytes);
    }

    const second = await runMonthlyBackfill({
      rootDir: root,
      fromMonth: '2023-08',
      toMonth: '2023-08',
      delayMs: 0,
      sleepImpl: async () => {},
      fetchImpl: async () => assert.fail('checkpoint should prevent fetch'),
      logger: silentLogger,
    });
    assert.deepEqual(second, { months: 1, requests: 0, skipped: 4, rawWritten: 0, rows: 0 });
  });
});

test('the frozen 800-byte wrong-domain shell is rejected before any raw write', async () => {
  await withTempDir(async (root) => {
    // Exact 2026-08-28 response from mops.twse.com.tw (without "ov").
    const shell = await readFile(shellFixturePath);
    assert.equal(shell.length, 800);
    await assert.rejects(
      runMonthlyBackfill({
        rootDir: root,
        fromMonth: '2023-08',
        toMonth: '2023-08',
        delayMs: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => responseFor(shell),
        logger: silentLogger,
      }),
      /response too short \(800 bytes\)/,
    );
    assert.deepEqual(await listFiles(join(root, 'data', 'raw')), []);
  });
});

test('full build discovers MOPS html months with openapi priority and hist fallback', async () => {
  await withTempDir(async (root) => {
    const bytes = await readFile(officialFixturePath);
    await writeRaw(root, 'twse/monthly_revenue_hist', '2023-08', '_0.html', bytes);
    const openApiPath = await writeRaw(
      root,
      'twse/monthly_revenue',
      '2023-08',
      '.json',
      Buffer.from(JSON.stringify([{
        '資料年月': '11208',
        '公司代號': '1264',
        '公司名稱': 'openapi 德麥',
        '營業收入-當月營收': '999',
        '營業收入-去年同月增減(%)': '88',
        '營業收入-上月比較增減(%)': '77',
      }])),
    );

    const preferred = await buildDerived({ rootDir: root });
    assert.equal(preferred.monthlyMonths, 1);
    let derived = JSON.parse(await readFile(join(root, 'data', 'derived', 'fundamentals', '12', '1264.json'), 'utf8'));
    assert.equal(derived.name, 'openapi 德麥');
    assert.deepEqual(derived.revenue.rows, [[202308, 999, 88, 77]]);

    await unlink(openApiPath);
    const fallback = await buildDerived({ rootDir: root });
    assert.equal(fallback.monthlyMonths, 1);
    derived = JSON.parse(await readFile(join(root, 'data', 'derived', 'fundamentals', '12', '1264.json'), 'utf8'));
    assert.equal(derived.name, '德麥');
    assert.deepEqual(derived.revenue.rows, [[202308, 512933, 12.4, 13.48]]);
  });
});
