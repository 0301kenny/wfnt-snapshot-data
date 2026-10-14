import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repairTwseDividendYield } from './lib/derived.mjs';

function parseArgs(argv) {
  let rootDir = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== '--out') throw new Error(`unknown argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('--out requires a directory');
    rootDir = resolve(value);
    index += 1;
  }
  return { rootDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const summary = await repairTwseDividendYield(parseArgs(process.argv.slice(2)).rootDir);
    console.log(`files=${summary.files} cells=${summary.cells}`);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
