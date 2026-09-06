import { nowIso } from './db.js';
import { refreshWatchlistPrices, upsertDailyBars } from './market.js';
import { saveDailySnapshots } from './portfolio.js';
import { generateDailyReviews, refreshDailyReviewsIfNeeded } from './reviews.js';
import { createNotification } from './notifications.js';
import { syncSecCompany, syncSecWatchlist } from './sec.js';
import { syncEarningsEstimate, syncWatchlistEarningsEstimates } from './earnings-estimates.js';
import { syncNewsForTicker, syncWatchlistNews } from './news.js';
import { syncMarketContext } from './market-context.js';
import { latestStableUsMarketDate } from './trading-calendar.js';
import { saveInvestmentAdvice, saveWatchlistAdvice } from './advice.js';
import { notifyVolumeAnomalies, saveCapitalFlow, saveWatchlistCapitalFlow } from './capital-flow.js';
import {
  notifyIntradayFlowAnomalies, saveIntradayFlowSnapshot, saveWatchlistIntradayFlow
} from './intraday-flow.js';
import {
  notifyCapitalBehaviorTransition, runCapitalBehaviorBacktest, runWatchlistCapitalBehaviorBacktests
} from './capital-behavior.js';
import { runPredictionBacktest, runWatchlistPredictionBacktests } from './predictions.js';
import { savePortfolioRisk } from './portfolio-risk.js';
import {
  DAILY_OPERATIONS_VERSION, collectDailyDataQuality, runRecordedStep
} from './daily-operations.js';

function etParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short'
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function etDate(date = new Date()) {
  const parts = etParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const activeDailyCycles = new WeakSet();

async function executeDailyCycle(
  db, provider, date = new Date(), secProvider = null, earningsProvider = null,
  newsProvider = null, options = {}
) {
  const startedAt = nowIso();
  const reviewDate = options.analysisDate || latestStableUsMarketDate(date);
  const ticker = options.ticker ? String(options.ticker).trim().toUpperCase() : null;
  if (ticker && !/^[A-Z0-9.^-]{1,15}$/.test(ticker)) throw new Error('股票代码格式无效');
  if (ticker && !db.prepare(
    'SELECT ticker FROM watchlist_items WHERE ticker = ? AND enabled = 1'
  ).get(ticker)) throw new Error(`股票池中没有启用的股票：${ticker}`);
  const trigger = options.trigger || 'MANUAL';
  const syncAttempts = Math.max(1, Number(options.retryAttempts) || 2);
  const result = db.prepare(`
    INSERT INTO job_runs (job_name, started_at, status, details_json)
    VALUES ('daily-cycle', ?, 'RUNNING', ?)
  `).run(startedAt, JSON.stringify({
    version: DAILY_OPERATIONS_VERSION, reviewDate, ticker, trigger
  }));
  const jobId = Number(result.lastInsertRowid);
  const stepResults = [];
  const outputs = {};
  const runStep = async (key, label, run, maxAttempts = 1) => {
    const step = await runRecordedStep(db, jobId, {
      key, label, run, maxAttempts, retryDelayMs: options.retryDelayMs ?? 500,
      analysisDate: reviewDate, ticker
    });
    stepResults.push({
      key: step.key, label: step.label, status: step.status,
      attempts: step.attempts, summary: step.summary, error: step.error
    });
    outputs[key] = step.result;
    return step.result;
  };
  const scopedResult = async (fn) => {
    try {
      return { results: [{ ticker, ok: true, ...(await fn()) }] };
    } catch (error) {
      return { results: [{ ticker, ok: false, error: error.message }] };
    }
  };
  try {
    await runStep('SEC', 'SEC披露同步', async () => {
      if (!ticker) return syncSecWatchlist(db, secProvider);
      if (!secProvider) return { skipped: true, reason: 'provider-unavailable', results: [] };
      try {
        secProvider.assertConfigured();
      } catch (error) {
        return { skipped: true, reason: 'not-configured', error: error.message, results: [] };
      }
      return scopedResult(async () => {
        const synced = await syncSecCompany(db, secProvider, ticker);
        return { filingCount: synced.filingCount, factCount: synced.factCount };
      });
    }, syncAttempts);
    await runStep('MARKET', '日线行情同步', async () => {
      if (!ticker) return refreshWatchlistPrices(db, provider);
      if (!provider) return { skipped: true, reason: 'provider-unavailable', results: [] };
      return scopedResult(async () => {
        const bars = await provider.fetchDaily(ticker);
        return { provider: provider.name, count: upsertDailyBars(db, bars) };
      });
    }, syncAttempts);
    await runStep('MARKET_CONTEXT', '宏观市场同步', () => (
      syncMarketContext(db, provider, reviewDate)
    ), syncAttempts);
    await runStep('EARNINGS', '一致预期同步', async () => {
      if (!ticker) return syncWatchlistEarningsEstimates(db, earningsProvider, reviewDate);
      if (!earningsProvider) return { skipped: true, reason: 'provider-unavailable', results: [] };
      try {
        earningsProvider.assertConfigured();
      } catch (error) {
        return { skipped: true, reason: 'not-configured', error: error.message, results: [] };
      }
      return scopedResult(() => syncEarningsEstimate(db, earningsProvider, ticker, reviewDate));
    }, syncAttempts);
    await runStep('NEWS', '新闻舆情同步', async () => {
      if (!ticker) return syncWatchlistNews(db, newsProvider, reviewDate);
      if (!newsProvider) return { skipped: true, reason: 'provider-unavailable', results: [] };
      try {
        newsProvider.assertConfigured();
      } catch (error) {
        return { skipped: true, reason: 'not-configured', error: error.message, results: [] };
      }
      return scopedResult(() => syncNewsForTicker(db, newsProvider, ticker, reviewDate));
    }, syncAttempts);
    await runStep('CAPITAL_FLOW', '日线资金行为', async () => {
      const capitalFlow = ticker
        ? [await scopedResult(() => saveCapitalFlow(db, ticker, reviewDate)).then((item) => item.results[0])]
        : saveWatchlistCapitalFlow(db, reviewDate);
      for (const item of capitalFlow) {
        if (!item.ok) continue;
        const analysis = item.analysis || item;
        item.volumeNotifications = await notifyVolumeAnomalies(db, analysis);
      }
      return capitalFlow;
    });
    await runStep('INTRADAY_FLOW', '分钟资金行为', async () => {
      const intradayFlow = ticker
        ? [await scopedResult(() => saveIntradayFlowSnapshot(db, ticker, reviewDate)).then((item) => item.results[0])]
        : saveWatchlistIntradayFlow(db, reviewDate);
      for (const item of intradayFlow) {
        const analysis = item.analysis || item;
        if (!item.ok || !analysis.asOf) continue;
        item.notifications = await notifyIntradayFlowAnomalies(db, analysis);
      }
      return intradayFlow;
    });
    await runStep('CAPITAL_BEHAVIOR', '连续资金阶段与验证', async () => {
      const capitalBehavior = ticker
        ? [await scopedResult(() => runCapitalBehaviorBacktest(db, ticker, reviewDate)).then((item) => ({
          ticker, ok: item.ok, error: item.error, result: item.ok ? item : null
        }))]
        : runWatchlistCapitalBehaviorBacktests(db, reviewDate);
      for (const item of capitalBehavior) {
        if (!item.ok || !item.result?.latest) continue;
        item.notifications = await notifyCapitalBehaviorTransition(db, item.result);
      }
      return capitalBehavior;
    });
    await runStep('PREDICTIONS', '预测与历史验证', () => (
      ticker
        ? scopedResult(() => runPredictionBacktest(db, ticker, reviewDate))
        : runWatchlistPredictionBacktests(db, reviewDate)
    ));
    await runStep('ADVICE', '投资建议生成', () => (
      ticker
        ? scopedResult(() => saveInvestmentAdvice(db, ticker, reviewDate))
        : saveWatchlistAdvice(db, reviewDate)
    ));
    const portfolio = await runStep('PORTFOLIO', '持仓快照', () => saveDailySnapshots(db, reviewDate));
    await runStep('PORTFOLIO_RISK', '组合风险复核', () => savePortfolioRisk(db, reviewDate));
    const reviews = await runStep('REVIEWS', '收盘复盘', () => (
      generateDailyReviews(db, reviewDate, { ticker })
    ));
    const quality = await runStep('DATA_QUALITY', '数据质量验收', () => (
      collectDailyDataQuality(db, {
        analysisDate: reviewDate, ticker, jobRunId: jobId,
        futuEnabled: options.futuEnabled ?? false
      })
    ));
    const failed = stepResults.filter((step) => step.status === 'FAILED');
    const degraded = stepResults.filter((step) => step.status === 'DEGRADED');
    const status = failed.length ? 'FAILED' : degraded.length ? 'DEGRADED' : 'SUCCESS';
    const details = {
      version: DAILY_OPERATIONS_VERSION, reviewDate, ticker, trigger,
      positions: portfolio?.positions?.length || 0,
      qualityStatus: quality?.status || null,
      steps: stepResults.map((step) => ({
        key: step.key, status: step.status, attempts: step.attempts,
        itemTotal: step.summary?.itemTotal || 0,
        itemFailed: step.summary?.itemFailed || 0,
        error: step.error
      }))
    };
    db.prepare(`
      UPDATE job_runs SET finished_at = ?, status = ?, details_json = ? WHERE id = ?
    `).run(nowIso(), status, JSON.stringify(details), jobId);
    const scopeLabel = ticker || '全部股票';
    if (options.notify !== false && status === 'SUCCESS') {
      await createNotification(db, {
        severity: 'INFO', category: 'DAILY_REVIEW', title: '美股收盘复盘已完成',
        body: `${reviewDate} 的${scopeLabel}日终流水线已完成。`
      });
    } else if (options.notify !== false) {
      const title = `${reviewDate} 日终任务需要关注（${scopeLabel}）`;
      const existing = db.prepare(`
        SELECT id FROM notifications WHERE category = 'DAILY_CYCLE_STATUS' AND title = ? LIMIT 1
      `).get(title);
      if (!existing) await createNotification(db, {
        severity: failed.length ? 'P1' : 'P2', category: 'DAILY_CYCLE_STATUS', title,
        body: `${failed.length}个步骤失败、${degraded.length}个步骤降级。请在每日运行中心查看数据缺失和重试记录。`,
        evidence: [{ jobRunId: jobId, reviewDate, ticker, failed: failed.map((item) => item.key), degraded: degraded.map((item) => item.key) }]
      });
    }
    return { jobRunId: jobId, status, ...details, outputs, reviews, quality };
  } catch (error) {
    db.prepare(`
      UPDATE job_runs SET finished_at = ?, status = 'FAILED', details_json = ? WHERE id = ?
    `).run(nowIso(), JSON.stringify({
      version: DAILY_OPERATIONS_VERSION, reviewDate, ticker, trigger, error: error.message
    }), jobId);
    if (options.notify !== false) {
      const scopeLabel = ticker || '全部股票';
      const title = `${reviewDate} 日终任务失败（${scopeLabel}）`;
      const existing = db.prepare(`
        SELECT id FROM notifications WHERE category = 'DAILY_CYCLE_STATUS' AND title = ? LIMIT 1
      `).get(title);
      if (!existing) {
        try {
          await createNotification(db, {
            severity: 'P1', category: 'DAILY_CYCLE_STATUS', title,
            body: `日终流水线发生未恢复错误：${error.message}。请在每日运行中心检查后重新运行。`,
            evidence: [{ jobRunId: jobId, reviewDate, ticker, error: error.message }]
          });
        } catch (notificationError) {
          console.error('日终失败通知发送失败：', notificationError.message);
        }
      }
    }
    throw error;
  }
}

export async function runDailyCycle(...args) {
  const db = args[0];
  if (activeDailyCycles.has(db)) throw new Error('日终任务正在运行，请等待当前任务完成');
  activeDailyCycles.add(db);
  try {
    return await executeDailyCycle(...args);
  } finally {
    activeDailyCycles.delete(db);
  }
}

export async function runMarketRefreshCycle(db, provider, date = new Date()) {
  const market = await refreshWatchlistPrices(db, provider);
  const reviewDate = etDate(date);
  const reviewRepair = await refreshDailyReviewsIfNeeded(db, reviewDate);
  return { ...market, reviewRepair };
}

export function startScheduler(
  db, provider, options, secProvider = null, earningsProvider = null, newsProvider = null
) {
  const refreshMs = Math.max(5, options.marketRefreshIntervalMinutes) * 60_000;
  const timers = [];

  const refreshTimer = setInterval(() => {
    runMarketRefreshCycle(db, provider).catch((error) => {
      console.error('定时行情更新失败：', error.message);
    });
  }, refreshMs);
  timers.push(refreshTimer);

  let lastDailyDate = null;
  const dailyTimer = setInterval(() => {
    const parts = etParts();
    const currentDate = `${parts.year}-${parts.month}-${parts.day}`;
    const weekday = parts.weekday;
    if (['Sat', 'Sun'].includes(weekday)) return;
    if (
      Number(parts.hour) === options.dailyReviewHourEt &&
      Number(parts.minute) >= options.dailyReviewMinuteEt &&
      lastDailyDate !== currentDate
    ) {
      lastDailyDate = currentDate;
      runDailyCycle(
        db, provider, new Date(), secProvider, earningsProvider, newsProvider,
        {
          trigger: 'SCHEDULED', futuEnabled: options.futu?.enabled,
          retryAttempts: options.system?.dailyCycleRetryAttempts,
          retryDelayMs: options.system?.dailyCycleRetryDelayMs
        }
      ).catch((error) => {
        console.error('日终任务失败：', error.message);
        lastDailyDate = null;
      });
    }
  }, 60_000);
  timers.push(dailyTimer);

  return () => timers.forEach(clearInterval);
}
