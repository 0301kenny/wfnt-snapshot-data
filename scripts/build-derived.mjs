import { createHash } from 'node:crypto';
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyCapitalEvents,
  applyCorporateActions,
  applyDailyDate,
  applyIndustryIndex,
  applyInsiderHoldingMonth,
  applyMacroSeries,
  applyMonthlyRevenue,
  applyQuarterlyFinancials,
  applyTaifexForeignFuturesMonth,
  applyTaifexPcrMonth,
  applyTaifexVixMonth,
  applyTdccWeek,
  applyTpexIndexMonth,
  buildSectorIndexForDates,
} from './lib/derived.mjs';
import { listCsvGzDates, listHtmlMonths, listJsonDates, writeFileEnsured } from './lib/io.mjs';

const BUILD_VERSION = 4;
const BUILD_DIR_NAME = '.derived-build';
const DAILY_PROGRESS_NAME = 'daily-progress.jsonl';

export const DAILY_SOURCES = [
  'twse/mi_index',
  'twse/stock_day_all',
  'twse/bwibbu_all',
  'twse/mi_margn',
  'twse/mi_index_hist',
  'twse/t86_hist',
  'twse/twt38u_hist',
  'twse/twt44u_hist',
  'twse/twt43u_hist',
  'twse/mi_margn_hist',
  'twse/bwibbu_hist',
  'twse/sbl_hist',
  'tpex/index',
  'tpex/mainboard_close',
  'tpex/3insti',
  'tpex/margin',
  'tpex/daily_quotes_hist',
  'tpex/insti_hist',
  'tpex/margin_hist',
  'tpex/pe_hist',
  'tpex/sbl_hist',
];

const MONTHLY_SOURCES = [
  { sourceDataset: 'twse/monthly_revenue', listMonths: listJsonMonths },
  { sourceDataset: 'tpex/monthly_revenue', listMonths: listJsonMonths },
  { sourceDataset: 'twse/monthly_revenue_hist', listMonths: listHtmlMonths },
  { sourceDataset: 'tpex/monthly_revenue_hist', listMonths: listHtmlMonths },
];

const INSIDER_MONTHLY_SOURCES = [
  'twse/insider_holding',
  'tpex/insider_holding',
];

const QUARTERLY_SOURCES = [
  'twse/quarterly_fin_hist',
  'tpex/quarterly_fin_hist',
];

const NON_DAILY_INPUTS = [
  'tpex/index_hist',
  'taifex/pcr',
  'taifex/foreign_futures',
  'taifex/vix_monthly',
  ...MONTHLY_SOURCES.map(({ sourceDataset }) => sourceDataset),
  ...INSIDER_MONTHLY_SOURCES,
  'twse/company_capital',
  'tpex/company_capital',
  'twse/industry_mi_index',
  'twse/ex_right',
  'tpex/ex_right',
  ...QUARTERLY_SOURCES,
  'tdcc',
  'fred',
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

async function listTaifexMonths(dir, extension) {
  try {
    const years = await readdir(dir, { withFileTypes: true });
    const months = [];
    for (const year of years) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const files = await readdir(join(dir, year.name), { withFileTypes: true });
      for (const file of files) {
        const match = file.isFile()
          && new RegExp(`^(\\d{4}-(?:0[1-9]|1[0-2]))\\.${extension}$`).exec(file.name);
        if (match && match[1].startsWith(`${year.name}-`)) months.push(match[1]);
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

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function collectDailyDates(rootDir) {
  const dates = new Set();
  for (const source of DAILY_SOURCES) {
    for (const date of await listJsonDates(join(rootDir, 'data', 'raw', source))) dates.add(date);
  }
  return [...dates].sort();
}

async function collectDailyRawState(rootDir, date) {
  const state = {};
  for (const source of DAILY_SOURCES) {
    const path = join(rootDir, 'data', 'raw', source, date.slice(0, 4), `${date}.json`);
    try {
      const metadata = await stat(path, { bigint: true });
      state[source] = {
        size: metadata.size.toString(),
        mtimeNs: metadata.mtimeNs.toString(),
        ctimeNs: metadata.ctimeNs.toString(),
        ino: metadata.ino.toString(),
      };
    } catch (error) {
      if (error.code === 'ENOENT') state[source] = null;
      else throw error;
    }
  }
  return state;
}

function sameDailyRawState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function changedCompletedDailyDates(rootDir, progress) {
  const changed = [];
  for (const date of progress.completed.daily) {
    const current = await collectDailyRawState(rootDir, date);
    if (!sameDailyRawState(current, progress.dailyRawState[date])) changed.push(date);
  }
  return changed;
}

async function assertCompletedDailyRawUnchanged(rootDir, progress, hooks) {
  await hooks?.onDailyRawFullCheck?.({ dates: [...progress.completed.daily] });
  const changed = await changedCompletedDailyDates(rootDir, progress);
  if (changed.length > 0) throw new ChangedDailyRawError(changed);
}

async function hashTree(path, hash, relative = '') {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      hash.update(`missing:${relative}\0`);
      return;
    }
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const nextRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const nextPath = join(path, entry.name);
    if (entry.isDirectory()) {
      hash.update(`dir:${nextRelative}\0`);
      await hashTree(nextPath, hash, nextRelative);
    } else if (entry.isFile()) {
      hash.update(`file:${nextRelative}\0`);
      hash.update(await readFile(nextPath));
      hash.update('\0');
    }
  }
}

async function nonDailyFingerprint(rootDir) {
  const hash = createHash('sha256');
  for (const source of NON_DAILY_INPUTS) {
    hash.update(`source:${source}\0`);
    await hashTree(join(rootDir, 'data', 'raw', source), hash);
  }
  return hash.digest('hex');
}

async function collectInputs(rootDir) {
  const rawDir = join(rootDir, 'data', 'raw');
  const monthlyMonths = new Set();
  for (const source of MONTHLY_SOURCES) {
    for (const month of await source.listMonths(join(rawDir, source.sourceDataset))) monthlyMonths.add(month);
  }
  const insiderMonths = new Set();
  for (const source of INSIDER_MONTHLY_SOURCES) {
    for (const month of await listJsonMonths(join(rawDir, source))) insiderMonths.add(month);
  }
  const quarterlySeasons = new Set();
  for (const source of QUARTERLY_SOURCES) {
    for (const season of await listHtmlSeasons(join(rawDir, source))) quarterlySeasons.add(season);
  }
  return {
    daily: await collectDailyDates(rootDir),
    tpexIndex: await listJsonMonths(join(rawDir, 'tpex', 'index_hist')),
    pcr: await listTaifexMonths(join(rawDir, 'taifex', 'pcr'), 'csv'),
    foreignFutures: await listTaifexMonths(join(rawDir, 'taifex', 'foreign_futures'), 'csv'),
    vix: await listTaifexMonths(join(rawDir, 'taifex', 'vix_monthly'), 'txt'),
    monthly: [...monthlyMonths].sort(),
    insider: [...insiderMonths].sort(),
    quarterly: [...quarterlySeasons].sort(),
    tdcc: await listCsvGzDates(join(rawDir, 'tdcc')),
  };
}

async function collectStableInputs(rootDir) {
  for (;;) {
    const before = await nonDailyFingerprint(rootDir);
    const inputs = await collectInputs(rootDir);
    const after = await nonDailyFingerprint(rootDir);
    if (before === after) return { inputs, nonDailyFingerprint: after };
  }
}

function emptyCompleted() {
  return {
    daily: [],
    sector: false,
    dailyBase: false,
    tpexIndex: [],
    pcr: [],
    foreignFutures: [],
    vix: [],
    monthly: [],
    insider: [],
    capital: false,
    industry: false,
    corporate: false,
    quarterly: [],
    tdcc: [],
    macro: false,
  };
}

function initialSummary(inputs) {
  return {
    dailyDates: inputs.daily.length,
    tpexIndexMonths: inputs.tpexIndex.length,
    taifexPcrMonths: inputs.pcr.length,
    taifexForeignFuturesMonths: inputs.foreignFutures.length,
    taifexVixMonths: inputs.vix.length,
    monthlyMonths: inputs.monthly.length,
    insiderMonths: inputs.insider.length,
    capitalEvents: 0,
    industries: 0,
    corporateActions: 0,
    quarterlySeasons: inputs.quarterly.length,
    tdccWeeks: inputs.tdcc.length,
    macroSeries: 0,
    files: 0,
  };
}

async function readProgress(path) {
  try {
    const progress = JSON.parse(await readFile(path, 'utf8'));
    if (progress.version !== BUILD_VERSION) throw new Error(`unsupported derived build progress version: ${progress.version}`);
    return progress;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveProgress(path, progress) {
  progress.updatedAt = new Date().toISOString();
  const { dailyRawState, ...persisted } = progress;
  void dailyRawState;
  persisted.completed = { ...progress.completed, daily: [] };
  await writeFileEnsured(path, `${JSON.stringify(persisted, null, 2)}\n`);
}

async function readDailyProgress(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  let validText = '';
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const entry = JSON.parse(line);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !entry.state) break;
      entries.push(entry);
      validText += `${line}\n`;
    } catch {
      break;
    }
  }
  if (validText !== text) await writeFileEnsured(path, validText);
  return entries;
}

async function hydrateDailyProgress(progress, dailyProgressPath) {
  progress.dailyRawState = {};
  progress.completed.daily = [];
  const persistedInputs = new Set(progress.inputs.daily);
  let addedInput = false;
  for (const { date, state } of await readDailyProgress(dailyProgressPath)) {
    if (!Object.hasOwn(progress.dailyRawState, date)) progress.completed.daily.push(date);
    progress.dailyRawState[date] = state;
    if (!persistedInputs.has(date)) {
      progress.inputs.daily.push(date);
      persistedInputs.add(date);
      addedInput = true;
    }
  }
  progress.completed.daily.sort();
  progress.inputs.daily.sort();
  return { addedInput };
}

async function appendDailyProgress({
  dailyProgressPath,
  progress,
  date,
  state,
  phase,
  hooks,
}) {
  const line = `${JSON.stringify({ date, state })}\n`;
  await appendFile(dailyProgressPath, line);
  progress.dailyRawState[date] = state;
  if (!progress.completed.daily.includes(date)) progress.completed.daily.push(date);
  await hooks?.onDailyProgressWrite?.({ date, bytes: Buffer.byteLength(line) });
  await hooks?.afterCheckpoint?.({ phase, item: date });
}

async function prepareBuild(rootDir, buildDir) {
  const rawDir = join(rootDir, 'data', 'raw');
  const stageRoot = join(buildDir, 'root');
  await mkdir(rawDir, { recursive: true });
  await mkdir(join(stageRoot, 'data'), { recursive: true });
  const stageRaw = join(stageRoot, 'data', 'raw');
  if (!await exists(stageRaw)) await symlink(rawDir, stageRaw, 'dir');
  await mkdir(join(stageRoot, 'data', 'derived'), { recursive: true });
  return stageRoot;
}

async function createProgress(rootDir, progressPath) {
  const stable = await collectStableInputs(rootDir);
  const { inputs } = stable;
  const progress = {
    version: BUILD_VERSION,
    startedAt: new Date().toISOString(),
    updatedAt: null,
    nonDailyFingerprint: stable.nonDailyFingerprint,
    inputs,
    completed: emptyCompleted(),
    summary: initialSummary(inputs),
    ready: false,
  };
  await saveProgress(progressPath, progress);
  return progress;
}

async function checkpoint(progressPath, progress, hooks, event) {
  await saveProgress(progressPath, progress);
  await hooks?.afterCheckpoint?.(event);
}

async function runItems({ name, items, completed, apply, progress, progressPath, hooks, rootDir }) {
  const done = new Set(completed);
  for (const item of items) {
    if (done.has(item)) continue;
    await apply(item);
    completed.push(item);
    done.add(item);
    await checkpoint(progressPath, progress, hooks, { phase: name, item });
  }
}

async function recoverDirectoryReplacement(target) {
  const next = `${target}.replace-next`;
  const previous = `${target}.replace-previous`;
  if (!await exists(target) && await exists(previous)) await rename(previous, target);
  else if (await exists(target) && await exists(previous)) {
    await rm(previous, { recursive: true, force: true });
  }
  await rm(next, { recursive: true, force: true });
}

async function replaceDirectory(source, target, hooks) {
  const next = `${target}.replace-next`;
  const previous = `${target}.replace-previous`;
  await recoverDirectoryReplacement(target);
  await rm(next, { recursive: true, force: true });
  await cp(source, next, { recursive: true });
  const hadTarget = await exists(target);
  if (hadTarget) {
    await rename(target, previous);
    await hooks?.afterSnapshotTargetMoved?.({ target, previous, next });
  }
  try {
    await rename(next, target);
  } catch (error) {
    if (!await exists(target) && await exists(previous)) await rename(previous, target);
    throw error;
  }
  if (hadTarget) await rm(previous, { recursive: true, force: true });
}

async function refreshDailyBase(stageDerived, dailyBase, hooks) {
  await replaceDirectory(stageDerived, dailyBase, hooks);
}

async function restoreDailyBase(dailyBase, stageDerived, hooks) {
  await replaceDirectory(dailyBase, stageDerived, hooks);
}

async function resetNonDailyProgress(rootDir, progress, progressPath) {
  const stable = await collectStableInputs(rootDir);
  const currentInputs = stable.inputs;
  progress.inputs = {
    ...currentInputs,
    daily: progress.inputs.daily,
  };
  progress.completed = {
    ...emptyCompleted(),
    daily: progress.completed.daily,
    sector: true,
    dailyBase: true,
  };
  progress.summary = initialSummary(progress.inputs);
  progress.nonDailyFingerprint = stable.nonDailyFingerprint;
  progress.ready = false;
  await saveProgress(progressPath, progress);
}

async function runOnce({
  rootDir,
  stageRoot,
  dailyBase,
  dailyProgressPath,
  progress,
  progressPath,
  hooks,
}) {
  const { inputs, completed, summary } = progress;
  const completedDaily = new Set(completed.daily);
  for (const date of inputs.daily) {
    if (completedDaily.has(date)) continue;
    const before = await collectDailyRawState(rootDir, date);
    await applyDailyDate(stageRoot, date, { applySectorIndex: false });
    const after = await collectDailyRawState(rootDir, date);
    if (!sameDailyRawState(before, after)) throw new ChangedDailyRawError([date]);
    await appendDailyProgress({
      dailyProgressPath,
      progress,
      date,
      state: after,
      phase: 'daily',
      hooks,
    });
    completedDaily.add(date);
  }
  await assertCompletedDailyRawUnchanged(rootDir, progress, hooks);
  if (!completed.sector) {
    await buildSectorIndexForDates(stageRoot, inputs.daily, {
      initial: null,
      onWrite: hooks?.onSectorWrite,
    });
    completed.sector = true;
    await checkpoint(progressPath, progress, hooks, { phase: 'sector', item: null });
  }
  if (!completed.dailyBase) {
    await refreshDailyBase(join(stageRoot, 'data', 'derived'), dailyBase, hooks);
    completed.dailyBase = true;
    await checkpoint(progressPath, progress, hooks, { phase: 'daily-base', item: null });
  }
  const itemStages = [
    ['tpexIndex', applyTpexIndexMonth],
    ['pcr', applyTaifexPcrMonth],
    ['foreignFutures', applyTaifexForeignFuturesMonth],
    ['vix', applyTaifexVixMonth],
    ['monthly', applyMonthlyRevenue],
    ['insider', applyInsiderHoldingMonth],
  ];
  for (const [name, apply] of itemStages) {
    await runItems({
      name,
      items: inputs[name],
      completed: completed[name],
      apply: (item) => apply(stageRoot, item),
      progress,
      progressPath,
      hooks,
      rootDir,
    });
  }
  const singletonStages = [
    ['capital', applyCapitalEvents, 'capitalEvents', 'capitalEvents'],
    ['industry', applyIndustryIndex, 'industries', 'industries'],
    ['corporate', applyCorporateActions, 'corporateActions', 'corporateActions'],
  ];
  for (const [name, apply, summaryKey, resultKey] of singletonStages) {
    if (completed[name]) continue;
    const result = await apply(stageRoot);
    summary[summaryKey] = result[resultKey];
    completed[name] = true;
    await checkpoint(progressPath, progress, hooks, { phase: name, item: null });
  }
  await runItems({
    name: 'quarterly',
    items: inputs.quarterly,
    completed: completed.quarterly,
    apply: (season) => applyQuarterlyFinancials(stageRoot, season),
    progress,
    progressPath,
    hooks,
    rootDir,
  });
  await runItems({
    name: 'tdcc',
    items: inputs.tdcc,
    completed: completed.tdcc,
    apply: (week) => applyTdccWeek(stageRoot, week),
    progress,
    progressPath,
    hooks,
    rootDir,
  });
  if (!completed.macro) {
    const macro = await applyMacroSeries(stageRoot);
    summary.macroSeries = macro.series;
    completed.macro = true;
    await checkpoint(progressPath, progress, hooks, { phase: 'macro', item: null });
  }
}

function taipeiParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function switchWindowReason(now = new Date()) {
  const parts = taipeiParts(now);
  const hour = Number(parts.hour);
  if (hour === 21) return 'Taipei daily protection window 21:00-22:00';
  if (parts.weekday === 'Sun' && hour === 10) return 'Taipei Sunday protection window 10:00-11:00';
  return null;
}

function taipeiTimestamp(now) {
  const parts = taipeiParts(now);
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
}

async function nextPreviousDir(dataDir, now) {
  const base = join(dataDir, `derived.prev-${taipeiTimestamp(now)}`);
  if (!await exists(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!await exists(candidate)) return candidate;
  }
}

async function switchDerived(rootDir, stageDerived, now) {
  const dataDir = join(rootDir, 'data');
  const active = join(dataDir, 'derived');
  let previousDir = null;
  if (await exists(active)) {
    previousDir = await nextPreviousDir(dataDir, now);
    await rename(active, previousDir);
  }
  try {
    await rename(stageDerived, active);
  } catch (error) {
    if (previousDir !== null && !await exists(active)) await rename(previousDir, active);
    throw error;
  }
  return previousDir;
}

export class OlderDailyRawError extends Error {
  constructor(dates) {
    super(`refusing derived switch: newly discovered older daily raw dates: ${dates.join(', ')}`);
    this.name = 'OlderDailyRawError';
    this.code = 'OLDER_DAILY_RAW';
    this.dates = dates;
  }
}

export class ChangedDailyRawError extends Error {
  constructor(dates) {
    super(`refusing derived switch: applied daily raw changed: ${dates.join(', ')}`);
    this.name = 'ChangedDailyRawError';
    this.code = 'CHANGED_DAILY_RAW';
    this.dates = dates;
  }
}

export class SwitchWindowError extends Error {
  constructor(reason) {
    super(`derived switch refused: ${reason}`);
    this.name = 'SwitchWindowError';
    this.code = 'SWITCH_WINDOW';
  }
}

export async function buildDerived({
  rootDir = process.cwd(),
  buildOnly = false,
  reset = false,
  protectSwitchWindow = false,
  now = () => new Date(),
  hooks = null,
} = {}) {
  rootDir = resolve(rootDir);
  const dataDir = join(rootDir, 'data');
  const buildDir = join(dataDir, BUILD_DIR_NAME);
  const progressPath = join(buildDir, 'progress.json');
  const dailyProgressPath = join(buildDir, DAILY_PROGRESS_NAME);
  if (reset) await rm(buildDir, { recursive: true, force: true });

  for (;;) {
    let progress = await readProgress(progressPath);
    const stageRootPath = join(buildDir, 'root');
    const stageDerived = join(stageRootPath, 'data', 'derived');
    const dailyBase = join(buildDir, 'daily-base');
    await recoverDirectoryReplacement(stageDerived);
    await recoverDirectoryReplacement(dailyBase);
    if (progress !== null && !await exists(stageDerived)) {
      const active = join(dataDir, 'derived');
      if (progress.ready && await exists(active)) {
        const summary = {
          ...progress.summary,
          staged: false,
          switched: true,
          previousDir: null,
          recovered: true,
        };
        await rm(buildDir, { recursive: true, force: true });
        return summary;
      }
      await rm(buildDir, { recursive: true, force: true });
      progress = null;
    }
    const stageRoot = await prepareBuild(rootDir, buildDir);
    if (progress === null) progress = await createProgress(rootDir, progressPath);
    const dailyRecovery = await hydrateDailyProgress(progress, dailyProgressPath);
    await assertCompletedDailyRawUnchanged(rootDir, progress, hooks);
    if (dailyRecovery.addedInput) {
      await restoreDailyBase(dailyBase, stageDerived, hooks);
      await resetNonDailyProgress(rootDir, progress, progressPath);
    }
    await runOnce({
      rootDir,
      stageRoot,
      dailyBase,
      dailyProgressPath,
      progress,
      progressPath,
      hooks,
    });

    const currentFingerprint = await nonDailyFingerprint(rootDir);
    if (currentFingerprint !== progress.nonDailyFingerprint) {
      await hooks?.onRestart?.({ reason: 'non-daily-raw-changed' });
      await restoreDailyBase(dailyBase, stageDerived, hooks);
      await resetNonDailyProgress(rootDir, progress, progressPath);
      continue;
    }

    const currentDaily = await collectDailyDates(rootDir);
    const completedDaily = new Set(progress.completed.daily);
    const latestApplied = progress.completed.daily.at(-1) ?? null;
    const unseen = currentDaily.filter((date) => !completedDaily.has(date));
    const older = latestApplied === null ? [] : unseen.filter((date) => date <= latestApplied);
    if (older.length > 0) throw new OlderDailyRawError(older);
    const newer = unseen.filter((date) => latestApplied === null || date > latestApplied);
    if (newer.length > 0) {
      await restoreDailyBase(dailyBase, stageDerived, hooks);
      const newerStates = {};
      for (const date of newer) {
        const before = await collectDailyRawState(rootDir, date);
        await applyDailyDate(stageRoot, date, { applySectorIndex: false });
        const after = await collectDailyRawState(rootDir, date);
        if (!sameDailyRawState(before, after)) throw new ChangedDailyRawError([date]);
        newerStates[date] = after;
      }
      await buildSectorIndexForDates(stageRoot, newer, { onWrite: hooks?.onSectorWrite });
      await refreshDailyBase(stageDerived, dailyBase, hooks);
      progress.inputs.daily.push(...newer);
      progress.inputs.daily.sort();
      for (const date of newer) {
        await appendDailyProgress({
          dailyProgressPath,
          progress,
          date,
          state: newerStates[date],
          phase: 'catchup-daily',
          hooks,
        });
      }
      await resetNonDailyProgress(rootDir, progress, progressPath);
      await hooks?.afterCheckpoint?.({ phase: 'catchup-sector', item: null });
      await assertCompletedDailyRawUnchanged(rootDir, progress, hooks);
      continue;
    }

    if (await nonDailyFingerprint(rootDir) !== progress.nonDailyFingerprint) {
      await hooks?.onRestart?.({ reason: 'non-daily-raw-changed' });
      await restoreDailyBase(dailyBase, stageDerived, hooks);
      await resetNonDailyProgress(rootDir, progress, progressPath);
      continue;
    }

    progress.summary.files = await countFiles(join(stageRoot, 'data', 'derived'));
    progress.ready = true;
    await checkpoint(progressPath, progress, hooks, { phase: 'ready', item: null });
    await hooks?.beforeSwitch?.();
    if (await nonDailyFingerprint(rootDir) !== progress.nonDailyFingerprint) {
      await hooks?.onRestart?.({ reason: 'non-daily-raw-changed' });
      await restoreDailyBase(dailyBase, stageDerived, hooks);
      await resetNonDailyProgress(rootDir, progress, progressPath);
      continue;
    }
    const finalDaily = await collectDailyDates(rootDir);
    const finalCompleted = new Set(progress.completed.daily);
    const finalLatest = progress.completed.daily.at(-1) ?? null;
    const finalUnseen = finalDaily.filter((date) => !finalCompleted.has(date));
    const finalOlder = finalLatest === null ? [] : finalUnseen.filter((date) => date <= finalLatest);
    if (finalOlder.length > 0) throw new OlderDailyRawError(finalOlder);
    if (finalUnseen.length > 0) continue;
    await assertCompletedDailyRawUnchanged(rootDir, progress, hooks);
    if (buildOnly) return { ...progress.summary, staged: true, switched: false };
    const reason = protectSwitchWindow ? switchWindowReason(now()) : null;
    if (reason !== null) throw new SwitchWindowError(reason);

    const previousDir = await switchDerived(rootDir, stageDerived, now());
    const summary = {
      ...progress.summary,
      staged: false,
      switched: true,
      previousDir,
    };
    await hooks?.afterSwitch?.(summary);
    await rm(buildDir, { recursive: true, force: true });
    return summary;
  }
}

function parseArgs(argv) {
  const args = { buildOnly: false, reset: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--build-only') args.buildOnly = true;
    else if (token === '--reset') args.reset = true;
    else if (token === '--out') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error('--out requires a directory');
      args.out = next;
      index += 1;
    } else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function summaryLine(summary) {
  return `derived daily_dates=${summary.dailyDates} tpex_index_months=${summary.tpexIndexMonths} taifex_pcr_months=${summary.taifexPcrMonths} taifex_foreign_futures_months=${summary.taifexForeignFuturesMonths} taifex_vix_months=${summary.taifexVixMonths} monthly_months=${summary.monthlyMonths} insider_months=${summary.insiderMonths} capital_events=${summary.capitalEvents} industries=${summary.industries} corporate_actions=${summary.corporateActions} quarterly_seasons=${summary.quarterlySeasons} tdcc_weeks=${summary.tdccWeeks} macro_series=${summary.macroSeries} files=${summary.files} staged=${summary.staged} switched=${summary.switched}`;
}

export async function runBuildDerivedCli(argv = process.argv.slice(2), {
  now = () => new Date(),
  stdout = console.log,
} = {}) {
  const args = parseArgs(argv);
  const summary = await buildDerived({
    rootDir: args.out === undefined ? process.cwd() : resolve(args.out),
    buildOnly: args.buildOnly,
    reset: args.reset,
    protectSwitchWindow: true,
    now,
  });
  stdout(summaryLine(summary));
  return summary;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    await runBuildDerivedCli();
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
