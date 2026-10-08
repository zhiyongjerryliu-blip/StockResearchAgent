import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.js';
import { nowIso, toPlain } from './db.js';
import { calculatePosition } from './portfolio.js';
import { nextRegularUsTradingDate, previousRegularUsTradingDate } from './trading-calendar.js';
import { saveQualityMomentumStrategy } from './quality-momentum-strategy.js';

const STRATEGY_KEY = 'industry18-quality-momentum';
const NOTE_PREFIX = '质量—动量月度调仓';
const EPSILON = 1e-6;

export function isQualityMomentumMonthEnd(tradeDate) {
  return nextRegularUsTradingDate(tradeDate).slice(0, 7) !== tradeDate.slice(0, 7);
}

function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function strategyRow(db) {
  return toPlain(db.prepare(`
    SELECT * FROM quality_momentum_strategies WHERE strategy_key = ? AND enabled = 1
  `).get(STRATEGY_KEY));
}

function computeRankings(databasePath, signalDate) {
  const python = process.env.QUALITY_MOMENTUM_PYTHON || path.join(
    config.projectRoot, 'dayk_strategy', '.venv', 'bin', 'python'
  );
  const script = path.join(config.projectRoot, 'dayk_strategy', 'compute_monthly_signal.py');
  const result = spawnSync(python, [script, databasePath, signalDate], {
    cwd: config.projectRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout).trim() || '质量—动量评分失败');
  return JSON.parse(result.stdout);
}

function configuration(row) {
  return {
    name: row.name,
    enabled: Boolean(row.enabled),
    capital: Number(row.capital),
    selectionCount: Number(row.selection_count),
    maxPerGroup: Number(row.max_per_group),
    targetWeight: Number(row.target_weight),
    rebalanceRule: row.rebalance_rule,
    scoring: parse(row.scoring_json, {}),
    universe: parse(row.universe_json, []),
    groups: parse(row.groups_json, {})
  };
}

function savePendingSignal(db, row, signalDate, tradeDate, rankings) {
  const base = configuration(row);
  const selected = rankings.filter((item) => item.selected).map((item) => ({
    ticker: item.ticker, group: item.group, combined: item.combined,
    targetWeight: base.targetWeight
  }));
  saveQualityMomentumStrategy(db, {
    ...base, signalDate, tradeDate, rankings, selected, status: 'PENDING',
    source: { calculator: 'dayk_strategy/compute_monthly_signal.py', timing: 'month-end-close' }
  });
  return selected;
}

function executionPrice(db, ticker, tradeDate) {
  return Number(db.prepare(`
    SELECT close FROM prices_daily WHERE ticker = ? AND trade_date = ?
    ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC LIMIT 1
  `).get(ticker, tradeDate)?.close);
}

function executeSignal(db, row, signalDate, tradeDate, rankings) {
  const note = `${NOTE_PREFIX} · ${signalDate}信号`;
  const existing = Number(db.prepare('SELECT COUNT(*) count FROM transactions WHERE note = ?').get(note).count);
  if (existing) return { status: 'ALREADY_EXECUTED', signalDate, tradeDate, transactions: existing };
  const base = configuration(row);
  const current = db.prepare(`
    SELECT ticker,
           SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END) quantity
    FROM transactions
    WHERE note LIKE '质量—动量%' AND substr(trade_time, 1, 10) < ?
    GROUP BY ticker
    HAVING quantity > ?
    ORDER BY ticker
  `).all(tradeDate, EPSILON).map((item) => ({
    ticker: item.ticker, quantity: Number(item.quantity)
  }));
  let portfolioValue = current.reduce((sum, item) => {
    const price = executionPrice(db, item.ticker, tradeDate);
    if (!(price > 0)) throw new Error(`${item.ticker}缺少${tradeDate}执行价格`);
    return sum + item.quantity * price;
  }, 0);
  if (!(portfolioValue > 0)) portfolioValue = base.capital;
  const selected = rankings.filter((item) => item.selected).map((item) => {
    const entryPrice = executionPrice(db, item.ticker, tradeDate);
    if (!(entryPrice > 0)) throw new Error(`${item.ticker}缺少${tradeDate}执行价格`);
    const targetValue = portfolioValue * base.targetWeight;
    return {
      ticker: item.ticker, group: item.group, combined: item.combined,
      targetWeight: base.targetWeight, targetValue, entryPrice,
      quantity: targetValue / entryPrice
    };
  });
  const target = new Map(selected.map((item) => [item.ticker, item.quantity]));
  const currentMap = new Map(current.map((item) => [item.ticker, item.quantity]));
  const changes = [...new Set([...currentMap.keys(), ...target.keys()])].sort().map((ticker) => {
    const quantity = (target.get(ticker) || 0) - (currentMap.get(ticker) || 0);
    return { ticker, quantity, price: executionPrice(db, ticker, tradeDate) };
  }).filter((item) => Math.abs(item.quantity) > EPSILON);
  const timestamp = nowIso();
  db.exec('BEGIN');
  try {
    saveQualityMomentumStrategy(db, {
      ...base, signalDate, tradeDate, rankings, selected, status: 'EXECUTED',
      source: { calculator: 'dayk_strategy/compute_monthly_signal.py', timing: 'next-session-close' }
    });
    const insert = db.prepare(`
      INSERT INTO transactions (
        ticker, side, trade_time, quantity, price, fee, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `);
    for (const item of changes.sort((left, right) => left.quantity - right.quantity)) {
      insert.run(
        item.ticker, item.quantity > 0 ? 'BUY' : 'SELL', `${tradeDate}T16:00:00.000Z`,
        Math.abs(item.quantity), item.price, note, timestamp, timestamp
      );
    }
    for (const ticker of new Set(changes.map((item) => item.ticker))) calculatePosition(db, ticker, tradeDate);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { status: 'EXECUTED', signalDate, tradeDate, portfolioValue, transactions: changes.length };
}

export function runQualityMomentumAutomation(db, analysisDate, options = {}) {
  const row = strategyRow(db);
  if (!row) return { skipped: true, reason: 'strategy-disabled-or-missing' };
  const previousDate = previousRegularUsTradingDate(analysisDate);
  let signalDate = null;
  if (isQualityMomentumMonthEnd(analysisDate)) signalDate = analysisDate;
  else if (isQualityMomentumMonthEnd(previousDate)) signalDate = previousDate;
  const pending = toPlain(db.prepare(`
    SELECT * FROM quality_momentum_signals
    WHERE strategy_key = ? AND status = 'PENDING' AND trade_date <= ?
    ORDER BY signal_date LIMIT 1
  `).get(STRATEGY_KEY, analysisDate));
  if (pending) signalDate = pending.signal_date;
  if (!signalDate) return { skipped: true, reason: 'not-month-end-or-execution-day' };
  const tradeDate = nextRegularUsTradingDate(signalDate);
  const existing = toPlain(db.prepare(`
    SELECT * FROM quality_momentum_signals WHERE strategy_key = ? AND signal_date = ?
  `).get(STRATEGY_KEY, signalDate));
  if (existing?.status === 'EXECUTED') {
    return { status: 'ALREADY_EXECUTED', signalDate, tradeDate };
  }
  const rankings = existing
    ? parse(existing.rankings_json, [])
    : (options.computeRankings || computeRankings)(options.databasePath || config.databasePath, signalDate).rankings;
  if (!existing) savePendingSignal(db, row, signalDate, tradeDate, rankings);
  const completePrices = rankings.filter((item) => item.selected)
    .every((item) => executionPrice(db, item.ticker, tradeDate) > 0);
  if (!completePrices) return { status: 'PENDING', signalDate, tradeDate, selected: rankings.filter((x) => x.selected).map((x) => x.ticker) };
  return executeSignal(db, row, signalDate, tradeDate, rankings);
}
