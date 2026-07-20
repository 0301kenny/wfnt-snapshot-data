import { maxIsoDate, parseGregorianDate, parseTradingDate } from './lib/date.mjs';

export const ENDPOINTS = [
  {
    key: 'twse_mi_index',
    market: 'twse',
    sourceDataset: 'twse/mi_index',
    url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',
    anchor: true,
    dateField: '日期',
    requiredFields: ['日期', '指數', '收盤指數'],
  },
  {
    key: 'twse_stock_day_all',
    market: 'twse',
    sourceDataset: 'twse/stock_day_all',
    url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    dateField: 'Date',
    preferRowDate: true,
    staleGuard: true,
    requiredFields: ['Date', 'Code', 'Name', 'TradeVolume', 'ClosingPrice'],
  },
  {
    key: 'twse_bwibbu_all',
    market: 'twse',
    sourceDataset: 'twse/bwibbu_all',
    url: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
    dateField: 'Date',
    preferRowDate: true,
    requiredFields: ['Date', 'Code', 'PEratio'],
  },
  {
    key: 'twse_mi_margn',
    market: 'twse',
    sourceDataset: 'twse/mi_margn',
    url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN',
    useAnchorDate: true,
    staleGuard: true,
    requiredFields: ['股票代號', '股票名稱', '融資買進', '融資今日餘額'],
  },
  {
    key: 'tpex_index',
    market: 'tpex',
    sourceDataset: 'tpex/index',
    url: 'https://www.tpex.org.tw/openapi/v1/tpex_index',
    anchor: true,
    dateField: 'Date',
    requiredFields: ['Date', 'Open', 'High', 'Low', 'Close'],
  },
  {
    key: 'tpex_mainboard_close',
    market: 'tpex',
    sourceDataset: 'tpex/mainboard_close',
    url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
    dateField: 'Date',
    preferRowDate: true,
    requiredFields: ['Date', 'SecuritiesCompanyCode', 'CompanyName', 'Close'],
  },
  {
    key: 'tpex_3insti',
    market: 'tpex',
    sourceDataset: 'tpex/3insti',
    url: 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading',
    dateField: 'Date',
    preferRowDate: true,
    requiredFields: ['Date', 'SecuritiesCompanyCode', 'CompanyName', 'TotalDifference'],
  },
  {
    key: 'tpex_margin',
    market: 'tpex',
    sourceDataset: 'tpex/margin',
    url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance',
    dateField: 'Date',
    preferRowDate: true,
    requiredFields: ['Date', 'SecuritiesCompanyCode', 'CompanyName', 'MarginPurchaseBalance'],
  },
  {
    key: 'twse_monthly_revenue',
    market: 'twse',
    cadence: 'monthly',
    sourceDataset: 'twse/monthly_revenue',
    url: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
    requiredFields: ['資料年月', '公司代號', '營業收入-當月營收'],
  },
  {
    key: 'tpex_monthly_revenue',
    market: 'tpex',
    cadence: 'monthly',
    sourceDataset: 'tpex/monthly_revenue',
    url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O',
    requiredFields: ['資料年月', '公司代號', '營業收入-當月營收'],
  },
  {
    key: 'tdcc',
    sourceDataset: 'tdcc',
    url: 'https://opendata.tdcc.com.tw/getOD.ashx?id=1-5',
    format: 'csv',
    accept: 'text/csv,text/plain,*/*',
    timeoutMs: 300_000,
    dateField: '資料日期',
    requiredFields: ['資料日期', '證券代號'],
  },
];

// Backfill-only TWSE and TPEX legacy endpoints. These are intentionally separate from
// ENDPOINTS so scripts/run.mjs never includes them in the daily pipeline.
export const BACKFILL_ENDPOINTS = {
  twse_mi_index_hist: {
    sourceDataset: 'twse/mi_index_hist',
    url: (ymd) => `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd}&type=ALLBUT0999&response=json`,
  },
  twse_t86_hist: {
    sourceDataset: 'twse/t86_hist',
    url: (ymd) => `https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd}&selectType=ALL&response=json`,
  },
  twse_mi_margn_hist: {
    sourceDataset: 'twse/mi_margn_hist',
    url: (ymd) => `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd}&selectType=ALL&response=json`,
  },
  tpex_daily_quotes_hist: {
    sourceDataset: 'tpex/daily_quotes_hist',
    url: (ymd) => `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}&type=EW&response=json`,
  },
  tpex_insti_hist: {
    sourceDataset: 'tpex/insti_hist',
    url: (ymd) => `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}&response=json`,
  },
  tpex_margin_hist: {
    sourceDataset: 'tpex/margin_hist',
    url: (ymd) => `https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}&response=json`,
  },
};

export function endpointByKey(key) {
  return ENDPOINTS.find((endpoint) => endpoint.key === key);
}

export function validateRows(endpoint, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: 'schema: JSON 不是非空陣列' };
  }
  const first = rows[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return { ok: false, error: 'schema: row 不是 object' };
  }
  const missing = endpoint.requiredFields.filter((field) => !(field in first));
  if (missing.length > 0) {
    return { ok: false, error: `schema: 缺少欄位 ${missing.join(',')}` };
  }
  if (endpoint.dateField && !parseTradingDate(first[endpoint.dateField])) {
    return { ok: false, error: 'schema: 日期欄不可解析' };
  }
  return { ok: true };
}

export function dateFromRows(endpoint, rows, anchorDate) {
  if (endpoint.useAnchorDate) return anchorDate;
  const parsed = endpoint.dateField
    ? maxIsoDate(rows.map((row) => parseTradingDate(row?.[endpoint.dateField])))
    : null;
  return parsed ?? anchorDate;
}

function parseCsvLine(line) {
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

export function validateTdccCsv(body) {
  if (!body || body.length === 0) {
    return { ok: false, error: 'fetch: empty body' };
  }
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  const lines = text.split(/\r\n|\n|\r/);
  const headerLine = lines.find((line) => line.length > 0);
  if (!headerLine) {
    return { ok: false, error: 'schema: CSV 無 header' };
  }
  const header = parseCsvLine(headerLine);
  if (header.length > 0) header[0] = header[0].replace(/^\uFEFF/, '');
  const missing = ['資料日期', '證券代號'].filter((field) => !header.includes(field));
  if (missing.length > 0) {
    return { ok: false, error: `schema: 缺少欄位 ${missing.join(',')}` };
  }
  const dateIndex = header.indexOf('資料日期');
  const dates = [];
  for (const line of lines.slice(lines.indexOf(headerLine) + 1)) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    dates.push(parseGregorianDate(cells[dateIndex]));
  }
  const date = maxIsoDate(dates);
  if (!date) {
    return { ok: false, error: 'schema: 日期欄不可解析' };
  }
  return { ok: true, date };
}
