import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { taipeiIsoDate } from './lib/date.mjs';
import { writeFileEnsured } from './lib/io.mjs';
import { assertMonth, monthsAscending } from './lib/taifex-monthly-backfill.mjs';

const EXPECTED_FIELDS = ['日　期', '發行量加權股價報酬指數'];
const ROC_DATE_RE = /^(\d{2,3})\/(\d{2})\/(\d{2})$/;

function parseArgs(argv) {
  const allowed = new Set(['from', 'to', 'out', 'delay-ms']);
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

function currentTaipeiMonth(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`now must return a valid Date, got: ${value}`);
  return taipeiIsoDate(date).slice(0, 7);
}

function assertOptions({ fromMonth, toMonth, delayMs, now }) {
  const from = assertMonth('--from', fromMonth);
  const to = assertMonth('--to', toMonth);
  if (from > to) throw new Error(`--from must be <= --to, got: ${from} > ${to}`);
  const currentMonth = currentTaipeiMonth(now);
  if (to > currentMonth) {
    throw new Error(`--to must not be after Taipei current month ${currentMonth}, got: ${to}`);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`--delay-ms must be a non-negative number, got: ${delayMs}`);
  }
  return { fromMonth: from, toMonth: to, currentMonth };
}

function rawPath(rootDir, monthKey) {
  return join(rootDir, 'data', 'raw', 'twse', 'mfi94u_hist', monthKey.slice(0, 4), `${monthKey}.json`);
}

// Official ROC dates are padded to 3 characters with a leading half-width space for
// years below 100 (" 95/10/02"), so trim before matching and accept 2 or 3 digit years.
function rocDateToMonth(text) {
  const match = ROC_DATE_RE.exec(String(text).trim());
  if (!match) throw new Error(`unparseable ROC date: ${JSON.stringify(text)}`);
  return `${Number(match[1]) + 1911}-${match[2]}`;
}

export function validateTwseReturnIndexMonth(bytes, monthKey) {
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw new Error('twse/mfi94u_hist: invalid JSON');
  }
  if (payload?.stat !== 'OK') throw new Error(`unexpected stat: ${payload?.stat}`);
  if (
    !Array.isArray(payload.fields)
    || payload.fields.length !== EXPECTED_FIELDS.length
    || payload.fields.some((field, index) => field !== EXPECTED_FIELDS[index])
  ) {
    throw new Error('unexpected fields');
  }
  if (!Array.isArray(payload.data) || payload.data.length === 0) throw new Error('no data rows');
  for (const row of payload.data) {
    if (!Array.isArray(row) || row.length !== 2) throw new Error('row width must be 2');
    const month = rocDateToMonth(row[0]);
    if (month !== monthKey) throw new Error(`row date ${JSON.stringify(row[0])} is outside ${monthKey}`);
  }
  return payload.data;
}

async function readValidRaw(path, monthKey) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return { bytes, rows: validateTwseReturnIndexMonth(bytes, monthKey) };
}

async function writeOnChange(path, bytes) {
  try {
    if ((await readFile(path)).equals(bytes)) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFileEnsured(path, bytes);
  return true;
}

export function twseReturnIndexBackfillOptionsFromArgs(args, { now = () => new Date() } = {}) {
  const delayMs = parseNumericFlag(args['delay-ms'], 3000);
  const checked = assertOptions({
    fromMonth: args.from,
    toMonth: args.to,
    delayMs,
    now,
  });
  return {
    rootDir: args.out === undefined ? process.cwd() : resolve(args.out),
    ...checked,
    delayMs,
    now,
  };
}

export async function runTwseReturnIndexBackfill({
  rootDir = process.cwd(),
  fromMonth,
  toMonth,
  delayMs = 3000,
  fetcher = globalThis.fetch,
  sleepImpl = sleep,
  now = () => new Date(),
  logger = console,
} = {}) {
  rootDir = resolve(rootDir);
  const checked = assertOptions({ fromMonth, toMonth, delayMs, now });
  const endpoint = BACKFILL_ENDPOINTS.twse_mfi94u_hist;
  const summary = { months: 0, requests: 0, skipped: 0, rawWritten: 0, rows: 0, failures: [] };
  logger.log(`[backfill-twse-return-index] range ${checked.fromMonth}..${checked.toMonth} out=${rootDir} delay=${delayMs}ms`);
  for (const monthKey of monthsAscending(checked.fromMonth, checked.toMonth)) {
    summary.months += 1;
    try {
      const path = rawPath(rootDir, monthKey);
      let existing = null;
      if (monthKey !== checked.currentMonth) {
        try {
          existing = await readValidRaw(path, monthKey);
        } catch (error) {
          logger.warn(`[refetch] ${monthKey} invalid existing raw: ${error.message}`);
        }
      }
      if (existing) {
        summary.skipped += 1;
        summary.rows += existing.rows.length;
        logger.log(`[skip] ${monthKey} rows=${existing.rows.length}`);
        continue;
      }
      if (summary.requests > 0 && delayMs > 0) await sleepImpl(delayMs);
      summary.requests += 1;
      const response = await fetcher(endpoint.url(monthKey), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const rows = validateTwseReturnIndexMonth(bytes, monthKey);
      if (await writeOnChange(path, bytes)) summary.rawWritten += 1;
      summary.rows += rows.length;
      logger.log(`[ok] ${monthKey} rows=${rows.length}`);
    } catch (error) {
      summary.failures.push({ month: monthKey, error: error?.message ?? String(error) });
      logger.error(`[fail] ${monthKey}: ${error?.message ?? error}`);
    }
  }
  logger.log(`[done] months=${summary.months} requests=${summary.requests} skipped=${summary.skipped} rawWritten=${summary.rawWritten} rows=${summary.rows} failed=${summary.failures.length}`);
  return summary;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    const options = twseReturnIndexBackfillOptionsFromArgs(parseArgs(process.argv.slice(2)));
    const summary = await runTwseReturnIndexBackfill(options);
    if (summary.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
