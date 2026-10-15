import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { rawPath } from '../scripts/backfill.mjs';
import { runHistoryBackfill } from '../scripts/lib/history-backfill.mjs';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const silentLogger = { log() {}, warn() {} };
const fixedNow = () => new Date('2026-10-16T04:00:00.000Z');

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-history-backfill-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function jsonBytes(value) {
  return Buffer.from(` ${JSON.stringify(value)}\r\n`);
}

function miIndexFixture() {
  const tables = Array.from({ length: 9 }, () => ({ fields: [], data: [] }));
  tables[8] = {
    fields: ['證券代號', '證券名稱', '成交股數', '成交筆數', '開盤價', '最高價', '最低價', '收盤價'],
    data: [['2330', '台積電', '1', '1', '1', '1', '1', '1']],
  };
  return { stat: 'OK', tables };
}

function t86Fixture() {
  return {
    stat: 'OK',
    fields: ['證券代號', '證券名稱', '三大法人買賣超股數', '外陸資買賣超股數(不含外資自營商)', '外資自營商買賣超股數', '投信買賣超股數', '自營商買賣超股數'],
    data: [['2330', '台積電', '1', '1', '1', '1', '1']],
  };
}

function miMargnFixture() {
  return {
    stat: 'OK',
    tables: [
      { fields: [], data: [] },
      {
        fields: ['代號', '名稱', '買進', '賣出', '現金償還', '前日餘額', '今日餘額', '次一營業日限額', '買進', '賣出', '現券償還', '前日餘額', '今日餘額', '次一營業日限額', '資券互抵', '註記'],
        groups: [{ title: '股票', span: 2 }, { title: '融資', span: 6 }, { title: '融券', span: 6 }, { title: '', span: 1 }, { title: '', span: 1 }],
        data: [['2330', '台積電', '1', '1', '0', '1', '1', '1', '1', '1', '0', '1', '1', '1', '0', '']],
      },
    ],
  };
}

function bwibbuFixture() {
  return {
    stat: 'OK',
    fields: ['證券代號', '證券名稱', '本益比', '殖利率(%)', '股價淨值比'],
    data: [['2330', '台積電', '1', '1', '1']],
  };
}

function twseSblFixture(date, old = false) {
  const fields = old
    ? ['代號', '名稱', '前日餘額', '賣出', '買進', '現券', '今日餘額', '次一營業日限額', '前日餘額', '賣出', '庫存異動', '今日餘額', '可使用額度', '備註']
    : ['代號', '名稱', '前日餘額', '賣出', '買進', '現券', '今日餘額', '次一營業日限額', '前日餘額', '當日賣出', '當日還券', '當日調整', '當日餘額', '次一營業日可限額', '備註'];
  return { stat: 'OK', date, fields, data: [fields.map((_, index) => index < 2 ? ['2330', '台積電'][index] : '1')] };
}

function tpexDailyFixture(empty = false) {
  const fields = ['代號', '名稱', '收盤', '開盤', '最高', '最低', '成交股數', '成交筆數'];
  return { stat: 'ok', tables: [{ fields, data: empty ? [] : [['5483', '中美晶', '1', '1', '1', '1', '1', '1']] }] };
}

function tpexInstiFixture() {
  const fields = Array.from({ length: 24 }, (_, index) => `f${index}`);
  fields[23] = '三大法人買賣超股數合計';
  return { stat: 'ok', tables: [{ fields, data: [Array.from({ length: 24 }, (_, index) => index < 2 ? ['5483', '中美晶'][index] : '1')] }] };
}

function tpexMarginFixture() {
  return { stat: 'ok', tables: [{ fields: ['代號', '名稱', '資餘額', '券餘額'], data: [['5483', '中美晶', '1', '1']] }] };
}

function tpexPeFixture() {
  return { stat: 'ok', tables: [{ fields: ['股票代號', '公司名稱', '本益比', '殖利率(%)', '股價淨值比'], data: [['5483', '中美晶', '1', '1', '1']] }] };
}

function tpexSblFixture(date) {
  const fields = ['股票代號', '股票名稱', '前日餘額', '賣出', '買進', '現券', '當日餘額', '限額', '前日餘額', '當日賣出', '當日還券', '當日調整數額', '當日餘額', '次一營業日可借券賣出限額', '備註'];
  return { stat: 'ok', date, tables: [{ fields, data: [fields.map((_, index) => index < 2 ? ['5483', '中美晶'][index] : '1')] }] };
}

function response(bytes, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
  };
}

function dateFromUrl(url) {
  const parsed = new URL(url);
  return (parsed.searchParams.get('date') ?? '').replaceAll('/', '-').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
}

function fixtureFetcher({
  calls = [],
  fail = () => false,
  invalidAnchor = () => false,
  tpexNonTrading = () => false,
  unavailableT86 = false,
  oldTwseSbl = false,
} = {}) {
  return async (url) => {
    calls.push(url);
    const date = dateFromUrl(url);
    if (fail(url, date)) return response(Buffer.from('retry'), 503);
    if (url.includes('/MI_INDEX?')) {
      return response(invalidAnchor(date) ? Buffer.from('{broken') : jsonBytes(miIndexFixture()));
    }
    if (url.includes('/fund/T86?')) {
      return response(jsonBytes(unavailableT86
        ? { stat: '查詢日期小於101年05月02日，請重新查詢!' }
        : t86Fixture()));
    }
    if (url.includes('/MI_MARGN?')) return response(jsonBytes(miMargnFixture()));
    if (url.includes('/BWIBBU_d?')) return response(jsonBytes(bwibbuFixture()));
    if (url.includes('/TWT93U?')) return response(jsonBytes(twseSblFixture(date.replaceAll('-', ''), oldTwseSbl)));
    if (url.includes('/afterTrading/dailyQuotes?')) return response(jsonBytes(tpexDailyFixture(tpexNonTrading(date))));
    if (url.includes('/insti/dailyTrade?')) return response(jsonBytes(tpexInstiFixture()));
    if (url.includes('/margin/balance?')) return response(jsonBytes(tpexMarginFixture()));
    if (url.includes('/afterTrading/peQryDate?')) return response(jsonBytes(tpexPeFixture()));
    if (url.includes('/margin/sbl?')) return response(jsonBytes(tpexSblFixture(date.replaceAll('-', ''))));
    throw new Error(`unexpected URL ${url}`);
  };
}

async function run(root, options = {}) {
  return runHistoryBackfill({
    rootDir: root,
    fromIso: '2021-01-01',
    toIso: '2021-01-01',
    delayMs: 0,
    maxRetries: 0,
    fetchImpl: fixtureFetcher(),
    sleepImpl: async () => {},
    logger: silentLogger,
    now: fixedNow,
    ...options,
  });
}

async function exists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function progress(root) {
  return JSON.parse(await readFile(join(root, 'data/history-backfill/progress.json'), 'utf8'));
}

test('history runner stores byte-identical raw only and leaves legacy checkpoint untouched', async () => {
  await withTempDir(async (root) => {
    const legacy = Buffer.from('{"lastDate":"keep-me"}\n');
    await writeFile(join(root, '.backfill-progress.json'), legacy);
    const calls = [];
    const fetchImpl = fixtureFetcher({ calls });
    const result = await run(root, { fromIso: '2021-01-01', toIso: '2021-01-03', fetchImpl });
    assert.equal(result.status, 'DONE');
    const path = rawPath(root, 'twse/mi_index_hist', '2021-01-03');
    assert.deepEqual(await readFile(path), jsonBytes(miIndexFixture()));
    assert.equal(await exists(join(root, 'data/derived')), false);
    assert.deepEqual(await readFile(join(root, '.backfill-progress.json')), legacy);
    assert.equal(calls.length, 30);
  });
});

test('network pause resumes the same date without requesting a completed newer date', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    let interrupted = true;
    const fetchImpl = fixtureFetcher({ calls, fail: (url, date) => interrupted && date === '2021-01-02' && url.includes('/MI_INDEX?') });
    const first = await run(root, { fromIso: '2021-01-01', toIso: '2021-01-03', fetchImpl });
    assert.equal(first.status, 'PAUSED_NETWORK');
    assert.equal(first.progress.nextDate, '2021-01-02');
    const newerCalls = calls.filter((url) => dateFromUrl(url) === '2021-01-03').length;
    interrupted = false;
    const second = await run(root, { fromIso: '2021-01-01', toIso: '2021-01-03', fetchImpl });
    assert.equal(second.status, 'DONE');
    assert.equal(calls.filter((url) => dateFromUrl(url) === '2021-01-03').length, newerCalls);
  });
});

test('a legal no-row T86 response is unavailable and does not stop later dates', async () => {
  await withTempDir(async (root) => {
    const result = await run(root, {
      fromIso: '2012-04-30',
      toIso: '2012-05-01',
      fetchImpl: fixtureFetcher({ unavailableT86: true }),
    });
    assert.equal(result.status, 'DONE');
    assert.equal(result.progress.endpoints['twse/t86_hist'].unavailable, 2);
    assert.equal(await exists(rawPath(root, 'twse/t86_hist', '2012-05-01')), false);
  });
});

test('a data-bearing rejected TWT93U response is quarantined byte-for-byte', async () => {
  await withTempDir(async (root) => {
    const expected = jsonBytes(twseSblFixture('20061016', true));
    const result = await run(root, {
      fromIso: '2006-10-16',
      toIso: '2006-10-16',
      fetchImpl: fixtureFetcher({ oldTwseSbl: true }),
    });
    assert.equal(result.progress.endpoints['twse/sbl_hist'].quarantined, 1);
    assert.equal(await exists(rawPath(root, 'twse/sbl_hist', '2006-10-16')), false);
    assert.deepEqual(await readFile(join(root, 'data/history-backfill/quarantine/twse/sbl_hist/2006/2006-10-16.json')), expected);
  });
});

test('a non-trading TPEX anchor skips every other TPEX endpoint', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    await run(root, { fetchImpl: fixtureFetcher({ calls, tpexNonTrading: () => true }) });
    const tpexCalls = calls.filter((url) => url.includes('tpex.org.tw'));
    assert.equal(tpexCalls.length, 1);
    assert.match(tpexCalls[0], /dailyQuotes/);
  });
});

test('five consecutive anchor anomalies block, require opt-in resume, and then recover', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    let invalid = true;
    const fetchImpl = fixtureFetcher({ calls, invalidAnchor: () => invalid });
    const first = await run(root, { fromIso: '2021-01-01', toIso: '2021-01-05', fetchImpl });
    assert.equal(first.status, 'BLOCKED');
    assert.equal(first.exitCode, 1);
    assert.deepEqual(first.progress.pendingDates, [
      '2021-01-05',
      '2021-01-04',
      '2021-01-03',
      '2021-01-02',
      '2021-01-01',
    ]);
    const blockedCalls = calls.length;
    const second = await run(root, { fromIso: '2021-01-01', toIso: '2021-01-05', fetchImpl });
    assert.equal(second.status, 'BLOCKED');
    assert.equal(calls.length, blockedCalls);
    invalid = false;
    const resumed = await run(root, { fromIso: '2021-01-01', toIso: '2021-01-05', fetchImpl, resumeBlocked: true });
    assert.equal(resumed.status, 'DONE');
    assert.ok(calls.length > blockedCalls);
  });
});

test('transient anchor anomalies are retried newest-first and removed from pendingDates', async () => {
  await withTempDir(async (root) => {
    const transient = new Set(['2021-01-03', '2021-01-02']);
    const attempts = new Map();
    const invalidAnchor = (date) => {
      const count = (attempts.get(date) ?? 0) + 1;
      attempts.set(date, count);
      return transient.has(date) && count === 1;
    };
    const result = await run(root, {
      fromIso: '2021-01-01',
      toIso: '2021-01-04',
      fetchImpl: fixtureFetcher({ invalidAnchor }),
    });
    assert.equal(result.status, 'DONE');
    assert.deepEqual(result.progress.pendingDates, []);
    assert.equal(result.progress.days.done, 4);
    assert.equal(await exists(rawPath(root, 'twse/mi_index_hist', '2021-01-03')), true);
    assert.equal(await exists(rawPath(root, 'twse/mi_index_hist', '2021-01-02')), true);
    assert.deepEqual(
      result.progress.recentDays.slice(-2).map((day) => day.date),
      ['2021-01-03', '2021-01-02'],
    );
  });
});

test('a persistent pending anchor anomaly blocks instead of reporting DONE', async () => {
  await withTempDir(async (root) => {
    const result = await run(root, {
      fromIso: '2021-01-01',
      toIso: '2021-01-03',
      fetchImpl: fixtureFetcher({ invalidAnchor: (date) => date === '2021-01-02' }),
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.progress.pendingDates, ['2021-01-02']);
    assert.equal(result.progress.days.done, 2);
    assert.equal(await exists(rawPath(root, 'twse/mi_index_hist', '2021-01-02')), false);
  });
});

test('a normal fifth date resets four consecutive anchor anomalies', async () => {
  await withTempDir(async (root) => {
    const bad = new Set(['2021-01-05', '2021-01-04', '2021-01-03', '2021-01-02']);
    const attempts = new Map();
    const result = await run(root, {
      fromIso: '2021-01-01',
      toIso: '2021-01-05',
      fetchImpl: fixtureFetcher({
        invalidAnchor: (date) => {
          const count = (attempts.get(date) ?? 0) + 1;
          attempts.set(date, count);
          return bad.has(date) && count === 1;
        },
      }),
    });
    assert.equal(result.status, 'DONE');
    assert.equal(result.progress.consecutiveAnchorFailures, 0);
    assert.deepEqual(result.progress.pendingDates, []);
  });
});

test('a live lock causes no requests and no progress mutation', async () => {
  await withTempDir(async (root) => {
    const lock = join(root, 'data/history-backfill/.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    const progressPath = join(root, 'data/history-backfill/progress.json');
    const sentinel = Buffer.from('{"sentinel":true}\n');
    await writeFile(progressPath, sentinel);
    const calls = [];
    const result = await run(root, { fetchImpl: fixtureFetcher({ calls }) });
    assert.equal(result.status, 'LOCKED');
    assert.equal(calls.length, 0);
    assert.deepEqual(await readFile(progressPath), sentinel);
    await rm(lock, { recursive: true, force: true });
  });
});

test('a failed atomic lock publication preserves the other owner and cleans only its temp directory', async () => {
  await withTempDir(async (root) => {
    const historyDir = join(root, 'data/history-backfill');
    const lock = join(historyDir, '.lock');
    const ownerBytes = Buffer.from(JSON.stringify({
      pid: process.pid,
      startedAt: '2026-10-16T00:00:00.000Z',
      token: 'other-owner-token',
    }));
    let intercepted = false;
    const lockRenameImpl = async (from, to) => {
      if (!intercepted && to === lock) {
        intercepted = true;
        await mkdir(lock);
        await writeFile(join(lock, 'owner.json'), ownerBytes);
        const error = new Error('simulated publication conflict');
        error.code = 'ENOTEMPTY';
        throw error;
      }
      return rename(from, to);
    };
    const calls = [];
    const result = await run(root, {
      fetchImpl: fixtureFetcher({ calls }),
      lockRenameImpl,
    });
    assert.equal(result.status, 'LOCKED');
    assert.equal(calls.length, 0);
    assert.deepEqual(await readFile(join(lock, 'owner.json')), ownerBytes);
    assert.deepEqual(
      (await readdir(historyDir)).filter((name) => name.startsWith('.lock.tmp-')),
      [],
    );
    await rm(lock, { recursive: true, force: true });
  });
});

test('a stale lock is taken over and removed after completion', async () => {
  await withTempDir(async (root) => {
    const lock = join(root, 'data/history-backfill/.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999 }));
    const logs = [];
    const result = await run(root, { logger: { log: (line) => logs.push(line), warn() {} } });
    assert.equal(result.status, 'DONE');
    assert.equal(await exists(lock), false);
    assert.ok(logs.some((line) => line.includes('stale lock from pid 999999999')));
  });
});

test('the lock is released when an injected dependency throws', async () => {
  await withTempDir(async (root) => {
    await assert.rejects(
      run(root, { sleepImpl: async () => { throw new Error('injected sleep failure'); } }),
      /injected sleep failure/,
    );
    assert.equal(await exists(join(root, 'data/history-backfill/.lock')), false);
  });
});

test('the daily pause window writes PAUSED_DAILY_WINDOW without requests', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    const result = await run(root, {
      fetchImpl: fixtureFetcher({ calls }),
      now: () => new Date('2026-10-16T13:30:00.000Z'),
    });
    assert.equal(result.status, 'PAUSED_DAILY_WINDOW');
    assert.equal(calls.length, 0);
    assert.equal((await progress(root)).status, 'PAUSED_DAILY_WINDOW');
  });
});

test('the runtime limit stops only after a completed day', async () => {
  await withTempDir(async (root) => {
    const result = await run(root, { fromIso: '2021-01-01', toIso: '2021-01-02', maxMinutes: 0 });
    assert.equal(result.status, 'IN_PROGRESS');
    assert.equal(result.progress.days.done, 1);
    assert.equal(result.progress.nextDate, '2021-01-01');
  });
});

test('dates run newest-first, DONE reruns make zero requests, and valid raw counts as exists', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    const fetchImpl = fixtureFetcher({ calls });
    const first = await run(root, { fromIso: '2021-01-01', toIso: '2021-01-02', fetchImpl });
    assert.equal(first.status, 'DONE');
    assert.deepEqual(first.progress.recentDays.map((day) => day.date), ['2021-01-02', '2021-01-01']);
    const count = calls.length;
    const second = await run(root, { fromIso: '2021-01-01', toIso: '2021-01-02', fetchImpl });
    assert.equal(second.status, 'DONE');
    assert.equal(calls.length, count);

    await rm(join(root, 'data/history-backfill/progress.json'));
    const third = await run(root, { fromIso: '2021-01-01', toIso: '2021-01-02', fetchImpl });
    assert.equal(calls.length, count);
    assert.equal(third.progress.endpoints['twse/mi_index_hist'].exists, 2);
  });
});

test('changing the requested range resets cursor and statistics but reuses valid raw', async () => {
  await withTempDir(async (root) => {
    const calls = [];
    const fetchImpl = fixtureFetcher({ calls });
    await run(root, { fromIso: '2021-01-01', toIso: '2021-01-02', fetchImpl });
    const count = calls.length;
    const reset = await run(root, { fromIso: '2021-01-02', toIso: '2021-01-02', fetchImpl });
    assert.equal(reset.status, 'DONE');
    assert.equal(reset.progress.days.total, 1);
    assert.equal(reset.progress.days.done, 1);
    assert.equal(reset.progress.endpoints['twse/mi_index_hist'].written, 0);
    assert.equal(reset.progress.endpoints['twse/mi_index_hist'].exists, 1);
    assert.equal(calls.length, count);
  });
});

test('progress has required counters and caps recent days, failures, and launches at 50', async () => {
  await withTempDir(async (root) => {
    const result = await run(root, {
      fromIso: '2021-01-01',
      toIso: '2021-02-20',
      fetchImpl: fixtureFetcher({ tpexNonTrading: () => true }),
    });
    assert.equal(result.progress.schemaVersion, 1);
    assert.equal(result.progress.days.total, 51);
    assert.equal(result.progress.days.done, 51);
    assert.deepEqual(result.progress.pendingDates, []);
    assert.equal(result.progress.recentDays.length, 50);
    assert.deepEqual(Object.keys(result.progress.endpoints['twse/t86_hist']), ['written', 'exists', 'unavailable', 'quarantined', 'failed']);
    assert.equal(result.progress.failures.length, 0);
    assert.equal(result.progress.launches.length, 1);
  });
});

test('CLI rejects unknown flags, reversed/future ranges, and bare numeric flags', async () => {
  await withTempDir(async (root) => {
    const cli = join(REPO_ROOT, 'scripts/history-backfill.mjs');
    const cases = [
      ['--unknown'],
      ['--from', '2021-01-02', '--to', '2021-01-01'],
      ['--from', '2099-01-01', '--to', '2099-01-02'],
      ['--from', '2021-01-01', '--to', '2021-01-01', '--delay-ms'],
    ];
    for (const args of cases) {
      const child = spawnSync(process.execPath, [cli, ...args, '--out', root], { cwd: REPO_ROOT, encoding: 'utf8' });
      assert.notEqual(child.status, 0, `${args.join(' ')} unexpectedly succeeded`);
    }
  });
});
