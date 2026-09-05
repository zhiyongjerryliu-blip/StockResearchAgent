import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export const FUTU_EVENT_PREFIX = '__FUTU_EVENT__';

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
    this.state = {
      enabled: Boolean(options.enabled), status: options.enabled ? 'idle' : 'disabled',
      symbols: [], session: options.session, pid: null,
      startedAt: null, lastHeartbeatAt: null, lastDataAt: null,
      lastError: null, backfill: {}
    };
  }

  status() {
    return { ...this.state, symbols: [...this.state.symbols], backfill: { ...this.state.backfill } };
  }

  async start(tickers = [], backfillTickers = tickers) {
    const symbols = [...new Set(tickers.map((ticker) => String(ticker).trim().toUpperCase()).filter(Boolean))].sort();
    const backfillSymbols = [...new Set(backfillTickers
      .map((ticker) => String(ticker).trim().toUpperCase())
      .filter((ticker) => symbols.includes(ticker)))].sort();
    if (!this.options.enabled) {
      this.state = { ...this.state, status: 'disabled', symbols };
      return this.status();
    }
    if (!symbols.length) {
      await this.stop();
      this.state = { ...this.state, status: 'waiting_for_symbols', symbols: [] };
      return this.status();
    }
    if (this.child && symbols.join(',') === this.state.symbols.join(',')) return this.status();
    await this.stop();
    if (!fs.existsSync(this.options.pythonPath)) {
      this.state = {
        ...this.state, status: 'missing_sdk', symbols,
        lastError: `未找到富途Python环境：${this.options.pythonPath}`
      };
      return this.status();
    }

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
    const child = spawn(this.options.pythonPath, args, {
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
      const event = parseFutuCollectorLine(line);
      if (event) this.#handleEvent(event);
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on('error', (error) => {
      this.state = { ...this.state, status: 'error', lastError: error.message, pid: null };
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      const expected = this.stopping || signal === 'SIGTERM' || code === 0;
      this.state = {
        ...this.state, status: expected ? 'stopped' : 'error', pid: null,
        lastError: expected ? this.state.lastError : (stderr.trim() || `采集器退出，状态码 ${code}`)
      };
      this.stopping = false;
    });
    return this.status();
  }

  async restart(tickers = this.state.symbols, backfillTickers = []) {
    await this.stop();
    return this.start(tickers, backfillTickers);
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    this.stopping = true;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.child === child) child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
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
