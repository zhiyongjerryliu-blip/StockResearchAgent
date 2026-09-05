import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker, parseJson, round } from './domain.js';
import { analyzeCapitalFlow } from './capital-flow.js';
import { analyzeIntradayFlow } from './intraday-flow.js';
import { createNotification } from './notifications.js';

export const CAPITAL_BEHAVIOR_MODEL_VERSION = 'continuous-capital-behavior-v1-2026-09-05';
export const CAPITAL_BEHAVIOR_HORIZONS = Object.freeze([1, 3, 5, 10, 20]);

const STAGE_LABELS = Object.freeze({
  ACCELERATED_ACCUMULATION: '加速吸筹迹象',
  ACCUMULATION: '持续吸筹迹象',
  ABSORPTION: '下跌承接迹象',
  NEUTRAL: '方向暂不明确',
  DISTRIBUTION_INTO_STRENGTH: '上涨派发迹象',
  DISTRIBUTION: '持续派发迹象',
  ACCELERATED_DISTRIBUTION: '加速派发迹象',
  INSUFFICIENT: '数据不足'
});

const REQUIRED_EFFECTIVE_SAMPLES = Object.freeze({ 1: 30, 3: 24, 5: 20, 10: 14, 20: 10 });

function clamp(value, minimum = -100, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function canonicalDates(db, ticker, asOf) {
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

function futurePrices(db, ticker, asOf, limit) {
  return toPlainRows(db.prepare(`
    SELECT trade_date, high, low, close FROM (
      SELECT trade_date, high, low, close, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS source_number
      FROM prices_daily WHERE ticker = ? AND trade_date > ?
    ) WHERE source_number = 1 ORDER BY trade_date LIMIT ?
  `).all(ticker, asOf, limit));
}

function intradaySignals(intraday) {
  const metrics = intraday?.metrics || {};
  const usable = String(intraday?.dataLevel || '').startsWith('FUTU_TICK_DIRECTION')
    && Number.isFinite(metrics.activeTurnoverRatio);
  const hasVwap = Number.isFinite(metrics.priceVsVwap);
  const activeScore = usable ? clamp(metrics.activeTurnoverRatio * 100) : null;
  const vwapScore = hasVwap
    ? clamp(metrics.priceVsVwap * 2000) : null;
  return { usable, hasVwap, activeScore, vwapScore };
}

function compositeScore(daily, intraday) {
  const parts = [{ value: daily.score, weight: 0.65 }];
  if (Number.isFinite(intraday.activeScore)) parts.push({ value: intraday.activeScore, weight: 0.25 });
  if (Number.isFinite(intraday.vwapScore)) parts.push({ value: intraday.vwapScore, weight: 0.10 });
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  return totalWeight ? clamp(parts.reduce((sum, part) => sum + (part.value * part.weight), 0) / totalWeight) : 0;
}

function directionForStage(stage) {
  if (['ACCELERATED_ACCUMULATION', 'ACCUMULATION', 'ABSORPTION'].includes(stage)) return 'BULLISH';
  if (['DISTRIBUTION_INTO_STRENGTH', 'DISTRIBUTION', 'ACCELERATED_DISTRIBUTION'].includes(stage)) return 'BEARISH';
  return 'NEUTRAL';
}

function directionalStreak(scores, sign) {
  let count = 0;
  for (let index = scores.length - 1; index >= 0; index -= 1) {
    if ((sign > 0 && scores[index] >= 15) || (sign < 0 && scores[index] <= -15)) count += 1;
    else break;
  }
  return count;
}

function classifyStage(score, rollingScores, daily) {
  if (daily.signal === 'INSUFFICIENT') return 'INSUFFICIENT';
  const positiveDays = rollingScores.filter((value) => value >= 15).length;
  const negativeDays = rollingScores.filter((value) => value <= -15).length;
  const sign = score >= 15 ? 1 : score <= -15 ? -1 : 0;
  const streak = sign ? directionalStreak(rollingScores, sign) : 0;
  const relativeVolume = daily.metrics?.relativeVolume;
  const return5d = daily.metrics?.return5d;
  if (return5d >= 0.03 && score <= -15 && negativeDays >= 2) return 'DISTRIBUTION_INTO_STRENGTH';
  if (return5d <= -0.03 && score >= 15 && positiveDays >= 2) return 'ABSORPTION';
  if (score >= 40 && positiveDays >= 3 && streak >= 2 && relativeVolume >= 1.1) return 'ACCELERATED_ACCUMULATION';
  if (score <= -40 && negativeDays >= 3 && streak >= 2 && relativeVolume >= 1.1) return 'ACCELERATED_DISTRIBUTION';
  if (score >= 18 && positiveDays >= 3) return 'ACCUMULATION';
  if (score <= -18 && negativeDays >= 3) return 'DISTRIBUTION';
  return 'NEUTRAL';
}

function buildEvidence(daily, intraday, rollingScores, score) {
  const positiveDays = rollingScores.filter((value) => value >= 15).length;
  const negativeDays = rollingScores.filter((value) => value <= -15).length;
  return [
    { key: 'composite', label: '连续行为综合分', value: round(score, 2), available: true },
    { key: 'dailyFlow', label: '日线量价资金分', value: daily.score, available: daily.signal !== 'INSUFFICIENT' },
    { key: 'activeFlow', label: '富途主动成交差', value: round(intraday.activeScore, 2), available: intraday.usable },
    { key: 'priceVsVwap', label: '收盘价相对VWAP', value: round(intraday.vwapScore, 2), available: Number.isFinite(intraday.vwapScore) },
    { key: 'persistence', label: '近5日方向持续性', value: positiveDays - negativeDays, available: rollingScores.length >= 3 }
  ];
}

function buildExplanation(stage, score, confidence, rollingScores, intraday) {
  const positiveDays = rollingScores.filter((value) => value >= 15).length;
  const negativeDays = rollingScores.filter((value) => value <= -15).length;
  return `${STAGE_LABELS[stage]}：连续行为评分${score >= 0 ? '+' : ''}${score.toFixed(1)}，` +
    `近${rollingScores.length}个交易日中正向${positiveDays}日、负向${negativeDays}日，证据置信${confidence.toFixed(1)}分。` +
    `${intraday.usable
      ? '本次合并了富途主动成交方向与VWAP位置。'
      : intraday.hasVwap ? '本次合并了富途分钟VWAP位置，但历史逐笔方向不足。' : '当前主要依据日线量价，富途历史分钟证据不足。'}` +
    '这是公开成交数据的概率推断，不能确认机构或最终账户身份。';
}

export function analyzeCapitalBehavior(db, tickerValue, asOf) {
  const ticker = normalizeTicker(tickerValue);
  const daily = analyzeCapitalFlow(db, ticker, asOf);
  const hasIntraday = daily.priceDate ? Boolean(db.prepare(`
    SELECT 1 FROM intraday_tick_minutes WHERE ticker = ? AND trade_date = ? LIMIT 1
  `).get(ticker, daily.priceDate) || db.prepare(`
    SELECT 1 FROM prices_intraday
    WHERE ticker = ? AND trade_date = ? AND interval = '1M' LIMIT 1
  `).get(ticker, daily.priceDate)) : false;
  const intradayAnalysis = hasIntraday ? analyzeIntradayFlow(db, ticker, daily.priceDate) : null;
  const intraday = intradaySignals(intradayAnalysis);
  const score = round(compositeScore(daily, intraday), 2);
  const previous = toPlainRows(db.prepare(`
    SELECT as_of, score FROM capital_behavior_snapshots
    WHERE ticker = ? AND as_of < ? AND model_version = ?
    ORDER BY as_of DESC LIMIT 4
  `).all(ticker, asOf, CAPITAL_BEHAVIOR_MODEL_VERSION)).reverse();
  const rollingScores = [...previous.map((row) => row.score), score];
  const stage = classifyStage(score, rollingScores, daily);
  const direction = directionForStage(stage);
  const positiveDays = rollingScores.filter((value) => value >= 15).length;
  const negativeDays = rollingScores.filter((value) => value <= -15).length;
  const sign = score >= 15 ? 1 : score <= -15 ? -1 : 0;
  const streak = sign ? directionalStreak(rollingScores, sign) : 0;
  const persistence = rollingScores.length
    ? Math.max(positiveDays, negativeDays) / rollingScores.length : 0;
  const dailyConfidence = Number(daily.confidence) || 0;
  const intradayConfidence = intraday.usable ? Number(intradayAnalysis.confidence) || 0 : 0;
  const confidence = stage === 'INSUFFICIENT' ? Math.min(35, dailyConfidence) : Math.min(
    intraday.usable ? 82 : intraday.hasVwap ? 75 : 72,
    (dailyConfidence * 0.65) + (intradayConfidence * 0.15) +
      (Math.min(1, rollingScores.length / 5) * 10) + (persistence * 10)
  );
  const evidence = buildEvidence(daily, intraday, rollingScores, score);
  return {
    ticker, asOf, priceDate: daily.priceDate, close: daily.close,
    stage, stageLabel: STAGE_LABELS[stage], direction, score,
    confidence: round(confidence, 2), persistenceScore: round(persistence * 100, 2),
    positiveDays5: positiveDays, negativeDays5: negativeDays, directionalStreak: streak,
    dataLevel: intraday.usable
      ? 'DAILY_AND_FUTU_TICK' : intraday.hasVwap ? 'DAILY_AND_FUTU_MINUTE' : 'DAILY_PROXY',
    dailyFlowScore: daily.score,
    intradayFlowScore: round(intraday.activeScore, 2),
    activeTurnoverRatio: intradayAnalysis?.metrics?.activeTurnoverRatio ?? null,
    priceVsVwap: intradayAnalysis?.metrics?.priceVsVwap ?? null,
    evidence,
    explanation: buildExplanation(stage, score, round(confidence, 2), rollingScores, intraday),
    limitations: [
      '公开成交只能推断大额资金行为概率，不能确认机构、主力或最终账户身份',
      '未采集到富途逐笔的历史日期会降级为日线量价代理',
      '连续阶段必须通过后续1、3、5、10、20个交易日表现验证后才能提高权重'
    ],
    modelVersion: CAPITAL_BEHAVIOR_MODEL_VERSION
  };
}

export function saveCapitalBehavior(db, tickerValue, asOf) {
  const result = analyzeCapitalBehavior(db, tickerValue, asOf);
  db.prepare(`
    INSERT INTO capital_behavior_snapshots (
      ticker, as_of, price_date, stage, direction, score, confidence, close,
      daily_flow_score, intraday_flow_score, active_turnover_ratio, price_vs_vwap,
      persistence_score, positive_days_5, negative_days_5, directional_streak,
      data_level, evidence_json, limitations_json, model_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, as_of, model_version) DO UPDATE SET
      price_date = excluded.price_date, stage = excluded.stage, direction = excluded.direction,
      score = excluded.score, confidence = excluded.confidence, close = excluded.close,
      daily_flow_score = excluded.daily_flow_score, intraday_flow_score = excluded.intraday_flow_score,
      active_turnover_ratio = excluded.active_turnover_ratio, price_vs_vwap = excluded.price_vs_vwap,
      persistence_score = excluded.persistence_score, positive_days_5 = excluded.positive_days_5,
      negative_days_5 = excluded.negative_days_5, directional_streak = excluded.directional_streak,
      data_level = excluded.data_level, evidence_json = excluded.evidence_json,
      limitations_json = excluded.limitations_json, created_at = excluded.created_at
  `).run(
    result.ticker, result.asOf, result.priceDate, result.stage, result.direction,
    result.score, result.confidence, result.close, result.dailyFlowScore,
    result.intradayFlowScore, result.activeTurnoverRatio, result.priceVsVwap,
    result.persistenceScore, result.positiveDays5, result.negativeDays5,
    result.directionalStreak, result.dataLevel, JSON.stringify(result.evidence),
    JSON.stringify(result.limitations), result.modelVersion, nowIso()
  );
  return result;
}

function evaluateBehavior(db, snapshot, horizonDays) {
  if (snapshot.direction === 'NEUTRAL' || snapshot.stage === 'INSUFFICIENT') {
    return {
      status: 'EXCLUDED', exclusionReason: snapshot.stage === 'INSUFFICIENT' ? '资金行为数据不足' : '无方向阶段不参与方向命中统计',
      targetDate: null, actualDate: null, actualReturn: null, maximumFavorableExcursion: null,
      maximumAdverseExcursion: null, directionHit: null
    };
  }
  const rows = futurePrices(db, snapshot.ticker, snapshot.asOf, horizonDays);
  if (rows.length < horizonDays) return {
    status: 'PENDING', exclusionReason: null, targetDate: null, actualDate: null,
    actualReturn: null, maximumFavorableExcursion: null, maximumAdverseExcursion: null,
    directionHit: null
  };
  const target = rows.at(-1);
  const actualReturn = (target.close / snapshot.close) - 1;
  const highReturns = rows.map((row) => (row.high / snapshot.close) - 1).filter(Number.isFinite);
  const lowReturns = rows.map((row) => (row.low / snapshot.close) - 1).filter(Number.isFinite);
  const bullish = snapshot.direction === 'BULLISH';
  const favorable = bullish
    ? Math.max(0, ...highReturns) : Math.max(0, ...lowReturns.map((value) => -value));
  const adverse = bullish
    ? Math.min(0, ...lowReturns) : Math.min(0, ...highReturns.map((value) => -value));
  const directionHit = bullish ? actualReturn > 0.01 : actualReturn < -0.01;
  return {
    status: 'MATURED', exclusionReason: null, targetDate: target.trade_date,
    actualDate: target.trade_date, actualReturn: round(actualReturn, 8),
    maximumFavorableExcursion: round(favorable, 8), maximumAdverseExcursion: round(adverse, 8),
    directionHit
  };
}

function saveValidation(db, snapshot, horizonDays) {
  const evaluation = evaluateBehavior(db, snapshot, horizonDays);
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO capital_behavior_validation (
      ticker, signal_as_of, horizon_days, target_date, actual_date, stage, direction,
      start_price, actual_return, maximum_favorable_excursion, maximum_adverse_excursion,
      direction_hit, status, exclusion_reason, signal_confidence, model_version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, signal_as_of, horizon_days, model_version) DO UPDATE SET
      target_date = excluded.target_date, actual_date = excluded.actual_date,
      stage = excluded.stage, direction = excluded.direction, start_price = excluded.start_price,
      actual_return = excluded.actual_return,
      maximum_favorable_excursion = excluded.maximum_favorable_excursion,
      maximum_adverse_excursion = excluded.maximum_adverse_excursion,
      direction_hit = excluded.direction_hit, status = excluded.status,
      exclusion_reason = excluded.exclusion_reason, signal_confidence = excluded.signal_confidence,
      updated_at = excluded.updated_at
  `).run(
    snapshot.ticker, snapshot.asOf, horizonDays, evaluation.targetDate, evaluation.actualDate,
    snapshot.stage, snapshot.direction, snapshot.close, evaluation.actualReturn,
    evaluation.maximumFavorableExcursion, evaluation.maximumAdverseExcursion,
    evaluation.directionHit == null ? null : evaluation.directionHit ? 1 : 0,
    evaluation.status, evaluation.exclusionReason, snapshot.confidence,
    CAPITAL_BEHAVIOR_MODEL_VERSION, timestamp, timestamp
  );
  return evaluation;
}

function nonOverlapping(rows) {
  const selected = [];
  let previousTarget = null;
  for (const row of rows) {
    if (previousTarget && row.signal_as_of <= previousTarget) continue;
    selected.push(row);
    previousTarget = row.actual_date;
  }
  return selected;
}

function reliabilityForHorizon(db, ticker, horizonDays, asOf = null) {
  const storedRows = toPlainRows(db.prepare(`
    SELECT * FROM capital_behavior_validation
    WHERE ticker = ? AND horizon_days = ? AND model_version = ?
      AND (? IS NULL OR signal_as_of <= ?)
    ORDER BY signal_as_of
  `).all(ticker, horizonDays, CAPITAL_BEHAVIOR_MODEL_VERSION, asOf, asOf));
  const rows = storedRows.map((row) => (
    asOf && row.status === 'MATURED' && row.actual_date > asOf
      ? { ...row, status: 'PENDING', actual_date: null, actual_return: null,
          maximum_favorable_excursion: null, maximum_adverse_excursion: null,
          direction_hit: null }
      : row
  ));
  const matured = rows.filter((row) => row.status === 'MATURED');
  const effective = nonOverlapping(matured);
  const hits = effective.filter((row) => row.direction_hit === 1).length;
  const directionAccuracy = effective.length ? hits / effective.length : null;
  const excursionWins = effective.filter((row) => (
    Number(row.maximum_favorable_excursion || 0) > Math.abs(Number(row.maximum_adverse_excursion || 0))
  )).length;
  const excursionQuality = effective.length ? excursionWins / effective.length : null;
  const averageConfidence = mean(effective.map((row) => row.signal_confidence));
  const requiredSamples = REQUIRED_EFFECTIVE_SAMPLES[horizonDays];
  const sampleScore = Math.min(1, effective.length / requiredSamples);
  const reliabilityScore = round(
    ((directionAccuracy || 0) * 65) + ((excursionQuality || 0) * 10) +
      ((averageConfidence || 0) / 100 * 10) + (sampleScore * 15), 2
  );
  return {
    horizonDays,
    total: rows.length,
    matured: matured.length,
    pending: rows.filter((row) => row.status === 'PENDING').length,
    excluded: rows.filter((row) => row.status === 'EXCLUDED').length,
    effectiveSamples: effective.length,
    requiredSamples,
    hits,
    directionAccuracy: round(directionAccuracy, 6),
    averageForwardReturn: round(mean(effective.map((row) => (
      row.direction === 'BULLISH' ? row.actual_return : -row.actual_return
    ))), 8),
    averageMfe: round(mean(effective.map((row) => row.maximum_favorable_excursion)), 8),
    averageMae: round(mean(effective.map((row) => row.maximum_adverse_excursion)), 8),
    reliabilityScore,
    status: effective.length < requiredSamples
      ? 'INSUFFICIENT' : reliabilityScore >= 85 ? 'PUBLISHED' : 'OBSERVE'
  };
}

function snapshotFromRow(row) {
  const stageLabel = STAGE_LABELS[row.stage] || row.stage;
  return {
    ticker: row.ticker, asOf: row.as_of, priceDate: row.price_date,
    stage: row.stage, stageLabel,
    direction: row.direction, score: row.score, confidence: row.confidence,
    close: row.close, dailyFlowScore: row.daily_flow_score,
    intradayFlowScore: row.intraday_flow_score,
    activeTurnoverRatio: row.active_turnover_ratio, priceVsVwap: row.price_vs_vwap,
    persistenceScore: row.persistence_score, positiveDays5: row.positive_days_5,
    negativeDays5: row.negative_days_5, directionalStreak: row.directional_streak,
    dataLevel: row.data_level, evidence: parseJson(row.evidence_json, []),
    limitations: parseJson(row.limitations_json, []), modelVersion: row.model_version,
    createdAt: row.created_at,
    explanation: `${stageLabel}：连续行为评分${row.score >= 0 ? '+' : ''}${Number(row.score).toFixed(1)}，` +
      `近5日正向${row.positive_days_5}日、负向${row.negative_days_5}日，证据置信${Number(row.confidence).toFixed(1)}分。` +
      '这是公开成交数据的概率推断，不能确认机构或最终账户身份。'
  };
}

export function listCapitalBehaviorHistory(db, tickerValue, limit = 20, asOf = null) {
  const ticker = normalizeTicker(tickerValue);
  const boundedLimit = Math.min(260, Math.max(1, Number(limit) || 20));
  return toPlainRows(db.prepare(`
    SELECT * FROM capital_behavior_snapshots
    WHERE ticker = ? AND model_version = ? AND (? IS NULL OR as_of <= ?)
    ORDER BY as_of DESC LIMIT ?
  `).all(ticker, CAPITAL_BEHAVIOR_MODEL_VERSION, asOf, asOf, boundedLimit)).map(snapshotFromRow);
}

export function listCapitalBehaviorValidation(db, tickerValue, limit = 30, asOf = null) {
  const ticker = normalizeTicker(tickerValue);
  const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 30));
  return toPlainRows(db.prepare(`
    SELECT * FROM capital_behavior_validation
    WHERE ticker = ? AND model_version = ? AND status <> 'EXCLUDED'
      AND (? IS NULL OR signal_as_of <= ?)
    ORDER BY signal_as_of DESC, horizon_days LIMIT ?
  `).all(ticker, CAPITAL_BEHAVIOR_MODEL_VERSION, asOf, asOf, boundedLimit)).map((row) => {
    const notYetMatured = asOf && row.status === 'MATURED' && row.actual_date > asOf;
    return {
      ticker: row.ticker, signalAsOf: row.signal_as_of, horizonDays: row.horizon_days,
      targetDate: notYetMatured ? null : row.target_date,
      actualDate: notYetMatured ? null : row.actual_date,
      stage: row.stage, stageLabel: STAGE_LABELS[row.stage] || row.stage,
      direction: row.direction, startPrice: row.start_price,
      actualReturn: notYetMatured ? null : row.actual_return,
      maximumFavorableExcursion: notYetMatured ? null : row.maximum_favorable_excursion,
      maximumAdverseExcursion: notYetMatured ? null : row.maximum_adverse_excursion,
      directionHit: notYetMatured ? null : row.direction_hit == null ? null : Boolean(row.direction_hit),
      status: notYetMatured ? 'PENDING' : row.status,
      signalConfidence: row.signal_confidence, modelVersion: row.model_version
    };
  });
}

export function getCapitalBehaviorOverview(db, tickerValue, asOf = null) {
  const ticker = normalizeTicker(tickerValue);
  const latestDate = asOf || toPlain(db.prepare(`
    SELECT MAX(trade_date) AS value FROM prices_daily WHERE ticker = ?
  `).get(ticker))?.value;
  const history = listCapitalBehaviorHistory(db, ticker, 20, latestDate);
  const latest = history[0]?.asOf === latestDate
    ? history[0] : latestDate ? analyzeCapitalBehavior(db, ticker, latestDate) : null;
  return {
    ticker, asOf: latestDate || null, latest, history,
    validationDetails: listCapitalBehaviorValidation(db, ticker, 30, latestDate),
    reliability: CAPITAL_BEHAVIOR_HORIZONS.map((horizon) => reliabilityForHorizon(db, ticker, horizon, latestDate)),
    modelVersion: CAPITAL_BEHAVIOR_MODEL_VERSION,
    reliabilityGate: 85,
    methodology: {
      directionHit: '看多阶段后续收益大于+1%命中；看空阶段后续收益小于-1%命中。',
      overlap: '可靠度只统计前一信号验证期结束后出现的非重叠样本。',
      boundary: '未达到最低有效样本和85分综合可靠度时，资金阶段不得作为正式买卖依据。'
    }
  };
}

export async function notifyCapitalBehaviorTransition(db, overview, options = {}) {
  const notifier = options.notifier || createNotification;
  const [latest, previous, beforePrevious] = overview?.history || [];
  if (!latest || !previous || latest.direction === 'NEUTRAL') return [];
  const confirmedTransition = latest.stage === previous.stage
    && beforePrevious?.stage !== latest.stage;
  if (!confirmedTransition || latest.confidence < 60) return [];
  const reliability = (overview.reliability || []).find((item) => item.horizonDays === 20);
  const formallyValidated = reliability?.status === 'PUBLISHED'
    && reliability.reliabilityScore >= (overview.reliabilityGate || 85);
  const highRiskStage = latest.stage === 'ACCELERATED_DISTRIBUTION';
  const severity = formallyValidated && highRiskStage ? 'P1' : 'P2';
  const eventKey = `CAPITAL_BEHAVIOR:${latest.ticker}:${latest.priceDate}:${latest.stage}:${CAPITAL_BEHAVIOR_MODEL_VERSION}`;
  if (db.prepare('SELECT 1 FROM capital_behavior_alerts WHERE event_key = ?').get(eventKey)) return [];
  const reliabilityText = reliability
    ? `${reliability.reliabilityScore.toFixed(1)}分（${reliability.effectiveSamples}个有效样本）`
    : '尚无验证样本';
  const input = {
    ticker: latest.ticker,
    severity,
    category: 'CAPITAL_BEHAVIOR_TRANSITION',
    title: `${latest.ticker} 连续资金阶段确认：${latest.stageLabel}`,
    body: `${latest.priceDate} 连续两日处于“${latest.stageLabel}”，行为评分${latest.score >= 0 ? '+' : ''}${latest.score.toFixed(1)}，置信度${latest.confidence.toFixed(1)}分，20日验证可靠度${reliabilityText}。${formallyValidated ? '该信号已通过资金行为可靠度门槛，仍需结合价格、事件和风险预算。' : '该信号尚未通过85分门槛，仅作研究提醒。'}不能据此确认机构账户身份。`,
    evidence: [{
      eventKey, tradeDate: latest.priceDate, stage: latest.stage,
      direction: latest.direction, score: latest.score, confidence: latest.confidence,
      previousDate: previous.priceDate, dataLevel: latest.dataLevel,
      reliability: reliability || null, formallyValidated,
      confirmationRule: '同一连续阶段出现两个交易日，且前一阶段不同'
    }]
  };
  const notification = await notifier(db, input);
  db.prepare(`
    INSERT INTO capital_behavior_alerts (
      event_key, ticker, trade_date, stage, severity, notified_at, basis_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventKey, latest.ticker, latest.priceDate, latest.stage,
    severity, nowIso(), JSON.stringify(input.evidence[0])
  );
  return [notification];
}

export function runCapitalBehaviorBacktest(db, tickerValue, asOf, options = {}) {
  const ticker = normalizeTicker(tickerValue);
  const maximum = Math.min(1600, Math.max(60, Number(options.maxSessions) || 520));
  const backfillDates = canonicalDates(db, ticker, asOf).slice(-maximum);
  const lastStored = toPlain(db.prepare(`
    SELECT MAX(as_of) AS value FROM capital_behavior_snapshots
    WHERE ticker = ? AND model_version = ?
  `).get(ticker, CAPITAL_BEHAVIOR_MODEL_VERSION))?.value;
  const lastStoredIndex = lastStored ? backfillDates.indexOf(lastStored) : -1;
  const dates = options.full === true || lastStoredIndex < 0
    ? backfillDates : backfillDates.slice(Math.max(0, lastStoredIndex - 4));
  const snapshots = [];
  let validationRowsUpdated = 0;
  db.exec('BEGIN');
  try {
    for (const date of dates) snapshots.push(saveCapitalBehavior(db, ticker, date));
    const pendingSnapshots = lastStoredIndex < 0 ? [] : toPlainRows(db.prepare(`
      SELECT DISTINCT s.* FROM capital_behavior_snapshots s
      JOIN capital_behavior_validation v
        ON v.ticker = s.ticker AND v.signal_as_of = s.as_of AND v.model_version = s.model_version
      WHERE s.ticker = ? AND s.model_version = ? AND s.as_of <= ? AND v.status = 'PENDING'
    `).all(ticker, CAPITAL_BEHAVIOR_MODEL_VERSION, asOf)).map(snapshotFromRow);
    const validationSnapshots = [...new Map(
      [...snapshots, ...pendingSnapshots].map((snapshot) => [snapshot.asOf, snapshot])
    ).values()];
    for (const snapshot of validationSnapshots) {
      for (const horizon of CAPITAL_BEHAVIOR_HORIZONS) saveValidation(db, snapshot, horizon);
      validationRowsUpdated += CAPITAL_BEHAVIOR_HORIZONS.length;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    ticker, asOf, datesProcessed: dates.length, backfillSessions: backfillDates.length,
    validationRowsUpdated,
    ...getCapitalBehaviorOverview(db, ticker, asOf)
  };
}

export function runWatchlistCapitalBehaviorBacktests(db, asOf, options = {}) {
  const tickers = toPlainRows(db.prepare(`
    SELECT ticker FROM watchlist_items WHERE enabled = 1 ORDER BY ticker
  `).all());
  return tickers.map(({ ticker }) => {
    try {
      return { ticker, ok: true, result: runCapitalBehaviorBacktest(db, ticker, asOf, options) };
    } catch (error) {
      return { ticker, ok: false, error: error.message };
    }
  });
}
