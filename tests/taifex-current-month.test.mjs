import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  foreignFuturesDefaultRange,
  runForeignFuturesBackfill,
} from '../scripts/backfill-foreign-futures.mjs';
import { runPcrBackfill } from '../scripts/backfill-pcr.mjs';
import { stableDerivedString } from '../scripts/lib/derived.mjs';

const silentLogger = { log() {}, warn() {} };
const SUNDAY_NOW = () => new Date('2026-09-20T04:00:00Z');
const PCR_EVIDENCE_BASE64 =
  'pOm0wSy95sV2pqil5rZxLLZSxXamqKXmtnEstlK95sV2pqil5rZxpPGydiUsvebFdqW8pa2t3LZxLLZSxXalvKWtrdy2cSy2Ur3mxXalvKWtrdy2caTxsnYlDQoyMDI2LzA5LzE4LDMyOTkwMiwzMzIwNDcsOTkuMzUsMzU0MTUsNDY0MDEsNzYuMzIsDQoyMDI2LzA5LzE3LDIwNDQxMCwxOTA2MTYsMTA3LjI0LDU4NDU3LDc2NDE1LDc2LjUwLA0KMjAyNi8wOS8xNiwzNzUwODcsMzUyNjU2LDEwNi4zNiwzMTA5OCwzNzIxNSw4My41NiwNCjIwMjYvMDkvMTUsMTcyNTQ3LDE2MjEwMiwxMDYuNDQsODE1NTYsOTQ5NTYsODUuODksDQoyMDI2LzA5LzE0LDE1MDE4MCwxNDAyNDIsMTA3LjA5LDcwNjg3LDgwMjkwLDg4LjA0LA0KMjAyNi8wOS8xMSwzMzUzNTgsMzY2Mjc5LDkxLjU2LDUyNjQxLDYwMDI1LDg3LjcwLA0KMjAyNi8wOS8xMCwxNTM1MjYsMTYyNjcwLDk0LjM4LDY5MzYzLDgzOTA2LDgyLjY3LA0KMjAyNi8wOS8wOSwzODM3MDMsMzQ5NTIzLDEwOS43OCw1MTI0Niw1MzE5NCw5Ni4zNCwNCjIwMjYvMDkvMDgsMTUwODMwLDE0NTgyOCwxMDMuNDMsODcyMjYsODI4OTMsMTA1LjIzLA0KMjAyNi8wOS8wNywxNjEyMTksMTMwMTMyLDEyMy44OSw3Mjc5MCw2NTE3MiwxMTEuNjksDQoyMDI2LzA5LzA0LDM1NjIxOSwzNjE4MTcsOTguNDUsNDgxNjIsNDgyNTgsOTkuODAsDQoyMDI2LzA5LzAzLDIwMDQ1OSwxOTk5NDIsMTAwLjI2LDY1NzI2LDg1MTgwLDc3LjE2LA0KMjAyNi8wOS8wMiwzMjI4NDEsMzc3Nzk4LDg1LjQ1LDQ1MDc2LDUzNzI0LDgzLjkwLA0KMjAyNi8wOS8wMSwyMDI3OTAsMTgxNjk3LDExMS42MSw4Mjk0OCw3NTM3OSwxMTAuMDQsDQo=';
const BIG5_FOREIGN_HEADER = Buffer.from(
  'a4e9b4c12cb0d3ab7ea657bad92ca8ada5f7a74f2ca668a4e8a5e6a9f6a466bcc62ca668a4e8a5e6a9f6abb4acf9aaf7c34228a464a4b8292caac5a4e8a5e6a9f6a466bcc62caac5a4e8a5e6a9f6abb4acf9aaf7c34228a464a4b8292ca668aac5a5e6a9f6a466bcc6b262c3422ca668aac5a5e6a9f6abb4acf9aaf7c342b262c34228a464a4b8292ca668a4e8a5bca5adaddca466bcc62ca668a4e8a5bca5adaddcabb4acf9aaf7c34228a464a4b8292caac5a4e8a5bca5adaddca466bcc62caac5a4e8a5bca5adaddcabb4acf9aaf7c34228a464a4b8292ca668aac5a5bca5adaddca466bcc6b262c3422ca668aac5a5bca5adaddcabb4acf9aaf7c342b262c34228a464a4b829',
  'hex',
);
const BIG5_IDENTITIES = [
  Buffer.from('a6dbc0e7b0d3', 'hex'),
  Buffer.from('a7ebab48', 'hex'),
  Buffer.from('a57eb8eaa4ceb3b0b8ea', 'hex'),
];

function pcrEvidenceBytes() {
  const bytes = Buffer.from(PCR_EVIDENCE_BASE64, 'base64');
  assert.equal(bytes.length, 818);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '65f5396d6781a2baa24e2e302f36f74004a3064583b0def7cd4e4d933649905b',
  );
  return bytes;
}

function foreignFixture(dates) {
  const chunks = [BIG5_FOREIGN_HEADER, Buffer.from('\r\n')];
  for (const date of dates) {
    for (let index = 0; index < BIG5_IDENTITIES.length; index += 1) {
      chunks.push(Buffer.from(`${date},TX,`));
      chunks.push(BIG5_IDENTITIES[index]);
      chunks.push(Buffer.from(`,10,20,30,40,50,60,100000,80,90000,100,${-80000 - index},120\r\n`));
    }
  }
  return Buffer.concat(chunks);
}

const SEPTEMBER_FOREIGN = foreignFixture(['2026/09/18', '2026/09/01']);
const AUGUST_FOREIGN = foreignFixture(['2026/08/31']);
const JULY_FOREIGN = foreignFixture(['2026/07/31']);
const AUGUST_PCR = Buffer.from('2026/08/31,1,1,100,1,1,100,\r\n');

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-ticket-233-test-'));
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

async function writeMonthlyRaw(root, dataset, monthKey, bytes) {
  const path = join(root, 'data', 'raw', dataset, monthKey.slice(0, 4), `${monthKey}.csv`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function runCurrentForeign(root, fetchImpl, options = {}) {
  return runForeignFuturesBackfill({
    rootDir: root,
    fromMonth: '2026-09',
    toMonth: '2026-09',
    now: SUNDAY_NOW,
    delayMs: 0,
    maxRetries: 0,
    fetchImpl,
    sleepImpl: async () => {},
    logger: silentLogger,
    ...options,
  });
}

test('TICKET-233 A2 uses the last date in current-month PCR raw as the foreign-futures query end', async (t) => {
  await withTempDir(async (root) => {
    await writeMonthlyRaw(root, 'taifex/pcr', '2026-09', pcrEvidenceBytes());
    let requestBody;
    const summary = await runCurrentForeign(root, async (_url, options) => {
      requestBody = options.body;
      return responseFor(SEPTEMBER_FOREIGN);
    }, {
      now: () => new Date('2026-09-18T04:00:00Z'),
      applyTaifexForeignFuturesMonthImpl: async () => ({ market: false }),
    });
    const query = Object.fromEntries(new URLSearchParams(requestBody));
    assert.equal(query.queryEndDate, '2026/09/18');
    assert.equal(summary.requests, 1);
    t.diagnostic(`A2_QUERY_END=${query.queryEndDate} PCR_EVIDENCE_BYTES=818`);
  });
});

test('TICKET-233 A3 does not substitute Sunday today for the last PCR trading date', async (t) => {
  await withTempDir(async (root) => {
    await writeMonthlyRaw(root, 'taifex/pcr', '2026-09', pcrEvidenceBytes());
    let requestBody;
    await runCurrentForeign(root, async (_url, options) => {
      requestBody = options.body;
      return responseFor(SEPTEMBER_FOREIGN);
    }, {
      applyTaifexForeignFuturesMonthImpl: async () => ({ market: false }),
    });
    const queryEndDate = new URLSearchParams(requestBody).get('queryEndDate');
    assert.equal(queryEndDate, '2026/09/18');
    assert.notEqual(queryEndDate, '2026/09/20');
    t.diagnostic(`A3_TODAY=2026/09/20 A3_QUERY_END=${queryEndDate}`);
  });
});

test('TICKET-233 A4 keeps calendar month-end for historical foreign-futures requests', async (t) => {
  await withTempDir(async (root) => {
    let requestBody;
    await runForeignFuturesBackfill({
      rootDir: root,
      fromMonth: '2026-07',
      toMonth: '2026-07',
      now: SUNDAY_NOW,
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: async (_url, options) => {
        requestBody = options.body;
        return responseFor(JULY_FOREIGN);
      },
      sleepImpl: async () => {},
      logger: silentLogger,
      applyTaifexForeignFuturesMonthImpl: async () => ({ market: false }),
    });
    const queryEndDate = new URLSearchParams(requestBody).get('queryEndDate');
    assert.equal(queryEndDate, '2026/07/31');
    t.diagnostic(`A4_QUERY_END=${queryEndDate}`);
  });
});

test('TICKET-233 A5 fails before fetch when current-month PCR raw is missing or has no rows', async (t) => {
  await withTempDir(async (root) => {
    let requests = 0;
    await assert.rejects(
      runCurrentForeign(root, async () => {
        requests += 1;
        return responseFor(SEPTEMBER_FOREIGN);
      }),
      /PCR raw is required but missing/,
    );
    assert.equal(requests, 0);

    await writeMonthlyRaw(root, 'taifex/pcr', '2026-09', Buffer.from('<html>no rows</html>'));
    await assert.rejects(
      runCurrentForeign(root, async () => {
        requests += 1;
        return responseFor(SEPTEMBER_FOREIGN);
      }),
      /PCR raw has 0 data rows for the month/,
    );
    assert.equal(requests, 0);
    t.diagnostic('A5_MISSING=FAILED A5_ZERO_ROWS=FAILED A5_REQUESTS=0');
  });
});

test('TICKET-233 A6 refreshes existing current-month PCR and foreign-futures raw', async (t) => {
  await withTempDir(async (root) => {
    const pcrRoot = join(root, 'pcr');
    const pcrBytes = pcrEvidenceBytes();
    await writeMonthlyRaw(pcrRoot, 'taifex/pcr', '2026-09', pcrBytes);
    const pcr = await runPcrBackfill({
      rootDir: pcrRoot,
      fromMonth: '2026-09',
      toMonth: '2026-09',
      now: SUNDAY_NOW,
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: async () => responseFor(pcrBytes),
      sleepImpl: async () => {},
      logger: silentLogger,
      applyTaifexPcrMonthImpl: async () => ({ market: false }),
    });
    assert.equal(pcr.requests, 1);
    assert.equal(pcr.skipped, 0);
    assert.equal(pcr.rawWritten, 0);

    const foreignRoot = join(root, 'foreign');
    await writeMonthlyRaw(foreignRoot, 'taifex/pcr', '2026-09', pcrBytes);
    await writeMonthlyRaw(foreignRoot, 'taifex/foreign_futures', '2026-09', SEPTEMBER_FOREIGN);
    const foreign = await runCurrentForeign(
      foreignRoot,
      async () => responseFor(SEPTEMBER_FOREIGN),
      { applyTaifexForeignFuturesMonthImpl: async () => ({ market: false }) },
    );
    assert.equal(foreign.requests, 1);
    assert.equal(foreign.skipped, 0);
    assert.equal(foreign.rawWritten, 0);
    t.diagnostic(`A6_PCR_REQUESTS=${pcr.requests} A6_FOREIGN_REQUESTS=${foreign.requests}`);
  });
});

test('TICKET-233 A7 refreshes only the current month and checkpoints historical months', async (t) => {
  await withTempDir(async (root) => {
    const pcrRoot = join(root, 'pcr');
    const pcrBytes = pcrEvidenceBytes();
    await writeMonthlyRaw(pcrRoot, 'taifex/pcr', '2026-08', AUGUST_PCR);
    await writeMonthlyRaw(pcrRoot, 'taifex/pcr', '2026-09', pcrBytes);
    const pcr = await runPcrBackfill({
      rootDir: pcrRoot,
      fromMonth: '2026-08',
      toMonth: '2026-09',
      now: SUNDAY_NOW,
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: async () => responseFor(pcrBytes),
      sleepImpl: async () => {},
      logger: silentLogger,
      applyTaifexPcrMonthImpl: async () => ({ market: false }),
    });
    assert.equal(pcr.months, 2);
    assert.equal(pcr.requests, 1);
    assert.equal(pcr.skipped, 1);
    assert.notEqual(pcr.requests, pcr.months);

    const foreignRoot = join(root, 'foreign');
    await writeMonthlyRaw(foreignRoot, 'taifex/pcr', '2026-09', pcrBytes);
    await writeMonthlyRaw(foreignRoot, 'taifex/foreign_futures', '2026-08', AUGUST_FOREIGN);
    await writeMonthlyRaw(foreignRoot, 'taifex/foreign_futures', '2026-09', SEPTEMBER_FOREIGN);
    const foreign = await runForeignFuturesBackfill({
      rootDir: foreignRoot,
      fromMonth: '2026-08',
      toMonth: '2026-09',
      now: SUNDAY_NOW,
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: async () => responseFor(SEPTEMBER_FOREIGN),
      sleepImpl: async () => {},
      logger: silentLogger,
      applyTaifexForeignFuturesMonthImpl: async () => ({ market: false }),
    });
    assert.equal(foreign.months, 2);
    assert.equal(foreign.requests, 1);
    assert.equal(foreign.skipped, 1);
    assert.notEqual(foreign.requests, foreign.months);
    t.diagnostic(`A7_PCR=${pcr.requests}/${pcr.months} A7_FOREIGN=${foreign.requests}/${foreign.months} A7_SKIPPED=${pcr.skipped}/${foreign.skipped}`);
  });
});

test('TICKET-233 A8 current-month refresh is byte-idempotent and preserves PCR and VIX series', async (t) => {
  await withTempDir(async (root) => {
    const pcrBytes = pcrEvidenceBytes();
    const pcrPath = await writeMonthlyRaw(root, 'taifex/pcr', '2026-09', pcrBytes);
    const marketPath = join(root, 'data', 'derived', 'market.json');
    const preservedPcr = { cols: ['d', 'vol', 'oi'], rows: [[20260918, 99.35, 76.32]] };
    const preservedVix = { cols: ['d', 'vix'], rows: [[20260918, 21.22]] };
    await mkdir(dirname(marketPath), { recursive: true });
    await writeFile(marketPath, stableDerivedString({
      updated: '2026-09-18',
      taifex: { pcr: preservedPcr, vix: preservedVix },
    }));

    const first = await runCurrentForeign(root, async () => responseFor(SEPTEMBER_FOREIGN));
    const firstMarketBytes = await readFile(marketPath);
    const second = await runCurrentForeign(root, async () => responseFor(SEPTEMBER_FOREIGN));
    const secondMarketBytes = await readFile(marketPath);
    const market = JSON.parse(secondMarketBytes);

    assert.equal(first.rawWritten, 1);
    assert.equal(second.requests, 1);
    assert.equal(second.rawWritten, 0);
    assert.equal(second.derivedWritten, 0);
    assert.deepEqual(secondMarketBytes, firstMarketBytes);
    assert.deepEqual(market.taifex.pcr, preservedPcr);
    assert.deepEqual(market.taifex.vix, preservedVix);
    assert.deepEqual(await readFile(pcrPath), pcrBytes);
    t.diagnostic(`A8_SECOND_RAW_WRITTEN=${second.rawWritten} A8_SECOND_DERIVED_WRITTEN=${second.derivedWritten} A8_MARKET_BYTES_EQUAL=${secondMarketBytes.equals(firstMarketBytes)} A8_PCR_VIX_PRESERVED=true`);
  });
});

test('TICKET-233 current foreign-futures default range includes the current Taipei month', (t) => {
  const range = foreignFuturesDefaultRange(SUNDAY_NOW);
  assert.deepEqual(range, { fromMonth: '2023-10', toMonth: '2026-09' });
  t.diagnostic(`DEFAULT_RANGE=${JSON.stringify(range)}`);
});
