import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ENDPOINTS, dateFromRows, endpointByKey, validateRows, validateTdccCsv } from './endpoints.mjs';
import { daysBetweenIsoDates, parseRocMonth, taipeiIsoDate, yyyyOf } from './lib/date.mjs';
import { applyDailyDate, applyMonthlyRevenue, applyTdccWeek } from './lib/derived.mjs';
import { sha256Hex } from './lib/hash.mjs';
import { listCsvGzDates, listJsonDates, readJsonIfExists, writeFileEnsured } from './lib/io.mjs';
import {
  DATASET_KEYS,
  normalizeManifest,
  refreshLatestTradingDate,
  setDatasetError,
  setDatasetSuccess,
  stableManifestString,
} from './lib/manifest.mjs';

const RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ACCEPT = 'application/json';
const USER_AGENT = 'wfnt-snapshot-data/0.1 (+https://github.com/0301kenny/wfnt-snapshot-data)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deterministicFetchError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  return error?.message ? `fetch: ${error.message}` : 'fetch: failed';
}

async function fetchTextWithRetry(endpoint, fetcher) {
  let lastError = 'fetch: failed';
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetcher(endpoint.url, {
        signal: AbortSignal.timeout(endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: { accept: endpoint.accept ?? DEFAULT_ACCEPT, 'user-agent': USER_AGENT },
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        if (attempt < RETRIES) {
          await sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        return { ok: false, error: lastError };
      }
      const body = response.arrayBuffer
        ? Buffer.from(await response.arrayBuffer())
        : Buffer.from(await response.text(), 'utf8');
      if (body.length === 0) {
        lastError = 'fetch: empty body';
        if (attempt < RETRIES) {
          await sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        return { ok: false, error: lastError };
      }
      return { ok: true, body };
    } catch (error) {
      lastError = deterministicFetchError(error);
      if (attempt < RETRIES) await sleep(250 * 2 ** (attempt - 1));
    }
  }
  return { ok: false, error: lastError };
}

function parseJsonRows(body) {
  try {
    return { ok: true, rows: JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body) };
  } catch {
    return { ok: false, error: 'schema: JSON 不可解析' };
  }
}

function parseCli(argv) {
  const result = { datasets: null, force: false };
  for (const arg of argv) {
    if (arg === '--force') result.force = true;
    if (arg.startsWith('--datasets=')) {
      result.datasets = arg.slice('--datasets='.length).split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  if (process.env.SNAPSHOT_DATASETS) {
    result.datasets = process.env.SNAPSHOT_DATASETS.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (process.env.SNAPSHOT_FORCE === 'true' || process.env.SNAPSHOT_FORCE === '1') {
    result.force = true;
  }
  return result;
}

function selectedEndpointKeys(datasetInput) {
  if (!datasetInput || datasetInput.length === 0) return new Set(ENDPOINTS.map((endpoint) => endpoint.key));
  const unknown = datasetInput.filter((key) => !endpointByKey(key));
  if (unknown.length > 0) throw new Error(`unknown dataset(s): ${unknown.join(',')}`);
  return new Set(datasetInput);
}

const MONTHLY_KEYS = ENDPOINTS.filter((endpoint) => endpoint.cadence === 'monthly').map((endpoint) => endpoint.key);
const EXTRA_DAILY_KEYS = ENDPOINTS
  .filter((endpoint) => endpoint.market && endpoint.cadence !== 'monthly' && !DATASET_KEYS.includes(endpoint.key))
  .map((endpoint) => endpoint.key);

function normalizeSnapshotManifest(input) {
  const manifest = normalizeManifest(input);
  for (const key of EXTRA_DAILY_KEYS) {
    manifest.datasets[key] = {
      first: null,
      latest: null,
      days: 0,
      ok: false,
      ...(input?.datasets?.[key] ?? {}),
    };
  }
  for (const key of MONTHLY_KEYS) {
    manifest.datasets[key] = {
      firstMonth: null,
      latestMonth: null,
      months: 0,
      ok: false,
      ...(input?.datasets?.[key] ?? {}),
    };
  }
  manifest.paths.rawMonthly = 'data/raw/{source_dataset}/{yyyy}/{yyyy}-{mm}.json';
  manifest.paths.fundamentals = 'data/derived/fundamentals/{p2}/{id}.json';
  return manifest;
}

function rawPath(rootDir, endpoint, date) {
  return join(rootDir, 'data', 'raw', endpoint.sourceDataset, yyyyOf(date), `${date}.json`);
}

function rawTdccPath(rootDir, date) {
  return join(rootDir, 'data', 'raw', 'tdcc', yyyyOf(date), `${date}.csv.gz`);
}

function rawMonthlyPath(rootDir, endpoint, month) {
  return join(rootDir, 'data', 'raw', endpoint.sourceDataset, month.slice(0, 4), `${month}.json`);
}

async function previousRawHash(rootDir, endpoint, date) {
  const dir = join(rootDir, 'data', 'raw', endpoint.sourceDataset);
  const dates = (await listJsonDates(dir)).filter((storedDate) => storedDate < date);
  if (dates.length === 0) return null;
  const previousDate = dates.at(-1);
  const previousPath = rawPath(rootDir, endpoint, previousDate);
  return sha256Hex(await readFile(previousPath));
}

async function storedDatesForEndpoint(rootDir, endpoint) {
  return listJsonDates(join(rootDir, 'data', 'raw', endpoint.sourceDataset));
}

async function storedWeeksForTdcc(rootDir) {
  return listCsvGzDates(join(rootDir, 'data', 'raw', 'tdcc'));
}

async function storedMonthsForEndpoint(rootDir, endpoint) {
  const dir = join(rootDir, 'data', 'raw', endpoint.sourceDataset);
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

function setMonthlyDatasetSuccess(manifest, key, months) {
  const sorted = [...months].sort();
  manifest.datasets[key] = {
    firstMonth: sorted[0] ?? null,
    latestMonth: sorted.at(-1) ?? null,
    months: sorted.length,
    ok: sorted.length > 0,
  };
}

async function writeRawIfChanged(rootDir, endpoint, date, body, options) {
  const destination = rawPath(rootDir, endpoint, date);
  const bodyHash = sha256Hex(body);
  if (endpoint.staleGuard && !options.force) {
    const previousHash = await previousRawHash(rootDir, endpoint, date);
    if (previousHash && previousHash === bodyHash) {
      return { status: 'stale', path: destination };
    }
  }
  try {
    const current = await readFile(destination);
    const currentHash = sha256Hex(current);
    if (currentHash === bodyHash && !options.force) {
      return { status: 'same', path: destination };
    }
    await writeFileEnsured(destination, body);
    return { status: currentHash === bodyHash ? 'forced' : 'revise', path: destination };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFileEnsured(destination, body);
    return { status: 'write', path: destination };
  }
}

async function writeTdccRawIfChanged(rootDir, date, body, options) {
  const destination = rawTdccPath(rootDir, date);
  const bodyHash = sha256Hex(body);
  try {
    const current = gunzipSync(await readFile(destination));
    const currentHash = sha256Hex(current);
    if (currentHash === bodyHash && !options.force) {
      return { status: 'same', path: destination };
    }
    await writeFileEnsured(destination, gzipSync(body));
    return { status: currentHash === bodyHash ? 'forced' : 'revise', path: destination };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFileEnsured(destination, gzipSync(body));
    return { status: 'write', path: destination };
  }
}

async function writeMonthlyRawIfChanged(rootDir, endpoint, month, body, options) {
  const destination = rawMonthlyPath(rootDir, endpoint, month);
  const bodyHash = sha256Hex(body);
  try {
    const currentHash = sha256Hex(await readFile(destination));
    if (currentHash === bodyHash && !options.force) return { status: 'same', path: destination };
    await writeFileEnsured(destination, body);
    return { status: currentHash === bodyHash ? 'forced' : 'revise', path: destination };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFileEnsured(destination, body);
    return { status: 'write', path: destination };
  }
}

async function loadEndpoint(endpoint, fetcher) {
  const fetched = await fetchTextWithRetry(endpoint, fetcher);
  if (!fetched.ok) return fetched;
  if (endpoint.key === 'tdcc') {
    const schema = validateTdccCsv(fetched.body);
    if (!schema.ok) return schema;
    return { ok: true, body: fetched.body, date: schema.date };
  }
  const parsed = parseJsonRows(fetched.body);
  if (!parsed.ok) return parsed;
  const schema = validateRows(endpoint, parsed.rows);
  if (!schema.ok) return schema;
  return { ok: true, body: fetched.body, rows: parsed.rows };
}

function shouldSkipFreshTdcc(manifest, { force, explicitTdcc, today }) {
  if (force || explicitTdcc) return false;
  const latestWeek = manifest.datasets.tdcc?.latestWeek;
  if (!latestWeek) return false;
  return daysBetweenIsoDates(latestWeek, today) <= 7;
}

async function writeGithubOutput(rootDir, summary) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = [
    `commit_message=${summary.commitMessage}`,
    `changed=${summary.changed ? 'true' : 'false'}`,
    `trading_date=${summary.tradingDate ?? ''}`,
  ];
  await appendFile(outputPath, `${lines.join('\n')}\n`);
}

function countByMarket(results, market) {
  const scoped = results.filter((result) => result.market === market && result.cadence !== 'monthly');
  return `${scoped.filter((result) => result.ok).length}/${scoped.length}`;
}

function commitMessage(results, changedDates) {
  const revised = results.filter((result) => result.status === 'revise');
  const changedTdcc = results.filter((result) => result.key === 'tdcc' && ['write', 'revise', 'forced'].includes(result.status));
  const dailyChangedDates = results
    .filter((result) => result.market && result.cadence !== 'monthly' && ['write', 'revise', 'forced'].includes(result.status))
    .map((result) => result.date)
    .sort();
  const tradingDate = dailyChangedDates.at(-1) ?? null;
  const tdccDate = changedTdcc.map((result) => result.date).sort().at(-1) ?? null;
  if (revised.length > 0) {
    const reviseDate = [...changedDates].filter(Boolean).sort().at(-1) ?? tdccDate;
    return `revise: ${reviseDate} [${revised.map((result) => result.key === 'tdcc' ? 'tdcc' : `${result.market}:${result.key.replace(`${result.market}_`, '')}`).join(',')}]`;
  }
  const changedMonthly = results.filter((result) => result.cadence === 'monthly' && ['write', 'forced'].includes(result.status));
  if (!tradingDate && changedMonthly.length > 0) {
    return `snapshot(monthly): ${changedMonthly.map((result) => `${result.key}:${result.month}`).join(',')}`;
  }
  if (!tradingDate && tdccDate) return `snapshot(tdcc): ${tdccDate}`;
  if (!tradingDate) return 'snapshot: no-op';
  const changed = results.filter((result) => ['write', 'forced'].includes(result.status));
  const dailyResults = results.filter((result) => result.market && result.cadence !== 'monthly');
  const dailyChanged = changed.filter((result) => result.market && result.cadence !== 'monthly');
  const retry = dailyChanged.length < dailyResults.filter((result) => result.ok).length ? ' retry' : '';
  const scoped = dailyResults.length === ENDPOINTS.filter((endpoint) => endpoint.market && endpoint.cadence !== 'monthly').length
    ? `[twse ${countByMarket(results, 'twse')}, tpex ${countByMarket(results, 'tpex')}]`
    : `[${dailyChanged.map((result) => `${result.market}:${result.key.replace(`${result.market}_`, '')}`).join(',')}]`;
  const tdccSuffix = tdccDate ? ` + tdcc:${tdccDate}` : '';
  return `snapshot: ${tradingDate}${retry} ${scoped}${tdccSuffix}`;
}

export async function runSnapshot({
  rootDir = process.cwd(),
  fetcher = globalThis.fetch,
  datasets = null,
  force = false,
  now = () => new Date(),
} = {}) {
  const selected = selectedEndpointKeys(datasets);
  const explicitTdcc = datasets?.includes('tdcc') ?? false;
  const manifestPath = join(rootDir, 'data', 'manifest.json');
  const oldManifestString = stableManifestString(normalizeSnapshotManifest(await readJsonIfExists(manifestPath, {})));
  const manifest = normalizeSnapshotManifest(JSON.parse(oldManifestString));
  const endpointsToWrite = ENDPOINTS.filter((endpoint) => selected.has(endpoint.key));
  const dailyEndpointsToWrite = endpointsToWrite.filter((endpoint) => endpoint.market && endpoint.cadence !== 'monthly');
  const monthlyEndpointsToWrite = endpointsToWrite.filter((endpoint) => endpoint.cadence === 'monthly');
  const tdccEndpoint = endpointsToWrite.find((endpoint) => endpoint.key === 'tdcc') ?? null;
  const markets = [...new Set(dailyEndpointsToWrite.map((endpoint) => endpoint.market))];
  const anchors = new Map();
  const results = [];
  let anchorsFailed = 0;

  for (const market of markets) {
    const anchor = ENDPOINTS.find((endpoint) => endpoint.market === market && endpoint.anchor);
    const loaded = await loadEndpoint(anchor, fetcher);
    if (!loaded.ok) {
      anchorsFailed += 1;
      const marketError = loaded.error === 'schema: 日期欄不可解析' ? loaded.error : `anchor: ${loaded.error}`;
      for (const endpoint of dailyEndpointsToWrite.filter((item) => item.market === market)) {
        const error = endpoint.key === anchor.key ? loaded.error : marketError;
        setDatasetError(manifest, endpoint.key, error);
        results.push({ key: endpoint.key, market, ok: false, error });
      }
      console.log(`[abort] ${market} anchor failed: ${loaded.error}`);
      continue;
    }
    const anchorDate = dateFromRows(anchor, loaded.rows, null);
    if (!anchorDate) {
      anchorsFailed += 1;
      for (const endpoint of endpointsToWrite.filter((item) => item.market === market)) {
        setDatasetError(manifest, endpoint.key, 'schema: 日期欄不可解析');
        results.push({ key: endpoint.key, market, ok: false, error: 'schema: 日期欄不可解析' });
      }
      console.log(`[abort] ${market} anchor date parse failed`);
      continue;
    }
    anchors.set(market, { endpoint: anchor, loaded, date: anchorDate });
  }

  for (const endpoint of dailyEndpointsToWrite) {
    if (!anchors.has(endpoint.market)) continue;
    const anchor = anchors.get(endpoint.market);
    const loaded = endpoint.anchor ? anchor.loaded : await loadEndpoint(endpoint, fetcher);
    if (!loaded.ok) {
      setDatasetError(manifest, endpoint.key, loaded.error);
      results.push({ key: endpoint.key, market: endpoint.market, ok: false, error: loaded.error });
      console.log(`[fail] ${endpoint.key}: ${loaded.error}`);
      continue;
    }
    const date = dateFromRows(endpoint, loaded.rows, anchor.date);
    if (!date) {
      setDatasetError(manifest, endpoint.key, 'schema: 日期欄不可解析');
      results.push({ key: endpoint.key, market: endpoint.market, ok: false, error: 'schema: 日期欄不可解析' });
      console.log(`[fail] ${endpoint.key}: schema: 日期欄不可解析`);
      continue;
    }
    if (date !== anchor.date) {
      console.log(`[warn] ${endpoint.key}: row date ${date} != ${endpoint.market} anchor ${anchor.date}`);
    }
    const writeResult = await writeRawIfChanged(rootDir, endpoint, date, loaded.body, { force });
    if (writeResult.status === 'stale') {
      results.push({ key: endpoint.key, market: endpoint.market, ok: true, status: 'stale', date });
      console.log(`[stale] ${endpoint.key}: hash equals previous trading day, skip ${date}`);
      continue;
    }
    const storedDates = await storedDatesForEndpoint(rootDir, endpoint);
    setDatasetSuccess(manifest, endpoint.key, storedDates);
    results.push({ key: endpoint.key, market: endpoint.market, ok: true, status: writeResult.status, date });
    console.log(`[${writeResult.status}] ${endpoint.key}: ${date}`);
  }

  for (const endpoint of monthlyEndpointsToWrite) {
    const loaded = await loadEndpoint(endpoint, fetcher);
    if (!loaded.ok) {
      setDatasetError(manifest, endpoint.key, loaded.error);
      results.push({ key: endpoint.key, market: endpoint.market, cadence: 'monthly', ok: false, error: loaded.error });
      console.log(`[fail] ${endpoint.key}: ${loaded.error}`);
      continue;
    }
    const months = loaded.rows.map((row) => parseRocMonth(row?.['資料年月'])).filter(Boolean).sort();
    const month = months.at(-1) ?? null;
    if (!month) {
      const error = 'schema: 資料年月欄不可解析';
      setDatasetError(manifest, endpoint.key, error);
      results.push({ key: endpoint.key, market: endpoint.market, cadence: 'monthly', ok: false, error });
      console.log(`[fail] ${endpoint.key}: ${error}`);
      continue;
    }
    const writeResult = await writeMonthlyRawIfChanged(rootDir, endpoint, month, loaded.body, { force });
    const storedMonths = await storedMonthsForEndpoint(rootDir, endpoint);
    setMonthlyDatasetSuccess(manifest, endpoint.key, storedMonths);
    results.push({
      key: endpoint.key,
      market: endpoint.market,
      cadence: 'monthly',
      ok: true,
      status: writeResult.status,
      month,
    });
    console.log(`[${writeResult.status}] ${endpoint.key}: ${month}`);
  }

  if (tdccEndpoint) {
    const today = taipeiIsoDate(now());
    if (shouldSkipFreshTdcc(manifest, { force, explicitTdcc, today })) {
      results.push({ key: 'tdcc', ok: true, status: 'skip', date: manifest.datasets.tdcc.latestWeek });
      console.log(`[skip] tdcc: latestWeek ${manifest.datasets.tdcc.latestWeek} is within 7 days of ${today}`);
    } else {
      const loaded = await loadEndpoint(tdccEndpoint, fetcher);
      if (!loaded.ok) {
        setDatasetError(manifest, 'tdcc', loaded.error);
        results.push({ key: 'tdcc', ok: false, error: loaded.error });
        console.log(`[fail] tdcc: ${loaded.error}`);
      } else {
        const writeResult = await writeTdccRawIfChanged(rootDir, loaded.date, loaded.body, { force });
        const storedWeeks = await storedWeeksForTdcc(rootDir);
        setDatasetSuccess(manifest, 'tdcc', storedWeeks);
        results.push({ key: 'tdcc', ok: true, status: writeResult.status, date: loaded.date });
        console.log(`[${writeResult.status}] tdcc: ${loaded.date}`);
      }
    }
  }

  const changedDailyDatesForDerived = new Set(
    results
      .filter((result) => result.market && result.cadence !== 'monthly' && ['write', 'revise', 'forced'].includes(result.status))
      .map((result) => result.date),
  );
  const changedMonthsForDerived = new Set(
    results
      .filter((result) => result.cadence === 'monthly' && ['write', 'revise', 'forced'].includes(result.status))
      .map((result) => result.month),
  );
  const changedTdccWeeksForDerived = results
    .filter((result) => result.key === 'tdcc' && ['write', 'revise', 'forced'].includes(result.status))
    .map((result) => result.date);
  for (const date of [...changedDailyDatesForDerived].sort()) {
    const derived = await applyDailyDate(rootDir, date);
    console.log(`[derived] daily ${date}: symbols=${derived.symbols} fundamentals=${derived.fundamentals} market=${derived.market ? 'write' : 'same'}`);
  }
  for (const month of [...changedMonthsForDerived].sort()) {
    const derived = await applyMonthlyRevenue(rootDir, month);
    console.log(`[derived] monthly ${month}: fundamentals=${derived.fundamentals}`);
  }
  for (const date of changedTdccWeeksForDerived.sort()) {
    const derived = await applyTdccWeek(rootDir, date);
    console.log(`[derived] tdcc ${date}: files=${derived.tdcc}`);
  }

  refreshLatestTradingDate(manifest);
  const changedDates = new Set(results
    .filter((result) => ['write', 'revise', 'forced'].includes(result.status))
    .map((result) => result.date ?? result.month));
  let newManifestString = stableManifestString(manifest);
  if (newManifestString !== oldManifestString) {
    manifest.generatedAt = now().toISOString().replace(/\.\d{3}Z$/, 'Z');
    refreshLatestTradingDate(manifest);
    newManifestString = stableManifestString(manifest);
    await writeFileEnsured(manifestPath, newManifestString);
  }
  const successful = results.filter((result) => result.ok).length;
  const exitCode = ((markets.length > 0 && anchorsFailed === markets.length) || successful === 0) ? 1 : 0;
  const summary = {
    changed: newManifestString !== oldManifestString || changedDates.size > 0,
    commitMessage: commitMessage(results, changedDates),
    tradingDate: manifest.latestTradingDate,
    results,
    exitCode,
  };
  await writeGithubOutput(rootDir, summary);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseCli(process.argv.slice(2));
    const summary = await runSnapshot(options);
    console.log(`commit_message=${summary.commitMessage}`);
    process.exit(summary.exitCode);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exit(1);
  }
}
