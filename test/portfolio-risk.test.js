import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, nowIso } from '../src/db.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import {
  calculatePortfolioRisk, PORTFOLIO_RISK_VERSION, savePortfolioRisk
} from '../src/portfolio-risk.js';

function businessDates(start, count) {
  const dates = [];
  const date = new Date(`${start}T00:00:00.000Z`);
  while (dates.length < count) {
    if (![0, 6].includes(date.getUTCDay())) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

function seedPrices(db, ticker, base, slope) {
  const dates = businessDates('2026-06-01', 70);
  dates.forEach((tradeDate, index) => {
    const close = base + (index * slope);
    saveManualPrice(db, {
      ticker, tradeDate, open: close - 1, high: close + 2,
      low: close - 2, close, volume: 1_000_000
    });
  });
  return dates;
}

test('组合风险识别集中度、行业暴露和官方风险且不会给出自动交易数量', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAA' });
  upsertWatchlistItem(db, { ticker: 'BBB' });
  db.prepare("UPDATE securities SET sector = 'Technology' WHERE ticker IN ('AAA','BBB')").run();
  seedPrices(db, 'AAA', 100, 1.5);
  seedPrices(db, 'BBB', 50, 0.25);
  addTransaction(db, { ticker: 'AAA', side: 'BUY', tradeTime: '2026-06-01', quantity: 10, price: 100 });
  addTransaction(db, { ticker: 'BBB', side: 'BUY', tradeTime: '2026-06-01', quantity: 10, price: 50 });
  const timestamp = nowIso();
  const eventDate = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO research_events (
      event_key, ticker, event_date, event_type, title, summary, severity,
      source_type, source_id, evidence_json, status, detected_at, updated_at
    ) VALUES (
      'bbb-official-risk', 'BBB', ?, 'SEC_8K_ITEM_3_01', '上市资格风险',
      '官方风险测试', 'P1', 'SEC_8K', 'filing-1', '[]', 'ACTIVE', ?, ?
    )
  `).run(eventDate, timestamp, timestamp);

  const risk = calculatePortfolioRisk(db);
  const aaa = risk.positions.find((item) => item.ticker === 'AAA');
  const bbb = risk.positions.find((item) => item.ticker === 'BBB');

  assert.equal(risk.positionCount, 2);
  assert.ok(risk.largestPositionWeight > 0.35);
  assert.equal(risk.largestSectorWeight, 1);
  assert.ok(Number.isFinite(risk.averageCorrelation));
  assert.equal(aaa.recommendation.action, 'REDUCE_CONCENTRATION_REVIEW');
  assert.equal(bbb.recommendation.action, 'EXIT_RISK_REVIEW');
  assert.equal('quantity' in aaa.recommendation, false);
  assert.match(risk.boundaries.join(' '), /不执行交易/);

  savePortfolioRisk(db, eventDate);
  savePortfolioRisk(db, eventDate);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portfolio_risk_snapshots
    WHERE as_of = ? AND model_version = ?
  `).get(eventDate, PORTFOLIO_RISK_VERSION).count, 1);
  db.close();
});
