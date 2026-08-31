import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKFILL_ENDPOINTS } from '../scripts/endpoints.mjs';
import {
  COVERAGE_SOURCES,
  collectCoveredDates,
  detectGaps,
} from '../scripts/detect-gaps.mjs';

const silentLogger = { log() {}, warn() {} };
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-gaps-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeRaw(root, sourceDataset, date, body = '{}\n') {
  const path = join(root, 'data', 'raw', sourceDataset, date.slice(0, 4), `${date}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

async function fixtureBytes(name) {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url));
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

const closeSource = {
  twse: 'twse/stock_day_all',
  tpex: 'tpex/mainboard_close',
};

async function rawHistNamespaces(rootDir = repoRoot) {
  const namespaces = [];
  for (const market of ['twse', 'tpex']) {
    const entries = await readdir(join(rootDir, 'data', 'raw', market), { withFileTypes: true });
    namespaces.push(...entries
      .filter((entry) => entry.isDirectory() && /_hist$/.test(entry.name))
      .map((entry) => `${market}/${entry.name}`));
  }
  return namespaces.sort();
}

test('every backfill endpoint declares a supported cadence', () => {
  const allowed = new Set(['daily', 'monthly', 'quarterly']);
  for (const [key, endpoint] of Object.entries(BACKFILL_ENDPOINTS)) {
    assert.equal(allowed.has(endpoint.cadence), true, `${key} has invalid cadence: ${endpoint.cadence}`);
  }
});

test('every raw historical namespace on disk is registered as a backfill endpoint', async () => {
  const registered = new Set(Object.values(BACKFILL_ENDPOINTS).map((endpoint) => endpoint.sourceDataset));
  const unregistered = (await rawHistNamespaces()).filter((source) => !registered.has(source));
  assert.deepEqual(unregistered, [], `unregistered raw historical namespaces: ${unregistered.join(',')}`);
});

test('coverage sources exactly match daily backfill endpoints plus each market close source', () => {
  for (const market of ['twse', 'tpex']) {
    const dailyNamespaces = Object.values(BACKFILL_ENDPOINTS)
      .filter((endpoint) => endpoint.cadence === 'daily' && endpoint.sourceDataset.startsWith(`${market}/`))
      .map((endpoint) => endpoint.sourceDataset);
    dailyNamespaces.push(closeSource[market]);
    assert.deepEqual(
      [...COVERAGE_SOURCES[market]].sort(),
      dailyNamespaces.sort(),
      `${market} coverage sources drifted from data/raw namespaces`,
    );
  }
});

test('coverage uses market-local unions and both close endpoints prevent HF2 false gaps', async () => {
  await withTempDir(async (root) => {
    await writeRaw(root, 'twse/stock_day_all', '2026-08-17');
    await writeRaw(root, 'tpex/insti_hist', '2026-08-17');
    await writeRaw(root, 'twse/t86_hist', '2026-08-18');
    await writeRaw(root, 'tpex/mainboard_close', '2026-08-18');

    const covered = await collectCoveredDates(root);
    assert.equal(covered.twse.has('2026-08-17'), true);
    assert.equal(covered.tpex.has('2026-08-18'), true);

    const withoutClose = {
      twse: COVERAGE_SOURCES.twse.filter((source) => source !== 'twse/stock_day_all'),
      tpex: COVERAGE_SOURCES.tpex.filter((source) => source !== 'tpex/mainboard_close'),
    };
    const falseGapCoverage = await collectCoveredDates(root, withoutClose);
    assert.equal(falseGapCoverage.twse.has('2026-08-17'), false);
    assert.equal(falseGapCoverage.tpex.has('2026-08-18'), false);
  });
});

test('official MI_INDEX shapes distinguish two non-trading days from a trading day and cache exact stat text', async () => {
  await withTempDir(async (root) => {
    const cases = [
      ['2026-02-17', 'twse-mi-index-holiday.json', 0],
      ['2026-07-10', 'twse-mi-index-non-trading.json', 0],
      ['2026-08-28', 'twse-mi-index-trading.json', 1],
    ];
    for (const [date, fixture, expectedGaps] of cases) {
      const result = await detectGaps({
        rootDir: root,
        fromIso: date,
        toIso: date,
        delayMs: 0,
        fetchImpl: async () => responseFor(await fixtureBytes(fixture)),
        sleepImpl: async () => {},
        now: () => new Date('2026-08-29T00:00:00Z'),
        logger: silentLogger,
      });
      assert.equal(result.gaps.length, expectedGaps);
      if (expectedGaps) assert.deepEqual(result.gaps[0].markets, ['twse', 'tpex']);
    }
    const cache = JSON.parse(await readFile(join(root, '.gap-scan-cache.json'), 'utf8'));
    assert.deepEqual(cache, { nonTrading: {
      '2026-02-17': { stat: '很抱歉，沒有符合條件的資料!' },
      '2026-07-10': { stat: '很抱歉，沒有符合條件的資料!' },
    } });
  });
});

test('three isolated hole shapes report only the market with no legacy or close coverage', async () => {
  await withTempDir(async (root) => {
    for (const date of ['2026-08-19', '2026-08-20', '2026-08-21']) {
      await writeRaw(root, 'twse/mi_index_hist', date);
    }
    await writeRaw(root, 'tpex/mainboard_close', '2026-08-20');
    await writeRaw(root, 'tpex/insti_hist', '2026-08-21');

    const result = await detectGaps({
      rootDir: root,
      fromIso: '2026-08-19',
      toIso: '2026-08-21',
      delayMs: 0,
      fetchImpl: async () => responseFor(await fixtureBytes('twse-mi-index-trading.json')),
      sleepImpl: async () => {},
      now: () => new Date('2026-08-29T00:00:00Z'),
      logger: silentLogger,
    });

    assert.deepEqual(result.gaps, [{ date: '2026-08-19', markets: ['tpex'] }]);
    assert.equal(result.candidates.has('2026-08-20'), false);
    assert.equal(result.candidates.has('2026-08-21'), false);
  });
});

test('request failures and non-200 responses never create the non-trading cache', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('fixture network failure'); },
    async () => responseFor(Buffer.from('unavailable'), 503),
  ]) {
    await withTempDir(async (root) => {
      await assert.rejects(detectGaps({
        rootDir: root,
        fromIso: '2026-08-28',
        toIso: '2026-08-28',
        delayMs: 0,
        fetchImpl,
        sleepImpl: async () => {},
        now: () => new Date('2026-08-29T00:00:00Z'),
        logger: silentLogger,
      }), /fixture network failure|HTTP 503/);
      await assert.rejects(readFile(join(root, '.gap-scan-cache.json')), { code: 'ENOENT' });
    });
  }
});

test('gap candidates always exclude today and future weekdays before fetching', async () => {
  await withTempDir(async (root) => {
    let calls = 0;
    const result = await detectGaps({
      rootDir: root,
      fromIso: '2026-08-28',
      toIso: '2026-09-01',
      delayMs: 0,
      fetchImpl: async () => { calls += 1; },
      sleepImpl: async () => {},
      now: () => new Date('2026-08-28T00:00:00Z'),
      logger: silentLogger,
    });
    assert.equal(result.candidates.size, 0);
    assert.equal(calls, 0);
  });
});
