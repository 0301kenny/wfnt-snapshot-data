import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyDailyDate, applyMonthlyRevenue, applyQuarterlyFinancials, applyTdccWeek } from './lib/derived.mjs';
import { listCsvGzDates, listHtmlMonths, listJsonDates } from './lib/io.mjs';

const DAILY_SOURCES = [
  'twse/mi_index',
  'twse/stock_day_all',
  'twse/bwibbu_all',
  'twse/mi_margn',
  'twse/mi_index_hist',
  'twse/t86_hist',
  'twse/mi_margn_hist',
  'twse/bwibbu_hist',
  'tpex/index',
  'tpex/mainboard_close',
  'tpex/3insti',
  'tpex/margin',
  'tpex/daily_quotes_hist',
  'tpex/insti_hist',
  'tpex/margin_hist',
  'tpex/pe_hist',
];

const MONTHLY_SOURCES = [
  { sourceDataset: 'twse/monthly_revenue', listMonths: listJsonMonths },
  { sourceDataset: 'tpex/monthly_revenue', listMonths: listJsonMonths },
  { sourceDataset: 'twse/monthly_revenue_hist', listMonths: listHtmlMonths },
  { sourceDataset: 'tpex/monthly_revenue_hist', listMonths: listHtmlMonths },
];

const QUARTERLY_SOURCES = [
  'twse/quarterly_fin_hist',
  'tpex/quarterly_fin_hist',
];

async function listJsonMonths(dir) {
  try {
    const years = await readdir(dir, { withFileTypes: true });
    const months = [];
    for (const year of years) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const files = await readdir(join(dir, year.name), { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && /^\d{4}-\d{2}\.json$/.test(file.name)) months.push(file.name.slice(0, -5));
      }
    }
    return months.sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listHtmlSeasons(dir) {
  try {
    const years = await readdir(dir, { withFileTypes: true });
    const seasons = [];
    for (const year of years) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const files = await readdir(join(dir, year.name), { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && /^\d{4}-Q[1-4]\.html$/.test(file.name)) seasons.push(file.name.slice(0, -5));
      }
    }
    return seasons.sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function countFiles(dir) {
  try {
    let count = 0;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) count += await countFiles(path);
      else if (entry.isFile()) count += 1;
    }
    return count;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function buildDerived({ rootDir = process.cwd() } = {}) {
  const derivedDir = join(rootDir, 'data', 'derived');
  await rm(derivedDir, { recursive: true, force: true });

  const dailyDates = new Set();
  for (const source of DAILY_SOURCES) {
    for (const date of await listJsonDates(join(rootDir, 'data', 'raw', source))) {
      dailyDates.add(date);
    }
  }
  const sortedDailyDates = [...dailyDates].sort();
  for (const date of sortedDailyDates) {
    await applyDailyDate(rootDir, date);
  }

  const monthlyMonths = new Set();
  for (const source of MONTHLY_SOURCES) {
    for (const month of await source.listMonths(join(rootDir, 'data', 'raw', source.sourceDataset))) {
      monthlyMonths.add(month);
    }
  }
  const sortedMonthlyMonths = [...monthlyMonths].sort();
  for (const month of sortedMonthlyMonths) {
    await applyMonthlyRevenue(rootDir, month);
  }

  const quarterlySeasons = new Set();
  for (const source of QUARTERLY_SOURCES) {
    for (const season of await listHtmlSeasons(join(rootDir, 'data', 'raw', source))) {
      quarterlySeasons.add(season);
    }
  }
  const sortedQuarterlySeasons = [...quarterlySeasons].sort();
  for (const season of sortedQuarterlySeasons) {
    await applyQuarterlyFinancials(rootDir, season);
  }

  const weeks = await listCsvGzDates(join(rootDir, 'data', 'raw', 'tdcc'));
  for (const week of weeks) {
    await applyTdccWeek(rootDir, week);
  }

  const files = await countFiles(derivedDir);
  return {
    dailyDates: sortedDailyDates.length,
    monthlyMonths: sortedMonthlyMonths.length,
    quarterlySeasons: sortedQuarterlySeasons.length,
    tdccWeeks: weeks.length,
    files,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const summary = await buildDerived();
    console.log(`derived daily_dates=${summary.dailyDates} monthly_months=${summary.monthlyMonths} quarterly_seasons=${summary.quarterlySeasons} tdcc_weeks=${summary.tdccWeeks} files=${summary.files}`);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exit(1);
  }
}
