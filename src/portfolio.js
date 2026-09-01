import { nowIso, toPlainRows } from './db.js';
import { round } from './domain.js';
import {
  isRegularUsTradingDay,
  nextRegularUsTradingDate,
  previousRegularUsTradingDate
} from './trading-calendar.js';

const EPSILON = 1e-8;
const CALCULATION_VERSION = 'portfolio-v1';

function transactionTradeDate(transaction) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(transaction.trade_time));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const tradeDate = `${values.year}-${values.month}-${values.day}`;
  return isRegularUsTradingDay(tradeDate) ? tradeDate : nextRegularUsTradingDate(tradeDate);
}

function consumeLots(lots, quantity) {
  let remaining = quantity;
  let consumedCost = 0;

  while (remaining > EPSILON && lots.length) {
    const lot = lots[0];
    const used = Math.min(remaining, lot.quantity);
    consumedCost += used * lot.unitCost;
    lot.quantity -= used;
    remaining -= used;
    if (lot.quantity <= EPSILON) lots.shift();
  }

  if (remaining > EPSILON) {
    throw new Error('卖出股数超过当时可用持仓');
  }
  return consumedCost;
}

export function calculateLots(transactions) {
  const lots = [];
  let realizedPnl = 0;
  let totalBuyCash = 0;
  let totalSellCash = 0;

  for (const transaction of transactions) {
    const quantity = Number(transaction.quantity);
    const price = Number(transaction.price);
    const fee = Number(transaction.fee || 0);

    if (transaction.side === 'BUY') {
      const grossCost = quantity * price + fee;
      lots.push({
        sourceTransactionId: transaction.id,
        acquiredAt: transaction.trade_time,
        quantity,
        unitCost: grossCost / quantity
      });
      totalBuyCash += grossCost;
    } else if (transaction.side === 'SELL') {
      const consumedCost = consumeLots(lots, quantity);
      const netProceeds = quantity * price - fee;
      realizedPnl += netProceeds - consumedCost;
      totalSellCash += netProceeds;
    } else {
      throw new Error(`未知交易方向：${transaction.side}`);
    }
  }

  const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const remainingCost = lots.reduce((sum, lot) => sum + lot.quantity * lot.unitCost, 0);
  return {
    lots,
    quantity,
    remainingCost,
    averageCost: quantity > EPSILON ? remainingCost / quantity : null,
    realizedPnl,
    totalBuyCash,
    totalSellCash
  };
}

function latestPrices(db, ticker) {
  const latest = toPlainRows(db.prepare(`
    SELECT trade_date, open, high, low, close, volume, provider
    FROM (
      SELECT trade_date, open, high, low, close, volume, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily
      WHERE ticker = ?
    )
    WHERE row_number = 1
    ORDER BY trade_date DESC
    LIMIT 1
  `).all(ticker))[0] || null;
  if (!latest) return { latest: null, previous: null, expectedPreviousDate: null };

  const expectedPreviousDate = previousRegularUsTradingDate(latest.trade_date);
  const previous = toPlainRows(db.prepare(`
    SELECT trade_date, open, high, low, close, volume, provider
    FROM (
      SELECT trade_date, open, high, low, close, volume, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily
      WHERE ticker = ? AND trade_date = ?
    )
    WHERE row_number = 1
  `).all(ticker, expectedPreviousDate))[0] || null;
  return { latest, previous, expectedPreviousDate };
}

function transactionsForTicker(db, ticker) {
  return toPlainRows(db.prepare(`
    SELECT id, ticker, side, trade_time, quantity, price, fee, note
    FROM transactions
    WHERE ticker = ?
    ORDER BY trade_time ASC, id ASC
  `).all(ticker));
}

function calculateDailyPnl(transactions, latest, previous, endingQuantity) {
  if (!latest || !previous) return null;
  const tradeDate = latest.trade_date;
  const todaysTransactions = transactions.filter((tx) => {
    return transactionTradeDate(tx) === tradeDate;
  });
  if (!todaysTransactions.length) {
    return endingQuantity * (latest.close - previous.close);
  }

  let boughtQuantity = 0;
  let soldQuantity = 0;
  let buyCash = 0;
  let sellCash = 0;
  for (const tx of todaysTransactions) {
    if (tx.side === 'BUY') {
      boughtQuantity += tx.quantity;
      buyCash += tx.quantity * tx.price + tx.fee;
    } else {
      soldQuantity += tx.quantity;
      sellCash += tx.quantity * tx.price - tx.fee;
    }
  }
  const beginningQuantity = endingQuantity - boughtQuantity + soldQuantity;
  const beginningValue = beginningQuantity * previous.close;
  const endingValue = endingQuantity * latest.close;
  return endingValue + sellCash - buyCash - beginningValue;
}

export function calculatePosition(db, ticker) {
  const transactions = transactionsForTicker(db, ticker);
  const lotResult = calculateLots(transactions);
  const { latest, previous, expectedPreviousDate } = latestPrices(db, ticker);
  const currentPrice = latest?.close ?? null;
  const marketValue = currentPrice == null ? null : lotResult.quantity * currentPrice;
  const unrealizedPnl = marketValue == null ? null : marketValue - lotResult.remainingCost;
  const totalPnl = unrealizedPnl == null ? null : unrealizedPnl + lotResult.realizedPnl;
  const totalReturn = totalPnl == null || lotResult.totalBuyCash <= EPSILON
    ? null
    : totalPnl / lotResult.totalBuyCash;
  const dailyPnl = calculateDailyPnl(
    transactions,
    latest,
    previous,
    lotResult.quantity
  );

  return {
    ticker,
    quantity: round(lotResult.quantity, 6),
    averageCost: round(lotResult.averageCost),
    remainingCost: round(lotResult.remainingCost),
    currentPrice: round(currentPrice),
    previousClose: round(previous?.close),
    priceDate: latest?.trade_date ?? null,
    previousPriceDate: previous?.trade_date ?? null,
    expectedPreviousPriceDate: expectedPreviousDate,
    priceDataStatus: latest ? (previous ? 'COMPLETE' : 'MISSING_PREVIOUS') : 'NO_CURRENT',
    marketValue: round(marketValue),
    dailyPnl: round(dailyPnl),
    dailyReturn: latest && previous && previous.close !== 0
      ? round((latest.close - previous.close) / previous.close, 6)
      : null,
    unrealizedPnl: round(unrealizedPnl),
    realizedPnl: round(lotResult.realizedPnl),
    totalPnl: round(totalPnl),
    totalReturn: round(totalReturn, 6),
    totalBuyCash: round(lotResult.totalBuyCash),
    lots: lotResult.lots.map((lot) => ({
      ...lot,
      quantity: round(lot.quantity, 6),
      unitCost: round(lot.unitCost)
    }))
  };
}

export function calculatePortfolio(db) {
  const stocks = toPlainRows(db.prepare(`
    SELECT s.ticker, s.name, s.benchmark, s.industry_etf, w.note, w.enabled
    FROM watchlist_items w
    JOIN securities s ON s.ticker = w.ticker
    ORDER BY s.ticker
  `).all()).map((stock) => ({ ...stock, ...calculatePosition(db, stock.ticker) }));

  const totals = stocks.reduce((result, position) => {
    for (const field of ['marketValue', 'dailyPnl', 'unrealizedPnl', 'realizedPnl', 'totalPnl']) {
      if (position[field] != null) result[field] += position[field];
    }
    return result;
  }, { marketValue: 0, dailyPnl: 0, unrealizedPnl: 0, realizedPnl: 0, totalPnl: 0 });

  return {
    asOf: nowIso(),
    positions: stocks,
    totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value)]))
  };
}

function monthBounds(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('月份格式必须为YYYY-MM');
  const [year, monthNumber] = month.split('-').map(Number);
  if (monthNumber < 1 || monthNumber > 12) throw new Error('月份无效');
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

function consolidatedPricesThrough(db, ticker, endDate) {
  return toPlainRows(db.prepare(`
    SELECT trade_date, close
    FROM (
      SELECT trade_date, close, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily
      WHERE ticker = ? AND trade_date <= ?
    )
    WHERE row_number = 1
    ORDER BY trade_date
  `).all(ticker, endDate));
}

function transactionCashFlows(transactions) {
  let boughtQuantity = 0;
  let soldQuantity = 0;
  let buyCash = 0;
  let sellCash = 0;
  for (const transaction of transactions) {
    if (transaction.side === 'BUY') {
      boughtQuantity += transaction.quantity;
      buyCash += transaction.quantity * transaction.price + transaction.fee;
    } else {
      soldQuantity += transaction.quantity;
      sellCash += transaction.quantity * transaction.price - transaction.fee;
    }
  }
  return { boughtQuantity, soldQuantity, buyCash, sellCash };
}

export function calculateMonthlyPerformance(db, month) {
  const { start, end } = monthBounds(month);
  const tickers = toPlainRows(db.prepare(`
    SELECT DISTINCT ticker FROM transactions ORDER BY ticker
  `).all()).map((row) => row.ticker);
  const days = new Map();

  for (const ticker of tickers) {
    const transactions = transactionsForTicker(db, ticker).map((transaction) => ({
      ...transaction,
      tradeDate: transactionTradeDate(transaction)
    }));
    const transactionsByDate = new Map();
    let quantity = 0;
    for (const transaction of transactions) {
      if (transaction.tradeDate < start) {
        quantity += transaction.side === 'BUY' ? transaction.quantity : -transaction.quantity;
        continue;
      }
      if (transaction.tradeDate > end) continue;
      const grouped = transactionsByDate.get(transaction.tradeDate) || [];
      grouped.push(transaction);
      transactionsByDate.set(transaction.tradeDate, grouped);
    }

    const prices = consolidatedPricesThrough(db, ticker, end);
    const priceByDate = new Map(prices.map((price) => [price.trade_date, price]));
    const monthPrices = prices.filter((price) => price.trade_date >= start);
    const pendingTransactionDates = [...transactionsByDate.keys()].sort();
    let pendingIndex = 0;

    for (const price of monthPrices) {
      while (
        pendingIndex < pendingTransactionDates.length &&
        pendingTransactionDates[pendingIndex] < price.trade_date
      ) {
        const skipped = transactionCashFlows(transactionsByDate.get(pendingTransactionDates[pendingIndex]));
        quantity += skipped.boughtQuantity - skipped.soldQuantity;
        pendingIndex += 1;
      }

      const todaysTransactions = transactionsByDate.get(price.trade_date) || [];
      if (pendingTransactionDates[pendingIndex] === price.trade_date) pendingIndex += 1;
      const flows = transactionCashFlows(todaysTransactions);
      const beginningQuantity = quantity;
      const endingQuantity = beginningQuantity + flows.boughtQuantity - flows.soldQuantity;
      quantity = endingQuantity;

      const active = beginningQuantity > EPSILON || endingQuantity > EPSILON || todaysTransactions.length > 0;
      if (!active) continue;

      const previousDate = previousRegularUsTradingDate(price.trade_date);
      const previous = priceByDate.get(previousDate) || null;
      const needsPreviousClose = beginningQuantity > EPSILON;
      const complete = !needsPreviousClose || previous != null;
      const dailyPnl = complete
        ? endingQuantity * price.close + flows.sellCash - flows.buyCash -
          beginningQuantity * (previous?.close || 0)
        : null;
      const detail = {
        ticker,
        beginningQuantity: round(beginningQuantity, 6),
        endingQuantity: round(endingQuantity, 6),
        close: round(price.close),
        previousDate: needsPreviousClose ? previousDate : null,
        previousClose: needsPreviousClose ? round(previous?.close) : null,
        buyCash: round(flows.buyCash),
        sellCash: round(flows.sellCash),
        pnl: round(dailyPnl),
        status: complete ? 'COMPLETE' : 'MISSING_PREVIOUS'
      };
      const day = days.get(price.trade_date) || { date: price.trade_date, positions: [] };
      day.positions.push(detail);
      days.set(price.trade_date, day);
    }
  }

  const dailyRows = [...days.values()].sort((left, right) => left.date.localeCompare(right.date)).map((day) => {
    const complete = day.positions.every((position) => position.status === 'COMPLETE');
    const knownPnl = day.positions.reduce((sum, position) => sum + (position.pnl ?? 0), 0);
    return {
      ...day,
      pnl: complete ? round(knownPnl) : null,
      knownPnl: round(knownPnl),
      status: complete ? 'COMPLETE' : 'INCOMPLETE'
    };
  });
  const incompleteDays = dailyRows.filter((day) => day.status !== 'COMPLETE').length;
  const knownPnl = dailyRows.reduce((sum, day) => sum + day.knownPnl, 0);
  return {
    month,
    startDate: start,
    endDate: end,
    firstDisplayedDate: dailyRows[0]?.date || null,
    lastDisplayedDate: dailyRows.at(-1)?.date || null,
    totalPnl: incompleteDays ? null : round(knownPnl),
    knownPnl: round(knownPnl),
    incompleteDays,
    days: dailyRows
  };
}

export function saveDailySnapshots(db, snapshotDate) {
  const portfolio = calculatePortfolio(db);
  const statement = db.prepare(`
    INSERT INTO daily_position_snapshots (
      ticker, snapshot_date, quantity, average_cost, remaining_cost,
      close, previous_close, market_value, daily_pnl, unrealized_pnl,
      realized_pnl, total_pnl, total_return, calculation_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, snapshot_date) DO UPDATE SET
      quantity = excluded.quantity,
      average_cost = excluded.average_cost,
      remaining_cost = excluded.remaining_cost,
      close = excluded.close,
      previous_close = excluded.previous_close,
      market_value = excluded.market_value,
      daily_pnl = excluded.daily_pnl,
      unrealized_pnl = excluded.unrealized_pnl,
      realized_pnl = excluded.realized_pnl,
      total_pnl = excluded.total_pnl,
      total_return = excluded.total_return,
      calculation_version = excluded.calculation_version,
      created_at = excluded.created_at
  `);
  const timestamp = nowIso();
  for (const position of portfolio.positions) {
    statement.run(
      position.ticker,
      snapshotDate,
      position.quantity,
      position.averageCost,
      position.remainingCost,
      position.currentPrice,
      position.previousClose,
      position.marketValue,
      position.dailyPnl,
      position.unrealizedPnl,
      position.realizedPnl,
      position.totalPnl,
      position.totalReturn,
      CALCULATION_VERSION,
      timestamp
    );
  }
  return portfolio;
}
