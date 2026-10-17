import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { taipeiIsoDate } from './lib/date.mjs';
import { applyTpexIndexMonth, parseTpexIndexHist } from './lib/derived.mjs';
import { writeFileEnsured } from './lib/io.mjs';
import { assertMonth, monthsAscending } from './lib/taifex-monthly-backfill.mjs';

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
  return join(rootDir, 'data', 'raw', 'tpex', 'index_hist', monthKey.slice(0, 4), `${monthKey}.json`);
}

async function readValidRaw(path, monthKey) {
  try {
    const bytes = await readFile(path);
    const rows = parseTpexIndexHist(JSON.parse(bytes.toString('utf8')), monthKey);
    return { bytes, rows };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
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

export function tpexIndexBackfillOptionsFromArgs(args, { now = () => new Date() } = {}) {
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

export async function runTpexIndexBackfill({
  rootDir = process.cwd(),
  fromMonth,
  toMonth,
  delayMs = 3000,
  fetcher = globalThis.fetch,
  sleepImpl = sleep,
  applyMonthImpl = applyTpexIndexMonth,
  now = () => new Date(),
  logger = console,
} = {}) {
  rootDir = resolve(rootDir);
  const checked = assertOptions({ fromMonth, toMonth, delayMs, now });
  const endpoint = BACKFILL_ENDPOINTS.tpex_index_hist;
  const summary = {
    months: 0,
    requests: 0,
    skipped: 0,
    rawWritten: 0,
    derivedWritten: 0,
    rows: 0,
    failures: [],
  };
  logger.log(`[backfill-tpex-index] range ${checked.fromMonth}..${checked.toMonth} out=${rootDir} delay=${delayMs}ms`);
  for (const monthKey of monthsAscending(checked.fromMonth, checked.toMonth)) {
    summary.months += 1;
    try {
      let payload = null;
      const path = rawPath(rootDir, monthKey);
      if (monthKey !== checked.currentMonth) {
        try {
          payload = await readValidRaw(path, monthKey);
        } catch (error) {
          logger.warn(`[refetch] ${monthKey} invalid existing raw: ${error.message}`);
        }
      }
      if (payload) {
        summary.skipped += 1;
      } else {
        if (summary.requests > 0 && delayMs > 0) await sleepImpl(delayMs);
        summary.requests += 1;
        const response = await fetcher(endpoint.url(monthKey), {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const rows = parseTpexIndexHist(JSON.parse(bytes.toString('utf8')), monthKey);
        payload = { bytes, rows };
        if (await writeOnChange(path, bytes)) summary.rawWritten += 1;
      }
      const derived = await applyMonthImpl(rootDir, monthKey);
      summary.rows += payload.rows.length;
      if (derived.market) summary.derivedWritten += 1;
      logger.log(`[ok] ${monthKey} rows=${payload.rows.length}`);
    } catch (error) {
      summary.failures.push({ month: monthKey, error: error?.message ?? String(error) });
      logger.error(`[fail] ${monthKey}: ${error?.message ?? error}`);
    }
  }
  logger.log(`[done] months=${summary.months} requests=${summary.requests} skipped=${summary.skipped} rawWritten=${summary.rawWritten} derivedWritten=${summary.derivedWritten} rows=${summary.rows} failed=${summary.failures.length}`);
  return summary;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    const options = tpexIndexBackfillOptionsFromArgs(parseArgs(process.argv.slice(2)));
    const summary = await runTpexIndexBackfill(options);
    if (summary.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
