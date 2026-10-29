import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export const FUTU_EVENT_PREFIX = '__FUTU_EVENT__';

function launchMacApplication(appName) {
  if (process.platform !== 'darwin') return Promise.resolve({ skipped: true, reason: 'not_macos' });
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', ['-gj', '-a', appName], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ launched: true });
      else reject(new Error(`启动${appName}失败，open退出码${code}`));
    });
  });
}

export class FutuOpenDManager {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.appName = options.appName || 'Futu_OpenD';
    this.cooldownSeconds = Math.max(60, Number(options.cooldownSeconds) || 300);
    this.launcher = options.launcher || launchMacApplication;
    this.now = options.now || (() => new Date());
    this.state = {
      enabled: this.enabled, attempts: 0, lastAttemptAt: null,
      lastSuccessAt: null, lastError: null, lastReason: null
    };
  }

  status() {
    return { ...this.state };
  }

  async ensure(reason = 'collector_start') {
    if (!this.enabled) return { ...this.status(), skipped: true, reason: 'disabled' };
    const now = this.now();
    const lastAttempt = this.state.lastAttemptAt
      ? new Date(this.state.lastAttemptAt).getTime() : 0;
    if (lastAttempt && now.getTime() - lastAttempt < this.cooldownSeconds * 1000) {
      return { ...this.status(), skipped: true, reason: 'cooldown' };
    }
    this.state.attempts += 1;
    this.state.lastAttemptAt = now.toISOString();
    this.state.lastReason = reason;
    try {
      await this.launcher(this.appName);
      this.state.lastSuccessAt = now.toISOString();
      this.state.lastError = null;
      return { ...this.status(), launched: true };
    } catch (error) {
      this.state.lastError = error.message;
      return { ...this.status(), launched: false, error: error.message };
    }
  }
}

export function parseFutuCollectorLine(line) {
  if (!String(line).startsWith(FUTU_EVENT_PREFIX)) return null;
  try {
    return JSON.parse(String(line).slice(FUTU_EVENT_PREFIX.length));
  } catch {
    return { type: 'error', scope: 'protocol', message: '富途采集器返回了无效JSON' };
  }
}

export class FutuCollector {
  constructor(options, onEvent = () => {}) {
    this.options = options;
    this.onEvent = onEvent;
    this.child = null;
    this.stopping = false;
    this.lifecycle = Promise.resolve();
    this.spawn = options.spawn || spawn;
    this.openDManager = options.openDManager || new FutuOpenDManager({
      enabled: options.enabled && options.autoLaunchOpenD,
      appName: options.openDAppName,
      cooldownSeconds: options.openDLaunchCooldownSeconds
    });
    this.state = {
      enabled: Boolean(options.enabled), status: options.enabled ? 'idle' : 'disabled',
      symbols: [], session: options.session, pid: null,
      startedAt: null, lastHeartbeatAt: null, lastDataAt: null,
      lastError: null, backfill: {}
    };
  }

  status() {
    return {
      ...this.state, symbols: [...this.state.symbols], backfill: { ...this.state.backfill },
      openD: this.openDManager.status()
    };
  }

  #enqueue(operation) {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => {});
    return result;
  }

  start(tickers = [], backfillTickers = tickers) {
    return this.#enqueue(() => this.#start(tickers, backfillTickers));
  }

  async #start(tickers, backfillTickers) {
    const symbols = [...new Set(tickers.map((ticker) => String(ticker).trim().toUpperCase()).filter(Boolean))].sort();
    const backfillSymbols = [...new Set(backfillTickers
      .map((ticker) => String(ticker).trim().toUpperCase())
      .filter((ticker) => symbols.includes(ticker)))].sort();
    if (!this.options.enabled) {
      this.state = { ...this.state, status: 'disabled', symbols };
      return this.status();
    }
    if (!symbols.length) {
      await this.#stop();
      this.state = { ...this.state, status: 'waiting_for_symbols', symbols: [] };
      return this.status();
    }
    if (this.child && symbols.join(',') === this.state.symbols.join(',')) return this.status();
    await this.#stop();
    if (!fs.existsSync(this.options.pythonPath)) {
      this.state = {
        ...this.state, status: 'missing_sdk', symbols,
        lastError: `未找到富途Python环境：${this.options.pythonPath}`
      };
      return this.status();
    }

    await this.openDManager.ensure('collector_start');

    const scriptPath = path.join(this.options.projectRoot, 'scripts', 'futu_collector.py');
    const args = [
      scriptPath,
      '--host', this.options.host,
      '--port', String(this.options.port),
      '--symbols', symbols.join(','),
      '--backfill-symbols', backfillSymbols.join(','),
      '--session', this.options.session,
      '--backfill-days', String(this.options.backfillDays)
    ];
    this.stopping = false;
    const child = this.spawn(this.options.pythonPath, args, {
      cwd: this.options.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    this.state = {
      ...this.state, status: 'starting', symbols, pid: child.pid,
      startedAt: new Date().toISOString(), lastHeartbeatAt: null,
      lastDataAt: null, lastError: null, backfill: {}
    };
    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      if (this.child !== child || this.stopping) return;
      const event = parseFutuCollectorLine(line);
      if (event) this.#handleEvent(event);
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      if (!child.pid) this.child = null;
      this.state = { ...this.state, status: 'error', lastError: error.message, pid: null };
    });
    child.on('exit', (code, signal) => {
      stdout.close();
      if (this.child !== child) return;
      this.child = null;
      const expected = this.stopping || signal === 'SIGTERM' || code === 0;
      this.state = {
        ...this.state, status: expected ? 'stopped' : 'error', pid: null,
        lastError: expected ? this.state.lastError : (stderr.trim() || `采集器退出，状态码 ${code}`)
      };
      this.stopping = false;
    });
    return this.status();
  }

  restart(tickers = this.state.symbols, backfillTickers = []) {
    return this.#enqueue(async () => {
      await this.#stop();
      return this.#start(tickers, backfillTickers);
    });
  }

  stop() {
    return this.#enqueue(() => this.#stop());
  }

  async #stop() {
    if (!this.child) return;
    const child = this.child;
    this.stopping = true;
    await new Promise((resolve, reject) => {
      let killTimer;
      const finish = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        child.removeListener('exit', finish);
        child.removeListener('close', finish);
        resolve();
      };
      const timer = setTimeout(() => {
        // Wait for actual exit after SIGKILL before allowing a replacement.
        killTimer = setTimeout(() => {
          child.removeListener('exit', finish);
          child.removeListener('close', finish);
          reject(new Error(`富途采集器 ${child.pid} 未退出，已暂停重启以避免重复进程`));
        }, this.options.stopTimeoutMilliseconds || 5000);
        if (this.child === child) child.kill('SIGKILL');
      }, this.options.stopTimeoutMilliseconds || 5000);
      child.once('exit', finish);
      child.once('close', finish);
      child.kill('SIGTERM');
    });
  }

  #handleEvent(event) {
    const now = new Date().toISOString();
    if (event.type === 'status') {
      this.state = {
        ...this.state, status: event.status,
        symbols: event.symbols || this.state.symbols,
        session: event.session || this.state.session,
        lastError: event.status === 'connected' ? null : this.state.lastError
      };
    } else if (event.type === 'heartbeat') {
      this.state = { ...this.state, lastHeartbeatAt: now };
    } else if (event.type === 'bars' || event.type === 'ticks') {
      this.state = { ...this.state, lastDataAt: now };
    } else if (event.type === 'backfill') {
      this.state = {
        ...this.state,
        backfill: { ...this.state.backfill, [event.ticker]: event }
      };
    } else if (event.type === 'error') {
      const fatalScopes = new Set(['startup', 'subscribe', 'collector', 'protocol']);
      this.state = {
        ...this.state,
        status: fatalScopes.has(event.scope) ? 'error' : this.state.status,
        lastError: event.message || '富途采集失败'
      };
    }
    try {
      this.onEvent(event, this.status());
    } catch (error) {
      this.state = { ...this.state, status: 'error', lastError: error.message };
    }
  }
}
