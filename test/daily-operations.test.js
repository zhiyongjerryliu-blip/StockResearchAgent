import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, nowIso } from '../src/db.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import { runDailyCycle } from '../src/scheduler.js';
import {
  collectDailyDataQuality, getDailyOperation, getDailyOperationsCenter, runRecordedStep
} from '../src/daily-operations.js';

function createJob(db, details = {}) {
  return Number(db.prepare(`
    INSERT INTO job_runs (job_name, started_at, status, details_json)
    VALUES ('daily-cycle', ?, 'RUNNING', ?)
  `).run(nowIso(), JSON.stringify(details)).lastInsertRowid);
}

test('分步骤任务会记录局部失败、自动重试和最终成功状态', async () => {
  const db = openDatabase(':memory:');
  const jobRunId = createJob(db, { reviewDate: '2026-09-04' });
  let calls = 0;
  const result = await runRecordedStep(db, jobRunId, {
    key: 'MARKET', label: '日线行情同步', analysisDate: '2026-09-04',
    maxAttempts: 2, retryDelayMs: 0,
    run: async () => {
      calls += 1;
      return calls === 1
        ? { results: [{ ticker: 'TEST', ok: false, error: 'temporary' }] }
        : { results: [{ ticker: 'TEST', ok: true, count: 10 }] };
    }
  });

  assert.equal(calls, 2);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.attempts, 2);
  const rows = db.prepare(`
    SELECT attempt, status, item_failed FROM job_step_runs
    WHERE job_run_id = ? ORDER BY attempt
  `).all(jobRunId);
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { attempt: 1, status: 'DEGRADED', item_failed: 1 },
    { attempt: 2, status: 'SUCCESS', item_failed: 0 }
  ]);
  db.close();
});

test('数据质量检查会识别同日Provider价格口径冲突并进入运行中心', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  const timestamp = nowIso();
  const insert = db.prepare(`
    INSERT INTO prices_daily (
      ticker, trade_date, open, high, low, close, volume, provider, available_at, ingested_at
    ) VALUES ('TEST', '2026-09-04', 100, 110, 90, ?, 1000, ?, ?, ?)
  `);
  insert.run(100, 'manual', timestamp, timestamp);
  insert.run(102, 'other', timestamp, timestamp);
  const jobRunId = createJob(db, {
    version: 'test', reviewDate: '2026-09-04', ticker: 'TEST', trigger: 'RERUN'
  });

  const quality = collectDailyDataQuality(db, {
    analysisDate: '2026-09-04', ticker: 'TEST', jobRunId
  });
  assert.equal(quality.status, 'ATTENTION');
  const market = quality.checks.find((check) => check.sourceKey === 'MARKET');
  assert.equal(market.status, 'INCONSISTENT');
  assert.match(market.message, /0.1%/);
  assert.equal(market.details.providers.length, 2);

  db.prepare(`
    UPDATE job_runs SET finished_at = ?, status = 'DEGRADED', details_json = ? WHERE id = ?
  `).run(nowIso(), JSON.stringify({ reviewDate: '2026-09-04', ticker: 'TEST' }), jobRunId);
  const operation = getDailyOperation(db, jobRunId);
  const center = getDailyOperationsCenter(db);
  assert.equal(operation.quality.length, quality.checks.length);
  assert.equal(center.latest.id, jobRunId);
  assert.equal(center.summary.degradedRuns, 1);
  db.close();
});

test('数据质量检查拒绝不在启用股票池内的定向范围', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => collectDailyDataQuality(db, {
    analysisDate: '2026-09-04', ticker: 'MISS', jobRunId: null
  }), /股票池中没有启用的股票/);
  db.close();
});

function businessDates(start, count) {
  const dates = [];
  const date = new Date(`${start}T00:00:00.000Z`);
  while (dates.length < count) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

test('定向日终重跑会执行完整流水线并保存可审计步骤和质量结果', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  const dates = businessDates('2026-01-02', 140);
  dates.forEach((tradeDate, index) => saveManualPrice(db, {
    ticker: 'TEST', tradeDate, open: 100 + index, high: 101 + index,
    low: 99 + index, close: 100 + index, volume: 1_000_000 + index
  }));
  addTransaction(db, {
    ticker: 'TEST', side: 'BUY', tradeTime: dates[0], quantity: 10, price: 100
  });
  const analysisDate = dates.at(-1);

  const result = await runDailyCycle(
    db, null, new Date(), null, null, null,
    { analysisDate, ticker: 'TEST', trigger: 'RERUN', retryDelayMs: 0, notify: false }
  );

  assert.equal(result.status, 'DEGRADED');
  assert.equal(result.ticker, 'TEST');
  assert.equal(result.steps.length, 14);
  assert.ok(result.steps.some((step) => step.key === 'DATA_QUALITY'));
  const operation = getDailyOperation(db, result.jobRunId);
  assert.equal(operation.details.trigger, 'RERUN');
  assert.equal(operation.steps.length, 14);
  assert.ok(operation.quality.some((check) => (
    check.ticker === 'TEST' && check.source_key === 'PREDICTIONS' && check.status === 'CURRENT'
  )));
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM daily_reviews
    WHERE ticker = 'TEST' AND review_date = ?
  `).get(analysisDate).count, 1);
  db.close();
});
