import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDerived,
  OlderDailyRawError,
  SwitchWindowError,
} from '../scripts/build-derived.mjs';
import { applyDailyDate } from '../scripts/lib/derived.mjs';

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-derived-staged-'));
  await mkdir(join(root, 'data', 'raw'), { recursive: true });
  return root;
}

async function writeJson(root, dataset, date, value) {
  const dir = join(root, 'data', 'raw', dataset, date.slice(0, 4));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${date}.json`), JSON.stringify(value));
}

function sectorRows(date, value = Number(date.slice(-2))) {
  return [{ '指數': '半導體類指數', '收盤指數': String(value) }];
}

async function writeDaily(root, date, value) {
  await writeJson(root, 'twse/mi_index', date, sectorRows(date, value));
}

async function seedActive(root, text = 'old-active') {
  await mkdir(join(root, 'data', 'derived'), { recursive: true });
  await writeFile(join(root, 'data', 'derived', 'sentinel.txt'), text);
}

async function treeBytes(dir, prefix = '') {
  const result = {};
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await treeBytes(path, relative));
    else if (entry.isFile()) result[relative] = (await readFile(path)).toString('base64');
  }
  return result;
}

async function makeDailyFixture(count) {
  const root = await tempRoot();
  const start = Date.UTC(2026, 0, 1);
  const dates = [];
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    dates.push(date);
    await writeDaily(root, date, index + 1);
  }
  return { root, dates };
}

async function expectedFromFixture(count) {
  const fixture = await makeDailyFixture(count);
  await buildDerived({ rootDir: fixture.root });
  return fixture;
}

test('daily interruption preserves active bytes, resumes identically, and skips completed dates', async () => {
  const interrupted = await makeDailyFixture(4);
  const uninterrupted = await expectedFromFixture(4);
  try {
    await seedActive(interrupted.root);
    const activeBefore = await treeBytes(join(interrupted.root, 'data', 'derived'));
    await assert.rejects(buildDerived({
      rootDir: interrupted.root,
      hooks: {
        afterCheckpoint({ phase, item }) {
          if (phase === 'daily' && item === interrupted.dates[1]) throw new Error('daily-stop');
        },
      },
    }), /daily-stop/);
    assert.deepEqual(await treeBytes(join(interrupted.root, 'data', 'derived')), activeBefore);

    const resumedDaily = [];
    await buildDerived({
      rootDir: interrupted.root,
      hooks: {
        afterCheckpoint({ phase, item }) {
          if (phase === 'daily') resumedDaily.push(item);
        },
      },
    });
    assert.deepEqual(resumedDaily, interrupted.dates.slice(2));
    assert.deepEqual(
      await treeBytes(join(interrupted.root, 'data', 'derived')),
      await treeBytes(join(uninterrupted.root, 'data', 'derived')),
    );
    const previous = (await readdir(join(interrupted.root, 'data')))
      .find((name) => name.startsWith('derived.prev-'));
    assert.ok(previous);
    assert.deepEqual(await treeBytes(join(interrupted.root, 'data', previous)), activeBefore);
  } finally {
    await rm(interrupted.root, { recursive: true, force: true });
    await rm(uninterrupted.root, { recursive: true, force: true });
  }
});

test('interruption after a non-daily stage resumes to uninterrupted bytes', async () => {
  const interrupted = await makeDailyFixture(2);
  const uninterrupted = await expectedFromFixture(2);
  try {
    await assert.rejects(buildDerived({
      rootDir: interrupted.root,
      hooks: { afterCheckpoint: ({ phase }) => { if (phase === 'capital') throw new Error('capital-stop'); } },
    }), /capital-stop/);
    await buildDerived({ rootDir: interrupted.root });
    assert.deepEqual(
      await treeBytes(join(interrupted.root, 'data', 'derived')),
      await treeBytes(join(uninterrupted.root, 'data', 'derived')),
    );
  } finally {
    await rm(interrupted.root, { recursive: true, force: true });
    await rm(uninterrupted.root, { recursive: true, force: true });
  }
});

test('interruption after catch-up and before switch resumes without daily work', async () => {
  const fixture = await makeDailyFixture(3);
  try {
    await seedActive(fixture.root);
    await assert.rejects(buildDerived({
      rootDir: fixture.root,
      hooks: { beforeSwitch: () => { throw new Error('pre-switch-stop'); } },
    }), /pre-switch-stop/);
    const daily = [];
    await buildDerived({
      rootDir: fixture.root,
      hooks: { afterCheckpoint: ({ phase, item }) => { if (phase === 'daily') daily.push(item); } },
    });
    assert.deepEqual(daily, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('interruption after the rename is recognized as a completed switch on rerun', async () => {
  const fixture = await makeDailyFixture(2);
  try {
    await seedActive(fixture.root);
    await assert.rejects(buildDerived({
      rootDir: fixture.root,
      hooks: { afterSwitch: () => { throw new Error('post-switch-stop'); } },
    }), /post-switch-stop/);
    const switchedBytes = await treeBytes(join(fixture.root, 'data', 'derived'));
    assert.ok(switchedBytes['sector_index.json']);
    const recovered = await buildDerived({ rootDir: fixture.root });
    assert.equal(recovered.recovered, true);
    assert.deepEqual(await treeBytes(join(fixture.root, 'data', 'derived')), switchedBytes);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a newer daily raw date appearing during build is included by catch-up', async () => {
  const fixture = await makeDailyFixture(2);
  try {
    const newer = '2026-01-05';
    let added = false;
    await buildDerived({
      rootDir: fixture.root,
      hooks: {
        async afterCheckpoint({ phase, item }) {
          if (!added && phase === 'daily' && item === fixture.dates[1]) {
            added = true;
            await writeDaily(fixture.root, newer, 50);
          }
        },
      },
    });
    const sector = JSON.parse(await readFile(join(fixture.root, 'data', 'derived', 'sector_index.json')));
    assert.deepEqual(sector.series['半導體類指數'].rows.at(-1), [20260105, 50]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a newly discovered older date refuses switching and leaves active and staged bytes unchanged', async () => {
  const root = await tempRoot();
  try {
    await writeDaily(root, '2026-01-02', 2);
    await writeDaily(root, '2026-01-04', 4);
    await seedActive(root);
    const activeBefore = await treeBytes(join(root, 'data', 'derived'));
    let added = false;
    await assert.rejects(buildDerived({
      rootDir: root,
      hooks: {
        async afterCheckpoint({ phase, item }) {
          if (!added && phase === 'daily' && item === '2026-01-04') {
            added = true;
            await writeDaily(root, '2026-01-03', 3);
          }
        },
      },
    }), (error) => error instanceof OlderDailyRawError && error.dates[0] === '2026-01-03');
    const stagedBefore = await treeBytes(join(root, 'data', '.derived-build', 'root', 'data', 'derived'));
    await assert.rejects(buildDerived({ rootDir: root }), OlderDailyRawError);
    assert.deepEqual(await treeBytes(join(root, 'data', 'derived')), activeBefore);
    assert.deepEqual(
      await treeBytes(join(root, 'data', '.derived-build', 'root', 'data', 'derived')),
      stagedBefore,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('monthly raw added during build restarts staging and equals a from-zero rebuild', async () => {
  const changed = await makeDailyFixture(2);
  const clean = await makeDailyFixture(2);
  const monthRows = [{
    '資料年月': '11501',
    '公司代號': '2330',
    '公司名稱': '台積電',
    '營業收入-當月營收': '100',
    '營業收入-去年同月增減(%)': '2',
    '營業收入-上月比較增減(%)': '1',
  }];
  const addMonthly = (root) => writeJson(root, 'twse/monthly_revenue', '2026-01', monthRows);
  try {
    await addMonthly(clean.root);
    await buildDerived({ rootDir: clean.root });
    let added = false;
    let restarts = 0;
    await buildDerived({
      rootDir: changed.root,
      hooks: {
        async afterCheckpoint({ phase, item }) {
          if (!added && phase === 'daily' && item === changed.dates[1]) {
            added = true;
            await addMonthly(changed.root);
          }
        },
        onRestart() { restarts += 1; },
      },
    });
    assert.equal(restarts, 1);
    assert.deepEqual(
      await treeBytes(join(changed.root, 'data', 'derived')),
      await treeBytes(join(clean.root, 'data', 'derived')),
    );
  } finally {
    await rm(changed.root, { recursive: true, force: true });
    await rm(clean.root, { recursive: true, force: true });
  }
});

test('both protected CLI windows retain progress and an allowed rerun switches without daily redo', async () => {
  const fixture = await makeDailyFixture(3);
  try {
    let dailyCount = 0;
    const hooks = { afterCheckpoint: ({ phase }) => { if (phase === 'daily') dailyCount += 1; } };
    await assert.rejects(buildDerived({
      rootDir: fixture.root,
      protectSwitchWindow: true,
      now: () => new Date('2026-10-19T13:30:00Z'),
      hooks,
    }), SwitchWindowError);
    assert.equal(dailyCount, 3);
    dailyCount = 0;
    await assert.rejects(buildDerived({
      rootDir: fixture.root,
      protectSwitchWindow: true,
      now: () => new Date('2026-10-25T02:30:00Z'),
      hooks,
    }), SwitchWindowError);
    assert.equal(dailyCount, 0);
    await buildDerived({
      rootDir: fixture.root,
      protectSwitchWindow: true,
      now: () => new Date('2026-10-19T04:00:00Z'),
      hooks,
    });
    assert.equal(dailyCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('three switches in one Taipei minute preserve three distinct previous directories', async () => {
  const fixture = await makeDailyFixture(1);
  const fixedNow = () => new Date('2026-10-19T04:34:00Z');
  try {
    await seedActive(fixture.root, 'version-0');
    const before = [];
    for (let run = 0; run < 3; run += 1) {
      before.push(await treeBytes(join(fixture.root, 'data', 'derived')));
      await buildDerived({ rootDir: fixture.root, now: fixedNow });
      if (run < 2) await writeDaily(fixture.root, `2026-01-0${run + 2}`, run + 2);
    }
    const previous = (await readdir(join(fixture.root, 'data')))
      .filter((name) => name.startsWith('derived.prev-202610191234'))
      .sort();
    assert.deepEqual(previous, [
      'derived.prev-202610191234',
      'derived.prev-202610191234-2',
      'derived.prev-202610191234-3',
    ]);
    for (let index = 0; index < previous.length; index += 1) {
      assert.deepEqual(await treeBytes(join(fixture.root, 'data', previous[index])), before[index]);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('F-221 writes sector output once for 10 and 40 days and matches incremental bytes', async () => {
  for (const count of [10, 40]) {
    const bulk = await makeDailyFixture(count);
    const incremental = await makeDailyFixture(count);
    try {
      let sectorWrites = 0;
      await buildDerived({
        rootDir: bulk.root,
        hooks: { onSectorWrite: () => { sectorWrites += 1; } },
      });
      for (const date of incremental.dates) await applyDailyDate(incremental.root, date);
      assert.equal(sectorWrites, 1, `${count} days`);
      assert.deepEqual(
        await readFile(join(bulk.root, 'data', 'derived', 'sector_index.json')),
        await readFile(join(incremental.root, 'data', 'derived', 'sector_index.json')),
      );
    } finally {
      await rm(bulk.root, { recursive: true, force: true });
      await rm(incremental.root, { recursive: true, force: true });
    }
  }
});

test('--reset discards only staged progress and starts daily work from the first date', async () => {
  const fixture = await makeDailyFixture(3);
  try {
    await seedActive(fixture.root);
    await assert.rejects(buildDerived({
      rootDir: fixture.root,
      hooks: {
        afterCheckpoint({ phase, item }) {
          if (phase === 'daily' && item === fixture.dates[0]) throw new Error('stop');
        },
      },
    }), /stop/);
    const activeBefore = await treeBytes(join(fixture.root, 'data', 'derived'));
    const daily = [];
    await buildDerived({
      rootDir: fixture.root,
      reset: true,
      buildOnly: true,
      hooks: { afterCheckpoint: ({ phase, item }) => { if (phase === 'daily') daily.push(item); } },
    });
    assert.deepEqual(daily, fixture.dates);
    assert.deepEqual(await treeBytes(join(fixture.root, 'data', 'derived')), activeBefore);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
