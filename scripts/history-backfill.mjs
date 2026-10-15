import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNumericFlag } from './lib/cli.mjs';
import { runHistoryBackfill } from './lib/history-backfill.mjs';

const VALUE_FLAGS = new Set([
  'from',
  'to',
  'out',
  'delay-ms',
  'max-minutes',
  'pause-window',
]);
const BOOLEAN_FLAGS = new Set(['resume-blocked']);

export function parseHistoryBackfillArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!VALUE_FLAGS.has(key) && !BOOLEAN_FLAGS.has(key)) {
      throw new Error(`unknown flag: --${key}`);
    }
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export function historyBackfillOptionsFromArgs(args) {
  return {
    rootDir: String(args.out ?? process.cwd()),
    fromIso: args.from,
    toIso: args.to,
    delayMs: parseNumericFlag(args['delay-ms'], 3000),
    maxMinutes: parseNumericFlag(args['max-minutes'], 28),
    pauseWindow: args['pause-window'] ?? '21:00-22:00',
    resumeBlocked: args['resume-blocked'] === true,
  };
}

async function main() {
  const args = parseHistoryBackfillArgs(process.argv.slice(2));
  const result = await runHistoryBackfill(historyBackfillOptionsFromArgs(args));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
