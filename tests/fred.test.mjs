import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDerived } from '../scripts/build-derived.mjs';
import { SERIES_ENDPOINTS } from '../scripts/endpoints.mjs';
import {
  MACRO_START_DATE,
  applyMacroSeries,
  parseFredCsv,
} from '../scripts/lib/derived.mjs';
import { runSnapshot } from '../scripts/run.mjs';

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-fred-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fredFixture(seriesId, { lastDate = '2021-01-07', extraColumn = true } = {}) {
  const header = extraColumn
    ? `observation_date,IGNORED,${seriesId}`
    : `observation_date,${seriesId}`;
  const row = (date, value) => extraColumn ? `${date},999,${value}` : `${date},${value}`;
  return [
    header,
    row('2020-12-31', '1'),
    row('2021-01-04', '2'),
    row('2021-01-05', ''),
    row('2021-01-06', '.'),
    row(lastDate, '3.5'),
    '',
  ].join('\n');
}

function response(body, status = 200) {
  const bytes = Buffer.from(body ?? '', 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

async function writeFredRaw(root, seriesId, body) {
  const path = join(root, 'data', 'raw', 'fred', `${seriesId}.csv`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return path;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function expectedFixtureCount(body, seriesId) {
  const lines = body.trimEnd().split('\n');
  const header = lines[0].split(',');
  const dateIndex = header.indexOf('observation_date');
  const valueIndex = header.indexOf(seriesId);
  return lines.slice(1).filter((line) => {
    const cells = line.split(',');
    const value = cells[valueIndex];
    const date = Number(cells[dateIndex].replaceAll('-', ''));
    return value !== '' && value !== '.' && date >= MACRO_START_DATE;
  }).length;
}

test('FRED parser skips empty and dot values and resolves the series column by header', (t) => {
  const fixture = [
    'observation_date,IGNORED,T10Y2Y',
    '2025-12-24,999,0.68',
    '2025-12-25,999,',
    '2025-12-26,999,0.68',
    '2025-12-29,999,.',
    '',
  ].join('\n');
  const rows = parseFredCsv(Buffer.from(fixture), 'T10Y2Y');
  assert.deepEqual(rows, [[20251224, 0.68], [20251226, 0.68]]);
  assert.equal(rows.some((row) => row[0] === 20251225), false);
  assert.equal(rows.some((row) => row[0] === 20251229), false);
  assert.throws(
    () => parseFredCsv('observation_date,T10Y2Y\n2025-12-24,not-a-number\n', 'T10Y2Y'),
    /non-numeric value at 2025-12-24/,
  );
  t.diagnostic(`A2_A3_ROWS=${JSON.stringify(rows)} EMPTY_PRESENT=${rows.some((row) => row[0] === 20251225)} DOT_PRESENT=${rows.some((row) => row[0] === 20251229)}`);
});

test('macro derivation enforces the date floor, attribution, adaptive counts, and idempotence', async (t) => {
  await withTempDir(async (root) => {
    const fixtures = new Map();
    for (const endpoint of SERIES_ENDPOINTS) {
      const body = fredFixture(endpoint.seriesId);
      fixtures.set(endpoint.seriesId, body);
      await writeFredRaw(root, endpoint.seriesId, body);
    }

    const first = await applyMacroSeries(root);
    assert.deepEqual(first, { series: 4, written: true });
    const path = join(root, 'data', 'derived', 'macro.json');
    const before = await readFile(path);
    const macro = JSON.parse(before);
    const counts = {};
    for (const endpoint of SERIES_ENDPOINTS) {
      const series = macro.series[endpoint.seriesId];
      const expected = expectedFixtureCount(fixtures.get(endpoint.seriesId), endpoint.seriesId);
      assert.deepEqual(series.cols, ['d', 'v']);
      assert.equal(series.rows.length, expected);
      assert.equal(series.rows.some((row) => row[0] === 20201231), false);
      assert.equal(series.rows.some((row) => row[0] === 20210104), true);
      counts[endpoint.seriesId] = { rawEligible: expected, derived: series.rows.length };
    }
    assert.equal(macro.series.VIXCLS.attribution, 'CBOE');

    const second = await applyMacroSeries(root);
    const after = await readFile(path);
    assert.deepEqual(second, { series: 4, written: false });
    assert.deepEqual(after, before);

    const rebuilt = await buildDerived({ rootDir: root });
    assert.equal(rebuilt.macroSeries, 4);
    assert.equal(rebuilt.files, 1);
    assert.deepEqual(await readFile(path), before);
    t.diagnostic(`A4_COUNTS=${JSON.stringify(counts)}`);
    t.diagnostic(`A5_VIX_ATTRIBUTION=${macro.series.VIXCLS.attribution}`);
    t.diagnostic('A6_BELOW_FLOOR_PRESENT=false AT_FLOOR_PRESENT=true');
    t.diagnostic(`A7_SECOND_WRITTEN=${second.written} BYTE_IDENTICAL=${after.equals(before)}`);
    t.diagnostic(`A8_REBUILD=${JSON.stringify(rebuilt)} BYTE_IDENTICAL=${(await readFile(path)).equals(before)}`);
  });
});

test('snapshot isolates one failed FRED series and preserves successful official bytes', async (t) => {
  await withTempDir(async (root) => {
    const bodies = new Map(SERIES_ENDPOINTS.map((endpoint) => [
      endpoint.seriesId,
      fredFixture(endpoint.seriesId),
    ]));
    const failedKey = 'fred_t10y2y';
    const summary = await runSnapshot({
      rootDir: root,
      datasets: SERIES_ENDPOINTS.map((endpoint) => endpoint.key),
      fetcher: async (url) => {
        const endpoint = SERIES_ENDPOINTS.find((item) => item.url === url);
        assert.ok(endpoint, `unexpected URL ${url}`);
        if (endpoint.key === failedKey) return response('unavailable', 500);
        return response(bodies.get(endpoint.seriesId));
      },
      now: () => new Date('2026-01-08T00:00:00Z'),
    });

    assert.equal(summary.exitCode, 0);
    assert.equal(summary.results.filter((result) => result.ok).length, 3);
    assert.equal(summary.results.find((result) => result.key === failedKey).error, 'HTTP 500');
    const rawEvidence = {};
    for (const endpoint of SERIES_ENDPOINTS) {
      const path = join(root, 'data', 'raw', 'fred', `${endpoint.seriesId}.csv`);
      if (endpoint.key === failedKey) {
        await assert.rejects(readFile(path), { code: 'ENOENT' });
        rawEvidence[endpoint.key] = 'missing';
      } else {
        const exact = (await readFile(path)).equals(Buffer.from(bodies.get(endpoint.seriesId)));
        assert.equal(exact, true);
        rawEvidence[endpoint.key] = 'byte-equal';
      }
    }

    const manifest = await readJson(join(root, 'data', 'manifest.json'));
    assert.equal(manifest.datasets[failedKey].ok, false);
    assert.equal(manifest.datasets[failedKey].lastError, 'HTTP 500');
    for (const endpoint of SERIES_ENDPOINTS.filter((item) => item.key !== failedKey)) {
      assert.equal(manifest.datasets[endpoint.key].ok, true);
      assert.equal(manifest.datasets[endpoint.key].observations, 3);
      assert.equal(Object.hasOwn(manifest.datasets[endpoint.key], 'latest'), false);
    }
    t.diagnostic(`A9_RESULT=${JSON.stringify(summary.results.map(({ key, ok, status, error }) => ({ key, ok, status, error })))}`);
    t.diagnostic(`A9_RAW=${JSON.stringify(rawEvidence)} MANIFEST_OK=${JSON.stringify(Object.fromEntries(SERIES_ENDPOINTS.map((endpoint) => [endpoint.key, manifest.datasets[endpoint.key].ok])))}`);
  });
});

test('FRED observations later than Taiwan data do not advance latestTradingDate', async (t) => {
  await withTempDir(async (root) => {
    const manifestPath = join(root, 'data', 'manifest.json');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00Z',
      latestTradingDate: '2026-01-01',
      datasets: {
        twse_mi_index: {
          first: '2026-01-01', latest: '2026-01-01', days: 1, ok: true,
        },
      },
    }, null, 2)}\n`);

    const options = {
      rootDir: root,
      datasets: ['fred_t10y2y'],
      fetcher: async () => response(fredFixture('T10Y2Y', { lastDate: '2026-01-02' })),
      now: () => new Date('2026-01-03T00:00:00Z'),
    };
    await runSnapshot(options);

    const manifest = await readJson(manifestPath);
    assert.equal(manifest.datasets.fred_t10y2y.lastObservation, '2026-01-02');
    assert.equal(Object.hasOwn(manifest.datasets.fred_t10y2y, 'latest'), false);
    assert.equal(manifest.latestTradingDate, '2026-01-01');
    assert.equal(manifest.paths.rawFred, 'data/raw/fred/{series_id}.csv');
    assert.equal(manifest.paths.macro, 'data/derived/macro.json');
    const rawPath = join(root, 'data', 'raw', 'fred', 'T10Y2Y.csv');
    const rawBefore = await readFile(rawPath);
    const manifestBefore = await readFile(manifestPath);
    const second = await runSnapshot(options);
    assert.equal(second.results[0].status, 'same');
    assert.deepEqual(await readFile(rawPath), rawBefore);
    assert.deepEqual(await readFile(manifestPath), manifestBefore);
    t.diagnostic(`A10_TAIWAN_LATEST=${manifest.latestTradingDate} FRED_LAST=${manifest.datasets.fred_t10y2y.lastObservation} HAS_LATEST_FIELD=${Object.hasOwn(manifest.datasets.fred_t10y2y, 'latest')}`);
    t.diagnostic(`RAW_RERUN_STATUS=${second.results[0].status} RAW_BYTE_IDENTICAL=${(await readFile(rawPath)).equals(rawBefore)} MANIFEST_BYTE_IDENTICAL=${(await readFile(manifestPath)).equals(manifestBefore)}`);
  });
});
