// TAIFEX Put/Call Ratio monthly backfill. Each official Big5 CSV response is
// authoritative raw; parsing is used to reject HTTP-200 error pages before write.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { applyTaifexPcrMonth, parseTaifexPcrCsv } from './lib/derived.mjs';
import { writeFileEnsured } from './lib/io.mjs';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
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

function assertMonth(label, value) {
  const text = String(value ?? '');
  if (!MONTH_RE.test(text)) throw new Error(`${label} must be YYYY-MM, got: ${value}`);
  return text;
}

function* monthsAscending(fromMonth, toMonth) {
  let year = Number(fromMonth.slice(0, 4));
  let month = Number(fromMonth.slice(5));
  const end = Number(toMonth.replace('-', ''));
  while (year * 100 + month <= end) {
    yield `${year}-${String(month).padStart(2, '0')}`;
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
}

function rawPath(rootDir, sourceDataset, monthKey) {
  return join(
    rootDir,
    'data',
    'raw',
    sourceDataset,
    monthKey.slice(0, 4),
    `${monthKey}.csv`,
  );
}

function requestBodyForMonth(monthKey) {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5));
  const monthText = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new URLSearchParams({
    down_type: '1',
    queryStartDate: `${year}/${monthText}/01`,
    queryEndDate: `${year}/${monthText}/${String(lastDay).padStart(2, '0')}`,
  }).toString();
}

function validatedRows(bytes) {
  const rows = parseTaifexPcrCsv(bytes);
  if (rows.length === 0) throw new Error('TAIFEX PCR: response has 0 data rows');
  return rows;
}

async function writeRawBytesOnChange(path, bytes) {
  try {
    const current = await readFile(path);
    if (current.equals(bytes)) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFileEnsured(path, bytes);
  return true;
}

async function readValidRaw(path) {
  try {
    const bytes = await readFile(path);
    return { bytes, rows: validatedRows(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function fetchPcrMonth(endpoint, monthKey, {
  fetchImpl,
  sleepImpl,
  maxRetries,
  retryBaseMs,
  logger,
  onRequest,
}) {
  const body = requestBodyForMonth(monthKey);
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    onRequest();
    try {
      const response = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: 'https://www.taifex.com.tw/',
          Accept: 'text/csv,text/plain,text/html,*/*',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes, rows: validatedRows(bytes) };
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      const backoffMs = retryBaseMs * (2 ** attempt);
      logger.warn(`[retry] ${monthKey} attempt=${attempt + 1} error=${error.message} backoff=${backoffMs}ms`);
      await sleepImpl(backoffMs);
    }
  }
  throw new Error(`${monthKey}: ${lastError?.message ?? 'request failed'}`);
}

export async function runPcrBackfill({
  rootDir = process.cwd(),
  fromMonth,
  toMonth,
  delayMs = 3000,
  maxRetries = 4,
  retryBaseMs = 1000,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  applyTaifexPcrMonthImpl = applyTaifexPcrMonth,
  logger = console,
} = {}) {
  rootDir = resolve(rootDir);
  fromMonth = assertMonth('--from', fromMonth);
  toMonth = assertMonth('--to', toMonth);
  if (fromMonth > toMonth) {
    throw new Error(`--from must be <= --to, got: ${fromMonth} > ${toMonth}`);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`--delay-ms must be a non-negative number, got: ${delayMs}`);
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`--max-retries must be a non-negative integer, got: ${maxRetries}`);
  }
  if (!Number.isFinite(retryBaseMs) || retryBaseMs < 0) {
    throw new Error(`--retry-base-ms must be a non-negative number, got: ${retryBaseMs}`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
  if (typeof sleepImpl !== 'function') throw new Error('sleepImpl must be a function');

  const endpoint = BACKFILL_ENDPOINTS.taifex_pcr;
  const summary = {
    months: 0,
    requests: 0,
    skipped: 0,
    rawWritten: 0,
    derivedWritten: 0,
    rows: 0,
    failures: [],
  };
  logger.log(`[backfill-pcr] range ${fromMonth}..${toMonth} out=${rootDir} delay=${delayMs}ms`);

  for (const monthKey of monthsAscending(fromMonth, toMonth)) {
    summary.months += 1;
    const path = rawPath(rootDir, endpoint.sourceDataset, monthKey);
    const requestsBeforeMonth = summary.requests;
    try {
      let payload;
      try {
        payload = await readValidRaw(path);
      } catch (error) {
        logger.warn(`[refetch] ${monthKey} invalid existing raw: ${error.message}`);
        payload = null;
      }
      if (payload) {
        summary.skipped += 1;
      } else {
        payload = await fetchPcrMonth(endpoint, monthKey, {
          fetchImpl,
          sleepImpl,
          maxRetries,
          retryBaseMs,
          logger,
          onRequest() { summary.requests += 1; },
        });
        if (await writeRawBytesOnChange(path, payload.bytes)) summary.rawWritten += 1;
      }
      summary.rows += payload.rows.length;
      const derived = await applyTaifexPcrMonthImpl(rootDir, monthKey);
      if (derived.market) summary.derivedWritten += 1;
      logger.log(`[ok] ${monthKey} rows=${payload.rows.length} rawWritten=${payload ? summary.rawWritten : 0}`);
    } catch (error) {
      summary.failures.push({ month: monthKey, error: error.message });
      logger.warn(`[fail] ${monthKey}: ${error.message}`);
    } finally {
      if (summary.requests > requestsBeforeMonth && delayMs > 0) await sleepImpl(delayMs);
    }
  }

  logger.log(`[done] months=${summary.months} requests=${summary.requests} skipped=${summary.skipped} rawWritten=${summary.rawWritten} derivedWritten=${summary.derivedWritten} rows=${summary.rows} failed=${summary.failures.length}`);
  if (summary.failures.length > 0) {
    const error = new Error(`TAIFEX PCR backfill completed with ${summary.failures.length} failure(s)`);
    error.summary = summary;
    throw error;
  }
  return summary;
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
  runPcrBackfill(pcrBackfillOptionsFromArgs(parseArgs(process.argv.slice(2)))).catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
