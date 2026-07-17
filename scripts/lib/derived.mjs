import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseGregorianDate, parseRocMonth, parseTradingDate, yyyyOf } from './date.mjs';
import { readJsonIfExists, writeFileEnsured } from './io.mjs';

export const DEFAULT_SYMBOL_WINDOW = 480;
export const DEFAULT_TDCC_WINDOW = 64;
export const DEFAULT_VALUATION_WINDOW = 480;
export const DEFAULT_REVENUE_WINDOW = 36;

const SYMBOL_COLS = ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd'];
const TDCC_COLS = ['w', 'big1000', 'big400', 'retail', 'holders', 'avgShares'];
const VALUATION_COLS = ['d', 'per', 'pbr', 'dy'];
const REVENUE_COLS = ['m', 'rev', 'yoy', 'mom'];
const TPEX_INSTI_FIELDS = {
  ff: 'ForeignInvestorsIncludeMainlandAreaInvestors-Difference',
  ft: 'SecuritiesInvestmentTrustCompanies-Difference',
  fd: 'Dealers-Difference',
};
const MARKET_TEMPLATE = {
  updated: null,
  twse: {
    index: { cols: ['d', 'c'], rows: [] },
    margin: { cols: ['d', 'mb', 'ms'], rows: [] },
  },
  tpex: {
    index: { cols: ['d', 'o', 'h', 'l', 'c'], rows: [] },
    margin: { cols: ['d', 'mb', 'ms'], rows: [] },
    insti: { cols: ['d', 'fi'], rows: [] },
  },
};

export function isDerivedSymbolId(id) {
  const text = String(id ?? '').trim();
  return text.length > 0 && !/^\d{6}$/.test(text);
}

function isoToInt(date) {
  return Number(date.replaceAll('-', ''));
}

function intToIso(value) {
  const text = String(value);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function p2(id) {
  return String(id).slice(0, 2);
}

function compactNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replaceAll(',', '');
  if (text === '' || text === '--') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function sumCell(value) {
  if (value === null || value === undefined || String(value).trim() === '') return { ok: true, value: 0 };
  const number = compactNumber(value);
  return number === null ? { ok: false, value: 0 } : { ok: true, value: number };
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function readJsonRaw(rootDir, sourceDataset, date) {
  return readJsonIfExists(join(rootDir, 'data', 'raw', sourceDataset, yyyyOf(date), `${date}.json`), null);
}

async function readTextRaw(rootDir, sourceDataset, date) {
  try {
    return await readFile(join(rootDir, 'data', 'raw', sourceDataset, yyyyOf(date), `${date}.json`), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readExistingJson(path, fallback) {
  return readJsonIfExists(path, fallback);
}

export function stableDerivedString(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeDerivedJson(path, value) {
  const next = stableDerivedString(value);
  try {
    const current = await readFile(path, 'utf8');
    if (current === next) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFileEnsured(path, next);
  return true;
}

function updatedFromRows(rows) {
  if (!rows.length) return null;
  return intToIso(rows.at(-1)[0]);
}

function monthIntToIso(value) {
  const text = String(value);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-01`;
}

function fundamentalsUpdated(valuationRows, revenueRows) {
  const values = [];
  if (valuationRows.length) values.push(intToIso(valuationRows.at(-1)[0]));
  if (revenueRows.length) values.push(monthIntToIso(revenueRows.at(-1)[0]));
  values.sort();
  return values.at(-1) ?? null;
}

function normalizeTpexInstiKey(key) {
  return String(key ?? '').replaceAll(/\s+/g, '');
}

function skipJsonWhitespace(text, index) {
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function parseJsonStringLiteral(text, index) {
  if (text[index] !== '"') throw new Error('invalid JSON string');
  let escaped = false;
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return { value: JSON.parse(text.slice(index, cursor + 1)), next: cursor + 1 };
    }
  }
  throw new Error('unterminated JSON string');
}

function scanJsonValue(text, index) {
  index = skipJsonWhitespace(text, index);
  const start = index;
  const initial = text[index];
  if (initial === '"') {
    return parseJsonStringLiteral(text, index);
  }
  if (initial === '{' || initial === '[') {
    const stack = [initial === '{' ? '}' : ']'];
    let escaped = false;
    let quoted = false;
    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          quoted = false;
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === '{') {
        stack.push('}');
        continue;
      }
      if (char === '[') {
        stack.push(']');
        continue;
      }
      if (char === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) {
          return { value: JSON.parse(text.slice(start, cursor + 1)), next: cursor + 1 };
        }
      }
    }
    throw new Error('unterminated JSON value');
  }
  let cursor = index;
  while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor += 1;
  return { value: JSON.parse(text.slice(start, cursor)), next: cursor };
}

function parseTpexInstiRows(text) {
  const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  let index = skipJsonWhitespace(source, 0);
  if (source[index] !== '[') throw new Error('invalid 3insti JSON: expected array');
  index += 1;
  const rows = [];
  index = skipJsonWhitespace(source, index);
  if (source[index] === ']') return rows;
  while (index < source.length) {
    index = skipJsonWhitespace(source, index);
    if (source[index] !== '{') throw new Error('invalid 3insti JSON: expected object');
    index += 1;
    const row = Object.create(null);
    index = skipJsonWhitespace(source, index);
    if (source[index] === '}') {
      rows.push(row);
      index += 1;
    } else {
      while (index < source.length) {
        const key = parseJsonStringLiteral(source, index);
        index = skipJsonWhitespace(source, key.next);
        if (source[index] !== ':') throw new Error('invalid 3insti JSON: expected colon');
        index = skipJsonWhitespace(source, index + 1);
        const value = scanJsonValue(source, index);
        const normalizedKey = normalizeTpexInstiKey(key.value);
        if (!Object.hasOwn(row, normalizedKey)) row[normalizedKey] = value.value;
        index = skipJsonWhitespace(source, value.next);
        if (source[index] === ',') {
          index = skipJsonWhitespace(source, index + 1);
          continue;
        }
        if (source[index] === '}') {
          rows.push(row);
          index += 1;
          break;
        }
        throw new Error('invalid 3insti JSON: expected comma or object end');
      }
    }
    index = skipJsonWhitespace(source, index);
    if (source[index] === ',') {
      index = skipJsonWhitespace(source, index + 1);
      continue;
    }
    if (source[index] === ']') return rows;
    if (index >= source.length) break;
    throw new Error('invalid 3insti JSON: expected array end');
  }
  throw new Error('invalid 3insti JSON: unterminated array');
}

function upsertRows(rows, nextRow, window) {
  const key = nextRow[0];
  const kept = rows.filter((row) => row[0] !== key);
  kept.push(nextRow);
  kept.sort((a, b) => a[0] - b[0]);
  return window ? kept.slice(-window) : kept;
}

async function upsertSymbol(rootDir, item, row, window) {
  const path = join(rootDir, 'data', 'derived', 'symbols', p2(item.id), `${item.id}.json`);
  const current = await readExistingJson(path, {
    id: item.id,
    name: item.name,
    market: item.market,
    updated: null,
    cols: SYMBOL_COLS,
    rows: [],
  });
  const rows = upsertRows(current.rows ?? [], row, window);
  const next = {
    id: item.id,
    name: item.name,
    market: item.market,
    updated: updatedFromRows(rows),
    cols: SYMBOL_COLS,
    rows,
  };
  return writeDerivedJson(path, next);
}

async function upsertTdcc(rootDir, id, row, window) {
  const path = join(rootDir, 'data', 'derived', 'tdcc', p2(id), `${id}.json`);
  const current = await readExistingJson(path, {
    id,
    updated: null,
    cols: TDCC_COLS,
    rows: [],
  });
  const rows = upsertRows(current.rows ?? [], row, window);
  return writeDerivedJson(path, { id, updated: updatedFromRows(rows), cols: TDCC_COLS, rows });
}

async function upsertFundamental(rootDir, item, kind, row, window) {
  const path = join(rootDir, 'data', 'derived', 'fundamentals', p2(item.id), `${item.id}.json`);
  const current = await readExistingJson(path, {
    id: item.id,
    name: item.name,
    market: item.market,
    updated: null,
    valuation: { cols: VALUATION_COLS, rows: [] },
    revenue: { cols: REVENUE_COLS, rows: [] },
  });
  const valuationRows = kind === 'valuation'
    ? upsertRows(current.valuation?.rows ?? [], row, window)
    : current.valuation?.rows ?? [];
  const revenueRows = kind === 'revenue'
    ? upsertRows(current.revenue?.rows ?? [], row, window)
    : current.revenue?.rows ?? [];
  const incomingWinsMetadata = kind === 'valuation'
    || current.market !== 'twse'
    || item.market === 'twse';
  const next = {
    id: item.id,
    name: incomingWinsMetadata ? item.name : current.name,
    market: incomingWinsMetadata ? item.market : current.market,
    updated: fundamentalsUpdated(valuationRows, revenueRows),
    valuation: { cols: VALUATION_COLS, rows: valuationRows },
    revenue: { cols: REVENUE_COLS, rows: revenueRows },
  };
  return writeDerivedJson(path, next);
}

function normalizeMarket(input) {
  return {
    updated: input?.updated ?? null,
    twse: {
      index: { cols: MARKET_TEMPLATE.twse.index.cols, rows: input?.twse?.index?.rows ?? [] },
      margin: { cols: MARKET_TEMPLATE.twse.margin.cols, rows: input?.twse?.margin?.rows ?? [] },
    },
    tpex: {
      index: { cols: MARKET_TEMPLATE.tpex.index.cols, rows: input?.tpex?.index?.rows ?? [] },
      margin: { cols: MARKET_TEMPLATE.tpex.margin.cols, rows: input?.tpex?.margin?.rows ?? [] },
      insti: { cols: MARKET_TEMPLATE.tpex.insti.cols, rows: input?.tpex?.insti?.rows ?? [] },
    },
  };
}

function upsertSeries(series, row) {
  series.rows = upsertRows(series.rows ?? [], row, null);
}

function refreshMarketUpdated(market) {
  const dates = [
    ...market.twse.index.rows,
    ...market.twse.margin.rows,
    ...market.tpex.index.rows,
    ...market.tpex.margin.rows,
    ...market.tpex.insti.rows,
  ].map((row) => row[0]).sort((a, b) => a - b);
  market.updated = dates.length ? intToIso(dates.at(-1)) : null;
}

function mapBy(rows, key) {
  const result = new Map();
  for (const row of rows ?? []) {
    const id = String(row?.[key] ?? '').trim();
    if (id) result.set(id, row);
  }
  return result;
}

function balanceRow(row, mbField, msField) {
  if (!row) return [null, null];
  return [compactNumber(row[mbField]), compactNumber(row[msField])];
}

function sumBalances(rows, mbField, msField) {
  let mb = 0;
  let ms = 0;
  let used = false;
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue;
    const mbCell = sumCell(row[mbField]);
    const msCell = sumCell(row[msField]);
    if (!mbCell.ok || !msCell.ok) continue;
    mb += mbCell.value;
    ms += msCell.value;
    used = true;
  }
  return used ? [mb, ms] : null;
}

function sumField(rows, field) {
  let total = 0;
  let used = false;
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue;
    const value = compactNumber(row[field]);
    if (value === null) continue;
    total += value;
    used = true;
  }
  return used ? total : null;
}

export async function applyDailyDate(rootDir, isoDate, { symbolWindow = DEFAULT_SYMBOL_WINDOW } = {}) {
  const ymd = isoToInt(isoDate);
  const written = { symbols: 0, fundamentals: 0, market: false };
  const [
    twseIndex,
    twseClose,
    twseMargin,
    tpexIndex,
    tpexClose,
    tpexInstiText,
    tpexMargin,
    twseValuation,
  ] = await Promise.all([
    readJsonRaw(rootDir, 'twse/mi_index', isoDate),
    readJsonRaw(rootDir, 'twse/stock_day_all', isoDate),
    readJsonRaw(rootDir, 'twse/mi_margn', isoDate),
    readJsonRaw(rootDir, 'tpex/index', isoDate),
    readJsonRaw(rootDir, 'tpex/mainboard_close', isoDate),
    readTextRaw(rootDir, 'tpex/3insti', isoDate),
    readJsonRaw(rootDir, 'tpex/margin', isoDate),
    readJsonRaw(rootDir, 'twse/bwibbu_all', isoDate),
  ]);
  const tpexInsti = tpexInstiText ? parseTpexInstiRows(tpexInstiText) : null;

  const twseMarginById = mapBy(twseMargin, '股票代號');
  const tpexMarginById = mapBy(tpexMargin, 'SecuritiesCompanyCode');
  const tpexInstiById = mapBy(tpexInsti, 'SecuritiesCompanyCode');
  const twseIds = new Set();

  for (const row of twseClose ?? []) {
    const id = String(row?.Code ?? '').trim();
    if (!isDerivedSymbolId(id)) continue;
    twseIds.add(id);
    const [mb, ms] = balanceRow(twseMarginById.get(id), '融資今日餘額', '融券今日餘額');
    const didWrite = await upsertSymbol(rootDir, {
      id,
      name: row.Name ?? '',
      market: 'twse',
    }, [
      ymd,
      compactNumber(row.OpeningPrice),
      compactNumber(row.HighestPrice),
      compactNumber(row.LowestPrice),
      compactNumber(row.ClosingPrice),
      compactNumber(row.TradeVolume),
      compactNumber(row.Transaction),
      mb,
      ms,
      null,
      null,
      null,
      null,
    ], symbolWindow);
    if (didWrite) written.symbols += 1;
  }

  for (const row of tpexClose ?? []) {
    const id = String(row?.SecuritiesCompanyCode ?? '').trim();
    if (!isDerivedSymbolId(id)) continue;
    if (twseIds.has(id)) {
      console.warn(`[warn] derived: symbol ${id} appears in both TWSE and TPEX on ${isoDate}; keeping TWSE`);
      continue;
    }
    const [mb, ms] = balanceRow(tpexMarginById.get(id), 'MarginPurchaseBalance', 'ShortSaleBalance');
    const insti = tpexInstiById.get(id);
    const didWrite = await upsertSymbol(rootDir, {
      id,
      name: row.CompanyName ?? '',
      market: 'tpex',
    }, [
      ymd,
      compactNumber(row.Open),
      compactNumber(row.High),
      compactNumber(row.Low),
      compactNumber(row.Close),
      compactNumber(row.TradingShares),
      compactNumber(row.TransactionNumber),
      mb,
      ms,
      compactNumber(insti?.TotalDifference),
      compactNumber(insti?.[TPEX_INSTI_FIELDS.ff]),
      compactNumber(insti?.[TPEX_INSTI_FIELDS.ft]),
      compactNumber(insti?.[TPEX_INSTI_FIELDS.fd]),
    ], symbolWindow);
    if (didWrite) written.symbols += 1;
  }

  for (const row of twseValuation ?? []) {
    const id = String(row?.Code ?? '').trim();
    if (!isDerivedSymbolId(id)) continue;
    const didWrite = await upsertFundamental(rootDir, {
      id,
      name: row.Name ?? '',
      market: 'twse',
    }, 'valuation', [
      ymd,
      compactNumber(row.PEratio),
      compactNumber(row.PBratio),
      compactNumber(row.DividendYield),
    ], DEFAULT_VALUATION_WINDOW);
    if (didWrite) written.fundamentals += 1;
  }

  const marketPath = join(rootDir, 'data', 'derived', 'market.json');
  const market = normalizeMarket(await readExistingJson(marketPath, MARKET_TEMPLATE));
  if (twseIndex) {
    const row = twseIndex.find((item) => item?.['指數'] === '發行量加權股價指數');
    if (row) upsertSeries(market.twse.index, [ymd, compactNumber(row['收盤指數'])]);
    else console.warn(`[warn] derived: TWSE weighted index row missing on ${isoDate}`);
  }
  if (tpexIndex) {
    for (const row of tpexIndex) {
      const rowDate = parseGregorianDate(row?.Date);
      if (!rowDate) continue;
      upsertSeries(market.tpex.index, [
        isoToInt(rowDate),
        compactNumber(row.Open),
        compactNumber(row.High),
        compactNumber(row.Low),
        compactNumber(row.Close),
      ]);
    }
  }
  const twseMarginSum = sumBalances(twseMargin, '融資今日餘額', '融券今日餘額');
  if (twseMarginSum) upsertSeries(market.twse.margin, [ymd, twseMarginSum[0], twseMarginSum[1]]);
  const tpexMarginSum = sumBalances(tpexMargin, 'MarginPurchaseBalance', 'ShortSaleBalance');
  if (tpexMarginSum) upsertSeries(market.tpex.margin, [ymd, tpexMarginSum[0], tpexMarginSum[1]]);
  const tpexFi = sumField(tpexInsti, 'TotalDifference');
  if (tpexFi !== null) upsertSeries(market.tpex.insti, [ymd, tpexFi]);
  refreshMarketUpdated(market);
  written.market = await writeDerivedJson(marketPath, market);
  return written;
}

export async function applyMonthlyRevenue(rootDir, monthKey, { revenueWindow = DEFAULT_REVENUE_WINDOW } = {}) {
  const month = Number(monthKey.replace('-', ''));
  const sources = [
    { sourceDataset: 'twse/monthly_revenue', market: 'twse' },
    { sourceDataset: 'tpex/monthly_revenue', market: 'tpex' },
  ];
  let written = 0;
  for (const source of sources) {
    const rows = await readJsonIfExists(
      join(rootDir, 'data', 'raw', source.sourceDataset, monthKey.slice(0, 4), `${monthKey}.json`),
      null,
    );
    for (const row of rows ?? []) {
      if (parseRocMonth(row?.['資料年月']) !== monthKey) continue;
      const id = String(row?.['公司代號'] ?? '').trim();
      if (!isDerivedSymbolId(id)) continue;
      const didWrite = await upsertFundamental(rootDir, {
        id,
        name: row['公司名稱'] ?? '',
        market: source.market,
      }, 'revenue', [
        month,
        compactNumber(row['營業收入-當月營收']),
        compactNumber(row['營業收入-去年同月增減(%)']),
        compactNumber(row['營業收入-上月比較增減(%)']),
      ], revenueWindow);
      if (didWrite) written += 1;
    }
  }
  return { fundamentals: written };
}

export function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseTdccRows(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const headerLine = lines.find((line) => line.length > 0);
  if (!headerLine) return [];
  const header = parseCsvLine(headerLine);
  if (header.length > 0) header[0] = header[0].replace(/^\uFEFF/, '');
  const start = lines.indexOf(headerLine) + 1;
  return lines.slice(start).filter((line) => line.trim()).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? '']));
  });
}

export async function applyTdccWeek(rootDir, isoDate, { tdccWindow = DEFAULT_TDCC_WINDOW } = {}) {
  const path = join(rootDir, 'data', 'raw', 'tdcc', yyyyOf(isoDate), `${isoDate}.csv.gz`);
  const text = gunzipSync(await readFile(path)).toString('utf8');
  const rows = parseTdccRows(text);
  const grouped = new Map();
  for (const row of rows) {
    const id = String(row['證券代號'] ?? '').trim();
    if (!isDerivedSymbolId(id)) continue;
    if (!grouped.has(id)) grouped.set(id, new Map());
    grouped.get(id).set(Number(row['持股分級']), row);
  }

  let written = 0;
  for (const [id, byGrade] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const total = byGrade.get(17);
    if (!total) {
      console.warn(`[warn] derived: TDCC ${id} missing grade 17 on ${isoDate}; skip`);
      continue;
    }
    const weekDate = parseGregorianDate(total['資料日期']);
    if (!weekDate) continue;
    const ratio = (grade) => compactNumber(byGrade.get(grade)?.['占集保庫存數比例%']) ?? 0;
    const holders = compactNumber(total['人數']);
    const shares = compactNumber(total['股數']);
    const avgShares = holders && shares !== null ? Math.round(shares / holders) : null;
    const didWrite = await upsertTdcc(rootDir, id, [
      isoToInt(weekDate),
      round2(ratio(15)),
      round2(ratio(12) + ratio(13) + ratio(14) + ratio(15)),
      round2(ratio(1) + ratio(2) + ratio(3)),
      holders,
      avgShares,
    ], tdccWindow);
    if (didWrite) written += 1;
  }
  return { tdcc: written };
}
