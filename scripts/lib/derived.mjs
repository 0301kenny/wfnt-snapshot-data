import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseGregorianDate, parseRocMonth, parseTradingDate, yyyyOf } from './date.mjs';
import { readJsonIfExists, writeFileEnsured } from './io.mjs';

export const DEFAULT_SYMBOL_WINDOW = 1300;
export const DEFAULT_TDCC_WINDOW = 64;
export const DEFAULT_VALUATION_WINDOW = 1300;
export const DEFAULT_REVENUE_WINDOW = 36;
export const DEFAULT_QUARTERLY_WINDOW = 24;
export const DERIVED_INPUT_DATASETS = new Set([
  'twse/mi_index',
  'twse/stock_day_all',
  'twse/mi_margn',
  'tpex/index',
  'tpex/mainboard_close',
  'tpex/3insti',
  'tpex/margin',
  'twse/bwibbu_all',
  'twse/mi_index_hist',
  'twse/t86_hist',
  'twse/mi_margn_hist',
  'twse/sbl_hist',
  'tpex/daily_quotes_hist',
  'tpex/insti_hist',
  'tpex/margin_hist',
  'tpex/sbl_hist',
  'twse/bwibbu_hist',
  'tpex/pe_hist',
]);

const SYMBOL_COLS = ['d', 'o', 'h', 'l', 'c', 'v', 't', 'mb', 'ms', 'fi', 'ff', 'ft', 'fd', 'sb', 'ss'];
const TDCC_COLS = ['w', 'big1000', 'big400', 'retail', 'holders', 'avgShares'];
const VALUATION_COLS = ['d', 'per', 'pbr', 'dy'];
const REVENUE_COLS = ['m', 'rev', 'yoy', 'mom'];
export const QUARTERLY_COLS = ['q', 'gm', 'om', 'nm'];
export const FUNDAMENTAL_SERIES = Object.freeze({
  valuation: Object.freeze({
    cols: VALUATION_COLS,
    window: DEFAULT_VALUATION_WINDOW,
    updatesFundamentalsUpdated: true,
    updatedFromKey: intToIso,
    incomingWinsMetadata: true,
  }),
  revenue: Object.freeze({
    cols: REVENUE_COLS,
    window: DEFAULT_REVENUE_WINDOW,
    updatesFundamentalsUpdated: true,
    updatedFromKey: monthIntToIso,
    incomingWinsMetadata: false,
  }),
  quarterly: Object.freeze({
    cols: QUARTERLY_COLS,
    window: DEFAULT_QUARTERLY_WINDOW,
    updatesFundamentalsUpdated: false,
    updatedFromKey: null,
    incomingWinsMetadata: false,
  }),
});
export const MOPS_QUARTERLY_FIELDS = {
  id: '公司代號',
  name: '公司名稱',
  revenue: '營業收入',
  grossProfit: '營業毛利（毛損）',
  operatingIncome: '營業利益（損失）',
  netIncome: '本期淨利（淨損）',
};
const MOPS_REVENUE_FIELDS = [
  '公司代號',
  '公司名稱',
  '營業收入-當月營收',
  '營業收入-上月營收',
  '營業收入-去年當月營收',
  '營業收入-上月比較增減(%)',
  '營業收入-去年同月增減(%)',
  '累計營業收入-當月累計營收',
  '累計營業收入-去年累計營收',
  '累計營業收入-前期比較增減(%)',
  '備註',
];
const TPEX_INSTI_FIELDS = {
  ff: 'ForeignInvestorsIncludeMainlandAreaInvestors-Difference',
  ft: 'SecuritiesInvestmentTrustCompanies-Difference',
  fd: 'Dealers-Difference',
};
const T86_FIELDS = {
  id: '證券代號',
  name: '證券名稱',
  foreign: '外陸資買賣超股數(不含外資自營商)',
  foreignDealer: '外資自營商買賣超股數',
  trust: '投信買賣超股數',
  dealer: '自營商買賣超股數',
  total: '三大法人買賣超股數',
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

function decodeHtmlEntities(value) {
  return value.replace(/&(#\d+|#x[\da-f]+|nbsp|amp|lt|gt|quot|apos);/gi, (entity, token) => {
    const lower = token.toLowerCase();
    if (lower === 'nbsp') return ' ';
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const radix = lower.startsWith('#x') ? 16 : 10;
    const digits = lower.slice(radix === 16 ? 2 : 1);
    const codePoint = Number.parseInt(digits, radix);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
  });
}

function mopsCellText(value) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, '')).trim();
}

function decodeMopsHtml(bytes) {
  try {
    return new TextDecoder('big5', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('MOPS monthly revenue: invalid big5 HTML');
  }
}

function decodeMopsQuarterlyHtml(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('MOPS quarterly financials: invalid UTF-8 HTML');
  }
}

export function parseMopsQuarterlyFinHtml(bytes) {
  const html = decodeMopsQuarterlyHtml(bytes);
  let header = null;
  let indexes = null;
  const rows = [];
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
      .map((match) => mopsCellText(match[1]));
    if (cells[0] === '公司代號') {
      if (header) break;
      if (!cells.includes(MOPS_QUARTERLY_FIELDS.grossProfit)) continue;
      header = cells;
      indexes = requiredFieldIndexes(
        header,
        MOPS_QUARTERLY_FIELDS,
        'MOPS quarterly financials',
      );
      continue;
    }
    if (!header || !/^\d{4}$/.test(cells[0] ?? '') || cells.length !== header.length) continue;
    rows.push({
      id: cells[indexes.id],
      name: cells[indexes.name],
      revenue: compactNumber(cells[indexes.revenue]),
      grossProfit: compactNumber(cells[indexes.grossProfit]),
      operatingIncome: compactNumber(cells[indexes.operatingIncome]),
      netIncome: compactNumber(cells[indexes.netIncome]),
    });
  }
  if (!header) throw new Error('MOPS quarterly financials: general-industry header missing');
  if (rows.length === 0) throw new Error('MOPS quarterly financials: response has 0 general-industry data rows');
  return rows;
}

export function parseMopsMonthlyRevenue(bytes, rocMonth) {
  const period = String(rocMonth ?? '');
  if (!/^\d{5}$/.test(period) || Number(period.slice(-2)) < 1 || Number(period.slice(-2)) > 12) {
    throw new Error(`MOPS monthly revenue: invalid ROC month ${rocMonth}`);
  }
  const html = decodeMopsHtml(bytes);
  const rows = [];
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((match) => mopsCellText(match[1]));
    if (!/^\d{4}$/.test(cells[0] ?? '')) continue;
    if (cells.length !== MOPS_REVENUE_FIELDS.length) {
      throw new Error(`MOPS monthly revenue: company ${cells[0]} has ${cells.length} columns, expected 11`);
    }
    const row = Object.fromEntries(MOPS_REVENUE_FIELDS.map((field, index) => {
      if (index >= 2 && index <= 9) return [field, compactNumber(cells[index])];
      return [field, cells[index]];
    }));
    row['資料年月'] = period;
    rows.push(row);
  }
  return rows;
}

export function validateMopsMonthlyRevenueHtml(bytes, rocMonth) {
  if (!bytes || bytes.length <= 1024) {
    throw new Error(`MOPS monthly revenue: response too short (${bytes?.length ?? 0} bytes)`);
  }
  const html = decodeMopsHtml(bytes);
  if (!/營業收入統計表/.test(html)) {
    throw new Error('MOPS monthly revenue: response title marker missing');
  }
  const rows = parseMopsMonthlyRevenue(bytes, rocMonth);
  if (rows.length === 0) throw new Error('MOPS monthly revenue: response has 0 data rows');
  return rows;
}

function requiredFieldIndexes(fields, mapping, label) {
  if (!Array.isArray(fields)) throw new Error(`${label}: fields is not an array`);
  const indexes = {};
  for (const [key, field] of Object.entries(mapping)) {
    const index = fields.indexOf(field);
    if (index === -1) throw new Error(`${label}: missing field ${field}`);
    indexes[key] = index;
  }
  return indexes;
}

function requiredLegacyTable(payload, tableIndex, label) {
  if (payload?.stat !== 'OK') throw new Error(`${label}: stat is not OK`);
  const table = payload?.tables?.[tableIndex];
  if (!table || !Array.isArray(table.data)) throw new Error(`${label}: tables[${tableIndex}] is invalid`);
  return table;
}

export function isTwseMiIndexTradingDay(payload) {
  return payload?.stat === 'OK'
    && Array.isArray(payload?.tables?.[8]?.data)
    && payload.tables[8].data.length > 0;
}

export function parseTwseMiIndexHist(payload) {
  const table = requiredLegacyTable(payload, 8, 'MI_INDEX');
  const indexes = requiredFieldIndexes(table.fields, {
    id: '證券代號',
    name: '證券名稱',
    volume: '成交股數',
    transactions: '成交筆數',
    open: '開盤價',
    high: '最高價',
    low: '最低價',
    close: '收盤價',
  }, 'MI_INDEX');
  return table.data.map((row) => ({
    Code: String(row?.[indexes.id] ?? '').trim(),
    Name: String(row?.[indexes.name] ?? '').trim(),
    TradeVolume: row?.[indexes.volume],
    Transaction: row?.[indexes.transactions],
    OpeningPrice: row?.[indexes.open],
    HighestPrice: row?.[indexes.high],
    LowestPrice: row?.[indexes.low],
    ClosingPrice: row?.[indexes.close],
  }));
}

export function parseTwseMiMargnHist(payload) {
  const table = requiredLegacyTable(payload, 1, 'MI_MARGN');
  if (!Array.isArray(table.fields)) throw new Error('MI_MARGN: fields is not an array');
  if (!Array.isArray(table.groups)) throw new Error('MI_MARGN: groups is not an array');

  const blocks = new Map();
  let start = 0;
  for (const group of table.groups) {
    if (!Number.isInteger(group?.span) || group.span <= 0) {
      throw new Error('MI_MARGN: invalid group span');
    }
    const end = start + group.span;
    if (end > table.fields.length) throw new Error('MI_MARGN: group spans exceed fields');
    if (['股票', '融資', '融券'].includes(group.title)) {
      if (blocks.has(group.title)) throw new Error(`MI_MARGN: duplicate group ${group.title}`);
      blocks.set(group.title, { start, end });
    }
    start = end;
  }
  if (start !== table.fields.length) throw new Error('MI_MARGN: group spans do not match fields');

  const expectedStarts = { 股票: 0, 融資: 2, 融券: 8 };
  const indexInBlock = (title, field) => {
    const block = blocks.get(title);
    if (!block || block.start !== expectedStarts[title]) {
      throw new Error(`MI_MARGN: invalid group ${title}`);
    }
    const relativeIndexes = [];
    for (let index = block.start; index < block.end; index += 1) {
      if (table.fields[index] === field) relativeIndexes.push(index - block.start);
    }
    if (relativeIndexes.length !== 1) {
      throw new Error(`MI_MARGN: group ${title} must contain exactly one field ${field}`);
    }
    return block.start + relativeIndexes[0];
  };

  const indexes = {
    id: indexInBlock('股票', '代號'),
    name: indexInBlock('股票', '名稱'),
    marginBalance: indexInBlock('融資', '今日餘額'),
    shortBalance: indexInBlock('融券', '今日餘額'),
  };
  if (table.fields[0] !== '代號' || indexes.id !== 0) {
    throw new Error('MI_MARGN: fields[0] must be 代號');
  }
  return table.data.map((row) => ({
    '股票代號': String(row?.[indexes.id] ?? '').trim(),
    '股票名稱': String(row?.[indexes.name] ?? '').trim(),
    '融資今日餘額': row?.[indexes.marginBalance],
    '融券今日餘額': row?.[indexes.shortBalance],
  }));
}

export function parseTwseSblDerived(payload) {
  if (payload?.stat !== 'OK') throw new Error('TWSE_SBL: stat is not OK');
  if (!Array.isArray(payload.fields)) throw new Error('TWSE_SBL: fields is not an array');
  if (!Array.isArray(payload.groups)) throw new Error('TWSE_SBL: groups is not an array');
  if (!Array.isArray(payload.data)) throw new Error('TWSE_SBL: data is not an array');

  const blocks = new Map();
  let start = 0;
  for (const group of payload.groups) {
    if (!Number.isInteger(group?.span) || group.span <= 0) {
      throw new Error('TWSE_SBL: invalid group span');
    }
    const end = start + group.span;
    if (end > payload.fields.length) throw new Error('TWSE_SBL: group spans exceed fields');
    if (['股票', '融券', '借券賣出'].includes(group.title)) {
      if (blocks.has(group.title)) throw new Error(`TWSE_SBL: duplicate group ${group.title}`);
      blocks.set(group.title, { start, end });
    }
    start = end;
  }
  if (start !== payload.fields.length) throw new Error('TWSE_SBL: group spans do not match fields');

  const expectedStarts = { 股票: 0, 融券: 2, 借券賣出: 8 };
  for (const [title, expectedStart] of Object.entries(expectedStarts)) {
    if (blocks.get(title)?.start !== expectedStart) {
      throw new Error(`TWSE_SBL: invalid group ${title}`);
    }
  }
  const indexInBlock = (title, field) => {
    const block = blocks.get(title);
    const indexes = [];
    for (let index = block.start; index < block.end; index += 1) {
      if (payload.fields[index] === field) indexes.push(index);
    }
    if (indexes.length !== 1) {
      throw new Error(`TWSE_SBL: group ${title} must contain exactly one field ${field}`);
    }
    return indexes[0];
  };

  const indexes = {
    id: indexInBlock('股票', '代號'),
    name: indexInBlock('股票', '名稱'),
    sale: indexInBlock('借券賣出', '當日賣出'),
    balance: indexInBlock('借券賣出', '當日餘額'),
  };
  return payload.data.map((row, index) => {
    if (!Array.isArray(row) || row.length !== payload.fields.length) {
      throw new Error(`TWSE_SBL: data[${index}] width must be ${payload.fields.length}`);
    }
    return {
      SecuritiesCompanyCode: String(row[indexes.id] ?? '').trim(),
      CompanyName: String(row[indexes.name] ?? '').trim(),
      SecuritiesBorrowingBalanceOfTheMarketDay: compactNumber(row[indexes.balance]),
      SecuritiesBorrowingSaleOfTheMarketDay: compactNumber(row[indexes.sale]),
    };
  });
}

export function parseTwseT86Hist(payload) {
  if (payload?.stat !== 'OK') throw new Error('T86: stat is not OK');
  if (!Array.isArray(payload.data)) throw new Error('T86: data is not an array');
  const indexes = requiredFieldIndexes(payload.fields, T86_FIELDS, 'T86');
  return payload.data.map((row) => {
    const foreign = compactNumber(row?.[indexes.foreign]);
    const foreignDealer = compactNumber(row?.[indexes.foreignDealer]);
    return {
      id: String(row?.[indexes.id] ?? '').trim(),
      name: String(row?.[indexes.name] ?? '').trim(),
      fi: compactNumber(row?.[indexes.total]),
      ff: foreign === null || foreignDealer === null ? null : foreign + foreignDealer,
      ft: compactNumber(row?.[indexes.trust]),
      fd: compactNumber(row?.[indexes.dealer]),
    };
  });
}

export function parseTwseBwibbuHist(payload) {
  if (payload?.stat !== 'OK') throw new Error('BWIBBU_d: stat is not OK');
  if (!Array.isArray(payload.data)) throw new Error('BWIBBU_d: data is not an array');
  const indexes = requiredFieldIndexes(payload.fields, {
    id: '證券代號',
    name: '證券名稱',
    per: '本益比',
    dy: '殖利率(%)',
    pbr: '股價淨值比',
  }, 'BWIBBU_d');
  return payload.data.map((row) => ({
    Code: String(row?.[indexes.id] ?? '').trim(),
    Name: String(row?.[indexes.name] ?? '').trim(),
    PEratio: compactNumber(row?.[indexes.per]),
    PBratio: compactNumber(row?.[indexes.pbr]),
    DividendYield: compactNumber(row?.[indexes.dy]),
  }));
}

function requiredTpexLegacyTable(payload, label) {
  if (payload?.stat !== 'ok') throw new Error(`${label}: stat is not ok`);
  const table = payload?.tables?.[0];
  if (!table || !Array.isArray(table.data)) throw new Error(`${label}: tables[0] is invalid`);
  return table;
}

export function isTpexDailyQuotesTradingDay(payload) {
  return payload?.stat === 'ok'
    && Array.isArray(payload?.tables?.[0]?.data)
    && payload.tables[0].data.length > 0;
}

export function parseTpexDailyQuotesHist(payload) {
  const table = requiredTpexLegacyTable(payload, 'TPEX_DAILY_QUOTES');
  const indexes = requiredFieldIndexes(table.fields, {
    id: '代號',
    name: '名稱',
    close: '收盤',
    open: '開盤',
    high: '最高',
    low: '最低',
    volume: '成交股數',
    transactions: '成交筆數',
  }, 'TPEX_DAILY_QUOTES');
  return table.data.map((row) => ({
    SecuritiesCompanyCode: String(row?.[indexes.id] ?? '').trim(),
    CompanyName: String(row?.[indexes.name] ?? '').trim(),
    Open: compactNumber(row?.[indexes.open]),
    High: compactNumber(row?.[indexes.high]),
    Low: compactNumber(row?.[indexes.low]),
    Close: compactNumber(row?.[indexes.close]),
    TradingShares: compactNumber(row?.[indexes.volume]),
    TransactionNumber: compactNumber(row?.[indexes.transactions]),
  }));
}

export function parseTpexInstiHist(payload) {
  const table = requiredTpexLegacyTable(payload, 'TPEX_INSTI');
  if (!Array.isArray(table.fields) || table.fields.length !== 24) {
    throw new Error('TPEX_INSTI: fields length must be 24');
  }
  if (table.fields[23] !== '三大法人買賣超股數合計') {
    throw new Error('TPEX_INSTI: fields[23] must be 三大法人買賣超股數合計');
  }
  return table.data.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 24) {
      throw new Error(`TPEX_INSTI: data[${index}] width must be 24`);
    }
    return {
      SecuritiesCompanyCode: String(row[0] ?? '').trim(),
      CompanyName: String(row[1] ?? '').trim(),
      TotalDifference: compactNumber(row[23]),
      [TPEX_INSTI_FIELDS.ff]: compactNumber(row[10]),
      [TPEX_INSTI_FIELDS.ft]: compactNumber(row[13]),
      [TPEX_INSTI_FIELDS.fd]: compactNumber(row[22]),
    };
  });
}

export function parseTpexMarginHist(payload) {
  const table = requiredTpexLegacyTable(payload, 'TPEX_MARGIN');
  const indexes = requiredFieldIndexes(table.fields, {
    id: '代號',
    name: '名稱',
    marginBalance: '資餘額',
    shortBalance: '券餘額',
  }, 'TPEX_MARGIN');
  return table.data.map((row) => ({
    SecuritiesCompanyCode: String(row?.[indexes.id] ?? '').trim(),
    CompanyName: String(row?.[indexes.name] ?? '').trim(),
    MarginPurchaseBalance: compactNumber(row?.[indexes.marginBalance]),
    ShortSaleBalance: compactNumber(row?.[indexes.shortBalance]),
  }));
}

export function parseTpexSblDerived(payload) {
  const table = requiredTpexLegacyTable(payload, 'TPEX_SBL');
  const expectedFields = [
    '股票代號', '股票名稱', '前日餘額', '賣出', '買進', '現券', '當日餘額', '限額',
    '前日餘額', '當日賣出', '當日還券', '當日調整數額', '當日餘額',
    '次一營業日可借券賣出限額', '備註',
  ];
  if (!Array.isArray(table.fields) || table.fields.length !== expectedFields.length) {
    throw new Error('TPEX_SBL: fields length must be 15');
  }
  for (let index = 0; index < expectedFields.length; index += 1) {
    if (table.fields[index] !== expectedFields[index]) {
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
      SecuritiesBorrowingBalanceOfTheMarketDay: compactNumber(row[12]),
      SecuritiesBorrowingSaleOfTheMarketDay: compactNumber(row[9]),
    };
  });
}

export function parseTpexPeHist(payload) {
  const table = requiredTpexLegacyTable(payload, 'TPEX_PE');
  const indexes = requiredFieldIndexes(table.fields, {
    id: '股票代號',
    name: '公司名稱',
    per: '本益比',
    dy: '殖利率(%)',
    pbr: '股價淨值比',
  }, 'TPEX_PE');
  return table.data.map((row) => ({
    Code: String(row?.[indexes.id] ?? '').trim(),
    Name: String(row?.[indexes.name] ?? '').trim(),
    PEratio: compactNumber(row?.[indexes.per]),
    PBratio: compactNumber(row?.[indexes.pbr]),
    DividendYield: compactNumber(row?.[indexes.dy]),
  }));
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

async function readMopsMonthlyRevenueRaw(rootDir, sourceDataset, monthKey) {
  const rocMonth = `${Number(monthKey.slice(0, 4)) - 1911}${monthKey.slice(5)}`;
  const rows = [];
  let found = false;
  for (const variant of [0, 1]) {
    const path = join(
      rootDir,
      'data',
      'raw',
      sourceDataset,
      monthKey.slice(0, 4),
      `${monthKey}_${variant}.html`,
    );
    try {
      const bytes = await readFile(path);
      found = true;
      rows.push(...validateMopsMonthlyRevenueHtml(bytes, rocMonth));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return found ? rows : null;
}

async function readMopsQuarterlyFinRaw(rootDir, sourceDataset, seasonKey) {
  const path = join(
    rootDir,
    'data',
    'raw',
    sourceDataset,
    seasonKey.slice(0, 4),
    `${seasonKey}.html`,
  );
  try {
    return parseMopsQuarterlyFinHtml(await readFile(path));
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

function fundamentalSeriesFor(kind) {
  const definition = FUNDAMENTAL_SERIES[kind];
  if (!definition) throw new Error(`unknown fundamental kind: ${kind}`);
  return definition;
}

function fundamentalRows(current) {
  const result = {};
  for (const kind of Object.keys(FUNDAMENTAL_SERIES)) {
    result[kind] = current?.[kind]?.rows ?? [];
  }
  return result;
}

function fundamentalSeriesPayload(rowsByKind) {
  const result = {};
  for (const [kind, definition] of Object.entries(FUNDAMENTAL_SERIES)) {
    result[kind] = { cols: definition.cols, rows: rowsByKind[kind] };
  }
  return result;
}

function fundamentalsUpdated(rowsByKind) {
  const values = [];
  for (const [kind, definition] of Object.entries(FUNDAMENTAL_SERIES)) {
    const rows = rowsByKind[kind];
    if (definition.updatesFundamentalsUpdated && rows.length) {
      values.push(definition.updatedFromKey(rows.at(-1)[0]));
    }
  }
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
  const definition = fundamentalSeriesFor(kind);
  const path = join(rootDir, 'data', 'derived', 'fundamentals', p2(item.id), `${item.id}.json`);
  const current = await readExistingJson(path, {
    id: item.id,
    name: item.name,
    market: item.market,
    updated: null,
    ...fundamentalSeriesPayload(fundamentalRows()),
  });
  const rowsByKind = fundamentalRows(current);
  rowsByKind[kind] = upsertRows(
    rowsByKind[kind],
    row,
    window === undefined ? definition.window : window,
  );
  const incomingWinsMetadata = definition.incomingWinsMetadata
    || current.market !== 'twse'
    || item.market === 'twse';
  const next = {
    id: item.id,
    name: incomingWinsMetadata ? item.name : current.name,
    market: incomingWinsMetadata ? item.market : current.market,
    updated: fundamentalsUpdated(rowsByKind),
    ...fundamentalSeriesPayload(rowsByKind),
  };
  return writeDerivedJson(path, next);
}

async function listFundamentalPaths(rootDir) {
  const dir = join(rootDir, 'data', 'derived', 'fundamentals');
  try {
    const buckets = await readdir(dir, { withFileTypes: true });
    const paths = [];
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const files = await readdir(join(dir, bucket.name), { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith('.json')) paths.push(join(dir, bucket.name, file.name));
      }
    }
    return paths.sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function reconcileFundamentalPeriod(rootDir, kind, key, presentIds) {
  fundamentalSeriesFor(kind);
  let written = 0;
  for (const path of await listFundamentalPaths(rootDir)) {
    const current = await readExistingJson(path, null);
    if (!current || presentIds.has(String(current.id))) continue;
    const rowsByKind = fundamentalRows(current);
    const currentRows = rowsByKind[kind];
    if (!currentRows.some((row) => row[0] === key)) continue;
    rowsByKind[kind] = currentRows.filter((row) => row[0] !== key);
    if (Object.values(rowsByKind).every((rows) => rows.length === 0)) {
      await rm(path);
      written += 1;
      continue;
    }
    const next = {
      ...current,
      updated: fundamentalsUpdated(rowsByKind),
      ...fundamentalSeriesPayload(rowsByKind),
    };
    if (await writeDerivedJson(path, next)) written += 1;
  }
  return written;
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
    twseCloseOpenApi,
    twseMarginOpenApi,
    tpexIndex,
    tpexCloseOpenApi,
    tpexInstiText,
    tpexMarginOpenApi,
    twseValuationOpenApi,
    twseCloseHistRaw,
    twseT86HistRaw,
    twseMarginHistRaw,
    tpexCloseHistRaw,
    tpexInstiHistRaw,
    tpexMarginHistRaw,
    twseValuationHistRaw,
    tpexValuationHistRaw,
    twseSblRaw,
    tpexSblRaw,
  ] = await Promise.all([
    readJsonRaw(rootDir, 'twse/mi_index', isoDate),
    readJsonRaw(rootDir, 'twse/stock_day_all', isoDate),
    readJsonRaw(rootDir, 'twse/mi_margn', isoDate),
    readJsonRaw(rootDir, 'tpex/index', isoDate),
    readJsonRaw(rootDir, 'tpex/mainboard_close', isoDate),
    readTextRaw(rootDir, 'tpex/3insti', isoDate),
    readJsonRaw(rootDir, 'tpex/margin', isoDate),
    readJsonRaw(rootDir, 'twse/bwibbu_all', isoDate),
    readJsonRaw(rootDir, 'twse/mi_index_hist', isoDate),
    readJsonRaw(rootDir, 'twse/t86_hist', isoDate),
    readJsonRaw(rootDir, 'twse/mi_margn_hist', isoDate),
    readJsonRaw(rootDir, 'tpex/daily_quotes_hist', isoDate),
    readJsonRaw(rootDir, 'tpex/insti_hist', isoDate),
    readJsonRaw(rootDir, 'tpex/margin_hist', isoDate),
    readJsonRaw(rootDir, 'twse/bwibbu_hist', isoDate),
    readJsonRaw(rootDir, 'tpex/pe_hist', isoDate),
    readJsonRaw(rootDir, 'twse/sbl_hist', isoDate),
    readJsonRaw(rootDir, 'tpex/sbl_hist', isoDate),
  ]);
  const tpexClose = tpexCloseOpenApi !== null
    ? tpexCloseOpenApi
    : tpexCloseHistRaw === null ? null : parseTpexDailyQuotesHist(tpexCloseHistRaw);
  const tpexInstiOpenApi = tpexInstiText ? parseTpexInstiRows(tpexInstiText) : null;
  const tpexInsti = tpexInstiOpenApi !== null
    ? tpexInstiOpenApi
    : tpexInstiHistRaw === null ? null : parseTpexInstiHist(tpexInstiHistRaw);
  const tpexMargin = tpexMarginOpenApi !== null
    ? tpexMarginOpenApi
    : tpexMarginHistRaw === null ? null : parseTpexMarginHist(tpexMarginHistRaw);
  const twseClose = twseCloseOpenApi !== null
    ? twseCloseOpenApi
    : twseCloseHistRaw === null ? null : parseTwseMiIndexHist(twseCloseHistRaw);
  const twseMargin = twseMarginOpenApi !== null
    ? twseMarginOpenApi
    : twseMarginHistRaw === null ? null : parseTwseMiMargnHist(twseMarginHistRaw);
  const twseT86 = twseT86HistRaw === null ? null : parseTwseT86Hist(twseT86HistRaw);
  const twseValuation = twseValuationOpenApi !== null
    ? twseValuationOpenApi
    : twseValuationHistRaw === null ? null : parseTwseBwibbuHist(twseValuationHistRaw);
  const tpexValuation = tpexValuationHistRaw === null ? null : parseTpexPeHist(tpexValuationHistRaw);
  const twseSbl = twseSblRaw === null ? null : parseTwseSblDerived(twseSblRaw);
  const tpexSbl = tpexSblRaw === null ? null : parseTpexSblDerived(tpexSblRaw);

  const twseMarginById = mapBy(twseMargin, '股票代號');
  const twseT86ById = mapBy(twseT86, 'id');
  const twseSblById = mapBy(twseSbl, 'SecuritiesCompanyCode');
  const tpexMarginById = mapBy(tpexMargin, 'SecuritiesCompanyCode');
  const tpexInstiById = mapBy(tpexInsti, 'SecuritiesCompanyCode');
  const tpexSblById = mapBy(tpexSbl, 'SecuritiesCompanyCode');
  const twseIds = new Set();

  for (const row of twseClose ?? []) {
    const id = String(row?.Code ?? '').trim();
    if (!isDerivedSymbolId(id)) continue;
    twseIds.add(id);
    const [mb, ms] = balanceRow(twseMarginById.get(id), '融資今日餘額', '融券今日餘額');
    const insti = twseT86ById.get(id);
    const sbl = twseSblById.get(id);
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
      insti?.fi ?? null,
      insti?.ff ?? null,
      insti?.ft ?? null,
      insti?.fd ?? null,
      sbl?.SecuritiesBorrowingBalanceOfTheMarketDay ?? null,
      sbl?.SecuritiesBorrowingSaleOfTheMarketDay ?? null,
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
    const sbl = tpexSblById.get(id);
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
      sbl?.SecuritiesBorrowingBalanceOfTheMarketDay ?? null,
      sbl?.SecuritiesBorrowingSaleOfTheMarketDay ?? null,
    ], symbolWindow);
    if (didWrite) written.symbols += 1;
  }

  const valuationById = new Map();
  for (const source of [
    { rows: tpexValuation, market: 'tpex' },
    { rows: twseValuation, market: 'twse' },
  ]) {
    for (const row of source.rows ?? []) {
      const id = String(row?.Code ?? '').trim();
      if (!isDerivedSymbolId(id)) continue;
      valuationById.set(id, { row, market: source.market });
    }
  }
  for (const [id, { row, market }] of [...valuationById.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const didWrite = await upsertFundamental(rootDir, {
      id,
      name: row.Name ?? '',
      market,
    }, 'valuation', [
      ymd,
      compactNumber(row.PEratio),
      compactNumber(row.PBratio),
      compactNumber(row.DividendYield),
    ], DEFAULT_VALUATION_WINDOW);
    if (didWrite) written.fundamentals += 1;
  }
  if (twseValuation !== null || tpexValuation !== null) {
    written.fundamentals += await reconcileFundamentalPeriod(rootDir, 'valuation', ymd, new Set(valuationById.keys()));
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
    {
      sourceDataset: 'twse/monthly_revenue',
      histDataset: 'twse/monthly_revenue_hist',
      market: 'twse',
    },
    {
      sourceDataset: 'tpex/monthly_revenue',
      histDataset: 'tpex/monthly_revenue_hist',
      market: 'tpex',
    },
  ];
  const revenueById = new Map();
  for (const source of sources) {
    const openApiRows = await readJsonIfExists(
      join(rootDir, 'data', 'raw', source.sourceDataset, monthKey.slice(0, 4), `${monthKey}.json`),
      null,
    );
    const histRows = openApiRows === null
      ? await readMopsMonthlyRevenueRaw(rootDir, source.histDataset, monthKey)
      : null;
    const rows = openApiRows !== null ? openApiRows : histRows;
    const selectedDataset = openApiRows !== null ? source.sourceDataset : source.histDataset;
    const droppedByMonth = new Map();
    for (const row of rows ?? []) {
      const rowMonth = parseRocMonth(row?.['資料年月']);
      if (rowMonth !== monthKey) {
        const label = rowMonth ?? 'invalid';
        droppedByMonth.set(label, (droppedByMonth.get(label) ?? 0) + 1);
        continue;
      }
      const id = String(row?.['公司代號'] ?? '').trim();
      if (!isDerivedSymbolId(id)) continue;
      const current = revenueById.get(id);
      if (!current || source.market === 'twse') revenueById.set(id, { source, row });
    }
    for (const [rowMonth, count] of [...droppedByMonth.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.warn(`[warn] derived: monthly revenue dataset=${selectedDataset} monthKey=${monthKey} drops rowMonth=${rowMonth} count=${count}`);
    }
  }
  let written = await reconcileFundamentalPeriod(rootDir, 'revenue', month, new Set(revenueById.keys()));
  for (const [id, { source, row }] of [...revenueById.entries()].sort(([a], [b]) => a.localeCompare(b))) {
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
  return { fundamentals: written };
}

export async function applyQuarterlyFinancials(
  rootDir,
  seasonKey,
  { quarterlyWindow = DEFAULT_QUARTERLY_WINDOW } = {},
) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(seasonKey ?? ''));
  if (!match) throw new Error(`quarterly financials: invalid season key ${seasonKey}`);
  const year = Number(match[1]);
  const season = Number(match[2]);
  const quarterKey = year * 10 + season;
  const previousSeasonKey = season === 1 ? null : `${year}-Q${season - 1}`;
  const sources = [
    { sourceDataset: 'twse/quarterly_fin_hist', market: 'twse' },
    { sourceDataset: 'tpex/quarterly_fin_hist', market: 'tpex' },
  ];
  const quarterlyById = new Map();

  for (const source of sources) {
    const currentRows = await readMopsQuarterlyFinRaw(rootDir, source.sourceDataset, seasonKey);
    if (currentRows === null) continue;
    const previousRows = previousSeasonKey === null
      ? null
      : await readMopsQuarterlyFinRaw(rootDir, source.sourceDataset, previousSeasonKey);
    if (previousSeasonKey !== null && previousRows === null) {
      console.warn(`[warn] derived: quarterly dataset=${source.sourceDataset} seasonKey=${seasonKey} previous raw missing; skipped=${currentRows.length}`);
      continue;
    }
    const previousById = new Map((previousRows ?? []).map((row) => [row.id, row]));
    let missingPrevious = 0;
    let invalid = 0;
    for (const current of currentRows) {
      if (!isDerivedSymbolId(current.id)) continue;
      const previous = previousSeasonKey === null ? null : previousById.get(current.id);
      if (previousSeasonKey !== null && !previous) {
        missingPrevious += 1;
        continue;
      }
      const absolute = [
        current.revenue,
        current.grossProfit,
        current.operatingIncome,
        current.netIncome,
      ];
      const previousAbsolute = previous === null ? null : [
        previous.revenue,
        previous.grossProfit,
        previous.operatingIncome,
        previous.netIncome,
      ];
      if (absolute.some((value) => value === null)
        || previousAbsolute?.some((value) => value === null)) {
        invalid += 1;
        continue;
      }
      const singleQuarter = previousAbsolute === null
        ? absolute
        : absolute.map((value, index) => value - previousAbsolute[index]);
      if (singleQuarter[0] <= 0) {
        invalid += 1;
        continue;
      }
      const currentWinner = quarterlyById.get(current.id);
      if (!currentWinner || source.market === 'twse') {
        quarterlyById.set(current.id, {
          source,
          row: current,
          values: singleQuarter,
        });
      }
    }
    if (missingPrevious > 0 || invalid > 0) {
      console.warn(`[warn] derived: quarterly dataset=${source.sourceDataset} seasonKey=${seasonKey} missingPrevious=${missingPrevious} invalid=${invalid}`);
    }
  }

  let written = 0;
  for (const [id, { source, row, values }] of [...quarterlyById.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [revenue, grossProfit, operatingIncome, netIncome] = values;
    const didWrite = await upsertFundamental(rootDir, {
      id,
      name: row.name,
      market: source.market,
    }, 'quarterly', [
      quarterKey,
      round2((grossProfit / revenue) * 100),
      round2((operatingIncome / revenue) * 100),
      round2((netIncome / revenue) * 100),
    ], quarterlyWindow);
    if (didWrite) written += 1;
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
