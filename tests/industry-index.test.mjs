import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildDerived } from '../scripts/build-derived.mjs';
import { buildIndustryIndex } from '../scripts/build-industry-index.mjs';
import {
  ENDPOINTS,
  BACKFILL_ENDPOINTS,
  REFERENCE_ENDPOINTS,
  SERIES_ENDPOINTS,
} from '../scripts/endpoints.mjs';
import {
  applyIndustryIndex,
  latestCompanyIndustryRows,
} from '../scripts/lib/derived.mjs';
import {
  industryNameBackfillOptionsFromArgs,
  runIndustryNameBackfill,
} from '../scripts/backfill-industry-names.mjs';
import { runSnapshot } from '../scripts/run.mjs';

const execFile = promisify(execFileCallback);
const backfillScript = join(process.cwd(), 'scripts', 'backfill-industry-names.mjs');

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-industry-index-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(root, dataset, date, value, suffix = '') {
  const dir = join(root, 'data', 'raw', dataset, date.slice(0, 4));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${date}${suffix}.json`), JSON.stringify(value));
}

function industryPayload(name) {
  return { stat: 'OK', tables: [{ title: `115年10月16日 每日收盤行情(${name})`, fields: [], data: [] }] };
}

function capitalRows() {
  return {
    twse: [
      { '公司代號': ' 1101 ', '產業別': '01' },
      { '公司代號': '6488', '產業別': '24' },
      { '公司代號': '123456', '產業別': '99' },
    ],
    tpex: [
      { SecuritiesCompanyCode: '6488', SecuritiesIndustryCode: '33' },
      { SecuritiesCompanyCode: '8069', SecuritiesIndustryCode: '32' },
      { SecuritiesCompanyCode: '654321', SecuritiesIndustryCode: '98' },
    ],
  };
}

async function seedCapital(root) {
  const rows = capitalRows();
  await writeJson(root, 'twse/company_capital', '2026-10-14', [{ '公司代號': 'OLD', '產業別': '02' }]);
  await writeJson(root, 'twse/company_capital', '2026-10-15', rows.twse);
  await writeJson(root, 'tpex/company_capital', '2026-10-14', rows.tpex);
}

function response(body, status = 200) {
  const bytes = Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test('industry reference endpoint is isolated from scheduled and backfill registries', () => {
  const endpoint = REFERENCE_ENDPOINTS.twse_industry_mi_index;
  assert.equal(endpoint.sourceDataset, 'twse/industry_mi_index');
  assert.equal(endpoint.url('20261016', '24'), 'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20261016&type=24&response=json');
  assert.equal(ENDPOINTS.some((item) => item.sourceDataset === endpoint.sourceDataset), false);
  assert.equal(SERIES_ENDPOINTS.some((item) => item.sourceDataset === endpoint.sourceDataset), false);
  assert.equal(Object.values(BACKFILL_ENDPOINTS).some((item) => item.sourceDataset === endpoint.sourceDataset), false);
});

test('latest company industry rows use market-specific fields, newest raw, id filter, and TWSE priority', async () => {
  await withTempRoot(async (root) => {
    await seedCapital(root);
    assert.deepEqual(await latestCompanyIndustryRows(root), {
      updated: '2026-10-15',
      rows: [
        ['1101', 'twse', '01'],
        ['6488', 'twse', '24'],
        ['8069', 'tpex', '32'],
      ],
      codes: ['01', '24', '32', '33', '98', '99'],
    });
  });
});

test('industry index uses the latest official title and emits null for empty or missing names', async () => {
  await withTempRoot(async (root) => {
    await seedCapital(root);
    await writeJson(root, 'twse/industry_mi_index', '2026-10-15', industryPayload('舊水泥'), '_01');
    await writeJson(root, 'twse/industry_mi_index', '2026-10-16', industryPayload('水泥工業'), '_01');
    await writeJson(root, 'twse/industry_mi_index', '2026-10-16', industryPayload(''), '_32');
    assert.deepEqual(await applyIndustryIndex(root), { industries: 3, written: true });
    assert.deepEqual(JSON.parse(await readFile(join(root, 'data', 'derived', 'industry.json'))), {
      updated: '2026-10-15',
      industries: { '01': '水泥工業', '24': null, '32': null },
      cols: ['id', 'market', 'code'],
      rows: [['1101', 'twse', '01'], ['6488', 'twse', '24'], ['8069', 'tpex', '32']],
    });
  });
});

test('industry-only builder is byte-idempotent and does not touch other derived files', async () => {
  await withTempRoot(async (root) => {
    await seedCapital(root);
    const other = join(root, 'data', 'derived', 'keep.json');
    await mkdir(join(root, 'data', 'derived'), { recursive: true });
    await writeFile(other, '{"keep":true}\n');
    const before = await stat(other);
    await buildIndustryIndex({ rootDir: root });
    const first = await readFile(join(root, 'data', 'derived', 'industry.json'));
    await buildIndustryIndex({ rootDir: root });
    assert.deepEqual(await readFile(join(root, 'data', 'derived', 'industry.json')), first);
    assert.equal((await stat(other)).mtimeMs, before.mtimeMs);
    assert.equal(await readFile(other, 'utf8'), '{"keep":true}\n');
  });
});

test('runSnapshot company-capital change and full build produce byte-identical industry output', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, 'twse/industry_mi_index', '2026-07-06', industryPayload('半導體業'), '_24');
    const bodies = new Map([
      ['https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX', JSON.stringify([{ '日期': '1150706', '指數': '半導體類指數', '收盤指數': '1' }])],
      ['https://openapi.twse.com.tw/v1/opendata/t187ap03_L', JSON.stringify([{ '出表日期': '1150706', '公司代號': '2330', '產業別': '24', '實收資本額': '1', '已發行普通股數或TDR原股發行股數': '1' }])],
    ]);
    const fetcher = async (url) => {
      assert.ok(bodies.has(url), `unexpected URL ${url}`);
      const body = bodies.get(url);
      return { ok: true, status: 200, async text() { return body; }, async arrayBuffer() { return Buffer.from(body); } };
    };
    await runSnapshot({
      rootDir: root,
      fetcher,
      datasets: ['twse_company_capital'],
      now: () => new Date('2026-07-06T13:00:00Z'),
    });
    const path = join(root, 'data', 'derived', 'industry.json');
    const incremental = await readFile(path);
    await rm(join(root, 'data', 'derived'), { recursive: true, force: true });
    await buildDerived({ rootDir: root });
    assert.deepEqual(await readFile(path), incremental);
  });
});

test('industry-name backfill writes exact response bytes to the code-specific raw path', async () => {
  await withTempRoot(async (root) => {
    await seedCapital(root);
    const expected = Buffer.from('{"stat":"OK","tables":[]}\n');
    const calls = [];
    const summary = await runIndustryNameBackfill({
      rootDir: root,
      date: '2026-10-16',
      delayMs: 0,
      now: () => new Date('2026-10-17T04:00:00Z'),
      fetcher: async (url) => { calls.push(url); return response(expected); },
      logger: { log() {}, error() {} },
    });
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.written, 6);
    assert.deepEqual(calls.map((url) => new URL(url).searchParams.get('type')), ['01', '24', '32', '33', '98', '99']);
    assert.deepEqual(await readFile(join(root, 'data', 'raw', 'twse', 'industry_mi_index', '2026', '2026-10-16_24.json')), expected);
  });
});

test('industry-name backfill skips every existing parseable raw without fetching', async () => {
  await withTempRoot(async (root) => {
    await seedCapital(root);
    for (const code of ['01', '24', '32', '33', '98', '99']) {
      await writeJson(root, 'twse/industry_mi_index', '2026-10-16', industryPayload(code), `_${code}`);
    }
    const summary = await runIndustryNameBackfill({
      rootDir: root,
      date: '2026-10-16',
      delayMs: 0,
      now: () => new Date('2026-10-17T04:00:00Z'),
      fetcher: async () => { throw new Error('fetch must not run'); },
      logger: { log() {}, error() {} },
    });
    assert.equal(summary.skipped, 6);
    assert.equal(summary.written, 0);
  });
});

test('industry-name CLI exits non-zero after HTTP 500 while later codes still write', async () => {
  await withTempRoot(async (root) => {
    await seedCapital(root);
    const preload = join(root, 'fake-fetch.mjs');
    await writeFile(preload, `globalThis.fetch = async (url) => {\n  const code = new URL(url).searchParams.get('type');\n  return code === '01' ? new Response('', { status: 500 }) : new Response(JSON.stringify({ stat: 'OK', tables: [] }), { status: 200 });\n};\n`);
    await assert.rejects(
      execFile(process.execPath, [backfillScript, '--date', '2026-10-16', '--out', root, '--delay-ms', '0'], {
        env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /\[fail\] 01: HTTP 500/);
        assert.match(error.stdout, /failed=1/);
        return true;
      },
    );
    await readFile(join(root, 'data', 'raw', 'twse', 'industry_mi_index', '2026', '2026-10-16_24.json'));
    await readFile(join(root, 'data', 'raw', 'twse', 'industry_mi_index', '2026', '2026-10-16_32.json'));
  });
});

test('industry-name backfill rejects Taipei today before any fetch', async () => {
  await assert.rejects(
    runIndustryNameBackfill({
      date: '2026-10-17',
      delayMs: 0,
      now: () => new Date('2026-10-17T04:00:00Z'),
      fetcher: async () => { throw new Error('fetch must not run'); },
    }),
    /--date must be before Taipei today 2026-10-17/,
  );
});

test('industry-name CLI options preserve a bare numeric flag as NaN for the numeric guard', () => {
  assert.throws(
    () => industryNameBackfillOptionsFromArgs(
      { date: '2026-10-16', 'delay-ms': true },
      { now: () => new Date('2026-10-17T04:00:00Z') },
    ),
    /--delay-ms must be a non-negative number, got: NaN/,
  );
});
