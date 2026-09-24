import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { heldTickers, requireHeldTicker } from '../src/analysis-scope.js';
import { addTransaction, upsertWatchlistItem } from '../src/repository.js';

test('分析范围按截止日实际持仓判定并排除已清仓和自选股', () => {
  const db = openDatabase(':memory:');
  for (const ticker of ['HELD', 'SOLD', 'WATCH']) upsertWatchlistItem(db, { ticker });
  addTransaction(db, { ticker: 'HELD', side: 'BUY', tradeTime: '2026-09-01T15:00:00Z', quantity: 10, price: 10, fee: 0 });
  addTransaction(db, { ticker: 'SOLD', side: 'BUY', tradeTime: '2026-09-01T15:00:00Z', quantity: 5, price: 10, fee: 0 });
  addTransaction(db, { ticker: 'SOLD', side: 'SELL', tradeTime: '2026-09-03T15:00:00Z', quantity: 5, price: 11, fee: 0 });

  assert.deepEqual(heldTickers(db, '2026-09-02'), ['HELD', 'SOLD']);
  assert.deepEqual(heldTickers(db, '2026-09-04'), ['HELD']);
  assert.equal(requireHeldTicker(db, 'held', '2026-09-04'), 'HELD');
  assert.throws(() => requireHeldTicker(db, 'WATCH', '2026-09-04'), /未持有股票/);
  db.close();
});
