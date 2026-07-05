import { maxIsoDate } from './date.mjs';

export const DATASET_KEYS = [
  'twse_mi_index',
  'twse_stock_day_all',
  'twse_mi_margn',
  'tpex_index',
  'tpex_mainboard_close',
  'tpex_3insti',
  'tpex_margin',
];

export function emptyDatasetEntry() {
  return { first: null, latest: null, days: 0, ok: false };
}

export function normalizeManifest(input) {
  const manifest = {
    schemaVersion: 1,
    generatedAt: input?.generatedAt ?? null,
    latestTradingDate: input?.latestTradingDate ?? null,
    datasets: {},
    paths: { raw: 'data/raw/{source_dataset}/{yyyy}/{date}.json' },
    archives: [],
  };
  for (const key of DATASET_KEYS) {
    manifest.datasets[key] = { ...emptyDatasetEntry(), ...(input?.datasets?.[key] ?? {}) };
    if (manifest.datasets[key].lastError === undefined) {
      delete manifest.datasets[key].lastError;
    }
  }
  return manifest;
}

export function setDatasetSuccess(manifest, key, dates) {
  const sorted = [...dates].sort();
  manifest.datasets[key] = {
    first: sorted[0] ?? null,
    latest: sorted.at(-1) ?? null,
    days: sorted.length,
    ok: sorted.length > 0,
  };
}

export function setDatasetError(manifest, key, lastError) {
  const previous = manifest.datasets[key] ?? emptyDatasetEntry();
  manifest.datasets[key] = { ...previous, ok: false, lastError };
}

export function refreshLatestTradingDate(manifest) {
  manifest.latestTradingDate = maxIsoDate(Object.values(manifest.datasets).map((entry) => entry.latest));
}

export function stableManifestString(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
