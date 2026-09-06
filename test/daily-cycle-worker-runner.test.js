import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DailyCycleWorkerRunner } from '../src/daily-cycle-worker-runner.js';

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.terminated = false;
  }

  async terminate() {
    this.terminated = true;
    this.emit('exit', 1);
    return 1;
  }
}

test('独立日终工作线程返回结果且运行期间拒绝并发任务', async () => {
  let worker;
  let receivedOptions;
  const runner = new DailyCycleWorkerRunner({
    databasePath: '/tmp/research.sqlite',
    workerFactory: (_url, options) => {
      worker = new FakeWorker();
      receivedOptions = options;
      return worker;
    }
  });
  const promise = runner.run({ analysisDate: '2026-09-04', trigger: 'TEST' });
  assert.equal(runner.status().running, true);
  assert.equal(receivedOptions.workerData.databasePath, '/tmp/research.sqlite');
  assert.ok(receivedOptions.execArgv.every((argument) => !argument.startsWith('--input-type')));
  assert.throws(() => runner.run({}), /正在运行/);
  worker.emit('message', { ok: true, result: { status: 'SUCCESS', jobRunId: 8 } });
  assert.deepEqual(await promise, { status: 'SUCCESS', jobRunId: 8 });
  assert.equal(runner.status().running, false);
});

test('服务关闭会终止日终工作线程并拒绝等待中的调用', async () => {
  let worker;
  const runner = new DailyCycleWorkerRunner({
    workerFactory: () => {
      worker = new FakeWorker();
      return worker;
    }
  });
  const promise = runner.run({ analysisDate: '2026-09-04' });
  await runner.stop();
  await assert.rejects(promise, /异常退出|服务关闭/);
  assert.equal(worker.terminated, true);
  assert.equal(runner.status().running, false);
});

test('工作线程正常退出但没有结果时立即报错而不等待超时', async () => {
  let worker;
  const runner = new DailyCycleWorkerRunner({
    workerFactory: () => {
      worker = new FakeWorker();
      return worker;
    }
  });
  const promise = runner.run({ analysisDate: '2026-09-04' });
  worker.emit('exit', 0);
  await assert.rejects(promise, /未返回结果/);
  assert.equal(runner.status().running, false);
});
