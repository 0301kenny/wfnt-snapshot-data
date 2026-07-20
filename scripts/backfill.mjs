// TWSE and TPEX legacy historical backfill. Raw response bytes are authoritative;
// derived output is produced only through scripts/lib/derived.mjs::applyDailyDate.

import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import {
  DEFAULT_SYMBOL_WINDOW,
  applyDailyDate,
  isTpexDailyQuotesTradingDay,
  isTwseMiIndexTradingDay,
  parseTpexDailyQuotesHist,
  parseTpexInstiHist,
  parseTpexMarginHist,
  parseTwseMiIndexHist,
  parseTwseMiMargnHist,
  parseTwseT86Hist,
} from './lib/derived.mjs';
import { yyyyOf } from './lib/date.mjs';
import { readJsonIfExists, writeFileEnsured } from './lib/io.mjs';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  if (!ISO_RE.test(text) || Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) {
    throw new Error(`${label} must be YYYY-MM-DD, got: ${value}`);
  }
  return text;
}

function isoToYmd(iso) {
  return iso.replaceAll('-', '');
}

function* isoDaysAscending(fromIso, toIso) {
  const cursor = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function parseJsonBytes(bytes, label) {
  try {
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
}

async function fetchBytesWithRetry(url, {
  delayMs,
  maxRetries,
  fetchImpl,
  sleepImpl,
  logger,
}) {
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: url.startsWith('https://www.tpex.org.tw/')
            ? 'https://www.tpex.org.tw/'
            : 'https://www.twse.com.tw/',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      return { ok: true, bytes: Buffer.from(await response.arrayBuffer()) };
    } catch (error) {
      attempt += 1;
      if (attempt > maxRetries) {
        return { ok: false, error: String(error?.message ?? error) };
      }
      const backoff = delayMs * 2 ** attempt;
      logger.warn(`[warn] ${url} attempt ${attempt} failed (${error?.message ?? error}); backoff ${backoff}ms`);
      await sleepImpl(backoff);
    }
  }
}

function rawPath(rootDir, sourceDataset, iso) {
  return join(rootDir, 'data', 'raw', sourceDataset, yyyyOf(iso), `${iso}.json`);
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

function checkpointPath(rootDir) {
  return join(rootDir, '.backfill-progress.json');
}

async function loadCheckpoint(rootDir) {
  return readJsonIfExists(checkpointPath(rootDir), { lastDate: null });
}

async function saveCheckpoint(rootDir, iso, now) {
  const checkpoint = { lastDate: iso, updatedAt: now().toISOString() };
  await writeFileEnsured(checkpointPath(rootDir), `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function fetchEndpoint(endpoint, iso, options) {
  const result = await fetchBytesWithRetry(endpoint.url(isoToYmd(iso)), options);
  await options.sleepImpl(options.delayMs);
  if (!result.ok) throw new Error(`${iso} ${endpoint.sourceDataset}: ${result.error}`);
  return result.bytes;
}

export async function runBackfill({
  rootDir = process.cwd(),
  fromIso,
  toIso,
  delayMs = 3000,
  symbolWindow = DEFAULT_SYMBOL_WINDOW,
  maxRetries = 3,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  logger = console,
  now = () => new Date(),
} = {}) {
  rootDir = resolve(rootDir);
  fromIso = assertIso('--from', fromIso);
  toIso = assertIso('--to', toIso);
  if (fromIso > toIso) throw new Error(`--from must be <= --to, got: ${fromIso} > ${toIso}`);
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`--delay-ms must be a non-negative number, got: ${delayMs}`);
  if (!Number.isInteger(symbolWindow) || symbolWindow <= 0) throw new Error(`--window must be a positive integer, got: ${symbolWindow}`);
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error(`maxRetries must be a non-negative integer, got: ${maxRetries}`);
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  const checkpoint = await loadCheckpoint(rootDir);
  const resumeAfter = checkpoint.lastDate;
  const summary = {
    trading: 0,
    skipped: 0,
    resumed: 0,
    openApiDays: 0,
    tpexOpenApiDays: 0,
    rawWritten: 0,
    derivedSymbols: 0,
  };
  logger.log(`[backfill] range ${fromIso}..${toIso} out=${rootDir} delay=${delayMs}ms window=${symbolWindow}${resumeAfter ? ` resumeAfter=${resumeAfter}` : ''}`);

  const fetchOptions = { delayMs, maxRetries, fetchImpl, sleepImpl, logger };
  for (const iso of isoDaysAscending(fromIso, toIso)) {
    if (resumeAfter && iso <= resumeAfter) {
      summary.resumed += 1;
      continue;
    }

    const twseOpenApiCloseExists = await fileExists(rawPath(rootDir, 'twse/stock_day_all', iso));
    let twseTrading = false;
    let twseSource = 'non-trading';
    let miIndexBytes = null;
    let t86Bytes = null;
    let miMargnBytes = null;
    if (twseOpenApiCloseExists) {
      summary.openApiDays += 1;
      twseTrading = true;
      twseSource = 'openapi+t86';
    } else {
      miIndexBytes = await fetchEndpoint(BACKFILL_ENDPOINTS.twse_mi_index_hist, iso, fetchOptions);
      const miIndex = parseJsonBytes(miIndexBytes, 'MI_INDEX');
      if (isTwseMiIndexTradingDay(miIndex)) {
        parseTwseMiIndexHist(miIndex);
        twseTrading = true;
        twseSource = 'legacy';
      }
    }

    if (twseTrading) {
      t86Bytes = await fetchEndpoint(BACKFILL_ENDPOINTS.twse_t86_hist, iso, fetchOptions);
      parseTwseT86Hist(parseJsonBytes(t86Bytes, 'T86'));
      if (!twseOpenApiCloseExists) {
        miMargnBytes = await fetchEndpoint(BACKFILL_ENDPOINTS.twse_mi_margn_hist, iso, fetchOptions);
        parseTwseMiMargnHist(parseJsonBytes(miMargnBytes, 'MI_MARGN'));
      }
    }

    const rawWrites = [];
    if (twseTrading && miIndexBytes) {
      rawWrites.push(writeRawBytesOnChange(
        rawPath(rootDir, BACKFILL_ENDPOINTS.twse_mi_index_hist.sourceDataset, iso),
        miIndexBytes,
      ));
    }
    if (t86Bytes) {
      rawWrites.push(writeRawBytesOnChange(
        rawPath(rootDir, BACKFILL_ENDPOINTS.twse_t86_hist.sourceDataset, iso),
        t86Bytes,
      ));
    }
    if (twseTrading && miMargnBytes) {
      rawWrites.push(writeRawBytesOnChange(
        rawPath(rootDir, BACKFILL_ENDPOINTS.twse_mi_margn_hist.sourceDataset, iso),
        miMargnBytes,
      ));
    }

    const tpexOpenApiCloseExists = await fileExists(rawPath(rootDir, 'tpex/mainboard_close', iso));
    let tpexTrading = false;
    let tpexSource = 'non-trading';
    let tpexDailyBytes = null;
    let tpexInstiBytes = null;
    let tpexMarginBytes = null;
    if (tpexOpenApiCloseExists) {
      summary.tpexOpenApiDays += 1;
      tpexTrading = true;
      tpexSource = 'openapi';
    } else {
      tpexDailyBytes = await fetchEndpoint(BACKFILL_ENDPOINTS.tpex_daily_quotes_hist, iso, fetchOptions);
      const tpexDaily = parseJsonBytes(tpexDailyBytes, 'TPEX_DAILY_QUOTES');
      if (isTpexDailyQuotesTradingDay(tpexDaily)) {
        parseTpexDailyQuotesHist(tpexDaily);
        tpexTrading = true;
        tpexSource = 'legacy';
        tpexInstiBytes = await fetchEndpoint(BACKFILL_ENDPOINTS.tpex_insti_hist, iso, fetchOptions);
        parseTpexInstiHist(parseJsonBytes(tpexInstiBytes, 'TPEX_INSTI'));
        tpexMarginBytes = await fetchEndpoint(BACKFILL_ENDPOINTS.tpex_margin_hist, iso, fetchOptions);
        parseTpexMarginHist(parseJsonBytes(tpexMarginBytes, 'TPEX_MARGIN'));
      }
    }

    if (tpexTrading && tpexDailyBytes) {
      rawWrites.push(writeRawBytesOnChange(
        rawPath(rootDir, BACKFILL_ENDPOINTS.tpex_daily_quotes_hist.sourceDataset, iso),
        tpexDailyBytes,
      ));
    }
    if (tpexInstiBytes) {
      rawWrites.push(writeRawBytesOnChange(
        rawPath(rootDir, BACKFILL_ENDPOINTS.tpex_insti_hist.sourceDataset, iso),
        tpexInstiBytes,
      ));
    }
    if (tpexMarginBytes) {
      rawWrites.push(writeRawBytesOnChange(
        rawPath(rootDir, BACKFILL_ENDPOINTS.tpex_margin_hist.sourceDataset, iso),
        tpexMarginBytes,
      ));
    }
    summary.rawWritten += (await Promise.all(rawWrites)).filter(Boolean).length;

    if (!twseTrading && !tpexTrading) {
      summary.skipped += 1;
      logger.log(`[skip] ${iso} non-trading day (twse+tpex)`);
      await saveCheckpoint(rootDir, iso, now);
      continue;
    }

    const written = await applyDailyDate(rootDir, iso, { symbolWindow });
    await saveCheckpoint(rootDir, iso, now);
    summary.trading += 1;
    summary.derivedSymbols += written.symbols;
    logger.log(`[ok] ${iso} twse=${twseSource} tpex=${tpexSource} derivedWritten=${written.symbols}`);
  }

  logger.log(`[done] trading=${summary.trading} skipped=${summary.skipped} resumed=${summary.resumed} rawWritten=${summary.rawWritten} derivedSymbolsWritten=${summary.derivedSymbols}`);
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  return runBackfill({
    rootDir: String(args.out ?? process.cwd()),
    fromIso: args.from ?? '2024-01-01',
    toIso: args.to ?? '2024-01-31',
    delayMs: Number(args['delay-ms'] ?? 3000),
    symbolWindow: Number(args.window ?? DEFAULT_SYMBOL_WINDOW),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
