import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, nowIso } from '../src/db.js';
import {
  claimDailyCycle, dailyCycleAutomationStatus, finishDailyCycleClaim,
  heartbeatDailyCycleClaim, missingDailyCycleDates
} from '../src/daily-cycle-automation.js';
import { reconcileDailyCycles } from '../src/scheduler.js';

function saveLegacyCompletion(db, reviewDate) {
  db.prepare(`
    INSERT INTO job_runs (job_name, started_at, finished_at, status, details_json)
    VALUES ('daily-cycle', ?, ?, 'SUCCESS', ?)
  `).run(nowIso(), nowIso(), JSON.stringify({ reviewDate, ticker: null, trigger: 'SCHEDULED' }));
}

test('补跑日期跳过美股休市日并从最近完成日顺序追赶', () => {
  const db = openDatabase(':memory:');
  saveLegacyCompletion(db, '2026-09-03');
  assert.deepEqual(missingDailyCycleDates(db, '2026-09-08', 5), [
    '2026-09-04', '2026-09-08'
  ]);
  db.close();
});

test('数据库任务租约阻止同一交易日重复运行', () => {
  const db = openDatabase(':memory:');
  const now = new Date('2026-09-05T10:00:00.000Z');
  const first = claimDailyCycle(db, { analysisDate: '2026-09-04', now });
  const duplicate = claimDailyCycle(db, { analysisDate: '2026-09-04', now });
  assert.equal(first.claimed, true);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.reason, 'already_running');
  assert.equal(finishDailyCycleClaim(db, {
    analysisDate: '2026-09-04', token: first.token, resultStatus: 'SUCCESS', now
  }), true);
  const completed = claimDailyCycle(db, { analysisDate: '2026-09-04', now });
  assert.equal(completed.claimed, false);
  assert.equal(completed.reason, 'already_completed');
  assert.equal(dailyCycleAutomationStatus(db, '2026-09-04').status, 'CURRENT');
  db.close();
});

test('长任务定期刷新数据库租约，其他进程不能误判为已超时', () => {
  const db = openDatabase(':memory:');
  const claim = claimDailyCycle(db, {
    analysisDate: '2026-09-04', now: '2026-09-05T10:00:00.000Z'
  });
  assert.equal(heartbeatDailyCycleClaim(db, {
    analysisDate: '2026-09-04', token: claim.token,
    now: '2026-09-05T10:25:00.000Z'
  }), true);
  const duplicate = claimDailyCycle(db, {
    analysisDate: '2026-09-04', now: '2026-09-05T10:40:00.000Z', staleMinutes: 30
  });
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.reason, 'already_running');
  db.close();
});

test('失败任务按冷却时间重试且达到上限后停止', () => {
  const db = openDatabase(':memory:');
  const first = claimDailyCycle(db, {
    analysisDate: '2026-09-04', now: '2026-09-05T10:00:00.000Z', maximumAttempts: 2
  });
  finishDailyCycleClaim(db, {
    analysisDate: '2026-09-04', token: first.token, resultStatus: 'FAILED',
    error: 'network', now: '2026-09-05T10:01:00.000Z'
  });
  assert.equal(claimDailyCycle(db, {
    analysisDate: '2026-09-04', now: '2026-09-05T10:10:00.000Z',
    maximumAttempts: 2, retryDelayMinutes: 15
  }).reason, 'retry_wait');
  const retry = claimDailyCycle(db, {
    analysisDate: '2026-09-04', now: '2026-09-05T10:17:00.000Z',
    maximumAttempts: 2, retryDelayMinutes: 15
  });
  assert.equal(retry.claimed, true);
  assert.equal(retry.attempts, 2);
  finishDailyCycleClaim(db, {
    analysisDate: '2026-09-04', token: retry.token, resultStatus: 'FAILED',
    now: '2026-09-05T10:18:00.000Z'
  });
  assert.equal(claimDailyCycle(db, {
    analysisDate: '2026-09-04', now: '2026-09-05T11:00:00.000Z', maximumAttempts: 2
  }).reason, 'attempts_exhausted');
  assert.equal(dailyCycleAutomationStatus(db, '2026-09-04', {
    maximumAttempts: 2
  }).attemptsExhausted, true);
  db.close();
});

test('最后一次运行崩溃后超时租约转为失败且不会永久显示运行中', () => {
  const db = openDatabase(':memory:');
  const claim = claimDailyCycle(db, {
    analysisDate: '2026-09-04', now: '2026-09-05T10:00:00.000Z', maximumAttempts: 1
  });
  assert.equal(claim.claimed, true);
  const run = db.prepare(`
    INSERT INTO job_runs (job_name, started_at, status, details_json)
    VALUES ('daily-cycle', ?, 'RUNNING', ?)
  `).run(
    '2026-09-05T10:00:00.000Z',
    JSON.stringify({ reviewDate: '2026-09-04', ticker: null, trigger: 'STARTUP_CATCHUP' })
  );
  const stale = claimDailyCycle(db, {
    analysisDate: '2026-09-04', now: '2026-09-05T14:00:00.000Z',
    maximumAttempts: 1, staleMinutes: 180
  });
  assert.equal(stale.claimed, false);
  assert.equal(stale.reason, 'attempts_exhausted');
  assert.equal(stale.existing.state, 'FAILED');
  assert.equal(db.prepare('SELECT status FROM job_runs WHERE id = ?').get(run.lastInsertRowid).status, 'FAILED');
  db.close();
});

test('流水线已完成但租约未释放时以完成记录为准避免重复补跑', () => {
  const db = openDatabase(':memory:');
  claimDailyCycle(db, {
    analysisDate: '2026-09-04', now: '2026-09-05T10:00:00.000Z'
  });
  saveLegacyCompletion(db, '2026-09-04');
  assert.deepEqual(missingDailyCycleDates(db, '2026-09-04'), []);
  const status = dailyCycleAutomationStatus(db, '2026-09-04');
  assert.equal(status.status, 'CURRENT');
  assert.equal(status.orphanedClaim, true);
  db.close();
});

test('自动协调器启动后补跑遗漏交易日且再次检查保持幂等', async () => {
  const db = openDatabase(':memory:');
  saveLegacyCompletion(db, '2026-09-03');
  const calls = [];
  const options = {
    dailyReviewHourEt: 18, dailyReviewMinuteEt: 15,
    automationTrigger: 'STARTUP_CATCHUP',
    system: {
      dailyCycleCatchupLimit: 5,
      dailyCycleAutomationMaxAttempts: 3,
      dailyCycleAutomationRetryMinutes: 15,
      dailyCycleClaimStaleMinutes: 180
    },
    executeCycle: async (...args) => {
      const cycleOptions = args.at(-1);
      calls.push(cycleOptions);
      return { status: 'SUCCESS', jobRunId: null };
    }
  };
  const now = new Date('2026-09-09T00:00:00.000Z'); // 9月8日20:00 ET
  const first = await reconcileDailyCycles(db, null, now, null, null, null, options);
  assert.deepEqual(first.missing, ['2026-09-04', '2026-09-08']);
  assert.deepEqual(calls.map((item) => item.analysisDate), ['2026-09-04', '2026-09-08']);
  assert.ok(calls.every((item) => item.trigger === 'STARTUP_CATCHUP'));
  const second = await reconcileDailyCycles(db, null, now, null, null, null, options);
  assert.deepEqual(second.missing, []);
  assert.equal(calls.length, 2);
  db.close();
});
