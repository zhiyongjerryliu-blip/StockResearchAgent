import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../src/db.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import { generateDailyReviews } from '../src/reviews.js';
import { DailyCycleWorkerRunner } from '../src/daily-cycle-worker-runner.js';

test('真实行情工作线程修复数据库中的过期复盘并关闭连接', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-refresh-worker-'));
  const databasePath = path.join(directory, 'research.sqlite');
  const db = openDatabase(databasePath);
  const runner = new DailyCycleWorkerRunner({
    databasePath, taskLabel: '行情刷新',
    workerUrl: new URL('../src/market-refresh-worker.js', import.meta.url),
    workerFactory: (url, options) => new Worker(url, {
      ...options,
      env: { ...process.env, MARKET_DATA_PROVIDER: 'manual', LLM_ENABLED: 'true',
        LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model', LLM_BASE_URL: 'https://llm.invalid' }
    })
  });
  try {
    upsertWatchlistItem(db, { ticker: 'TEST' });
    addTransaction(db, { ticker: 'TEST', side: 'BUY', tradeTime: '2026-09-01', quantity: 10, price: 100, fee: 0 });
    saveManualPrice(db, { ticker: 'TEST', tradeDate: '2026-09-01', close: 100, volume: 1000 });
    await generateDailyReviews(db, '2026-09-02', { useLlm: false });
    saveManualPrice(db, { ticker: 'TEST', tradeDate: '2026-09-02', close: 110, volume: 1000 });
    const result = await runner.run();
    assert.equal(result.provider, 'manual');
    assert.equal(result.historicalReviewRepairs.find(row => row.reviewDate === '2026-09-02').refreshed, true);
    const row = db.prepare("SELECT structured_json FROM daily_reviews WHERE ticker='TEST' AND review_date='2026-09-02'").get();
    const review = JSON.parse(row.structured_json);
    assert.equal(review.position.currentPrice, 110);
    assert.equal(review.position.dailyPnl, 100);
    assert.equal(review.llmError, undefined);
    assert.equal(runner.status().running, false);
  } finally {
    await runner.stop();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
