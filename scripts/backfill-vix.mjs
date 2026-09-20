// TAIFEX VIXTWN monthly backfill. Each official Big5 tab-separated response is
// authoritative raw; parsing rejects HTTP-200 404 pages before write.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { taipeiIsoDate } from './lib/date.mjs';
import { applyTaifexVixMonth, parseTaifexVixTxt } from './lib/derived.mjs';
import {
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

export function vixDefaultRange(now = () => new Date()) {
  const today = clockDate(now);
  const [year, month] = taipeiIsoDate(today).split('-').map(Number);
  return {
    fromMonth: utcMonthKey(year, month - 4),
    toMonth: utcMonthKey(year, month - 1),
  };
}

export async function runVixBackfill({
  fromMonth,
  toMonth,
  now = () => new Date(),
  delayMs = 2000,
  retryBaseMs = 2000,
  applyTaifexVixMonthImpl = applyTaifexVixMonth,
  ...options
} = {}) {
  const defaults = vixDefaultRange(now);
  return runTaifexMonthlyBackfill({
    ...options,
    fromMonth: fromMonth ?? defaults.fromMonth,
    toMonth: toMonth ?? defaults.toMonth,
    delayMs,
    retryBaseMs,
    endpoint: BACKFILL_ENDPOINTS.taifex_vix_monthly,
    label: 'TAIFEX VIX',
    logPrefix: 'backfill-vix',
    requestMethod: 'GET',
    requestBodyForMonth: undefined,
    rawExtension: 'txt',
    refreshExistingRaw: true,
    parseRows: parseTaifexVixTxt,
    requireHeader: true,
    headerPrefix: '交易日期',
    headerLabel: 'VIX header starting with 交易日期',
    applyMonthImpl: applyTaifexVixMonthImpl,
  });
}

export function vixBackfillOptionsFromArgs(args) {
  return {
    rootDir: args.out ?? process.cwd(),
    fromMonth: args.from,
    toMonth: args.to,
    delayMs: parseNumericFlag(args['delay-ms'], 2000),
    maxRetries: parseNumericFlag(args['max-retries'], 4),
    retryBaseMs: parseNumericFlag(args['retry-base-ms'], 2000),
  };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  runVixBackfill(vixBackfillOptionsFromArgs(parseLongArgs(process.argv.slice(2)))).catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
