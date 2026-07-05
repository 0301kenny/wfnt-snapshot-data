import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readJsonIfExists(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeFileEnsured(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
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
