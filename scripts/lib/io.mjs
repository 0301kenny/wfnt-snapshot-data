import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export async function readJsonIfExists(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeFileEnsured(path, data, {
  writeFileImpl = writeFile,
  renameImpl = rename,
} = {}) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporaryPath = join(parent, `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFileImpl(temporaryPath, data);
    await renameImpl(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function listJsonDates(dir) {
  try {
    const years = await readdir(dir, { withFileTypes: true });
    const dates = [];
    for (const year of years) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const files = await readdir(join(dir, year.name), { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(file.name)) {
          dates.push(file.name.slice(0, -5));
        }
      }
    }
    return dates.sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function listCsvGzDates(dir) {
  try {
    const years = await readdir(dir, { withFileTypes: true });
    const dates = [];
    for (const year of years) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const files = await readdir(join(dir, year.name), { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && /^\d{4}-\d{2}-\d{2}\.csv\.gz$/.test(file.name)) {
          dates.push(file.name.slice(0, -7));
        }
      }
    }
    return dates.sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function listHtmlMonths(dir) {
  try {
    const years = await readdir(dir, { withFileTypes: true });
    const months = new Set();
    for (const year of years) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const files = await readdir(join(dir, year.name), { withFileTypes: true });
      for (const file of files) {
        const match = file.isFile() && /^(\d{4}-\d{2})_[01]\.html$/.exec(file.name);
        if (match) months.add(match[1]);
      }
    }
    return [...months].sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
