import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { REFERENCE_ENDPOINTS } from './endpoints.mjs';
import { parseNumericFlag } from './lib/cli.mjs';
import { parseGregorianDate, taipeiIsoDate } from './lib/date.mjs';
import { latestCompanyIndustryRows } from './lib/derived.mjs';
import { writeFileEnsured } from './lib/io.mjs';

function parseArgs(argv) {
  const allowed = new Set(['date', 'out', 'delay-ms']);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unknown argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`unknown argument: ${token}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function assertOptions({ date, delayMs, now }) {
  const parsedDate = parseGregorianDate(date);
  if (!parsedDate || parsedDate !== date) throw new Error(`--date must be YYYY-MM-DD, got: ${date}`);
  const today = taipeiIsoDate(now());
  if (parsedDate >= today) throw new Error(`--date must be before Taipei today ${today}, got: ${date}`);
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`--delay-ms must be a non-negative number, got: ${delayMs}`);
  }
  return parsedDate;
}

async function isParseableJson(path) {
  try {
    JSON.parse(await readFile(path, 'utf8'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function writeRawOnChange(path, bytes) {
  try {
    if ((await readFile(path)).equals(bytes)) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFileEnsured(path, bytes);
  return true;
}

export function industryNameBackfillOptionsFromArgs(args, { now = () => new Date() } = {}) {
  const delayMs = parseNumericFlag(args['delay-ms'], 3000);
  const date = assertOptions({ date: args.date, delayMs, now });
  return {
    rootDir: args.out === undefined ? process.cwd() : resolve(args.out),
    date,
    delayMs,
    now,
  };
}

export async function runIndustryNameBackfill({
  rootDir = process.cwd(),
  date,
  delayMs = 3000,
  fetcher = globalThis.fetch,
  now = () => new Date(),
  sleepImpl = sleep,
  logger = console,
} = {}) {
  const targetDate = assertOptions({ date, delayMs, now });
  const endpoint = REFERENCE_ENDPOINTS.twse_industry_mi_index;
  const { codes } = await latestCompanyIndustryRows(rootDir);
  const failures = [];
  let written = 0;
  let skipped = 0;
  let requests = 0;
  for (const code of codes) {
    const relativePath = join('data', 'raw', endpoint.sourceDataset, targetDate.slice(0, 4), `${targetDate}_${code}.json`);
    const path = join(rootDir, relativePath);
    if (await isParseableJson(path)) {
      skipped += 1;
      logger.log(`[skip] ${code}: ${relativePath}`);
      continue;
    }
    if (requests > 0 && delayMs > 0) await sleepImpl(delayMs);
    requests += 1;
    try {
      const response = await fetcher(endpoint.url(targetDate.replaceAll('-', ''), code));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const didWrite = await writeRawOnChange(path, bytes);
      if (didWrite) written += 1;
      logger.log(`[${didWrite ? 'write' : 'same'}] ${code}: ${relativePath}`);
    } catch (error) {
      const message = error?.message ?? String(error);
      failures.push({ code, error: message });
      logger.error(`[fail] ${code}: ${message}`);
    }
  }
  logger.log(`industry names: date=${targetDate} codes=${codes.length} written=${written} skipped=${skipped} failed=${failures.length}`);
  return { date: targetDate, codes: codes.length, written, skipped, failures };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    const options = industryNameBackfillOptionsFromArgs(parseArgs(process.argv.slice(2)));
    const summary = await runIndustryNameBackfill(options);
    if (summary.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
