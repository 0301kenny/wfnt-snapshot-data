import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyDailyDate, applyMonthlyRevenue, applyTdccWeek } from './lib/derived.mjs';
import { listCsvGzDates, listJsonDates } from './lib/io.mjs';

const DAILY_SOURCES = [
  'twse/mi_index',
  'twse/stock_day_all',
  'twse/bwibbu_all',
  'twse/mi_margn',
  'twse/mi_index_hist',
  'twse/t86_hist',
  'twse/mi_margn_hist',
  'tpex/index',
  'tpex/mainboard_close',
  'tpex/3insti',
  'tpex/margin',
];

const MONTHLY_SOURCES = ['twse/monthly_revenue', 'tpex/monthly_revenue'];

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
    for (const month of await listJsonMonths(join(rootDir, 'data', 'raw', source))) monthlyMonths.add(month);
  }
  const sortedMonthlyMonths = [...monthlyMonths].sort();
  for (const month of sortedMonthlyMonths) {
    await applyMonthlyRevenue(rootDir, month);
  }

  const weeks = await listCsvGzDates(join(rootDir, 'data', 'raw', 'tdcc'));
  for (const week of weeks) {
    await applyTdccWeek(rootDir, week);
  }

  const files = await countFiles(derivedDir);
  return { dailyDates: sortedDailyDates.length, monthlyMonths: sortedMonthlyMonths.length, tdccWeeks: weeks.length, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const summary = await buildDerived();
    console.log(`derived daily_dates=${summary.dailyDates} monthly_months=${summary.monthlyMonths} tdcc_weeks=${summary.tdccWeeks} files=${summary.files}`);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exit(1);
  }
}
