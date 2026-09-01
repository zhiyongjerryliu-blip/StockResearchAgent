import { nowIso, toPlainRows } from './db.js';

function yahooSymbol(ticker) {
  return ticker.replaceAll('.', '-');
}

export class YahooDailyProvider {
  constructor(fetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
    this.name = 'yahoo';
  }

  async fetchDaily(ticker) {
    const symbol = encodeURIComponent(yahooSymbol(ticker));
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=10d&interval=1d&events=div%2Csplits`;
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
  const stocks = toPlainRows(db.prepare(`
    SELECT ticker FROM watchlist_items WHERE enabled = 1 ORDER BY ticker
  `).all());
  const results = [];
  for (const { ticker } of stocks) {
    try {
      const bars = await provider.fetchDaily(ticker);
      const count = upsertDailyBars(db, bars);
      results.push({ ticker, ok: true, count });
    } catch (error) {
      results.push({ ticker, ok: false, error: error.message });
    }
  }
  return { provider: provider.name, results };
}
