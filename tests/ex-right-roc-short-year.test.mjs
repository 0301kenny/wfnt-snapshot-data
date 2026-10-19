import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCorporateActions } from '../scripts/lib/derived.mjs';

const TWSE_FIELDS = ['資料日期', '股票代號', '除權息前收盤價', '除權息參考價', '權/息'];
const TPEX_FIELDS = ['除權息日期', '代號', '除權息前收盤價', '除權息參考價', '權/息'];

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-ex-right-roc-short-year-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeRaw(root, market, year, raw) {
  const dir = join(root, 'data', 'raw', market, 'ex_right', String(year));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${year}.json`), JSON.stringify(raw));
}

async function readCorporateActions(root, id) {
  const path = join(root, 'data', 'derived', 'corporate_actions', id.slice(0, 2), `${id}.json`);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function applyShortAndThreeDigitFixtures(root) {
  await writeRaw(root, 'twse', 2006, {
    fields: TWSE_FIELDS,
    data: [['95年01月10日', '2330', '59.4', '54.64', '權息']],
  });
  await writeRaw(root, 'twse', 2011, {
    fields: TWSE_FIELDS,
    data: [['100年01月05日', '2330', '70', '68', '息']],
  });
  await writeRaw(root, 'tpex', 2010, {
    tables: [{ fields: TPEX_FIELDS, data: [['99/01/14', '6488', '100', '95.5', '除權']] }],
  });
  await writeRaw(root, 'tpex', 2011, {
    tables: [{ fields: TPEX_FIELDS, data: [['100/01/05', '6488', '110', '108', '除息']] }],
  });
  return applyCorporateActions(root);
}

test('TWSE corporate actions include two-digit ROC years and retain three-digit years', async () => {
  await withTempDir(async (root) => {
    assert.deepEqual(await applyShortAndThreeDigitFixtures(root), { corporateActions: 2, written: 2 });
    assert.deepEqual((await readCorporateActions(root, '2330')).rows, [
      ['2006-01-10', 59.4, 54.64, '權息'],
      ['2011-01-05', 70, 68, '息'],
    ]);
  });
});

test('TPEX corporate actions include two-digit ROC years and retain three-digit years', async () => {
  await withTempDir(async (root) => {
    assert.deepEqual(await applyShortAndThreeDigitFixtures(root), { corporateActions: 2, written: 2 });
    assert.deepEqual((await readCorporateActions(root, '6488')).rows, [
      ['2010-01-14', 100, 95.5, '權'],
      ['2011-01-05', 110, 108, '息'],
    ]);
  });
});
