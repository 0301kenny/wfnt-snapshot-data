import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  quarterlyBackfillOptionsFromArgs,
  runQuarterlyBackfill,
} from '../scripts/backfill-quarterly.mjs';
import {
  applyQuarterlyFinancials,
  parseMopsQuarterlyFinHtml,
  readMopsQuarterlyFinRaw,
} from '../scripts/lib/derived.mjs';
import {
  quarterlyRefreshOptionsFromArgs,
  quarterlyRefreshRange,
  runQuarterlyRefresh,
} from '../scripts/quarterly-refresh.mjs';
import {
  GENERAL_HEADER,
  SII_Q1_ROWS,
  SII_Q2_ROWS,
  makeOtcQuarterlyFixture,
  makeSiiQuarterlyFixture,
} from './fixtures/mops-quarterly-2025.mjs';

const silentLogger = { log() {}, warn() {} };

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-quarterly-revisions-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function writeRaw(root, market, seasonKey, bytes, suffix = '') {
  const path = join(
    root,
    'data',
    'raw',
    market,
    'quarterly_fin_hist',
    seasonKey.slice(0, 4),
    `${seasonKey}${suffix}.html`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

function responseFor(bytes) {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function generalHtml(rows) {
  const header = GENERAL_HEADER.map((cell) => `<th>${cell}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('');
  return Buffer.from(`<html><body><table><tr>${header}</tr>${body}</table></body></html>`);
}

function withBankRow(bytes, interestIncome) {
  const html = bytes.toString('utf8');
  const start = html.indexOf('<table data-kind="special">');
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end);
  const headerRow = table.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i)?.[1];
  const headers = [...headerRow.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
    .map((match) => match[1].replace(/<[^>]*>/g, '').trim());
  const values = Array(headers.length).fill('--');
  const set = (name, value) => { values[headers.indexOf(name)] = value; };
  set('公司代號', '2801');
  set('公司名稱', '金融測試');
  set('利息淨收益', String(interestIncome));
  set('利息以外淨損益', '50');
  set('本期稅後淨利（淨損）', '20');
  set('基本每股盈餘（元）', '1');
  const row = `<tr>${values.map((value) => `<td>${value}</td>`).join('')}</tr>`;
  return Buffer.from(`${html.slice(0, end)}${row}${html.slice(end)}`);
}

function rowWith(base, values) {
  const row = [...base];
  for (const [field, value] of Object.entries(values)) row[GENERAL_HEADER.indexOf(field)] = value;
  return row;
}

function quarterlyRow({ id, name, revenue, grossProfit, operatingIncome, netIncome, eps }) {
  return rowWith(Array(GENERAL_HEADER.length).fill('--'), {
    '公司代號': id,
    '公司名稱': name,
    '營業收入': String(revenue),
    '營業毛利（毛損）': String(grossProfit),
    '營業利益（損失）': String(operatingIncome),
    '本期淨利（淨損）': String(netIncome),
    '基本每股盈餘（元）': String(eps),
  });
}

async function readFundamental(root, id) {
  return JSON.parse(await readFile(
    join(root, 'data', 'derived', 'fundamentals', id.slice(0, 2), `${id}.json`),
    'utf8',
  ));
}

test('refreshRecent 0 preserves the legacy checkpoint summary shape and values', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse', '2025-Q1', makeSiiQuarterlyFixture(1));
    await writeRaw(root, 'tpex', '2025-Q1', makeOtcQuarterlyFixture());
    const summary = await runQuarterlyBackfill({
      rootDir: root,
      fromSeason: '2025-Q1',
      toSeason: '2025-Q1',
      refreshRecent: 0,
      fetchImpl: async () => assert.fail('legacy checkpoint must not fetch'),
      logger: silentLogger,
    });
    assert.deepEqual(summary, { seasons: 1, requests: 0, skipped: 2, rawWritten: 0, rows: 0 });
  });
});

test('refreshRecent identical responses write nothing and count unchanged', async () => {
  await withTempDir(async (root) => {
    const sii = makeSiiQuarterlyFixture(1);
    const otc = makeOtcQuarterlyFixture();
    await writeRaw(root, 'twse', '2025-Q1', sii);
    await writeRaw(root, 'tpex', '2025-Q1', otc);
    const summary = await runQuarterlyBackfill({
      rootDir: root,
      fromSeason: '2025-Q1',
      toSeason: '2025-Q1',
      refreshRecent: 1,
      delayMs: 0,
      sleepImpl: async () => {},
      fetchImpl: async (_url, options) => responseFor(options.body.includes('TYPEK=sii') ? sii : otc),
      logger: silentLogger,
    });
    assert.deepEqual(summary, {
      seasons: 1, requests: 2, skipped: 0, rawWritten: 0, rows: 3,
      revisions: 0, unchanged: 2, unpublished: 0,
    });
    await assert.rejects(access(join(root, 'data/raw/twse/quarterly_fin_hist/2025/2025-Q1.rev-2026-10-17.html')));
  });
});

test('refreshRecent appends changed bytes to a dated revision and preserves main bytes', async () => {
  await withTempDir(async (root) => {
    const main = makeSiiQuarterlyFixture(1);
    const revised = generalHtml([
      rowWith(SII_Q1_ROWS[0], { '營業收入': '35,000,000' }),
      SII_Q1_ROWS[1],
    ]);
    const otc = makeOtcQuarterlyFixture();
    const mainPath = await writeRaw(root, 'twse', '2025-Q1', main);
    await writeRaw(root, 'tpex', '2025-Q1', otc);
    const summary = await runQuarterlyBackfill({
      rootDir: root,
      fromSeason: '2025-Q1',
      toSeason: '2025-Q1',
      refreshRecent: 1,
      delayMs: 0,
      sleepImpl: async () => {},
      now: () => new Date('2026-10-16T16:30:00Z'),
      fetchImpl: async (_url, options) => responseFor(options.body.includes('TYPEK=sii') ? revised : otc),
      logger: silentLogger,
    });
    assert.equal(summary.rawWritten, 1);
    assert.equal(summary.revisions, 1);
    assert.equal(summary.unchanged, 1);
    assert.deepEqual(await readFile(mainPath), main);
    assert.deepEqual(
      await readFile(join(root, 'data/raw/twse/quarterly_fin_hist/2025/2025-Q1.rev-2026-10-17.html')),
      revised,
    );
  });
});

test('refresh comparison includes non-general numeric rows', async () => {
  await withTempDir(async (root) => {
    const main = withBankRow(makeSiiQuarterlyFixture(1), 100);
    const revised = withBankRow(makeSiiQuarterlyFixture(1), 110);
    const otc = makeOtcQuarterlyFixture();
    await writeRaw(root, 'twse', '2025-Q1', main);
    await writeRaw(root, 'tpex', '2025-Q1', otc);
    const summary = await runQuarterlyBackfill({
      rootDir: root,
      fromSeason: '2025-Q1',
      toSeason: '2025-Q1',
      refreshRecent: 1,
      delayMs: 0,
      sleepImpl: async () => {},
      now: () => new Date('2026-10-17T00:00:00Z'),
      fetchImpl: async (_url, options) => responseFor(options.body.includes('TYPEK=sii') ? revised : otc),
      logger: silentLogger,
    });
    assert.equal(summary.revisions, 1);
    assert.equal(summary.unchanged, 1);
    assert.deepEqual(
      await readFile(join(root, 'data/raw/twse/quarterly_fin_hist/2025/2025-Q1.rev-2026-10-17.html')),
      revised,
    );
  });
});

test('revision merge adds new ids, retains omitted ids, and replaces existing ids', async () => {
  await withTempDir(async (root) => {
    const changed2330 = rowWith(SII_Q1_ROWS[1], { '營業收入': '900,000,000' });
    const added = rowWith(SII_Q1_ROWS[0], { '公司代號': '9999', '公司名稱': '晚申報' });
    await writeRaw(root, 'twse', '2025-Q1', generalHtml(SII_Q1_ROWS));
    await writeRaw(root, 'twse', '2025-Q1', generalHtml([changed2330, added]), '.rev-2026-10-17');
    const rows = await readMopsQuarterlyFinRaw(root, 'twse/quarterly_fin_hist', '2025-Q1');
    assert.deepEqual(rows.map((row) => row.id).sort(), ['1101', '2330', '9999']);
    assert.equal(rows.find((row) => row.id === '1101').revenue, 34956255);
    assert.equal(rows.find((row) => row.id === '2330').revenue, 900000000);
  });
});

test('refresh compares merged outcomes when newer responses omit old companies', async () => {
  await withTempDir(async (root) => {
    const originalA = quarterlyRow({
      id: '7001', name: 'A', revenue: 100, grossProfit: 40,
      operatingIncome: 20, netIncome: 10, eps: 1,
    });
    const changedA = quarterlyRow({
      id: '7001', name: 'A', revenue: 120, grossProfit: 48,
      operatingIncome: 24, netIncome: 12, eps: 1.2,
    });
    const companyB = quarterlyRow({
      id: '7002', name: 'B', revenue: 200, grossProfit: 80,
      operatingIncome: 40, netIncome: 20, eps: 2,
    });
    const companyC = quarterlyRow({
      id: '7003', name: 'C', revenue: 300, grossProfit: 120,
      operatingIncome: 60, netIncome: 30, eps: 3,
    });
    const otc = makeOtcQuarterlyFixture();
    const main = generalHtml([originalA, companyB]);
    const onlyChangedA = generalHtml([changedA]);
    const changedAWithC = generalHtml([changedA, companyC]);
    await writeRaw(root, 'twse', '2025-Q1', main);
    await writeRaw(root, 'tpex', '2025-Q1', otc);

    const runDay = (date, sii) => runQuarterlyBackfill({
      rootDir: root,
      fromSeason: '2025-Q1',
      toSeason: '2025-Q1',
      refreshRecent: 1,
      delayMs: 0,
      sleepImpl: async () => {},
      now: () => new Date(`${date}T00:00:00Z`),
      fetchImpl: async (_url, options) => responseFor(
        options.body.includes('TYPEK=sii') ? sii : otc,
      ),
      logger: silentLogger,
    });

    const first = await runDay('2026-10-17', onlyChangedA);
    assert.deepEqual(first, {
      seasons: 1, requests: 2, skipped: 0, rawWritten: 1, rows: 2,
      revisions: 1, unchanged: 1, unpublished: 0,
    });

    let rebuildCalls = 0;
    let second;
    const refresh = await runQuarterlyRefresh({
      rootDir: root,
      now: () => new Date('2026-10-18T00:00:00Z'),
      backfill: async () => {
        second = await runDay('2026-10-18', onlyChangedA);
        return second;
      },
      rebuild: async () => { rebuildCalls += 1; },
      logger: silentLogger,
    });
    assert.deepEqual(second, {
      seasons: 1, requests: 2, skipped: 0, rawWritten: 0, rows: 2,
      revisions: 0, unchanged: 2, unpublished: 0,
    });
    assert.equal(refresh.rebuilt, null);
    assert.equal(rebuildCalls, 0);
    await assert.rejects(access(
      join(root, 'data/raw/twse/quarterly_fin_hist/2025/2025-Q1.rev-2026-10-18.html'),
    ));

    const third = await runDay('2026-10-19', changedAWithC);
    assert.deepEqual(third, {
      seasons: 1, requests: 2, skipped: 0, rawWritten: 1, rows: 3,
      revisions: 1, unchanged: 1, unpublished: 0,
    });
    assert.deepEqual(
      await readFile(join(root, 'data/raw/twse/quarterly_fin_hist/2025/2025-Q1.html')),
      main,
    );
    await access(join(
      root,
      'data/raw/twse/quarterly_fin_hist/2025/2025-Q1.rev-2026-10-19.html',
    ));
  });
});

test('main-only quarterly read remains identical to the established parser output', async () => {
  await withTempDir(async (root) => {
    const main = makeSiiQuarterlyFixture(1);
    await writeRaw(root, 'twse', '2025-Q1', main);
    assert.deepEqual(
      await readMopsQuarterlyFinRaw(root, 'twse/quarterly_fin_hist', '2025-Q1'),
      parseMopsQuarterlyFinHtml(main),
    );
  });
});

test('an invalid revision warns and leaves main rows usable', async () => {
  await withTempDir(async (root) => {
    const main = makeSiiQuarterlyFixture(1);
    await writeRaw(root, 'twse', '2025-Q1', main);
    await writeRaw(root, 'twse', '2025-Q1', Buffer.from('<html>broken</html>'), '.rev-2026-10-17');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      assert.deepEqual(
        await readMopsQuarterlyFinRaw(root, 'twse/quarterly_fin_hist', '2025-Q1'),
        parseMopsQuarterlyFinHtml(main),
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /quarterly revision skipped/);
  });
});

test('Q2 current TWSE row falls back to the matching prior-quarter TPEX row', async () => {
  await withTempDir(async (root) => {
    const previous = quarterlyRow({
      id: '7777', name: '轉上市', revenue: 100, grossProfit: 40,
      operatingIncome: 20, netIncome: 10, eps: 1,
    });
    const current = quarterlyRow({
      id: '7777', name: '轉上市', revenue: 250, grossProfit: 100,
      operatingIncome: 50, netIncome: 25, eps: 3,
    });
    await writeRaw(root, 'tpex', '2025-Q1', generalHtml([previous]));
    await writeRaw(root, 'twse', '2025-Q2', generalHtml([current]));
    const summary = await applyQuarterlyFinancials(root, '2025-Q2');
    assert.equal(summary.eps, 1);
    assert.deepEqual((await readFundamental(root, '7777')).quarterly.rows, [
      [20252, 40, 20, 10],
    ]);
    const eps = JSON.parse(await readFile(join(root, 'data/derived/quarterly_eps.json'), 'utf8'));
    assert.deepEqual(eps.series['7777'], [[20252, 2]]);
  });
});

test('zero-row responses in the final refresh season are counted as unpublished', async () => {
  await withTempDir(async (root) => {
    const empty = generalHtml([]);
    const summary = await runQuarterlyBackfill({
      rootDir: root,
      fromSeason: '2025-Q1',
      toSeason: '2025-Q1',
      refreshRecent: 1,
      delayMs: 0,
      sleepImpl: async () => {},
      fetchImpl: async () => responseFor(empty),
      logger: silentLogger,
    });
    assert.equal(summary.unpublished, 2);
    assert.equal(summary.rawWritten, 0);
  });
});

test('zero-row responses before the final refresh window still throw', async () => {
  await withTempDir(async (root) => {
    await assert.rejects(runQuarterlyBackfill({
      rootDir: root,
      fromSeason: '2025-Q1',
      toSeason: '2025-Q2',
      refreshRecent: 1,
      delayMs: 0,
      sleepImpl: async () => {},
      fetchImpl: async () => responseFor(generalHtml([])),
      logger: silentLogger,
    }), /0 general-industry data rows/);
  });
});

test('quarterly refresh range uses Taipei time and crosses January into prior-year Q4', () => {
  assert.deepEqual(
    quarterlyRefreshRange(new Date('2026-01-01T00:30:00Z')),
    { fromSeason: '2024-Q1', toSeason: '2025-Q4' },
  );
  assert.deepEqual(
    quarterlyRefreshRange(new Date('2026-09-30T16:30:00Z')),
    { fromSeason: '2025-Q1', toSeason: '2026-Q3' },
  );
});

test('quarterly refresh rebuilds after a main or revision write', async () => {
  const calls = [];
  const lines = [];
  const result = await runQuarterlyRefresh({
    rootDir: '/tmp/ticket-302-refresh-root',
    refreshRecent: 4,
    now: () => new Date('2026-10-17T00:00:00Z'),
    backfill: async (options) => {
      calls.push(['backfill', options]);
      return { requests: 8, rawWritten: 1, revisions: 1, unchanged: 7, unpublished: 0 };
    },
    rebuild: async (options) => {
      calls.push(['rebuild', options]);
      return { seasons: 7, fundamentals: 1, eps: 1 };
    },
    logger: { log: (line) => lines.push(line), warn() {} },
  });
  assert.equal(calls[0][0], 'backfill');
  assert.deepEqual(
    { fromSeason: calls[0][1].fromSeason, toSeason: calls[0][1].toSeason },
    { fromSeason: '2025-Q1', toSeason: '2026-Q3' },
  );
  assert.equal(calls[1][0], 'rebuild');
  assert.deepEqual(calls[1][1], { rootDir: resolve('/tmp/ticket-302-refresh-root') });
  assert.deepEqual(result.rebuilt, { seasons: 7, fundamentals: 1, eps: 1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /rebuilt=yes/);
});

test('quarterly refresh skips rebuild when backfill writes nothing', async () => {
  let rebuildCalls = 0;
  const result = await runQuarterlyRefresh({
    rootDir: '/tmp/ticket-302-refresh-root',
    now: () => new Date('2026-10-17T00:00:00Z'),
    backfill: async () => ({
      requests: 8, rawWritten: 0, revisions: 0, unchanged: 8, unpublished: 0,
    }),
    rebuild: async () => { rebuildCalls += 1; },
    logger: silentLogger,
  });
  assert.equal(rebuildCalls, 0);
  assert.equal(result.rebuilt, null);
});

test('quarterly numeric CLI options preserve defaults and bare flags for guards', async () => {
  assert.equal(quarterlyBackfillOptionsFromArgs({}).refreshRecent, 0);
  assert.equal(quarterlyRefreshOptionsFromArgs({}).refreshRecent, 4);
  const refreshRecent = quarterlyRefreshOptionsFromArgs({ 'refresh-recent': true }).refreshRecent;
  assert.equal(Number.isNaN(refreshRecent), true);
  await assert.rejects(runQuarterlyRefresh({ refreshRecent }), /non-negative integer/);
});
