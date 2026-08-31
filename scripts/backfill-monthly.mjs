// MOPS monthly revenue historical backfill. Each official big5 HTML response is
// authoritative raw; parsing is used only to reject shell or malformed bodies.

import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { validateMopsMonthlyRevenueHtml } from './lib/derived.mjs';
import { writeFileEnsured } from './lib/io.mjs';

const MONTH_RE = /^(\d{4})-(\d{2})$/;
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
  const match = MONTH_RE.exec(text);
  const month = Number(match?.[2]);
  if (!match || month < 1 || month > 12) {
    throw new Error(`${label} must be YYYY-MM, got: ${value}`);
  }
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

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
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

function rawPath(rootDir, sourceDataset, monthKey, variant) {
  return join(
    rootDir,
    'data',
    'raw',
    sourceDataset,
    monthKey.slice(0, 4),
    `${monthKey}_${variant}.html`,
  );
}

async function fetchMopsBytes(url, { fetchImpl, sleepImpl, delayMs }) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://mopsov.twse.com.tw/',
        Accept: 'text/html,*/*',
      },
      signal: AbortSignal.timeout(60_000),
    });
  } finally {
    await sleepImpl(delayMs);
  }
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function runMonthlyBackfill({
  rootDir = process.cwd(),
  fromMonth,
  toMonth,
  delayMs = 3000,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
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
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  const endpoints = [
    BACKFILL_ENDPOINTS.twse_monthly_revenue_hist,
    BACKFILL_ENDPOINTS.tpex_monthly_revenue_hist,
  ];
  const summary = { months: 0, requests: 0, skipped: 0, rawWritten: 0, rows: 0 };
  logger.log(`[backfill-monthly] range ${fromMonth}..${toMonth} out=${rootDir} delay=${delayMs}ms`);

  for (const monthKey of monthsAscending(fromMonth, toMonth)) {
    summary.months += 1;
    const gregorianYear = Number(monthKey.slice(0, 4));
    const month = Number(monthKey.slice(5));
    const rocYear = gregorianYear - 1911;
    const rocMonth = `${rocYear}${String(month).padStart(2, '0')}`;
    for (const endpoint of endpoints) {
      for (const variant of [0, 1]) {
        const path = rawPath(rootDir, endpoint.sourceDataset, monthKey, variant);
        if (await fileExists(path)) {
          summary.skipped += 1;
          logger.log(`[skip] ${endpoint.sourceDataset}: ${monthKey}_${variant}`);
          continue;
        }
        const url = endpoint.url(rocYear, month, variant);
        summary.requests += 1;
        const bytes = await fetchMopsBytes(url, { fetchImpl, sleepImpl, delayMs });
        let rows;
        try {
          rows = validateMopsMonthlyRevenueHtml(bytes, rocMonth);
        } catch (error) {
          throw new Error(`${url}: ${error.message}`);
        }
        if (await writeRawBytesOnChange(path, bytes)) summary.rawWritten += 1;
        summary.rows += rows.length;
        logger.log(`[write] ${endpoint.sourceDataset}: ${monthKey}_${variant} bytes=${bytes.length} rows=${rows.length}`);
      }
    }
  }

  logger.log(`[done] months=${summary.months} requests=${summary.requests} skipped=${summary.skipped} rawWritten=${summary.rawWritten} rows=${summary.rows}`);
  return summary;
}

export function monthlyBackfillOptionsFromArgs(args) {
  return {
    rootDir: args.out ?? process.cwd(),
    fromMonth: args.from,
    toMonth: args.to,
    delayMs: parseNumericFlag(args['delay-ms'], 3000),
  };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  runMonthlyBackfill(monthlyBackfillOptionsFromArgs(parseArgs(process.argv.slice(2)))).catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
