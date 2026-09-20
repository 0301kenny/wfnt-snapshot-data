// TAIFEX foreign-investor TX futures net-open-interest monthly backfill.
// Official Big5 CSV bytes remain authoritative; parsing only validates before write.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { taipeiIsoDate } from './lib/date.mjs';
import {
  applyTaifexForeignFuturesMonth,
  parseTaifexForeignFuturesCsv,
} from './lib/derived.mjs';
import {
  calendarMonthRequestBody,
  parseLongArgs,
  runTaifexMonthlyBackfill,
} from './lib/taifex-monthly-backfill.mjs';

function clockDate(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`now must return a valid Date, got: ${value}`);
  return date;
}

function utcMonthKey(year, zeroBasedMonth) {
  const date = new Date(Date.UTC(year, zeroBasedMonth, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function foreignFuturesDefaultRange(now = () => new Date()) {
  const today = clockDate(now);
  const [year, month] = taipeiIsoDate(today).split('-').map(Number);
  return {
    // The upstream window is approximately three years. Start with the first
    // complete month after that boundary so a moving partial month cannot fail
    // the whole request with an HTTP-200 DateTime error page.
    fromMonth: utcMonthKey(year - 3, month),
    // Avoid asking for future dates in the current, incomplete month.
    toMonth: utcMonthKey(year, month - 2),
  };
}

export async function runForeignFuturesBackfill({
  fromMonth,
  toMonth,
  now = () => new Date(),
  applyTaifexForeignFuturesMonthImpl = applyTaifexForeignFuturesMonth,
  ...options
} = {}) {
  const defaults = foreignFuturesDefaultRange(now);
  return runTaifexMonthlyBackfill({
    ...options,
    fromMonth: fromMonth ?? defaults.fromMonth,
    toMonth: toMonth ?? defaults.toMonth,
    endpoint: BACKFILL_ENDPOINTS.taifex_foreign_futures,
    label: 'TAIFEX foreign futures',
    logPrefix: 'backfill-foreign-futures',
    requestBodyForMonth: (monthKey) => calendarMonthRequestBody(monthKey, { commodityId: 'TXF' }),
    parseRows: parseTaifexForeignFuturesCsv,
    requireHeader: true,
    applyMonthImpl: applyTaifexForeignFuturesMonthImpl,
  });
}

export function foreignFuturesBackfillOptionsFromArgs(args) {
  return {
    rootDir: args.out ?? process.cwd(),
    fromMonth: args.from,
    toMonth: args.to,
    delayMs: parseNumericFlag(args['delay-ms'], 3000),
    maxRetries: parseNumericFlag(args['max-retries'], 4),
    retryBaseMs: parseNumericFlag(args['retry-base-ms'], 1000),
  };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  runForeignFuturesBackfill(
    foreignFuturesBackfillOptionsFromArgs(parseLongArgs(process.argv.slice(2))),
  ).catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
