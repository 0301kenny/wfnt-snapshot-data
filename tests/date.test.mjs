import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRocDate, parseTradingDate } from '../scripts/lib/date.mjs';

test('parse ROC dates in compact and slash formats', () => {
  assert.equal(parseRocDate('1150706'), '2026-07-06');
  assert.equal(parseRocDate('115/07/06'), '2026-07-06');
  assert.equal(parseRocDate('115/7/6'), '2026-07-06');
});

test('parse trading dates in ROC and Gregorian formats', () => {
  assert.equal(parseTradingDate('1150706'), '2026-07-06');
  assert.equal(parseTradingDate('20260706'), '2026-07-06');
  assert.equal(parseTradingDate('2026/07/06'), '2026-07-06');
  assert.equal(parseTradingDate('bad'), null);
});
