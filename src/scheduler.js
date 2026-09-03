import { nowIso } from './db.js';
import { refreshWatchlistPrices } from './market.js';
import { saveDailySnapshots } from './portfolio.js';
import { generateDailyReviews, refreshDailyReviewsIfNeeded } from './reviews.js';
import { createNotification } from './notifications.js';
import { syncSecWatchlist } from './sec.js';
import { syncWatchlistEarningsEstimates } from './earnings-estimates.js';
import { syncWatchlistNews } from './news.js';
import { syncMarketContext } from './market-context.js';
import { latestStableUsMarketDate } from './trading-calendar.js';
import { saveWatchlistAdvice } from './advice.js';
import { notifyVolumeAnomalies, saveWatchlistCapitalFlow } from './capital-flow.js';
import {
  notifyIntradayFlowAnomalies, saveWatchlistIntradayFlow
} from './intraday-flow.js';

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

export async function runDailyCycle(
  db, provider, date = new Date(), secProvider = null, earningsProvider = null,
  newsProvider = null
) {
  const startedAt = nowIso();
  const result = db.prepare(`
    INSERT INTO job_runs (job_name, started_at, status, details_json)
    VALUES ('daily-cycle', ?, 'RUNNING', '{}')
  `).run(startedAt);
  const jobId = Number(result.lastInsertRowid);
  try {
    const sec = await syncSecWatchlist(db, secProvider);
    const market = await refreshWatchlistPrices(db, provider);
    const reviewDate = latestStableUsMarketDate(date);
    const marketContext = await syncMarketContext(db, provider, reviewDate);
    const earnings = await syncWatchlistEarningsEstimates(db, earningsProvider, reviewDate);
    const news = await syncWatchlistNews(db, newsProvider, reviewDate);
    const capitalFlow = saveWatchlistCapitalFlow(db, reviewDate);
    for (const result of capitalFlow) {
      if (!result.ok) continue;
      result.volumeNotifications = await notifyVolumeAnomalies(db, result.analysis);
    }
    const intradayFlow = saveWatchlistIntradayFlow(db, reviewDate);
    for (const result of intradayFlow) {
      if (!result.ok || !result.analysis.asOf) continue;
      result.notifications = await notifyIntradayFlowAnomalies(db, result.analysis);
    }
    const advice = saveWatchlistAdvice(db, reviewDate);
    const portfolio = saveDailySnapshots(db, reviewDate);
    const reviews = await generateDailyReviews(db, reviewDate);
    const details = {
      market, marketContext, sec, earnings, news, capitalFlow, intradayFlow, advice, reviewDate,
      positions: portfolio.positions.length
    };
    db.prepare(`
      UPDATE job_runs SET finished_at = ?, status = 'SUCCESS', details_json = ? WHERE id = ?
    `).run(nowIso(), JSON.stringify(details), jobId);
    await createNotification(db, {
      severity: 'INFO',
      category: 'DAILY_REVIEW',
      title: '美股收盘复盘已完成',
      body: `${reviewDate} 的 ${portfolio.positions.length} 只股票复盘已生成。`
    });
    return { ...details, reviews };
  } catch (error) {
    db.prepare(`
      UPDATE job_runs SET finished_at = ?, status = 'FAILED', details_json = ? WHERE id = ?
    `).run(nowIso(), JSON.stringify({ error: error.message }), jobId);
    throw error;
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
      runDailyCycle(db, provider, new Date(), secProvider, earningsProvider, newsProvider).catch((error) => {
        console.error('日终任务失败：', error.message);
        lastDailyDate = null;
      });
    }
  }, 60_000);
  timers.push(dailyTimer);

  return () => timers.forEach(clearInterval);
}
