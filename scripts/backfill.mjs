// TWSE and TPEX legacy historical backfill. Raw response bytes are authoritative;
// derived output is produced only through scripts/lib/derived.mjs::applyDailyDate.

import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKFILL_ENDPOINTS } from './endpoints.mjs';
import {
  DEFAULT_SYMBOL_WINDOW,
  DERIVED_INPUT_DATASETS,
  applyDailyDate,
  isTpexDailyQuotesTradingDay,
  isTwseMiIndexTradingDay,
  parseTpexPeHist,
  parseTpexDailyQuotesHist,
  parseTpexInstiHist,
  parseTpexMarginHist,
  parseTwseMiIndexHist,
  parseTwseMiMargnHist,
  parseTwseBwibbuHist,
  parseTwseT86Hist,
} from './lib/derived.mjs';
import { taipeiIsoDate, yyyyOf } from './lib/date.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
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
  const parsed = new Date(`${text}T00:00:00Z`);
  if (
    !ISO_RE.test(text) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
  ) {
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

function parseExplicitDates(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  const dates = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value).trim();
    if (!text) continue;
    const iso = assertIso('--dates', text);
    if (!seen.has(iso)) {
      seen.add(iso);
      dates.push(iso);
    }
  }
  return dates;
}

function parseJsonBytes(bytes, label) {
  try {
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
}

export function parseTwseSblHist(payload, expectedYmd) {
  if (payload?.stat !== 'OK') throw new Error('TWT93U: stat is not OK');
  if (payload.date !== expectedYmd) {
    throw new Error(`TWT93U: response date ${payload?.date} does not match ${expectedYmd}`);
  }
  const fields = payload.fields;
  const expectedFields = [
    '代號', '名稱', '前日餘額', '賣出', '買進', '現券', '今日餘額', '次一營業日限額',
    '前日餘額', '當日賣出', '當日還券', '當日調整', '當日餘額', '次一營業日可限額', '備註',
  ];
  if (!Array.isArray(fields) || fields.length !== expectedFields.length) {
    throw new Error('TWT93U: fields length must be 15');
  }
  for (let index = 0; index < expectedFields.length; index += 1) {
    if (fields[index] !== expectedFields[index]) {
      throw new Error(`TWT93U: fields[${index}] must be ${expectedFields[index]}`);
    }
  }
  if (!Array.isArray(payload.data)) throw new Error('TWT93U: data is not an array');
  return payload.data.map((row, index) => {
    if (!Array.isArray(row) || row.length !== expectedFields.length) {
      throw new Error(`TWT93U: data[${index}] width must be 15`);
    }
    return {
      SecuritiesCompanyCode: String(row[0] ?? '').trim(),
      CompanyName: String(row[1] ?? '').trim(),
      SecuritiesBorrowingBalanceOfTheMarketDay: row[12],
    };
  });
}

export function parseTpexSblHist(payload, expectedYmd) {
  if (payload?.stat !== 'ok') throw new Error('TPEX_SBL: stat is not ok');
  if (payload.date !== expectedYmd) {
    throw new Error(`TPEX_SBL: response date ${payload?.date} does not match ${expectedYmd}`);
  }
  const table = payload?.tables?.[0];
  if (!table || !Array.isArray(table.data)) {
    throw new Error('TPEX_SBL: tables[0] is invalid');
  }
  const fields = table.fields;
  const expectedFields = [
    '股票代號', '股票名稱', '前日餘額', '賣出', '買進', '現券', '當日餘額', '限額',
    '前日餘額', '當日賣出', '當日還券', '當日調整數額', '當日餘額',
    '次一營業日可借券賣出限額', '備註',
  ];
  if (!Array.isArray(fields) || fields.length !== expectedFields.length) {
    throw new Error('TPEX_SBL: fields length must be 15');
  }
  for (let index = 0; index < expectedFields.length; index += 1) {
    if (fields[index] !== expectedFields[index]) {
      throw new Error(`TPEX_SBL: fields[${index}] must be ${expectedFields[index]}`);
    }
  }
  return table.data.map((row, index) => {
    if (!Array.isArray(row) || row.length !== expectedFields.length) {
      throw new Error(`TPEX_SBL: data[${index}] width must be 15`);
    }
    return {
      SecuritiesCompanyCode: String(row[0] ?? '').trim(),
      CompanyName: String(row[1] ?? '').trim(),
      SecuritiesBorrowingBalanceOfTheMarketDay: row[12],
    };
  });
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

async function saveCheckpoint(rootDir, iso, fromIso, toIso, now) {
  const checkpoint = {
    lastDate: iso,
    fromDate: fromIso,
    toDate: toIso,
    updatedAt: now().toISOString(),
  };
  await writeFileEnsured(checkpointPath(rootDir), `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function fetchEndpoint(endpoint, iso, options) {
  const result = await fetchBytesWithRetry(endpoint.url(isoToYmd(iso)), options);
  await options.sleepImpl(options.delayMs);
  if (!result.ok) throw new Error(`${iso} ${endpoint.sourceDataset}: ${result.error}`);
  return result.bytes;
}

async function fetchDataEndpointIfMissing(rootDir, endpoint, iso, options, validate) {
  try {
    const bytes = await readFile(rawPath(rootDir, endpoint.sourceDataset, iso));
    try {
      validate(bytes);
      return null;
    } catch {
      // Invalid cached raw is repaired from the official endpoint below.
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return fetchEndpoint(endpoint, iso, options);
}

export async function runBackfill({
  rootDir = process.cwd(),
  fromIso,
  toIso,
  dates,
  delayMs = 3000,
  symbolWindow = DEFAULT_SYMBOL_WINDOW,
  maxRetries = 3,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  applyDailyDateImpl = applyDailyDate,
  logger = console,
  now = () => new Date(),
} = {}) {
  rootDir = resolve(rootDir);
  const explicitDates = dates !== undefined;
  if (explicitDates && (fromIso !== undefined || toIso !== undefined)) {
    throw new Error('--dates cannot be combined with --from or --to');
  }
  let targetDates;
  if (explicitDates) {
    targetDates = parseExplicitDates(dates);
    const today = taipeiIsoDate(now());
    const invalid = targetDates.find((iso) => iso >= today);
    if (invalid) throw new Error(`--dates must be before today (${today}), got: ${invalid}`);
  } else {
    fromIso = assertIso('--from', fromIso);
    toIso = assertIso('--to', toIso);
    if (fromIso > toIso) throw new Error(`--from must be <= --to, got: ${fromIso} > ${toIso}`);
    targetDates = isoDaysAscending(fromIso, toIso);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`--delay-ms must be a non-negative number, got: ${delayMs}`);
  if (!Number.isInteger(symbolWindow) || symbolWindow <= 0) throw new Error(`--window must be a positive integer, got: ${symbolWindow}`);
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error(`maxRetries must be a non-negative integer, got: ${maxRetries}`);
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  const checkpoint = explicitDates ? { lastDate: null } : await loadCheckpoint(rootDir);
  const resumeAfter = checkpoint.fromDate === fromIso && checkpoint.toDate === toIso
    ? checkpoint.lastDate
    : null;
  const summary = {
    trading: 0,
    skipped: 0,
    resumed: 0,
    openApiDays: 0,
    tpexOpenApiDays: 0,
    rawWritten: 0,
    derivedSymbols: 0,
  };
  if (explicitDates) summary.failures = [];
  if (explicitDates) {
    logger.log(`[backfill] dates ${targetDates.join(',')} out=${rootDir} delay=${delayMs}ms window=${symbolWindow}`);
  } else {
    logger.log(`[backfill] range ${fromIso}..${toIso} out=${rootDir} delay=${delayMs}ms window=${symbolWindow}${resumeAfter ? ` resumeAfter=${resumeAfter}` : ''}`);
  }

  const fetchOptions = { delayMs, maxRetries, fetchImpl, sleepImpl, logger };
  for (const iso of targetDates) {
    if (!explicitDates && resumeAfter && iso <= resumeAfter) {
      summary.resumed += 1;
      continue;
    }

    try {

    const twseOpenApiCloseExists = await fileExists(rawPath(rootDir, 'twse/stock_day_all', iso));
    let twseTrading = false;
    let twseSource = 'non-trading';
    let miIndexBytes = null;
    let t86Bytes = null;
    let miMargnBytes = null;
    let bwibbuBytes = null;
    let twseSblBytes = null;
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
      t86Bytes = await fetchDataEndpointIfMissing(rootDir, BACKFILL_ENDPOINTS.twse_t86_hist, iso, fetchOptions,
        (bytes) => parseTwseT86Hist(parseJsonBytes(bytes, 'T86')));
      if (t86Bytes) parseTwseT86Hist(parseJsonBytes(t86Bytes, 'T86'));
      bwibbuBytes = await fetchDataEndpointIfMissing(rootDir, BACKFILL_ENDPOINTS.twse_bwibbu_hist, iso, fetchOptions,
        (bytes) => parseTwseBwibbuHist(parseJsonBytes(bytes, 'BWIBBU_d')));
      if (bwibbuBytes) parseTwseBwibbuHist(parseJsonBytes(bwibbuBytes, 'BWIBBU_d'));
      twseSblBytes = await fetchDataEndpointIfMissing(rootDir, BACKFILL_ENDPOINTS.twse_sbl_hist, iso, fetchOptions,
        (bytes) => parseTwseSblHist(parseJsonBytes(bytes, 'TWT93U'), isoToYmd(iso)));
      if (twseSblBytes) parseTwseSblHist(parseJsonBytes(twseSblBytes, 'TWT93U'), isoToYmd(iso));
      if (!twseOpenApiCloseExists) {
        miMargnBytes = await fetchDataEndpointIfMissing(rootDir, BACKFILL_ENDPOINTS.twse_mi_margn_hist, iso, fetchOptions,
          (bytes) => parseTwseMiMargnHist(parseJsonBytes(bytes, 'MI_MARGN')));
        if (miMargnBytes) parseTwseMiMargnHist(parseJsonBytes(miMargnBytes, 'MI_MARGN'));
      }
    }

    const rawWrites = [];
    const pushRawWrite = (sourceDataset, bytes) => {
      rawWrites.push(writeRawBytesOnChange(
        rawPath(rootDir, sourceDataset, iso),
        bytes,
      ).then((didWrite) => (didWrite ? sourceDataset : null)));
    };
    if (twseTrading && miIndexBytes) {
      pushRawWrite(BACKFILL_ENDPOINTS.twse_mi_index_hist.sourceDataset, miIndexBytes);
    }
    if (t86Bytes) {
      pushRawWrite(BACKFILL_ENDPOINTS.twse_t86_hist.sourceDataset, t86Bytes);
    }
    if (twseTrading && miMargnBytes) {
      pushRawWrite(BACKFILL_ENDPOINTS.twse_mi_margn_hist.sourceDataset, miMargnBytes);
    }
    if (bwibbuBytes) {
      pushRawWrite(BACKFILL_ENDPOINTS.twse_bwibbu_hist.sourceDataset, bwibbuBytes);
    }
    if (twseSblBytes) {
      pushRawWrite(BACKFILL_ENDPOINTS.twse_sbl_hist.sourceDataset, twseSblBytes);
    }

    const tpexOpenApiCloseExists = await fileExists(rawPath(rootDir, 'tpex/mainboard_close', iso));
    let tpexTrading = false;
    let tpexSource = 'non-trading';
    let tpexDailyBytes = null;
    let tpexInstiBytes = null;
    let tpexMarginBytes = null;
    let tpexPeBytes = null;
    let tpexSblBytes = null;
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
        tpexInstiBytes = await fetchDataEndpointIfMissing(rootDir, BACKFILL_ENDPOINTS.tpex_insti_hist, iso, fetchOptions,
          (bytes) => parseTpexInstiHist(parseJsonBytes(bytes, 'TPEX_INSTI')));
        if (tpexInstiBytes) parseTpexInstiHist(parseJsonBytes(tpexInstiBytes, 'TPEX_INSTI'));
        tpexMarginBytes = await fetchDataEndpointIfMissing(rootDir, BACKFILL_ENDPOINTS.tpex_margin_hist, iso, fetchOptions,
          (bytes) => parseTpexMarginHist(parseJsonBytes(bytes, 'TPEX_MARGIN')));
        if (tpexMarginBytes) parseTpexMarginHist(parseJsonBytes(tpexMarginBytes, 'TPEX_MARGIN'));
      }
    }

    if (tpexTrading) {
      tpexPeBytes = await fetchDataEndpointIfMissing(rootDir, BACKFILL_ENDPOINTS.tpex_pe_hist, iso, fetchOptions,
        (bytes) => parseTpexPeHist(parseJsonBytes(bytes, 'TPEX_PE')));
      if (tpexPeBytes) parseTpexPeHist(parseJsonBytes(tpexPeBytes, 'TPEX_PE'));
      tpexSblBytes = await fetchDataEndpointIfMissing(rootDir, BACKFILL_ENDPOINTS.tpex_sbl_hist, iso, fetchOptions,
        (bytes) => parseTpexSblHist(parseJsonBytes(bytes, 'TPEX_SBL'), isoToYmd(iso)));
      if (tpexSblBytes) parseTpexSblHist(parseJsonBytes(tpexSblBytes, 'TPEX_SBL'), isoToYmd(iso));
    }

    if (tpexTrading && tpexDailyBytes) {
      pushRawWrite(BACKFILL_ENDPOINTS.tpex_daily_quotes_hist.sourceDataset, tpexDailyBytes);
    }
    if (tpexInstiBytes) {
      pushRawWrite(BACKFILL_ENDPOINTS.tpex_insti_hist.sourceDataset, tpexInstiBytes);
    }
    if (tpexMarginBytes) {
      pushRawWrite(BACKFILL_ENDPOINTS.tpex_margin_hist.sourceDataset, tpexMarginBytes);
    }
    if (tpexPeBytes) {
      pushRawWrite(BACKFILL_ENDPOINTS.tpex_pe_hist.sourceDataset, tpexPeBytes);
    }
    if (tpexSblBytes) {
      pushRawWrite(BACKFILL_ENDPOINTS.tpex_sbl_hist.sourceDataset, tpexSblBytes);
    }
    const writtenDatasets = (await Promise.all(rawWrites)).filter(Boolean);
    summary.rawWritten += writtenDatasets.length;

    if (!twseTrading && !tpexTrading) {
      summary.skipped += 1;
      logger.log(`[skip] ${iso} non-trading day (twse+tpex)`);
      if (!explicitDates) await saveCheckpoint(rootDir, iso, fromIso, toIso, now);
      continue;
    }

    const derivedInputTouched = writtenDatasets.some((dataset) => DERIVED_INPUT_DATASETS.has(dataset));
    const canSkipDerived = writtenDatasets.length > 0
      && !derivedInputTouched
      && symbolWindow === DEFAULT_SYMBOL_WINDOW
      && await fileExists(join(rootDir, 'data', 'derived', 'market.json'));
    const written = canSkipDerived
      ? { symbols: 0, fundamentals: 0, market: false }
      : await applyDailyDateImpl(rootDir, iso, { symbolWindow });
    if (!explicitDates) await saveCheckpoint(rootDir, iso, fromIso, toIso, now);
    summary.trading += 1;
    summary.derivedSymbols += written.symbols;
    logger.log(`[ok] ${iso} twse=${twseSource} tpex=${tpexSource} derivedWritten=${written.symbols}`);
    } catch (error) {
      if (!explicitDates) throw error;
      const message = String(error?.message ?? error);
      summary.failures.push({ date: iso, error: message });
      logger.warn(`[fail] ${iso}: ${message}`);
    }
  }

  const done = `[done] trading=${summary.trading} skipped=${summary.skipped} resumed=${summary.resumed} rawWritten=${summary.rawWritten} derivedSymbolsWritten=${summary.derivedSymbols}`;
  logger.log(explicitDates ? `${done} failed=${summary.failures.length}` : done);
  if (summary.failures?.length) {
    const error = new Error(`--dates completed with ${summary.failures.length} failure(s): ${summary.failures.map((failure) => `${failure.date} ${failure.error}`).join('; ')}`);
    error.summary = summary;
    throw error;
  }
  return summary;
}

export function backfillOptionsFromArgs(args) {
  return {
    rootDir: String(args.out ?? process.cwd()),
    fromIso: args.from ?? (args.dates === undefined ? '2024-01-01' : undefined),
    toIso: args.to ?? (args.dates === undefined ? '2024-01-31' : undefined),
    dates: args.dates,
    delayMs: parseNumericFlag(args['delay-ms'], 3000),
    symbolWindow: parseNumericFlag(args.window, DEFAULT_SYMBOL_WINDOW),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  return runBackfill(backfillOptionsFromArgs(args));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
