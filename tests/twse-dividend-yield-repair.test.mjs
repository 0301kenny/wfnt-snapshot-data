import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  applyDailyDate,
  repairTwseDividendYield,
  stableDerivedString,
} from '../scripts/lib/derived.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'scripts', 'repair-twse-dividend-yield.mjs');

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-dividend-yield-repair-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableDerivedString(value));
}

function fundamental(id, name, rows) {
  return {
    id,
    name,
    market: 'twse',
    updated: '2026-07-06',
    valuation: { cols: ['d', 'per', 'pbr', 'dy'], rows },
    revenue: { cols: ['m', 'rev', 'yoy', 'mom'], rows: [] },
    quarterly: { cols: ['q', 'gm', 'om', 'nm'], rows: [] },
  };
}

test('repair restores byte-identical rebuilt fundamentals and reports exact counts', async () => {
  await withTempDir(async (root) => {
    const rawPath = join(root, 'data/raw/twse/bwibbu_all/2026/2026-07-06.json');
    const path2330 = join(root, 'data/derived/fundamentals/23/2330.json');
    const path2317 = join(root, 'data/derived/fundamentals/23/2317.json');
    await writeJson(rawPath, [
      { Date: '1150706', Code: '2330', Name: '台積電', PEratio: '', PBratio: '5.2', DividendYield: '' },
      { Date: '1150706', Code: '2317', Name: '鴻海', PEratio: '12', PBratio: '2', DividendYield: ' ' },
    ]);
    await applyDailyDate(root, '2026-07-06');
    const rebuilt = new Map([
      [path2330, await readFile(path2330)],
      [path2317, await readFile(path2317)],
    ]);
    await writeJson(path2330, fundamental('2330', '台積電', [[20260706, null, 5.2, null]]));
    await writeJson(path2317, fundamental('2317', '鴻海', [[20260706, 12, 2, null]]));

    assert.deepEqual(await repairTwseDividendYield(root), { files: 2, cells: 2 });
    assert.deepEqual(await readFile(path2330), rebuilt.get(path2330));
    assert.deepEqual(await readFile(path2317), rebuilt.get(path2317));
  });
});

test('repair leaves unsupported nulls, PE nulls, and dates absent from blank raw unchanged', async () => {
  await withTempDir(async (root) => {
    await writeJson(join(root, 'data/raw/twse/bwibbu_all/2026/2026-07-06.json'), [
      { Date: '1150706', Code: '2330', Name: '台積電', PEratio: '', PBratio: '5.2', DividendYield: '--' },
      { Date: '1150706', Code: '2317', Name: '鴻海', PEratio: '12', PBratio: '2', DividendYield: '' },
    ]);
    const path2330 = join(root, 'data/derived/fundamentals/23/2330.json');
    const path2317 = join(root, 'data/derived/fundamentals/23/2317.json');
    await writeJson(path2330, fundamental('2330', '台積電', [[20260706, null, 5.2, null]]));
    await writeJson(path2317, fundamental('2317', '鴻海', [[20260707, 12, 2, null]]));
    const before2330 = await readFile(path2330);
    const before2317 = await readFile(path2317);

    assert.deepEqual(await repairTwseDividendYield(root), { files: 0, cells: 0 });
    assert.deepEqual(await readFile(path2330), before2330);
    assert.deepEqual(await readFile(path2317), before2317);
  });
});

test('repair CLI honors --out, is idempotent without touching mtime, and rejects unknown args', async () => {
  await withTempDir(async (root) => {
    await writeJson(join(root, 'data/raw/twse/bwibbu_all/2026/2026-07-06.json'), [
      { Date: '1150706', Code: '2330', Name: '台積電', PEratio: '', PBratio: '5.2', DividendYield: '' },
    ]);
    const derivedPath = join(root, 'data/derived/fundamentals/23/2330.json');
    await writeJson(derivedPath, fundamental('2330', '台積電', [[20260706, null, 5.2, null]]));

    const first = await execFileAsync(process.execPath, [cliPath, '--out', root], { cwd: repoRoot });
    assert.equal(first.stdout, 'files=1 cells=1\n');
    const firstMtime = (await stat(derivedPath, { bigint: true })).mtimeNs;
    const second = await execFileAsync(process.execPath, [cliPath, '--out', root], { cwd: repoRoot });
    assert.equal(second.stdout, 'files=0 cells=0\n');
    assert.equal((await stat(derivedPath, { bigint: true })).mtimeNs, firstMtime);
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, '--wat'], { cwd: repoRoot }),
      (error) => error.code === 1 && /unknown argument: --wat/.test(error.stderr),
    );
  });
});
