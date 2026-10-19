import test from 'node:test';
import assert from 'node:assert/strict';
import { daysBetweenIsoDates, parseRocDate, parseTradingDate, taipeiIsoDate } from '../scripts/lib/date.mjs';

test('parse ROC dates in compact and slash formats', () => {
  assert.equal(parseRocDate('1150706'), '2026-07-06');
  assert.equal(parseRocDate('115/07/06'), '2026-07-06');
  assert.equal(parseRocDate('115/7/6'), '2026-07-06');
});

test('parse two-digit ROC years in slash dates', () => {
  assert.equal(parseRocDate('99/01/14'), '2010-01-14');
  assert.equal(parseRocDate('99/02/30'), null);
  assert.equal(parseTradingDate('99/01/14'), '2010-01-14');
});

test('two-digit ROC year support does not expand compact dates', () => {
  assert.equal(parseRocDate('990114'), null);
  assert.equal(parseRocDate('0990114'), '2010-01-14');
});

test('parse trading dates in ROC and Gregorian formats', () => {
  assert.equal(parseTradingDate('1150706'), '2026-07-06');
  assert.equal(parseTradingDate('20260706'), '2026-07-06');
  assert.equal(parseTradingDate('2026/07/06'), '2026-07-06');
  assert.equal(parseTradingDate('bad'), null);
});

test('taipei date helpers support tdcc freshness checks', () => {
  assert.equal(taipeiIsoDate(new Date('2026-07-04T16:30:00Z')), '2026-07-05');
  assert.equal(daysBetweenIsoDates('2026-07-04', '2026-07-11'), 7);
  assert.equal(daysBetweenIsoDates('2026-07-04', '2026-07-12'), 8);
});
