import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as defaultSleep } from 'node:timers/promises';
import { writeRawBytesOnChange } from './taifex-monthly-backfill.mjs';

export const EX_RIGHT_START_YEAR = 2021;
export const EX_RIGHT_DATASETS = Object.freeze({
  twse_ex_right: Object.freeze({
    key: 'twse_ex_right',
    market: 'twse',
    sourceDataset: 'twse/ex_right',
    url: 'https://www.twse.com.tw/rwd/zh/exRight/TWT49U',
  }),
  tpex_ex_right: Object.freeze({
    key: 'tpex_ex_right',
    market: 'tpex',
    sourceDataset: 'tpex/ex_right',
    url: 'https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ',
  }),
});
export const EX_RIGHT_DATASET_KEYS = Object.freeze(Object.keys(EX_RIGHT_DATASETS));

const USER_AGENT = 'wfnt-snapshot-data/0.1 (+https://github.com/0301kenny/wfnt-snapshot-data)';

export function exRightRawPath(rootDir, market, year) {
  const text = String(year);
  return join(rootDir, 'data', 'raw', market, 'ex_right', text, `${text}.json`);
}

export async function listExRightYears(rootDir, market) {
  const dir = join(rootDir, 'data', 'raw', market, 'ex_right');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const years = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{4}$/.test(entry.name)) continue;
      try {
        await access(join(dir, entry.name, `${entry.name}.json`));
        years.push(entry.name);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return years.sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function compactDate(date) {
  return date.replaceAll('-', '');
}

function slashDate(date) {
  return date.replaceAll('-', '/');
}

async function isCompleteHistoricalRaw(path, market, year) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    const recordedEndDate = market === 'twse'
      ? parsed?.endDate
      : parsed?.date?.split('~').at(-1);
    return recordedEndDate === `${year}1231`;
  } catch {
    return false;
  }
}

function requestForYear(endpoint, year, today) {
  const endDate = year === Number(today.slice(0, 4)) ? today : `${year}-12-31`;
  if (endpoint.market === 'twse') {
    const query = new URLSearchParams({
      startDate: `${year}0101`,
      endDate: compactDate(endDate),
      response: 'json',
    });
    return {
      url: `${endpoint.url}?${query}`,
      options: {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      },
      endDate,
    };
  }
  return {
    url: endpoint.url,
    options: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: new URLSearchParams({
        startDate: `${year}/01/01`,
        endDate: slashDate(endDate),
        id: '',
        response: 'json',
      }).toString(),
    },
    endDate,
  };
}

function validateResponse(endpoint, bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, retryable: true, error: 'truncated: JSON 不可解析' };
  }
  if (endpoint.market === 'twse') {
    if (parsed?.stat !== 'OK' || !Array.isArray(parsed?.fields) || !Array.isArray(parsed?.data)) {
      return { ok: false, retryable: false, error: 'schema: TWSE ex_right 回應格式無效' };
    }
    return { ok: true };
  }
  const table = parsed?.tables?.[0];
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.data)
    || !Number.isInteger(Number(table.totalCount)) || Number(table.totalCount) < 0) {
    return { ok: false, retryable: false, error: 'schema: TPEX ex_right 回應格式無效' };
  }
  const totalCount = Number(table.totalCount);
  if (table.data.length < totalCount) {
    return {
      ok: false,
      retryable: true,
      error: `truncated: TPEX ex_right rows ${table.data.length}/${totalCount}`,
    };
  }
  if (table.data.length !== totalCount) {
    return {
      ok: false,
      retryable: false,
      error: `schema: TPEX ex_right rows ${table.data.length}/${totalCount}`,
    };
  }
  return { ok: true };
}

async function responseBytes(response) {
  if (response.arrayBuffer) return Buffer.from(await response.arrayBuffer());
  return Buffer.from(await response.text(), 'utf8');
}

async function fetchYear(endpoint, year, today, {
  fetcher,
  sleepImpl,
  delayMs,
  maxAttempts,
  requestState,
}) {
  const request = requestForYear(endpoint, year, today);
  let lastError = 'truncated: invalid response';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (requestState.count > 0) await sleepImpl(delayMs);
    requestState.count += 1;
    let response;
    try {
      response = await fetcher(request.url, request.options);
    } catch (error) {
      return { ok: false, error: error?.message ? `fetch: ${error.message}` : 'fetch: failed' };
    }
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    let bytes;
    try {
      bytes = await responseBytes(response);
    } catch (error) {
      return { ok: false, error: error?.message ? `fetch: ${error.message}` : 'fetch: failed' };
    }
    const validation = validateResponse(endpoint, bytes);
    if (validation.ok) return { ok: true, bytes, endDate: request.endDate };
    lastError = validation.error;
    if (!validation.retryable) return { ok: false, error: lastError };
  }
  return { ok: false, error: lastError };
}

export async function fetchExRightDataset(rootDir, key, today, {
  fetcher = globalThis.fetch,
  sleepImpl = defaultSleep,
  delayMs = 3000,
  maxAttempts = 3,
} = {}) {
  const endpoint = EX_RIGHT_DATASETS[key];
  if (!endpoint) throw new Error(`unknown ex_right dataset: ${key}`);
  const currentYear = Number(today.slice(0, 4));
  const requestState = { count: 0 };
  let rawWritten = 0;
  for (let year = EX_RIGHT_START_YEAR; year <= currentYear; year += 1) {
    const path = exRightRawPath(rootDir, endpoint.market, year);
    if (year !== currentYear && await isCompleteHistoricalRaw(path, endpoint.market, year)) continue;
    const fetched = await fetchYear(endpoint, year, today, {
      fetcher,
      sleepImpl,
      delayMs,
      maxAttempts,
      requestState,
    });
    if (!fetched.ok) {
      return {
        key,
        market: endpoint.market,
        ok: false,
        error: `${key} ${year}: ${fetched.error}`,
        rawWritten,
      };
    }
    if (await writeRawBytesOnChange(path, fetched.bytes)) rawWritten += 1;
  }
  const years = await listExRightYears(rootDir, endpoint.market);
  return {
    key,
    market: endpoint.market,
    ok: true,
    status: rawWritten > 0 ? 'write' : 'same',
    date: today,
    first: years.length > 0 ? `${years[0]}-01-01` : null,
    latest: today,
    years: years.length,
    rawWritten,
  };
}
