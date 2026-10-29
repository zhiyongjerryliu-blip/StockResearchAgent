import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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

function collectorHarness({ forceKill = false } = {}) {
  const children = [];
  let live = 0;
  let maximumLive = 0;
  const collector = new FutuCollector({
    enabled: true, pythonPath: process.execPath, projectRoot: process.cwd(),
    host: '127.0.0.1', port: 11111, session: 'RTH', backfillDays: 0,
    stopTimeoutMilliseconds: 10,
    openDManager: { status: () => ({}), ensure: async () => {
      await new Promise(resolve => setImmediate(resolve));
    } },
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 1000 + children.length;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.signals = [];
      child.kill = signal => {
        child.signals.push(signal);
        if (forceKill && signal === 'SIGTERM') return true;
        setTimeout(() => {
          live -= 1;
          child.emit('exit', null, signal);
        }, forceKill ? 5 : 0);
        return true;
      };
      children.push(child);
      live += 1;
      maximumLive = Math.max(maximumLive, live);
      return child;
    }
  });
  return { collector, children, live: () => live, maximumLive: () => maximumLive };
}

test('并发刷新订阅只启动一个采集器，停机等待正在进行的启动', async () => {
  const h = collectorHarness();
  await Promise.all(Array.from({ length: 20 }, () => h.collector.start(['AMD'])));
  assert.equal(h.children.length, 1);
  assert.equal(h.live(), 1);
  const restart = h.collector.restart(['MU']);
  const stop = h.collector.stop();
  await Promise.all([restart, stop]);
  assert.equal(h.live(), 0);
  assert.equal(h.maximumLive(), 1);
  assert.equal(h.collector.status().status, 'stopped');
});

test('重连与刷新串行执行，旧进程迟到事件不会覆盖当前状态', async () => {
  const h = collectorHarness();
  await h.collector.start(['AMD']);
  const old = h.children[0];
  await Promise.all([h.collector.restart(['MU']), h.collector.start(['MU'])]);
  assert.equal(h.children.length, 2);
  assert.equal(h.maximumLive(), 1);
  const current = h.collector.status();
  old.emit('exit', 1, null);
  old.emit('error', new Error('old collector error'));
  old.stdout.write(`${FUTU_EVENT_PREFIX}{"type":"status","status":"stopped"}\n`);
  assert.deepEqual(h.collector.status(), current);
  assert.equal(current.pid, h.children[1].pid);
  await h.collector.stop();
});

test('忽略SIGTERM的采集器被强制结束后才允许启动替代进程', async () => {
  const h = collectorHarness({ forceKill: true });
  await h.collector.start(['AMD']);
  await h.collector.restart(['MU']);
  assert.deepEqual(h.children[0].signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(h.maximumLive(), 1);
  assert.equal(h.children.length, 2);
  await h.collector.stop();
  assert.equal(h.live(), 0);
});
