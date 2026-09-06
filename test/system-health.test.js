import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db.js';
import {
  collectSystemStatus, maintenanceDue, runSystemMaintenance
} from '../src/system-health.js';
import { claimDailyCycle, finishDailyCycleClaim } from '../src/daily-cycle-automation.js';

function seedWatchlist(db) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO securities (ticker, name, benchmark, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run('TEST', 'Test Company', 'SPY', now, now);
  db.prepare(
    'INSERT INTO watchlist_items (ticker, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)'
  ).run('TEST', now, now);
  db.prepare(
    'INSERT INTO prices_daily (ticker, trade_date, close, provider, available_at, ingested_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?)'
  ).run('TEST', '2026-09-04', 100, 'test', now, now);
}

test('系统状态汇总服务、数据库容量和股票池日线完整度', () => {
  const db = openDatabase(':memory:');
  seedWatchlist(db);
  const status = collectSystemStatus(db, {
    expectedMarketDate: '2026-09-04',
    startedAt: '2026-09-05T00:00:00.000Z',
    databaseWarningBytes: 1024,
    futu: { enabled: true, collector: { status: 'connected' } },
    futuRecovery: { totalAttempts: 0 }
  });
  assert.equal(status.status, 'HEALTHY');
  assert.equal(status.watchlist[0].dailyStatus, 'CURRENT');
  assert.equal(status.database.rowCounts.prices_daily, 1);
  assert.equal(status.futu.collector.status, 'connected');
  db.close();
});

test('每日维护执行完整性检查、清理过期逐笔并幂等备份', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-research-health-'));
  const databasePath = path.join(directory, 'research.sqlite');
  const backupDirectory = path.join(directory, 'backups');
  const db = openDatabase(databasePath);
  seedWatchlist(db);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO ticks_intraday (ticker, sequence, trade_time_et, trade_date, price, volume, turnover, direction, session, provider, ingested_at) ' +
    "VALUES ('TEST', '1', '2026-01-02 10:00:00', '2026-01-02', 100, 1, 100, 'BUY', 'RTH', 'futu', ?)"
  ).run(now);
  const options = {
    databasePath,
    backupDirectory,
    backupRetentionCount: 7,
    databaseWarningBytes: 1024 * 1024 * 1024,
    tickRetentionDays: 7,
    timezone: 'Asia/Shanghai'
  };
  assert.equal(maintenanceDue(db, options.timezone), true);
  const first = await runSystemMaintenance(db, options);
  assert.equal(first.integrity, 'ok');
  assert.equal(first.prunedTicks, 1);
  assert.equal(first.backup.skipped, false);
  assert.equal(fs.existsSync(path.join(backupDirectory, first.backup.name)), true);
  assert.equal(maintenanceDue(db, options.timezone), false);
  const second = await runSystemMaintenance(db, options);
  assert.equal(second.backup.skipped, true);
  assert.equal(second.backup.reason, 'already_backed_up_today');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM job_runs WHERE job_name = 'system-maintenance'").get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM system_health_snapshots').get().count, 1);
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('系统状态会报告遗漏的自动日终任务并在补跑完成后恢复', () => {
  const db = openDatabase(':memory:');
  seedWatchlist(db);
  const options = {
    expectedMarketDate: '2026-09-04',
    futu: { enabled: false },
    automation: { catchupLimit: 5, maximumAttempts: 3, claimStaleMinutes: 180 }
  };
  const missing = collectSystemStatus(db, options);
  assert.equal(missing.automation.status, 'MISSING');
  assert.ok(missing.issues.some((item) => item.code === 'DAILY_CYCLE_MISSING'));

  const claim = claimDailyCycle(db, {
    analysisDate: '2026-09-04', now: '2026-09-05T00:00:00.000Z'
  });
  finishDailyCycleClaim(db, {
    analysisDate: '2026-09-04', token: claim.token,
    resultStatus: 'SUCCESS', now: '2026-09-05T00:01:00.000Z'
  });
  const recovered = collectSystemStatus(db, options);
  assert.equal(recovered.automation.status, 'CURRENT');
  assert.ok(!recovered.issues.some((item) => item.code === 'DAILY_CYCLE_MISSING'));
  db.close();
});
