import { nowIso, toPlainRows } from './db.js';
import { normalizeTicker, round } from './domain.js';

export const INTRADAY_FLOW_MODEL_VERSION = 'futu-tick-direction-v1-2026-09-02';

const SIGNAL_LABELS = Object.freeze({
  STRONG_INFLOW: '主动买入显著占优',
  INFLOW: '主动买入偏强',
  NEUTRAL: '主动资金方向中性',
  OUTFLOW: '主动卖出偏强',
  STRONG_OUTFLOW: '主动卖出显著占优',
  INSUFFICIENT: '逐笔方向数据不足'
});

function clamp(value, minimum = -100, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function sum(values) {
  return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const remainder = position - lower;
  return sorted[lower + 1] == null
    ? sorted[lower]
    : sorted[lower] + (remainder * (sorted[lower + 1] - sorted[lower]));
}

function signalFromScore(score, available) {
  if (!available) return 'INSUFFICIENT';
  if (score >= 35) return 'STRONG_INFLOW';
  if (score >= 12) return 'INFLOW';
  if (score <= -35) return 'STRONG_OUTFLOW';
  if (score <= -12) return 'OUTFLOW';
  return 'NEUTRAL';
}

function normalizeDirection(value) {
  const direction = String(value || '').toUpperCase();
  if (direction === 'BUY') return 'BUY';
  if (direction === 'SELL') return 'SELL';
  return 'NEUTRAL';
}

export function ingestFutuBars(db, bars = []) {
  const securityExists = db.prepare('SELECT 1 FROM securities WHERE ticker = ?');
  const statement = db.prepare(`
    INSERT INTO prices_intraday (
      ticker, bar_time_et, trade_date, interval, session, open, high, low, close,
      volume, turnover, provider, is_final, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'futu', ?, ?)
    ON CONFLICT(ticker, bar_time_et, interval, session, provider) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, volume = excluded.volume, turnover = excluded.turnover,
      is_final = MAX(prices_intraday.is_final, excluded.is_final),
      ingested_at = excluded.ingested_at
  `);
  let count = 0;
  for (const bar of bars) {
    const ticker = normalizeTicker(bar.ticker);
    if (!securityExists.get(ticker) || !bar.barTimeEt || !Number.isFinite(Number(bar.close))) continue;
    statement.run(
      ticker, bar.barTimeEt, bar.tradeDate || String(bar.barTimeEt).slice(0, 10),
      bar.interval || '1M', bar.session || 'RTH',
      bar.open ?? null, bar.high ?? null, bar.low ?? null, Number(bar.close),
      bar.volume ?? null, bar.turnover ?? null, bar.isFinal ? 1 : 0, nowIso()
    );
    count += 1;
  }
  return count;
}

export function ingestFutuTicks(db, ticks = []) {
  const securityExists = db.prepare('SELECT 1 FROM securities WHERE ticker = ?');
  const statement = db.prepare(`
    INSERT OR IGNORE INTO ticks_intraday (
      ticker, sequence, trade_time_et, trade_date, price, volume, turnover,
      direction, trade_type, session, provider, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'futu', ?)
  `);
  const minuteStatement = db.prepare(`
    INSERT INTO intraday_tick_minutes (
      ticker, minute_et, trade_date, session,
      buy_turnover, sell_turnover, neutral_turnover,
      buy_count, sell_count, neutral_count, volume, last_price, provider, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'futu', ?)
    ON CONFLICT(ticker, minute_et, provider) DO UPDATE SET
      buy_turnover = intraday_tick_minutes.buy_turnover + excluded.buy_turnover,
      sell_turnover = intraday_tick_minutes.sell_turnover + excluded.sell_turnover,
      neutral_turnover = intraday_tick_minutes.neutral_turnover + excluded.neutral_turnover,
      buy_count = intraday_tick_minutes.buy_count + excluded.buy_count,
      sell_count = intraday_tick_minutes.sell_count + excluded.sell_count,
      neutral_count = intraday_tick_minutes.neutral_count + excluded.neutral_count,
      volume = intraday_tick_minutes.volume + excluded.volume,
      last_price = excluded.last_price,
      updated_at = excluded.updated_at
  `);
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const tick of ticks) {
      const ticker = normalizeTicker(tick.ticker);
      if (
        !securityExists.get(ticker) || !tick.sequence || !tick.tradeTimeEt ||
        !Number.isFinite(Number(tick.price)) || !Number.isFinite(Number(tick.volume))
      ) continue;
      const price = Number(tick.price);
      const volume = Number(tick.volume);
      const turnover = Number.isFinite(Number(tick.turnover)) ? Number(tick.turnover) : price * volume;
      const direction = normalizeDirection(tick.direction);
      const tradeDate = tick.tradeDate || String(tick.tradeTimeEt).slice(0, 10);
      const ingestedAt = nowIso();
      const result = statement.run(
        ticker, String(tick.sequence), tick.tradeTimeEt, tradeDate,
        price, volume, turnover, direction, tick.tradeType || null,
        tick.session || 'RTH', ingestedAt
      );
      if (Number(result.changes || 0) > 0) {
        minuteStatement.run(
          ticker, String(tick.tradeTimeEt).slice(0, 16), tradeDate, tick.session || 'RTH',
          direction === 'BUY' ? turnover : 0,
          direction === 'SELL' ? turnover : 0,
          direction === 'NEUTRAL' ? turnover : 0,
          direction === 'BUY' ? 1 : 0,
          direction === 'SELL' ? 1 : 0,
          direction === 'NEUTRAL' ? 1 : 0,
          volume, price, ingestedAt
        );
        count += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return count;
}

export function rebuildMissingIntradayMinutes(db) {
  if (Number(db.prepare('SELECT COUNT(*) AS count FROM intraday_tick_minutes').get()?.count || 0) > 0) {
    return 0;
  }
  const missing = toPlainRows(db.prepare(`
    SELECT
      ticker, substr(trade_time_et, 1, 16) AS minute_et, trade_date, session,
      SUM(CASE WHEN direction = 'BUY' THEN turnover ELSE 0 END) AS buy_turnover,
      SUM(CASE WHEN direction = 'SELL' THEN turnover ELSE 0 END) AS sell_turnover,
      SUM(CASE WHEN direction NOT IN ('BUY','SELL') THEN turnover ELSE 0 END) AS neutral_turnover,
      SUM(CASE WHEN direction = 'BUY' THEN 1 ELSE 0 END) AS buy_count,
      SUM(CASE WHEN direction = 'SELL' THEN 1 ELSE 0 END) AS sell_count,
      SUM(CASE WHEN direction NOT IN ('BUY','SELL') THEN 1 ELSE 0 END) AS neutral_count,
      SUM(volume) AS volume, MAX(trade_time_et) AS latest_tick_time
    FROM ticks_intraday AS tick
    WHERE NOT EXISTS (
      SELECT 1 FROM intraday_tick_minutes AS minute
      WHERE minute.ticker = tick.ticker
        AND minute.minute_et = substr(tick.trade_time_et, 1, 16)
        AND minute.provider = tick.provider
    )
    GROUP BY ticker, substr(trade_time_et, 1, 16), trade_date, session
  `).all());
  const latestPrice = db.prepare(`
    SELECT price FROM ticks_intraday
    WHERE ticker = ? AND trade_time_et = ? ORDER BY sequence DESC LIMIT 1
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO intraday_tick_minutes (
      ticker, minute_et, trade_date, session,
      buy_turnover, sell_turnover, neutral_turnover,
      buy_count, sell_count, neutral_count, volume, last_price, provider, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'futu', ?)
  `);
  db.exec('BEGIN');
  try {
    for (const row of missing) {
      insert.run(
        row.ticker, row.minute_et, row.trade_date, row.session,
        row.buy_turnover, row.sell_turnover, row.neutral_turnover,
        row.buy_count, row.sell_count, row.neutral_count, row.volume,
        latestPrice.get(row.ticker, row.latest_tick_time)?.price ?? null, nowIso()
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return missing.length;
}

export function pruneIntradayTicks(db, retentionDays = 7) {
  const boundedDays = Math.min(30, Math.max(1, Number.parseInt(retentionDays, 10) || 7));
  return Number(db.prepare(`
    DELETE FROM ticks_intraday WHERE trade_date < date('now', ?)
  `).run(`-${boundedDays} days`).changes || 0);
}

function latestTradeDate(db, ticker) {
  return db.prepare(`
    SELECT MAX(trade_date) AS trade_date FROM (
      SELECT trade_date FROM ticks_intraday WHERE ticker = ?
      UNION ALL
      SELECT trade_date FROM prices_intraday
      WHERE ticker = ? AND COALESCE(volume, 0) > 0
    )
  `).get(ticker, ticker)?.trade_date || null;
}

export function analyzeIntradayFlow(db, tickerValue, tradeDate = null) {
  const ticker = normalizeTicker(tickerValue);
  const effectiveDate = tradeDate || latestTradeDate(db, ticker);
  if (!effectiveDate) {
    return {
      ticker, tradeDate: null, asOf: null, signal: 'INSUFFICIENT',
      signalLabel: SIGNAL_LABELS.INSUFFICIENT, score: 0, confidence: 0,
      dataLevel: 'NO_INTRADAY_DATA', metrics: {}, anomalies: [],
      explanation: '尚未收到富途分钟线或逐笔成交数据。',
      limitations: ['需要启动并登录 Futu OpenD 后持续采集行情'],
      modelVersion: INTRADAY_FLOW_MODEL_VERSION
    };
  }
  const tickMinutes = toPlainRows(db.prepare(`
    SELECT * FROM intraday_tick_minutes
    WHERE ticker = ? AND trade_date = ? ORDER BY minute_et
  `).all(ticker, effectiveDate));
  const latestTick = db.prepare(`
    SELECT trade_time_et, price FROM ticks_intraday
    WHERE ticker = ? AND trade_date = ? ORDER BY trade_time_et DESC, sequence DESC LIMIT 1
  `).get(ticker, effectiveDate);
  const activeTickSample = toPlainRows(db.prepare(`
    SELECT turnover, direction FROM ticks_intraday
    WHERE ticker = ? AND trade_date = ? AND direction IN ('BUY','SELL')
    ORDER BY trade_time_et DESC, sequence DESC LIMIT 5000
  `).all(ticker, effectiveDate));
  const bars = toPlainRows(db.prepare(`
    SELECT bar_time_et, open, high, low, close, volume, turnover, is_final
    FROM prices_intraday
    WHERE ticker = ? AND trade_date = ? AND interval = '1M'
    ORDER BY bar_time_et
  `).all(ticker, effectiveDate));

  const buyTurnover = sum(tickMinutes.map((minute) => minute.buy_turnover));
  const sellTurnover = sum(tickMinutes.map((minute) => minute.sell_turnover));
  const neutralTurnover = sum(tickMinutes.map((minute) => minute.neutral_turnover));
  const buyTickCount = sum(tickMinutes.map((minute) => minute.buy_count));
  const sellTickCount = sum(tickMinutes.map((minute) => minute.sell_count));
  const neutralTickCount = sum(tickMinutes.map((minute) => minute.neutral_count));
  const activeTickCount = buyTickCount + sellTickCount;
  const tickCount = activeTickCount + neutralTickCount;
  const activeTurnover = buyTurnover + sellTurnover;
  const totalTurnover = activeTurnover + neutralTurnover;
  const netActiveTurnover = buyTurnover - sellTurnover;
  const activeTurnoverRatio = activeTurnover > 0 ? netActiveTurnover / activeTurnover : null;
  const directionCoverage = totalTurnover > 0 ? activeTurnover / totalTurnover : null;

  const directionCountCoverage = tickCount > 0 ? activeTickCount / tickCount : null;
  const threshold = activeTickCount >= 20
    ? quantile(activeTickSample.map((tick) => tick.turnover), 0.95)
    : null;
  const largeTicks = Number.isFinite(threshold)
    ? activeTickSample.filter((tick) => tick.turnover >= threshold)
    : [];
  const largeBuyTurnover = sum(largeTicks.filter((tick) => tick.direction === 'BUY').map((tick) => tick.turnover));
  const largeSellTurnover = sum(largeTicks.filter((tick) => tick.direction === 'SELL').map((tick) => tick.turnover));
  const largeActiveTurnover = largeBuyTurnover + largeSellTurnover;
  const largeTradeRatio = largeActiveTurnover > 0
    ? (largeBuyTurnover - largeSellTurnover) / largeActiveTurnover : null;

  const barTurnover = sum(bars.map((bar) => Number.isFinite(bar.turnover) ? bar.turnover : bar.close * bar.volume));
  const barVolume = sum(bars.map((bar) => bar.volume));
  const vwap = barVolume > 0 ? barTurnover / barVolume : null;
  const latestPrice = latestTick?.price ?? bars.at(-1)?.close ?? null;
  const priceVsVwap = Number.isFinite(latestPrice) && Number.isFinite(vwap) && vwap > 0
    ? (latestPrice / vwap) - 1 : null;
  let signedBarTurnover = 0;
  let comparableBarTurnover = 0;
  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    const turnover = Number.isFinite(current.turnover) ? current.turnover : current.close * current.volume;
    if (![current.close, previous.close, turnover].every(Number.isFinite)) continue;
    signedBarTurnover += Math.sign(current.close - previous.close) * turnover;
    comparableBarTurnover += turnover;
  }
  const minuteDirectionalRatio = comparableBarTurnover > 0 ? signedBarTurnover / comparableBarTurnover : null;
  const tickMinuteCount = tickMinutes.length;
  const tickMinuteCoverage = bars.length > 0 ? Math.min(1, tickMinuteCount / bars.length) : null;
  const available = activeTickCount >= 10 && activeTurnover > 0;
  const tickCoverageScale = available
    ? 0.35 + (0.65 * Math.sqrt(tickMinuteCoverage || 0))
    : 0;
  const barScore = Number.isFinite(minuteDirectionalRatio)
    ? (minuteDirectionalRatio * 10) + clamp((priceVsVwap || 0) * 1000, -10, 10)
    : 0;
  const score = available ? clamp(
    (((activeTurnoverRatio * 60) + ((largeTradeRatio || 0) * 20)) * tickCoverageScale) + barScore
  ) : Number.isFinite(minuteDirectionalRatio) ? clamp(minuteDirectionalRatio * 45, -45, 45) : 0;
  const signal = signalFromScore(score, available || bars.length >= 10);
  const rawConfidence = available
    ? Math.min(90, 20 + (Math.min(tickCount, 1500) / 1500 * 35) + ((directionCountCoverage || 0) * 25) + (Math.min(bars.length, 390) / 390 * 10))
    : Math.min(35, Math.min(bars.length, 390) / 390 * 35);
  const sessionProgress = Math.min(1, bars.length / 390);
  const confidence = available
    ? rawConfidence
      * (0.4 + (0.6 * (tickMinuteCoverage || 0)))
      * (0.55 + (0.45 * Math.sqrt(sessionProgress)))
    : rawConfidence;
  const anomalies = [];
  if (available && Math.abs(activeTurnoverRatio) >= 0.25) {
    anomalies.push({
      code: activeTurnoverRatio > 0 ? 'ACTIVE_BUY_IMBALANCE' : 'ACTIVE_SELL_IMBALANCE',
      direction: activeTurnoverRatio > 0 ? 'INFLOW' : 'OUTFLOW',
      severity: Math.abs(activeTurnoverRatio) >= 0.45 ? 'P1' : 'P2',
      label: activeTurnoverRatio > 0 ? '主动买入成交显著占优' : '主动卖出成交显著占优'
    });
  }
  if (Number.isFinite(largeTradeRatio) && Math.abs(largeTradeRatio) >= 0.35) {
    anomalies.push({
      code: largeTradeRatio > 0 ? 'LARGE_BUY_IMBALANCE' : 'LARGE_SELL_IMBALANCE',
      direction: largeTradeRatio > 0 ? 'INFLOW' : 'OUTFLOW', severity: 'P2',
      label: largeTradeRatio > 0 ? '大额主动买入占优' : '大额主动卖出占优'
    });
  }
  const asOf = latestTick?.trade_time_et || bars.at(-1)?.bar_time_et || null;
  const dataLevel = available
    ? (tickMinuteCoverage >= 0.5 ? 'FUTU_TICK_DIRECTION' : 'FUTU_TICK_DIRECTION_PARTIAL')
    : bars.length ? 'FUTU_MINUTE_PROXY' : 'NO_INTRADAY_DATA';
  const explanation = available
    ? `${SIGNAL_LABELS[signal]}：主动买入成交额与主动卖出成交额之差为${netActiveTurnover >= 0 ? '+' : ''}${Math.round(netActiveTurnover).toLocaleString('zh-CN')}美元，` +
      `方向成交差占主动成交${(activeTurnoverRatio * 100).toFixed(1)}%，逐笔覆盖${tickMinuteCount}/${bars.length || tickMinuteCount}个已采集分钟。` +
      '逐笔方向反映成交发生在买卖盘哪一侧，不代表账户身份。'
    : bars.length
      ? `${SIGNAL_LABELS[signal]}：当前只有分钟量价方向代理，逐笔主动买卖样本不足，不能发布高置信资金流结论。`
      : '尚无可分析的分钟成交数据。';

  return {
    ticker, tradeDate: effectiveDate, asOf, signal, signalLabel: SIGNAL_LABELS[signal],
    score: round(score, 2), confidence: round(confidence, 2), dataLevel,
    metrics: {
      tickCount, barCount: bars.length,
      buyTurnover: round(buyTurnover, 2), sellTurnover: round(sellTurnover, 2),
      neutralTurnover: round(neutralTurnover, 2), netActiveTurnover: round(netActiveTurnover, 2),
      activeTurnoverRatio: round(activeTurnoverRatio, 6), directionCoverage: round(directionCoverage, 6),
      directionCountCoverage: round(directionCountCoverage, 6), tickMinutes: tickMinuteCount,
      tickMinuteCoverage: round(tickMinuteCoverage, 6), sessionProgress: round(sessionProgress, 6),
      largeTradeThreshold: round(threshold, 2), largeBuyTurnover: round(largeBuyTurnover, 2),
      largeSellTurnover: round(largeSellTurnover, 2), largeTradeRatio: round(largeTradeRatio, 6),
      largeTradeSampleCount: activeTickSample.length,
      latestPrice: round(latestPrice, 4), vwap: round(vwap, 4), priceVsVwap: round(priceVsVwap, 6),
      minuteDirectionalRatio: round(minuteDirectionalRatio, 6), collectedVolume: round(barVolume, 0)
    },
    anomalies, explanation,
    limitations: [
      '主动买卖方向由成交价相对当时买卖盘的位置分类，不等于账户现金流入流出',
      '公开行情不能确认交易者是否为机构、主力或同一最终受益账户',
      '采集器启动前的历史逐笔成交无法回补，早期样本可能只覆盖部分交易时段'
    ],
    modelVersion: INTRADAY_FLOW_MODEL_VERSION
  };
}

export function saveIntradayFlowSnapshot(db, tickerValue, tradeDate = null) {
  const analysis = analyzeIntradayFlow(db, tickerValue, tradeDate);
  if (!analysis.asOf) return analysis;
  const asOfMinute = analysis.asOf.slice(0, 16);
  db.prepare(`
    INSERT INTO intraday_flow_snapshots (
      ticker, as_of_minute, trade_date, signal, score, confidence,
      metrics_json, limitations_json, model_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, as_of_minute, model_version) DO UPDATE SET
      signal = excluded.signal, score = excluded.score, confidence = excluded.confidence,
      metrics_json = excluded.metrics_json, limitations_json = excluded.limitations_json,
      created_at = excluded.created_at
  `).run(
    analysis.ticker, asOfMinute, analysis.tradeDate, analysis.signal,
    analysis.score, analysis.confidence, JSON.stringify(analysis.metrics),
    JSON.stringify(analysis.limitations), analysis.modelVersion, nowIso()
  );
  return analysis;
}

export function listIntradayFlowMinutes(db, tickerValue, tradeDate = null, limit = 30) {
  const ticker = normalizeTicker(tickerValue);
  const effectiveDate = tradeDate || latestTradeDate(db, ticker);
  if (!effectiveDate) return [];
  const boundedLimit = Math.min(390, Math.max(1, Number.parseInt(limit, 10) || 30));
  return toPlainRows(db.prepare(`
    SELECT minute_et AS minute, buy_turnover, sell_turnover, neutral_turnover,
           buy_count + sell_count + neutral_count AS tick_count
    FROM intraday_tick_minutes
    WHERE ticker = ? AND trade_date = ?
    ORDER BY minute_et DESC LIMIT ?
  `).all(ticker, effectiveDate, boundedLimit)).map((row) => ({
    minute: row.minute,
    buyTurnover: row.buy_turnover,
    sellTurnover: row.sell_turnover,
    neutralTurnover: row.neutral_turnover,
    netActiveTurnover: row.buy_turnover - row.sell_turnover,
    tickCount: row.tick_count
  }));
}
