import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyDailyDate, applyTdccWeek } from './lib/derived.mjs';
import { listCsvGzDates, listJsonDates } from './lib/io.mjs';

const DAILY_SOURCES = [
  'twse/mi_index',
  'twse/stock_day_all',
  'twse/mi_margn',
  'tpex/index',
  'tpex/mainboard_close',
  'tpex/3insti',
  'tpex/margin',
];

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

  const weeks = await listCsvGzDates(join(rootDir, 'data', 'raw', 'tdcc'));
  for (const week of weeks) {
    await applyTdccWeek(rootDir, week);
  }

  const files = await countFiles(derivedDir);
  return { dailyDates: sortedDailyDates.length, tdccWeeks: weeks.length, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const summary = await buildDerived();
    console.log(`derived daily_dates=${summary.dailyDates} tdcc_weeks=${summary.tdccWeeks} files=${summary.files}`);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exit(1);
  }
}
