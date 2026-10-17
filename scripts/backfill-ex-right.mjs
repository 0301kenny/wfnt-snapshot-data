import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseNumericFlag } from './lib/cli.mjs';
import { taipeiIsoDate } from './lib/date.mjs';
import { applyCorporateActions } from './lib/derived.mjs';
import { fetchExRightDataset } from './lib/ex-right.mjs';

function parseArgs(argv) {
  const allowed = new Set(['market', 'from-year', 'to-year', 'out', 'delay-ms']);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') || !allowed.has(token.slice(2))) {
      throw new Error(`unknown argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function assertOptions({ market, fromYear, toYear, delayMs, now }) {
  if (!['twse', 'tpex'].includes(market)) {
    throw new Error(`--market must be twse or tpex, got: ${market}`);
  }
  if (!Number.isInteger(fromYear) || fromYear < 1000 || fromYear > 9999) {
    throw new Error(`--from-year must be a four-digit year, got: ${fromYear}`);
  }
  if (!Number.isInteger(toYear) || toYear < 1000 || toYear > 9999) {
    throw new Error(`--to-year must be a four-digit year, got: ${toYear}`);
  }
  if (fromYear > toYear) {
    throw new Error(`--from-year must be <= --to-year, got: ${fromYear} > ${toYear}`);
  }
  const today = taipeiIsoDate(now());
  const currentYear = Number(today.slice(0, 4));
  if (toYear >= currentYear) {
    throw new Error(`--to-year must be before Taipei current year ${currentYear}, got: ${toYear}`);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`--delay-ms must be a non-negative number, got: ${delayMs}`);
  }
  return { today };
}

export function exRightBackfillOptionsFromArgs(args, { now = () => new Date() } = {}) {
  const fromYear = parseNumericFlag(args['from-year'], Number.NaN);
  const toYear = parseNumericFlag(args['to-year'], Number.NaN);
  const delayMs = parseNumericFlag(args['delay-ms'], 3000);
  const checked = assertOptions({
    market: args.market,
    fromYear,
    toYear,
    delayMs,
    now,
  });
  return {
    rootDir: args.out === undefined ? process.cwd() : resolve(args.out),
    market: args.market,
    fromYear,
    toYear,
    delayMs,
    now,
    ...checked,
  };
}

export async function runExRightBackfill({
  rootDir = process.cwd(),
  market,
  fromYear,
  toYear,
  delayMs = 3000,
  now = () => new Date(),
  fetcher = globalThis.fetch,
  sleepImpl = sleep,
  applyCorporateActionsImpl = applyCorporateActions,
  logger = console,
} = {}) {
  rootDir = resolve(rootDir);
  const { today } = assertOptions({ market, fromYear, toYear, delayMs, now });
  logger.log(`[backfill-ex-right] market=${market} range=${fromYear}..${toYear} out=${rootDir} delay=${delayMs}ms`);
  const fetched = await fetchExRightDataset(rootDir, `${market}_ex_right`, today, {
    fetcher,
    sleepImpl,
    delayMs,
    startYear: fromYear,
    endYear: toYear,
    skipEmpty: true,
  });
  if (!fetched.ok) throw new Error(fetched.error);
  for (const year of fetched.emptyYears) logger.log(`[empty] ${market} ${year}`);
  const derived = await applyCorporateActionsImpl(rootDir);
  const summary = {
    market,
    fromYear,
    toYear,
    rawWritten: fetched.rawWritten,
    empty: fetched.emptyYears.length,
    corporateActions: derived.corporateActions,
    derivedWritten: derived.written,
  };
  logger.log(`[done] market=${market} years=${toYear - fromYear + 1} rawWritten=${summary.rawWritten} empty=${summary.empty} corporateActions=${summary.corporateActions} derivedWritten=${summary.derivedWritten}`);
  return summary;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    await runExRightBackfill(exRightBackfillOptionsFromArgs(parseArgs(process.argv.slice(2))));
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
