import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { backfillOptionsFromArgs, runBackfill } from '../scripts/backfill.mjs';
import {
  monthlyBackfillOptionsFromArgs,
  runMonthlyBackfill,
} from '../scripts/backfill-monthly.mjs';
import { quarterlyBackfillOptionsFromArgs } from '../scripts/backfill-quarterly.mjs';
import {
  detectGaps,
  detectGapsOptionsFromArgs,
} from '../scripts/detect-gaps.mjs';
import { parseNumericFlag } from '../scripts/lib/cli.mjs';

const silentLogger = { log() {}, warn() {} };

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-cli-flags-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(root, relativePath, contents = '') {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function rejectionMessage(promise, pattern) {
  try {
    await promise;
    assert.fail('expected rejection');
  } catch (error) {
    assert.match(error.message, pattern);
    return error.message;
  }
}

test('numeric flag parser distinguishes absence, strings, and bare flags', () => {
  assert.equal(parseNumericFlag(undefined, 3000), 3000);
  assert.equal(parseNumericFlag('0', 3000), 0);
  assert.equal(parseNumericFlag('500', 1300), 500);
  assert.equal(Number.isNaN(parseNumericFlag(true, 3000)), true);
  assert.equal(Number.isNaN(parseNumericFlag(12, 3000)), true);
  assert.equal(Number.isNaN(quarterlyBackfillOptionsFromArgs({ 'delay-ms': true }).delayMs), true);
});

test('monthly bare --delay-ms rejects before fetch', async () => {
  await withTempDir(async (root) => {
    let fetchCalls = 0;
    const options = monthlyBackfillOptionsFromArgs({
      out: root,
      from: '2023-08',
      to: '2023-08',
      'delay-ms': true,
    });
    const message = await rejectionMessage(runMonthlyBackfill({
      ...options,
      fetchImpl: async () => { fetchCalls += 1; },
      sleepImpl: async () => {},
      logger: silentLogger,
    }), /--delay-ms must be a non-negative number/);
    assert.equal(fetchCalls, 0);
    console.log(`[ticket-198 bare monthly delay] message=${JSON.stringify(message)} fetchCalls=${fetchCalls}`);
  });
});

test('daily backfill bare --delay-ms rejects before fetch', async () => {
  await withTempDir(async (root) => {
    let fetchCalls = 0;
    const options = backfillOptionsFromArgs({
      out: root,
      from: '2026-07-06',
      to: '2026-07-06',
      'delay-ms': true,
    });
    const message = await rejectionMessage(runBackfill({
      ...options,
      fetchImpl: async () => { fetchCalls += 1; },
      sleepImpl: async () => {},
      logger: silentLogger,
    }), /--delay-ms must be a non-negative number/);
    assert.equal(fetchCalls, 0);
    console.log(`[ticket-198 bare daily delay] message=${JSON.stringify(message)} fetchCalls=${fetchCalls}`);
  });
});

test('daily backfill bare --window rejects before fetch', async () => {
  await withTempDir(async (root) => {
    let fetchCalls = 0;
    const options = backfillOptionsFromArgs({
      out: root,
      from: '2026-07-06',
      to: '2026-07-06',
      window: true,
    });
    const message = await rejectionMessage(runBackfill({
      ...options,
      fetchImpl: async () => { fetchCalls += 1; },
      sleepImpl: async () => {},
      logger: silentLogger,
    }), /--window must be a positive integer/);
    assert.equal(fetchCalls, 0);
    console.log(`[ticket-198 bare daily window] message=${JSON.stringify(message)} fetchCalls=${fetchCalls}`);
  });
});

test('gap detector bare --delay-ms rejects before fetch', async () => {
  await withTempDir(async (root) => {
    let fetchCalls = 0;
    const options = detectGapsOptionsFromArgs({
      out: root,
      from: '2026-07-06',
      to: '2026-07-06',
      'delay-ms': true,
    });
    const message = await rejectionMessage(detectGaps({
      ...options,
      fetchImpl: async () => { fetchCalls += 1; },
      sleepImpl: async () => {},
      logger: silentLogger,
    }), /--delay-ms must be a non-negative number/);
    assert.equal(fetchCalls, 0);
    console.log(`[ticket-198 bare gaps delay] message=${JSON.stringify(message)} fetchCalls=${fetchCalls}`);
  });
});

test('legal numeric strings reach all four run paths unchanged', async () => {
  await withTempDir(async (root) => {
    let fetchCalls = 0;
    const noFetch = async () => {
      fetchCalls += 1;
      assert.fail('fixture should complete without fetch');
    };

    for (const source of ['twse/monthly_revenue_hist', 'tpex/monthly_revenue_hist']) {
      for (const variant of [0, 1]) {
        await write(root, `data/raw/${source}/2023/2023-08_${variant}.html`);
      }
    }
    const monthlyOptions = monthlyBackfillOptionsFromArgs({
      out: root,
      from: '2023-08',
      to: '2023-08',
      'delay-ms': '0',
    });
    const monthly = await runMonthlyBackfill({
      ...monthlyOptions,
      fetchImpl: noFetch,
      sleepImpl: async () => {},
      logger: silentLogger,
    });

    const date = '2026-07-06';
    const year = date.slice(0, 4);
    const twseSblFields = [
      '代號', '名稱', '前日餘額', '賣出', '買進', '現券', '今日餘額', '次一營業日限額',
      '前日餘額', '當日賣出', '當日還券', '當日調整', '當日餘額', '次一營業日可限額', '備註',
    ];
    const tpexSblFields = [
      '股票代號', '股票名稱', '前日餘額', '賣出', '買進', '現券', '當日餘額', '限額',
      '前日餘額', '當日賣出', '當日還券', '當日調整數額', '當日餘額',
      '次一營業日可借券賣出限額', '備註',
    ];
    const dailyRaw = [
      ['twse/stock_day_all', []],
      ['tpex/mainboard_close', []],
      ['twse/t86_hist', {
        stat: 'OK',
        fields: ['證券代號', '證券名稱', '外陸資買賣超股數(不含外資自營商)', '外資自營商買賣超股數', '投信買賣超股數', '自營商買賣超股數', '三大法人買賣超股數'],
        data: [],
      }],
      ['twse/bwibbu_hist', {
        stat: 'OK',
        fields: ['證券代號', '證券名稱', '本益比', '殖利率(%)', '股價淨值比'],
        data: [],
      }],
      ['twse/sbl_hist', { stat: 'OK', date: '20260706', fields: twseSblFields, data: [], groups: [{ title: '股票', span: 2 }, { title: '融券', span: 6 }, { title: '借券賣出', span: 6 }, { title: '', span: 1 }] }],
      ['tpex/pe_hist', {
        stat: 'ok',
        tables: [{ fields: ['股票代號', '公司名稱', '本益比', '殖利率(%)', '股價淨值比'], data: [] }],
      }],
      ['tpex/sbl_hist', {
        stat: 'ok',
        date: '20260706',
        tables: [{ fields: tpexSblFields, data: [] }],
      }],
    ];
    for (const [source, payload] of dailyRaw) {
      await write(root, `data/raw/${source}/${year}/${date}.json`, `${JSON.stringify(payload)}\n`);
    }
    const backfillOptions = backfillOptionsFromArgs({
      out: root,
      from: date,
      to: date,
      'delay-ms': '0',
      window: '500',
    });
    const backfill = await runBackfill({
      ...backfillOptions,
      fetchImpl: noFetch,
      sleepImpl: async () => {},
      logger: silentLogger,
    });

    await write(root, 'data/raw/twse/mi_index_hist/2026/2026-07-06.json', '{}\n');
    await write(root, 'data/raw/tpex/daily_quotes_hist/2026/2026-07-06.json', '{}\n');
    const gapOptions = detectGapsOptionsFromArgs({
      out: root,
      from: '2026-07-06',
      to: '2026-07-06',
      'delay-ms': '0',
    });
    const gaps = await detectGaps({
      ...gapOptions,
      fetchImpl: noFetch,
      sleepImpl: async () => {},
      now: () => new Date('2026-08-31T00:00:00Z'),
      logger: silentLogger,
    });

    assert.equal(monthlyOptions.delayMs, 0);
    assert.equal(monthly.requests, 0);
    assert.equal(backfillOptions.delayMs, 0);
    assert.equal(backfillOptions.symbolWindow, 500);
    assert.equal(backfill.resumed, 0);
    assert.equal(backfill.rawWritten, 0);
    assert.equal(gapOptions.delayMs, 0);
    assert.equal(gaps.candidates.size, 0);
    assert.equal(fetchCalls, 0);
    console.log('[ticket-198 legal monthly delay] delayMs=0 run=fulfilled');
    console.log('[ticket-198 legal daily delay] delayMs=0 run=fulfilled');
    console.log('[ticket-198 legal daily window] symbolWindow=500 run=fulfilled');
    console.log('[ticket-198 legal gaps delay] delayMs=0 run=fulfilled');
  });
});
