import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import { isTwseMiIndexTradingDay } from './lib/derived.mjs';
import { parseGregorianDate, taipeiIsoDate } from './lib/date.mjs';
import { listJsonDates, readJsonIfExists, writeFileEnsured } from './lib/io.mjs';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const NON_TRADING_STAT = '很抱歉，沒有符合條件的資料!';

export const COVERAGE_SOURCES = {
  twse: [
    'twse/mi_index_hist',
    'twse/t86_hist',
    'twse/mi_margn_hist',
    'twse/bwibbu_hist',
    'twse/stock_day_all',
  ],
  tpex: [
    'tpex/daily_quotes_hist',
    'tpex/insti_hist',
    'tpex/margin_hist',
    'tpex/mainboard_close',
  ],
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function assertIso(label, value) {
  const text = String(value ?? '');
  if (parseGregorianDate(text) !== text) {
    throw new Error(`${label} must be YYYY-MM-DD, got: ${value}`);
  }
  return text;
}

function* isoDaysAscending(fromIso, toIso) {
  const cursor = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function isWeekday(iso) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function sortedUnion(sets) {
  return new Set(sets.flatMap((set) => [...set]).sort());
}

export async function collectCoveredDates(rootDir = process.cwd(), sources = COVERAGE_SOURCES) {
  const rawRoot = join(resolve(rootDir), 'data', 'raw');
  const bySource = {};
  for (const market of ['twse', 'tpex']) {
    for (const source of sources[market]) {
      bySource[source] = new Set(await listJsonDates(join(rawRoot, source)));
    }
  }
  return {
    bySource,
    twse: sortedUnion(sources.twse.map((source) => bySource[source])),
    tpex: sortedUnion(sources.tpex.map((source) => bySource[source])),
  };
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
}

async function fetchTradingDayPayload(iso, fetchImpl) {
  const url = BACKFILL_ENDPOINTS.twse_mi_index_hist.url(iso.replaceAll('-', ''));
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://www.twse.com.tw/',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`${url}: ${error?.message ?? error}`);
  }
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return { url, payload: parseJsonBytes(Buffer.from(await response.arrayBuffer()), `MI_INDEX ${iso}`) };
}

function cachePath(rootDir) {
  return join(rootDir, '.gap-scan-cache.json');
}

function isCachedNonTrading(cache, iso) {
  return cache?.nonTrading?.[iso]?.stat === NON_TRADING_STAT;
}

async function saveNonTradingCache(rootDir, cache) {
  const ordered = {};
  for (const iso of Object.keys(cache.nonTrading).sort()) ordered[iso] = cache.nonTrading[iso];
  await writeFileEnsured(
    cachePath(rootDir),
    `${JSON.stringify({ nonTrading: ordered }, null, 2)}\n`,
  );
}

export async function detectGaps({
  rootDir = process.cwd(),
  fromIso,
  toIso,
  delayMs = 3000,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  now = () => new Date(),
  logger = console,
  datesOnly = false,
  coverageSources = COVERAGE_SOURCES,
} = {}) {
  rootDir = resolve(rootDir);
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`--delay-ms must be a non-negative number, got: ${delayMs}`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  const covered = await collectCoveredDates(rootDir, coverageSources);
  const allCovered = sortedUnion([covered.twse, covered.tpex]);
  const defaultFrom = [...allCovered].at(0);
  const defaultTo = [...allCovered].at(-1);
  fromIso = fromIso === undefined ? defaultFrom : assertIso('--from', fromIso);
  toIso = toIso === undefined ? defaultTo : assertIso('--to', toIso);
  if (!fromIso || !toIso) throw new Error('cannot infer scan range from empty coverage; pass --from and --to');
  if (fromIso > toIso) throw new Error(`--from must be <= --to, got: ${fromIso} > ${toIso}`);

  const today = taipeiIsoDate(now());
  const candidates = new Map();
  let weekdays = 0;
  for (const iso of isoDaysAscending(fromIso, toIso)) {
    if (iso >= today || !isWeekday(iso)) continue;
    weekdays += 1;
    const markets = [];
    if (!covered.twse.has(iso)) markets.push('twse');
    if (!covered.tpex.has(iso)) markets.push('tpex');
    if (markets.length) candidates.set(iso, markets);
  }

  const cache = await readJsonIfExists(cachePath(rootDir), { nonTrading: {} });
  if (!cache.nonTrading || typeof cache.nonTrading !== 'object' || Array.isArray(cache.nonTrading)) {
    throw new Error(`${cachePath(rootDir)}: nonTrading must be an object`);
  }

  const gaps = [];
  let checked = 0;
  let cachedNonTrading = 0;
  for (const [iso, markets] of candidates) {
    if (isCachedNonTrading(cache, iso)) {
      cachedNonTrading += 1;
      continue;
    }
    const { payload } = await fetchTradingDayPayload(iso, fetchImpl);
    checked += 1;
    await sleepImpl(delayMs);
    if (isTwseMiIndexTradingDay(payload)) {
      gaps.push({ date: iso, markets });
      continue;
    }
    if (payload?.stat !== NON_TRADING_STAT || Object.hasOwn(payload ?? {}, 'tables')) {
      throw new Error(`MI_INDEX ${iso}: unexpected non-trading response shape: ${JSON.stringify(payload).slice(0, 500)}`);
    }
    cache.nonTrading[iso] = { stat: payload.stat };
    await saveNonTradingCache(rootDir, cache);
  }

  const dates = gaps.map((gap) => gap.date);
  const datesCsv = dates.join(',');
  if (datesOnly) {
    logger.log(datesCsv);
  } else {
    logger.log(datesCsv);
    for (const gap of gaps) logger.log(`[gap] ${gap.date} markets=${gap.markets.join(',')}`);
    if (gaps.length === 0) logger.log(`[done] zero gaps in ${fromIso}..${toIso}`);
    else logger.log(`[done] gaps=${gaps.length} in ${fromIso}..${toIso}`);
    logger.log(`[scan] twseCovered=${covered.twse.size} tpexCovered=${covered.tpex.size} weekdays=${weekdays} candidates=${candidates.size} checked=${checked} cachedNonTrading=${cachedNonTrading}`);
  }

  return { covered, fromIso, toIso, weekdays, candidates, checked, cachedNonTrading, gaps, dates, datesCsv };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = String(args.out ?? process.cwd());
  if (args['coverage-only']) {
    const covered = await collectCoveredDates(rootDir);
    console.log(`twse_covered=${covered.twse.size}`);
    console.log(`tpex_covered=${covered.tpex.size}`);
    return;
  }
  await detectGaps({
    rootDir,
    fromIso: args.from,
    toIso: args.to,
    delayMs: Number(args['delay-ms'] ?? 3000),
    datesOnly: Boolean(args['dates-only']),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
