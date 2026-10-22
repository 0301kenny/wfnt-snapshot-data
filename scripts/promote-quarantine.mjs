import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rawPath } from './backfill.mjs';
import {
  acquireHistoryBackfillLock,
  validateHistoryBackfillBytes,
} from './lib/history-backfill.mjs';

const DATASETS = [
  'twse/t86_hist',
  'twse/sbl_hist',
  'tpex/insti_hist',
];
const DATASET_SET = new Set(DATASETS);
const ISO_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

export function parsePromoteQuarantineArgs(argv) {
  const datasets = [];
  let dryRun = false;
  let rootDir;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (token !== '--dataset' && token !== '--out') {
      throw new Error(`unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${token} requires a value`);
    }
    index += 1;
    if (token === '--dataset') datasets.push(value);
    else rootDir = value;
  }
  const selected = datasets.length === 0 ? DATASETS : [...new Set(datasets)];
  for (const dataset of selected) {
    if (!DATASET_SET.has(dataset)) throw new Error(`unsupported dataset: ${dataset}`);
  }
  return {
    datasets: selected,
    dryRun,
    rootDir: resolve(rootDir ?? process.cwd()),
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBytesIfExists(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function listJsonFiles(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonFiles(child));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(child);
  }
  return files;
}

async function publishExclusive(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    if (sha256(await readFile(temporaryPath)) !== sha256(bytes)) {
      throw new Error(`temporary write hash mismatch: ${path}`);
    }
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    if (sha256(await readFile(path)) !== sha256(bytes)) {
      await rm(path, { force: true });
      throw new Error(`published raw hash mismatch: ${path}`);
    }
    return true;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function emptyCounts() {
  return { copied: 0, identical: 0, validationFailed: 0, conflicts: 0, writeFailed: 0 };
}

export async function promoteQuarantine({
  rootDir = process.cwd(),
  datasets = DATASETS,
  dryRun = false,
  logger = console,
  now = () => new Date(),
  processKill = process.kill.bind(process),
} = {}) {
  rootDir = resolve(rootDir);
  const lock = await acquireHistoryBackfillLock(rootDir, { logger, now, processKill });
  if (!lock.acquired) return { status: 'LOCKED', exitCode: 1, datasets: {} };
  const summaries = {};
  try {
    for (const dataset of datasets) {
      if (!DATASET_SET.has(dataset)) throw new Error(`unsupported dataset: ${dataset}`);
      const counts = emptyCounts();
      summaries[dataset] = counts;
      const quarantineRoot = join(rootDir, 'data', 'history-backfill', 'quarantine', dataset);
      for (const quarantineFile of await listJsonFiles(quarantineRoot)) {
        const match = ISO_FILE_RE.exec(basename(quarantineFile));
        const iso = match?.[1];
        let bytes;
        try {
          bytes = await readFile(quarantineFile);
          const validation = iso
            ? validateHistoryBackfillBytes(dataset, bytes, iso)
            : { kind: 'quarantined' };
          if (validation.kind !== 'valid') {
            counts.validationFailed += 1;
            continue;
          }
        } catch (error) {
          counts.validationFailed += 1;
          logger.error?.(`[promote-quarantine] validation failed file=${quarantineFile}: ${error.message}`);
          continue;
        }

        const destination = rawPath(rootDir, dataset, iso);
        let existing;
        try {
          existing = await readBytesIfExists(destination);
        } catch (error) {
          counts.writeFailed += 1;
          logger.error?.(`[promote-quarantine] raw read failed file=${destination}: ${error.message}`);
          continue;
        }
        if (existing) {
          if (existing.equals(bytes)) counts.identical += 1;
          else counts.conflicts += 1;
          continue;
        }
        if (dryRun) {
          counts.copied += 1;
          continue;
        }
        try {
          if (await publishExclusive(destination, bytes)) {
            counts.copied += 1;
          } else {
            const raced = await readFile(destination);
            if (raced.equals(bytes)) counts.identical += 1;
            else counts.conflicts += 1;
          }
        } catch (error) {
          counts.writeFailed += 1;
          logger.error?.(`[promote-quarantine] raw write failed file=${destination}: ${error.message}`);
        }
      }
      logger.log(
        `[promote-quarantine] dataset=${dataset} copied=${counts.copied}`
        + ` identical=${counts.identical} validation_failed=${counts.validationFailed}`
        + ` conflicts=${counts.conflicts}${dryRun ? ' dry_run=true' : ''}`,
      );
    }
  } finally {
    await lock.release();
  }
  const failed = Object.values(summaries)
    .some((counts) => counts.conflicts > 0 || counts.writeFailed > 0);
  return { status: failed ? 'FAILED' : 'DONE', exitCode: failed ? 1 : 0, datasets: summaries };
}

async function main() {
  const options = parsePromoteQuarantineArgs(process.argv.slice(2));
  const result = await promoteQuarantine(options);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
