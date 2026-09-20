import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileEnsured } from './io.mjs';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export function parseLongArgs(argv) {
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

export function assertMonth(label, value) {
  const text = String(value ?? '');
  if (!MONTH_RE.test(text)) throw new Error(`${label} must be YYYY-MM, got: ${value}`);
  return text;
}

export function* monthsAscending(fromMonth, toMonth) {
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

export function taifexMonthlyRawPath(rootDir, sourceDataset, monthKey) {
  return join(
    rootDir,
    'data',
    'raw',
    sourceDataset,
    monthKey.slice(0, 4),
    `${monthKey}.csv`,
  );
}

export function calendarMonthRequestBody(monthKey, extraFields = {}) {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5));
  const monthText = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new URLSearchParams({
    down_type: '1',
    queryStartDate: `${year}/${monthText}/01`,
    queryEndDate: `${year}/${monthText}/${String(lastDay).padStart(2, '0')}`,
    ...extraFields,
  }).toString();
}

export function decodeTaifexBig5Csv(bytes, label) {
  try {
    return new TextDecoder('big5', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label}: invalid big5 CSV`);
  }
}

export function validateTaifexMonthlyCsv(bytes, { label, parseRows, requireHeader }) {
  const rows = parseRows(bytes);
  if (rows.length === 0) throw new Error(`${label}: response has 0 data rows`);
  if (!requireHeader) return rows;
  const firstLine = decodeTaifexBig5Csv(bytes, label)
    .split(/\r\n|\n|\r/, 1)[0]
    .replace(/^\uFEFF/, '');
  if (!firstLine.startsWith('日期,')) {
    throw new Error(`${label}: response first line is not a CSV header starting with 日期,`);
  }
  return rows;
}

export async function writeRawBytesOnChange(path, bytes) {
  try {
    const current = await readFile(path);
    if (current.equals(bytes)) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFileEnsured(path, bytes);
  return true;
}

export async function readValidTaifexMonthlyRaw(path, validation) {
  try {
    const bytes = await readFile(path);
    return { bytes, rows: validateTaifexMonthlyCsv(bytes, validation) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function fetchTaifexMonth(endpoint, monthKey, {
  requestBodyForMonth,
  validation,
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
      return { bytes, rows: validateTaifexMonthlyCsv(bytes, validation) };
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

export async function runTaifexMonthlyBackfill({
  rootDir = process.cwd(),
  fromMonth,
  toMonth,
  delayMs = 3000,
  maxRetries = 4,
  retryBaseMs = 1000,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  logger = console,
  endpoint,
  label,
  logPrefix,
  requestBodyForMonth,
  parseRows,
  requireHeader = true,
  applyMonthImpl,
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
  if (!endpoint?.url || !endpoint?.sourceDataset) throw new Error('endpoint must declare url and sourceDataset');
  if (typeof requestBodyForMonth !== 'function') throw new Error('requestBodyForMonth must be a function');
  if (typeof parseRows !== 'function') throw new Error('parseRows must be a function');
  if (typeof applyMonthImpl !== 'function') throw new Error('applyMonthImpl must be a function');

  const validation = { label, parseRows, requireHeader };
  const summary = {
    months: 0,
    requests: 0,
    skipped: 0,
    rawWritten: 0,
    derivedWritten: 0,
    rows: 0,
    failures: [],
  };
  logger.log(`[${logPrefix}] range ${fromMonth}..${toMonth} out=${rootDir} delay=${delayMs}ms`);

  for (const monthKey of monthsAscending(fromMonth, toMonth)) {
    summary.months += 1;
    const path = taifexMonthlyRawPath(rootDir, endpoint.sourceDataset, monthKey);
    const requestsBeforeMonth = summary.requests;
    try {
      let payload;
      try {
        payload = await readValidTaifexMonthlyRaw(path, validation);
      } catch (error) {
        logger.warn(`[refetch] ${monthKey} invalid existing raw: ${error.message}`);
        payload = null;
      }
      if (payload) {
        summary.skipped += 1;
      } else {
        payload = await fetchTaifexMonth(endpoint, monthKey, {
          requestBodyForMonth,
          validation,
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
      const derived = await applyMonthImpl(rootDir, monthKey);
      if (derived.market) summary.derivedWritten += 1;
      logger.log(`[ok] ${monthKey} rows=${payload.rows.length} rawWritten=${summary.rawWritten}`);
    } catch (error) {
      summary.failures.push({ month: monthKey, error: error.message });
      logger.warn(`[fail] ${monthKey}: ${error.message}`);
    } finally {
      if (summary.requests > requestsBeforeMonth && delayMs > 0) await sleepImpl(delayMs);
    }
  }

  logger.log(`[done] months=${summary.months} requests=${summary.requests} skipped=${summary.skipped} rawWritten=${summary.rawWritten} derivedWritten=${summary.derivedWritten} rows=${summary.rows} failed=${summary.failures.length}`);
  if (summary.failures.length > 0) {
    const error = new Error(`${label} backfill completed with ${summary.failures.length} failure(s)`);
    error.summary = summary;
    throw error;
  }
  return summary;
}
