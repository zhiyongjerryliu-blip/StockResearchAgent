import { nowIso, toPlain, toPlainRows } from './db.js';
import { PREDICTION_MODEL_VERSION } from './predictions.js';

export const DAILY_OPERATIONS_VERSION = 'daily-operations-v1-2026-09-06';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizedTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  if (!ticker) return null;
  if (!/^[A-Z0-9.^-]{1,15}$/.test(ticker)) throw new Error(`股票代码格式无效：${value}`);
  return ticker;
}

function dateDistance(left, right) {
  if (!left || !right) return null;
  return Math.round((new Date(`${right}T00:00:00.000Z`) - new Date(`${left}T00:00:00.000Z`)) / 86_400_000);
}

function resultItems(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.results)) return result.results;
  if (Array.isArray(result?.stockReviews)) return result.stockReviews.map((item) => ({ ...item, ok: true }));
  return result == null ? [] : [result];
}

export function summarizeStepResult(result) {
  const items = resultItems(result);
  const failed = items.filter((item) => item?.ok === false);
  const nestedSources = items.flatMap((item) => item?.sources || item?.sourceResults || []);
  const failedSources = nestedSources.filter((item) => item?.ok === false && !item?.skipped);
  const skipped = Boolean(result?.skipped);
  const explicitlyDegraded = ['ATTENTION', 'WARNING', 'DEGRADED'].includes(result?.status);
  const itemTotal = items.length + nestedSources.length;
  const itemFailed = failed.length + failedSources.length;
  return {
    status: skipped ? 'SKIPPED' : itemFailed || explicitlyDegraded ? 'DEGRADED' : 'SUCCESS',
    itemTotal,
    itemSucceeded: skipped ? 0 : itemTotal - itemFailed,
    itemFailed,
    errors: [
      ...failed.map((item) => ({ ticker: item.ticker || null, error: item.error || '未知错误' })),
      ...failedSources.map((item) => ({
        ticker: item.ticker || null, provider: item.provider || null,
        error: item.error || '来源同步失败'
      }))
    ].slice(0, 20)
  };
}

function compactStepResult(result) {
  if (result == null || typeof result !== 'object') return result;
  const summaryFields = [
    'provider', 'skipped', 'reason', 'error', 'asOf', 'reviewDate', 'analysisDate',
    'status', 'counts', 'positions', 'version'
  ];
  const compact = Object.fromEntries(summaryFields
    .filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
  if (Array.isArray(result.results)) {
    compact.results = result.results.map((item) => {
      const value = Object.fromEntries([
        'ticker', 'role', 'ok', 'skipped', 'error', 'count', 'filingCount', 'factCount',
        'qualityStatus', 'articles', 'newLinks'
      ].filter((key) => item?.[key] !== undefined).map((key) => [key, item[key]]));
      if (Array.isArray(item?.sources)) value.sources = item.sources.map((source) => ({
        provider: source.provider, ok: source.ok, skipped: source.skipped,
        count: source.count, error: source.error
      }));
      return value;
    });
  }
  if (Array.isArray(result.checks)) {
    compact.checks = result.checks.map((item) => ({
      ticker: item.ticker || null, sourceKey: item.sourceKey,
      checkKey: item.checkKey, status: item.status, message: item.message
    }));
  }
  return Object.keys(compact).length ? compact : { completed: true };
}

export async function runRecordedStep(db, jobRunId, spec) {
  const attempts = Math.max(1, Number(spec.maxAttempts) || 1);
  let lastResult = null;
  let lastSummary = null;
  let lastError = null;
  let actualAttempts = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    actualAttempts = attempt;
    const startedAt = nowIso();
    const inserted = db.prepare(`
      INSERT INTO job_step_runs (
        job_run_id, step_key, step_label, analysis_date, ticker, attempt,
        status, started_at, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, '{}')
    `).run(
      jobRunId, spec.key, spec.label, spec.analysisDate || null,
      normalizedTicker(spec.ticker), attempt, startedAt
    );
    const stepRunId = Number(inserted.lastInsertRowid);
    try {
      lastResult = await spec.run();
      lastError = null;
      lastSummary = summarizeStepResult(lastResult);
      db.prepare(`
        UPDATE job_step_runs SET finished_at = ?, status = ?, item_total = ?,
          item_succeeded = ?, item_failed = ?, details_json = ? WHERE id = ?
      `).run(
        nowIso(), lastSummary.status, lastSummary.itemTotal,
        lastSummary.itemSucceeded, lastSummary.itemFailed,
        JSON.stringify({ result: compactStepResult(lastResult), errors: lastSummary.errors }), stepRunId
      );
      if (lastSummary.status !== 'DEGRADED' || attempt === attempts) break;
    } catch (error) {
      lastError = error;
      lastSummary = {
        status: 'FAILED', itemTotal: 1, itemSucceeded: 0, itemFailed: 1,
        errors: [{ ticker: normalizedTicker(spec.ticker), error: error.message }]
      };
      db.prepare(`
        UPDATE job_step_runs SET finished_at = ?, status = 'FAILED', item_total = 1,
          item_failed = 1, error_message = ?, details_json = ? WHERE id = ?
      `).run(nowIso(), error.message, JSON.stringify({ error: error.message }), stepRunId);
      if (attempt === attempts) break;
    }
    if (spec.retryDelayMs) await sleep(spec.retryDelayMs * attempt);
  }
  return {
    key: spec.key, label: spec.label,
    status: lastSummary?.status || 'FAILED', attempts: actualAttempts,
    result: lastResult, summary: lastSummary,
    error: lastError?.message || null
  };
}

function enabledTickers(db, ticker = null) {
  if (ticker) {
    const normalized = normalizedTicker(ticker);
    const exists = db.prepare(
      'SELECT ticker FROM watchlist_items WHERE ticker = ? AND enabled = 1'
    ).get(normalized);
    if (!exists) throw new Error(`股票池中没有启用的股票：${normalized}`);
    return [normalized];
  }
  return toPlainRows(db.prepare(
    'SELECT ticker FROM watchlist_items WHERE enabled = 1 ORDER BY ticker'
  ).all()).map((item) => item.ticker);
}

function saveCheck(db, jobRunId, check) {
  const result = db.prepare(`
    INSERT INTO data_quality_checks (
      job_run_id, analysis_date, ticker, source_key, check_key, status,
      expected_date, actual_date, message, details_json, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobRunId || null, check.analysisDate, check.ticker || null,
    check.sourceKey, check.checkKey, check.status,
    check.expectedDate || null, check.actualDate || null, check.message,
    JSON.stringify(check.details || {}), nowIso()
  );
  return { id: Number(result.lastInsertRowid), ...check };
}

function dailyPriceCheck(db, ticker, analysisDate) {
  const rows = toPlainRows(db.prepare(`
    SELECT trade_date, open, high, low, close, volume, provider, available_at
    FROM prices_daily WHERE ticker = ? AND trade_date <= ?
    ORDER BY trade_date DESC, CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
  `).all(ticker, analysisDate));
  const latest = rows[0];
  if (!latest) return {
    analysisDate, ticker, sourceKey: 'MARKET', checkKey: 'DAILY_PRICE', status: 'MISSING',
    expectedDate: analysisDate, message: `${ticker} 缺少日线行情。`
  };
  const sameDate = rows.filter((row) => row.trade_date === latest.trade_date);
  const closes = sameDate.map((row) => Number(row.close)).filter(Number.isFinite);
  const spread = closes.length > 1 && Math.min(...closes) > 0
    ? (Math.max(...closes) - Math.min(...closes)) / Math.min(...closes) : 0;
  const invalidOhlc = !Number.isFinite(Number(latest.close)) || Number(latest.close) <= 0 ||
    (Number.isFinite(Number(latest.low)) && Number(latest.low) > Number(latest.close)) ||
    (Number.isFinite(Number(latest.high)) && Number(latest.high) < Number(latest.close)) ||
    (Number.isFinite(Number(latest.volume)) && Number(latest.volume) < 0);
  if (invalidOhlc || spread > 0.001) return {
    analysisDate, ticker, sourceKey: 'MARKET', checkKey: 'DAILY_PRICE', status: 'INCONSISTENT',
    expectedDate: analysisDate, actualDate: latest.trade_date,
    message: invalidOhlc
      ? `${ticker} 日线OHLC或成交量字段不自洽。`
      : `${ticker} 同日不同Provider收盘价差异超过0.1%。`,
    details: { providers: sameDate.map((row) => ({ provider: row.provider, close: row.close })), spread }
  };
  const current = latest.trade_date === analysisDate;
  return {
    analysisDate, ticker, sourceKey: 'MARKET', checkKey: 'DAILY_PRICE',
    status: current ? 'CURRENT' : 'STALE', expectedDate: analysisDate, actualDate: latest.trade_date,
    message: current ? `${ticker} 日线已更新至预期交易日。` : `${ticker} 日线滞后于预期交易日。`,
    details: { provider: latest.provider, availableAt: latest.available_at }
  };
}

function syncStatusCheck(db, ticker, analysisDate, sourceKey, table, dateColumn, errorColumn = null) {
  const row = toPlain(db.prepare(
    `SELECT ${dateColumn} AS actual_date${errorColumn ? `, ${errorColumn} AS error_message` : ''} ` +
    `FROM ${table} WHERE ticker = ?`
  ).get(ticker));
  if (!row) return {
    analysisDate, ticker, sourceKey, checkKey: 'SYNC_STATUS', status: 'MISSING',
    expectedDate: analysisDate, message: `${ticker} 尚无${sourceKey}同步记录。`
  };
  if (row.error_message) return {
    analysisDate, ticker, sourceKey, checkKey: 'SYNC_STATUS', status: 'DEGRADED',
    expectedDate: analysisDate, actualDate: row.actual_date?.slice(0, 10) || null,
    message: `${ticker} ${sourceKey}最近同步失败：${row.error_message}`
  };
  if (!row.actual_date) return {
    analysisDate, ticker, sourceKey, checkKey: 'SYNC_STATUS', status: 'MISSING',
    expectedDate: analysisDate, message: `${ticker} ${sourceKey}同步记录没有有效日期。`
  };
  if (sourceKey === 'NEWS' && row.actual_date.slice(0, 10) < analysisDate) return {
    analysisDate, ticker, sourceKey, checkKey: 'SYNC_STATUS', status: 'STALE',
    expectedDate: analysisDate, actualDate: row.actual_date.slice(0, 10),
    message: `${ticker} NEWS同步日期滞后于分析日。`
  };
  return {
    analysisDate, ticker, sourceKey, checkKey: 'SYNC_STATUS', status: 'CURRENT',
    expectedDate: analysisDate, actualDate: row.actual_date?.slice(0, 10) || null,
    message: `${ticker} ${sourceKey}同步状态正常。`
  };
}

function datedTableCheck(db, ticker, analysisDate, sourceKey, table, dateColumn, minimumRows = 1) {
  const row = toPlain(db.prepare(
    `SELECT MAX(${dateColumn}) AS actual_date, COUNT(*) AS row_count FROM ${table} ` +
    `WHERE ticker = ? AND ${dateColumn} = ?`
  ).get(ticker, analysisDate));
  const count = Number(row?.row_count || 0);
  return {
    analysisDate, ticker, sourceKey, checkKey: 'DAILY_OUTPUT',
    status: count >= minimumRows ? 'CURRENT' : 'MISSING',
    expectedDate: analysisDate, actualDate: row?.actual_date || null,
    message: count >= minimumRows
      ? `${ticker} ${sourceKey}已生成${count}条当日记录。`
      : `${ticker} ${sourceKey}缺少${analysisDate}的结果。`,
    details: { rowCount: count, minimumRows }
  };
}

export function collectDailyDataQuality(db, options) {
  const analysisDate = options.analysisDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(analysisDate || '')) throw new Error('数据质量检查需要有效交易日期');
  const tickers = enabledTickers(db, options.ticker);
  const checks = [];
  for (const ticker of tickers) {
    checks.push(dailyPriceCheck(db, ticker, analysisDate));
    checks.push(syncStatusCheck(
      db, ticker, analysisDate, 'SEC', 'sec_sync_status', 'last_synced_at', 'last_error'
    ));
    checks.push(syncStatusCheck(
      db, ticker, analysisDate, 'NEWS', 'news_sync_status', 'last_as_of', 'last_error'
    ));
    const estimate = toPlain(db.prepare(`
      SELECT as_of, quality_status FROM earnings_estimates
      WHERE ticker = ? AND as_of <= ? ORDER BY as_of DESC, id DESC LIMIT 1
    `).get(ticker, analysisDate));
    if (!estimate) {
      checks.push({
        analysisDate, ticker, sourceKey: 'EARNINGS', checkKey: 'NTM_EPS', status: 'MISSING',
        expectedDate: analysisDate, message: `${ticker} 缺少NTM EPS预期。`
      });
    } else {
      const age = dateDistance(estimate.as_of, analysisDate);
      checks.push({
        analysisDate, ticker, sourceKey: 'EARNINGS', checkKey: 'NTM_EPS',
        status: age > 45 ? 'STALE' : estimate.quality_status === 'INSUFFICIENT' ? 'DEGRADED' : 'CURRENT',
        expectedDate: analysisDate, actualDate: estimate.as_of,
        message: age > 45 ? `${ticker} NTM EPS预期已超过45天未更新。` : `${ticker} NTM EPS预期可用。`,
        details: { ageDays: age, qualityStatus: estimate.quality_status }
      });
    }
    checks.push(datedTableCheck(db, ticker, analysisDate, 'CAPITAL_FLOW', 'capital_flow_snapshots', 'as_of'));
    checks.push(datedTableCheck(db, ticker, analysisDate, 'CAPITAL_BEHAVIOR', 'capital_behavior_snapshots', 'as_of'));
    checks.push(datedTableCheck(db, ticker, analysisDate, 'PREDICTIONS', 'predictions', 'as_of', 3));
    const selectedPredictions = [21, 63, 126].flatMap((horizonDays) => {
      const selection = db.prepare(`
        SELECT selected_model_version FROM prediction_model_evaluations
        WHERE ticker = ? AND horizon_days = ? AND as_of <= ?
        ORDER BY as_of DESC LIMIT 1
      `).get(ticker, horizonDays, analysisDate);
      const row = db.prepare(`
        SELECT publication_status FROM predictions
        WHERE ticker = ? AND as_of = ? AND horizon_days = ? AND model_version = ?
        ORDER BY id DESC LIMIT 1
      `).get(
        ticker, analysisDate, horizonDays,
        selection?.selected_model_version || PREDICTION_MODEL_VERSION
      );
      return row ? [{ horizonDays, publicationStatus: row.publication_status }] : [];
    });
    if (selectedPredictions.length) {
      const publication = selectedPredictions.reduce((counts, row) => {
        counts[row.publicationStatus] = (counts[row.publicationStatus] || 0) + 1;
        return counts;
      }, {});
      checks.push({
        analysisDate, ticker, sourceKey: 'PREDICTIONS', checkKey: 'PUBLICATION_GATE',
        status: 'CURRENT', expectedDate: analysisDate, actualDate: analysisDate,
        message: `${ticker} 正式发布${publication.PUBLISHED || 0}条，观察/样本不足${(publication.OBSERVE || 0) + (publication.INSUFFICIENT || 0)}条。`,
        details: { counts: publication, horizons: selectedPredictions }
      });
    }
    checks.push(datedTableCheck(db, ticker, analysisDate, 'ADVICE', 'investment_advice_snapshots', 'as_of', 3));
    if (options.futuEnabled) {
      const intraday = toPlain(db.prepare(`
        SELECT trade_date, confidence, signal FROM intraday_flow_snapshots
        WHERE ticker = ? AND trade_date = ? ORDER BY as_of_minute DESC LIMIT 1
      `).get(ticker, analysisDate));
      checks.push({
        analysisDate, ticker, sourceKey: 'FUTU', checkKey: 'INTRADAY_FLOW',
        status: intraday ? (Number(intraday.confidence) >= 60 ? 'CURRENT' : 'DEGRADED') : 'MISSING',
        expectedDate: analysisDate, actualDate: intraday?.trade_date || null,
        message: intraday
          ? `${ticker} 富途分钟资金数据置信度${Number(intraday.confidence).toFixed(0)}分。`
          : `${ticker} 缺少${analysisDate}的富途分钟资金快照。`,
        details: intraday || {}
      });
    }
    const position = Number(db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END), 0) AS quantity
      FROM transactions WHERE ticker = ? AND date(trade_time) <= date(?)
    `).get(ticker, analysisDate)?.quantity || 0);
    if (position > 0) {
      checks.push(datedTableCheck(db, ticker, analysisDate, 'DAILY_REVIEW', 'daily_reviews', 'review_date'));
    }
  }
  const marketContext = toPlain(db.prepare(
    'SELECT as_of FROM macro_market_snapshots WHERE as_of = ?'
  ).get(analysisDate));
  checks.push({
    analysisDate, ticker: null, sourceKey: 'MACRO', checkKey: 'MARKET_CONTEXT',
    status: marketContext ? 'CURRENT' : 'MISSING', expectedDate: analysisDate,
    actualDate: marketContext?.as_of || null,
    message: marketContext ? '宏观市场快照已生成。' : `${analysisDate}缺少宏观市场快照。`
  });
  const saved = checks.map((check) => saveCheck(db, options.jobRunId, check));
  const counts = saved.reduce((summary, check) => {
    summary[check.status] = (summary[check.status] || 0) + 1;
    return summary;
  }, {});
  return {
    version: DAILY_OPERATIONS_VERSION, analysisDate, ticker: normalizedTicker(options.ticker),
    status: (counts.INCONSISTENT || counts.MISSING) ? 'ATTENTION'
      : (counts.STALE || counts.DEGRADED) ? 'WARNING' : 'HEALTHY',
    counts, checks: saved
  };
}

function hydrateStep(row) {
  return {
    ...row,
    details: parseJson(row.details_json, {}),
    durationMs: row.finished_at
      ? Math.max(0, new Date(row.finished_at) - new Date(row.started_at)) : null
  };
}

function compactJobDetails(value) {
  const details = parseJson(value, {});
  return Object.fromEntries([
    'version', 'reviewDate', 'ticker', 'trigger', 'positions', 'qualityStatus', 'error', 'steps'
  ].filter((key) => details[key] !== undefined).map((key) => [key, details[key]]));
}

export function getDailyOperation(db, jobRunId) {
  const run = toPlain(db.prepare(
    "SELECT * FROM job_runs WHERE id = ? AND job_name = 'daily-cycle'"
  ).get(jobRunId));
  if (!run) return null;
  const { details_json: detailsJson, ...runFields } = run;
  const steps = toPlainRows(db.prepare(
    'SELECT * FROM job_step_runs WHERE job_run_id = ? ORDER BY id'
  ).all(jobRunId)).map(hydrateStep);
  const quality = toPlainRows(db.prepare(
    'SELECT * FROM data_quality_checks WHERE job_run_id = ? ORDER BY ticker, source_key, check_key, id'
  ).all(jobRunId)).map((row) => ({ ...row, details: parseJson(row.details_json, {}) }));
  return { ...runFields, details: compactJobDetails(detailsJson), steps, quality };
}

export function getDailyOperationsCenter(db, limit = 20) {
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const runs = toPlainRows(db.prepare(`
    SELECT * FROM job_runs WHERE job_name = 'daily-cycle' ORDER BY id DESC LIMIT ?
  `).all(boundedLimit)).map((run) => {
    const { details_json: detailsJson, ...runFields } = run;
    const counts = toPlainRows(db.prepare(`
      SELECT status, COUNT(*) AS count FROM job_step_runs
      WHERE job_run_id = ? GROUP BY status
    `).all(run.id)).reduce((result, item) => ({ ...result, [item.status]: Number(item.count) }), {});
    return { ...runFields, details: compactJobDetails(detailsJson), stepCounts: counts };
  });
  return {
    version: DAILY_OPERATIONS_VERSION,
    summary: {
      totalRuns: runs.length,
      successfulRuns: runs.filter((run) => run.status === 'SUCCESS').length,
      degradedRuns: runs.filter((run) => run.status === 'DEGRADED').length,
      failedRuns: runs.filter((run) => run.status === 'FAILED').length
    },
    runs,
    latest: runs[0] ? getDailyOperation(db, runs[0].id) : null
  };
}
