import { config } from './config.js';
import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker, parseJson, round } from './domain.js';
import { getExternalDriversOverview } from './external-drivers.js';
import { calculatePosition } from './portfolio.js';
import { getValuationOverview } from './valuation.js';
import { analyzeCapitalFlow } from './capital-flow.js';
import { analyzeIntradayFlow } from './intraday-flow.js';
import { getCapitalBehaviorOverview } from './capital-behavior.js';

export const ADVICE_MODEL_VERSION = 'evidence-impact-advice-v4-2026-09-05';
export const ADVICE_HORIZONS = Object.freeze([21, 63, 126]);

const HORIZON_LABELS = { 21: '1个月', 63: '3个月', 126: '6个月' };
const COMPONENT_WEIGHTS = Object.freeze({
  21: { price: 0.20, capitalFlow: 0.16, intradayFlow: 0.10, events: 0.20, macro: 0.12, valuation: 0.08, earnings: 0.08, fundamentals: 0.06 },
  63: { price: 0.11, capitalFlow: 0.10, intradayFlow: 0.06, events: 0.17, macro: 0.13, valuation: 0.18, earnings: 0.18, fundamentals: 0.07 },
  126: { price: 0.08, capitalFlow: 0.06, intradayFlow: 0.03, events: 0.14, macro: 0.14, valuation: 0.24, earnings: 0.19, fundamentals: 0.12 }
});

const ACTION_LABELS = Object.freeze({
  BUY_CANDIDATE: '候选买入', ADD_CANDIDATE: '候选加仓', HOLD: '持有',
  REDUCE_CANDIDATE: '候选减仓', EXIT_RISK_REVIEW: '风险退出评估',
  REDUCE_REVIEW: '谨慎持有/评估减仓', HOLD_REVIEW: '持有并复核',
  WATCH: '观察', AVOID: '暂不买入'
});

function clamp(value, minimum = -100, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function priceContext(db, ticker, asOf, horizonDays) {
  const rows = toPlainRows(db.prepare(`
    SELECT trade_date, close, volume FROM (
      SELECT trade_date, close, volume, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily WHERE ticker = ? AND trade_date <= ?
    ) WHERE row_number = 1 ORDER BY trade_date DESC LIMIT 130
  `).all(ticker, asOf));
  const current = rows[0] || null;
  const anchor = rows[horizonDays] || null;
  const returns = rows.slice(0, 21).flatMap((row, index) => {
    const previous = rows[index + 1];
    return previous?.close ? [(row.close / previous.close) - 1] : [];
  });
  const mean = average(returns);
  const variance = mean == null || returns.length < 5
    ? null
    : returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1);
  const horizonReturn = current && anchor?.close ? (current.close / anchor.close) - 1 : null;
  const scale = { 21: 0.08, 63: 0.15, 126: 0.25 }[horizonDays];
  return {
    available: Boolean(current), currentPrice: current?.close ?? null,
    priceDate: current?.trade_date || null, anchorDate: anchor?.trade_date || null,
    horizonReturn: round(horizonReturn, 6),
    dailyVolatility20d: variance == null ? null : round(Math.sqrt(variance), 6),
    score: horizonReturn == null ? null : round(clamp((horizonReturn / scale) * 100), 2)
  };
}

function latestPrediction(db, ticker, asOf, horizonDays) {
  const selection = toPlain(db.prepare(`
    SELECT selected_model_version FROM prediction_model_evaluations
    WHERE ticker = ? AND horizon_days = ? AND date(as_of) <= date(?)
    ORDER BY as_of DESC LIMIT 1
  `).get(ticker, horizonDays, asOf));
  const selectedModelVersion = selection?.selected_model_version || null;
  const prediction = toPlain(db.prepare(`
    SELECT * FROM predictions
    WHERE ticker = ? AND horizon_days = ? AND date(as_of) <= date(?)
      AND (? IS NULL OR model_version = ?)
    ORDER BY as_of DESC, id DESC LIMIT 1
  `).get(ticker, horizonDays, asOf, selectedModelVersion, selectedModelVersion));
  const reliabilityVersion = prediction?.model_version || selectedModelVersion;
  const reliability = toPlain(db.prepare(`
    SELECT composite_score, status, effective_samples, as_of
    FROM reliability_scores
    WHERE ticker = ? AND horizon_days = ? AND date(as_of) <= date(?)
      AND (? IS NULL OR model_version = ?)
    ORDER BY as_of DESC, id DESC LIMIT 1
  `).get(ticker, horizonDays, asOf, reliabilityVersion, reliabilityVersion));
  if (!prediction) return { available: false, reliability: reliability || null };
  return {
    available: true,
    asOf: prediction.as_of, targetDate: prediction.target_date,
    returnP10: prediction.return_p10, returnP50: prediction.return_p50,
    returnP90: prediction.return_p90, priceP10: prediction.price_p10,
    priceP50: prediction.price_p50, priceP90: prediction.price_p90,
    probabilityUp: prediction.probability_up,
    reliabilityScore: prediction.reliability_score ?? reliability?.composite_score ?? null,
    publicationStatus: prediction.publication_status,
    modelVersion: prediction.model_version,
    reliability: reliability || null
  };
}

function valuationScore(valuation) {
  const relative = valuation.relativeToPeers || {};
  const history = valuation.historicalValuation || {};
  const premiums = [relative.forwardPePremium, relative.staticPePremium]
    .filter(Number.isFinite).map((premium) => clamp(-premium * 250, -70, 70));
  const percentiles = [history.forwardPe?.percentile, history.staticPe?.percentile]
    .filter(Number.isFinite).map((percentile) => clamp((50 - percentile) * 1.4, -70, 70));
  const score = average([...premiums, ...percentiles]);
  return {
    available: score != null, score: round(score, 2),
    forwardPe: valuation.target?.forwardPe ?? null,
    staticPe: valuation.target?.staticPe ?? null,
    forwardPePremium: relative.forwardPePremium ?? null,
    staticPePremium: relative.staticPePremium ?? null,
    forwardPePercentile: history.forwardPe?.percentile ?? null,
    staticPePercentile: history.staticPe?.percentile ?? null,
    issues: valuation.target?.issues || []
  };
}

function earningsScore(valuation) {
  const revision = valuation.target?.estimate?.revision;
  const thirtyDay = revision?.thirtyDay;
  const sevenDay = revision?.sevenDay;
  const changes = [
    Number.isFinite(thirtyDay?.changePct) ? clamp(thirtyDay.changePct * 1000, -80, 80) : null,
    Number.isFinite(sevenDay?.changePct) ? clamp(sevenDay.changePct * 1200, -80, 80) : null,
    Number.isFinite(thirtyDay?.revisionBreadth) ? thirtyDay.revisionBreadth * 60 : null,
    Number.isFinite(sevenDay?.revisionBreadth) ? sevenDay.revisionBreadth * 50 : null
  ];
  const score = average(changes);
  return {
    available: score != null, score: round(score, 2),
    sevenDay: sevenDay || null, thirtyDay: thirtyDay || null,
    qualityStatus: valuation.target?.estimate?.qualityStatus || null
  };
}

function fundamentalsScore(valuation) {
  const target = valuation.target || {};
  const peer = valuation.peerMedian || {};
  const signals = [];
  if (Number.isFinite(target.revenueGrowth)) signals.push(clamp(target.revenueGrowth * 250, -75, 75));
  if (Number.isFinite(target.grossMargin) && Number.isFinite(peer.grossMargin)) {
    signals.push(clamp((target.grossMargin - peer.grossMargin) * 250, -75, 75));
  }
  const score = average(signals);
  return {
    available: score != null, score: round(score, 2),
    revenueGrowth: target.revenueGrowth ?? null, grossMargin: target.grossMargin ?? null,
    peerGrossMargin: peer.grossMargin ?? null
  };
}

function macroScore(macro, horizonDays) {
  const base = {
    RATE_HEADWIND: -50, RATE_TAILWIND: 50, MIXED: 0, NEUTRAL: 0
  }[macro?.regime];
  const horizonMultiplier = { 21: 1, 63: 0.85, 126: 0.7 }[horizonDays];
  return {
    available: Boolean(macro?.available), score: Number.isFinite(base) ? round(base * horizonMultiplier, 2) : null,
    regime: macro?.regime || 'UNKNOWN', severity: macro?.severity || null,
    summary: macro?.summary || '宏观数据不足'
  };
}

function eventContext(db, ticker, asOf, horizonDays) {
  const lookback = Math.min(90, Math.max(14, Math.round(horizonDays / 2)));
  const rows = toPlainRows(db.prepare(`
    SELECT event_date, event_type, title, severity, source_type, source_url,
           evidence_json, status
    FROM research_events
    WHERE ticker = ? AND event_date BETWEEN date(?, ?) AND date(?)
    ORDER BY event_date DESC, id DESC
  `).all(ticker, asOf, `-${lookback} days`, asOf)).map((row) => ({
    ...row, evidence: parseJson(row.evidence_json, [])
  }));
  let total = 0;
  let weightedEvidence = 0;
  let evidenceWeight = 0;
  for (const event of rows) {
    const evidence = event.evidence[0] || {};
    const severityMagnitude = { P0: 100, P1: 75, P2: 45, P3: 20 }[event.severity] || 20;
    const daysAgo = Math.max(0, (Date.parse(asOf) - Date.parse(event.event_date)) / 86_400_000);
    const recency = Math.max(0.25, 1 - (daysAgo / (lookback + 1)));
    const sourceQuality = event.source_type === 'SEC_8K'
      ? 1 : (evidence.sourceTier === 'TIER_1' ? 0.9 : evidence.sourceTier === 'SOCIAL' ? 0.35 : 0.65);
    const relationQuality = evidence.relationType && evidence.relationType !== 'DIRECT' ? 0.65 : 1;
    let direction = 0;
    if (event.source_type === 'NEWS_RISK') direction = -1;
    if (event.source_type === 'NEWS_IMPACT') {
      direction = evidence.direction === 'POSITIVE' ? 1 : evidence.direction === 'NEGATIVE' ? -1 : 0;
    }
    if (event.source_type === 'SEC_8K' && ['P0', 'P1'].includes(event.severity)) direction = -1;
    const weight = recency * sourceQuality * relationQuality;
    total += direction * severityMagnitude * weight;
    weightedEvidence += sourceQuality * relationQuality;
    evidenceWeight += 1;
  }
  const officialCritical = rows.filter((event) => (
    event.source_type === 'SEC_8K' && ['P0', 'P1'].includes(event.severity)
  ));
  const unverifiedHighRisk = rows.filter((event) => (
    event.source_type === 'NEWS_RISK' && event.severity === 'P1'
  ));
  return {
    available: rows.length > 0, score: rows.length ? round(clamp(total), 2) : null,
    evidenceQuality: evidenceWeight ? round((weightedEvidence / evidenceWeight) * 100, 2) : null,
    officialCritical, unverifiedHighRisk,
    events: rows.slice(0, 12)
  };
}

function corporateActionAdjustment(externalDrivers, asOf) {
  const repurchases = externalDrivers.corporateActions?.shareRepurchases;
  if (!repurchases?.available) return null;
  const ageDays = (Date.parse(asOf) - Date.parse(repurchases.periodEnd)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > 370) return null;
  const change = repurchases.previousComparable?.changePct;
  return Number.isFinite(change) ? clamp(15 + change * 20, 0, 30) : 10;
}

function weightedImpact(components, horizonDays, corporateAdjustment) {
  const weights = COMPONENT_WEIGHTS[horizonDays];
  let total = 0;
  let availableWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (!Number.isFinite(components[key].score)) continue;
    total += components[key].score * weight;
    availableWeight += weight;
  }
  if (!availableWeight) return { score: 0, coverage: 0 };
  const normalized = total / availableWeight;
  return {
    score: round(clamp(normalized + (corporateAdjustment || 0)), 2),
    coverage: round(availableWeight * 100, 2)
  };
}

function continuousCapitalBehaviorContext(overview) {
  const latest = overview?.latest;
  const reliability = (overview?.reliability || []).find((item) => item.horizonDays === 20) || null;
  const evidenceAvailable = Boolean(latest)
    && latest.stage !== 'INSUFFICIENT'
    && latest.confidence >= 60;
  const formallyValidated = evidenceAvailable
    && latest.direction !== 'NEUTRAL'
    && reliability?.status === 'PUBLISHED'
    && reliability.reliabilityScore >= config.reliabilityGate;
  return {
    available: evidenceAvailable,
    score: evidenceAvailable ? latest.score : null,
    stage: latest?.stage || 'INSUFFICIENT',
    stageLabel: latest?.stageLabel || '数据不足',
    direction: latest?.direction || 'NEUTRAL',
    confidence: latest?.confidence ?? 0,
    dataLevel: latest?.dataLevel || 'NO_DATA',
    reliability,
    usedInImpact: formallyValidated,
    publicationStatus: formallyValidated ? 'PUBLISHED' : 'OBSERVE',
    explanation: latest?.explanation || '连续资金行为尚未生成。'
  };
}

function determineAction({
  score, prediction, position, eventContext, intradayFlow, capitalBehavior, confidenceScore
}) {
  const reliabilityScore = Number(prediction.reliabilityScore);
  const formalReady = prediction.available
    && prediction.publicationStatus === 'PUBLISHED'
    && reliabilityScore >= config.reliabilityGate
    && Number.isFinite(prediction.returnP50)
    && Number.isFinite(prediction.probabilityUp);
  const hasPosition = position.quantity > 0;
  if (eventContext.officialCritical.length) {
    return { action: hasPosition ? 'EXIT_RISK_REVIEW' : 'AVOID', publicationStatus: 'RISK_OVERRIDE', formalReady };
  }
  const confirmedTacticalOutflow = intradayFlow.available
    && intradayFlow.signal === 'STRONG_OUTFLOW'
    && intradayFlow.confidence >= 60
    && intradayFlow.anomalies.some((item) => item.code === 'ACTIVE_SELL_IMBALANCE' && item.severity === 'P1');
  if (confirmedTacticalOutflow) {
    return {
      action: hasPosition ? 'REDUCE_REVIEW' : 'AVOID',
      publicationStatus: 'OBSERVE',
      formalReady: false
    };
  }
  const validatedContinuousOutflow = capitalBehavior.usedInImpact
    && capitalBehavior.direction === 'BEARISH'
    && capitalBehavior.score <= -20;
  if (validatedContinuousOutflow) {
    return {
      action: hasPosition ? 'REDUCE_REVIEW' : 'AVOID',
      publicationStatus: 'OBSERVE',
      formalReady: false
    };
  }
  if (!formalReady) {
    if (eventContext.unverifiedHighRisk.length || score <= -35) {
      return { action: hasPosition ? 'EXIT_RISK_REVIEW' : 'AVOID', publicationStatus: 'OBSERVE', formalReady };
    }
    if (score <= -20) {
      return { action: hasPosition ? 'REDUCE_REVIEW' : 'AVOID', publicationStatus: 'OBSERVE', formalReady };
    }
    return {
      action: hasPosition ? 'HOLD_REVIEW' : 'WATCH', publicationStatus: 'OBSERVE', formalReady
    };
  }
  if (score >= 20 && prediction.returnP50 >= 0.03 && prediction.probabilityUp >= 0.55 && confidenceScore >= 60) {
    return { action: hasPosition ? 'ADD_CANDIDATE' : 'BUY_CANDIDATE', publicationStatus: 'PUBLISHED', formalReady };
  }
  if (score <= -20 || prediction.returnP50 <= -0.03 || prediction.probabilityUp <= 0.45) {
    return { action: hasPosition ? 'REDUCE_CANDIDATE' : 'AVOID', publicationStatus: 'PUBLISHED', formalReady };
  }
  return { action: hasPosition ? 'HOLD' : 'WATCH', publicationStatus: 'PUBLISHED', formalReady };
}

function adviceText(action, horizonLabel, stance, formalReady) {
  const label = ACTION_LABELS[action];
  const stanceLabel = { BULLISH: '偏多', BEARISH: '偏空', NEUTRAL: '中性' }[stance] || stance;
  if (action === 'EXIT_RISK_REVIEW') return `${horizonLabel}建议：${label}。先核实高风险事实和价格反应，再决定是否减仓或退出。`;
  if (action === 'REDUCE_REVIEW') return `${horizonLabel}建议：${label}。负面因子占优，但预测尚未通过发布闸门；暂停加仓，并结合风险预算评估降低暴露。`;
  if (action === 'AVOID') return `${horizonLabel}建议：${label}。当前风险或负面证据占优，不建议在触发条件改善前新建仓。`;
  if (!formalReady) return `${horizonLabel}建议：${label}。当前仅为${stanceLabel}研究倾向，预测尚未通过综合可靠度发布门槛。`;
  return `${horizonLabel}建议：${label}。该建议已通过预测可靠度闸门，仍需按触发条件执行并遵守风险预算。`;
}

export function buildInvestmentAdvice(db, tickerValue, asOf) {
  const ticker = normalizeTicker(tickerValue);
  const position = calculatePosition(db, ticker, asOf);
  const externalDrivers = getExternalDriversOverview(db, ticker, asOf);
  const valuation = getValuationOverview(db, ticker, { lookbackYears: 5, asOf });
  const valuationComponent = valuationScore(valuation);
  const earningsComponent = earningsScore(valuation);
  const fundamentalsComponent = fundamentalsScore(valuation);
  const capitalFlow = analyzeCapitalFlow(db, ticker, asOf);
  const capitalBehavior = continuousCapitalBehaviorContext(
    getCapitalBehaviorOverview(db, ticker, asOf)
  );
  const capitalFlowReady = capitalFlow.signal !== 'INSUFFICIENT' && capitalFlow.confidence >= 60;
  const rawCapitalFlowScore = capitalFlowReady ? capitalFlow.score : null;
  const blendedCapitalFlowScore = capitalFlowReady && capitalBehavior.usedInImpact
    ? round((capitalFlow.score * 0.55) + (capitalBehavior.score * 0.45), 2)
    : rawCapitalFlowScore;
  const capitalFlowComponent = {
    available: capitalFlowReady,
    score: blendedCapitalFlowScore,
    rawScore: rawCapitalFlowScore,
    continuousBehaviorApplied: capitalFlowReady && capitalBehavior.usedInImpact,
    signal: capitalFlow.signal,
    signalLabel: capitalFlow.signalLabel,
    confidence: capitalFlow.confidence,
    dataLevel: capitalFlow.dataLevel,
    explanation: capitalFlow.explanation,
    anomalies: capitalFlow.anomalies,
    metrics: capitalFlow.metrics
  };
  const intradayFlow = analyzeIntradayFlow(db, ticker, asOf);
  const intradayFlowReady = intradayFlow.asOf
    && intradayFlow.tradeDate === asOf
    && intradayFlow.dataLevel === 'FUTU_TICK_DIRECTION'
    && intradayFlow.confidence >= 55;
  const intradayFlowComponent = {
    available: intradayFlowReady,
    score: intradayFlowReady ? intradayFlow.score : null,
    signal: intradayFlow.signal,
    signalLabel: intradayFlow.signalLabel,
    confidence: intradayFlow.confidence,
    dataLevel: intradayFlow.dataLevel,
    asOf: intradayFlow.asOf,
    explanation: intradayFlow.explanation,
    anomalies: intradayFlow.anomalies,
    metrics: intradayFlow.metrics
  };
  const corporateAdjustment = corporateActionAdjustment(externalDrivers, asOf);
  const advice = ADVICE_HORIZONS.map((horizonDays) => {
    const prediction = latestPrediction(db, ticker, asOf, horizonDays);
    const components = {
      price: priceContext(db, ticker, asOf, horizonDays),
      capitalFlow: capitalFlowComponent,
      capitalBehavior,
      intradayFlow: intradayFlowComponent,
      events: eventContext(db, ticker, asOf, horizonDays),
      macro: macroScore(externalDrivers.macro, horizonDays),
      valuation: valuationComponent,
      earnings: earningsComponent,
      fundamentals: fundamentalsComponent
    };
    const impact = weightedImpact(components, horizonDays, corporateAdjustment);
    const eventQuality = components.events.evidenceQuality;
    const reliability = Number(prediction.reliabilityScore);
    const confidenceScore = round(clamp(
      impact.coverage * 0.6
      + (Number.isFinite(eventQuality) ? eventQuality : 50) * 0.15
      + (Number.isFinite(reliability) ? reliability : 0) * 0.25,
      0, 100
    ), 2);
    const stance = impact.score >= 20 ? 'BULLISH' : impact.score <= -20 ? 'BEARISH' : 'NEUTRAL';
    const decision = determineAction({
      score: impact.score, prediction, position,
      eventContext: components.events, intradayFlow: components.intradayFlow,
      capitalBehavior: components.capitalBehavior, confidenceScore
    });
    const currentPrice = components.price.currentPrice;
    const targetPrice = decision.formalReady && Number.isFinite(prediction.priceP50)
      ? prediction.priceP50 : null;
    const stopPrice = decision.formalReady && Number.isFinite(prediction.priceP10)
      && prediction.priceP10 < currentPrice ? prediction.priceP10 : null;
    return {
      ticker, asOf, horizonDays, horizonLabel: HORIZON_LABELS[horizonDays],
      action: decision.action, actionLabel: ACTION_LABELS[decision.action],
      stance, impactScore: impact.score, confidenceScore,
      factorCoverage: impact.coverage, publicationStatus: decision.publicationStatus,
      formalReady: decision.formalReady, reliabilityGate: config.reliabilityGate,
      currentPrice, targetPrice: round(targetPrice, 4),
      stopPrice: round(stopPrice, 4), prediction,
      advice: adviceText(decision.action, HORIZON_LABELS[horizonDays], stance, decision.formalReady),
      components,
      conditions: [
        decision.formalReady ? '预测保持PUBLISHED且综合可靠度不低于发布门槛' : '等待预测通过综合可靠度及样本量门槛',
        components.capitalBehavior.usedInImpact
          ? '连续资金行为已通过20日验证可靠度门槛'
          : '连续资金行为只作研究证据，等待20日验证可靠度达到85分',
        '事件原文与官方披露不存在相互冲突',
        '日线及高置信分钟资金行为没有出现与研究方向相反的确认信号'
      ],
      invalidation: [
        '出现新的SEC P0/P1官方风险事件',
        '富途完整逐笔显示高置信主动卖出显著占优',
        '已验证的连续资金阶段反转为持续或加速派发',
        'EPS一致预期或行业需求方向显著反转',
        '实际价格越过已验证模型的失效位或预测区间'
      ]
    };
  });
  const asOfPrice = advice[0]?.currentPrice ?? null;
  const asOfTotalPnl = asOfPrice == null
    ? null : (position.quantity * asOfPrice) - position.remainingCost + position.realizedPnl;
  const asOfTotalReturn = asOfTotalPnl == null || !position.totalBuyCash
    ? null : asOfTotalPnl / position.totalBuyCash;
  return {
    ticker, asOf, position: {
      quantity: position.quantity, averageCost: position.averageCost,
      currentPrice: asOfPrice, totalReturn: round(asOfTotalReturn, 6)
    },
    advice,
    policy: {
      formalGate: `候选买入、加仓和减仓必须有PUBLISHED预测且综合可靠度≥${config.reliabilityGate}分。`,
      riskOverride: 'SEC官方P0/P1可触发风险优先评估；高置信分钟主动卖出或已验证的连续派发最多触发减仓复核，不能单独触发清仓。',
      personalization: '尚未配置个人风险承受度、流动性需求及最大单股仓位，因此不输出仓位百分比。',
      llmBoundary: 'LLM只能解释结构化结果，不得改变分数、可靠度闸门、目标位或止损位。'
    }
  };
}

export function saveInvestmentAdvice(db, tickerValue, asOf) {
  const overview = buildInvestmentAdvice(db, tickerValue, asOf);
  const timestamp = nowIso();
  const statement = db.prepare(`
    INSERT INTO investment_advice_snapshots (
      ticker, as_of, horizon_days, action, stance, impact_score, confidence_score,
      publication_status, current_price, target_price, stop_price,
      rationale_json, model_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, as_of, horizon_days, model_version) DO UPDATE SET
      action = excluded.action, stance = excluded.stance,
      impact_score = excluded.impact_score, confidence_score = excluded.confidence_score,
      publication_status = excluded.publication_status, current_price = excluded.current_price,
      target_price = excluded.target_price, stop_price = excluded.stop_price,
      rationale_json = excluded.rationale_json, created_at = excluded.created_at
  `);
  for (const item of overview.advice) {
    statement.run(
      overview.ticker, asOf, item.horizonDays, item.action, item.stance,
      item.impactScore, item.confidenceScore, item.publicationStatus,
      item.currentPrice, item.targetPrice, item.stopPrice,
      JSON.stringify(item), ADVICE_MODEL_VERSION, timestamp
    );
  }
  return overview;
}

export function saveWatchlistAdvice(db, asOf) {
  const tickers = toPlainRows(db.prepare(`
    SELECT ticker FROM watchlist_items WHERE enabled = 1 ORDER BY ticker
  `).all());
  return tickers.map(({ ticker }) => {
    try {
      return { ticker, ok: true, overview: saveInvestmentAdvice(db, ticker, asOf) };
    } catch (error) {
      return { ticker, ok: false, error: error.message };
    }
  });
}
