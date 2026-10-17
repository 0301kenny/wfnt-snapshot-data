import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySectorIndexDate } from './lib/derived.mjs';
import { listJsonDates } from './lib/io.mjs';

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

export async function rebuildSectorIndex({ rootDir = process.cwd() } = {}) {
  await rm(resolve(rootDir, 'data', 'derived', 'sector_index.json'), { force: true });
  const dates = new Set();
  for (const sourceDataset of ['twse/mi_index', 'twse/mi_index_hist']) {
    const dir = resolve(rootDir, 'data', 'raw', sourceDataset);
    for (const date of await listJsonDates(dir)) dates.add(date);
  }
  let rows = 0;
  for (const date of [...dates].sort()) {
    const result = await applySectorIndexDate(rootDir, date);
    rows += result.sectorIndexes;
  }
  return { dates: dates.size, rows };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const summary = await rebuildSectorIndex({
      rootDir: args.out === undefined ? process.cwd() : resolve(args.out),
    });
    console.log(`sector index: dates=${summary.dates} rows=${summary.rows}`);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
