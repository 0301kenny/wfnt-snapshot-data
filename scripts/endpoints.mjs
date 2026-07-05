import { maxIsoDate, parseTradingDate } from './lib/date.mjs';

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
];

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
