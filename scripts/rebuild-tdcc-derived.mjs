import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyTdccWeek } from './lib/derived.mjs';
import { listCsvGzDates } from './lib/io.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== '--out') throw new Error(`unknown argument: ${token}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error('--out requires a directory');
    }
    args.out = next;
    index += 1;
  }
  return args;
}

export async function rebuildTdccDerived({ rootDir = process.cwd() } = {}) {
  const tdccRawDir = join(rootDir, 'data', 'raw', 'tdcc');
  const weeks = await listCsvGzDates(tdccRawDir);
  await rm(join(rootDir, 'data', 'derived', 'tdcc'), { recursive: true, force: true });

  let files = 0;
  for (const week of weeks) {
    const result = await applyTdccWeek(rootDir, week);
    files += result.tdcc;
  }
  return { weeks: weeks.length, files };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const summary = await rebuildTdccDerived({
      rootDir: args.out === undefined ? process.cwd() : resolve(args.out),
    });
    console.log(`derived tdcc_weeks=${summary.weeks} files=${summary.files}`);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
