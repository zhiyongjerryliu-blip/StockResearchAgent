import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { saveDailySnapshots } from '../src/portfolio.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import { generateDailyReviews, refreshDailyReviewsIfNeeded } from '../src/reviews.js';
import { indexSecFilingEvents } from '../src/events.js';
import { ingestFutuBars, ingestFutuTicks } from '../src/intraday-flow.js';
import { runMarketRefreshCycle } from '../src/scheduler.js';
import { config } from '../src/config.js';

test('隔夜行情恢复会修复缺失交易日的复盘和快照，不使用尚未收盘的当天', async () => {
  const db = openDatabase(':memory:');
  const originalLlm = { ...config.llm };
  const originalFetch = globalThis.fetch;
  let llmCalls = 0;
  Object.assign(config.llm, { enabled: true, apiKey: 'test-key', model: 'test-model', baseUrl: 'https://llm.invalid' });
  globalThis.fetch = async () => { llmCalls += 1; throw new Error('LLM unavailable'); };
  try {
    upsertWatchlistItem(db, { ticker: 'TEST' });
    addTransaction(db, { ticker: 'TEST', side: 'BUY', tradeTime: '2026-10-26', quantity: 10, price: 100, fee: 0 });
    saveManualPrice(db, { ticker: 'TEST', tradeDate: '2026-10-26', close: 100, volume: 1000 });
    for (const day of ['2026-10-27', '2026-10-28']) {
      saveDailySnapshots(db, day);
      await generateDailyReviews(db, day, { useLlm: false });
    }
    const provider = {
      name: 'test', fetchDaily: async ticker => ['2026-10-26', '2026-10-27', '2026-10-28'].map((tradeDate, index) => ({
        ticker, tradeDate, open: 100, high: 121, low: 100,
        close: [100, 110, 121][index], adjustedClose: [100, 110, 121][index], volume: 1000,
        provider: 'manual'
      }))
    };
    const result = await runMarketRefreshCycle(db, provider, new Date('2026-10-29T05:00:00Z'));
    assert.equal(result.reviewRepair.refreshed, true);
    assert.equal(result.historicalReviewRepairs.find(row => row.reviewDate === '2026-10-27').refreshed, true);
    for (const [day, price] of [['2026-10-27', 110], ['2026-10-28', 121]]) {
      const review = db.prepare("SELECT structured_json FROM daily_reviews WHERE ticker='TEST' AND review_date=?").get(day);
      assert.equal(JSON.parse(review.structured_json).position.currentPrice, price);
      assert.equal(db.prepare("SELECT close FROM daily_position_snapshots WHERE ticker='TEST' AND snapshot_date=?").get(day).close, price);
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_reviews WHERE review_date='2026-10-29'").get().n, 0);
    const repeated = await runMarketRefreshCycle(db, provider, new Date('2026-10-29T05:00:00Z'));
    assert.equal(repeated.reviewRepair.reason, 'UP_TO_DATE');
    assert.equal(repeated.historicalReviewRepairs.length, 0);
    assert.equal(llmCalls, 0, '行情恢复不应等待不可用的可选LLM服务');
  } finally {
    Object.assign(config.llm, originalLlm);
    globalThis.fetch = originalFetch;
    db.close();
  }
});

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

test('每日复盘纳入近7日研究事件并保留来源类型', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'RISK', name: 'Risk Corp' });
  addTransaction(db, { ticker: 'RISK', side: 'BUY', tradeTime: '2026-08-01T15:00:00Z', quantity: 10, price: 10, fee: 0 });
  saveManualPrice(db, { ticker: 'RISK', tradeDate: '2026-08-31', close: 9, volume: 1000 });
  db.prepare(`
    INSERT INTO sec_filings (
      accession_number, ticker, cik, form, filed_at, report_date, accepted_at,
      primary_document, items, filing_url, is_xbrl, is_inline_xbrl, ingested_at
    ) VALUES (
      '0000000001-26-000009', 'RISK', '0000000001', '8-K', '2026-08-31',
      '2026-08-31', '2026-08-31T20:30:00.000Z', 'risk.htm', '3.01,9.01',
      'https://www.sec.gov/risk', 1, 1, '2026-08-31T21:00:00.000Z'
    )
  `).run();
  indexSecFilingEvents(db, 'RISK');
  ingestFutuBars(db, Array.from({ length: 10 }, (_, index) => ({
    ticker: 'RISK', barTimeEt: `2026-09-01 09:${String(30 + index).padStart(2, '0')}:00`,
    tradeDate: '2026-09-01', open: 9, high: 9.1, low: 8.9, close: 9,
    volume: 100, turnover: 900, isFinal: true, session: 'RTH'
  })));
  ingestFutuTicks(db, Array.from({ length: 10 }, (_, index) => ({
    ticker: 'RISK', sequence: String(index),
    tradeTimeEt: `2026-09-01 09:${String(30 + index).padStart(2, '0')}:30`,
    tradeDate: '2026-09-01', price: 9, volume: 100, turnover: 900,
    direction: 'SELL', tradeType: 'AUTO_MATCH', session: 'RTH'
  })));

  await generateDailyReviews(db, '2026-09-01');
  const stock = db.prepare("SELECT structured_json, narrative FROM daily_reviews WHERE ticker = 'RISK'").get();
  const structured = JSON.parse(stock.structured_json);
  assert.equal(structured.events.length, 1);
  assert.equal(structured.events[0].severity, 'P1');
  assert.match(stock.narrative, /P0\/P1风险/);
  assert.match(stock.narrative, /退市通知/);
  assert.match(stock.narrative, /舆情样本不足/);
  assert.equal(structured.intradayFlow.tradeDate, '2026-09-01');
  assert.equal(structured.intradayFlow.signal, 'STRONG_OUTFLOW');
  assert.match(stock.narrative, /分钟主动资金/);

  const portfolio = db.prepare("SELECT structured_json FROM daily_reviews WHERE review_type = 'PORTFOLIO'").get();
  const portfolioStructured = JSON.parse(portfolio.structured_json);
  assert.equal(portfolioStructured.recentEvents[0].ticker, 'RISK');
  assert.equal(portfolioStructured.recentEvents[0].sourceType, 'SEC_8K');
  assert.equal(portfolioStructured.intradayFlow[0].signal, 'STRONG_OUTFLOW');
  db.close();
});
