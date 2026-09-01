import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { saveDailySnapshots } from '../src/portfolio.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import { generateDailyReviews, refreshDailyReviewsIfNeeded } from '../src/reviews.js';

test('缺失行情补齐后自动重算快照和已有复盘', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'LITE', name: 'Lumentum' });
  addTransaction(db, { ticker: 'LITE', side: 'BUY', tradeTime: '2026-08-17T15:00:00Z', quantity: 100, price: 950, fee: 0 });
  saveManualPrice(db, { ticker: 'LITE', tradeDate: '2026-08-27', close: 956.14, volume: 1000 });
  saveManualPrice(db, { ticker: 'LITE', tradeDate: '2026-08-31', close: 914.76, volume: 1200 });

  saveDailySnapshots(db, '2026-09-01');
  await generateDailyReviews(db, '2026-09-01');
  let review = db.prepare("SELECT structured_json, narrative FROM daily_reviews WHERE ticker = 'LITE'").get();
  let structured = JSON.parse(review.structured_json);
  assert.equal(structured.position.previousClose, null);
  assert.equal(structured.position.priceDataStatus, 'MISSING_PREVIOUS');
  assert.match(review.narrative, /行情缺失/);

  saveManualPrice(db, { ticker: 'LITE', tradeDate: '2026-08-28', close: 895, volume: 1100 });
  const repair = await refreshDailyReviewsIfNeeded(db, '2026-09-01');
  assert.deepEqual(repair, { refreshed: true, reason: 'PRICE_DATA_CHANGED', tickers: ['LITE'] });

  review = db.prepare("SELECT structured_json FROM daily_reviews WHERE ticker = 'LITE'").get();
  structured = JSON.parse(review.structured_json);
  assert.equal(structured.position.previousClose, 895);
  assert.equal(structured.position.previousPriceDate, '2026-08-28');
  assert.equal(structured.position.dailyReturn, 0.022078);
  assert.equal(structured.position.dailyPnl, 1976);

  const snapshot = db.prepare("SELECT previous_close, daily_pnl FROM daily_position_snapshots WHERE ticker = 'LITE'").get();
  assert.equal(snapshot.previous_close, 895);
  assert.equal(snapshot.daily_pnl, 1976);
  db.close();
});
