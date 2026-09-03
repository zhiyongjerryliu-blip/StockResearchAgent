import test from 'node:test';
import assert from 'node:assert/strict';
import { FutuCollector, FUTU_EVENT_PREFIX, parseFutuCollectorLine } from '../src/futu.js';

test('富途采集协议只解析带标记的JSON事件', () => {
  assert.equal(parseFutuCollectorLine('普通SDK日志'), null);
  assert.deepEqual(
    parseFutuCollectorLine(`${FUTU_EVENT_PREFIX}{"type":"heartbeat","time":"2026-09-02T12:00:00"}`),
    { type: 'heartbeat', time: '2026-09-02T12:00:00' }
  );
  assert.equal(parseFutuCollectorLine(`${FUTU_EVENT_PREFIX}{broken`).scope, 'protocol');
});

test('缺少独立Python环境时返回可诊断状态且不会启动进程', async () => {
  const collector = new FutuCollector({
    enabled: true,
    pythonPath: '/path/that/does/not/exist/python',
    projectRoot: process.cwd(),
    host: '127.0.0.1', port: 11111, session: 'RTH', backfillDays: 0
  });
  const status = await collector.start(['lite', 'LITE']);
  assert.equal(status.status, 'missing_sdk');
  assert.deepEqual(status.symbols, ['LITE']);
  assert.match(status.lastError, /未找到富途Python环境/);
});

test('禁用富途时保留规范化股票列表且不启动进程', async () => {
  const collector = new FutuCollector({
    enabled: false,
    pythonPath: '/unused', projectRoot: process.cwd(),
    host: '127.0.0.1', port: 11111, session: 'RTH', backfillDays: 0
  });
  const status = await collector.start(['sndk', 'LITE']);
  assert.equal(status.status, 'disabled');
  assert.deepEqual(status.symbols, ['LITE', 'SNDK']);
});
