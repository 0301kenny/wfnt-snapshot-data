import './date.test.mjs';
import './cli-flags.test.mjs';
import './run.test.mjs';
import './io.test.mjs';
import './backfill.test.mjs';
import './gaps.test.mjs';
import './monthly-backfill.test.mjs';
import './quarterly-backfill.test.mjs';
import './twse-weighted-index.test.mjs';
import './fred.test.mjs';
import './taifex-pcr.test.mjs';
import './taifex-foreign-futures.test.mjs';
import './taifex-vix.test.mjs';
import './taifex-current-month.test.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test('every test module is imported by the test barrel', async () => {
  const barrelPath = fileURLToPath(import.meta.url);
  const testFiles = (await readdir(dirname(barrelPath), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => entry.name)
    .sort();
  const source = await readFile(barrelPath, 'utf8');
  const imported = new Set(
    [...source.matchAll(/^import ['"]\.\/([^'"]+\.test\.mjs)['"];?$/gm)]
      .map((match) => match[1]),
  );
  const missing = testFiles.filter((file) => !imported.has(file));
  assert.deepEqual(missing, [], `test modules missing from tests/all.mjs: ${missing.join(',')}`);
});
