import { nowIso } from './db.js';
import { refreshWatchlistPrices } from './market.js';
import { saveDailySnapshots } from './portfolio.js';
import { generateDailyReviews } from './reviews.js';
import { createNotification } from './notifications.js';

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

export async function runDailyCycle(db, provider, date = new Date()) {
  const startedAt = nowIso();
  const result = db.prepare(`
    INSERT INTO job_runs (job_name, started_at, status, details_json)
    VALUES ('daily-cycle', ?, 'RUNNING', '{}')
  `).run(startedAt);
  const jobId = Number(result.lastInsertRowid);
  try {
    const market = await refreshWatchlistPrices(db, provider);
    const reviewDate = etDate(date);
    const portfolio = saveDailySnapshots(db, reviewDate);
    const reviews = await generateDailyReviews(db, reviewDate);
    const details = { market, reviewDate, positions: portfolio.positions.length };
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

export function startScheduler(db, provider, options) {
  const refreshMs = Math.max(5, options.marketRefreshIntervalMinutes) * 60_000;
  const timers = [];

  const refreshTimer = setInterval(() => {
    refreshWatchlistPrices(db, provider).catch((error) => {
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
      runDailyCycle(db, provider).catch((error) => {
        console.error('日终任务失败：', error.message);
        lastDailyDate = null;
      });
    }
  }, 60_000);
  timers.push(dailyTimer);

  return () => timers.forEach(clearInterval);
}
