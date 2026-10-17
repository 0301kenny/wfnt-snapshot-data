import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runQuarterlyBackfill } from './backfill-quarterly.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { taipeiIsoDate } from './lib/date.mjs';
import { rebuildQuarterly } from './rebuild-quarterly.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== '--out' && token !== '--refresh-recent') {
      throw new Error(`unknown argument: ${token}`);
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[token.slice(2)] = true;
    } else {
      args[token.slice(2)] = next;
      index += 1;
    }
  }
  return args;
}

export function quarterlyRefreshRange(now = new Date()) {
  const [year, month] = taipeiIsoDate(now).split('-').map(Number);
  const currentQuarter = Math.ceil(month / 3);
  const toYear = currentQuarter === 1 ? year - 1 : year;
  const toQuarter = currentQuarter === 1 ? 4 : currentQuarter - 1;
  return {
    fromSeason: `${toYear - 1}-Q1`,
    toSeason: `${toYear}-Q${toQuarter}`,
  };
}

export function quarterlyRefreshOptionsFromArgs(args) {
  if (args.out === true) throw new Error('--out requires a directory');
  return {
    rootDir: args.out ?? process.cwd(),
    refreshRecent: parseNumericFlag(args['refresh-recent'], 4),
  };
}

export async function runQuarterlyRefresh({
  rootDir = process.cwd(),
  refreshRecent = 4,
  now = () => new Date(),
  backfill = runQuarterlyBackfill,
  rebuild = rebuildQuarterly,
  logger = console,
} = {}) {
  if (!Number.isInteger(refreshRecent) || refreshRecent < 0) {
    throw new Error(`--refresh-recent must be a non-negative integer, got: ${refreshRecent}`);
  }
  if (typeof now !== 'function') throw new Error('now must be a function');
  const range = quarterlyRefreshRange(now());
  const summary = await backfill({
    rootDir: resolve(rootDir),
    ...range,
    refreshRecent,
    now,
    logger: { log() {}, warn: (...args) => logger.warn?.(...args) },
  });
  const rebuilt = summary.rawWritten > 0
    ? await rebuild({ rootDir: resolve(rootDir) })
    : null;
  logger.log([
    'quarterly-refresh:',
    `range=${range.fromSeason}..${range.toSeason}`,
    `requests=${summary.requests}`,
    `written=${summary.rawWritten}`,
    `revisions=${summary.revisions ?? 0}`,
    `unchanged=${summary.unchanged ?? 0}`,
    `unpublished=${summary.unpublished ?? 0}`,
    `rebuilt=${rebuilt === null ? 'no' : 'yes'}`,
  ].join(' '));
  return { range, backfill: summary, rebuilt };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    const options = quarterlyRefreshOptionsFromArgs(parseArgs(process.argv.slice(2)));
    await runQuarterlyRefresh(options);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
