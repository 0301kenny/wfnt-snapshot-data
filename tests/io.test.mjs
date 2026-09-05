import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileEnsured } from '../scripts/lib/io.mjs';

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wfnt-io-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function temporaryFiles(root) {
  return (await readdir(root)).filter((name) => name.includes('.tmp-'));
}

test('writeFileEnsured atomically publishes the exact requested bytes', async (t) => {
  await withTempDir(async (root) => {
    const target = join(root, 'nested', 'snapshot.json');
    const expected = Buffer.from(' {"raw":true}\r\n', 'utf8');
    await writeFileEnsured(target, expected);
    const actual = await readFile(target);
    const leftovers = await temporaryFiles(join(root, 'nested'));
    assert.deepEqual(actual, expected);
    assert.deepEqual(leftovers, []);
    t.diagnostic(`SUCCESS_BYTES_EQUAL=${actual.equals(expected)} TEMP_FILES=${JSON.stringify(leftovers)}`);
  });
});

test('interrupted atomic write preserves an existing target and removes its partial temp file', async (t) => {
  await withTempDir(async (root) => {
    const target = join(root, 'snapshot.json');
    const original = Buffer.from('original bytes\n', 'utf8');
    await writeFile(target, original);
    let temporaryPath;
    await assert.rejects(writeFileEnsured(target, Buffer.from('replacement bytes\n'), {
      writeFileImpl: async (path, data) => {
        temporaryPath = path;
        await writeFile(path, Buffer.from(data).subarray(0, 4));
        throw new Error('fixture interrupted write');
      },
    }), /fixture interrupted write/);
    const after = await readFile(target);
    const leftovers = await temporaryFiles(root);
    assert.equal(temporaryPath.startsWith(`${root}/`), true);
    assert.deepEqual(after, original);
    assert.deepEqual(leftovers, []);
    t.diagnostic(`EXISTING_TARGET_BYTES_UNCHANGED=${after.equals(original)} TEMP_SAME_DIR=${temporaryPath.startsWith(`${root}/`)} TEMP_FILES=${JSON.stringify(leftovers)}`);
  });
});

test('interrupted atomic write leaves an absent target absent and removes its partial temp file', async (t) => {
  await withTempDir(async (root) => {
    const target = join(root, 'snapshot.json');
    await assert.rejects(writeFileEnsured(target, Buffer.from('new bytes\n'), {
      writeFileImpl: async (path, data) => {
        await writeFile(path, Buffer.from(data).subarray(0, 4));
        throw new Error('fixture interrupted write');
      },
    }), /fixture interrupted write/);
    await assert.rejects(access(target), { code: 'ENOENT' });
    const leftovers = await temporaryFiles(root);
    assert.deepEqual(leftovers, []);
    t.diagnostic(`ABSENT_TARGET_REMAINS_ABSENT=true TEMP_FILES=${JSON.stringify(leftovers)}`);
  });
});
