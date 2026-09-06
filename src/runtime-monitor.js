import { randomUUID } from 'node:crypto';
import { nowIso, toPlain, toPlainRows } from './db.js';

export const RUNTIME_MONITOR_VERSION = 'runtime-monitor-v1-2026-09-06';

export function startRuntimeSession(db, options = {}) {
  const startedAt = options.startedAt || nowIso();
  db.prepare(`
    UPDATE runtime_sessions SET status = 'INTERRUPTED', stopped_at = heartbeat_at,
      stop_reason = 'heartbeat_stopped_before_next_start'
    WHERE status = 'RUNNING'
  `).run();
  const instanceId = options.instanceId || randomUUID();
  const result = db.prepare(`
    INSERT INTO runtime_sessions (
      instance_id, pid, started_at, heartbeat_at, status
    ) VALUES (?, ?, ?, ?, 'RUNNING')
  `).run(instanceId, Number(options.pid || process.pid), startedAt, startedAt);
  return { id: Number(result.lastInsertRowid), instanceId, startedAt };
}

export function heartbeatRuntimeSession(db, instanceId, heartbeatAt = nowIso()) {
  const result = db.prepare(`
    UPDATE runtime_sessions SET heartbeat_at = ?
    WHERE instance_id = ? AND status = 'RUNNING'
  `).run(heartbeatAt, instanceId);
  return Number(result.changes) === 1;
}

export function finishRuntimeSession(db, instanceId, reason = 'shutdown', stoppedAt = nowIso()) {
  const result = db.prepare(`
    UPDATE runtime_sessions SET heartbeat_at = ?, stopped_at = ?, stop_reason = ?, status = 'STOPPED'
    WHERE instance_id = ? AND status = 'RUNNING'
  `).run(stoppedAt, stoppedAt, reason, instanceId);
  return Number(result.changes) === 1;
}

export function runtimeContinuityStatus(db, now = new Date()) {
  const sessions = toPlainRows(db.prepare(`
    SELECT * FROM runtime_sessions ORDER BY id DESC LIMIT 10
  `).all());
  const latest = sessions[0] || null;
  const recentBoundary = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const recentInterruptions = sessions.filter((item) => (
    item.status === 'INTERRUPTED' && (item.stopped_at || item.heartbeat_at) >= recentBoundary
  ));
  return {
    version: RUNTIME_MONITOR_VERSION,
    latest: latest ? toPlain(latest) : null,
    recentInterruptions: recentInterruptions.length,
    sessions
  };
}
