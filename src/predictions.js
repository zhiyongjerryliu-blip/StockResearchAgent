import { config } from './config.js';
import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker, parseJson, round } from './domain.js';
import { analyzeCapitalFlow } from './capital-flow.js';
import { buildMarketContext } from './market-context.js';
import { calculateTtmEps } from './valuation.js';
import { calculateReliability } from './reliability.js';
import { nextRegularUsTradingDate } from './trading-calendar.js';

export const FEATURE_VERSION = 'point-in-time-features-v1-2026-09-03';
export const PREDICTION_MODEL_VERSION = 'explainable-pit-ensemble-v1-2026-09-03';
export const PREDICTION_HORIZONS = Object.freeze([21, 63, 126]);

const HORIZON_CONFIG = Object.freeze({
  21: {
    label: '1个月', scale: 0.08,
    weights: { momentum: 0.32, relativeStrength: 0.14, capitalFlow: 0.20, valuation: 0.06, earnings: 0.08, fundamentals: 0.04, macro: 0.07, events: 0.09 }
  },
  63: {
    label: '3个月', scale: 0.15,
    weights: { momentum: 0.22, relativeStrength: 0.10, capitalFlow: 0.12, valuation: 0.18, earnings: 0.15, fundamentals: 0.08, macro: 0.08, events: 0.07 }
  },
  126: {
    label: '6个月', scale: 0.25,
    weights: { momentum: 0.17, relativeStrength: 0.07, capitalFlow: 0.07, valuation: 0.23, earnings: 0.17, fundamentals: 0.14, macro: 0.09, events: 0.06 }
  }
});

const FACTOR_LABELS = Object.freeze({
  momentum: '价格动量', relativeStrength: '相对基准强弱', capitalFlow: '资金行为',
  valuation: '估值', earnings: 'EPS预期修订', fundamentals: '基本面',
  macro: '宏观利率', events: '公司及行业事件'
});

function clamp(value, minimum = -1, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

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

function canonicalPrices(db, ticker, asOf, limit = 180) {
  return toPlainRows(db.prepare(`
    SELECT trade_date, open, high, low, close, volume, provider, available_at
    FROM (
      SELECT trade_date, open, high, low, close, volume, provider, available_at, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily WHERE ticker = ? AND trade_date <= ?
    ) WHERE row_number = 1
    ORDER BY trade_date DESC LIMIT ?
  `).all(ticker, asOf, limit)).reverse();
}

function allCanonicalDates(db, ticker, asOf) {
  return toPlainRows(db.prepare(`
    SELECT trade_date FROM (
      SELECT trade_date, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily WHERE ticker = ? AND trade_date <= ?
    ) WHERE row_number = 1 ORDER BY trade_date
  `).all(ticker, asOf)).map((row) => row.trade_date);
}

function returnAt(rows, sessions) {
  const current = rows.at(-1);
  const anchor = rows.at(-(sessions + 1));
  return current?.close && anchor?.close ? (current.close / anchor.close) - 1 : null;
}

function priceFeatures(rows) {
  const latest = rows.at(-1) || null;
  const dailyReturns = rows.slice(-21).flatMap((row, index, sample) => {
    const prior = sample[index - 1];
    return index && prior?.close ? [(row.close / prior.close) - 1] : [];
  });
  const closes20 = rows.slice(-20).map((row) => Number(row.close)).filter(Number.isFinite);
  const volumes20 = rows.slice(-20).map((row) => Number(row.volume)).filter((value) => Number.isFinite(value) && value > 0);
  const averageClose20 = mean(closes20);
  const averageVolume20 = mean(volumes20);
  return {
    currentPrice: latest?.close ?? null,
    priceDate: latest?.trade_date || null,
    priceProvider: latest?.provider || null,
    priceAvailableAt: latest?.available_at || null,
    sampleSize: rows.length,
    return5d: round(returnAt(rows, 5), 6),
    return21d: round(returnAt(rows, 21), 6),
    return63d: round(returnAt(rows, 63), 6),
    return126d: round(returnAt(rows, 126), 6),
    volatility20d: round(standardDeviation(dailyReturns), 6),
    movingAverageGap20d: latest?.close && averageClose20
      ? round((latest.close / averageClose20) - 1, 6) : null,
    relativeVolume20d: latest?.volume && averageVolume20
      ? round(latest.volume / averageVolume20, 4) : null
  };
}

function benchmarkFeatures(db, ticker, asOf) {
  const security = toPlain(db.prepare(`
    SELECT benchmark, industry_etf FROM securities WHERE ticker = ?
  `).get(ticker));
  const build = (symbol) => {
    if (!symbol) return null;
    const rows = canonicalPrices(db, symbol, asOf, 130);
    if (!rows.length) return { symbol, available: false };
    return {
      symbol, available: true, priceDate: rows.at(-1).trade_date,
      return21d: round(returnAt(rows, 21), 6),
      return63d: round(returnAt(rows, 63), 6),
      return126d: round(returnAt(rows, 126), 6)
    };
  };
  return {
    market: build(security?.benchmark || 'SPY'),
    industry: build(security?.industry_etf)
  };
}

function estimateFeatures(db, ticker, asOf) {
  const estimate = toPlain(db.prepare(`
    SELECT * FROM earnings_estimates
    WHERE ticker = ? AND estimate_type = 'NTM_EPS' AND as_of <= ?
    ORDER BY as_of DESC, CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, id DESC LIMIT 1
  `).get(ticker, asOf));
  if (!estimate) return { available: false };
  const periods = toPlainRows(db.prepare(`
    SELECT * FROM earnings_estimate_periods
    WHERE estimate_id = ? AND included_in_ntm = 1
  `).all(estimate.id));
  const revision = (field) => {
    let current = 0;
    let previous = 0;
    let weight = 0;
    for (const period of periods) {
      if (!Number.isFinite(period[field]) || !Number.isFinite(period.eps_average)) continue;
      const periodWeight = Number(period.ntm_weight) || 0;
      current += period.eps_average * periodWeight;
      previous += period[field] * periodWeight;
      weight += periodWeight;
    }
    return weight > 0 && previous !== 0 ? (current - previous) / Math.abs(previous) : null;
  };
  return {
    available: true, asOf: estimate.as_of, value: round(estimate.eps_value, 4),
    analystCount: estimate.analyst_count, provider: estimate.provider,
    qualityStatus: estimate.quality_status,
    revision7d: round(revision('eps_average_7_days_ago'), 6),
    revision30d: round(revision('eps_average_30_days_ago'), 6)
  };
}

function financialMetricRows(db, ticker, metricKey, asOf) {
  const rows = toPlainRows(db.prepare(`
    SELECT value, period_end, filed_at, tag_priority
    FROM financial_facts
    WHERE ticker = ? AND metric_key = ? AND period_type = 'annual' AND filed_at < ?
    ORDER BY period_end DESC, filed_at DESC, tag_priority ASC
  `).all(ticker, metricKey, asOf));
  const distinct = new Map();
  for (const row of rows) if (!distinct.has(row.period_end)) distinct.set(row.period_end, row);
  return [...distinct.values()];
}

function fundamentalFeatures(db, ticker, asOf) {
  const revenue = financialMetricRows(db, ticker, 'revenue', asOf);
  const grossProfit = financialMetricRows(db, ticker, 'grossProfit', asOf);
  const latest = revenue[0] || null;
  const previous = revenue[1] || null;
  const matchingGross = latest && grossProfit.find((row) => row.period_end === latest.period_end);
  return {
    available: Boolean(latest),
    periodEnd: latest?.period_end || null,
    filedAt: latest?.filed_at || null,
    revenueGrowth: latest && previous?.value
      ? round((latest.value - previous.value) / Math.abs(previous.value), 6) : null,
    grossMargin: latest?.value && matchingGross
      ? round(matchingGross.value / latest.value, 6) : null
  };
}

function valuationFeatures(db, ticker, asOf, currentPrice, estimate) {
  const ttm = calculateTtmEps(db, ticker, asOf);
  return {
    available: Number.isFinite(ttm.value) || estimate.available,
    ttmEps: round(ttm.value, 4), ttmMethod: ttm.method,
    staticPe: currentPrice && ttm.value > 0 ? round(currentPrice / ttm.value, 4) : null,
    forwardEps: estimate.available ? estimate.value : null,
    forwardPe: currentPrice && estimate.value > 0 ? round(currentPrice / estimate.value, 4) : null,
    issue: ttm.issue || null
  };
}

function eventFeatures(db, ticker, asOf) {
  const rows = toPlainRows(db.prepare(`
    SELECT event_date, severity, source_type, evidence_json
    FROM research_events
    WHERE ticker = ? AND event_date BETWEEN date(?, '-30 days') AND date(?)
    ORDER BY event_date DESC
  `).all(ticker, asOf, asOf));
  let score = 0;
  for (const row of rows) {
    const evidence = parseJson(row.evidence_json, [])[0] || {};
    const magnitude = { P0: 1, P1: 0.75, P2: 0.4, P3: 0.15 }[row.severity] || 0.15;
    let direction = 0;
    if (row.source_type === 'NEWS_RISK') direction = -1;
    if (row.source_type === 'NEWS_IMPACT') {
      direction = evidence.direction === 'POSITIVE' ? 1 : evidence.direction === 'NEGATIVE' ? -1 : 0;
    }
    if (row.source_type === 'SEC_8K' && ['P0', 'P1'].includes(row.severity)) direction = -1;
    score += direction * magnitude;
  }
  const coverage = toPlain(db.prepare(`
    SELECT MAX(last_published_at) AS latest FROM news_sync_status
    WHERE ticker = ? AND COALESCE(last_as_of, '') <= ?
  `).get(ticker, asOf));
  return {
    available: rows.length > 0 || Boolean(coverage?.latest),
    eventCount30d: rows.length,
    score: round(clamp(score), 4)
  };
}

function macroFeatures(db, asOf) {
  const context = buildMarketContext(db, asOf);
  return {
    available: context.available, regime: context.regime, severity: context.severity,
    tenYearChangeBps: context.metrics.US10Y_YIELD?.changeBps ?? null,
    expectedRateChangeBps: context.metrics.FED_FUNDS_FUTURES?.changeBps ?? null
  };
}

function dataQuality(features) {
  const availability = {
    price: features.price.sampleSize >= 22,
    longPriceHistory: features.price.sampleSize >= 127,
    benchmark: Boolean(features.benchmarks.market?.available),
    capitalFlow: features.capitalFlow.available,
    valuation: features.valuation.available,
    earnings: features.earnings.available,
    fundamentals: features.fundamentals.available,
    macro: features.macro.available,
    events: features.events.available
  };
  const priceScore = features.price.sampleSize >= 127 ? 40 : features.price.sampleSize >= 64 ? 32 : features.price.sampleSize >= 22 ? 24 : 0;
  const score = priceScore
    + (availability.benchmark ? 6 : 0)
    + (availability.capitalFlow ? 12 : 0)
    + (availability.valuation ? 14 : 0)
    + (availability.earnings ? 10 : 0)
    + (availability.fundamentals ? 10 : 0)
    + (availability.macro ? 5 : 0)
    + (availability.events ? 3 : 0);
  const reasons = [];
  if (!features.price.currentPrice) reasons.push('缺少基准日收盘价');
  if (features.price.sampleSize < 22) reasons.push('少于22个有效历史交易日');
  if (features.price.priceDate !== features.asOf) reasons.push('基准日没有对应完整日线');
  return {
    score: round(score, 2), availability, reasons,
    eligible: reasons.length === 0 && score >= 35
  };
}

export function buildFeatureSnapshot(db, tickerValue, asOf) {
  const ticker = normalizeTicker(tickerValue);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ''))) throw new Error('特征基准日无效');
  if (!db.prepare('SELECT 1 FROM securities WHERE ticker = ?').get(ticker)) throw new Error('股票不存在');
  const prices = canonicalPrices(db, ticker, asOf);
  const price = priceFeatures(prices);
  const earnings = estimateFeatures(db, ticker, asOf);
  const features = {
    ticker, asOf,
    price,
    benchmarks: benchmarkFeatures(db, ticker, asOf),
    capitalFlow: (() => {
      const flow = analyzeCapitalFlow(db, ticker, asOf);
      return {
        available: flow.signal !== 'INSUFFICIENT', score: round(flow.score / 100, 4),
        confidence: flow.confidence, signal: flow.signal,
        relativeVolume: flow.metrics.relativeVolume
      };
    })(),
    earnings,
    valuation: valuationFeatures(db, ticker, asOf, price.currentPrice, earnings),
    fundamentals: fundamentalFeatures(db, ticker, asOf),
    macro: macroFeatures(db, asOf),
    events: eventFeatures(db, ticker, asOf)
  };
  const quality = dataQuality(features);
  return {
    ticker, asOf, priceDate: price.priceDate,
    featureVersion: FEATURE_VERSION, features,
    availability: quality.availability, dataQualityScore: quality.score,
    eligibleForTraining: quality.eligible, exclusionReasons: quality.reasons
  };
}

export function saveFeatureSnapshot(db, tickerValue, asOf) {
  const snapshot = buildFeatureSnapshot(db, tickerValue, asOf);
  db.prepare(`
    INSERT INTO feature_snapshots (
      ticker, as_of, price_date, feature_version, features_json, availability_json,
      data_quality_score, eligible_for_training, exclusion_reasons_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, as_of, feature_version) DO UPDATE SET
      price_date = excluded.price_date, features_json = excluded.features_json,
      availability_json = excluded.availability_json,
      data_quality_score = excluded.data_quality_score,
      eligible_for_training = excluded.eligible_for_training,
      exclusion_reasons_json = excluded.exclusion_reasons_json,
      created_at = excluded.created_at
  `).run(
    snapshot.ticker, snapshot.asOf, snapshot.priceDate, snapshot.featureVersion,
    JSON.stringify(snapshot.features), JSON.stringify(snapshot.availability),
    snapshot.dataQualityScore, snapshot.eligibleForTraining ? 1 : 0,
    JSON.stringify(snapshot.exclusionReasons), nowIso()
  );
  return snapshot;
}

function featureSignal(snapshot, horizonDays) {
  const { features } = snapshot;
  const momentumReturn = horizonDays === 21
    ? mean([features.price.return5d, features.price.return21d])
    : horizonDays === 63
      ? mean([features.price.return21d, features.price.return63d])
      : mean([features.price.return63d, features.price.return126d]);
  const momentumScale = HORIZON_CONFIG[horizonDays].scale;
  const benchmarkReturn = features.benchmarks.market?.[`return${horizonDays}d`];
  const stockReturn = features.price[`return${horizonDays}d`];
  const valuationValues = [features.valuation.forwardPe, features.valuation.staticPe]
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => clamp((30 - value) / 35));
  const earningsRevision = mean([features.earnings.revision7d, features.earnings.revision30d]);
  const fundamentalValues = [
    Number.isFinite(features.fundamentals.revenueGrowth) ? clamp(features.fundamentals.revenueGrowth / 0.30) : null,
    Number.isFinite(features.fundamentals.grossMargin) ? clamp((features.fundamentals.grossMargin - 0.35) / 0.30) : null
  ];
  const macro = { RATE_HEADWIND: -0.6, RATE_TAILWIND: 0.6, MIXED: 0, NEUTRAL: 0 }[features.macro.regime];
  return {
    momentum: Number.isFinite(momentumReturn) ? clamp(momentumReturn / momentumScale) : null,
    relativeStrength: Number.isFinite(stockReturn) && Number.isFinite(benchmarkReturn)
      ? clamp((stockReturn - benchmarkReturn) / momentumScale) : null,
    capitalFlow: features.capitalFlow.available ? features.capitalFlow.score : null,
    valuation: valuationValues.length ? mean(valuationValues) : null,
    earnings: Number.isFinite(earningsRevision) ? clamp(earningsRevision / 0.05) : null,
    fundamentals: fundamentalValues.some(Number.isFinite) ? mean(fundamentalValues) : null,
    macro: features.macro.available ? macro : null,
    events: features.events.available ? features.events.score : null
  };
}

function estimateTargetDate(asOf, horizonDays) {
  let targetDate = asOf;
  for (let index = 0; index < horizonDays; index += 1) {
    targetDate = nextRegularUsTradingDate(targetDate);
  }
  return targetDate;
}

export function predictFromSnapshot(snapshot, horizonDays) {
  if (!PREDICTION_HORIZONS.includes(Number(horizonDays))) throw new Error('预测期限必须为21、63或126个交易日');
  const horizon = Number(horizonDays);
  const configuration = HORIZON_CONFIG[horizon];
  const signals = featureSignal(snapshot, horizon);
  let weighted = 0;
  let coverage = 0;
  for (const [key, weight] of Object.entries(configuration.weights)) {
    if (!Number.isFinite(signals[key])) continue;
    weighted += signals[key] * weight;
    coverage += weight;
  }
  const rawSignal = coverage ? clamp(weighted / coverage) : 0;
  const qualityShrinkage = Math.max(0.35, snapshot.dataQualityScore / 100);
  const expectedReturn = clamp(rawSignal * configuration.scale * qualityShrinkage, -0.8, 2);
  const factorContributions = Object.fromEntries(Object.entries(configuration.weights).map(([key, weight]) => [
    key,
    Number.isFinite(signals[key]) && coverage
      ? round((signals[key] * weight / coverage) * configuration.scale * qualityShrinkage, 8)
      : null
  ]));
  const dailyVolatility = snapshot.features.price.volatility20d;
  const horizonVolatility = Number.isFinite(dailyVolatility)
    ? dailyVolatility * Math.sqrt(horizon)
    : configuration.scale;
  const intervalHalfWidth = Math.max(configuration.scale * 0.55, horizonVolatility * 1.28);
  const returnP10 = clamp(expectedReturn - intervalHalfWidth, -0.95, 3);
  const returnP90 = clamp(expectedReturn + intervalHalfWidth, -0.95, 3);
  const currentPrice = snapshot.features.price.currentPrice;
  const predictedDirection = expectedReturn > 0.01 ? 'BULLISH' : expectedReturn < -0.01 ? 'BEARISH' : 'NEUTRAL';
  return {
    ticker: snapshot.ticker, asOf: snapshot.asOf,
    targetDate: estimateTargetDate(snapshot.asOf, horizon),
    horizonDays: horizon, horizonLabel: configuration.label,
    currentPrice,
    returnP10: round(returnP10, 6), returnP50: round(expectedReturn, 6), returnP90: round(returnP90, 6),
    priceP10: round(currentPrice * (1 + returnP10), 4),
    priceP50: round(currentPrice * (1 + expectedReturn), 4),
    priceP90: round(currentPrice * (1 + returnP90), 4),
    probabilityUp: round(clamp(0.5 + (rawSignal * 0.35), 0.05, 0.95), 4),
    predictedDirection, signalScore: round(rawSignal * 100, 2),
    factorCoverage: round(coverage * 100, 2), dataQualityScore: snapshot.dataQualityScore,
    dataAvailability: snapshot.availability,
    eligible: snapshot.eligibleForTraining, exclusionReasons: snapshot.exclusionReasons,
    signals, factorContributions,
    featureVersion: FEATURE_VERSION, modelVersion: PREDICTION_MODEL_VERSION
  };
}

function targetObservation(db, ticker, asOf, horizonDays) {
  const row = toPlain(db.prepare(`
    SELECT trade_date, close FROM (
      SELECT trade_date, close,
             ROW_NUMBER() OVER (ORDER BY trade_date) AS session_number
      FROM (
        SELECT trade_date, close, provider, ingested_at,
               ROW_NUMBER() OVER (
                 PARTITION BY trade_date
                 ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
               ) AS source_number
        FROM prices_daily WHERE ticker = ? AND trade_date > ?
      ) WHERE source_number = 1
    ) WHERE session_number = ?
  `).get(ticker, asOf, horizonDays));
  return row || null;
}

function closeOnOrBefore(db, ticker, date) {
  return toPlain(db.prepare(`
    SELECT trade_date, close FROM (
      SELECT trade_date, close, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily WHERE ticker = ? AND trade_date <= ?
    ) WHERE row_number = 1 ORDER BY trade_date DESC LIMIT 1
  `).get(ticker, date)) || null;
}

function actualDirection(actualReturn) {
  if (actualReturn > 0.01) return 'BULLISH';
  if (actualReturn < -0.01) return 'BEARISH';
  return 'NEUTRAL';
}

function evaluatePrediction(db, prediction, snapshot) {
  if (!snapshot.eligibleForTraining) {
    return {
      status: 'EXCLUDED', exclusionReason: snapshot.exclusionReasons.join('；'),
      actualDate: null, actualReturn: null, benchmarkReturn: null, excessReturn: null,
      directionHit: null, intervalHit: null
    };
  }
  const target = targetObservation(db, prediction.ticker, prediction.asOf, prediction.horizonDays);
  if (!target) return {
    status: 'PENDING', exclusionReason: null, actualDate: null, actualReturn: null,
    benchmarkReturn: null, excessReturn: null, directionHit: null, intervalHit: null
  };
  const actualReturn = (target.close / prediction.currentPrice) - 1;
  const benchmark = snapshot.features.benchmarks.market;
  let benchmarkReturn = null;
  if (benchmark?.available) {
    const start = closeOnOrBefore(db, benchmark.symbol, prediction.asOf);
    const end = closeOnOrBefore(db, benchmark.symbol, target.trade_date);
    if (start?.close && end?.close && end.trade_date > start.trade_date) benchmarkReturn = (end.close / start.close) - 1;
  }
  return {
    status: 'MATURED', exclusionReason: null, actualDate: target.trade_date,
    actualReturn: round(actualReturn, 6), benchmarkReturn: round(benchmarkReturn, 6),
    excessReturn: round(Number.isFinite(benchmarkReturn) ? actualReturn - benchmarkReturn : null, 6),
    directionHit: prediction.predictedDirection === actualDirection(actualReturn),
    intervalHit: actualReturn >= prediction.returnP10 && actualReturn <= prediction.returnP90
  };
}

function saveBacktestResult(db, prediction, evaluation) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO prediction_backtest_results (
      ticker, as_of, horizon_days, target_date, actual_date, current_price,
      predicted_direction, probability_up, return_p10, return_p50, return_p90,
      actual_return, benchmark_return, excess_return, direction_hit, interval_hit,
      status, exclusion_reason, data_quality_score, feature_version, model_version,
      details_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, as_of, horizon_days, model_version) DO UPDATE SET
      target_date = excluded.target_date, actual_date = excluded.actual_date,
      actual_return = excluded.actual_return, benchmark_return = excluded.benchmark_return,
      excess_return = excluded.excess_return, direction_hit = excluded.direction_hit,
      interval_hit = excluded.interval_hit, status = excluded.status,
      exclusion_reason = excluded.exclusion_reason, details_json = excluded.details_json,
      updated_at = excluded.updated_at
  `).run(
    prediction.ticker, prediction.asOf, prediction.horizonDays, prediction.targetDate,
    evaluation.actualDate, prediction.currentPrice, prediction.predictedDirection,
    prediction.probabilityUp, prediction.returnP10, prediction.returnP50, prediction.returnP90,
    evaluation.actualReturn, evaluation.benchmarkReturn, evaluation.excessReturn,
    evaluation.directionHit == null ? null : evaluation.directionHit ? 1 : 0,
    evaluation.intervalHit == null ? null : evaluation.intervalHit ? 1 : 0,
    evaluation.status, evaluation.exclusionReason, prediction.dataQualityScore,
    prediction.featureVersion, prediction.modelVersion,
    JSON.stringify({ signals: prediction.signals, factorCoverage: prediction.factorCoverage }),
    timestamp, timestamp
  );
}

function reliabilityMetrics(rows, horizonDays) {
  const matured = rows.filter((row) => row.status === 'MATURED');
  const nonOverlapping = matured.filter((_, index) => index % horizonDays === 0);
  const sample = nonOverlapping.length ? nonOverlapping : matured;
  const directionAccuracy = mean(sample.map((row) => Number(row.direction_hit))) ?? 0;
  const brier = mean(sample.map((row) => {
    if (!Number.isFinite(row.probability_up) || !Number.isFinite(row.actual_return)) return null;
    return (row.probability_up - (row.actual_return > 0 ? 1 : 0)) ** 2;
  }));
  const empiricalCoverage = mean(sample.map((row) => Number(row.interval_hit))) ?? 0;
  const modelMae = mean(sample.map((row) => Math.abs(row.actual_return - row.return_p50)));
  const zeroMae = mean(sample.map((row) => Math.abs(row.actual_return)));
  const benchmarkMae = mean(sample.map((row) => (
    Number.isFinite(row.benchmark_return) ? Math.abs(row.actual_return - row.benchmark_return) : null
  )));
  const baselineMae = Math.min(...[zeroMae, benchmarkMae].filter((value) => Number.isFinite(value) && value > 0));
  const skill = Number.isFinite(modelMae) && Number.isFinite(baselineMae)
    ? 1 - (modelMae / baselineMae) : 0;
  const positiveRegime = sample.filter((row) => Number.isFinite(row.benchmark_return) && row.benchmark_return >= 0);
  const negativeRegime = sample.filter((row) => Number.isFinite(row.benchmark_return) && row.benchmark_return < 0);
  const regimeRates = [positiveRegime, negativeRegime]
    .filter((group) => group.length >= 2)
    .map((group) => mean(group.map((row) => Number(row.direction_hit))));
  const regimeStability = regimeRates.length >= 2
    ? 1 - Math.abs(regimeRates[0] - regimeRates[1]) : 0.5;
  return {
    rawSamples: matured.length,
    effectiveSamples: sample.length,
    directionAccuracy: round(directionAccuracy * 100, 2),
    probabilityCalibration: round(clamp(1 - ((brier ?? 0.25) / 0.25), 0, 1) * 100, 2),
    intervalCoverage: round(clamp(1 - (Math.abs(empiricalCoverage - 0.8) * 2), 0, 1) * 100, 2),
    benchmarkSkill: round(clamp(0.5 + (skill * 0.5), 0, 1) * 100, 2),
    regimeStability: round(clamp(regimeStability, 0, 1) * 100, 2),
    dataQuality: round(mean(sample.map((row) => row.data_quality_score)) ?? 0, 2),
    empiricalIntervalCoverage: round(empiricalCoverage * 100, 2),
    modelMae: round(modelMae, 6), zeroReturnMae: round(zeroMae, 6),
    benchmarkMae: round(benchmarkMae, 6)
  };
}

function saveAutomaticReliability(db, ticker, horizonDays, asOf) {
  const rows = toPlainRows(db.prepare(`
    SELECT * FROM prediction_backtest_results
    WHERE ticker = ? AND horizon_days = ? AND model_version = ? AND as_of <= ?
    ORDER BY as_of
  `).all(ticker, horizonDays, PREDICTION_MODEL_VERSION, asOf));
  const metrics = reliabilityMetrics(rows, horizonDays);
  const result = calculateReliability({ horizonDays, ...metrics });
  db.prepare(`
    INSERT INTO reliability_scores (
      ticker, horizon_days, model_version, as_of, direction_accuracy,
      probability_calibration, interval_coverage, benchmark_skill,
      regime_stability, data_quality, effective_samples, composite_score,
      status, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, horizon_days, model_version, as_of) DO UPDATE SET
      direction_accuracy = excluded.direction_accuracy,
      probability_calibration = excluded.probability_calibration,
      interval_coverage = excluded.interval_coverage,
      benchmark_skill = excluded.benchmark_skill,
      regime_stability = excluded.regime_stability,
      data_quality = excluded.data_quality,
      effective_samples = excluded.effective_samples,
      composite_score = excluded.composite_score,
      status = excluded.status,
      details_json = excluded.details_json
  `).run(
    ticker, horizonDays, PREDICTION_MODEL_VERSION, asOf,
    result.directionAccuracy, result.probabilityCalibration, result.intervalCoverage,
    result.benchmarkSkill, result.regimeStability, result.dataQuality,
    result.effectiveSamples, result.compositeScore, result.status,
    JSON.stringify({
      rawSamples: metrics.rawSamples, requiredSamples: result.requiredSamples,
      gate: result.gate, empiricalIntervalCoverage: metrics.empiricalIntervalCoverage,
      modelMae: metrics.modelMae, zeroReturnMae: metrics.zeroReturnMae,
      benchmarkMae: metrics.benchmarkMae,
      overlapPolicy: `按每${horizonDays}个交易日抽取一个非重叠样本计算可靠度`
    })
  );
  return { ticker, horizonDays, asOf, modelVersion: PREDICTION_MODEL_VERSION, ...result, ...metrics };
}

function saveCurrentPrediction(db, prediction, reliability) {
  const status = reliability?.status || 'INSUFFICIENT';
  const existing = toPlain(db.prepare(`
    SELECT id FROM predictions
    WHERE ticker = ? AND as_of = ? AND horizon_days = ? AND model_version = ?
    ORDER BY id DESC LIMIT 1
  `).get(prediction.ticker, prediction.asOf, prediction.horizonDays, prediction.modelVersion));
  const values = [
    prediction.targetDate, prediction.currentPrice, prediction.returnP10, prediction.returnP50,
    prediction.returnP90, prediction.priceP10, prediction.priceP50, prediction.priceP90,
    prediction.probabilityUp, reliability?.compositeScore ?? 0, status,
    prediction.featureVersion,
    JSON.stringify({
      predictedDirection: prediction.predictedDirection, signals: prediction.signals,
      factorContributions: prediction.factorContributions,
      signalScore: prediction.signalScore, factorCoverage: prediction.factorCoverage,
      dataQualityScore: prediction.dataQualityScore,
      dataAvailability: prediction.dataAvailability,
      exclusionReasons: prediction.exclusionReasons
    }), nowIso()
  ];
  if (existing) {
    db.prepare(`
      UPDATE predictions SET
        target_date = ?, current_price = ?, return_p10 = ?, return_p50 = ?, return_p90 = ?,
        price_p10 = ?, price_p50 = ?, price_p90 = ?, probability_up = ?,
        reliability_score = ?, publication_status = ?, feature_version = ?,
        rationale_json = ?, created_at = ?
      WHERE id = ?
    `).run(...values, existing.id);
  } else {
    db.prepare(`
      INSERT INTO predictions (
        ticker, as_of, target_date, horizon_days, current_price,
        return_p10, return_p50, return_p90, price_p10, price_p50, price_p90,
        probability_up, reliability_score, publication_status, model_version,
        feature_version, rationale_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      prediction.ticker, prediction.asOf, prediction.targetDate, prediction.horizonDays,
      prediction.currentPrice, prediction.returnP10, prediction.returnP50, prediction.returnP90,
      prediction.priceP10, prediction.priceP50, prediction.priceP90,
      prediction.probabilityUp, reliability?.compositeScore ?? 0, status,
      prediction.modelVersion, prediction.featureVersion,
      JSON.stringify({
        predictedDirection: prediction.predictedDirection, signals: prediction.signals,
        factorContributions: prediction.factorContributions,
        signalScore: prediction.signalScore, factorCoverage: prediction.factorCoverage,
        dataQualityScore: prediction.dataQualityScore,
        dataAvailability: prediction.dataAvailability,
        exclusionReasons: prediction.exclusionReasons
      }), nowIso()
    );
  }
  return { ...prediction, reliabilityScore: reliability?.compositeScore ?? 0, publicationStatus: status };
}

function snapshotFromRow(row) {
  return {
    ticker: row.ticker, asOf: row.as_of, priceDate: row.price_date,
    featureVersion: row.feature_version,
    features: parseJson(row.features_json, {}),
    availability: parseJson(row.availability_json, {}),
    dataQualityScore: row.data_quality_score,
    eligibleForTraining: Boolean(row.eligible_for_training),
    exclusionReasons: parseJson(row.exclusion_reasons_json, [])
  };
}

function directionFromPrediction(row, rationale) {
  if (rationale?.predictedDirection) return rationale.predictedDirection;
  if (row.return_p50 > 0.01) return 'BULLISH';
  if (row.return_p50 < -0.01) return 'BEARISH';
  return 'NEUTRAL';
}

function changeType(previous, current, returnChange, probabilityChange) {
  if (previous !== current) return 'DIRECTION_CHANGE';
  if (Math.abs(returnChange) >= 0.02 || Math.abs(probabilityChange || 0) >= 0.05) return 'MATERIAL_CHANGE';
  if (Math.abs(returnChange) >= 0.005) return 'MODERATE_CHANGE';
  return 'STABLE';
}

function signedPoints(value) {
  if (!Number.isFinite(value)) return '0.00个百分点';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}个百分点`;
}

function absolutePoints(value) {
  return `${(Math.abs(Number(value) || 0) * 100).toFixed(2)}个百分点`;
}

function signedPercentValue(value) {
  if (!Number.isFinite(value)) return '0.00%';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

function buildChangeSummary(horizonDays, previousAsOf, asOf, type, returnChange, contributions) {
  const drivers = contributions.filter((item) => Math.abs(item.delta) >= 0.00005).slice(0, 3);
  const direction = returnChange > 0 ? '上调' : returnChange < 0 ? '下调' : '基本不变';
  const driverText = drivers.length
    ? `主要变化来自${drivers.map((item) => `${item.label}${signedPoints(item.delta)}`).join('、')}。`
    : '各结构化因子贡献没有明显变化。';
  return {
    headline: `${HORIZON_CONFIG[horizonDays].label}预期收益较${previousAsOf}${direction}${absolutePoints(returnChange)}。${driverText}`,
    drivers,
    changeType: type,
    comparison: `${previousAsOf} → ${asOf}`,
    boundary: '归因是同一冻结模型内的数学贡献变化，不等同于对股价变化建立因果关系。'
  };
}

export function savePredictionChanges(db, tickerValue, asOf) {
  const ticker = normalizeTicker(tickerValue);
  const saved = [];
  for (const horizonDays of PREDICTION_HORIZONS) {
    const current = toPlain(db.prepare(`
      SELECT * FROM predictions
      WHERE ticker = ? AND as_of = ? AND horizon_days = ? AND model_version = ?
      ORDER BY id DESC LIMIT 1
    `).get(ticker, asOf, horizonDays, PREDICTION_MODEL_VERSION));
    if (!current) continue;
    const previous = toPlain(db.prepare(`
      SELECT * FROM predictions
      WHERE ticker = ? AND as_of < ? AND horizon_days = ? AND model_version = ?
      ORDER BY as_of DESC, id DESC LIMIT 1
    `).get(ticker, asOf, horizonDays, PREDICTION_MODEL_VERSION));
    if (!previous) continue;
    const currentRationale = parseJson(current.rationale_json, {});
    const previousRationale = parseJson(previous.rationale_json, {});
    const currentContributions = currentRationale.factorContributions || {};
    const previousContributions = previousRationale.factorContributions || {};
    const contributions = Object.keys(FACTOR_LABELS).map((key) => {
      const before = Number.isFinite(previousContributions[key]) ? previousContributions[key] : 0;
      const after = Number.isFinite(currentContributions[key]) ? currentContributions[key] : 0;
      return {
        key, label: FACTOR_LABELS[key], previous: round(before, 8), current: round(after, 8),
        delta: round(after - before, 8),
        previousSignal: previousRationale.signals?.[key] ?? null,
        currentSignal: currentRationale.signals?.[key] ?? null
      };
    }).sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
    const explainedChange = contributions.reduce((sum, item) => sum + item.delta, 0);
    const returnChange = current.return_p50 - previous.return_p50;
    const probabilityChange = Number.isFinite(current.probability_up) && Number.isFinite(previous.probability_up)
      ? current.probability_up - previous.probability_up : null;
    const previousDirection = directionFromPrediction(previous, previousRationale);
    const currentDirection = directionFromPrediction(current, currentRationale);
    const type = changeType(previousDirection, currentDirection, returnChange, probabilityChange);
    const marketPriceEffect = (current.current_price - previous.current_price) * (1 + previous.return_p50);
    const returnOutlookEffect = current.current_price * returnChange;
    const priceTargetChange = current.price_p50 - previous.price_p50;
    const summary = buildChangeSummary(
      horizonDays, previous.as_of, current.as_of, type, returnChange, contributions
    );
    summary.dataQuality = {
      previous: previousRationale.dataQualityScore ?? null,
      current: currentRationale.dataQualityScore ?? null,
      delta: Number.isFinite(currentRationale.dataQualityScore) && Number.isFinite(previousRationale.dataQualityScore)
        ? round(currentRationale.dataQualityScore - previousRationale.dataQualityScore, 2) : null
    };
    summary.factorCoverage = {
      previous: previousRationale.factorCoverage ?? null,
      current: currentRationale.factorCoverage ?? null,
      delta: Number.isFinite(currentRationale.factorCoverage) && Number.isFinite(previousRationale.factorCoverage)
        ? round(currentRationale.factorCoverage - previousRationale.factorCoverage, 2) : null
    };
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO prediction_change_snapshots (
        ticker, as_of, previous_as_of, horizon_days, comparison_type,
        previous_direction, current_direction, previous_return_p50, current_return_p50,
        return_change, previous_probability_up, current_probability_up, probability_change,
        previous_price_p50, current_price_p50, price_target_change,
        market_price_effect, return_outlook_effect, residual_return_change, change_type,
        contributions_json, summary_json, feature_version, model_version, created_at
      ) VALUES (?, ?, ?, ?, 'SAME_HORIZON', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker, as_of, horizon_days, comparison_type, model_version)
      DO UPDATE SET
        previous_as_of = excluded.previous_as_of,
        previous_direction = excluded.previous_direction,
        current_direction = excluded.current_direction,
        previous_return_p50 = excluded.previous_return_p50,
        current_return_p50 = excluded.current_return_p50,
        return_change = excluded.return_change,
        previous_probability_up = excluded.previous_probability_up,
        current_probability_up = excluded.current_probability_up,
        probability_change = excluded.probability_change,
        previous_price_p50 = excluded.previous_price_p50,
        current_price_p50 = excluded.current_price_p50,
        price_target_change = excluded.price_target_change,
        market_price_effect = excluded.market_price_effect,
        return_outlook_effect = excluded.return_outlook_effect,
        residual_return_change = excluded.residual_return_change,
        change_type = excluded.change_type,
        contributions_json = excluded.contributions_json,
        summary_json = excluded.summary_json,
        feature_version = excluded.feature_version,
        created_at = excluded.created_at
    `).run(
      ticker, current.as_of, previous.as_of, horizonDays,
      previousDirection, currentDirection, previous.return_p50, current.return_p50,
      round(returnChange, 8), previous.probability_up, current.probability_up,
      round(probabilityChange, 8), previous.price_p50, current.price_p50,
      round(priceTargetChange, 4), round(marketPriceEffect, 4), round(returnOutlookEffect, 4),
      round(returnChange - explainedChange, 8), type,
      JSON.stringify(contributions), JSON.stringify(summary), current.feature_version,
      PREDICTION_MODEL_VERSION, timestamp
    );
    saved.push({
      ticker, asOf: current.as_of, previousAsOf: previous.as_of, horizonDays,
      comparisonType: 'SAME_HORIZON', previousDirection, currentDirection,
      previousReturnP50: previous.return_p50, currentReturnP50: current.return_p50,
      returnChange: round(returnChange, 8), probabilityChange: round(probabilityChange, 8),
      priceTargetChange: round(priceTargetChange, 4), marketPriceEffect: round(marketPriceEffect, 4),
      returnOutlookEffect: round(returnOutlookEffect, 4),
      residualReturnChange: round(returnChange - explainedChange, 8),
      changeType: type, contributions, summary
    });
  }
  return saved;
}

export function listPredictionChanges(db, tickerValue, limitPerHorizon = 10, asOf = null) {
  const ticker = normalizeTicker(tickerValue);
  const limit = Math.min(60, Math.max(1, Number(limitPerHorizon) || 10));
  return toPlainRows(db.prepare(`
    SELECT * FROM (
      SELECT c.*,
             ROW_NUMBER() OVER (PARTITION BY horizon_days ORDER BY as_of DESC) AS row_number
      FROM prediction_change_snapshots c
      WHERE ticker = ? AND model_version = ? AND comparison_type = 'SAME_HORIZON'
        AND (? IS NULL OR as_of <= ?)
    ) WHERE row_number <= ? ORDER BY as_of DESC, horizon_days
  `).all(ticker, PREDICTION_MODEL_VERSION, asOf, asOf, limit)).map((row) => ({
    ...row,
    contributions: parseJson(row.contributions_json, []),
    summary: parseJson(row.summary_json, {})
  }));
}

function calendarDayDistance(left, right) {
  const leftTime = Date.parse(`${left}T00:00:00.000Z`);
  const rightTime = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(leftTime - rightTime) / 86_400_000);
}

function fixedTargetPoint(row, anchorTargetDate) {
  const targetPrice = (returnValue) => Number.isFinite(row.current_price) && Number.isFinite(returnValue)
    ? round(row.current_price * (1 + returnValue), 4) : null;
  return {
    asOf: row.as_of,
    horizonDays: row.horizon_days,
    horizonLabel: HORIZON_CONFIG[row.horizon_days]?.label || `${row.horizon_days}个交易日`,
    targetDate: row.target_date,
    targetDateOffsetDays: calendarDayDistance(row.target_date, anchorTargetDate),
    currentPrice: row.current_price,
    returnP10: row.return_p10,
    returnP50: row.return_p50,
    returnP90: row.return_p90,
    targetPriceP10: targetPrice(row.return_p10),
    targetPriceP50: targetPrice(row.return_p50),
    targetPriceP90: targetPrice(row.return_p90),
    probabilityUp: row.probability_up,
    predictedDirection: row.predicted_direction,
    dataQualityScore: row.data_quality_score,
    validationStatus: row.status,
    featureVersion: row.feature_version,
    modelVersion: row.model_version
  };
}

function fixedTargetSummary(anchorTargetDate, points) {
  const oldest = points[0];
  const latest = points.at(-1);
  const targetPriceChange = round(latest.targetPriceP50 - oldest.targetPriceP50, 4);
  const targetPriceChangePct = oldest.targetPriceP50
    ? round(targetPriceChange / oldest.targetPriceP50, 8) : null;
  const revision = targetPriceChangePct > 0.01
    ? 'UPGRADED' : targetPriceChangePct < -0.01 ? 'DOWNGRADED' : 'STABLE';
  const revisionLabel = revision === 'UPGRADED' ? '上调' : revision === 'DOWNGRADED' ? '下调' : '基本不变';
  const prices = points.map((point) => point.targetPriceP50).filter(Number.isFinite);
  const averagePrice = mean(prices);
  const targetSpreadPct = prices.length > 1 && averagePrice
    ? round((Math.max(...prices) - Math.min(...prices)) / Math.abs(averagePrice), 8) : 0;
  const lowerBound = Math.max(...points.map((point) => point.targetPriceP10).filter(Number.isFinite));
  const upperBound = Math.min(...points.map((point) => point.targetPriceP90).filter(Number.isFinite));
  const intervalsOverlap = Number.isFinite(lowerBound) && Number.isFinite(upperBound) && lowerBound <= upperBound;
  const exactMatches = points.filter((point) => point.targetDateOffsetDays === 0).length;
  return {
    revision,
    targetPriceChange,
    targetPriceChangePct,
    targetSpreadPct,
    intervalsOverlap,
    commonInterval: intervalsOverlap ? { low: round(lowerBound, 4), high: round(upperBound, 4) } : null,
    exactMatches,
    headline: `对${anchorTargetDate}附近的目标中位价由${oldest.targetPriceP50.toFixed(2)}美元${revisionLabel}至${latest.targetPriceP50.toFixed(2)}美元（${signedPercentValue(targetPriceChangePct)}）。`,
    interpretation: revision === 'STABLE'
      ? '随着目标日临近，中位目标价变化不超过1%，跨期限观点暂时稳定。'
      : `随着目标日临近，模型对同一终点的估值已${revisionLabel}；需结合逐日因子归因判断变化来源。`,
    boundary: '比较使用同一模型版本，并允许估算目标日相差最多7个自然日以容纳节假日；不同起点的收益率不直接互比，结论不代表因果关系。'
  };
}

export function buildFixedTargetComparisons(db, tickerValue, asOf = null, options = {}) {
  const ticker = normalizeTicker(tickerValue);
  const alignmentWindowDays = Math.min(14, Math.max(0, Number(options.alignmentWindowDays) || 7));
  const rows = toPlainRows(db.prepare(`
    SELECT ticker, as_of, horizon_days, target_date, current_price, predicted_direction,
           probability_up, return_p10, return_p50, return_p90, status,
           data_quality_score, feature_version, model_version
    FROM prediction_backtest_results
    WHERE ticker = ? AND model_version = ? AND (? IS NULL OR as_of <= ?)
    ORDER BY as_of DESC, horizon_days
  `).all(ticker, PREDICTION_MODEL_VERSION, asOf, asOf));
  const comparisons = [];
  for (const anchorHorizon of [21, 63]) {
    const anchor = rows.find((row) => row.horizon_days === anchorHorizon);
    if (!anchor?.target_date) continue;
    const points = PREDICTION_HORIZONS
      .filter((horizonDays) => horizonDays >= anchorHorizon)
      .map((horizonDays) => rows
        .filter((row) => row.horizon_days === horizonDays && row.as_of <= anchor.as_of && row.target_date)
        .map((row) => ({ row, distance: calendarDayDistance(row.target_date, anchor.target_date) }))
        .filter((candidate) => candidate.distance <= alignmentWindowDays)
        .sort((left, right) => left.distance - right.distance || right.row.as_of.localeCompare(left.row.as_of))[0]?.row)
      .filter(Boolean)
      .map((row) => fixedTargetPoint(row, anchor.target_date))
      .sort((left, right) => right.horizonDays - left.horizonDays);
    if (points.length < 2) continue;
    comparisons.push({
      ticker,
      anchorTargetDate: anchor.target_date,
      anchorAsOf: anchor.as_of,
      anchorHorizonDays: anchorHorizon,
      alignmentWindowDays,
      points,
      summary: fixedTargetSummary(anchor.target_date, points)
    });
  }
  return comparisons;
}

export function runPredictionBacktest(db, tickerValue, asOf, options = {}) {
  const ticker = normalizeTicker(tickerValue);
  const dates = allCanonicalDates(db, ticker, asOf);
  const maximum = Math.min(1600, Math.max(30, Number(options.maxSessions) || 1600));
  const selectedDates = dates.slice(-maximum);
  let generated = 0;
  let excluded = 0;
  for (const date of selectedDates) {
    // 同一特征版本按日期幂等重算，使后来补齐的基准、SEC或宏观历史数据
    // 能进入回测；主键确保不会因重复运行增加样本数量。
    const snapshot = saveFeatureSnapshot(db, ticker, date);
    if (!snapshot.eligibleForTraining) excluded += 1;
    for (const horizonDays of PREDICTION_HORIZONS) {
      const prediction = predictFromSnapshot(snapshot, horizonDays);
      saveBacktestResult(db, prediction, evaluatePrediction(db, prediction, snapshot));
      generated += 1;
    }
  }
  const reliability = PREDICTION_HORIZONS.map((horizonDays) => (
    saveAutomaticReliability(db, ticker, horizonDays, asOf)
  ));
  const latestSnapshot = saveFeatureSnapshot(db, ticker, asOf);
  const predictions = PREDICTION_HORIZONS.map((horizonDays) => saveCurrentPrediction(
    db, predictFromSnapshot(latestSnapshot, horizonDays),
    reliability.find((item) => item.horizonDays === horizonDays)
  ));
  const changes = savePredictionChanges(db, ticker, asOf);
  return {
    ticker, asOf, featureVersion: FEATURE_VERSION, modelVersion: PREDICTION_MODEL_VERSION,
    datesProcessed: selectedDates.length, resultsUpdated: generated, excludedDates: excluded,
    latestFeature: latestSnapshot, predictions, reliability, changes,
    methodology: {
      validation: '冻结规则模型按历史交易日逐日生成时点预测，再使用其后第21/63/126个交易日收盘价验证。',
      leakage: '价格只读取基准日及之前日线；财务数据按SEC提交日截断；一致预期按as_of截断。',
      overlap: '可靠度只使用按期限间隔抽取的非重叠样本；全部重叠样本仅用于诊断。',
      boundary: 'V1是可解释基线模型，不代表已经训练完成；未达到样本量和85分综合可靠度时保持样本不足或观察状态。'
    }
  };
}

export function getPredictionOverview(db, tickerValue, asOf = null) {
  const ticker = normalizeTicker(tickerValue);
  const effectiveAsOf = asOf || toPlain(db.prepare(`
    SELECT MAX(trade_date) AS value FROM prices_daily WHERE ticker = ?
  `).get(ticker))?.value;
  const featureRow = effectiveAsOf ? toPlain(db.prepare(`
    SELECT * FROM feature_snapshots
    WHERE ticker = ? AND as_of <= ? AND feature_version = ?
    ORDER BY as_of DESC LIMIT 1
  `).get(ticker, effectiveAsOf, FEATURE_VERSION)) : null;
  const predictions = toPlainRows(db.prepare(`
    SELECT * FROM predictions
    WHERE ticker = ? AND model_version = ?
      AND (? IS NULL OR as_of <= ?)
    ORDER BY as_of DESC, horizon_days, id DESC
  `).all(ticker, PREDICTION_MODEL_VERSION, effectiveAsOf, effectiveAsOf));
  const latestByHorizon = [];
  const seen = new Set();
  for (const row of predictions) {
    if (seen.has(row.horizon_days)) continue;
    seen.add(row.horizon_days);
    latestByHorizon.push({ ...row, rationale: parseJson(row.rationale_json, {}) });
  }
  const reliability = PREDICTION_HORIZONS.map((horizonDays) => {
    const row = toPlain(db.prepare(`
      SELECT * FROM reliability_scores
      WHERE ticker = ? AND horizon_days = ? AND model_version = ?
        AND (? IS NULL OR as_of <= ?)
      ORDER BY as_of DESC, id DESC LIMIT 1
    `).get(ticker, horizonDays, PREDICTION_MODEL_VERSION, effectiveAsOf, effectiveAsOf));
    return row ? { ...row, details: parseJson(row.details_json, {}) } : null;
  }).filter(Boolean);
  const backtest = PREDICTION_HORIZONS.map((horizonDays) => {
    const counts = toPlain(db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'MATURED' THEN 1 ELSE 0 END) AS matured,
             SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status = 'EXCLUDED' THEN 1 ELSE 0 END) AS excluded,
             SUM(CASE WHEN status = 'MATURED' AND direction_hit = 1 THEN 1 ELSE 0 END) AS hits
      FROM prediction_backtest_results
      WHERE ticker = ? AND horizon_days = ? AND model_version = ?
    `).get(ticker, horizonDays, PREDICTION_MODEL_VERSION));
    return { horizonDays, ...counts };
  });
  const changes = listPredictionChanges(db, ticker, 10, effectiveAsOf);
  const fixedTargetComparisons = buildFixedTargetComparisons(db, ticker, effectiveAsOf);
  return {
    ticker, asOf: effectiveAsOf || null,
    feature: featureRow ? snapshotFromRow(featureRow) : null,
    predictions: latestByHorizon, reliability, backtest, changes, fixedTargetComparisons,
    featureVersion: FEATURE_VERSION, modelVersion: PREDICTION_MODEL_VERSION,
    reliabilityGate: config.reliabilityGate
  };
}

export function runWatchlistPredictionBacktests(db, asOf, options = {}) {
  const tickers = toPlainRows(db.prepare(`
    SELECT ticker FROM watchlist_items WHERE enabled = 1 ORDER BY ticker
  `).all());
  return tickers.map(({ ticker }) => {
    try {
      return { ticker, ok: true, result: runPredictionBacktest(db, ticker, asOf, options) };
    } catch (error) {
      return { ticker, ok: false, error: error.message };
    }
  });
}
