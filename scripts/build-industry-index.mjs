import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyIndustryIndex } from './lib/derived.mjs';

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

export async function buildIndustryIndex({ rootDir = process.cwd() } = {}) {
  return applyIndustryIndex(rootDir);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const summary = await buildIndustryIndex({
      rootDir: args.out === undefined ? process.cwd() : resolve(args.out),
    });
    console.log(`industry index: codes=${summary.industries} file=${summary.written ? 'write' : 'same'}`);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
