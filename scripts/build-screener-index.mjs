import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyScreenerIndex } from './lib/screener-index.mjs';

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

export async function buildScreenerIndexCli({ rootDir = process.cwd() } = {}) {
  return applyScreenerIndex(rootDir);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const summary = await buildScreenerIndexCli({
      rootDir: args.out === undefined ? process.cwd() : resolve(args.out),
    });
    console.log(`screener index: rows=${summary.rows} file=${summary.written ? 'write' : 'same'}`);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
