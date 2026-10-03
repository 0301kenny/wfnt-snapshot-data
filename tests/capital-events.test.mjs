import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCapitalEvents } from '../scripts/lib/derived.mjs';

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-capital-events-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSnapshot(root, market, date, rows) {
  const dir = join(root, 'data', 'raw', market, 'company_capital', date.slice(0, 4));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${date}.json`), JSON.stringify(rows));
}

test('capital events track the last valid appearance across both market snapshot gaps', async () => {
  await withTempDir(async (root) => {
    await writeSnapshot(root, 'twse', '2026-07-01', [
      { '公司代號': '1101', '已發行普通股數或TDR原股發行股數': '100' },
      { '公司代號': '1102', '已發行普通股數或TDR原股發行股數': '200' },
      { '公司代號': '1103', '已發行普通股數或TDR原股發行股數': '300' },
      { '公司代號': '1104', '已發行普通股數或TDR原股發行股數': '400' },
      { '公司代號': '2317', '已發行普通股數或TDR原股發行股數': '500' },
      { '公司代號': '2330', '已發行普通股數或TDR原股發行股數': '1,000' },
      { '公司代號': '3008', '已發行普通股數或TDR原股發行股數': '50' },
      { '公司代號': '123456', '已發行普通股數或TDR原股發行股數': '10' },
    ]);
    await writeSnapshot(root, 'twse', '2026-07-02', [
      { '公司代號': '1101', '已發行普通股數或TDR原股發行股數': '' },
      { '公司代號': '1102', '已發行普通股數或TDR原股發行股數': '--' },
      { '公司代號': '1103', '已發行普通股數或TDR原股發行股數': '0' },
      { '公司代號': '1104', '已發行普通股數或TDR原股發行股數': '-1' },
      { '公司代號': '2317', '已發行普通股數或TDR原股發行股數': '500' },
      { '公司代號': '2330', '已發行普通股數或TDR原股發行股數': '1,100' },
      { '公司代號': '123456', '已發行普通股數或TDR原股發行股數': '20' },
    ]);
    await writeSnapshot(root, 'twse', '2026-07-03', [
      { '公司代號': '1101', '已發行普通股數或TDR原股發行股數': '90' },
      { '公司代號': '1102', '已發行普通股數或TDR原股發行股數': '210' },
      { '公司代號': '1103', '已發行普通股數或TDR原股發行股數': '310' },
      { '公司代號': '1104', '已發行普通股數或TDR原股發行股數': '390' },
      { '公司代號': '2317', '已發行普通股數或TDR原股發行股數': '500' },
      { '公司代號': '2330', '已發行普通股數或TDR原股發行股數': '1,100' },
      { '公司代號': '3008', '已發行普通股數或TDR原股發行股數': '75' },
    ]);
    await writeSnapshot(root, 'tpex', '2026-07-01', [
      { SecuritiesCompanyCode: '6488', IssueShares: '2,000' },
      { SecuritiesCompanyCode: '654321', IssueShares: '10' },
    ]);
    await writeSnapshot(root, 'tpex', '2026-07-04', [
      { SecuritiesCompanyCode: '6488', IssueShares: '1,800' },
      { SecuritiesCompanyCode: '654321', IssueShares: '20' },
    ]);

    const result = await applyCapitalEvents(root);
    assert.deepEqual(result, { capitalEvents: 7, written: true });
    assert.deepEqual(JSON.parse(await readFile(join(root, 'data', 'derived', 'capital_events.json'), 'utf8')), {
      updated: '2026-07-04',
      cols: ['id', 'from', 'to', 'before', 'after'],
      rows: [
        ['1101', 20260701, 20260703, 100, 90],
        ['1102', 20260701, 20260703, 200, 210],
        ['1103', 20260701, 20260703, 300, 310],
        ['1104', 20260701, 20260703, 400, 390],
        ['2330', 20260701, 20260702, 1000, 1100],
        ['3008', 20260701, 20260703, 50, 75],
        ['6488', 20260701, 20260704, 2000, 1800],
      ],
    });
  });
});

test('capital events do not write an output without a valid snapshot', async () => {
  await withTempDir(async (root) => {
    assert.deepEqual(await applyCapitalEvents(root), { capitalEvents: 0, written: false });
    await assert.rejects(access(join(root, 'data', 'derived', 'capital_events.json')));
  });
});
