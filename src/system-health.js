import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';
import { nowIso, toPlainRows } from './db.js';
import { createNotification } from './notifications.js';
import { pruneIntradayTicks } from './intraday-flow.js';

export const SYSTEM_HEALTH_VERSION = 'system-health-v1-2026-09-05';

function fileBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function databaseFiles(databasePath) {
  if (!databasePath || databasePath === ':memory:') {
    return { databaseBytes: 0, walBytes: 0, shmBytes: 0, totalBytes: 0 };
  }
  const databaseBytes = fileBytes(databasePath);
  const walBytes = fileBytes(databasePath + '-wal');
  const shmBytes = fileBytes(databasePath + '-shm');
  return { databaseBytes, walBytes, shmBytes, totalBytes: databaseBytes + walBytes + shmBytes };
}

function setting(db, key) {
  const row = db.prepare('SELECT value_json, updated_at FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value_json), updatedAt: row.updated_at };
  } catch {
    return { value: null, updatedAt: row.updated_at };
  }
}

function saveSetting(db, key, value) {
  const updatedAt = nowIso();
  db.prepare(
    'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at'
  ).run(key, JSON.stringify(value), updatedAt);
  return { value, updatedAt };
}

function localDate(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + '-' + values.month + '-' + values.day;
}

function listBackups(databasePath, backupDirectory) {
  if (!databasePath || databasePath === ':memory:' || !fs.existsSync(backupDirectory)) return [];
  const base = path.basename(databasePath, path.extname(databasePath));
  return fs.readdirSync(backupDirectory)
    .filter((name) => name.startsWith(base + '-') && name.endsWith('.sqlite'))
    .map((name) => {
      const filePath = path.join(backupDirectory, name);
      const stat = fs.statSync(filePath);
      return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((left, right) => right.name.localeCompare(left.name));
}

export function collectSystemStatus(db, options = {}) {
  const databasePath = options.databasePath || ':memory:';
  const databaseWarningBytes = options.databaseWarningBytes || 512 * 1024 * 1024;
  const backupDirectory = options.backupDirectory || (
    databasePath === ':memory:' ? '' : path.join(path.dirname(databasePath), 'backups')
  );
  const expectedMarketDate = options.expectedMarketDate || null;
  const files = databaseFiles(databasePath);
  const maintenance = setting(db, 'system:last_maintenance');
  const watchlist = toPlainRows(db.prepare(
    'SELECT watch.ticker, ' +
    '(SELECT MAX(price.trade_date) FROM prices_daily AS price WHERE price.ticker = watch.ticker) AS latest_daily_date, ' +
    '(SELECT COUNT(*) FROM prices_daily AS price WHERE price.ticker = watch.ticker) AS daily_rows, ' +
    '(SELECT MAX(bar.bar_time_et) FROM prices_intraday AS bar WHERE bar.ticker = watch.ticker AND COALESCE(bar.volume, 0) > 0) AS latest_intraday_at, ' +
    '(SELECT MAX(tick.trade_time_et) FROM ticks_intraday AS tick WHERE tick.ticker = watch.ticker) AS latest_tick_at ' +
    'FROM watchlist_items AS watch WHERE watch.enabled = 1 ORDER BY watch.ticker'
  ).all()).map((item) => ({
    ...item,
    dailyStatus: !item.latest_daily_date
      ? 'MISSING'
      : expectedMarketDate && item.latest_daily_date < expectedMarketDate ? 'STALE' : 'CURRENT'
  }));
  const jobs = toPlainRows(db.prepare(
    'SELECT id, job_name, started_at, finished_at, status ' +
    'FROM job_runs ORDER BY id DESC LIMIT 10'
  ).all());
  const rowCounts = {};
  for (const table of [
    'prices_daily', 'prices_intraday', 'ticks_intraday', 'intraday_tick_minutes',
    'intraday_flow_snapshots', 'capital_behavior_snapshots', 'capital_behavior_validation',
    'news_articles', 'financial_facts', 'prediction_backtest_results'
  ]) {
    rowCounts[table] = Number(db.prepare('SELECT COUNT(*) AS count FROM ' + table).get()?.count || 0);
  }
  const issues = [];
  if (files.totalBytes >= databaseWarningBytes) {
    issues.push({
      code: 'DATABASE_CAPACITY', severity: 'P2',
      message: '数据库及WAL占用已达到 ' + (files.totalBytes / 1024 / 1024).toFixed(1) + ' MB'
    });
  }
  if (options.futu?.enabled && options.futu.collector?.status !== 'connected') {
    issues.push({
      code: 'FUTU_DISCONNECTED', severity: 'P1',
      message: '富途采集器状态为 ' + (options.futu.collector?.status || 'unknown')
    });
  }
  for (const item of watchlist.filter((entry) => entry.dailyStatus !== 'CURRENT')) {
    issues.push({
      code: item.dailyStatus === 'MISSING' ? 'DAILY_PRICE_MISSING' : 'DAILY_PRICE_STALE',
      severity: 'P1', ticker: item.ticker,
      message: item.latest_daily_date
        ? item.ticker + ' 最新完整日线为 ' + item.latest_daily_date + '，预期为 ' + expectedMarketDate
        : item.ticker + ' 尚无完整日线'
    });
  }
  const integrity = maintenance?.value?.integrity || null;
  if (integrity && integrity !== 'ok') {
    issues.push({ code: 'DATABASE_INTEGRITY', severity: 'P0', message: '数据库完整性检查：' + integrity });
  }
  const status = issues.some((issue) => ['P0', 'P1'].includes(issue.severity))
    ? 'ATTENTION' : issues.length ? 'WARNING' : 'HEALTHY';
  const memory = process.memoryUsage();
  return {
    version: SYSTEM_HEALTH_VERSION,
    checkedAt: nowIso(),
    status,
    startedAt: options.startedAt || null,
    uptimeSeconds: Math.round(process.uptime()),
    process: {
      pid: process.pid, node: process.version,
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal
    },
    database: {
      path: databasePath, ...files,
      warningBytes: databaseWarningBytes, rowCounts
    },
    backup: {
      directory: backupDirectory,
      retentionCount: options.backupRetentionCount || 7,
      files: listBackups(databasePath, backupDirectory)
    },
    expectedMarketDate,
    watchlist,
    futu: options.futu || null,
    futuRecovery: options.futuRecovery || null,
    jobs,
    maintenance,
    issues
  };
}

async function createDailyBackup(db, options, date = new Date()) {
  const databasePath = options.databasePath;
  if (!databasePath || databasePath === ':memory:') {
    return { skipped: true, reason: 'memory_database' };
  }
  const backupDirectory = options.backupDirectory || path.join(path.dirname(databasePath), 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const base = path.basename(databasePath, path.extname(databasePath));
  const day = localDate(options.timezone, date);
  const destination = path.join(backupDirectory, base + '-' + day + '.sqlite');
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    return { skipped: true, reason: 'already_backed_up_today', name: path.basename(destination) };
  }
  const temporary = destination + '.tmp-' + process.pid;
  try {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    await backup(db, temporary);
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  const retentionCount = Math.max(1, Number(options.backupRetentionCount || 7));
  const files = listBackups(databasePath, backupDirectory);
  const removed = [];
  for (const old of files.slice(retentionCount)) {
    fs.unlinkSync(path.join(backupDirectory, old.name));
    removed.push(old.name);
  }
  return {
    skipped: false,
    name: path.basename(destination),
    sizeBytes: fs.statSync(destination).size,
    removed
  };
}

async function notifyCapacityIfNeeded(db, options, totalBytes) {
  const warningBytes = options.databaseWarningBytes || 512 * 1024 * 1024;
  if (totalBytes < warningBytes) return null;
  const today = localDate(options.timezone);
  const lastAlert = setting(db, 'system:last_capacity_alert');
  if (lastAlert?.value?.date === today) return null;
  const notification = await createNotification(db, {
    severity: 'P2',
    category: 'DATABASE_CAPACITY',
    title: '研究数据库容量提醒',
    body: '数据库及WAL当前占用 ' + (totalBytes / 1024 / 1024).toFixed(1) +
      ' MB，请检查逐笔数据保留周期和备份空间。系统不会自动删除未过期研究数据。'
  });
  saveSetting(db, 'system:last_capacity_alert', { date: today, totalBytes });
  return notification;
}

export async function runSystemMaintenance(db, options = {}) {
  const startedAt = nowIso();
  const jobResult = db.prepare(
    "INSERT INTO job_runs (job_name, started_at, status, details_json) " +
    "VALUES ('system-maintenance', ?, 'RUNNING', '{}')"
  ).run(startedAt);
  const jobId = Number(jobResult.lastInsertRowid);
  try {
    const prunedTicks = pruneIntradayTicks(db, options.tickRetentionDays || 7);
    const integrityRow = db.prepare('PRAGMA quick_check').get();
    const integrity = integrityRow?.quick_check || Object.values(integrityRow || {})[0] || 'unknown';
    const checkpoint = toPlainRows(db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all())[0] || {};
    db.exec('PRAGMA optimize');
    const backupResult = await createDailyBackup(db, options);
    const files = databaseFiles(options.databasePath);
    const capacityNotification = await notifyCapacityIfNeeded(db, options, files.totalBytes);
    const result = {
      completedAt: nowIso(),
      maintenanceDate: localDate(options.timezone),
      integrity, prunedTicks, checkpoint,
      backup: backupResult, database: files,
      capacityNotificationId: capacityNotification?.id || null
    };
    saveSetting(db, 'system:last_maintenance', result);
    const health = collectSystemStatus(db, options);
    db.prepare(
      'INSERT INTO system_health_snapshots ' +
      '(check_date, checked_at, expected_market_date, status, summary_json, issues_json, model_version) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(check_date) DO UPDATE SET checked_at = excluded.checked_at, ' +
      'expected_market_date = excluded.expected_market_date, status = excluded.status, ' +
      'summary_json = excluded.summary_json, issues_json = excluded.issues_json, ' +
      'model_version = excluded.model_version'
    ).run(
      result.maintenanceDate, health.checkedAt, health.expectedMarketDate, health.status,
      JSON.stringify({
        database: health.database,
        backup: health.backup.files[0] || null,
        watchlist: health.watchlist,
        futu: health.futu,
        futuRecovery: health.futuRecovery
      }),
      JSON.stringify(health.issues),
      SYSTEM_HEALTH_VERSION
    );
    db.prepare(
      "UPDATE job_runs SET finished_at = ?, status = 'SUCCESS', details_json = ? WHERE id = ?"
    ).run(result.completedAt, JSON.stringify(result), jobId);
    return result;
  } catch (error) {
    db.prepare(
      "UPDATE job_runs SET finished_at = ?, status = 'FAILED', details_json = ? WHERE id = ?"
    ).run(nowIso(), JSON.stringify({ error: error.message }), jobId);
    throw error;
  }
}

export function maintenanceDue(db, timezone, date = new Date()) {
  const last = setting(db, 'system:last_maintenance');
  return last?.value?.maintenanceDate !== localDate(timezone, date);
}
