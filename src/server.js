import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import { nowIso, openDatabase, toPlainRows } from './db.js';
import { calculateMonthlyPerformance, calculatePortfolio } from './portfolio.js';
import { providerFromName } from './market.js';
import { createNotification } from './notifications.js';
import { generateDailyReviews, refreshDailyReviewsIfNeeded } from './reviews.js';
import { runDailyCycle, runMarketRefreshCycle, startScheduler } from './scheduler.js';
import { getSecOverview, SecEdgarProvider, syncSecCompany } from './sec.js';
import { commitTransactionImport, validateTransactionImport } from './transaction-import.js';
import {
  addTransaction,
  deleteWatchlistItem,
  deleteTransaction,
  listReliability,
  listTransactions,
  listWatchlist,
  saveManualPrice,
  saveReliability,
  setWatchlistEnabled,
  updateWatchlistItem,
  upsertWatchlistItem
} from './repository.js';

const db = openDatabase();
const provider = providerFromName(config.marketDataProvider);
const secProvider = new SecEdgarProvider(config.sec);
const publicDir = path.join(config.projectRoot, 'public');
const pidFile = path.join(config.projectRoot, 'data', 'server.pid');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 8_000_000) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON格式无效');
  }
}

function latestEtDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function apiRoute(request, response, url) {
  const { method } = request;

  if (method === 'GET' && url.pathname === '/api/health') {
    return sendJson(response, 200, {
      status: 'ok', time: nowIso(), version: '0.1.0', database: config.databasePath,
      marketDataProvider: config.marketDataProvider
    });
  }

  if (method === 'GET' && url.pathname === '/api/config') {
    return sendJson(response, 200, {
      host: config.host,
      port: config.port,
      timezone: config.timezone,
      marketDataProvider: config.marketDataProvider,
      reliabilityGate: config.reliabilityGate,
      sec: {
        configured: /[^\s@]+@[^\s@]+\.[^\s@]+/.test(config.sec.userAgent),
        requestsPerSecond: config.sec.requestsPerSecond
      },
      notifications: {
        macosEnabled: config.notifications.macosEnabled,
        emailEnabled: config.notifications.emailEnabled,
        emailConfigured: Boolean(config.notifications.smtp.host && config.notifications.smtp.to)
      },
      llm: {
        enabled: config.llm.enabled,
        configured: Boolean(config.llm.apiKey && config.llm.model),
        model: config.llm.model || null
      }
    });
  }

  if (method === 'GET' && url.pathname === '/api/watchlist') {
    return sendJson(response, 200, listWatchlist(db));
  }
  if (method === 'POST' && url.pathname === '/api/watchlist') {
    return sendJson(response, 201, upsertWatchlistItem(db, await readJson(request)));
  }
  const watchlistMatch = url.pathname.match(/^\/api\/watchlist\/([^/]+)$/);
  if (watchlistMatch && method === 'PATCH') {
    const body = await readJson(request);
    const ticker = decodeURIComponent(watchlistMatch[1]);
    if (Object.keys(body).length === 1 && Object.hasOwn(body, 'enabled')) {
      return sendJson(response, 200, setWatchlistEnabled(db, ticker, body.enabled));
    }
    return sendJson(response, 200, updateWatchlistItem(db, ticker, body));
  }
  if (watchlistMatch && method === 'DELETE') {
    return sendJson(response, 200, deleteWatchlistItem(db, decodeURIComponent(watchlistMatch[1])));
  }

  if (method === 'GET' && url.pathname === '/api/transactions') {
    return sendJson(response, 200, listTransactions(db, url.searchParams.get('ticker')));
  }
  if (method === 'POST' && url.pathname === '/api/transactions') {
    return sendJson(response, 201, addTransaction(db, await readJson(request)));
  }
  if (method === 'POST' && url.pathname === '/api/transactions/import/validate') {
    return sendJson(response, 200, await validateTransactionImport(db, await readJson(request)));
  }
  if (method === 'POST' && url.pathname === '/api/transactions/import/commit') {
    const body = await readJson(request);
    return sendJson(response, 201, commitTransactionImport(db, body.token));
  }
  const transactionMatch = url.pathname.match(/^\/api\/transactions\/(\d+)$/);
  if (transactionMatch && method === 'DELETE') {
    return sendJson(response, 200, deleteTransaction(db, transactionMatch[1]));
  }

  if (method === 'GET' && url.pathname === '/api/portfolio') {
    return sendJson(response, 200, calculatePortfolio(db));
  }
  if (method === 'GET' && url.pathname === '/api/performance/monthly') {
    const month = url.searchParams.get('month') || latestEtDate().slice(0, 7);
    return sendJson(response, 200, calculateMonthlyPerformance(db, month));
  }

  if (method === 'POST' && url.pathname === '/api/prices/manual') {
    const price = saveManualPrice(db, await readJson(request));
    const reviewRepair = await refreshDailyReviewsIfNeeded(db, latestEtDate());
    return sendJson(response, 201, { ...price, reviewRepair });
  }
  if (method === 'GET' && url.pathname === '/api/prices') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, toPlainRows(db.prepare(`
      SELECT * FROM prices_daily WHERE ticker = ? ORDER BY trade_date DESC LIMIT 120
    `).all(ticker.toUpperCase())));
  }
  if (method === 'POST' && url.pathname === '/api/market/refresh') {
    return sendJson(response, 200, await runMarketRefreshCycle(db, provider));
  }

  if (method === 'GET' && url.pathname === '/api/sec/overview') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, getSecOverview(db, ticker));
  }
  if (method === 'POST' && url.pathname === '/api/sec/sync') {
    const body = await readJson(request);
    if (!body.ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, await syncSecCompany(db, secProvider, body.ticker));
  }

  if (method === 'GET' && url.pathname === '/api/notifications') {
    return sendJson(response, 200, toPlainRows(db.prepare(`
      SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100
    `).all()));
  }
  if (method === 'POST' && url.pathname === '/api/notifications/test') {
    return sendJson(response, 201, await createNotification(db, {
      severity: 'INFO', category: 'TEST', title: '通知测试', body: '美股投研工作台通知功能正常。'
    }));
  }
  const notificationMatch = url.pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
  if (notificationMatch && method === 'POST') {
    db.prepare(`UPDATE notifications SET status = 'READ' WHERE id = ?`).run(notificationMatch[1]);
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'GET' && url.pathname === '/api/reliability') {
    return sendJson(response, 200, listReliability(db));
  }
  if (method === 'POST' && url.pathname === '/api/reliability') {
    return sendJson(response, 201, saveReliability(db, await readJson(request)));
  }

  if (method === 'GET' && url.pathname === '/api/reviews') {
    const ticker = url.searchParams.get('ticker');
    const rows = ticker
      ? db.prepare(`SELECT * FROM daily_reviews WHERE ticker = ? ORDER BY review_date DESC LIMIT 60`).all(ticker.toUpperCase())
      : db.prepare(`SELECT * FROM daily_reviews ORDER BY review_date DESC, review_type LIMIT 100`).all();
    return sendJson(response, 200, toPlainRows(rows));
  }
  if (method === 'POST' && url.pathname === '/api/reviews/run') {
    return sendJson(response, 200, await generateDailyReviews(db, latestEtDate()));
  }
  if (method === 'POST' && url.pathname === '/api/daily-cycle') {
    return sendJson(response, 200, await runDailyCycle(db, provider, new Date(), secProvider));
  }

  return sendJson(response, 404, { error: '接口不存在' });
}

function staticRoute(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const relative = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.resolve(publicDir, `.${relative}`);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(response, 404, { error: '页面不存在' });
    return;
  }
  response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await apiRoute(request, response, url);
    else staticRoute(response, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(response, 400, { error: error.message || '请求失败' });
  }
});

const stopScheduler = startScheduler(db, provider, config, secProvider);

server.listen(config.port, config.host, () => {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), { encoding: 'utf8' });
  console.log(`美股投研工作台已启动：http://${config.host}:${config.port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`启动失败：${config.host}:${config.port} 已被占用。请先运行 npm stop；如果占用者不是本项目，请修改 .env 中的 APP_PORT。`);
  } else {
    console.error('服务启动失败：', error.message);
  }
  removeOwnPidFile();
  db.close();
  process.exit(1);
});

function removeOwnPidFile() {
  try {
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(pidFile);
    }
  } catch {
    // 退出清理失败不应掩盖原始退出原因。
  }
}

function shutdown() {
  stopScheduler();
  server.close(() => {
    removeOwnPidFile();
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', removeOwnPidFile);
