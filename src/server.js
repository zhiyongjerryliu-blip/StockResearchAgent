import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import { nowIso, openDatabase, toPlainRows } from './db.js';
import { calculateMonthlyPerformance, calculatePortfolio } from './portfolio.js';
import { providerFromName, upsertDailyBars } from './market.js';
import { createNotification } from './notifications.js';
import { generateDailyReviews, refreshDailyReviewsIfNeeded } from './reviews.js';
import { runDailyCycle, runMarketRefreshCycle, startScheduler } from './scheduler.js';
import { getSecOverview, SecEdgarProvider, syncSecCompany } from './sec.js';
import { commitTransactionImport, validateTransactionImport } from './transaction-import.js';
import { configureAutomaticPeers } from './peer-selection.js';
import { AlphaVantageEarningsProvider, syncEarningsEstimate } from './earnings-estimates.js';
import { backfillSecFilingEvents, listResearchEvents } from './events.js';
import {
  AlphaVantageNewsProvider, getNewsSentimentSummary, listNewsArticles, syncNewsForTicker
} from './news.js';
import {
  CompositeNewsProvider, GoogleNewsRssProvider, HackerNewsDiscussionProvider,
  YahooFinanceNewsProvider
} from './news-sources.js';
import {
  configureStockConcepts, configureWatchlistConcepts, listStockConcepts
} from './concepts.js';
import { getExternalDriversOverview } from './external-drivers.js';
import { getMarketContext, syncMarketContext } from './market-context.js';
import { buildInvestmentAdvice, saveInvestmentAdvice } from './advice.js';
import {
  analyzeCapitalFlow, listRecentCapitalFlowDays,
  notifyVolumeAnomalies, saveCapitalFlow
} from './capital-flow.js';
import { FutuCollector } from './futu.js';
import {
  analyzeIntradayFlow, ingestFutuBars, ingestFutuTicks,
  listIntradayFlowMinutes, notifyIntradayFlowAnomalies, pruneIntradayTicks,
  rebuildMissingIntradayMinutes, saveIntradayFlowSnapshot
} from './intraday-flow.js';
import {
  addPeer,
  deleteEarningsEstimate,
  getValuationOverview,
  removePeer,
  saveEarningsEstimate,
  valuationGroupTickers
} from './valuation.js';
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
import { latestStableUsMarketDate } from './trading-calendar.js';

const db = openDatabase();
rebuildMissingIntradayMinutes(db);
pruneIntradayTicks(db, config.futu.tickRetentionDays);
backfillSecFilingEvents(db);
configureWatchlistConcepts(db);
const provider = providerFromName(config.marketDataProvider);
const secProvider = new SecEdgarProvider(config.sec);
const earningsProvider = new AlphaVantageEarningsProvider(config.alphaVantage);
const newsProvider = new CompositeNewsProvider([
  new AlphaVantageNewsProvider(config.alphaVantage),
  new GoogleNewsRssProvider(),
  new YahooFinanceNewsProvider(),
  new HackerNewsDiscussionProvider()
]);
const publicDir = path.join(config.projectRoot, 'public');
const pidFile = path.join(config.projectRoot, 'data', 'server.pid');
const intradaySnapshotTimers = new Map();

function enabledWatchlistTickers() {
  return listWatchlist(db).filter((item) => item.enabled).map((item) => item.ticker);
}

function missingIntradayHistory(tickers) {
  const countBars = db.prepare(`
    SELECT COUNT(*) AS count FROM prices_intraday
    WHERE ticker = ? AND interval = '1M' AND COALESCE(volume, 0) > 0
  `);
  return tickers.filter((ticker) => Number(countBars.get(ticker)?.count || 0) < 390);
}

function scheduleIntradaySnapshot(ticker) {
  if (intradaySnapshotTimers.has(ticker)) return;
  const timer = setTimeout(async () => {
    intradaySnapshotTimers.delete(ticker);
    try {
      const analysis = saveIntradayFlowSnapshot(db, ticker);
      await notifyIntradayFlowAnomalies(db, analysis);
    } catch (error) {
      console.error(`保存或提醒 ${ticker} 分钟资金流快照失败：`, error.message);
    }
  }, 1000);
  intradaySnapshotTimers.set(ticker, timer);
}

const futuCollector = new FutuCollector(
  { ...config.futu, projectRoot: config.projectRoot },
  (event) => {
    if (event.type === 'bars') {
      ingestFutuBars(db, event.bars);
      for (const ticker of new Set((event.bars || []).map((bar) => bar.ticker))) {
        scheduleIntradaySnapshot(ticker);
      }
    }
    if (event.type === 'ticks') {
      ingestFutuTicks(db, event.ticks);
      for (const ticker of new Set((event.ticks || []).map((tick) => tick.ticker))) {
        scheduleIntradaySnapshot(ticker);
      }
    }
  }
);

function refreshFutuCollectorSymbols() {
  const tickers = enabledWatchlistTickers();
  futuCollector.start(tickers, missingIntradayHistory(tickers)).catch((error) => {
    console.error('刷新富途订阅失败：', error.message);
  });
}

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

async function syncValuationGroup(ticker) {
  let targetSec = null;
  try {
    const synced = await syncSecCompany(db, secProvider, ticker);
    targetSec = { ok: true, filingCount: synced.filingCount, factCount: synced.factCount };
  } catch (error) {
    targetSec = { ok: false, error: error.message };
  }
  const selection = configureAutomaticPeers(db, ticker);
  const tickers = valuationGroupTickers(db, ticker);
  const targetTicker = tickers[0];
  const results = [];
  for (const currentTicker of tickers) {
    const result = { ticker: currentTicker, market: null, sec: null, earnings: null };
    if (!provider) {
      result.market = { ok: false, skipped: true, error: '当前为手动行情模式' };
    } else {
      try {
        const desiredHistoryStart = valuationHistoryStart();
        const earliestPrice = db.prepare(
          'SELECT MIN(trade_date) AS trade_date FROM prices_daily WHERE ticker = ?'
        ).get(currentTicker)?.trade_date;
        const historyStart = !earliestPrice || earliestPrice > desiredHistoryStart
          ? desiredHistoryStart
          : null;
        const bars = await provider.fetchDaily(currentTicker, { historyStart });
        result.market = { ok: true, count: upsertDailyBars(db, bars) };
      } catch (error) {
        result.market = { ok: false, error: error.message };
      }
    }
    if (currentTicker === targetTicker) {
      result.sec = targetSec;
    } else {
      try {
        const synced = await syncSecCompany(db, secProvider, currentTicker);
        result.sec = { ok: true, filingCount: synced.filingCount, factCount: synced.factCount };
      } catch (error) {
        result.sec = { ok: false, error: error.message };
      }
    }
    try {
      result.earnings = await syncEarningsEstimate(db, earningsProvider, currentTicker, latestEtDate());
    } catch (error) {
      result.earnings = { ok: false, error: error.message };
    }
    results.push(result);
  }
  return { tickers, selection, results };
}

function latestEtDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function latestStableMarketDate() {
  return latestStableUsMarketDate(
    new Date(), config.dailyReviewHourEt, config.dailyReviewMinuteEt
  );
}

function valuationHistoryStart() {
  const date = new Date(`${latestEtDate()}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() - 5);
  return date.toISOString().slice(0, 10);
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
      alphaVantage: {
        configured: Boolean(config.alphaVantage.apiKey)
      },
      futu: {
        enabled: config.futu.enabled,
        host: config.futu.host,
        port: config.futu.port,
        session: config.futu.session,
        collector: futuCollector.status()
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
    const item = upsertWatchlistItem(db, await readJson(request));
    configureStockConcepts(db, item.ticker);
    refreshFutuCollectorSymbols();
    return sendJson(response, 201, item);
  }
  const watchlistMatch = url.pathname.match(/^\/api\/watchlist\/([^/]+)$/);
  if (watchlistMatch && method === 'PATCH') {
    const body = await readJson(request);
    const ticker = decodeURIComponent(watchlistMatch[1]);
    if (Object.keys(body).length === 1 && Object.hasOwn(body, 'enabled')) {
      const item = setWatchlistEnabled(db, ticker, body.enabled);
      refreshFutuCollectorSymbols();
      return sendJson(response, 200, item);
    }
    const item = updateWatchlistItem(db, ticker, body);
    configureStockConcepts(db, item.ticker);
    refreshFutuCollectorSymbols();
    return sendJson(response, 200, item);
  }
  if (watchlistMatch && method === 'DELETE') {
    const result = deleteWatchlistItem(db, decodeURIComponent(watchlistMatch[1]));
    refreshFutuCollectorSymbols();
    return sendJson(response, 200, result);
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
    const result = commitTransactionImport(db, body.token);
    refreshFutuCollectorSymbols();
    return sendJson(response, 201, result);
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
  if (method === 'GET' && url.pathname === '/api/market/context') {
    return sendJson(response, 200, getMarketContext(
      db, url.searchParams.get('asOf') || latestStableMarketDate()
    ));
  }
  if (method === 'POST' && url.pathname === '/api/market/context/sync') {
    return sendJson(response, 200, await syncMarketContext(db, provider, latestStableMarketDate()));
  }

  if (method === 'GET' && url.pathname === '/api/concepts') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, listStockConcepts(db, ticker));
  }
  if (method === 'POST' && url.pathname === '/api/concepts/sync') {
    const body = await readJson(request);
    if (!body.ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, configureStockConcepts(db, body.ticker));
  }
  if (method === 'GET' && url.pathname === '/api/drivers') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, getExternalDriversOverview(
      db, ticker, url.searchParams.get('asOf') || latestStableMarketDate()
    ));
  }
  if (method === 'GET' && url.pathname === '/api/advice') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, buildInvestmentAdvice(
      db, ticker, url.searchParams.get('asOf') || latestStableMarketDate()
    ));
  }
  if (method === 'POST' && url.pathname === '/api/advice/run') {
    const body = await readJson(request);
    if (!body.ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, saveInvestmentAdvice(
      db, body.ticker, body.asOf || latestStableMarketDate()
    ));
  }
  if (method === 'GET' && url.pathname === '/api/capital-flow') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, analyzeCapitalFlow(
      db, ticker, url.searchParams.get('asOf') || latestStableMarketDate()
    ));
  }
  if (method === 'GET' && url.pathname === '/api/capital-flow/history') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, listRecentCapitalFlowDays(
      db,
      ticker,
      url.searchParams.get('asOf') || latestStableMarketDate(),
      url.searchParams.get('limit')
    ));
  }
  if (method === 'POST' && url.pathname === '/api/capital-flow/run') {
    const body = await readJson(request);
    if (!body.ticker) throw new Error('缺少ticker');
    const analysis = saveCapitalFlow(
      db, body.ticker, body.asOf || latestStableMarketDate()
    );
    analysis.volumeNotifications = await notifyVolumeAnomalies(db, analysis);
    return sendJson(response, 200, analysis);
  }
  if (method === 'GET' && url.pathname === '/api/futu/status') {
    return sendJson(response, 200, futuCollector.status());
  }
  if (method === 'POST' && url.pathname === '/api/futu/restart') {
    const tickers = enabledWatchlistTickers();
    return sendJson(response, 200, await futuCollector.restart(tickers, missingIntradayHistory(tickers)));
  }
  if (method === 'GET' && url.pathname === '/api/intraday-flow') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) throw new Error('缺少ticker');
    const tradeDate = url.searchParams.get('tradeDate') || null;
    return sendJson(response, 200, {
      analysis: analyzeIntradayFlow(db, ticker, tradeDate),
      minutes: listIntradayFlowMinutes(db, ticker, tradeDate, url.searchParams.get('limit')),
      collector: futuCollector.status()
    });
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

  if (method === 'GET' && url.pathname === '/api/valuation/overview') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) throw new Error('缺少ticker');
    const lookbackYears = Number(url.searchParams.get('years') || 5);
    if (![1, 3, 5].includes(lookbackYears)) throw new Error('历史估值区间仅支持1、3或5年');
    return sendJson(response, 200, getValuationOverview(db, ticker, { lookbackYears }));
  }
  if (method === 'POST' && url.pathname === '/api/valuation/sync') {
    const body = await readJson(request);
    if (!body.ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, await syncValuationGroup(body.ticker));
  }
  if (method === 'POST' && url.pathname === '/api/valuation/peers/auto') {
    const body = await readJson(request);
    if (!body.ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, configureAutomaticPeers(db, body.ticker));
  }
  if (method === 'POST' && url.pathname === '/api/valuation/estimates') {
    return sendJson(response, 201, saveEarningsEstimate(db, await readJson(request)));
  }
  if (method === 'POST' && url.pathname === '/api/valuation/estimates/sync') {
    const body = await readJson(request);
    if (!body.ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, await syncEarningsEstimate(
      db, earningsProvider, body.ticker, latestEtDate()
    ));
  }
  const estimateMatch = url.pathname.match(/^\/api\/valuation\/estimates\/(\d+)$/);
  if (estimateMatch && method === 'DELETE') {
    return sendJson(response, 200, deleteEarningsEstimate(db, estimateMatch[1]));
  }
  if (method === 'POST' && url.pathname === '/api/valuation/peers') {
    return sendJson(response, 201, addPeer(db, await readJson(request)));
  }
  const peerMatch = url.pathname.match(/^\/api\/valuation\/peers\/([^/]+)\/([^/]+)$/);
  if (peerMatch && method === 'DELETE') {
    return sendJson(response, 200, removePeer(
      db, decodeURIComponent(peerMatch[1]), decodeURIComponent(peerMatch[2])
    ));
  }

  if (method === 'GET' && url.pathname === '/api/notifications') {
    return sendJson(response, 200, toPlainRows(db.prepare(`
      SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100
    `).all()));
  }

  if (method === 'GET' && url.pathname === '/api/events') {
    return sendJson(response, 200, listResearchEvents(db, {
      ticker: url.searchParams.get('ticker'),
      severity: url.searchParams.get('severity'),
      limit: url.searchParams.get('limit')
    }));
  }
  if (method === 'GET' && url.pathname === '/api/news') {
    return sendJson(response, 200, listNewsArticles(db, {
      ticker: url.searchParams.get('ticker'),
      limit: url.searchParams.get('limit')
    }));
  }
  if (method === 'GET' && url.pathname === '/api/news/sentiment') {
    return sendJson(response, 200, getNewsSentimentSummary(db, {
      ticker: url.searchParams.get('ticker')
    }));
  }
  if (method === 'POST' && url.pathname === '/api/news/sync') {
    const body = await readJson(request);
    if (!body.ticker) throw new Error('缺少ticker');
    return sendJson(response, 200, await syncNewsForTicker(
      db, newsProvider, body.ticker, latestEtDate(), { force: Boolean(body.force) }
    ));
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
    return sendJson(response, 200, await runDailyCycle(
      db, provider, new Date(), secProvider, earningsProvider, newsProvider
    ));
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

const stopScheduler = startScheduler(db, provider, config, secProvider, earningsProvider, newsProvider);

server.listen(config.port, config.host, () => {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), { encoding: 'utf8' });
  console.log(`美股投研工作台已启动：http://${config.host}:${config.port}`);
  refreshFutuCollectorSymbols();
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

async function shutdown() {
  stopScheduler();
  for (const timer of intradaySnapshotTimers.values()) clearTimeout(timer);
  await futuCollector.stop();
  server.close(() => {
    removeOwnPidFile();
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', removeOwnPidFile);
