import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRegularUsTradingDay,
  nextRegularUsTradingDate,
  previousRegularUsTradingDate
} from '../src/trading-calendar.js';

test('周一的上一美股交易日是周五', () => {
  assert.equal(previousRegularUsTradingDate('2026-08-31'), '2026-08-28');
});

test('美股法定休市日不会被当成前一交易日', () => {
  assert.equal(isRegularUsTradingDay('2026-09-07'), false);
  assert.equal(previousRegularUsTradingDate('2026-09-08'), '2026-09-04');
  assert.equal(previousRegularUsTradingDate('2026-04-06'), '2026-04-02');
});

test('休市日录入的交易归入下一个美股交易日', () => {
  assert.equal(nextRegularUsTradingDate('2026-08-16'), '2026-08-17');
  assert.equal(nextRegularUsTradingDate('2026-09-07'), '2026-09-08');
});
