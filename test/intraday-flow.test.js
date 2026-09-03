import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { upsertWatchlistItem } from '../src/repository.js';
import {
  analyzeIntradayFlow, ingestFutuBars, ingestFutuTicks,
  INTRADAY_FLOW_MODEL_VERSION, listIntradayFlowMinutes, rebuildMissingIntradayMinutes,
  saveIntradayFlowSnapshot
} from '../src/intraday-flow.js';

function minute(index) {
  return `2026-09-01 09:${String(30 + index).padStart(2, '0')}:00`;
}

function seedIntraday(db, ticker, direction = 'BUY') {
  const bars = [];
  const ticks = [];
  for (let index = 0; index < 20; index += 1) {
    const price = direction === 'BUY' ? 100 + (index * 0.1) : 102 - (index * 0.1);
    bars.push({
      ticker, barTimeEt: minute(index), tradeDate: '2026-09-01',
      open: price - 0.05, high: price + 0.1, low: price - 0.1, close: price,
      volume: 1000, turnover: price * 1000, isFinal: true, session: 'RTH'
    });
    for (let offset = 0; offset < 5; offset += 1) {
      const dominant = offset < 4 ? direction : direction === 'BUY' ? 'SELL' : 'BUY';
      const volume = dominant === direction ? 200 : 40;
      ticks.push({
        ticker, sequence: `${index}-${offset}`,
        tradeTimeEt: minute(index).replace(':00', `:${String(offset).padStart(2, '0')}`),
        tradeDate: '2026-09-01', price, volume, turnover: price * volume,
        direction: dominant, tradeType: 'AUTO_MATCH', session: 'RTH'
      });
    }
  }
  return { bars, ticks };
}

test('富途逐笔方向识别主动买入占优并保存分钟快照', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'FLOW' });
  const data = seedIntraday(db, 'FLOW', 'BUY');
  assert.equal(ingestFutuBars(db, data.bars), 20);
  assert.equal(ingestFutuTicks(db, data.ticks), 100);
  assert.equal(ingestFutuTicks(db, data.ticks), 0);

  const result = analyzeIntradayFlow(db, 'FLOW');
  assert.equal(result.dataLevel, 'FUTU_TICK_DIRECTION');
  assert.ok(['INFLOW', 'STRONG_INFLOW'].includes(result.signal));
  assert.ok(result.score > 0);
  assert.ok(result.metrics.netActiveTurnover > 0);
  assert.ok(result.metrics.largeTradeRatio > 0);
  assert.equal(result.metrics.tickMinuteCoverage, 1);
  assert.match(result.explanation, /不代表账户身份/);

  saveIntradayFlowSnapshot(db, 'FLOW');
  saveIntradayFlowSnapshot(db, 'FLOW');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM intraday_flow_snapshots
    WHERE ticker = 'FLOW' AND model_version = ?
  `).get(INTRADAY_FLOW_MODEL_VERSION).count, 1);
  db.close();
});

test('富途逐笔方向识别主动卖出占优且按分钟倒序汇总', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'SELL' });
  const data = seedIntraday(db, 'SELL', 'SELL');
  ingestFutuBars(db, data.bars);
  ingestFutuTicks(db, data.ticks);

  const result = analyzeIntradayFlow(db, 'SELL');
  assert.ok(['OUTFLOW', 'STRONG_OUTFLOW'].includes(result.signal));
  assert.ok(result.score < 0);
  assert.ok(result.metrics.netActiveTurnover < 0);

  const minutes = listIntradayFlowMinutes(db, 'SELL', null, 10);
  assert.equal(minutes.length, 10);
  assert.ok(minutes[0].minute > minutes.at(-1).minute);
  assert.ok(minutes.every((row) => row.netActiveTurnover < 0));
  db.close();
});

test('只有分钟K线时明确降级为量价方向代理', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'PROXY' });
  const data = seedIntraday(db, 'PROXY', 'BUY');
  ingestFutuBars(db, data.bars);
  const result = analyzeIntradayFlow(db, 'PROXY');
  assert.equal(result.dataLevel, 'FUTU_MINUTE_PROXY');
  assert.ok(result.confidence <= 35);
  assert.match(result.explanation, /逐笔主动买卖样本不足/);
  db.close();
});

test('逐笔序号可在新的交易日重新使用', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'RESET' });
  const base = {
    ticker: 'RESET', sequence: '1', price: 10, volume: 100,
    turnover: 1000, direction: 'BUY', session: 'RTH'
  };
  assert.equal(ingestFutuTicks(db, [{
    ...base, tradeDate: '2026-09-01', tradeTimeEt: '2026-09-01 09:30:00'
  }]), 1);
  assert.equal(ingestFutuTicks(db, [{
    ...base, tradeDate: '2026-09-02', tradeTimeEt: '2026-09-02 09:30:00'
  }]), 1);
  db.close();
});

test('盘前零成交量占位分钟线不会遮住上一有效交易日', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'PLACE' });
  const data = seedIntraday(db, 'PLACE', 'BUY');
  ingestFutuBars(db, data.bars);
  ingestFutuTicks(db, data.ticks);
  ingestFutuBars(db, [{
    ticker: 'PLACE', barTimeEt: '2026-09-02 09:25:00', tradeDate: '2026-09-02',
    open: 101, high: 101, low: 101, close: 101, volume: 0, turnover: 0,
    isFinal: false, session: 'RTH'
  }]);
  assert.equal(analyzeIntradayFlow(db, 'PLACE').tradeDate, '2026-09-01');
  db.close();
});

test('开盘初期即使逐笔很多也会按当日时间覆盖压低置信度', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'OPEN' });
  const data = seedIntraday(db, 'OPEN', 'BUY');
  ingestFutuBars(db, data.bars.slice(0, 2));
  const openingTicks = Array.from({ length: 1500 }, (_, index) => ({
    ...data.ticks[index % 10],
    ticker: 'OPEN', sequence: String(index),
    tradeTimeEt: `2026-09-01 09:${index % 2 === 0 ? '30' : '31'}:${String(index % 60).padStart(2, '0')}`
  }));
  ingestFutuTicks(db, openingTicks);
  const result = analyzeIntradayFlow(db, 'OPEN');
  assert.ok(result.confidence < 50);
  assert.equal(result.metrics.tickMinuteCoverage, 1);
  assert.ok(result.metrics.sessionProgress < 0.01);
  db.close();
});

test('升级已有数据库时可从原始逐笔重建分钟聚合', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'MIGRATE' });
  db.prepare(`
    INSERT INTO ticks_intraday (
      ticker, sequence, trade_time_et, trade_date, price, volume, turnover,
      direction, session, provider, ingested_at
    ) VALUES ('MIGRATE', '1', '2026-09-01 09:30:01', '2026-09-01', 10, 100, 1000,
      'BUY', 'RTH', 'futu', '2026-09-01T13:30:01Z')
  `).run();
  assert.equal(rebuildMissingIntradayMinutes(db), 1);
  assert.equal(rebuildMissingIntradayMinutes(db), 0);
  const minute = db.prepare(`
    SELECT buy_turnover, buy_count FROM intraday_tick_minutes WHERE ticker = 'MIGRATE'
  `).get();
  assert.equal(minute.buy_turnover, 1000);
  assert.equal(minute.buy_count, 1);
  db.close();
});
