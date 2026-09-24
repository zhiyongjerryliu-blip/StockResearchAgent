import { nowIso, toPlain, toPlainRows } from './db.js';
import { calculatePosition } from './portfolio.js';

const STRATEGY_KEY = 'industry18-quality-momentum';
const QUANTITY_EPSILON = 1e-6;

function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return 0;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function selectedQuantity(item) {
  if (Number.isFinite(Number(item?.quantity))) return Number(item.quantity);
  const price = Number(item?.entryPrice);
  return price > 0 ? Number(item.targetValue || 0) / price : 0;
}

function executionPrice(db, ticker, tradeDate, current, previous) {
  const supplied = Number(current?.entryPrice || current?.executionPrice);
  if (supplied > 0) return supplied;
  const row = db.prepare(`
    SELECT close FROM prices_daily WHERE ticker = ? AND trade_date = ?
    ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC LIMIT 1
  `).get(ticker, tradeDate);
  if (Number(row?.close) > 0) return Number(row.close);
  const previousPrice = Number(previous?.entryPrice || previous?.executionPrice);
  return previousPrice > 0 ? previousPrice : null;
}

function selectionReason(rankings, index, item, strategy) {
  if (item.selected) {
    return `综合评分排名第${index + 1}，满足每组最多${strategy.maxPerGroup}只限制，入选前${strategy.selectionCount}个有效席位。`;
  }
  const selectedBefore = rankings.slice(0, index).filter((row) => row.selected);
  const sameGroupBefore = selectedBefore.filter((row) => row.group === item.group).length;
  if (sameGroupBefore >= strategy.maxPerGroup) {
    return `该分组已有${strategy.maxPerGroup}只更高分股票入选，触发组内上限。`;
  }
  return `综合评分未进入前${strategy.selectionCount}个有效席位。`;
}

function buildRebalance(db, strategy, signal, previousSelected = []) {
  const previousMap = new Map(previousSelected.map((item) => [item.ticker, item]));
  const currentMap = new Map(signal.selected.map((item) => [item.ticker, item]));
  const tickers = [...new Set([...previousMap.keys(), ...currentMap.keys()])].sort();
  return tickers.map((ticker) => {
    const previous = previousMap.get(ticker);
    const current = currentMap.get(ticker);
    const price = executionPrice(db, ticker, signal.tradeDate, current, previous);
    const previousQuantity = selectedQuantity(previous);
    const targetQuantity = selectedQuantity(current);
    const deltaQuantity = targetQuantity - previousQuantity;
    let action = 'HOLD';
    let reason = '继续入选，目标股数不变。';
    if (!previous && current) { action = 'BUY'; reason = '新入选，建立目标仓位。'; }
    else if (previous && !current) { action = 'SELL'; reason = '本期未入选，清仓退出。'; }
    else if (deltaQuantity > QUANTITY_EPSILON) { action = 'INCREASE'; reason = '继续入选，买入至新的等权目标。'; }
    else if (deltaQuantity < -QUANTITY_EPSILON) { action = 'REDUCE'; reason = '继续入选，卖出至新的等权目标。'; }
    const previousValue = price ? previousQuantity * price : Number(previous?.targetValue || 0);
    const targetValue = Number(current?.targetValue || strategy.capital * Number(current?.targetWeight || 0));
    return {
      ticker, action, reason,
      previousQuantity: round(previousQuantity), targetQuantity: round(targetQuantity),
      deltaQuantity: round(deltaQuantity), executionPrice: price,
      previousValue: round(previousValue, 2), targetValue: round(targetValue, 2),
      cashAmount: round(price ? Math.abs(deltaQuantity * price) : Math.abs(targetValue - previousValue), 2),
      previousWeight: Number(previous?.targetWeight || 0), targetWeight: Number(current?.targetWeight || 0)
    };
  });
}

function persistAuditRecords(db, strategy, signal, previousSelected = [], timestamp = nowIso()) {
  const scores = db.prepare(`
    INSERT OR REPLACE INTO quality_momentum_score_records (
      strategy_key, signal_date, trade_date, ticker, group_name, rank_number,
      quality_score, momentum_score, combined_score, selected, selection_result,
      selection_reason, scoring_details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  signal.rankings.forEach((item, index) => scores.run(
    STRATEGY_KEY, signal.signalDate, signal.tradeDate, item.ticker, item.group,
    index + 1, item.qualityRank ?? item.qualityScore ?? null,
    item.momentumRank ?? item.momentumScore ?? null, item.combined,
    item.selected ? 1 : 0, item.selected ? 'SELECTED' : 'NOT_SELECTED',
    selectionReason(signal.rankings, index, item, strategy),
    JSON.stringify(item.scoringDetails || item.details || {}), timestamp
  ));
  const rebalances = buildRebalance(db, strategy, signal, previousSelected);
  const rebalanceStatement = db.prepare(`
    INSERT OR REPLACE INTO quality_momentum_rebalances (
      strategy_key, signal_date, trade_date, ticker, action, reason,
      previous_quantity, target_quantity, delta_quantity, execution_price,
      previous_value, target_value, cash_amount, previous_weight, target_weight, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of rebalances) rebalanceStatement.run(
    STRATEGY_KEY, signal.signalDate, signal.tradeDate, item.ticker, item.action, item.reason,
    item.previousQuantity, item.targetQuantity, item.deltaQuantity, item.executionPrice,
    item.previousValue, item.targetValue, item.cashAmount, item.previousWeight,
    item.targetWeight, timestamp
  );
  return rebalances;
}

export function ensureQualityMomentumAuditRecords(db) {
  const strategy = toPlain(db.prepare(`
    SELECT * FROM quality_momentum_strategies WHERE strategy_key = ?
  `).get(STRATEGY_KEY));
  if (!strategy) return { signals: 0, scores: 0, rebalances: 0 };
  const config = {
    capital: Number(strategy.capital), selectionCount: Number(strategy.selection_count),
    maxPerGroup: Number(strategy.max_per_group)
  };
  const signals = toPlainRows(db.prepare(`
    SELECT * FROM quality_momentum_signals WHERE strategy_key = ? ORDER BY signal_date
  `).all(STRATEGY_KEY));
  let previousSelected = [];
  for (const row of signals) {
    const signal = {
      signalDate: row.signal_date, tradeDate: row.trade_date,
      rankings: parse(row.rankings_json, []), selected: parse(row.selected_json, [])
    };
    const scoreCount = Number(db.prepare(`
      SELECT COUNT(*) count FROM quality_momentum_score_records
      WHERE strategy_key = ? AND signal_date = ?
    `).get(STRATEGY_KEY, signal.signalDate).count);
    const rebalanceCount = Number(db.prepare(`
      SELECT COUNT(*) count FROM quality_momentum_rebalances
      WHERE strategy_key = ? AND signal_date = ?
    `).get(STRATEGY_KEY, signal.signalDate).count);
    if (scoreCount !== signal.rankings.length || !rebalanceCount) {
      persistAuditRecords(db, config, signal, previousSelected, row.created_at);
    }
    previousSelected = signal.selected;
  }
  return {
    signals: signals.length,
    scores: Number(db.prepare('SELECT COUNT(*) count FROM quality_momentum_score_records WHERE strategy_key = ?').get(STRATEGY_KEY).count),
    rebalances: Number(db.prepare('SELECT COUNT(*) count FROM quality_momentum_rebalances WHERE strategy_key = ?').get(STRATEGY_KEY).count)
  };
}

export function saveQualityMomentumStrategy(db, input) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO quality_momentum_strategies (
      strategy_key, name, enabled, capital, selection_count, max_per_group,
      target_weight, rebalance_rule, scoring_json, universe_json, groups_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_key) DO UPDATE SET
      name=excluded.name, enabled=excluded.enabled, capital=excluded.capital,
      selection_count=excluded.selection_count, max_per_group=excluded.max_per_group,
      target_weight=excluded.target_weight, rebalance_rule=excluded.rebalance_rule,
      scoring_json=excluded.scoring_json, universe_json=excluded.universe_json,
      groups_json=excluded.groups_json, updated_at=excluded.updated_at
  `).run(
    STRATEGY_KEY, input.name, input.enabled === false ? 0 : 1, input.capital,
    input.selectionCount, input.maxPerGroup, input.targetWeight, input.rebalanceRule,
    JSON.stringify(input.scoring), JSON.stringify(input.universe), JSON.stringify(input.groups),
    timestamp, timestamp
  );
  const previous = toPlain(db.prepare(`
    SELECT selected_json FROM quality_momentum_signals
    WHERE strategy_key = ? AND signal_date < ? ORDER BY signal_date DESC LIMIT 1
  `).get(STRATEGY_KEY, input.signalDate));
  db.prepare(`
    INSERT INTO quality_momentum_signals (
      strategy_key, signal_date, trade_date, rankings_json, selected_json, source_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_key, signal_date) DO UPDATE SET
      trade_date=excluded.trade_date, rankings_json=excluded.rankings_json,
      selected_json=excluded.selected_json, source_json=excluded.source_json,
      created_at=excluded.created_at
  `).run(
    STRATEGY_KEY, input.signalDate, input.tradeDate, JSON.stringify(input.rankings),
    JSON.stringify(input.selected), JSON.stringify(input.source || {}), timestamp
  );
  persistAuditRecords(db, {
    capital: Number(input.capital), selectionCount: Number(input.selectionCount),
    maxPerGroup: Number(input.maxPerGroup)
  }, {
    signalDate: input.signalDate, tradeDate: input.tradeDate,
    rankings: input.rankings, selected: input.selected
  }, parse(previous?.selected_json, []), timestamp);
  return getQualityMomentumStrategy(db);
}

function signalFromRow(db, row) {
  const scores = toPlainRows(db.prepare(`
    SELECT ticker, group_name, rank_number, quality_score, momentum_score,
           combined_score, selected, selection_result, selection_reason, scoring_details_json
    FROM quality_momentum_score_records
    WHERE strategy_key = ? AND signal_date = ? ORDER BY rank_number
  `).all(STRATEGY_KEY, row.signal_date)).map((item) => ({
    ticker: item.ticker, group: item.group_name, rank: item.rank_number,
    qualityRank: item.quality_score, momentumRank: item.momentum_score,
    combined: item.combined_score, selected: Boolean(item.selected),
    selectionResult: item.selection_result, selectionReason: item.selection_reason,
    scoringDetails: parse(item.scoring_details_json, {})
  }));
  const rebalance = toPlainRows(db.prepare(`
    SELECT * FROM quality_momentum_rebalances
    WHERE strategy_key = ? AND signal_date = ?
    ORDER BY CASE action WHEN 'SELL' THEN 1 WHEN 'REDUCE' THEN 2 WHEN 'BUY' THEN 3 WHEN 'INCREASE' THEN 4 ELSE 5 END, ticker
  `).all(STRATEGY_KEY, row.signal_date)).map((item) => ({
    ticker: item.ticker, action: item.action, reason: item.reason,
    previousQuantity: item.previous_quantity, targetQuantity: item.target_quantity,
    deltaQuantity: item.delta_quantity, executionPrice: item.execution_price,
    previousValue: item.previous_value, targetValue: item.target_value,
    cashAmount: item.cash_amount, previousWeight: item.previous_weight,
    targetWeight: item.target_weight
  }));
  const buyCash = rebalance.filter((item) => ['BUY', 'INCREASE'].includes(item.action))
    .reduce((sum, item) => sum + item.cashAmount, 0);
  const sellCash = rebalance.filter((item) => ['SELL', 'REDUCE'].includes(item.action))
    .reduce((sum, item) => sum + item.cashAmount, 0);
  return {
    signalDate: row.signal_date, tradeDate: row.trade_date,
    rankings: scores.length ? scores : parse(row.rankings_json, []),
    selected: parse(row.selected_json, []), source: parse(row.source_json, {}),
    rebalance,
    rebalanceSummary: {
      buyCount: rebalance.filter((item) => ['BUY', 'INCREASE'].includes(item.action)).length,
      sellCount: rebalance.filter((item) => ['SELL', 'REDUCE'].includes(item.action)).length,
      holdCount: rebalance.filter((item) => item.action === 'HOLD').length,
      buyCash: round(buyCash, 2), sellCash: round(sellCash, 2), netCash: round(sellCash - buyCash, 2)
    }
  };
}

export function getQualityMomentumStrategy(db) {
  const row = toPlain(db.prepare(`
    SELECT * FROM quality_momentum_strategies WHERE strategy_key = ?
  `).get(STRATEGY_KEY));
  if (!row) return null;
  ensureQualityMomentumAuditRecords(db);
  const signalRows = toPlainRows(db.prepare(`
    SELECT * FROM quality_momentum_signals
    WHERE strategy_key = ? ORDER BY signal_date DESC
  `).all(STRATEGY_KEY));
  const signals = signalRows.map((signalRow) => signalFromRow(db, signalRow));
  const signal = signals[0] || null;
  const selected = signal?.selected || [];
  const positions = selected.map((item) => {
    const position = calculatePosition(db, item.ticker);
    return {
      ...item,
      quantity: position.quantity,
      averageCost: position.averageCost,
      currentPrice: position.currentPrice,
      priceDate: position.priceDate,
      marketValue: position.marketValue,
      totalPnl: position.totalPnl,
      totalReturn: position.totalReturn
    };
  });
  const investedCapital = selected.reduce((sum, item) => sum + Number(item.targetValue || 0), 0);
  const marketValue = positions.reduce((sum, item) => sum + Number(item.marketValue || 0), 0);
  return {
    strategyKey: row.strategy_key,
    name: row.name,
    enabled: Boolean(row.enabled),
    capital: row.capital,
    selectionCount: row.selection_count,
    maxPerGroup: row.max_per_group,
    targetWeight: row.target_weight,
    rebalanceRule: row.rebalance_rule,
    scoring: parse(row.scoring_json, {}),
    universe: parse(row.universe_json, []),
    groups: parse(row.groups_json, {}),
    signal,
    signals,
    positions,
    totals: {
      investedCapital,
      marketValue,
      totalPnl: marketValue - investedCapital,
      totalReturn: investedCapital ? marketValue / investedCapital - 1 : null
    },
    updatedAt: row.updated_at
  };
}
