import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildDerived } from '../scripts/build-derived.mjs';
import {
  applyQuarterlyFinancials,
  parseMopsQuarterlyFinHtml,
  parseMopsQuarterlyFinTables,
} from '../scripts/lib/derived.mjs';
import { rebuildQuarterly } from '../scripts/rebuild-quarterly.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const GENERAL = ['公司代號', '公司名稱', '營業收入', '營業毛利（毛損）', '營業利益（損失）', '本期淨利（淨損）', '基本每股盈餘（元）'];
const BANK = ['公司代號', '公司名稱', '利息淨收益', '利息以外淨損益', '本期稅後淨利（淨損）', '基本每股盈餘（元）'];
const HOLDING = ['公司代號', '公司名稱', '淨收益', '本期稅後淨利（淨損）', '基本每股盈餘（元）'];
const SECURITIES = ['公司代號', '公司名稱', '收益', '支出及費用', '本期淨利（淨損）', '基本每股盈餘（元）'];
const INSURANCE_NEW = ['公司代號', '公司名稱', '保險服務結果', '本期淨利（淨損）', '基本每股盈餘'];
const INSURANCE_NO_EPS = ['公司代號', '公司名稱', '保險服務結果', '本期淨利（淨損）'];
const INSURANCE_OLD = ['公司代號', '公司名稱', '營業收入', '本期淨利（淨損）', '基本每股盈餘（元）'];
const OTHER = ['公司代號', '公司名稱', '收入', '支出', '本期淨利（淨損）', '基本每股盈餘（元）'];

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-quarterly-eps-test-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function table(header, rows) {
  const render = (tag, cells) => `<tr>${cells.map((cell) => `<${tag}>${cell}</${tag}>`).join('')}</tr>`;
  return `<table>${render('th', header)}${rows.map((row) => render('td', row)).join('')}</table>`;
}

function fixture(sections) {
  return Buffer.from(`<html><body>${sections.map(([header, rows]) => table(header, rows)).join('')}</body></html>`);
}

function quarterFixture(quarter, additions = []) {
  const q1 = quarter === 1;
  return fixture([
    [BANK, [
      ['2882', '國泰金', q1 ? '80' : '170', q1 ? '20' : '40', q1 ? '10' : '25', q1 ? '1' : '2.7'],
      ['2890', '永豐金', q1 ? '40' : '30', q1 ? '10' : '10', q1 ? '5' : '6', q1 ? '0.5' : '1.1'],
      ['2891', '中信金', '--', '10', '3', q1 ? '0.3' : '0.8'],
    ]],
    [GENERAL, [
      ['2330', '台積電', q1 ? '100' : '250', q1 ? '40' : '100', q1 ? '30' : '70', q1 ? '20' : '45', q1 ? '2' : '5'],
      ...additions,
    ]],
    [INSURANCE_NEW, [['2851', '中再保', '7', '2', q1 ? '0.4' : '0.9']]],
  ]);
}

async function writeRaw(root, market, seasonKey, bytes) {
  const path = join(root, 'data', 'raw', market, 'quarterly_fin_hist', seasonKey.slice(0, 4), `${seasonKey}.html`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readFundamental(root, id) {
  return readJson(join(root, 'data', 'derived', 'fundamentals', id.slice(0, 2), `${id}.json`));
}

async function readEps(root) {
  return readJson(join(root, 'data', 'derived', 'quarterly_eps.json'));
}

test('all six quarterly table kinds use their specified revenue columns', () => {
  const rows = parseMopsQuarterlyFinTables(fixture([
    [GENERAL, [['1001', '一般', '100', '40', '30', '20', '2']]],
    [BANK, [['1002', '銀行', '80', '20', '10', '1']]],
    [HOLDING, [['1003', '金控', '300', '30', '3']]],
    [SECURITIES, [['1004', '證券', '200', '150', '20', '4']]],
    [INSURANCE_NEW, [['1005', '保險', '9', '5', '0.8']]],
    [OTHER, [['1006', '其他', '60', '40', '6', '1.2']]],
  ]));
  assert.deepEqual(rows.map(({ id, kind, revenue }) => [id, kind, revenue]), [
    ['1001', 'general', 100],
    ['1002', 'bank', 100],
    ['1003', 'holding', 300],
    ['1004', 'securities', 200],
    ['1005', 'insurance', null],
    ['1006', 'other', 60],
  ]);
  assert.deepEqual(rows.find((row) => row.id === '1002'), {
    id: '1002', name: '銀行', kind: 'bank', revenue: 100,
    grossProfit: null, operatingIncome: null, netIncome: 10, eps: 1,
  });
});

test('legacy insurance format uses operating revenue and keeps EPS', () => {
  const [row] = parseMopsQuarterlyFinTables(fixture([
    [INSURANCE_OLD, [['1005', '舊保險', '90', '12', '1.5']]],
  ]));
  assert.deepEqual(row, {
    id: '1005', name: '舊保險', kind: 'insurance', revenue: 90,
    grossProfit: null, operatingIncome: null, netIncome: 12, eps: 1.5,
  });
});

test('new insurance EPS header supports Q1 direct and Q2 cumulative differences', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', quarterFixture(1));
    await writeRaw(root, 'twse', '2025-Q2', quarterFixture(2));
    await applyQuarterlyFinancials(root, '2025-Q1');
    await applyQuarterlyFinancials(root, '2025-Q2');
    assert.deepEqual((await readEps(root)).series['2851'], [[20251, 0.4], [20252, 0.5]]);
  });
});

test('insurance rows without either EPS header keep eps null', () => {
  const [row] = parseMopsQuarterlyFinTables(fixture([
    [INSURANCE_NO_EPS, [['2851', '中再保', '7', '2']]],
  ]));
  assert.equal(row.eps, null);
});

test('full-table parser keeps the legacy four-digit numeric company-id rule', () => {
  const bytes = fixture([
    [GENERAL, [
      ['2330', '合法', '100', '40', '30', '20', '2'],
      ['ABCD', '英數', '100', '40', '30', '20', '2'],
      ['12345', '五碼', '100', '40', '30', '20', '2'],
    ]],
  ]);
  const legacyIds = parseMopsQuarterlyFinHtml(bytes).map((row) => row.id);
  const allTableIds = parseMopsQuarterlyFinTables(bytes).map((row) => row.id);
  assert.deepEqual(allTableIds, ['2330']);
  assert.deepEqual(allTableIds, legacyIds);
});

test('unrecognized quarterly table warns and is skipped without throwing', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const rows = parseMopsQuarterlyFinTables(fixture([
      [['公司代號', '公司名稱', '神秘值'], [['9999', '未知', '1']]],
    ]));
    assert.deepEqual(rows, []);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unrecognized MOPS quarterly table/);
});

test('financial margins use Q1 direct values and Q2 bank revenue and profit differences', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', quarterFixture(1));
    await writeRaw(root, 'twse', '2025-Q2', quarterFixture(2));
    await applyQuarterlyFinancials(root, '2025-Q1');
    await applyQuarterlyFinancials(root, '2025-Q2');
    assert.deepEqual((await readFundamental(root, '2882')).quarterly.rows, [
      [20251, null, null, 10],
      [20252, null, null, 13.64],
    ]);
  });
});

test('null and non-positive financial revenue do not write that quarter', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', quarterFixture(1));
    await writeRaw(root, 'twse', '2025-Q2', quarterFixture(2));
    await applyQuarterlyFinancials(root, '2025-Q1');
    await applyQuarterlyFinancials(root, '2025-Q2');
    assert.deepEqual((await readFundamental(root, '2890')).quarterly.rows, [[20251, null, null, 10]]);
    await assert.rejects(readFundamental(root, '2891'), /ENOENT/);
    await assert.rejects(readFundamental(root, '2851'), /ENOENT/);
  });
});

test('general-industry fundamental bytes retain the established four-column shape', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', quarterFixture(1));
    await applyQuarterlyFinancials(root, '2025-Q1');
    const bytes = await readFile(join(root, 'data', 'derived', 'fundamentals', '23', '2330.json'), 'utf8');
    const expected = {
      id: '2330', name: '台積電', market: 'twse', updated: null,
      valuation: { cols: ['d', 'per', 'pbr', 'dy'], rows: [] },
      revenue: { cols: ['m', 'rev', 'yoy', 'mom'], rows: [] },
      quarterly: { cols: ['q', 'gm', 'om', 'nm'], rows: [[20251, 40, 30, 20]] },
    };
    assert.equal(bytes, `${JSON.stringify(expected, null, 2)}\n`);
  });
});

test('EPS covers general and financial Q1 and Q2 differences but skips missing predecessors', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', quarterFixture(1));
    await writeRaw(root, 'twse', '2025-Q2', quarterFixture(2, [
      ['7777', '新公司', '20', '8', '6', '4', '0.7'],
    ]));
    await applyQuarterlyFinancials(root, '2025-Q1');
    await applyQuarterlyFinancials(root, '2025-Q2');
    const eps = await readEps(root);
    assert.deepEqual(eps.series['2330'], [[20251, 2], [20252, 3]]);
    assert.deepEqual(eps.series['2882'], [[20251, 1], [20252, 1.7]]);
    assert.equal(eps.series['7777'], undefined);
    assert.equal(eps.updated, '2025-Q2');
  });
});

test('EPS series retain only the latest 24 quarters in ascending order', async () => {
  await withTempDir(async (root) => {
    for (let year = 2000; year <= 2024; year += 1) {
      await writeRaw(root, 'twse', `${year}-Q1`, fixture([
        [GENERAL, [['2330', '台積電', '100', '40', '30', '20', String(year - 1999)]]],
      ]));
      await applyQuarterlyFinancials(root, `${year}-Q1`);
    }
    const eps = await readEps(root);
    assert.equal(eps.series['2330'].length, 24);
    assert.deepEqual(eps.series['2330'][0], [20011, 2]);
    assert.deepEqual(eps.series['2330'].at(-1), [20241, 25]);
    assert.equal(eps.updated, '2024-Q1');
  });
});

test('EPS uses TWSE priority and excludes pure six-digit ids', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', fixture([
      [GENERAL, [
        ['2330', '上市', '100', '40', '30', '20', '2'],
        ['123456', '六碼', '100', '40', '30', '20', '6'],
      ]],
    ]));
    await writeRaw(root, 'tpex', '2025-Q1', fixture([
      [GENERAL, [['2330', '上櫃', '100', '40', '30', '20', '9']]],
    ]));
    await applyQuarterlyFinancials(root, '2025-Q1');
    const eps = await readEps(root);
    assert.deepEqual(eps.series['2330'], [[20251, 2]]);
    assert.equal(eps.series['123456'], undefined);
  });
});

test('general-industry rows win same-market collisions with financial tables', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', fixture([
      [BANK, [['2330', '金融重複', '80', '20', '10', '1']]],
      [GENERAL, [['2330', '一般優先', '100', '40', '30', '20', '2']]],
    ]));
    await applyQuarterlyFinancials(root, '2025-Q1');
    const fundamental = await readFundamental(root, '2330');
    assert.equal(fundamental.name, '一般優先');
    assert.deepEqual(fundamental.quarterly.rows, [[20251, 40, 30, 20]]);
    assert.deepEqual((await readEps(root)).series['2330'], [[20251, 2]]);
  });
});

test('quarterly rebuild matches buildDerived and preserves valuation, revenue, and unrelated files', async () => {
  const rebuildRoot = await mkdtemp(join(tmpdir(), 'wfnt-quarterly-rebuild-'));
  const buildRoot = await mkdtemp(join(tmpdir(), 'wfnt-quarterly-build-'));
  try {
    for (const root of [rebuildRoot, buildRoot]) {
      await writeRaw(root, 'twse', '2025-Q1', quarterFixture(1));
      await writeRaw(root, 'twse', '2025-Q2', quarterFixture(2));
    }
    const path = join(rebuildRoot, 'data', 'derived', 'fundamentals', '23', '2330.json');
    const existing = {
      id: '2330', name: '台積電', market: 'twse', updated: '2025-02-03',
      valuation: { cols: ['d', 'per', 'pbr', 'dy'], rows: [[20250203, 20, 5, 2]] },
      revenue: { cols: ['m', 'rev', 'yoy', 'mom'], rows: [[202501, 50, 4, 3]] },
      quarterly: { cols: ['q', 'gm', 'om', 'nm'], rows: [[19991, 1, 1, 1]] },
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`);
    const sentinel = join(rebuildRoot, 'data', 'derived', 'sentinel.json');
    await writeFile(sentinel, '{}\n');

    await rebuildQuarterly({ rootDir: rebuildRoot });
    await buildDerived({ rootDir: buildRoot });
    const rebuilt = await readFundamental(rebuildRoot, '2330');
    const built = await readFundamental(buildRoot, '2330');
    assert.deepEqual(rebuilt.quarterly, built.quarterly);
    assert.deepEqual(await readEps(rebuildRoot), await readEps(buildRoot));
    assert.deepEqual(rebuilt.valuation, existing.valuation);
    assert.deepEqual(rebuilt.revenue, existing.revenue);
    await access(sentinel);
  } finally {
    await rm(rebuildRoot, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  }
});

test('rebuild-quarterly CLI honors --out and reports its summary', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', quarterFixture(1));
    const { stdout } = await execFileAsync(process.execPath, ['scripts/rebuild-quarterly.mjs', '--out', root], {
      cwd: repoRoot,
    });
    assert.match(stdout, /^quarterly: seasons=1 fundamentals=3 eps=5\n$/);
    assert.deepEqual((await readEps(root)).series['2882'], [[20251, 1]]);
  });
});

test('rebuild-quarterly CLI rejects unknown and bare --out arguments', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/rebuild-quarterly.mjs', '--wat'], { cwd: repoRoot }),
    /unknown argument: --wat/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/rebuild-quarterly.mjs', '--out'], { cwd: repoRoot }),
    /--out requires a directory/,
  );
});
