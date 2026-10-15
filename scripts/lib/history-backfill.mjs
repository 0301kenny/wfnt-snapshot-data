import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  fetchBytesWithRetry,
  parseTpexSblHist,
  parseTwseSblHist,
  rawPath,
  writeRawBytesOnChange,
} from '../backfill.mjs';
import { BACKFILL_ENDPOINTS } from '../endpoints.mjs';
import { taipeiIsoDate, yyyyOf } from './date.mjs';
import {
  isTpexDailyQuotesTradingDay,
  isTwseMiIndexTradingDay,
  parseTpexDailyQuotesHist,
  parseTpexInstiHist,
  parseTpexMarginHist,
  parseTpexPeHist,
  parseTwseBwibbuHist,
  parseTwseMiIndexHist,
  parseTwseMiMargnHist,
  parseTwseT86Hist,
} from './derived.mjs';
import { readJsonIfExists, writeFileEnsured } from './io.mjs';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAUSE_RE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;
const MAX_HISTORY = 50;

const DAILY_ENDPOINTS = [
  {
    ...BACKFILL_ENDPOINTS.twse_mi_index_hist,
    market: 'twse',
    anchor: true,
    isTradingDay: isTwseMiIndexTradingDay,
    parse: parseTwseMiIndexHist,
  },
  { ...BACKFILL_ENDPOINTS.twse_t86_hist, market: 'twse', parse: parseTwseT86Hist },
  { ...BACKFILL_ENDPOINTS.twse_mi_margn_hist, market: 'twse', parse: parseTwseMiMargnHist },
  { ...BACKFILL_ENDPOINTS.twse_bwibbu_hist, market: 'twse', parse: parseTwseBwibbuHist },
  {
    ...BACKFILL_ENDPOINTS.twse_sbl_hist,
    market: 'twse',
    parse: (payload, iso) => parseTwseSblHist(payload, iso.replaceAll('-', '')),
  },
  {
    ...BACKFILL_ENDPOINTS.tpex_daily_quotes_hist,
    market: 'tpex',
    anchor: true,
    isTradingDay: isTpexDailyQuotesTradingDay,
    parse: parseTpexDailyQuotesHist,
  },
  { ...BACKFILL_ENDPOINTS.tpex_insti_hist, market: 'tpex', parse: parseTpexInstiHist },
  { ...BACKFILL_ENDPOINTS.tpex_margin_hist, market: 'tpex', parse: parseTpexMarginHist },
  { ...BACKFILL_ENDPOINTS.tpex_pe_hist, market: 'tpex', parse: parseTpexPeHist },
  {
    ...BACKFILL_ENDPOINTS.tpex_sbl_hist,
    market: 'tpex',
    parse: (payload, iso) => parseTpexSblHist(payload, iso.replaceAll('-', '')),
  },
];

const MARKET_ENDPOINTS = {
  twse: DAILY_ENDPOINTS.filter((endpoint) => endpoint.market === 'twse'),
  tpex: DAILY_ENDPOINTS.filter((endpoint) => endpoint.market === 'tpex'),
};

function assertIso(label, value) {
  const text = String(value ?? '');
  const parsed = new Date(`${text}T00:00:00Z`);
  if (
    !ISO_RE.test(text)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== text
  ) {
    throw new Error(`${label} must be YYYY-MM-DD, got: ${value}`);
  }
  return text;
}

function previousIsoDate(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function inclusiveDays(fromIso, toIso) {
  const start = new Date(`${fromIso}T00:00:00Z`).getTime();
  const end = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}

function parsePauseWindow(value) {
  const text = String(value ?? '');
  const match = PAUSE_RE.exec(text);
  if (!match) throw new Error(`--pause-window must be HH:MM-HH:MM, got: ${value}`);
  const values = match.slice(1).map(Number);
  if (values[0] > 23 || values[2] > 23 || values[1] > 59 || values[3] > 59) {
    throw new Error(`--pause-window must be HH:MM-HH:MM, got: ${value}`);
  }
  return { start: values[0] * 60 + values[1], end: values[2] * 60 + values[3], text };
}

function taipeiMinute(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(value.hour) * 60 + Number(value.minute);
}

function isInPauseWindow(date, window) {
  const minute = taipeiMinute(date);
  if (window.start === window.end) return false;
  if (window.start < window.end) return minute >= window.start && minute < window.end;
  return minute >= window.start || minute < window.end;
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
}

function payloadHasRows(payload) {
  if (Array.isArray(payload?.data) && payload.data.length > 0) return true;
  return Array.isArray(payload?.tables)
    && payload.tables.some((table) => Array.isArray(table?.data) && table.data.length > 0);
}

function quarantinePath(rootDir, sourceDataset, iso) {
  return join(
    rootDir,
    'data',
    'history-backfill',
    'quarantine',
    sourceDataset,
    yyyyOf(iso),
    `${iso}.json`,
  );
}

function progressPath(rootDir) {
  return join(rootDir, 'data', 'history-backfill', 'progress.json');
}

function lockPath(rootDir) {
  return join(rootDir, 'data', 'history-backfill', '.lock');
}

function emptyEndpointCounts() {
  return Object.fromEntries(DAILY_ENDPOINTS.map((endpoint) => [endpoint.sourceDataset, {
    written: 0,
    exists: 0,
    unavailable: 0,
    quarantined: 0,
    failed: 0,
  }]));
}

function newProgress(fromIso, toIso, now) {
  return {
    schemaVersion: 1,
    status: 'IN_PROGRESS',
    range: { from: fromIso, to: toIso, order: 'desc' },
    nextDate: toIso,
    updatedAt: now.toISOString(),
    days: { total: inclusiveDays(fromIso, toIso), done: 0, trading: 0, nonTrading: 0 },
    endpoints: emptyEndpointCounts(),
    consecutiveAnchorFailures: 0,
    recentDays: [],
    failures: [],
    launches: [],
  };
}

function pushLimited(array, value) {
  array.push(value);
  if (array.length > MAX_HISTORY) array.splice(0, array.length - MAX_HISTORY);
}

async function saveProgress(rootDir, progress, now) {
  progress.updatedAt = now().toISOString();
  await writeFileEnsured(progressPath(rootDir), `${JSON.stringify(progress, null, 2)}\n`);
}

function pidIsAlive(pid, processKill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    processKill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLockOwner(path) {
  try {
    return JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function acquireLock(rootDir, { now, logger, processKill }) {
  const path = lockPath(rootDir);
  await mkdir(join(rootDir, 'data', 'history-backfill'), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    try {
      await mkdir(path);
      try {
        await writeFile(join(path, 'owner.json'), `${JSON.stringify({
          pid: process.pid,
          startedAt: now().toISOString(),
          token,
        }, null, 2)}\n`);
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      return { acquired: true, path, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = await readLockOwner(path);
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
        // A winner may still be publishing owner.json immediately after mkdir.
        await sleep(10);
        owner = await readLockOwner(path);
      }
      if (pidIsAlive(owner.pid, processKill)) {
        logger.log(`[history-backfill] lock held by live pid ${owner.pid}`);
        return { acquired: false, path };
      }
      logger.log(`[history-backfill] taking over stale lock from pid ${owner.pid ?? 'unknown'}`);
      const stalePath = `${path}.stale-${process.pid}-${token}`;
      try {
        await rename(path, stalePath);
      } catch (renameError) {
        if (renameError.code === 'ENOENT') continue;
        throw renameError;
      }
      await rm(stalePath, { recursive: true, force: true });
    }
  }
  throw new Error('could not acquire history backfill lock');
}

async function readBytesIfExists(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateDataPayload(endpoint, bytes, iso) {
  const payload = parseJsonBytes(bytes, endpoint.sourceDataset);
  if (!payloadHasRows(payload)) return { kind: 'unavailable', payload };
  try {
    endpoint.parse(payload, iso);
    return { kind: 'valid', payload };
  } catch (error) {
    return { kind: 'quarantined', payload, error };
  }
}

async function existingDataResult(rootDir, endpoint, iso) {
  const official = await readBytesIfExists(rawPath(rootDir, endpoint.sourceDataset, iso));
  if (official) {
    try {
      const validation = validateDataPayload(endpoint, official, iso);
      if (validation.kind === 'valid') return { kind: 'exists' };
    } catch {
      // Invalid cached raw is repaired from the official endpoint.
    }
  }
  const quarantined = await readBytesIfExists(quarantinePath(rootDir, endpoint.sourceDataset, iso));
  if (quarantined) {
    try {
      const validation = validateDataPayload(endpoint, quarantined, iso);
      if (validation.kind === 'quarantined') return { kind: 'quarantined' };
    } catch {
      // Invalid quarantine is replaced from the official endpoint.
    }
  }
  return null;
}

async function fetchEndpoint(endpoint, iso, options) {
  const result = await fetchBytesWithRetry(endpoint.url(iso.replaceAll('-', '')), options);
  await options.sleepImpl(options.delayMs);
  return result;
}

async function processAnchor(rootDir, endpoint, iso, fetchOptions) {
  const path = rawPath(rootDir, endpoint.sourceDataset, iso);
  const existing = await readBytesIfExists(path);
  if (existing) {
    try {
      const payload = parseJsonBytes(existing, endpoint.sourceDataset);
      const trading = endpoint.isTradingDay(payload);
      if (trading) endpoint.parse(payload, iso);
      return { kind: 'exists', trading };
    } catch {
      // Invalid cached raw is repaired from the official endpoint.
    }
  }

  const fetched = await fetchEndpoint(endpoint, iso, fetchOptions);
  if (!fetched.ok) return { kind: 'failed', error: fetched.error };
  let payload;
  try {
    payload = parseJsonBytes(fetched.bytes, endpoint.sourceDataset);
  } catch (error) {
    return { kind: 'anchor-failure', error: error.message };
  }
  const trading = endpoint.isTradingDay(payload);
  if (!trading) return { kind: 'unavailable', trading: false };
  try {
    endpoint.parse(payload, iso);
  } catch (error) {
    return { kind: 'anchor-failure', error: String(error?.message ?? error) };
  }
  await writeRawBytesOnChange(path, fetched.bytes);
  return { kind: 'written', trading: true };
}

async function processDataEndpoint(rootDir, endpoint, iso, fetchOptions) {
  const existing = await existingDataResult(rootDir, endpoint, iso);
  if (existing) return existing;

  const fetched = await fetchEndpoint(endpoint, iso, fetchOptions);
  if (!fetched.ok) return { kind: 'failed', error: fetched.error };
  let validation;
  try {
    validation = validateDataPayload(endpoint, fetched.bytes, iso);
  } catch (error) {
    return { kind: 'failed', error: String(error?.message ?? error) };
  }
  if (validation.kind === 'unavailable') return validation;
  if (validation.kind === 'quarantined') {
    await writeRawBytesOnChange(
      quarantinePath(rootDir, endpoint.sourceDataset, iso),
      fetched.bytes,
    );
    return validation;
  }
  await writeRawBytesOnChange(rawPath(rootDir, endpoint.sourceDataset, iso), fetched.bytes);
  return { kind: 'written' };
}

function addFailure(progress, date, sourceDataset, error) {
  pushLimited(progress.failures, { date, sourceDataset, error: String(error) });
}

function recordEndpoint(progress, endpoint, result) {
  const counts = progress.endpoints[endpoint.sourceDataset];
  counts[result.kind] += 1;
}

async function finishLaunch(rootDir, progress, launch, status, now, daysAtStart) {
  progress.status = status;
  launch.endedAt = now().toISOString();
  launch.daysDone = progress.days.done - daysAtStart;
  launch.status = status;
  pushLimited(progress.launches, launch);
  await saveProgress(rootDir, progress, now);
}

function installSignalHandlers(release) {
  const handlers = new Map();
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = async () => {
      await release();
      process.exit(code);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

export async function runHistoryBackfill({
  rootDir = process.cwd(),
  fromIso,
  toIso,
  delayMs = 3000,
  maxMinutes = 28,
  pauseWindow = '21:00-22:00',
  resumeBlocked = false,
  maxRetries = 3,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  logger = console,
  now = () => new Date(),
  processKill = process.kill.bind(process),
} = {}) {
  rootDir = resolve(rootDir);
  fromIso = assertIso('--from', fromIso);
  toIso = assertIso('--to', toIso);
  if (fromIso > toIso) throw new Error(`--from must be <= --to, got: ${fromIso} > ${toIso}`);
  const today = taipeiIsoDate(now());
  if (toIso >= today) throw new Error(`--to must be before today (${today}), got: ${toIso}`);
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`--delay-ms must be a non-negative number, got: ${delayMs}`);
  }
  if (!Number.isFinite(maxMinutes) || maxMinutes < 0) {
    throw new Error(`--max-minutes must be a non-negative number, got: ${maxMinutes}`);
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`maxRetries must be a non-negative integer, got: ${maxRetries}`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
  const parsedPauseWindow = parsePauseWindow(pauseWindow);

  const lock = await acquireLock(rootDir, { now, logger, processKill });
  if (!lock.acquired) return { status: 'LOCKED', exitCode: 0 };
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const owner = await readLockOwner(lock.path);
    if (owner.token === lock.token) {
      await rm(lock.path, { recursive: true, force: true });
    }
  };
  const removeSignalHandlers = installSignalHandlers(release);

  try {
    const saved = await readJsonIfExists(progressPath(rootDir), null);
    const sameRange = saved?.schemaVersion === 1
      && saved?.range?.from === fromIso
      && saved?.range?.to === toIso
      && saved?.range?.order === 'desc';
    const progress = sameRange ? saved : newProgress(fromIso, toIso, now());
    if (progress.status === 'DONE') return { status: 'DONE', exitCode: 0, progress };
    if (progress.status === 'BLOCKED' && !resumeBlocked) {
      return { status: 'BLOCKED', exitCode: 1, progress };
    }
    if (resumeBlocked) {
      progress.status = 'IN_PROGRESS';
      progress.consecutiveAnchorFailures = 0;
    }

    const startedAt = now();
    const launch = { startedAt: startedAt.toISOString(), endedAt: '', daysDone: 0, status: '' };
    const daysAtStart = progress.days.done;
    const fetchOptions = { delayMs, maxRetries, fetchImpl, sleepImpl, logger };
    let iso = progress.nextDate ?? toIso;

    while (iso >= fromIso) {
      if (isInPauseWindow(now(), parsedPauseWindow)) {
        await finishLaunch(rootDir, progress, launch, 'PAUSED_DAILY_WINDOW', now, daysAtStart);
        return { status: progress.status, exitCode: 0, progress };
      }

      const dayStarted = now();
      const marketStates = { twse: 'non-trading', tpex: 'non-trading' };
      let anchorFailure = false;
      for (const market of ['twse', 'tpex']) {
        const [anchor, ...dataEndpoints] = MARKET_ENDPOINTS[market];
        const anchorResult = await processAnchor(rootDir, anchor, iso, fetchOptions);
        if (anchorResult.kind === 'failed') {
          recordEndpoint(progress, anchor, anchorResult);
          addFailure(progress, iso, anchor.sourceDataset, anchorResult.error);
          await finishLaunch(rootDir, progress, launch, 'PAUSED_NETWORK', now, daysAtStart);
          return { status: progress.status, exitCode: 0, progress };
        }
        if (anchorResult.kind === 'anchor-failure') {
          progress.endpoints[anchor.sourceDataset].failed += 1;
          addFailure(progress, iso, anchor.sourceDataset, anchorResult.error);
          anchorFailure = true;
          continue;
        }
        recordEndpoint(progress, anchor, anchorResult);
        if (!anchorResult.trading) continue;
        marketStates[market] = 'trading';

        for (const endpoint of dataEndpoints) {
          const result = await processDataEndpoint(rootDir, endpoint, iso, fetchOptions);
          recordEndpoint(progress, endpoint, result);
          if (result.kind === 'failed') {
            addFailure(progress, iso, endpoint.sourceDataset, result.error);
            await finishLaunch(rootDir, progress, launch, 'PAUSED_NETWORK', now, daysAtStart);
            return { status: progress.status, exitCode: 0, progress };
          }
        }
      }

      if (anchorFailure) {
        progress.consecutiveAnchorFailures += 1;
      } else {
        progress.consecutiveAnchorFailures = 0;
        progress.days.done += 1;
        if (Object.values(marketStates).includes('trading')) progress.days.trading += 1;
        else progress.days.nonTrading += 1;
      }
      pushLimited(progress.recentDays, {
        date: iso,
        durationMs: Math.max(0, now().getTime() - dayStarted.getTime()),
        ...marketStates,
      });
      const nextDate = previousIsoDate(iso);
      progress.nextDate = nextDate < fromIso ? null : nextDate;

      if (progress.consecutiveAnchorFailures >= 5) {
        await finishLaunch(rootDir, progress, launch, 'BLOCKED', now, daysAtStart);
        return { status: progress.status, exitCode: 1, progress };
      }

      await saveProgress(rootDir, progress, now);
      if (now().getTime() - startedAt.getTime() >= maxMinutes * 60_000) {
        await finishLaunch(rootDir, progress, launch, 'IN_PROGRESS', now, daysAtStart);
        return { status: progress.status, exitCode: 0, progress };
      }
      iso = nextDate;
    }

    progress.nextDate = null;
    await finishLaunch(rootDir, progress, launch, 'DONE', now, daysAtStart);
    logger.log(`[history-backfill] DONE ${fromIso}..${toIso} days=${progress.days.done}`);
    return { status: progress.status, exitCode: 0, progress };
  } finally {
    removeSignalHandlers();
    await release();
  }
}

export const historyBackfillPaths = { lockPath, progressPath, quarantinePath };
