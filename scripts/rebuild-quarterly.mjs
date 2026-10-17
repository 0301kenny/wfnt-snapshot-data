import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyQuarterlyFinancials, replaceQuarterlyDerived } from './lib/derived.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== '--out') throw new Error(`unknown argument: ${token}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error('--out requires a directory');
    args.out = next;
    index += 1;
  }
  return args;
}

async function listHtmlSeasons(dir) {
  try {
    const years = await readdir(dir, { withFileTypes: true });
    const seasons = [];
    for (const year of years) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const files = await readdir(join(dir, year.name), { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && /^\d{4}-Q[1-4]\.html$/.test(file.name)) {
          seasons.push(file.name.slice(0, -5));
        }
      }
    }
    return seasons.sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function rebuildQuarterly({ rootDir = process.cwd() } = {}) {
  const seasons = new Set();
  for (const market of ['twse', 'tpex']) {
    const dir = join(rootDir, 'data', 'raw', market, 'quarterly_fin_hist');
    for (const season of await listHtmlSeasons(dir)) seasons.add(season);
  }
  const scratchRoot = await mkdtemp(join(tmpdir(), 'wfnt-quarterly-rebuild-'));
  let fundamentals = 0;
  let eps = 0;
  try {
    await mkdir(join(scratchRoot, 'data'), { recursive: true });
    await symlink(resolve(rootDir, 'data', 'raw'), join(scratchRoot, 'data', 'raw'), 'dir');
    for (const season of [...seasons].sort()) {
      const result = await applyQuarterlyFinancials(scratchRoot, season);
      fundamentals += result.fundamentals;
      eps += result.eps;
    }
    await replaceQuarterlyDerived(rootDir, scratchRoot);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
  return { seasons: seasons.size, fundamentals, eps };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const summary = await rebuildQuarterly({
      rootDir: args.out === undefined ? process.cwd() : resolve(args.out),
    });
    console.log(`quarterly: seasons=${summary.seasons} fundamentals=${summary.fundamentals} eps=${summary.eps}`);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
