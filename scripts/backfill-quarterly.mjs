// MOPS quarterly financial historical backfill. Each official UTF-8 HTML
// response is authoritative raw; parsing is used only to reject error pages.

import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { parseMopsQuarterlyFinHtml } from './lib/derived.mjs';
import { writeFileEnsured } from './lib/io.mjs';

const SEASON_RE = /^(\d{4})-Q([1-4])$/;
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

function assertSeason(label, value) {
  const text = String(value ?? '');
  if (!SEASON_RE.test(text)) throw new Error(`${label} must be YYYY-Qn, got: ${value}`);
  return text;
}

function seasonInt(seasonKey) {
  return Number(seasonKey.slice(0, 4)) * 10 + Number(seasonKey.slice(-1));
}

function* seasonsAscending(fromSeason, toSeason) {
  let year = Number(fromSeason.slice(0, 4));
  let season = Number(fromSeason.slice(-1));
  const end = seasonInt(toSeason);
  while (year * 10 + season <= end) {
    yield `${year}-Q${season}`;
    season += 1;
    if (season === 5) {
      year += 1;
      season = 1;
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

function rawPath(rootDir, sourceDataset, seasonKey) {
  return join(
    rootDir,
    'data',
    'raw',
    sourceDataset,
    seasonKey.slice(0, 4),
    `${seasonKey}.html`,
  );
}

function formBody(typek, seasonKey) {
  const params = new URLSearchParams({
    encodeURIComponent: '1',
    step: '1',
    firstin: '1',
    off: '1',
    isQuery: 'Y',
    TYPEK: typek,
    year: String(Number(seasonKey.slice(0, 4)) - 1911),
    season: String(Number(seasonKey.slice(-1))).padStart(2, '0'),
  });
  return params.toString();
}

async function fetchMopsBytes(endpoint, seasonKey, { fetchImpl, sleepImpl, delayMs }) {
  let response;
  try {
    response = await fetchImpl(endpoint.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Referer: 'https://mopsov.twse.com.tw/',
        Accept: 'text/html,*/*',
      },
      body: formBody(endpoint.typek, seasonKey),
      signal: AbortSignal.timeout(60_000),
    });
  } finally {
    await sleepImpl(delayMs);
  }
  if (!response.ok) throw new Error(`${endpoint.url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function runQuarterlyBackfill({
  rootDir = process.cwd(),
  fromSeason,
  toSeason,
  delayMs = 3000,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  logger = console,
} = {}) {
  rootDir = resolve(rootDir);
  fromSeason = assertSeason('--from', fromSeason);
  toSeason = assertSeason('--to', toSeason);
  if (!fromSeason.endsWith('-Q1')) {
    throw new Error(`--from must start at Q1 because later quarters require same-year cumulative differencing, got: ${fromSeason}`);
  }
  if (seasonInt(fromSeason) > seasonInt(toSeason)) {
    throw new Error(`--from must be <= --to, got: ${fromSeason} > ${toSeason}`);
  }
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`--delay-ms must be a non-negative number, got: ${delayMs}`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  const endpoints = [
    BACKFILL_ENDPOINTS.twse_quarterly_fin_hist,
    BACKFILL_ENDPOINTS.tpex_quarterly_fin_hist,
  ];
  const summary = { seasons: 0, requests: 0, skipped: 0, rawWritten: 0, rows: 0 };
  logger.log(`[backfill-quarterly] range ${fromSeason}..${toSeason} out=${rootDir} delay=${delayMs}ms`);

  for (const seasonKey of seasonsAscending(fromSeason, toSeason)) {
    summary.seasons += 1;
    for (const endpoint of endpoints) {
      const path = rawPath(rootDir, endpoint.sourceDataset, seasonKey);
      if (await fileExists(path)) {
        summary.skipped += 1;
        logger.log(`[skip] ${endpoint.sourceDataset}: ${seasonKey}`);
        continue;
      }
      summary.requests += 1;
      const bytes = await fetchMopsBytes(endpoint, seasonKey, { fetchImpl, sleepImpl, delayMs });
      let rows;
      try {
        rows = parseMopsQuarterlyFinHtml(bytes);
      } catch (error) {
        throw new Error(`${endpoint.url}: ${error.message}`);
      }
      if (await writeRawBytesOnChange(path, bytes)) summary.rawWritten += 1;
      summary.rows += rows.length;
      logger.log(`[write] ${endpoint.sourceDataset}: ${seasonKey} bytes=${bytes.length} rows=${rows.length}`);
    }
  }

  logger.log(`[done] seasons=${summary.seasons} requests=${summary.requests} skipped=${summary.skipped} rawWritten=${summary.rawWritten} rows=${summary.rows}`);
  return summary;
}

export function quarterlyBackfillOptionsFromArgs(args) {
  return {
    rootDir: args.out ?? process.cwd(),
    fromSeason: args.from,
    toSeason: args.to,
    delayMs: parseNumericFlag(args['delay-ms'], 3000),
  };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  runQuarterlyBackfill(quarterlyBackfillOptionsFromArgs(parseArgs(process.argv.slice(2)))).catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
