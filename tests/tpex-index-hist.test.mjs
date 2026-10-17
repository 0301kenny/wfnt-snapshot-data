import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runTpexIndexBackfill, tpexIndexBackfillOptionsFromArgs } from '../scripts/backfill-tpex-index.mjs';
import { buildDerived } from '../scripts/build-derived.mjs';
import { BACKFILL_ENDPOINTS } from '../scripts/endpoints.mjs';
import { applyDailyDate, applyTpexIndexMonth } from '../scripts/lib/derived.mjs';

const execFileAsync = promisify(execFile);
const FIELDS = ['日期', '開市', '最高', '最低', '收市', '漲/跌'];

function body(month = '2006-10', rows = [
  [`${month.replace('-', '/')}/02`, '100.10', '101.20', '99.30', '100.80', '0.70'],
  [`${month.replace('-', '/')}/03`, '1,001.5', '1,010', '995', '1,005.5', '904.7'],
]) {
  return Buffer.from(JSON.stringify({
    date: `${month.replace('-', '/')}/01`,
    stat: 'ok',
    tables: [{ title: '櫃買指數(月查詢)', fields: FIELDS, data: rows }],
  }));
}

function response(bytes) {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-tpex-index-hist-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeAt(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

function histPath(root, month = '2006-10') {
  return join(root, 'data/raw/tpex/index_hist', month.slice(0, 4), `${month}.json`);
}

test('TPEX historical index endpoint is monthly and queries the first day', () => {
  assert.deepEqual(BACKFILL_ENDPOINTS.tpex_index_hist, {
    cadence: 'monthly',
    sourceDataset: 'tpex/index_hist',
    url: BACKFILL_ENDPOINTS.tpex_index_hist.url,
  });
  assert.equal(
    BACKFILL_ENDPOINTS.tpex_index_hist.url('2006-10'),
    'https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=2006/10/01&response=json',
  );
});

test('TPEX historical index backfill preserves raw bytes and writes compact derived rows', async () => {
  await withTempDir(async (root) => {
    const bytes = body();
    const summary = await runTpexIndexBackfill({
      rootDir: root,
      fromMonth: '2006-10',
      toMonth: '2006-10',
      delayMs: 0,
      now: () => new Date('2026-10-17T04:00:00Z'),
      fetcher: async () => response(bytes),
    });
    assert.equal(summary.failures.length, 0);
    assert.deepEqual(await readFile(histPath(root)), bytes);
    const market = JSON.parse(await readFile(join(root, 'data/derived/market.json'), 'utf8'));
    assert.deepEqual(market.tpex.index.rows, [
      [20061002, 100.1, 101.2, 99.3, 100.8],
      [20061003, 1001.5, 1010, 995, 1005.5],
    ]);
  });
});

test('invalid TPEX historical index shapes do not write raw and make the CLI exit non-zero', async (t) => {
  const invalidBodies = {
    stat: Buffer.from(JSON.stringify({ stat: 'error', tables: [{ fields: FIELDS, data: [['2006/10/02']] }] })),
    empty: body('2006-10', []),
    fields: Buffer.from(JSON.stringify({ stat: 'ok', tables: [{ fields: [...FIELDS.slice(0, 5), '漂移'], data: [['2006/10/02', '1', '2', '1', '2', '1']] }] })),
  };
  for (const [name, bytes] of Object.entries(invalidBodies)) {
    await t.test(name, async () => {
      await withTempDir(async (root) => {
        const preload = join(root, 'fake-fetch.mjs');
        await writeFile(preload, `const bytes = Buffer.from(process.env.WFNT_FAKE_BODY, 'base64');\nglobalThis.fetch = async () => ({ ok: true, status: 200, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } });\n`);
        const script = fileURLToPath(new URL('../scripts/backfill-tpex-index.mjs', import.meta.url));
        let failure;
        try {
          await execFileAsync(process.execPath, [script, '--from', '2006-10', '--to', '2006-10', '--out', root, '--delay-ms', '0'], {
            env: {
              ...process.env,
              NODE_OPTIONS: `--import=${preload}`,
              WFNT_FAKE_BODY: bytes.toString('base64'),
            },
          });
        } catch (error) {
          failure = error;
        }
        assert.equal(failure?.code, 1);
        await assert.rejects(readFile(histPath(root)), { code: 'ENOENT' });
      });
    });
  }
});

test('historical TPEX index raw checkpoints while the Taipei current month refreshes write-on-change', async () => {
  await withTempDir(async (root) => {
    await writeAt(histPath(root, '2026-09'), body('2026-09'));
    await writeAt(histPath(root, '2026-10'), body('2026-10', [['2026/10/01', '1', '2', '1', '2', '1']]));
    const calls = [];
    const fresh = body('2026-10', [['2026/10/01', '2', '3', '1', '2.5', '0.5']]);
    const options = {
      rootDir: root,
      fromMonth: '2026-09',
      toMonth: '2026-10',
      delayMs: 0,
      now: () => new Date('2026-10-17T04:00:00Z'),
      fetcher: async (url) => {
        calls.push(url);
        return response(fresh);
      },
    };
    const first = await runTpexIndexBackfill(options);
    assert.equal(first.skipped, 1);
    assert.equal(first.requests, 1);
    assert.deepEqual(await readFile(histPath(root, '2026-10')), fresh);
    const second = await runTpexIndexBackfill(options);
    assert.equal(second.requests, 1);
    assert.equal(second.rawWritten, 0);
    assert.equal(calls.length, 2);
  });
});

test('same-day TPEX OpenAPI index raw wins over historical monthly values', async () => {
  await withTempDir(async (root) => {
    await writeAt(histPath(root), body('2006-10', [['2006/10/02', '1', '2', '0.5', '1.5', '0.5']]));
    await writeAt(join(root, 'data/raw/tpex/index/2006/2006-10-02.json'), JSON.stringify([{
      Date: '2006-10-02', Open: '10', High: '20', Low: '5', Close: '15',
    }]));
    await applyDailyDate(root, '2006-10-02');
    await applyTpexIndexMonth(root, '2006-10');
    const market = JSON.parse(await readFile(join(root, 'data/derived/market.json'), 'utf8'));
    assert.deepEqual(market.tpex.index.rows, [[20061002, 10, 20, 5, 15]]);
  });
});

test('full derived rebuild matches incremental TPEX historical index bytes', async () => {
  const incremental = await mkdtemp(join(tmpdir(), 'wfnt-tpex-index-inc-'));
  const rebuilt = await mkdtemp(join(tmpdir(), 'wfnt-tpex-index-build-'));
  try {
    for (const root of [incremental, rebuilt]) {
      await writeAt(histPath(root), body());
      await writeAt(join(root, 'data/raw/tpex/index/2006/2006-10-02.json'), JSON.stringify([{
        Date: '2006-10-02', Open: '9', High: '10', Low: '8', Close: '9.5',
      }]));
    }
    await applyDailyDate(incremental, '2006-10-02');
    await applyTpexIndexMonth(incremental, '2006-10');
    await buildDerived({ rootDir: rebuilt });
    assert.deepEqual(
      await readFile(join(rebuilt, 'data/derived/market.json')),
      await readFile(join(incremental, 'data/derived/market.json')),
    );
  } finally {
    await rm(incremental, { recursive: true, force: true });
    await rm(rebuilt, { recursive: true, force: true });
  }
});

test('TPEX historical index CLI rejects a future month and bare numeric delay', () => {
  const now = () => new Date('2026-10-17T04:00:00Z');
  assert.throws(
    () => tpexIndexBackfillOptionsFromArgs({ from: '2026-10', to: '2026-11' }, { now }),
    /must not be after Taipei current month/,
  );
  assert.throws(
    () => tpexIndexBackfillOptionsFromArgs({ from: '2026-10', to: '2026-10', 'delay-ms': true }, { now }),
    /got: NaN/,
  );
});
