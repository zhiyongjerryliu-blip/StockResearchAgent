import { randomUUID } from 'node:crypto';
import { nowIso, toPlain, toPlainRows } from './db.js';
import { nextRegularUsTradingDate } from './trading-calendar.js';

export const DAILY_CYCLE_AUTOMATION_VERSION = 'daily-cycle-automation-v1-2026-09-06';

function parsedDetails(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function automaticCompletionDates(db) {
  const dates = new Set(toPlainRows(db.prepare(`
    SELECT analysis_date FROM daily_cycle_claims
    WHERE state = 'COMPLETED'
  `).all()).map((row) => row.analysis_date));
  for (const row of toPlainRows(db.prepare(`
    SELECT details_json FROM job_runs
    WHERE job_name = 'daily-cycle' AND status IN ('SUCCESS','DEGRADED')
  `).all())) {
    const details = parsedDetails(row.details_json);
    if (!details.ticker && /^\d{4}-\d{2}-\d{2}$/.test(details.reviewDate || '')) {
      dates.add(details.reviewDate);
    }
  }
  return dates;
}

function failAbandonedRuns(db, analysisDate, timestamp) {
  const candidates = toPlainRows(db.prepare(`
    SELECT id, details_json FROM job_runs
    WHERE job_name = 'daily-cycle' AND status = 'RUNNING'
  `).all());
  for (const row of candidates) {
    const details = parsedDetails(row.details_json);
    if (details.reviewDate !== analysisDate || details.ticker) continue;
    db.prepare(`
      UPDATE job_runs SET status = 'FAILED', finished_at = ?, details_json = ?
      WHERE id = ? AND status = 'RUNNING'
    `).run(timestamp, JSON.stringify({
      ...details,
      error: '服务中断后任务租约超时，已由无人值守调度器接管',
      recoveredAt: timestamp
    }), row.id);
  }
}

export function missingDailyCycleDates(db, expectedDate, limit = 5) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate || '')) return [];
  const completed = automaticCompletionDates(db);
  const latestCompleted = [...completed]
    .filter((date) => date <= expectedDate)
    .sort()
    .at(-1);
  if (!latestCompleted) return completed.has(expectedDate) ? [] : [expectedDate];
  const missing = [];
  let candidate = nextRegularUsTradingDate(latestCompleted);
  while (candidate <= expectedDate && missing.length < Math.max(1, Number(limit) || 5)) {
    if (!completed.has(candidate)) missing.push(candidate);
    candidate = nextRegularUsTradingDate(candidate);
  }
  return missing;
}

export function claimDailyCycle(db, options) {
  const analysisDate = options.analysisDate;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const timestamp = now.toISOString();
  const token = randomUUID();
  const staleMinutes = Math.max(5, Number(options.staleMinutes) || 180);
  const retryDelayMinutes = Math.max(1, Number(options.retryDelayMinutes) || 15);
  const maximumAttempts = Math.max(1, Number(options.maximumAttempts) || 3);
  const staleBefore = new Date(now.getTime() - staleMinutes * 60_000).toISOString();
  const retryBefore = new Date(now.getTime() - retryDelayMinutes * 60_000).toISOString();
  const trigger = options.trigger || 'SCHEDULED';

  const inserted = db.prepare(`
    INSERT OR IGNORE INTO daily_cycle_claims (
      analysis_date, state, claim_token, trigger, attempts, claimed_at, updated_at
    ) VALUES (?, 'RUNNING', ?, ?, 1, ?, ?)
  `).run(analysisDate, token, trigger, timestamp, timestamp);
  if (Number(inserted.changes) === 1) {
    return { claimed: true, analysisDate, token, attempts: 1, trigger, reason: 'new' };
  }

  const reclaimed = db.prepare(`
    UPDATE daily_cycle_claims SET
      state = 'RUNNING', claim_token = ?, trigger = ?, attempts = attempts + 1,
      claimed_at = ?, updated_at = ?, completed_at = NULL, job_run_id = NULL,
      result_status = NULL, error_message = NULL
    WHERE analysis_date = ? AND attempts < ? AND (
      (state = 'FAILED' AND updated_at <= ?) OR
      (state = 'RUNNING' AND claimed_at <= ?)
    )
  `).run(
    token, trigger, timestamp, timestamp, analysisDate, maximumAttempts,
    retryBefore, staleBefore
  );
  if (Number(reclaimed.changes) === 1) {
    failAbandonedRuns(db, analysisDate, timestamp);
    const row = db.prepare(
      'SELECT attempts FROM daily_cycle_claims WHERE analysis_date = ?'
    ).get(analysisDate);
    return {
      claimed: true, analysisDate, token, attempts: Number(row?.attempts || 1),
      trigger, reason: 'retry'
    };
  }

  const existing = toPlain(db.prepare(
    'SELECT * FROM daily_cycle_claims WHERE analysis_date = ?'
  ).get(analysisDate));
  if (
    existing?.state === 'RUNNING' && existing.attempts >= maximumAttempts &&
    existing.claimed_at <= staleBefore
  ) {
    db.prepare(`
      UPDATE daily_cycle_claims SET state = 'FAILED', updated_at = ?,
        error_message = '运行租约超时且自动尝试次数已用尽'
      WHERE analysis_date = ? AND claim_token = ? AND state = 'RUNNING'
    `).run(timestamp, analysisDate, existing.claim_token);
    existing.state = 'FAILED';
    existing.updated_at = timestamp;
    existing.error_message = '运行租约超时且自动尝试次数已用尽';
    failAbandonedRuns(db, analysisDate, timestamp);
  }
  const reason = existing?.state === 'COMPLETED'
    ? 'already_completed'
    : existing?.state === 'RUNNING'
      ? 'already_running'
      : Number(existing?.attempts || 0) >= maximumAttempts
        ? 'attempts_exhausted' : 'retry_wait';
  return { claimed: false, analysisDate, reason, existing };
}

export function finishDailyCycleClaim(db, options) {
  const timestamp = (options.now instanceof Date
    ? options.now : new Date(options.now || Date.now())).toISOString();
  const completed = ['SUCCESS', 'DEGRADED'].includes(options.resultStatus);
  const result = db.prepare(`
    UPDATE daily_cycle_claims SET
      state = ?, updated_at = ?, completed_at = ?, job_run_id = ?,
      result_status = ?, error_message = ?
    WHERE analysis_date = ? AND claim_token = ? AND state = 'RUNNING'
  `).run(
    completed ? 'COMPLETED' : 'FAILED', timestamp, completed ? timestamp : null,
    options.jobRunId || null, options.resultStatus || 'FAILED', options.error || null,
    options.analysisDate, options.token
  );
  return Number(result.changes) === 1;
}

export function heartbeatDailyCycleClaim(db, options) {
  const timestamp = (options.now instanceof Date
    ? options.now : new Date(options.now || Date.now())).toISOString();
  const result = db.prepare(`
    UPDATE daily_cycle_claims SET claimed_at = ?, updated_at = ?
    WHERE analysis_date = ? AND claim_token = ? AND state = 'RUNNING'
  `).run(timestamp, timestamp, options.analysisDate, options.token);
  return Number(result.changes) === 1;
}

export function dailyCycleAutomationStatus(db, expectedDate, options = {}) {
  const latest = toPlain(db.prepare(`
    SELECT * FROM daily_cycle_claims ORDER BY analysis_date DESC LIMIT 1
  `).get());
  const expectedClaim = expectedDate ? toPlain(db.prepare(`
    SELECT * FROM daily_cycle_claims WHERE analysis_date = ?
  `).get(expectedDate)) : null;
  const completedDates = automaticCompletionDates(db);
  const expectedCompleted = expectedDate ? completedDates.has(expectedDate) : false;
  const missingDates = expectedDate
    ? missingDailyCycleDates(db, expectedDate, options.catchupLimit || 5) : [];
  let status = expectedCompleted ? 'CURRENT' : 'MISSING';
  if (!expectedCompleted && expectedClaim?.state === 'RUNNING') status = 'RUNNING';
  if (!expectedCompleted && expectedClaim?.state === 'FAILED') status = 'FAILED';
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const runningAgeMinutes = expectedClaim?.state === 'RUNNING'
    ? Math.max(0, (now.getTime() - new Date(expectedClaim.claimed_at).getTime()) / 60_000)
    : null;
  const maximumAttempts = Math.max(1, Number(options.maximumAttempts) || 3);
  return {
    version: DAILY_CYCLE_AUTOMATION_VERSION,
    expectedDate, status, expectedCompleted, missingDates, latest,
    maximumAttempts,
    attemptsExhausted: !expectedCompleted && expectedClaim?.state === 'FAILED' &&
      expectedClaim.attempts >= maximumAttempts,
    runningAgeMinutes,
    orphanedClaim: expectedCompleted && expectedClaim?.state !== 'COMPLETED'
  };
}
