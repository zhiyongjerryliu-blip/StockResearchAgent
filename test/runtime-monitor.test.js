import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  finishRuntimeSession, heartbeatRuntimeSession, runtimeContinuityStatus,
  startRuntimeSession
} from '../src/runtime-monitor.js';

test('运行心跳记录正常关闭并识别上次意外中断', () => {
  const db = openDatabase(':memory:');
  const first = startRuntimeSession(db, {
    instanceId: 'first', pid: 100, startedAt: '2026-09-06T00:00:00.000Z'
  });
  assert.equal(heartbeatRuntimeSession(db, first.instanceId, '2026-09-06T00:01:00.000Z'), true);
  const second = startRuntimeSession(db, {
    instanceId: 'second', pid: 101, startedAt: '2026-09-06T00:02:00.000Z'
  });
  const interrupted = db.prepare(
    "SELECT * FROM runtime_sessions WHERE instance_id = 'first'"
  ).get();
  assert.equal(interrupted.status, 'INTERRUPTED');
  assert.equal(interrupted.stopped_at, '2026-09-06T00:01:00.000Z');
  assert.equal(runtimeContinuityStatus(db, new Date('2026-09-06T01:00:00.000Z')).recentInterruptions, 1);
  assert.equal(finishRuntimeSession(
    db, second.instanceId, 'SIGTERM', '2026-09-06T00:03:00.000Z'
  ), true);
  assert.equal(runtimeContinuityStatus(db).latest.status, 'STOPPED');
  db.close();
});

test('异常中断按最后心跳而不是进程启动时间纳入24小时统计', () => {
  const db = openDatabase(':memory:');
  db.prepare(`
    INSERT INTO runtime_sessions (
      instance_id, pid, started_at, heartbeat_at, stopped_at, stop_reason, status
    ) VALUES ('old-process', 1, '2026-09-01T00:00:00.000Z',
      '2026-09-05T23:59:00.000Z', '2026-09-05T23:59:00.000Z', 'crash', 'INTERRUPTED')
  `).run();
  const status = runtimeContinuityStatus(db, new Date('2026-09-06T00:00:00.000Z'));
  assert.equal(status.recentInterruptions, 1);
  db.close();
});
