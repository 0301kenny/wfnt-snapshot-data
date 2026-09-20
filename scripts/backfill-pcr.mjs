// TAIFEX Put/Call Ratio monthly backfill. Each official Big5 CSV response is
// authoritative raw; parsing is used to reject HTTP-200 error pages before write.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { applyTaifexPcrMonth, parseTaifexPcrCsv } from './lib/derived.mjs';
import {
  calendarMonthRequestBody,
  parseLongArgs,
  runTaifexMonthlyBackfill,
} from './lib/taifex-monthly-backfill.mjs';

export async function runPcrBackfill({
  applyTaifexPcrMonthImpl = applyTaifexPcrMonth,
  ...options
} = {}) {
  return runTaifexMonthlyBackfill({
    ...options,
    endpoint: BACKFILL_ENDPOINTS.taifex_pcr,
    label: 'TAIFEX PCR',
    logPrefix: 'backfill-pcr',
    requestBodyForMonth: calendarMonthRequestBody,
    parseRows: parseTaifexPcrCsv,
    requireHeader: false,
    applyMonthImpl: applyTaifexPcrMonthImpl,
  });
}

export function pcrBackfillOptionsFromArgs(args) {
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
  runPcrBackfill(pcrBackfillOptionsFromArgs(parseLongArgs(process.argv.slice(2)))).catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
