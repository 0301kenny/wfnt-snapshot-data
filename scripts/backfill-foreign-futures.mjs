// TAIFEX foreign-investor TX futures net-open-interest monthly backfill.
// Official Big5 CSV bytes remain authoritative; parsing only validates before write.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { taipeiIsoDate } from './lib/date.mjs';
import {
  applyTaifexForeignFuturesMonth,
  parseTaifexPcrCsv,
  parseTaifexForeignFuturesCsv,
} from './lib/derived.mjs';
import {
  calendarMonthRequestBody,
  parseLongArgs,
  runTaifexMonthlyBackfill,
  taifexMonthlyRawPath,
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
    // complete month after that boundary.
    fromMonth: utcMonthKey(year - 3, month),
    toMonth: utcMonthKey(year, month - 1),
  };
}

export async function pcrMonthQueryEndDate(rootDir, monthKey) {
  const path = taifexMonthlyRawPath(
    resolve(rootDir),
    BACKFILL_ENDPOINTS.taifex_pcr.sourceDataset,
    monthKey,
  );
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`TAIFEX foreign futures ${monthKey}: PCR raw is required but missing`);
    }
    throw error;
  }

  let rows;
  try {
    rows = parseTaifexPcrCsv(bytes);
  } catch (error) {
    throw new Error(`TAIFEX foreign futures ${monthKey}: PCR raw is invalid: ${error.message}`);
  }
  const monthNumber = Number(monthKey.replace('-', ''));
  const dates = rows
    .map((row) => row[0])
    .filter((date) => Math.trunc(date / 100) === monthNumber);
  if (dates.length === 0) {
    throw new Error(`TAIFEX foreign futures ${monthKey}: PCR raw has 0 data rows for the month`);
  }
  const lastDate = String(Math.max(...dates));
  return `${lastDate.slice(0, 4)}/${lastDate.slice(4, 6)}/${lastDate.slice(6, 8)}`;
}

export async function runForeignFuturesBackfill({
  rootDir = process.cwd(),
  fromMonth,
  toMonth,
  now = () => new Date(),
  applyTaifexForeignFuturesMonthImpl = applyTaifexForeignFuturesMonth,
  ...options
} = {}) {
  const today = clockDate(now);
  const defaults = foreignFuturesDefaultRange(today);
  const effectiveFromMonth = fromMonth ?? defaults.fromMonth;
  const effectiveToMonth = toMonth ?? defaults.toMonth;
  const currentMonth = taipeiIsoDate(today).slice(0, 7);

  return runTaifexMonthlyBackfill({
    ...options,
    rootDir,
    fromMonth: effectiveFromMonth,
    toMonth: effectiveToMonth,
    endpoint: BACKFILL_ENDPOINTS.taifex_foreign_futures,
    label: 'TAIFEX foreign futures',
    logPrefix: 'backfill-foreign-futures',
    requestBodyForMonth: async (monthKey) => {
      const queryEndDate = monthKey === currentMonth
        ? await pcrMonthQueryEndDate(rootDir, currentMonth)
        : undefined;
      return calendarMonthRequestBody(monthKey, {
        commodityId: 'TXF',
        ...(queryEndDate ? { queryEndDate } : {}),
      });
    },
    refreshExistingRawForMonth: (monthKey) => monthKey === currentMonth,
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
