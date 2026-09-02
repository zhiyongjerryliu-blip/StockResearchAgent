import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  addTransaction,
  deleteWatchlistItem,
  listWatchlist,
  updateWatchlistItem,
  upsertWatchlistItem
} from '../src/repository.js';

test('股票池项目可以修改且股票代码保持不变', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, {
    ticker: 'NVDA', name: 'NVIDIA', sector: 'Technology', industry: 'Semiconductors',
    benchmark: 'SPY', industryEtf: 'SMH', note: '原备注'
  });

  const updated = updateWatchlistItem(db, 'NVDA', {
    name: 'NVIDIA Corporation', sector: 'Information Technology', industry: 'Chips',
    benchmark: 'QQQ', industryEtf: '', note: '关注数据中心', enabled: false
  });

  assert.equal(updated.ticker, 'NVDA');
  assert.equal(updated.name, 'NVIDIA Corporation');
  assert.equal(updated.sector, 'Information Technology');
  assert.equal(updated.industry, 'Chips');
  assert.equal(updated.benchmark, 'QQQ');
  assert.equal(updated.industry_etf, null);
  assert.equal(updated.note, '关注数据中心');
  assert.equal(updated.enabled, false);
  db.close();
});

test('已清仓股票可移出股票池且交易历史保留', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAPL' });
  addTransaction(db, {
    ticker: 'AAPL', side: 'BUY', tradeTime: '2026-08-01T15:00:00Z', quantity: 2, price: 100, fee: 0
  });
  addTransaction(db, {
    ticker: 'AAPL', side: 'SELL', tradeTime: '2026-08-02T15:00:00Z', quantity: 2, price: 110, fee: 0
  });

  const result = deleteWatchlistItem(db, 'AAPL');

  assert.deepEqual(result, { ticker: 'AAPL', removed: true, historyRetained: true });
  assert.equal(listWatchlist(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE ticker = ?').get('AAPL').count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM securities WHERE ticker = ?').get('AAPL').count, 1);
  db.close();
});

test('仍有持仓时不能从股票池删除', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'MSFT' });
  addTransaction(db, {
    ticker: 'MSFT', side: 'BUY', tradeTime: '2026-08-01T15:00:00Z', quantity: 3, price: 300, fee: 0
  });

  assert.throws(() => deleteWatchlistItem(db, 'MSFT'), /仍持有3股/);
  assert.equal(listWatchlist(db).length, 1);
  db.close();
});
