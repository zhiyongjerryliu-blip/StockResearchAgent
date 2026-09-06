import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FutuCollector, FutuOpenDManager, FUTU_EVENT_PREFIX, parseFutuCollectorLine
} from '../src/futu.js';

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

test('OpenD管理器自动拉起应用并通过冷却时间防止频繁重复启动', async () => {
  let now = new Date('2026-09-06T00:00:00.000Z');
  const launches = [];
  const manager = new FutuOpenDManager({
    enabled: true, appName: 'Futu_OpenD', cooldownSeconds: 300,
    now: () => now,
    launcher: async (appName) => launches.push(appName)
  });
  const first = await manager.ensure('startup');
  const cooldown = await manager.ensure('retry');
  now = new Date('2026-09-06T00:06:00.000Z');
  const retry = await manager.ensure('retry');
  assert.equal(first.launched, true);
  assert.equal(cooldown.reason, 'cooldown');
  assert.equal(retry.launched, true);
  assert.deepEqual(launches, ['Futu_OpenD', 'Futu_OpenD']);
  assert.equal(manager.status().attempts, 2);
});

test('OpenD启动失败会保留诊断但不抛出导致主服务退出', async () => {
  const manager = new FutuOpenDManager({
    enabled: true,
    launcher: async () => { throw new Error('OpenD unavailable'); }
  });
  const result = await manager.ensure('reconnect');
  assert.equal(result.launched, false);
  assert.match(result.lastError, /OpenD unavailable/);
  assert.equal(manager.status().lastReason, 'reconnect');
});
