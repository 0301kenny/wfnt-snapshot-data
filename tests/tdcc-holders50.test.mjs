import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { applyTdccWeek } from '../scripts/lib/derived.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TDCC_COLS = ['w', 'big1000', 'big400', 'retail', 'holders', 'avgShares', 'holders50'];

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-tdcc-holders50-test-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function csvCell(value) {
  const text = String(value);
  return text.includes(',') ? `"${text}"` : text;
}

function tdccCsv(isoDate, counts, id = '2330') {
  const date = isoDate.replaceAll('-', '');
  const rows = Object.entries(counts).map(([grade, count]) => [
    date,
    id,
    grade,
    count,
    Number(grade) === 17 ? '10,000' : '100',
    grade,
  ]);
  return [
    ['資料日期', '證券代號', '持股分級', '人數', '股數', '占集保庫存數比例%'],
    ...rows,
  ].map((row) => row.map(csvCell).join(',')).join('\n');
}

async function writeWeek(root, isoDate, counts) {
  const dir = join(root, 'data', 'raw', 'tdcc', isoDate.slice(0, 4));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${isoDate}.csv.gz`), gzipSync(tdccCsv(isoDate, counts)));
}

async function readSeries(root, id = '2330') {
  return JSON.parse(await readFile(
    join(root, 'data', 'derived', 'tdcc', id.slice(0, 2), `${id}.json`),
    'utf8',
  ));
}

function allGrades(multiplier = 10) {
  return Object.fromEntries([
    ...Array.from({ length: 8 }, (_, index) => [index + 1, (index + 1) * multiplier]),
    [9, 900],
    [15, 1500],
    [17, 100],
  ]);
}

function runRebuild(root) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      ['scripts/rebuild-tdcc-derived.mjs', '--out', root],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

test('holders50 sums grades 1 through 8 and excludes non-zero grades 9 and 15', async () => {
  await withTempDir(async (root) => {
    await writeWeek(root, '2026-09-24', allGrades());
    await applyTdccWeek(root, '2026-09-24');
    const series = await readSeries(root);
    assert.deepEqual(series.cols, TDCC_COLS);
    assert.equal(series.rows[0][6], 360);
  });
});

test('holders50 treats a missing grade from 1 through 8 as zero', async () => {
  await withTempDir(async (root) => {
    const counts = allGrades();
    delete counts[4];
    await writeWeek(root, '2026-09-24', counts);
    await applyTdccWeek(root, '2026-09-24');
    const holders50 = (await readSeries(root)).rows[0][6];
    assert.equal(holders50, 320);
    assert.ok(Number.isFinite(holders50));
  });
});

test('holders50 parses quoted holder counts with thousands separators', async () => {
  await withTempDir(async (root) => {
    await writeWeek(root, '2026-09-24', { 1: '1,234', 8: 8, 9: 90, 15: 150, 17: 100 });
    await applyTdccWeek(root, '2026-09-24');
    assert.equal((await readSeries(root)).rows[0][6], 1242);
  });
});

test('TDCC upsert pads legacy six-column rows with null before adding a seven-column week', async () => {
  await withTempDir(async (root) => {
    const path = join(root, 'data', 'derived', 'tdcc', '23', '2330.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      id: '2330',
      updated: '2026-09-18',
      cols: TDCC_COLS.slice(0, 6),
      rows: [[20260918, 1, 2, 3, 4, 5]],
    })}\n`);
    await writeWeek(root, '2026-09-24', allGrades());
    await applyTdccWeek(root, '2026-09-24');
    const series = await readSeries(root);
    assert.deepEqual(series.cols, TDCC_COLS);
    assert.deepEqual(series.rows[0], [20260918, 1, 2, 3, 4, 5, null]);
    assert.equal(series.rows[1].length, 7);
  });
});

test('rebuild CLI replays every raw week and preserves all six legacy values', async () => {
  await withTempDir(async (root) => {
    await writeWeek(root, '2026-09-24', allGrades(10));
    await writeWeek(root, '2026-10-02', allGrades(20));
    await applyTdccWeek(root, '2026-09-24');
    await applyTdccWeek(root, '2026-10-02');
    const seeded = await readSeries(root);
    const legacyRows = seeded.rows.map((row) => row.slice(0, 6));
    const path = join(root, 'data', 'derived', 'tdcc', '23', '2330.json');
    await writeFile(path, `${JSON.stringify({ ...seeded, cols: TDCC_COLS.slice(0, 6), rows: legacyRows })}\n`);

    const result = await runRebuild(root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /tdcc_weeks=2/);
    const rebuilt = await readSeries(root);
    assert.deepEqual(rebuilt.rows.map((row) => row.slice(0, 6)), legacyRows);
    assert.deepEqual(rebuilt.rows.map((row) => row[6]), [360, 720]);
  });
});

test('rebuild CLI is byte-identical on a second run with the same raw weeks', async () => {
  await withTempDir(async (root) => {
    await writeWeek(root, '2026-09-24', allGrades(10));
    await writeWeek(root, '2026-10-02', allGrades(20));
    const firstRun = await runRebuild(root);
    assert.equal(firstRun.code, 0, firstRun.stderr);
    const path = join(root, 'data', 'derived', 'tdcc', '23', '2330.json');
    const firstBytes = await readFile(path);
    const secondRun = await runRebuild(root);
    assert.equal(secondRun.code, 0, secondRun.stderr);
    assert.deepEqual(await readFile(path), firstBytes);
  });
});

test('rebuild CLI preserves existing derived files absent from every raw week', async () => {
  await withTempDir(async (root) => {
    await writeWeek(root, '2026-10-02', allGrades());
    const path = join(root, 'data', 'derived', 'tdcc', '99', '9999.json');
    const bytes = Buffer.from('{"id":"9999","updated":"2026-09-18","cols":["w"],"rows":[[20260918]]}\n');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);

    const result = await runRebuild(root);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readFile(path), bytes);
  });
});
