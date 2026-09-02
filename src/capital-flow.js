import { nowIso, toPlainRows } from './db.js';
import { normalizeTicker, parseJson, round } from './domain.js';
import { createNotification } from './notifications.js';

export const CAPITAL_FLOW_MODEL_VERSION = 'daily-price-volume-flow-v1-2026-09-02';
export const VOLUME_ALERT_RATIO = 1.5;
export const VOLUME_ALERT_MOVE = 0.02;

const SIGNAL_LABELS = Object.freeze({
  STRONG_ACCUMULATION: '强建仓迹象',
  ACCUMULATION: '温和建仓迹象',
  NEUTRAL: '资金方向中性',
  DISTRIBUTION: '温和派发迹象',
  STRONG_DISTRIBUTION: '强清仓迹象',
  INSUFFICIENT: '数据不足'
});

const VOLUME_TREND_LABELS = Object.freeze({
  RISING: '近期成交量上升',
  FALLING: '近期成交量下降',
  STABLE: '近期成交量平稳',
  INSUFFICIENT: '成交量趋势数据不足'
});

function clamp(value, minimum = -100, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function sum(values) {
  return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function standardDeviation(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return null;
  const average = mean(valid);
  return Math.sqrt(valid.reduce((total, value) => total + ((value - average) ** 2), 0) / (valid.length - 1));
}

function latestDailyRows(db, ticker, asOf, limit = 90) {
  return toPlainRows(db.prepare(`
    SELECT trade_date, open, high, low, close, volume, provider
    FROM (
      SELECT trade_date, open, high, low, close, volume, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily
      WHERE ticker = ? AND trade_date <= ?
    )
    WHERE row_number = 1
    ORDER BY trade_date DESC
    LIMIT ?
  `).all(ticker, asOf, limit)).reverse();
}

function calculateMfi(rows, lookback = 14) {
  const sample = rows.slice(-(lookback + 1));
  if (sample.length < Math.min(10, lookback + 1)) return null;
  let positive = 0;
  let negative = 0;
  let observations = 0;
  for (let index = 1; index < sample.length; index += 1) {
    const current = sample[index];
    const previous = sample[index - 1];
    if (![current.high, current.low, current.close, current.volume,
      previous.high, previous.low, previous.close].every(Number.isFinite)) continue;
    const typical = (current.high + current.low + current.close) / 3;
    const previousTypical = (previous.high + previous.low + previous.close) / 3;
    const flow = typical * current.volume;
    if (typical > previousTypical) positive += flow;
    else if (typical < previousTypical) negative += flow;
    observations += 1;
  }
  if (observations < 8) return null;
  if (negative === 0) return positive > 0 ? 100 : 50;
  return 100 - (100 / (1 + (positive / negative)));
}

function calculateCmf(rows, lookback = 20) {
  const sample = rows.slice(-lookback);
  let moneyFlowVolume = 0;
  let totalVolume = 0;
  let observations = 0;
  for (const row of sample) {
    if (![row.high, row.low, row.close, row.volume].every(Number.isFinite)) continue;
    if (row.high <= row.low || row.volume <= 0) continue;
    const multiplier = ((2 * row.close) - row.high - row.low) / (row.high - row.low);
    moneyFlowVolume += multiplier * row.volume;
    totalVolume += row.volume;
    observations += 1;
  }
  return observations >= 10 && totalVolume > 0 ? clamp(moneyFlowVolume / totalVolume, -1, 1) : null;
}

function calculateFlowMetrics(rows) {
  const latest = rows.at(-1) || null;
  const previous = rows.at(-2) || null;
  const recent = rows.slice(-21);
  const signed = [];
  const notionals = [];
  const signedVolumes = [];
  const volumes = [];
  for (let index = 1; index < recent.length; index += 1) {
    const row = recent[index];
    const prior = recent[index - 1];
    if (![row.close, prior.close, row.volume].every(Number.isFinite) || row.volume <= 0) continue;
    const direction = row.close > prior.close ? 1 : row.close < prior.close ? -1 : 0;
    const notional = row.close * row.volume;
    signed.push(direction * notional);
    notionals.push(notional);
    signedVolumes.push(direction * row.volume);
    volumes.push(row.volume);
  }
  const priorVolumes = rows.slice(-21, -1).map((row) => row.volume).filter((value) => Number.isFinite(value) && value > 0);
  const averageVolume20d = mean(priorVolumes);
  const averageVolume5d = mean(rows.slice(-5).map((row) => row.volume));
  const averageVolume20dIncludingCurrent = mean(rows.slice(-20).map((row) => row.volume));
  const volumeTrendPct = averageVolume5d && averageVolume20dIncludingCurrent
    ? (averageVolume5d / averageVolume20dIncludingCurrent) - 1 : null;
  const volumeTrend = !Number.isFinite(volumeTrendPct)
    ? 'INSUFFICIENT' : volumeTrendPct >= 0.20 ? 'RISING' : volumeTrendPct <= -0.20 ? 'FALLING' : 'STABLE';
  const relativeVolume = Number.isFinite(latest?.volume) && latest.volume > 0 && averageVolume20d
    ? latest.volume / averageVolume20d : null;
  const volumeStd = standardDeviation(priorVolumes);
  const volumeZScore = Number.isFinite(latest?.volume) && Number.isFinite(volumeStd) && volumeStd > 0
    ? (latest.volume - averageVolume20d) / volumeStd : null;
  const directionalNotionalRatio = sum(notionals) > 0 ? sum(signed) / sum(notionals) : null;
  const upDownVolumeImbalance20d = sum(volumes) > 0 ? sum(signedVolumes) / sum(volumes) : null;
  const closeLocation = latest && [latest.high, latest.low, latest.close].every(Number.isFinite)
    && latest.high > latest.low
    ? (((2 * latest.close) - latest.high - latest.low) / (latest.high - latest.low)) : null;
  const dailyReturn = latest?.close && previous?.close ? (latest.close / previous.close) - 1 : null;
  const price5 = rows.at(-6)?.close;
  const price20 = rows.at(-21)?.close;
  const return5d = latest?.close && price5 ? (latest.close / price5) - 1 : null;
  const return20d = latest?.close && price20 ? (latest.close / price20) - 1 : null;
  const obvSlope20d = sum(volumes) > 0 ? sum(signedVolumes) / sum(volumes) : null;
  return {
    latest, previous, averageVolume5d, averageVolume20d,
    averageVolume20dIncludingCurrent, volumeTrend, volumeTrendPct,
    relativeVolume, volumeZScore,
    directionalNotionalRatio, upDownVolumeImbalance20d, closeLocation,
    dailyReturn, return5d, return20d, obvSlope20d,
    cmf20: calculateCmf(rows), mfi14: calculateMfi(rows)
  };
}

function scoreComponents(metrics) {
  return [
    { key: 'directionalNotional', label: '20日方向性成交额代理', value: metrics.directionalNotionalRatio, score: Number.isFinite(metrics.directionalNotionalRatio) ? metrics.directionalNotionalRatio * 100 : null, weight: 0.30 },
    { key: 'cmf20', label: '20日收盘位置资金流（CMF）', value: metrics.cmf20, score: Number.isFinite(metrics.cmf20) ? metrics.cmf20 * 100 : null, weight: 0.25 },
    { key: 'mfi14', label: '14日资金流量指标（MFI）', value: metrics.mfi14, score: Number.isFinite(metrics.mfi14) ? (metrics.mfi14 - 50) * 2 : null, weight: 0.15 },
    { key: 'upDownVolume', label: '20日涨跌成交量差', value: metrics.upDownVolumeImbalance20d, score: Number.isFinite(metrics.upDownVolumeImbalance20d) ? metrics.upDownVolumeImbalance20d * 100 : null, weight: 0.15 },
    { key: 'closeLocation', label: '当日收盘位置', value: metrics.closeLocation, score: Number.isFinite(metrics.closeLocation) ? metrics.closeLocation * 100 : null, weight: 0.10 },
    { key: 'obvSlope', label: '20日OBV方向代理', value: metrics.obvSlope20d, score: Number.isFinite(metrics.obvSlope20d) ? metrics.obvSlope20d * 100 : null, weight: 0.05 }
  ].map((component) => ({
    ...component,
    value: round(component.value, 6),
    score: Number.isFinite(component.score) ? round(clamp(component.score), 2) : null
  }));
}

function signalFromScore(score, available) {
  if (!available) return 'INSUFFICIENT';
  if (score >= 50) return 'STRONG_ACCUMULATION';
  if (score >= 20) return 'ACCUMULATION';
  if (score <= -50) return 'STRONG_DISTRIBUTION';
  if (score <= -20) return 'DISTRIBUTION';
  return 'NEUTRAL';
}

function evidenceFrom(metrics, components) {
  const evidence = components.filter((item) => Number.isFinite(item.score))
    .sort((left, right) => Math.abs(right.score * right.weight) - Math.abs(left.score * left.weight))
    .slice(0, 4)
    .map((item) => ({
      key: item.key,
      direction: item.score > 8 ? 'INFLOW' : item.score < -8 ? 'OUTFLOW' : 'NEUTRAL',
      label: item.label,
      value: item.value,
      contribution: round(item.score * item.weight, 2)
    }));
  if (Number.isFinite(metrics.relativeVolume)) {
    evidence.push({
      key: 'relativeVolume', direction: 'CONTEXT', label: '相对20日均量',
      value: round(metrics.relativeVolume, 3), contribution: 0
    });
  }
  return evidence;
}

function anomalySignals(metrics) {
  const signals = [];
  if (metrics.relativeVolume >= VOLUME_ALERT_RATIO && metrics.dailyReturn >= VOLUME_ALERT_MOVE) {
    signals.push({ code: 'HIGH_VOLUME_RISE', severity: 'P2', direction: 'INFLOW', label: '放量上涨' });
  }
  if (metrics.relativeVolume >= VOLUME_ALERT_RATIO && metrics.dailyReturn <= -VOLUME_ALERT_MOVE) {
    signals.push({ code: 'HIGH_VOLUME_FALL', severity: 'P1', direction: 'OUTFLOW', label: '放量下跌' });
  }
  if (metrics.return5d >= 0.03 && metrics.cmf20 <= -0.05) {
    signals.push({ code: 'PRICE_FLOW_BEARISH_DIVERGENCE', severity: 'P2', direction: 'OUTFLOW', label: '价涨资金弱背离' });
  }
  if (metrics.return5d <= -0.03 && metrics.cmf20 >= 0.05) {
    signals.push({ code: 'PRICE_FLOW_BULLISH_DIVERGENCE', severity: 'P2', direction: 'INFLOW', label: '价跌资金强背离' });
  }
  if (metrics.relativeVolume >= 1.5 && metrics.closeLocation >= 0.65) {
    signals.push({ code: 'HIGH_VOLUME_CLOSE_NEAR_HIGH', severity: 'P2', direction: 'INFLOW', label: '放量且收近高位' });
  }
  if (metrics.relativeVolume >= 1.5 && metrics.closeLocation <= -0.65) {
    signals.push({ code: 'HIGH_VOLUME_CLOSE_NEAR_LOW', severity: 'P1', direction: 'OUTFLOW', label: '放量且收近低位' });
  }
  return signals;
}

function explanation(signal, score, metrics, evidence) {
  if (signal === 'INSUFFICIENT') return '有效成交量历史不足，暂不判断机构或大资金行为。';
  const leading = evidence.filter((item) => item.direction !== 'CONTEXT').slice(0, 2)
    .map((item) => item.label).join('、');
  const volume = Number.isFinite(metrics.relativeVolume)
    ? `当日成交量为20日均量的${metrics.relativeVolume.toFixed(2)}倍` : '当日相对成交量未知';
  return `${SIGNAL_LABELS[signal]}，资金行为评分${score >= 0 ? '+' : ''}${score.toFixed(1)}。` +
    `${leading ? `主要依据：${leading}；` : ''}${volume}。` +
    '该结论来自公开日线量价代理，不能确认交易账户身份。';
}

export function analyzeCapitalFlow(db, tickerValue, asOf) {
  const ticker = normalizeTicker(tickerValue);
  const rows = latestDailyRows(db, ticker, asOf);
  const metrics = calculateFlowMetrics(rows);
  const volumeRows = rows.filter((row) => Number.isFinite(row.volume) && row.volume > 0).length;
  const available = rows.length >= 10 && volumeRows >= 8 && Boolean(metrics.latest);
  const components = scoreComponents(metrics);
  const usable = components.filter((item) => Number.isFinite(item.score));
  const usableWeight = sum(usable.map((item) => item.weight));
  const score = available && usableWeight
    ? clamp(usable.reduce((total, item) => total + (item.score * item.weight), 0) / usableWeight)
    : 0;
  const directions = usable.map((item) => Math.sign(item.score)).filter(Boolean);
  const majority = Math.sign(score);
  const agreement = directions.length
    ? directions.filter((direction) => direction === majority).length / directions.length : 0;
  const coverage = components.reduce((total, item) => total + (Number.isFinite(item.score) ? item.weight : 0), 0);
  const confidence = available
    ? Math.min(72, 25 + (coverage * 30) + (Math.min(rows.length, 60) / 60 * 10) + (agreement * 10))
    : Math.min(35, (rows.length / 10) * 20 + (volumeRows / 8) * 15);
  const signal = signalFromScore(score, available);
  const evidence = evidenceFrom(metrics, components);
  const anomalies = anomalySignals(metrics);
  return {
    ticker,
    asOf,
    priceDate: metrics.latest?.trade_date || null,
    close: metrics.latest?.close ?? null,
    signal,
    signalLabel: SIGNAL_LABELS[signal],
    score: round(score, 2),
    confidence: round(confidence, 2),
    dataLevel: 'DAILY_PROXY',
    sampleSize: rows.length,
    volumeSampleSize: volumeRows,
    metrics: {
      volume: round(metrics.latest?.volume, 0),
      dailyReturn: round(metrics.dailyReturn, 6),
      return5d: round(metrics.return5d, 6),
      return20d: round(metrics.return20d, 6),
      averageVolume5d: round(metrics.averageVolume5d, 0),
      averageVolume20d: round(metrics.averageVolume20dIncludingCurrent, 0),
      baselineVolume20d: round(metrics.averageVolume20d, 0),
      volumeTrend: metrics.volumeTrend,
      volumeTrendLabel: VOLUME_TREND_LABELS[metrics.volumeTrend],
      volumeTrendPct: round(metrics.volumeTrendPct, 6),
      relativeVolume: round(metrics.relativeVolume, 3),
      volumeZScore: round(metrics.volumeZScore, 3),
      directionalNotionalRatio20d: round(metrics.directionalNotionalRatio, 6),
      upDownVolumeImbalance20d: round(metrics.upDownVolumeImbalance20d, 6),
      cmf20: round(metrics.cmf20, 6),
      mfi14: round(metrics.mfi14, 3),
      obvSlope20d: round(metrics.obvSlope20d, 6),
      closeLocation: round(metrics.closeLocation, 6)
    },
    components,
    evidence,
    anomalies,
    explanation: explanation(signal, round(score, 2), metrics, evidence),
    limitations: [
      '当前使用日线OHLCV推断资金行为，不是逐笔成交方向统计',
      '公开成交不包含最终交易账户身份，不能确认机构或所谓主力',
      '方向性成交额是量价代理比例，不代表真实净申购或净流入金额',
      '后续接入全市场逐笔成交、报价、FINRA场外数据和13F后应重新校准'
    ],
    modelVersion: CAPITAL_FLOW_MODEL_VERSION
  };
}

export function saveCapitalFlow(db, tickerValue, asOf) {
  const analysis = analyzeCapitalFlow(db, tickerValue, asOf);
  db.prepare(`
    INSERT INTO capital_flow_snapshots (
      ticker, as_of, price_date, signal, score, confidence, data_level,
      close, volume, daily_return, average_volume_5d, average_volume_20d,
      volume_trend, volume_trend_pct, relative_volume, directional_notional_ratio,
      cmf_20, mfi_14, up_down_volume_imbalance_20, obv_slope_20,
      close_location, evidence_json, anomalies_json, limitations_json,
      model_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, as_of, model_version) DO UPDATE SET
      price_date = excluded.price_date, signal = excluded.signal, score = excluded.score,
      confidence = excluded.confidence, data_level = excluded.data_level,
      close = excluded.close, volume = excluded.volume, daily_return = excluded.daily_return,
      average_volume_5d = excluded.average_volume_5d,
      average_volume_20d = excluded.average_volume_20d,
      volume_trend = excluded.volume_trend, volume_trend_pct = excluded.volume_trend_pct,
      relative_volume = excluded.relative_volume,
      directional_notional_ratio = excluded.directional_notional_ratio,
      cmf_20 = excluded.cmf_20, mfi_14 = excluded.mfi_14,
      up_down_volume_imbalance_20 = excluded.up_down_volume_imbalance_20,
      obv_slope_20 = excluded.obv_slope_20, close_location = excluded.close_location,
      evidence_json = excluded.evidence_json, anomalies_json = excluded.anomalies_json,
      limitations_json = excluded.limitations_json, created_at = excluded.created_at
  `).run(
    analysis.ticker, analysis.asOf, analysis.priceDate, analysis.signal,
    analysis.score, analysis.confidence, analysis.dataLevel, analysis.close,
    analysis.metrics.volume, analysis.metrics.dailyReturn,
    analysis.metrics.averageVolume5d, analysis.metrics.averageVolume20d,
    analysis.metrics.volumeTrend, analysis.metrics.volumeTrendPct,
    analysis.metrics.relativeVolume,
    analysis.metrics.directionalNotionalRatio20d, analysis.metrics.cmf20,
    analysis.metrics.mfi14, analysis.metrics.upDownVolumeImbalance20d,
    analysis.metrics.obvSlope20d, analysis.metrics.closeLocation,
    JSON.stringify(analysis.evidence), JSON.stringify(analysis.anomalies),
    JSON.stringify(analysis.limitations), analysis.modelVersion, nowIso()
  );
  return analysis;
}

export function saveWatchlistCapitalFlow(db, asOf) {
  return toPlainRows(db.prepare(`
    SELECT ticker FROM watchlist_items WHERE enabled = 1 ORDER BY ticker
  `).all()).map(({ ticker }) => {
    try {
      return { ticker, ok: true, analysis: saveCapitalFlow(db, ticker, asOf) };
    } catch (error) {
      return { ticker, ok: false, error: error.message };
    }
  });
}

export function listCapitalFlowHistory(db, tickerValue, limit = 60) {
  const ticker = normalizeTicker(tickerValue);
  const boundedLimit = Math.min(260, Math.max(1, Number.parseInt(limit, 10) || 60));
  return toPlainRows(db.prepare(`
    SELECT * FROM capital_flow_snapshots
    WHERE ticker = ? ORDER BY as_of DESC, created_at DESC LIMIT ?
  `).all(ticker, boundedLimit)).map((row) => ({
    ticker: row.ticker, asOf: row.as_of, priceDate: row.price_date,
    signal: row.signal, signalLabel: SIGNAL_LABELS[row.signal] || row.signal,
    score: row.score, confidence: row.confidence, dataLevel: row.data_level,
    close: row.close, volume: row.volume, dailyReturn: row.daily_return,
    averageVolume5d: row.average_volume_5d, averageVolume20d: row.average_volume_20d,
    volumeTrend: row.volume_trend,
    volumeTrendLabel: VOLUME_TREND_LABELS[row.volume_trend] || row.volume_trend,
    volumeTrendPct: row.volume_trend_pct, relativeVolume: row.relative_volume,
    directionalNotionalRatio20d: row.directional_notional_ratio,
    cmf20: row.cmf_20, mfi14: row.mfi_14,
    upDownVolumeImbalance20d: row.up_down_volume_imbalance_20,
    obvSlope20d: row.obv_slope_20, closeLocation: row.close_location,
    evidence: parseJson(row.evidence_json, []), anomalies: parseJson(row.anomalies_json, []),
    limitations: parseJson(row.limitations_json, []), modelVersion: row.model_version,
    createdAt: row.created_at
  }));
}

export async function notifyVolumeAnomalies(db, analysis, options = {}) {
  const notifier = options.notifier || createNotification;
  if (!analysis?.priceDate || analysis.signal === 'INSUFFICIENT') return [];
  const eligible = (analysis.anomalies || []).filter((item) => (
    ['HIGH_VOLUME_RISE', 'HIGH_VOLUME_FALL'].includes(item.code)
  ));
  const notifications = [];
  for (const anomaly of eligible) {
    const eventKey = `VOLUME:${analysis.ticker}:${analysis.priceDate}:${anomaly.code}:${CAPITAL_FLOW_MODEL_VERSION}`;
    if (db.prepare('SELECT 1 FROM volume_alerts WHERE event_key = ?').get(eventKey)) continue;
    const direction = anomaly.code === 'HIGH_VOLUME_RISE' ? '上涨' : '下跌';
    const severity = anomaly.code === 'HIGH_VOLUME_RISE' ? 'P2' : 'P1';
    const dailyReturn = analysis.metrics.dailyReturn * 100;
    const volume = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 })
      .format(analysis.metrics.volume);
    const input = {
      ticker: analysis.ticker,
      severity,
      category: 'VOLUME_ANOMALY',
      title: `${analysis.ticker} 明显放量${direction}`,
      body: `${analysis.priceDate} 成交量${volume}，为前20日均量的${analysis.metrics.relativeVolume.toFixed(2)}倍，股价${dailyReturn >= 0 ? '+' : ''}${dailyReturn.toFixed(2)}%。请结合公告、新闻和资金行为持续复核，不构成自动买卖指令。`,
      evidence: [{
        eventKey, priceDate: analysis.priceDate, close: analysis.close,
        volume: analysis.metrics.volume,
        averageVolume20d: analysis.metrics.averageVolume20d,
        baselineVolume20d: analysis.metrics.baselineVolume20d,
        relativeVolume: analysis.metrics.relativeVolume,
        dailyReturn: analysis.metrics.dailyReturn,
        threshold: { relativeVolume: VOLUME_ALERT_RATIO, absoluteMove: VOLUME_ALERT_MOVE }
      }]
    };
    const notification = await notifier(db, input);
    db.prepare(`
      INSERT INTO volume_alerts (
        event_key, ticker, trade_date, alert_type, severity, notified_at, basis_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventKey, analysis.ticker, analysis.priceDate, anomaly.code, severity,
      nowIso(), JSON.stringify(input.evidence[0])
    );
    notifications.push(notification);
  }
  return notifications;
}
