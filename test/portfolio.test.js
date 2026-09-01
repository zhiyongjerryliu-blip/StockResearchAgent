import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import { calculateLots, calculatePosition } from '../src/portfolio.js';

test('FIFO批次、已实现和未实现盈亏计算正确', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAPL' });
  addTransaction(db, { ticker: 'AAPL', side: 'BUY', tradeTime: '2026-08-01T15:00:00Z', quantity: 10, price: 100, fee: 1 });
  addTransaction(db, { ticker: 'AAPL', side: 'BUY', tradeTime: '2026-08-05T15:00:00Z', quantity: 5, price: 120, fee: 1 });
  addTransaction(db, { ticker: 'AAPL', side: 'SELL', tradeTime: '2026-08-10T15:00:00Z', quantity: 8, price: 150, fee: 1 });
  saveManualPrice(db, { ticker: 'AAPL', tradeDate: '2026-08-30', close: 160, volume: 1000 });
  saveManualPrice(db, { ticker: 'AAPL', tradeDate: '2026-08-31', close: 170, volume: 1200 });

  const position = calculatePosition(db, 'AAPL');
  assert.equal(position.quantity, 7);
  assert.equal(position.remainingCost, 801.2);
  assert.equal(position.realizedPnl, 398.2);
  assert.equal(position.marketValue, 1190);
  assert.equal(position.unrealizedPnl, 388.8);
  assert.equal(position.totalPnl, 787);
  assert.equal(position.dailyPnl, 70);
  assert.equal(position.lots.length, 2);
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
