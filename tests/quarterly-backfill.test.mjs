import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runQuarterlyBackfill } from '../scripts/backfill-quarterly.mjs';
import { buildDerived } from '../scripts/build-derived.mjs';
import {
  applyQuarterlyFinancials,
  MOPS_QUARTERLY_FIELDS,
  parseMopsQuarterlyFinHtml,
  reconcileFundamentalPeriod,
} from '../scripts/lib/derived.mjs';
import { GENERAL_HEADER, makeOtcQuarterlyFixture, makeSiiQuarterlyFixture } from './fixtures/mops-quarterly-2025.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const silentLogger = { log() {}, warn() {} };

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-quarterly-test-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function writeRaw(root, market, seasonKey, bytes) {
  const path = join(root, 'data', 'raw', market, 'quarterly_fin_hist', seasonKey.slice(0, 4), `${seasonKey}.html`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function readFundamental(root, id) {
  return JSON.parse(await readFile(join(root, 'data', 'derived', 'fundamentals', id.slice(0, 2), `${id}.json`), 'utf8'));
}

function responseFor(bytes, status = 200) {
  return { status, ok: status >= 200 && status < 300, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
}

function htmlRows(bytes) {
  const text = (value) => value.replace(/<[^>]*>/g, '').trim();
  return [...bytes.toString('utf8').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => text(cell[1])));
}

function firstHeaderMissing(bytes) {
  const first = htmlRows(bytes).find((row) => row[0] === '公司代號');
  const required = [
    MOPS_QUARTERLY_FIELDS.revenue,
    MOPS_QUARTERLY_FIELDS.grossProfit,
    MOPS_QUARTERLY_FIELDS.operatingIncome,
    MOPS_QUARTERLY_FIELDS.netIncome,
  ];
  return required.filter((field) => !first.includes(field));
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/backfill-quarterly.mjs', ...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('MOPS quarterly parser selects the general-industry table by header text in sii and otc', () => {
  const sii = parseMopsQuarterlyFinHtml(makeSiiQuarterlyFixture(1));
  const otc = parseMopsQuarterlyFinHtml(makeOtcQuarterlyFixture());
  assert.equal(GENERAL_HEADER.length, 30);
  assert.deepEqual(sii.find((row) => row.id === '2330'), {
    id: '2330', name: '台積電', revenue: 839253664, grossProfit: 493395076, operatingIncome: 407080808, netIncome: 360732661,
  });
  assert.deepEqual(otc, [{ id: '1240', name: '茂生農經', revenue: 1347115, grossProfit: 201369, operatingIncome: 77907, netIncome: 99732 }]);
});

test('HF5 golden anchors produce all six exact single-quarter margin groups', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', makeSiiQuarterlyFixture(1));
    await writeRaw(root, 'twse', '2025-Q2', makeSiiQuarterlyFixture(2));
    await applyQuarterlyFinancials(root, '2025-Q1');
    await applyQuarterlyFinancials(root, '2025-Q2');
    assert.deepEqual((await readFundamental(root, '2330')).quarterly.rows, [[20251, 58.79, 48.51, 42.98], [20252, 58.62, 49.63, 42.57]]);
    assert.deepEqual((await readFundamental(root, '1101')).quarterly.rows, [[20251, 16.86, 6.58, 2.2], [20252, 15.12, 3.15, 2.07]]);
  });
});

test('Q2 cumulative negative control differs from the single-quarter rows', () => {
  const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
  const rates = (row) => [row.grossProfit, row.operatingIncome, row.netIncome].map((value) => round2((value / row.revenue) * 100));
  const q2 = parseMopsQuarterlyFinHtml(makeSiiQuarterlyFixture(2));
  assert.deepEqual(rates(q2.find((row) => row.id === '2330')), [58.7, 49.1, 42.76]);
  assert.deepEqual(rates(q2.find((row) => row.id === '1101')), [15.99, 4.86, 2.13]);
  assert.notDeepEqual([58.7, 49.1, 42.76], [58.62, 49.63, 42.57]);
  assert.notDeepEqual([15.99, 4.86, 2.13], [15.12, 3.15, 2.07]);
});

test('taking the first 公司代號 header fails in both markets while production selection succeeds', () => {
  const sii = makeSiiQuarterlyFixture(1);
  const otc = makeOtcQuarterlyFixture();
  assert.deepEqual(firstHeaderMissing(sii), [
    MOPS_QUARTERLY_FIELDS.revenue,
    MOPS_QUARTERLY_FIELDS.grossProfit,
    MOPS_QUARTERLY_FIELDS.operatingIncome,
    MOPS_QUARTERLY_FIELDS.netIncome,
  ]);
  assert.deepEqual(firstHeaderMissing(otc), [
    MOPS_QUARTERLY_FIELDS.revenue,
    MOPS_QUARTERLY_FIELDS.grossProfit,
    MOPS_QUARTERLY_FIELDS.operatingIncome,
  ]);
  assert.equal(parseMopsQuarterlyFinHtml(sii).length, 2);
  assert.equal(parseMopsQuarterlyFinHtml(otc).length, 1);
});

test('header text indexes survive a synchronized inserted column and hard-coded index 2 does not', () => {
  const fixture = makeSiiQuarterlyFixture(1, { insertGeneralColumn: true });
  const generalRows = htmlRows(fixture).filter((row) => row.includes('上游新增欄位') || /^\d{4}$/.test(row[0] ?? ''));
  assert.ok(generalRows.every((row) => row.length === 31));
  const parsed = parseMopsQuarterlyFinHtml(fixture).find((row) => row.id === '2330');
  assert.equal(parsed.revenue, 839253664);
  assert.equal(parsed.grossProfit, 493395076);
  const raw2330 = generalRows.find((row) => row[0] === '2330');
  assert.equal(raw2330[2], '999');
  assert.notEqual(Number(raw2330[2]), parsed.revenue);
});

test('required -- becomes null and a width-mismatched company row is excluded', () => {
  const source = makeSiiQuarterlyFixture(1).toString('utf8');
  const missing = Buffer.from(source.replaceAll('<td>768,392</td>', '<td>--</td>'));
  assert.equal(parseMopsQuarterlyFinHtml(missing).find((row) => row.id === '1101').netIncome, null);
  const short = Buffer.from(source.replace('<td>台泥</td>', ''));
  assert.equal(parseMopsQuarterlyFinHtml(short).some((row) => row.id === '1101'), false);
  assert.equal(parseMopsQuarterlyFinHtml(short).some((row) => row.id === '2330'), true);
});

test('reconcile preserves quarterly-only files and quarterly surviving removal of the last old row', async () => {
  await withTempDir(async (root) => {
    const path = join(root, 'data', 'derived', 'fundamentals', '23', '2330.json');
    await mkdir(dirname(path), { recursive: true });
    const quarterly = { cols: ['q', 'gm', 'om', 'nm'], rows: [[20251, 58.79, 48.51, 42.98]] };
    await writeFile(path, `${JSON.stringify({ id: '2330', name: '台積電', market: 'twse', updated: null, valuation: { cols: ['d', 'per', 'pbr', 'dy'], rows: [] }, revenue: { cols: ['m', 'rev', 'yoy', 'mom'], rows: [] }, quarterly }, null, 2)}\n`);
    await reconcileFundamentalPeriod(root, 'valuation', 20250101, new Set());
    await access(path);
    assert.deepEqual((await readFundamental(root, '2330')).quarterly, quarterly);
    const withRevenue = await readFundamental(root, '2330');
    withRevenue.revenue.rows = [[202506, 1, 2, 3]];
    await writeFile(path, `${JSON.stringify(withRevenue, null, 2)}\n`);
    await reconcileFundamentalPeriod(root, 'revenue', 202506, new Set());
    await access(path);
    const after = await readFundamental(root, '2330');
    assert.deepEqual(after.revenue.rows, []);
    assert.deepEqual(after.quarterly, quarterly);
    console.log(`[r4-5 quarterly-only-protection] file=present valuation=${JSON.stringify(after.valuation.rows)} revenue=${JSON.stringify(after.revenue.rows)} quarterly=${JSON.stringify(after.quarterly.rows)}`);
  });
});

test('Q2 raw without same-year Q1 produces no quarterly rows', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q2', makeSiiQuarterlyFixture(2));
    await applyQuarterlyFinancials(root, '2025-Q2');
    await assert.rejects(readFundamental(root, '2330'), /ENOENT/);
    await assert.rejects(readFundamental(root, '1101'), /ENOENT/);
  });
});

test('quarterly incremental apply preserves a row when its market raw is absent', async () => {
  await withTempDir(async (root) => {
    const path = join(root, 'data', 'derived', 'fundamentals', '64', '6488.json');
    await mkdir(dirname(path), { recursive: true });
    const quarterly = { cols: ['q', 'gm', 'om', 'nm'], rows: [[20252, 26.06, 15.91, 9.93]] };
    await writeFile(path, `${JSON.stringify({
      id: '6488',
      name: '環球晶',
      market: 'tpex',
      updated: null,
      valuation: { cols: ['d', 'per', 'pbr', 'dy'], rows: [] },
      revenue: { cols: ['m', 'rev', 'yoy', 'mom'], rows: [] },
      quarterly,
    }, null, 2)}\n`);
    await writeRaw(root, 'twse', '2025-Q1', makeSiiQuarterlyFixture(1));
    await writeRaw(root, 'twse', '2025-Q2', makeSiiQuarterlyFixture(2));

    const before = await readFundamental(root, '6488');
    await applyQuarterlyFinancials(root, '2025-Q2');

    await access(path);
    const after = await readFundamental(root, '6488');
    assert.deepEqual(after.quarterly, quarterly);
    console.log(`[r4-1 absent-market] before=${JSON.stringify(before.quarterly.rows)} after=${JSON.stringify(after.quarterly.rows)} file=present`);
  });
});

test('quarterly incremental apply preserves a row absent from complete raw for both markets', async () => {
  await withTempDir(async (root) => {
    const path = join(root, 'data', 'derived', 'fundamentals', '99', '9999.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      id: '9999',
      name: '已移除公司',
      market: 'twse',
      updated: null,
      valuation: { cols: ['d', 'per', 'pbr', 'dy'], rows: [] },
      revenue: { cols: ['m', 'rev', 'yoy', 'mom'], rows: [] },
      quarterly: { cols: ['q', 'gm', 'om', 'nm'], rows: [[20251, 10, 10, 10]] },
    }, null, 2)}\n`);
    await writeRaw(root, 'twse', '2025-Q1', makeSiiQuarterlyFixture(1));
    await writeRaw(root, 'tpex', '2025-Q1', makeOtcQuarterlyFixture());

    const before = await readFundamental(root, '9999');
    await applyQuarterlyFinancials(root, '2025-Q1');

    await access(path);
    const after = await readFundamental(root, '9999');
    assert.deepEqual(after.quarterly.rows, [[20251, 10, 10, 10]]);
    console.log(`[r4-1 complete-raw-absence] before=${JSON.stringify(before.quarterly.rows)} after=${JSON.stringify(after.quarterly.rows)} file=present`);
  });
});

test('quarterly incremental apply ignores file market metadata when preserving a TPEX-sourced row', async () => {
  await withTempDir(async (root) => {
    const path = join(root, 'data', 'derived', 'fundamentals', '54', '5483.json');
    const tpexFixture = Buffer.from(makeOtcQuarterlyFixture().toString('utf8')
      .replace('<td>1240</td>', '<td>5483</td>')
      .replace('<td>茂生農經</td>', '<td>中美晶</td>'));
    const tpexRawPath = await writeRaw(root, 'tpex', '2025-Q1', tpexFixture);
    await applyQuarterlyFinancials(root, '2025-Q1');
    const createdFromTpex = await readFundamental(root, '5483');
    assert.equal(createdFromTpex.market, 'tpex');
    const sourceMarket = createdFromTpex.market;
    createdFromTpex.market = 'twse';
    createdFromTpex.updated = '2025-08-01';
    createdFromTpex.valuation.rows = [[20250801, 20, 2, 1]];
    await writeFile(path, `${JSON.stringify(createdFromTpex, null, 2)}\n`);
    await rm(tpexRawPath);
    await writeRaw(root, 'twse', '2025-Q1', makeSiiQuarterlyFixture(1));

    const before = await readFundamental(root, '5483');
    await applyQuarterlyFinancials(root, '2025-Q1');

    await access(path);
    const after = await readFundamental(root, '5483');
    assert.equal(after.market, 'twse');
    assert.deepEqual(after.quarterly, createdFromTpex.quarterly);
    console.log(`[r4-1 metadata-mismatch] createdMarket=${sourceMarket} fileMarket=${after.market} tpexRaw=absent before=${JSON.stringify(before.quarterly.rows)} after=${JSON.stringify(after.quarterly.rows)} file=present`);
  });
});

test('quarterly incremental upsert overwrites the same company and quarter key', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', makeSiiQuarterlyFixture(1));
    await applyQuarterlyFinancials(root, '2025-Q1');
    const before = (await readFundamental(root, '2330')).quarterly.rows;
    const revised = Buffer.from(makeSiiQuarterlyFixture(1).toString('utf8')
      .replace('<td>493,395,076</td>', '<td>839,253,664</td>')
      .replace('<td>407,080,808</td>', '<td>839,253,664</td>')
      .replaceAll('<td>360,732,661</td>', '<td>839,253,664</td>'));
    await writeRaw(root, 'twse', '2025-Q1', revised);

    await applyQuarterlyFinancials(root, '2025-Q1');

    const after = (await readFundamental(root, '2330')).quarterly.rows;
    assert.deepEqual(before, [[20251, 58.79, 48.51, 42.98]]);
    assert.deepEqual(after, [[20251, 100, 100, 100]]);
    console.log(`[r4-2 same-key-upsert] before=${JSON.stringify(before)} after=${JSON.stringify(after)} rowCount=${after.length}`);
  });
});

test('isolated full rebuild removes a stale quarterly row after the company disappears from raw', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', makeSiiQuarterlyFixture(1));
    await applyQuarterlyFinancials(root, '2025-Q1');
    const before = (await readFundamental(root, '2330')).quarterly.rows;
    const revised = Buffer.from(makeSiiQuarterlyFixture(1).toString('utf8')
      .replaceAll('<td>2330</td>', '<td>3333</td>'));
    await writeRaw(root, 'twse', '2025-Q1', revised);

    const summary = await buildDerived({ rootDir: root });

    await assert.rejects(readFundamental(root, '2330'), /ENOENT/);
    assert.equal(summary.quarterlySeasons, 1);
    console.log(`[r4-3 full-rebuild] root=${root} before=${JSON.stringify(before)} after=FILE_ABSENT quarter=absent`);
  });
});

test('quarterly backfill posts exact form, preserves bytes, checkpoints, and rejects non-Q1 starts', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    const sii = makeSiiQuarterlyFixture(1);
    const otc = makeOtcQuarterlyFixture();
    const first = await runQuarterlyBackfill({ rootDir: root, fromSeason: '2025-Q1', toSeason: '2025-Q1', delayMs: 0, sleepImpl: async () => {}, fetchImpl: async (url, options) => { calls.push({ url, options }); return responseFor(options.body.includes('TYPEK=sii') ? sii : otc); }, logger: silentLogger });
    assert.deepEqual(first, { seasons: 1, requests: 2, skipped: 0, rawWritten: 2, rows: 3 });
    assert.equal(calls.every((call) => call.options.method === 'POST'), true);
    assert.deepEqual(calls.map((call) => call.options.body), [
      'encodeURIComponent=1&step=1&firstin=1&off=1&isQuery=Y&TYPEK=sii&year=114&season=01',
      'encodeURIComponent=1&step=1&firstin=1&off=1&isQuery=Y&TYPEK=otc&year=114&season=01',
    ]);
    assert.deepEqual(await readFile(join(root, 'data/raw/twse/quarterly_fin_hist/2025/2025-Q1.html')), sii);
    const second = await runQuarterlyBackfill({ rootDir: root, fromSeason: '2025-Q1', toSeason: '2025-Q1', delayMs: 0, sleepImpl: async () => {}, fetchImpl: async () => assert.fail('checkpoint should skip fetch'), logger: silentLogger });
    assert.deepEqual(second, { seasons: 1, requests: 0, skipped: 2, rawWritten: 0, rows: 0 });
    await assert.rejects(runQuarterlyBackfill({ rootDir: root, fromSeason: '2025-Q2', toSeason: '2025-Q2' }), /--from must start at Q1/);
  });
});

test('CLI rejects a non-Q1 --from before making any request', async () => {
  const result = await runCli(['--from', '2025-Q2', '--to', '2025-Q2', '--out', tmpdir()]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--from must start at Q1 because later quarters require same-year cumulative differencing/);
  assert.equal(result.stdout, '');
});

test('CLI rejects missing, non-numeric, and negative --delay-ms values', async () => {
  const cases = [
    { label: 'missing', args: ['--delay-ms'] },
    { label: 'non-numeric', args: ['--delay-ms', 'nope'] },
    { label: 'negative', args: ['--delay-ms', '-1'] },
  ];
  for (const input of cases) {
    const result = await runCli(['--from', '2025-Q1', '--to', '2025-Q1', '--out', tmpdir(), ...input.args]);
    assert.notEqual(result.code, 0, input.label);
    assert.match(result.stderr, /--delay-ms must be a non-negative number/, input.label);
    assert.equal(result.stdout, '', input.label);
    console.log(`[r3-2 ${input.label}] exit=${result.code} stderr=${JSON.stringify(result.stderr.split('\n')[0])}`);
  }
});

test('isolated backfill to applyQuarterlyFinancials produces raw and derived quarterly rows', async () => {
  await withTempDir(async (root) => {
    const sii = makeSiiQuarterlyFixture(1);
    const otc = makeOtcQuarterlyFixture();
    await runQuarterlyBackfill({ rootDir: root, fromSeason: '2025-Q1', toSeason: '2025-Q1', delayMs: 0, sleepImpl: async () => {}, fetchImpl: async (_url, options) => responseFor(options.body.includes('TYPEK=sii') ? sii : otc), logger: silentLogger });
    await applyQuarterlyFinancials(root, '2025-Q1');
    assert.deepEqual((await readFundamental(root, '2330')).quarterly.rows, [[20251, 58.79, 48.51, 42.98]]);
    assert.deepEqual((await readFundamental(root, '1240')).quarterly.rows, [[20251, 14.95, 5.78, 7.4]]);
  });
});

test('full build discovers quarters while incremental quarterly preserves old sequence bytes and updated', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', makeSiiQuarterlyFixture(1));
    await writeRaw(root, 'twse', '2025-Q2', makeSiiQuarterlyFixture(2));
    const path = join(root, 'data', 'derived', 'fundamentals', '23', '2330.json');
    await mkdir(dirname(path), { recursive: true });
    const existing = { id: '2330', name: '台積電', market: 'twse', updated: '2026-07-01', valuation: { cols: ['d', 'per', 'pbr', 'dy'], rows: [[20260630, 25.1, 5.2, 1.8]] }, revenue: { cols: ['m', 'rev', 'yoy', 'mom'], rows: [[202607, 1, 2, 3]] } };
    await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`);
    const before = JSON.stringify({ valuation: existing.valuation, revenue: existing.revenue });
    await applyQuarterlyFinancials(root, '2025-Q1');
    const incremental = await readFundamental(root, '2330');
    assert.equal(JSON.stringify({ valuation: incremental.valuation, revenue: incremental.revenue }), before);
    assert.equal(incremental.updated, '2026-07-01');
    const summary = await buildDerived({ rootDir: root });
    assert.equal(summary.quarterlySeasons, 2);
    assert.deepEqual((await readFundamental(root, '2330')).quarterly.rows, [[20251, 58.79, 48.51, 42.98], [20252, 58.62, 49.63, 42.57]]);
  });
});
