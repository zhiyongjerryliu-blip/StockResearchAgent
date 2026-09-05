import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import { ingestFutuBars, ingestFutuTicks } from '../src/intraday-flow.js';
import {
  analyzeCapitalBehavior, CAPITAL_BEHAVIOR_MODEL_VERSION,
  getCapitalBehaviorOverview, runCapitalBehaviorBacktest, saveCapitalBehavior
} from '../src/capital-behavior.js';

function businessDates(start, count) {
  const dates = [];
  const date = new Date(`${start}T00:00:00.000Z`);
  while (dates.length < count) {
    if (![0, 6].includes(date.getUTCDay())) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

function seedTrend(db, ticker, direction = 1, count = 120) {
  const dates = businessDates('2026-01-02', count);
  dates.forEach((tradeDate, index) => {
    const close = 100 * ((direction > 0 ? 1.02 : 0.98) ** index);
    saveManualPrice(db, {
      ticker, tradeDate,
      open: close * (direction > 0 ? 0.99 : 1.01),
      high: close * 1.012, low: close * 0.988, close,
      volume: 1_000_000 + (index * 12_000)
    });
  });
  return dates;
}

test('连续资金模型识别持续吸筹并幂等生成多周期验证账本', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'BUILD' });
  const dates = seedTrend(db, 'BUILD', 1);
  const first = runCapitalBehaviorBacktest(db, 'BUILD', dates.at(-1), { maxSessions: 120 });
  const second = runCapitalBehaviorBacktest(db, 'BUILD', dates.at(-1), { maxSessions: 120 });
  const overview = getCapitalBehaviorOverview(db, 'BUILD', dates.at(-1));

  assert.ok(['ACCUMULATION', 'ACCELERATED_ACCUMULATION'].includes(first.latest.stage));
  assert.equal(first.latest.direction, 'BULLISH');
  assert.equal(first.validationRowsUpdated, 600);
  assert.ok(second.datesProcessed <= 5);
  assert.ok(second.validationRowsUpdated < 600);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM capital_behavior_snapshots
    WHERE ticker = 'BUILD' AND model_version = ?
  `).get(CAPITAL_BEHAVIOR_MODEL_VERSION).count, 120);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM capital_behavior_validation
    WHERE ticker = 'BUILD' AND model_version = ?
  `).get(CAPITAL_BEHAVIOR_MODEL_VERSION).count, 600);
  assert.equal(overview.history.length, 20);
  assert.equal(overview.reliability.length, 5);
  assert.ok(overview.reliability.find((row) => row.horizonDays === 1).directionAccuracy > 0.9);
  assert.equal(overview.reliability.find((row) => row.horizonDays === 1).status, 'PUBLISHED');
  db.close();
});

test('连续资金模型识别持续派发且最大有利不利变动按看空方向计算', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'EXIT' });
  const dates = seedTrend(db, 'EXIT', -1);
  const result = runCapitalBehaviorBacktest(db, 'EXIT', dates.at(-1), { maxSessions: 120 });
  const validation = db.prepare(`
    SELECT * FROM capital_behavior_validation
    WHERE ticker = 'EXIT' AND horizon_days = 5 AND status = 'MATURED'
    ORDER BY signal_as_of DESC LIMIT 1
  `).get();

  assert.ok(['DISTRIBUTION', 'ACCELERATED_DISTRIBUTION'].includes(result.latest.stage));
  assert.equal(result.latest.direction, 'BEARISH');
  assert.equal(validation.direction_hit, 1);
  assert.ok(validation.maximum_favorable_excursion > 0);
  assert.ok(validation.maximum_adverse_excursion <= 0);
  db.close();
});

test('存在富途逐笔时合并主动成交方向和VWAP证据', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'FUTU' });
  const dates = seedTrend(db, 'FUTU', 1, 45);
  for (const date of dates.slice(0, -1)) saveCapitalBehavior(db, 'FUTU', date);
  const tradeDate = dates.at(-1);
  const bars = [];
  const ticks = [];
  for (let index = 0; index < 12; index += 1) {
    const minute = `09:${String(30 + index).padStart(2, '0')}`;
    bars.push({
      ticker: 'FUTU', barTimeEt: `${tradeDate} ${minute}:00`, tradeDate,
      open: 120 + index, high: 121 + index, low: 119 + index, close: 120.8 + index,
      volume: 1000, turnover: (120.5 + index) * 1000, isFinal: true, session: 'RTH'
    });
    ticks.push({
      ticker: 'FUTU', sequence: String(index), tradeTimeEt: `${tradeDate} ${minute}:10`, tradeDate,
      price: 121 + index, volume: 500, turnover: (121 + index) * 500,
      direction: 'BUY', tradeType: 'AUTO_MATCH', session: 'RTH'
    });
  }
  ingestFutuBars(db, bars);
  ingestFutuTicks(db, ticks);

  const analysis = analyzeCapitalBehavior(db, 'FUTU', tradeDate);
  assert.equal(analysis.dataLevel, 'DAILY_AND_FUTU_TICK');
  assert.ok(analysis.intradayFlowScore > 0);
  assert.ok(Number.isFinite(analysis.priceVsVwap));
  assert.ok(analysis.evidence.find((item) => item.key === 'activeFlow').available);
  assert.match(analysis.explanation, /不能确认机构或最终账户身份/);
  db.close();
});
