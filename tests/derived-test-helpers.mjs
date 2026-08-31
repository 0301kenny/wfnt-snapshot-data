import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stableDerivedString } from '../scripts/lib/derived.mjs';

export async function writeDerived(root, relativePath, value) {
  const path = join(root, 'data', 'derived', relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableDerivedString(value));
}

export async function fileMap(dir, base = dir) {
  const result = {};
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fileMap(path, base));
    else result[path.slice(base.length + 1)] = await readFile(path);
  }
  return result;
}
