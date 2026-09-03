import { nowIso, toPlainRows } from './db.js';
import { previousRegularUsTradingDate } from './trading-calendar.js';

function yahooSymbol(ticker) {
  return ticker.replaceAll('.', '-');
}

function etDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function historyRange(startDate, latestDate) {
  const days = Math.max(1, (Date.parse(latestDate) - Date.parse(startDate)) / 86_400_000);
  if (days <= 31) return '1mo';
  if (days <= 93) return '3mo';
  if (days <= 186) return '6mo';
  if (days <= 366) return '1y';
  if (days <= 732) return '2y';
  if (days <= 1_830) return '5y';
  return 'max';
}

function predictionHistoryStart() {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 5);
  return date.toISOString().slice(0, 10);
}

function earlierDate(...values) {
  return values.filter(Boolean).sort()[0] || null;
}

function ensureReferenceSecurity(db, ticker) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO securities (
      ticker, benchmark, currency, created_at, updated_at
    ) VALUES (?, 'SPY', 'USD', ?, ?)
    ON CONFLICT(ticker) DO NOTHING
  `).run(ticker, timestamp, timestamp);
}

export class YahooDailyProvider {
  constructor(fetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
    this.name = 'yahoo';
  }

  async fetchRange(ticker, range) {
    const symbol = encodeURIComponent(yahooSymbol(ticker));
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d&events=div%2Csplits`;
    const response = await this.fetchImpl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Local Research Workbench' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Yahoo行情请求失败：HTTP ${response.status}`);
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    if (!result) throw new Error(payload?.chart?.error?.description || 'Yahoo行情数据为空');

    const quote = result.indicators?.quote?.[0] || {};
    const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
    return (result.timestamp || []).map((timestamp, index) => ({
      ticker,
      tradeDate: new Date(timestamp * 1000).toISOString().slice(0, 10),
      open: quote.open?.[index] ?? null,
      high: quote.high?.[index] ?? null,
      low: quote.low?.[index] ?? null,
      close: quote.close?.[index] ?? null,
      adjustedClose: adjusted[index] ?? null,
      volume: quote.volume?.[index] ?? null,
      availableAt: new Date(timestamp * 1000).toISOString(),
      provider: this.name
    })).filter((bar) => Number.isFinite(bar.close));
  }

  async fetchDaily(ticker, options = {}) {
    let bars = await this.fetchRange(ticker, '10d');
    const latest = [...bars].sort((left, right) => right.tradeDate.localeCompare(left.tradeDate))[0];
    if (!latest) return bars;

    const expectedPreviousDate = previousRegularUsTradingDate(latest.tradeDate);
    const missingPrevious = !bars.some((bar) => bar.tradeDate === expectedPreviousDate);
    const missingHistory = options.historyStart &&
      !bars.some((bar) => bar.tradeDate <= options.historyStart);
    if (missingPrevious || missingHistory) {
      const fallbackRange = missingHistory
        ? historyRange(options.historyStart, latest.tradeDate)
        : '1mo';
      const fallbackBars = await this.fetchRange(ticker, fallbackRange);
      const merged = new Map(bars.map((bar) => [bar.tradeDate, bar]));
      for (const bar of fallbackBars) merged.set(bar.tradeDate, bar);
      bars = [...merged.values()];
    }
    return bars.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  }
}

export function providerFromName(name, fetchImpl = fetch) {
  if (name === 'yahoo') return new YahooDailyProvider(fetchImpl);
  if (name === 'manual') return null;
  throw new Error(`不支持的行情数据源：${name}`);
}

export function upsertDailyBars(db, bars) {
  const statement = db.prepare(`
    INSERT INTO prices_daily (
      ticker, trade_date, open, high, low, close, adjusted_close, volume,
      provider, available_at, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, trade_date, provider) DO UPDATE SET
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      adjusted_close = excluded.adjusted_close,
      volume = excluded.volume,
      available_at = excluded.available_at,
      ingested_at = excluded.ingested_at
  `);
  const ingestedAt = nowIso();
  for (const bar of bars) {
    statement.run(
      bar.ticker,
      bar.tradeDate,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.adjustedClose,
      bar.volume,
      bar.provider,
      bar.availableAt || ingestedAt,
      ingestedAt
    );
  }
  return bars.length;
}

export async function refreshWatchlistPrices(db, provider) {
  if (!provider) return { provider: 'manual', results: [] };
  const coreAndPeers = toPlainRows(db.prepare(`
    SELECT w.ticker,
           w.role,
           (SELECT MIN(t.trade_time) FROM transactions t WHERE t.ticker = w.ticker) AS first_trade_time,
           (SELECT MIN(p.trade_date) FROM prices_daily p WHERE p.ticker = w.ticker) AS first_price_date
    FROM (
      SELECT ticker, 'WATCHLIST' AS role FROM watchlist_items WHERE enabled = 1
      UNION
      SELECT r.related_ticker AS ticker, 'PEER' AS role
      FROM company_relationships r
      JOIN watchlist_items w ON w.ticker = r.ticker AND w.enabled = 1
      WHERE r.relationship_type = 'COMPETITOR' AND r.active_to IS NULL
    ) w
    ORDER BY w.ticker
  `).all());
  const references = toPlainRows(db.prepare(`
    SELECT DISTINCT reference.ticker, reference.role
    FROM (
      SELECT s.benchmark AS ticker, 'BENCHMARK' AS role
      FROM watchlist_items w JOIN securities s ON s.ticker = w.ticker
      WHERE w.enabled = 1 AND s.benchmark IS NOT NULL
      UNION
      SELECT s.industry_etf AS ticker, 'INDUSTRY_ETF' AS role
      FROM watchlist_items w JOIN securities s ON s.ticker = w.ticker
      WHERE w.enabled = 1 AND s.industry_etf IS NOT NULL
    ) reference
    WHERE reference.ticker IS NOT NULL
  `).all());
  const stocksByTicker = new Map(coreAndPeers.map((stock) => [stock.ticker, stock]));
  for (const reference of references) {
    ensureReferenceSecurity(db, reference.ticker);
    if (stocksByTicker.has(reference.ticker)) continue;
    const firstPriceDate = db.prepare(`
      SELECT MIN(trade_date) AS value FROM prices_daily WHERE ticker = ?
    `).get(reference.ticker)?.value || null;
    stocksByTicker.set(reference.ticker, {
      ...reference, first_trade_time: null, first_price_date: firstPriceDate
    });
  }
  const stocks = [...stocksByTicker.values()].sort((left, right) => left.ticker.localeCompare(right.ticker));
  const defaultHistoryStart = predictionHistoryStart();
  const results = [];
  for (const { ticker, role, first_trade_time: firstTradeTime, first_price_date: firstPriceDate } of stocks) {
    try {
      const firstTradeDate = firstTradeTime ? etDate(firstTradeTime) : null;
      const desiredHistoryStart = earlierDate(defaultHistoryStart, firstTradeDate);
      const historyStart = !firstPriceDate || firstPriceDate > desiredHistoryStart
        ? desiredHistoryStart : null;
      const bars = await provider.fetchDaily(ticker, { historyStart });
      const count = upsertDailyBars(db, bars);
      results.push({ ticker, role, ok: true, count, historyStart });
    } catch (error) {
      results.push({ ticker, role, ok: false, error: error.message });
    }
  }
  return { provider: provider.name, results };
}
