// 一次性資料操作腳本：把既有的借券 raw 逐日回放進 derived。
// TICKET-223 merge 後，applyDailyDate 只處理被呼叫的日期，因此磁碟上既有的
// sbl_hist 日期不會自動取得 sb/ss 值。本腳本走 canonical 的 applyDailyDate
// 路徑逐日回放，不發任何網路請求，不使用高成本的 build-derived。
//
// 可中斷、可續跑：進度記在 data/.sbl-replay-progress.json（data/ 已 gitignore）。
// 重跑時自動跳過已完成的日期；applyDailyDate 本身冪等，重跑同一天結果相同。

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyDailyDate } from './lib/derived.mjs';

const ROOT = process.cwd();
const PROGRESS = join(ROOT, 'data', '.sbl-replay-progress.json');
const REPORT_EVERY = 20;

async function collectDates() {
  const dates = new Set();
  for (const market of ['twse', 'tpex']) {
    const base = join(ROOT, 'data', 'raw', market, 'sbl_hist');
    for (const year of await readdir(base, { withFileTypes: true })) {
      if (!year.isDirectory()) continue;
      for (const file of await readdir(join(base, year.name), { withFileTypes: true })) {
        if (file.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(file.name)) {
          dates.add(file.name.slice(0, -5));
        }
      }
    }
  }
  return [...dates].sort();
}

async function loadProgress() {
  try {
    const parsed = JSON.parse(await readFile(PROGRESS, 'utf8'));
    return new Set(Array.isArray(parsed.done) ? parsed.done : []);
  } catch {
    return new Set();
  }
}

async function saveProgress(done, failures) {
  const payload = {
    done: [...done].sort(),
    failures,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(PROGRESS, `${JSON.stringify(payload, null, 2)}\n`);
}

function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

const all = await collectDates();
const done = await loadProgress();
const todo = all.filter((date) => !done.has(date));
const failures = [];

console.log(`[replay] 總計 ${all.length} 天（${all[0]} ~ ${all.at(-1)}）`);
console.log(`[replay] 已完成 ${done.size} 天，本次要跑 ${todo.length} 天`);

if (todo.length === 0) {
  console.log('[replay] 全部已完成，無事可做。');
  process.exit(0);
}

const started = Date.now();
let index = 0;

for (const date of todo) {
  index += 1;
  try {
    const result = await applyDailyDate(ROOT, date);
    done.add(date);
    if (index % REPORT_EVERY === 0 || index === todo.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = elapsed / index;
      const remain = (todo.length - index) * rate;
      console.log(
        `[replay] ${index}/${todo.length} 完成 ${date} symbols=${result.symbols}`
        + ` | 已耗 ${fmt(elapsed)} 平均 ${rate.toFixed(1)}s/天 預估剩餘 ${fmt(remain)}`,
      );
      await saveProgress(done, failures);
    }
  } catch (error) {
    // 單日失敗不中斷整批；記錄後繼續，最後統一回報。
    failures.push({ date, error: String(error?.message ?? error) });
    console.error(`[replay][error] ${date}: ${error?.message ?? error}`);
    await saveProgress(done, failures);
  }
}

await saveProgress(done, failures);

const total = (Date.now() - started) / 1000;
console.log(`[replay] 結束：成功 ${done.size}/${all.length}，本次耗時 ${fmt(total)}`);
if (failures.length > 0) {
  console.log(`[replay] 失敗 ${failures.length} 天：`);
  for (const item of failures) console.log(`  ${item.date}: ${item.error}`);
  process.exit(1);
}
console.log('[replay] 零失敗。');
process.exit(0);
