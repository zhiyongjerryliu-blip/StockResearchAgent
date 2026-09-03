import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import {
  analyzeCapitalFlow, CAPITAL_FLOW_MODEL_VERSION, listCapitalFlowHistory,
  listRecentCapitalFlowDays, notifyVolumeAnomalies, saveCapitalFlow
} from '../src/capital-flow.js';
import { ingestFutuTicks } from '../src/intraday-flow.js';

function seedTrend(db, ticker, direction = 1, count = 45) {
  const start = new Date('2026-06-01T00:00:00.000Z');
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    const close = direction > 0 ? 100 + index : 200 - index;
    saveManualPrice(db, {
      ticker,
      tradeDate: date.toISOString().slice(0, 10),
      open: close - direction,
      high: direction > 0 ? close + 0.2 : close + 2,
      low: direction > 0 ? close - 2 : close - 0.2,
      close,
      volume: 1000 + (index * 30)
    });
  }
}

test('日线量价模型识别连续放量上涨的建仓迹象', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'FLOW' });
  seedTrend(db, 'FLOW', 1);
  const result = analyzeCapitalFlow(db, 'FLOW', '2026-07-15');
  assert.equal(result.signal, 'STRONG_ACCUMULATION');
  assert.ok(result.score >= 50);
  assert.ok(result.confidence <= 72);
  assert.equal(result.dataLevel, 'DAILY_PROXY');
  assert.ok(result.metrics.cmf20 > 0);
  assert.ok(result.metrics.directionalNotionalRatio20d > 0);
  assert.match(result.explanation, /不能确认交易账户身份/);
  db.close();
});

test('日线量价模型识别连续放量下跌的派发迹象', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'SELL' });
  seedTrend(db, 'SELL', -1);
  const result = analyzeCapitalFlow(db, 'SELL', '2026-07-15');
  assert.equal(result.signal, 'STRONG_DISTRIBUTION');
  assert.ok(result.score <= -50);
  assert.ok(result.metrics.cmf20 < 0);
  assert.ok(result.metrics.directionalNotionalRatio20d < 0);
  db.close();
});

test('资金行为快照按股票日期和模型版本幂等保存且不读取未来行情', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'SAFE' });
  seedTrend(db, 'SAFE', 1, 30);
  saveManualPrice(db, {
    ticker: 'SAFE', tradeDate: '2026-08-01', open: 1, high: 2, low: 0.5, close: 1, volume: 99_000
  });
  const first = saveCapitalFlow(db, 'SAFE', '2026-06-30');
  saveCapitalFlow(db, 'SAFE', '2026-06-30');
  assert.equal(first.priceDate, '2026-06-30');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM capital_flow_snapshots
    WHERE ticker = 'SAFE' AND as_of = '2026-06-30' AND model_version = ?
  `).get(CAPITAL_FLOW_MODEL_VERSION).count, 1);
  assert.equal(listCapitalFlowHistory(db, 'SAFE').length, 1);
  db.close();
});

test('成交量与资金行为明细直接列出最近10个交易日且按日期倒序', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEN' });
  seedTrend(db, 'TEN', 1, 15);
  ingestFutuTicks(db, [
    { ticker: 'TEN', sequence: '1', tradeTimeEt: '2026-06-15 09:30:01', tradeDate: '2026-06-15', price: 10, volume: 100, turnover: 1000, direction: 'BUY' },
    { ticker: 'TEN', sequence: '2', tradeTimeEt: '2026-06-15 09:30:02', tradeDate: '2026-06-15', price: 10, volume: 20, turnover: 200, direction: 'SELL' },
    { ticker: 'TEN', sequence: '1', tradeTimeEt: '2026-06-14 09:30:01', tradeDate: '2026-06-14', price: 10, volume: 10, turnover: 100, direction: 'BUY' },
    { ticker: 'TEN', sequence: '2', tradeTimeEt: '2026-06-14 09:30:02', tradeDate: '2026-06-14', price: 10, volume: 90, turnover: 900, direction: 'SELL' }
  ]);
  const rows = listRecentCapitalFlowDays(db, 'TEN', '2026-06-15', 10);
  assert.equal(rows.length, 10);
  assert.equal(rows[0].priceDate, '2026-06-15');
  assert.equal(rows.at(-1).priceDate, '2026-06-06');
  assert.ok(rows.every((row) => Number.isFinite(row.close)));
  assert.ok(rows.every((row) => Number.isFinite(row.volume)));
  assert.equal(new Set(rows.map((row) => row.priceDate)).size, 10);
  assert.equal(rows[0].activeBuyTurnover, 1000);
  assert.equal(rows[0].activeSellTurnover, 200);
  assert.equal(rows[0].netActiveTurnover, 800);
  assert.equal(rows[0].activeFlowDirection, 'INFLOW');
  assert.equal(rows[1].netActiveTurnover, -800);
  assert.equal(rows[1].activeFlowDirection, 'OUTFLOW');
  assert.equal(rows[2].netActiveTurnover, null);
  assert.equal(rows[2].activeFlowDataLevel, 'NO_TICK_DIRECTION');
  db.close();
});

test('成交量历史不足时不发布方向判断', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'NEW' });
  seedTrend(db, 'NEW', 1, 5);
  const result = analyzeCapitalFlow(db, 'NEW', '2026-06-05');
  assert.equal(result.signal, 'INSUFFICIENT');
  assert.equal(result.score, 0);
  assert.ok(result.confidence <= 35);
  db.close();
});

function seedVolumeAnomaly(db, ticker, direction) {
  const start = new Date('2026-07-01T00:00:00.000Z');
  for (let index = 0; index < 21; index += 1) {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    saveManualPrice(db, {
      ticker, tradeDate: date.toISOString().slice(0, 10),
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    });
  }
  saveManualPrice(db, {
    ticker, tradeDate: '2026-07-22', open: 100,
    high: direction > 0 ? 104 : 101, low: direction > 0 ? 99 : 96,
    close: direction > 0 ? 103 : 97, volume: 2000
  });
}

test('明显放量上涨生成P2提醒且同一交易日不会重复通知', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'SURGE' });
  seedVolumeAnomaly(db, 'SURGE', 1);
  const analysis = saveCapitalFlow(db, 'SURGE', '2026-07-22');
  const sent = [];
  const notifier = async (_db, input) => { sent.push(input); return input; };
  await notifyVolumeAnomalies(db, analysis, { notifier });
  await notifyVolumeAnomalies(db, analysis, { notifier });
  assert.ok(analysis.anomalies.some((item) => item.code === 'HIGH_VOLUME_RISE'));
  assert.equal(analysis.metrics.volume, 2000);
  assert.equal(analysis.metrics.averageVolume20d, 1050);
  assert.equal(analysis.metrics.baselineVolume20d, 1000);
  assert.equal(analysis.metrics.relativeVolume, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].severity, 'P2');
  assert.equal(sent[0].category, 'VOLUME_ANOMALY');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM volume_alerts').get().count, 1);
  db.close();
});

test('明显放量下跌生成P1风险提醒并保存成交量趋势字段', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'DROP' });
  seedVolumeAnomaly(db, 'DROP', -1);
  const analysis = saveCapitalFlow(db, 'DROP', '2026-07-22');
  const sent = [];
  await notifyVolumeAnomalies(db, analysis, {
    notifier: async (_db, input) => { sent.push(input); return input; }
  });
  assert.ok(analysis.anomalies.some((item) => item.code === 'HIGH_VOLUME_FALL'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].severity, 'P1');
  assert.match(sent[0].title, /明显放量下跌/);
  const snapshot = db.prepare(`
    SELECT volume, average_volume_5d, average_volume_20d, volume_trend
    FROM capital_flow_snapshots WHERE ticker = 'DROP'
  `).get();
  assert.equal(snapshot.volume, 2000);
  assert.equal(snapshot.average_volume_20d, 1050);
  assert.ok(snapshot.average_volume_5d > snapshot.average_volume_20d);
  assert.equal(snapshot.volume_trend, 'STABLE');
  db.close();
});
