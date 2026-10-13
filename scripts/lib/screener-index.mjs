import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileEnsured } from './io.mjs';

export const SCREENER_COLS = [
  'id',
  'name',
  'market',
  'kind',
  'date',
  'close',
  'chgPct',
  'volume',
  'volAvg20',
  'ma20',
  'ma60',
  'high60',
  'low60',
  'foreignNet',
  'trustNet',
  'dealerNet',
  'foreignStreak',
  'trustStreak',
  'marginBalance',
  'marginChg5',
  'shortBalance',
  'big1000',
  'retail',
  'big1000Chg4w',
  'retailChg4w',
  'tdccWeek',
];

const INCLUDED_ID = /^(?:\d{4}|00\d{2,4}[A-Z]?)$/;

function round(value, digits = 0) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function intDateToIso(value) {
  const text = String(value).padStart(8, '0');
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function columnIndexes(cols) {
  return new Map(cols.map((column, index) => [column, index]));
}

function valueAt(row, indexes, column) {
  return row[indexes.get(column)];
}

function roundedValue(value, divisor = 1, digits = 0) {
  return value === null ? null : round(value / divisor, digits);
}

function average(rows, indexes, column, divisor, digits) {
  const values = rows.map((row) => valueAt(row, indexes, column));
  if (values.some((value) => value === null)) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length / divisor, digits);
}

function streak(rows, indexes, column) {
  const latest = valueAt(rows.at(-1), indexes, column);
  if (latest === null || latest === 0) return 0;
  const sign = Math.sign(latest);
  let count = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = valueAt(rows[index], indexes, column);
    if (value === null || value === 0 || Math.sign(value) !== sign) break;
    count += 1;
  }
  return sign * count;
}

async function readTdcc(rootDir, id) {
  const path = join(rootDir, 'data', 'derived', 'tdcc', id.slice(0, 2), `${id}.json`);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function tdccSummary(tdcc) {
  if (!tdcc?.rows?.length) return [null, null, null, null, null];
  const indexes = columnIndexes(tdcc.cols);
  const latest = tdcc.rows.at(-1);
  const previous = tdcc.rows.length >= 5 ? tdcc.rows.at(-5) : null;
  const big1000 = valueAt(latest, indexes, 'big1000');
  const retail = valueAt(latest, indexes, 'retail');
  const previousBig1000 = previous && valueAt(previous, indexes, 'big1000');
  const previousRetail = previous && valueAt(previous, indexes, 'retail');
  return [
    big1000,
    retail,
    previous && big1000 !== null && previousBig1000 !== null
      ? round(big1000 - previousBig1000, 2)
      : null,
    previous && retail !== null && previousRetail !== null
      ? round(retail - previousRetail, 2)
      : null,
    intDateToIso(valueAt(latest, indexes, 'w')),
  ];
}

async function summarizeSymbol(rootDir, symbol) {
  if (!symbol.rows?.length) return null;
  const indexes = columnIndexes(symbol.cols);
  const rows = symbol.rows;
  const latest = rows.at(-1);
  const previous = rows.length >= 2 ? rows.at(-2) : null;
  const close = valueAt(latest, indexes, 'c');
  const previousClose = previous && valueAt(previous, indexes, 'c');
  const last20 = rows.slice(-20);
  const last60 = rows.slice(-60);
  const prior20 = rows.slice(-21, -1);
  const highValues = last60.map((row) => valueAt(row, indexes, 'h'));
  const lowValues = last60.map((row) => valueAt(row, indexes, 'l'));
  const marginBalance = valueAt(latest, indexes, 'mb');
  const marginReference = rows.length >= 6 ? valueAt(rows.at(-6), indexes, 'mb') : null;
  const tdcc = tdccSummary(await readTdcc(rootDir, symbol.id));

  return [
    symbol.id,
    symbol.name,
    symbol.market,
    symbol.id.startsWith('00') ? 'etf' : 'stock',
    intDateToIso(valueAt(latest, indexes, 'd')),
    close,
    previous && close !== null && previousClose !== null && previousClose !== 0
      ? round((close - previousClose) / previousClose * 100, 2)
      : null,
    roundedValue(valueAt(latest, indexes, 'v'), 1000),
    prior20.length === 20 ? average(prior20, indexes, 'v', 1000, 1) : null,
    last20.length === 20 ? average(last20, indexes, 'c', 1, 2) : null,
    last60.length === 60 ? average(last60, indexes, 'c', 1, 2) : null,
    last60.length === 60 && !highValues.includes(null) ? Math.max(...highValues) : null,
    last60.length === 60 && !lowValues.includes(null) ? Math.min(...lowValues) : null,
    roundedValue(valueAt(latest, indexes, 'ff'), 1000),
    roundedValue(valueAt(latest, indexes, 'ft'), 1000),
    roundedValue(valueAt(latest, indexes, 'fd'), 1000),
    streak(rows, indexes, 'ff'),
    streak(rows, indexes, 'ft'),
    marginBalance,
    marginReference !== null && marginBalance !== null ? marginBalance - marginReference : null,
    valueAt(latest, indexes, 'ms'),
    ...tdcc,
  ];
}

export async function buildScreenerIndex(rootDir = process.cwd()) {
  const symbolsDir = join(rootDir, 'data', 'derived', 'symbols');
  const rows = [];
  let prefixes;
  try {
    prefixes = await readdir(symbolsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { updated: null, cols: SCREENER_COLS, rows };
    throw error;
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue;
    const dir = join(symbolsDir, prefix.name);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!INCLUDED_ID.test(id)) continue;
      const symbol = JSON.parse(await readFile(join(dir, entry.name), 'utf8'));
      const row = await summarizeSymbol(rootDir, symbol);
      if (row) rows.push(row);
    }
  }
  rows.sort((left, right) => left[0].localeCompare(right[0]));
  const updated = rows.reduce((latest, row) => latest === null || row[4] > latest ? row[4] : latest, null);
  return { updated, cols: SCREENER_COLS, rows };
}

export async function applyScreenerIndex(rootDir = process.cwd()) {
  const index = await buildScreenerIndex(rootDir);
  const path = join(rootDir, 'data', 'index', 'screener.json');
  const next = `${JSON.stringify(index)}\n`;
  try {
    if (await readFile(path, 'utf8') === next) {
      return { rows: index.rows.length, written: false };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFileEnsured(path, next);
  return { rows: index.rows.length, written: true };
}
