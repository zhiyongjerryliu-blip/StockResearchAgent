import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker, parseJson, round } from './domain.js';
import { calculatePortfolio } from './portfolio.js';

export const PORTFOLIO_RISK_VERSION = 'portfolio-risk-v1-2026-09-05';

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function standardDeviation(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return null;
  const average = mean(valid);
  return Math.sqrt(valid.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (valid.length - 1));
}

function canonicalReturns(db, ticker, limit = 91, asOf = null) {
  const rows = toPlainRows(db.prepare(`
    SELECT trade_date, close FROM (
      SELECT trade_date, close, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily WHERE ticker = ? ${asOf ? 'AND trade_date <= ?' : ''}
    ) WHERE row_number = 1 ORDER BY trade_date DESC LIMIT ?
  `).all(...(asOf ? [ticker, asOf, limit] : [ticker, limit]))).reverse();
  return new Map(rows.slice(1).flatMap((row, index) => {
    const previous = rows[index];
    return previous?.close && row.close
      ? [[row.trade_date, (row.close / previous.close) - 1]] : [];
  }));
}

function correlation(leftMap, rightMap) {
  const pairs = [...leftMap.entries()].flatMap(([date, left]) => (
    rightMap.has(date) ? [[left, rightMap.get(date)]] : []
  ));
  if (pairs.length < 20) return null;
  const leftMean = mean(pairs.map(([left]) => left));
  const rightMean = mean(pairs.map(([, right]) => right));
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const [left, right] of pairs) {
    covariance += (left - leftMean) * (right - rightMean);
    leftVariance += (left - leftMean) ** 2;
    rightVariance += (right - rightMean) ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator ? covariance / denominator : null;
}

function historicalDrawdown(db, asOf = null) {
  const rows = toPlainRows(db.prepare(`
    SELECT snapshot_date, SUM(COALESCE(market_value, 0)) AS market_value
    FROM daily_position_snapshots
    WHERE quantity > 0 ${asOf ? 'AND snapshot_date <= ?' : ''}
    GROUP BY snapshot_date ORDER BY snapshot_date
  `).all(...(asOf ? [asOf] : [])));
  let peak = 0;
  let maximumDrawdown = null;
  let peakDate = null;
  let troughDate = null;
  for (const row of rows) {
    if (row.market_value > peak) {
      peak = row.market_value;
      peakDate = row.snapshot_date;
    }
    if (!peak) continue;
    const drawdown = (row.market_value / peak) - 1;
    if (maximumDrawdown == null || drawdown < maximumDrawdown) {
      maximumDrawdown = drawdown;
      troughDate = row.snapshot_date;
    }
  }
  return { maximumDrawdown: round(maximumDrawdown, 6), peakDate, troughDate, sampleDays: rows.length };
}

function latestAdvice(db, ticker, asOf = null) {
  const row = toPlain(db.prepare(`
    SELECT action, stance, publication_status, rationale_json, as_of
    FROM investment_advice_snapshots
    WHERE ticker = ? ${asOf ? 'AND as_of <= ?' : ''}
    ORDER BY as_of DESC, horizon_days ASC LIMIT 1
  `).get(...(asOf ? [ticker, asOf] : [ticker])));
  return row ? { ...row, rationale: parseJson(row.rationale_json, {}) } : null;
}

function activeOfficialRisk(db, ticker, asOf = null) {
  return toPlain(db.prepare(`
    SELECT event_date, severity, title, source_url
    FROM research_events
    WHERE ticker = ? AND source_type = 'SEC_8K' AND severity IN ('P0','P1')
      AND status = 'ACTIVE'
      AND event_date <= COALESCE(?, date('now'))
      AND event_date >= date(COALESCE(?, date('now')), '-30 days')
    ORDER BY event_date DESC, id DESC LIMIT 1
  `).get(ticker, asOf, asOf));
}

function positionAction(position, weight, advice, officialRisk) {
  if (officialRisk) return {
    action: 'EXIT_RISK_REVIEW', label: '风险退出复核', severity: 'P1',
    reason: `存在${officialRisk.severity}级SEC官方风险事件“${officialRisk.title}”，需核实后评估降低或退出暴露。`
  };
  if (weight > 0.35) return {
    action: 'REDUCE_CONCENTRATION_REVIEW', label: '集中度减仓复核', severity: 'P2',
    reason: `单股占组合${(weight * 100).toFixed(1)}%，超过35%的集中度复核线。`
  };
  if (position.totalReturn <= -0.15 && ['BEARISH'].includes(advice?.stance)) return {
    action: 'REDUCE_RISK_REVIEW', label: '亏损与趋势减仓复核', severity: 'P2',
    reason: `持仓累计收益${(position.totalReturn * 100).toFixed(1)}%，且最近结构化建议方向偏空。`
  };
  return {
    action: 'HOLD_REVIEW', label: '持有并复核', severity: 'P3',
    reason: advice ? `最近建议为${advice.action}，当前未触发组合级强制风险复核线。` : '尚无已保存投资建议，当前仅按组合风险约束观察。'
  };
}

export function calculatePortfolioRisk(db, asOf = null) {
  const portfolio = calculatePortfolio(db, asOf);
  const positions = portfolio.positions.filter((position) => position.quantity > 0 && position.marketValue > 0);
  const totalMarketValue = positions.reduce((sum, position) => sum + position.marketValue, 0);
  const returns = new Map(positions.map((position) => [
    position.ticker, canonicalReturns(db, position.ticker, 91, asOf)
  ]));
  const weightedDates = new Set([...returns.values()].flatMap((items) => [...items.keys()]));
  const portfolioReturns = [...weightedDates].sort().flatMap((date) => {
    let value = 0;
    let coveredWeight = 0;
    for (const position of positions) {
      const dailyReturn = returns.get(position.ticker).get(date);
      if (!Number.isFinite(dailyReturn)) continue;
      const weight = totalMarketValue ? position.marketValue / totalMarketValue : 0;
      value += dailyReturn * weight;
      coveredWeight += weight;
    }
    return coveredWeight >= 0.8 ? [value / coveredWeight] : [];
  });
  const correlations = [];
  for (let left = 0; left < positions.length; left += 1) {
    for (let right = left + 1; right < positions.length; right += 1) {
      correlations.push({
        left: positions[left].ticker, right: positions[right].ticker,
        correlation: round(correlation(returns.get(positions[left].ticker), returns.get(positions[right].ticker)), 4)
      });
    }
  }
  const sectorWeights = new Map();
  const enriched = positions.map((position) => {
    const security = toPlain(db.prepare('SELECT sector, industry FROM securities WHERE ticker = ?').get(position.ticker)) || {};
    const weight = totalMarketValue ? position.marketValue / totalMarketValue : 0;
    const sector = security.sector || security.industry || '未分类';
    sectorWeights.set(sector, (sectorWeights.get(sector) || 0) + weight);
    const advice = latestAdvice(db, position.ticker, asOf);
    const officialRisk = activeOfficialRisk(db, position.ticker, asOf);
    return {
      ticker: position.ticker, name: position.name, sector, weight: round(weight, 6),
      marketValue: position.marketValue, totalReturn: position.totalReturn,
      advice: advice ? { action: advice.action, stance: advice.stance, asOf: advice.as_of } : null,
      officialRisk, recommendation: positionAction(position, weight, advice, officialRisk)
    };
  });
  const sectors = [...sectorWeights.entries()].map(([sector, weight]) => ({ sector, weight: round(weight, 6) }))
    .sort((left, right) => right.weight - left.weight);
  const largestPositionWeight = Math.max(0, ...enriched.map((position) => position.weight));
  const largestSectorWeight = Math.max(0, ...sectors.map((sector) => sector.weight));
  const averageCorrelation = mean(correlations.map((item) => item.correlation));
  const annualizedVolatility = standardDeviation(portfolioReturns);
  const drawdown = historicalDrawdown(db, asOf);
  const riskScore = Math.min(100,
    (largestPositionWeight * 55)
    + (largestSectorWeight * 25)
    + (Math.max(0, averageCorrelation || 0) * 10)
    + (Math.min(1, (annualizedVolatility || 0) * Math.sqrt(252) / 0.5) * 10)
  );
  return {
    asOf: portfolio.asOf, totalMarketValue: round(totalMarketValue, 2),
    positionCount: positions.length, riskScore: round(riskScore, 2),
    riskLevel: riskScore >= 70 ? 'HIGH' : riskScore >= 45 ? 'MEDIUM' : 'LOW',
    largestPositionWeight: round(largestPositionWeight, 6),
    largestSectorWeight: round(largestSectorWeight, 6),
    concentrationHhi: round(enriched.reduce((sum, position) => sum + (position.weight ** 2), 0), 6),
    annualizedVolatility: round(annualizedVolatility == null ? null : annualizedVolatility * Math.sqrt(252), 6),
    averageCorrelation: round(averageCorrelation, 4), correlations, sectors,
    drawdown, positions: enriched, modelVersion: PORTFOLIO_RISK_VERSION,
    boundaries: [
      '相关性和波动率使用最近约90个交易日收盘收益，历史不足时明确缺失。',
      '回撤使用已保存的每日持仓快照；样本较少时不代表完整历史最大回撤。',
      '建议仅为复核优先级，不提供自动仓位比例，不执行交易。'
    ]
  };
}

export function savePortfolioRisk(db, asOf) {
  const result = calculatePortfolioRisk(db, asOf);
  db.prepare(`
    INSERT INTO portfolio_risk_snapshots (as_of, risk_score, risk_level, snapshot_json, model_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(as_of, model_version) DO UPDATE SET
      risk_score = excluded.risk_score, risk_level = excluded.risk_level,
      snapshot_json = excluded.snapshot_json, created_at = excluded.created_at
  `).run(asOf, result.riskScore, result.riskLevel, JSON.stringify(result), PORTFOLIO_RISK_VERSION, nowIso());
  return result;
}

export function tickerPortfolioRisk(db, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  return calculatePortfolioRisk(db).positions.find((position) => position.ticker === ticker) || null;
}
