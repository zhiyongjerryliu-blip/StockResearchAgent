import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import { calculateLots, calculateMonthlyPerformance, calculatePosition } from '../src/portfolio.js';

test('FIFO批次、已实现和未实现盈亏计算正确', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAPL' });
  addTransaction(db, { ticker: 'AAPL', side: 'BUY', tradeTime: '2026-08-01T15:00:00Z', quantity: 10, price: 100, fee: 1 });
  addTransaction(db, { ticker: 'AAPL', side: 'BUY', tradeTime: '2026-08-05T15:00:00Z', quantity: 5, price: 120, fee: 1 });
  addTransaction(db, { ticker: 'AAPL', side: 'SELL', tradeTime: '2026-08-10T15:00:00Z', quantity: 8, price: 150, fee: 1 });
  saveManualPrice(db, { ticker: 'AAPL', tradeDate: '2026-08-28', close: 160, volume: 1000 });
  saveManualPrice(db, { ticker: 'AAPL', tradeDate: '2026-08-31', close: 170, volume: 1200 });

  const position = calculatePosition(db, 'AAPL');
  assert.equal(position.quantity, 7);
  assert.equal(position.remainingCost, 801.2);
  assert.equal(position.realizedPnl, 398.2);
  assert.equal(position.marketValue, 1190);
  assert.equal(position.unrealizedPnl, 388.8);
  assert.equal(position.totalPnl, 787);
  assert.equal(position.dailyPnl, 70);
  assert.equal(position.previousPriceDate, '2026-08-28');
  assert.equal(position.priceDataStatus, 'COMPLETE');
  assert.equal(position.lots.length, 2);
  db.close();
});

test('上一交易日行情缺失时不会跨日期计算日涨跌', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'LITE' });
  addTransaction(db, { ticker: 'LITE', side: 'BUY', tradeTime: '2026-08-17T15:00:00Z', quantity: 100, price: 950, fee: 0 });
  saveManualPrice(db, { ticker: 'LITE', tradeDate: '2026-08-27', close: 956.14 });
  saveManualPrice(db, { ticker: 'LITE', tradeDate: '2026-08-31', close: 914.76 });

  const position = calculatePosition(db, 'LITE');
  assert.equal(position.currentPrice, 914.76);
  assert.equal(position.expectedPreviousPriceDate, '2026-08-28');
  assert.equal(position.previousPriceDate, null);
  assert.equal(position.previousClose, null);
  assert.equal(position.dailyReturn, null);
  assert.equal(position.dailyPnl, null);
  assert.equal(position.priceDataStatus, 'MISSING_PREVIOUS');
  db.close();
});

test('超过持仓的卖出会被拒绝且交易回滚', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'MSFT' });
  addTransaction(db, { ticker: 'MSFT', side: 'BUY', tradeTime: '2026-08-01T15:00:00Z', quantity: 2, price: 300, fee: 0 });
  assert.throws(() => addTransaction(db, {
    ticker: 'MSFT', side: 'SELL', tradeTime: '2026-08-02T15:00:00Z', quantity: 3, price: 310, fee: 0
  }), /卖出股数超过/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 1);
  db.close();
});

test('纯批次计算包含买入费用和卖出费用', () => {
  const result = calculateLots([
    { id: 1, side: 'BUY', trade_time: '2026-01-01', quantity: 10, price: 10, fee: 2 },
    { id: 2, side: 'SELL', trade_time: '2026-01-02', quantity: 4, price: 15, fee: 1 }
  ]);
  assert.equal(result.quantity, 6);
  assert.ok(Math.abs(result.remainingCost - 61.2) < 1e-9);
  assert.ok(Math.abs(result.realizedPnl - 18.2) < 1e-9);
});

test('月度盈亏只展示建仓日至清仓日并包含交易现金流', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAPL' });
  saveManualPrice(db, { ticker: 'AAPL', tradeDate: '2026-07-31', close: 99 });
  saveManualPrice(db, { ticker: 'AAPL', tradeDate: '2026-08-03', close: 102 });
  saveManualPrice(db, { ticker: 'AAPL', tradeDate: '2026-08-04', close: 105 });
  saveManualPrice(db, { ticker: 'AAPL', tradeDate: '2026-08-05', close: 107 });
  saveManualPrice(db, { ticker: 'AAPL', tradeDate: '2026-08-06', close: 110 });
  addTransaction(db, { ticker: 'AAPL', side: 'BUY', tradeTime: '2026-08-03T15:00:00Z', quantity: 10, price: 100, fee: 0 });
  addTransaction(db, { ticker: 'AAPL', side: 'SELL', tradeTime: '2026-08-05T15:00:00Z', quantity: 10, price: 106, fee: 1 });

  const performance = calculateMonthlyPerformance(db, '2026-08');
  assert.deepEqual(performance.days.map((day) => day.date), ['2026-08-03', '2026-08-04', '2026-08-05']);
  assert.deepEqual(performance.days.map((day) => day.pnl), [20, 30, 9]);
  assert.equal(performance.totalPnl, 59);
  assert.equal(performance.firstDisplayedDate, '2026-08-03');
  assert.equal(performance.lastDisplayedDate, '2026-08-05');
  db.close();
});

test('月度持仓日缺少上一交易日行情时标记为不完整', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'LITE' });
  addTransaction(db, { ticker: 'LITE', side: 'BUY', tradeTime: '2026-08-27T15:00:00Z', quantity: 1, price: 950, fee: 0 });
  saveManualPrice(db, { ticker: 'LITE', tradeDate: '2026-08-27', close: 956.14 });
  saveManualPrice(db, { ticker: 'LITE', tradeDate: '2026-08-31', close: 914.76 });

  const performance = calculateMonthlyPerformance(db, '2026-08');
  assert.equal(performance.days[0].pnl, 6.14);
  assert.equal(performance.days[1].pnl, null);
  assert.equal(performance.days[1].status, 'INCOMPLETE');
  assert.equal(performance.totalPnl, null);
  assert.equal(performance.incompleteDays, 1);
  db.close();
});
