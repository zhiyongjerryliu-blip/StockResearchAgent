import { Worker } from 'node:worker_threads';

const workerUrl = new URL('./daily-cycle-worker.js', import.meta.url);

export class DailyCycleWorkerRunner {
  constructor(options = {}) {
    this.databasePath = options.databasePath;
    this.timeoutMilliseconds = Math.max(1_000, Number(options.timeoutMilliseconds) || 60 * 60_000);
    this.workerFactory = options.workerFactory || ((url, workerOptions) => new Worker(url, workerOptions));
    this.active = null;
  }

  status() {
    if (!this.active) return { running: false };
    return {
      running: true,
      startedAt: this.active.startedAt,
      analysisDate: this.active.options.analysisDate || null,
      ticker: this.active.options.ticker || null,
      trigger: this.active.options.trigger || null
    };
  }

  run(options = {}) {
    if (this.active) throw new Error('日终任务正在运行，请等待当前任务完成');
    const worker = this.workerFactory(workerUrl, {
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
      workerData: {
        databasePath: this.databasePath,
        requestedAt: new Date().toISOString(),
        options
      }
    });
    const active = {
      worker,
      options: { ...options },
      startedAt: new Date().toISOString(),
      settled: false,
      timer: null,
      reject: null
    };
    this.active = active;
    return new Promise((resolve, reject) => {
      active.reject = reject;
      const settle = (callback, value) => {
        if (active.settled) return;
        active.settled = true;
        clearTimeout(active.timer);
        if (this.active === active) this.active = null;
        callback(value);
      };
      active.timer = setTimeout(() => {
        void worker.terminate();
        settle(reject, new Error(`日终工作线程运行超过${Math.round(this.timeoutMilliseconds / 60_000)}分钟，已终止并等待自动重试`));
      }, this.timeoutMilliseconds);
      active.timer.unref?.();
      worker.once('message', (message) => {
        if (message?.ok) settle(resolve, message.result);
        else settle(reject, new Error(message?.error || '日终工作线程执行失败'));
      });
      worker.once('error', (error) => settle(reject, error));
      worker.once('exit', (code) => {
        const message = code === 0
          ? '日终工作线程退出但未返回结果'
          : `日终工作线程异常退出（代码${code}）`;
        settle(reject, new Error(message));
      });
    });
  }

  async stop() {
    const active = this.active;
    if (!active) return false;
    await active.worker.terminate();
    if (!active.settled) {
      active.settled = true;
      clearTimeout(active.timer);
      if (this.active === active) this.active = null;
      active.reject(new Error('服务关闭，日终工作线程已终止'));
    }
    return true;
  }
}
