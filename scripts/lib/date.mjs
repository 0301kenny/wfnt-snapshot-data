const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function validIsoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function parseRocDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  let match = text.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (!match) {
    match = text.match(/^(\d{3})\/(\d{1,2})\/(\d{1,2})$/);
  }
  if (!match) return null;
  const year = Number(match[1]) + 1911;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return validIsoDate(year, month, day);
}

export function parseGregorianDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (ISO_DATE_RE.test(text)) return validIsoDate(Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10)));
  let match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) {
    match = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  }
  if (!match) return null;
  return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function parseTradingDate(value) {
  return parseRocDate(value) ?? parseGregorianDate(value);
}

export function parseRocMonth(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).trim().match(/^(\d{3})(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]) + 1911;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${year}-${pad2(month)}`;
}

export function yyyyOf(date) {
  if (!ISO_DATE_RE.test(date)) throw new Error(`invalid ISO date: ${date}`);
  return date.slice(0, 4);
}

export function maxIsoDate(dates) {
  const values = dates.filter(Boolean).sort();
  return values.length ? values.at(-1) : null;
}

export function taipeiIsoDate(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function daysBetweenIsoDates(fromDate, toDate) {
  if (!ISO_DATE_RE.test(fromDate) || !ISO_DATE_RE.test(toDate)) {
    throw new Error(`invalid ISO date range: ${fromDate}..${toDate}`);
  }
  const from = Date.UTC(Number(fromDate.slice(0, 4)), Number(fromDate.slice(5, 7)) - 1, Number(fromDate.slice(8, 10)));
  const to = Date.UTC(Number(toDate.slice(0, 4)), Number(toDate.slice(5, 7)) - 1, Number(toDate.slice(8, 10)));
  return Math.floor((to - from) / 86_400_000);
}
