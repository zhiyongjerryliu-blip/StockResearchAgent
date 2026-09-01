import { nowIso, toPlain, toPlainRows } from './db.js';
import { isoDate, nonNegativeNumber, normalizeTicker, positiveNumber } from './domain.js';
import { calculatePosition } from './portfolio.js';
import { calculateReliability } from './reliability.js';

export function listWatchlist(db) {
  return toPlainRows(db.prepare(`
    SELECT s.*, w.enabled, w.note, w.risk_tags, w.continue_after_exit
    FROM watchlist_items w
    JOIN securities s ON s.ticker = w.ticker
    ORDER BY s.ticker
  `).all()).map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    continue_after_exit: Boolean(row.continue_after_exit),
    risk_tags: JSON.parse(row.risk_tags || '[]')
  }));
}

export function upsertWatchlistItem(db, input) {
  const ticker = normalizeTicker(input.ticker);
  const timestamp = nowIso();
  const benchmark = input.benchmark ? normalizeTicker(input.benchmark) : 'SPY';
  const industryEtf = input.industryEtf ? normalizeTicker(input.industryEtf) : null;
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO securities (
        ticker, name, exchange, cik, sector, industry, benchmark, industry_etf,
        currency, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        name = COALESCE(excluded.name, securities.name),
        benchmark = excluded.benchmark,
        industry_etf = COALESCE(excluded.industry_etf, securities.industry_etf),
        updated_at = excluded.updated_at
    `).run(
      ticker,
      input.name?.trim() || null,
      input.exchange || null,
      input.cik || null,
      input.sector || null,
      input.industry || null,
      benchmark,
      industryEtf,
      timestamp,
      timestamp
    );
    db.prepare(`
      INSERT INTO watchlist_items (
        ticker, enabled, note, risk_tags, continue_after_exit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        enabled = excluded.enabled,
        note = excluded.note,
        risk_tags = excluded.risk_tags,
        continue_after_exit = excluded.continue_after_exit,
        updated_at = excluded.updated_at
    `).run(
      ticker,
      input.enabled === false ? 0 : 1,
      input.note?.trim() || null,
      JSON.stringify(input.riskTags || []),
      input.continueAfterExit === false ? 0 : 1,
      timestamp,
      timestamp
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return listWatchlist(db).find((item) => item.ticker === ticker);
}

export function setWatchlistEnabled(db, tickerValue, enabled) {
  const ticker = normalizeTicker(tickerValue);
  const result = db.prepare(`
    UPDATE watchlist_items SET enabled = ?, updated_at = ? WHERE ticker = ?
  `).run(enabled ? 1 : 0, nowIso(), ticker);
  if (!result.changes) throw new Error('股票不在股票池中');
  return listWatchlist(db).find((item) => item.ticker === ticker);
}

export function updateWatchlistItem(db, tickerValue, input) {
  const ticker = normalizeTicker(tickerValue);
  const existing = listWatchlist(db).find((item) => item.ticker === ticker);
  if (!existing) throw new Error('股票不在股票池中');

  const has = (field) => Object.prototype.hasOwnProperty.call(input, field);
  const name = has('name') ? input.name?.trim() || null : existing.name;
  const benchmark = has('benchmark')
    ? normalizeTicker(input.benchmark || 'SPY')
    : existing.benchmark;
  const industryEtf = has('industryEtf')
    ? (input.industryEtf ? normalizeTicker(input.industryEtf) : null)
    : existing.industry_etf;
  const note = has('note') ? input.note?.trim() || null : existing.note;
  const enabled = has('enabled') ? Boolean(input.enabled) : existing.enabled;
  const timestamp = nowIso();

  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE securities
      SET name = ?, benchmark = ?, industry_etf = ?, updated_at = ?
      WHERE ticker = ?
    `).run(name, benchmark, industryEtf, timestamp, ticker);
    db.prepare(`
      UPDATE watchlist_items
      SET note = ?, enabled = ?, updated_at = ?
      WHERE ticker = ?
    `).run(note, enabled ? 1 : 0, timestamp, ticker);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return listWatchlist(db).find((item) => item.ticker === ticker);
}

export function deleteWatchlistItem(db, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  const existing = listWatchlist(db).find((item) => item.ticker === ticker);
  if (!existing) throw new Error('股票不在股票池中');

  const position = calculatePosition(db, ticker);
  if (position.quantity > 1e-8) {
    throw new Error(`仍持有${position.quantity}股，清仓后才能从股票池删除`);
  }

  const transactionCount = Number(db.prepare(
    'SELECT COUNT(*) AS count FROM transactions WHERE ticker = ?'
  ).get(ticker).count);
  db.prepare('DELETE FROM watchlist_items WHERE ticker = ?').run(ticker);
  return {
    ticker,
    removed: true,
    historyRetained: transactionCount > 0
  };
}

export function listTransactions(db, tickerValue = null) {
  const ticker = tickerValue ? normalizeTicker(tickerValue) : null;
  const rows = ticker
    ? db.prepare('SELECT * FROM transactions WHERE ticker = ? ORDER BY trade_time DESC, id DESC').all(ticker)
    : db.prepare('SELECT * FROM transactions ORDER BY trade_time DESC, id DESC').all();
  return toPlainRows(rows);
}

export function addTransaction(db, input) {
  const ticker = normalizeTicker(input.ticker);
  const security = db.prepare('SELECT ticker FROM securities WHERE ticker = ?').get(ticker);
  if (!security) throw new Error('请先将股票加入股票池');
  const side = String(input.side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) throw new Error('交易方向必须为BUY或SELL');
  const tradeTime = isoDate(input.tradeTime, '交易时间');
  const quantity = positiveNumber(input.quantity, '股数');
  const price = nonNegativeNumber(input.price, '成交价');
  const fee = nonNegativeNumber(input.fee, '费用');
  const timestamp = nowIso();

  db.exec('BEGIN');
  try {
    const result = db.prepare(`
      INSERT INTO transactions (
        ticker, side, trade_time, quantity, price, fee, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ticker, side, tradeTime, quantity, price, fee, input.note?.trim() || null, timestamp, timestamp);
    calculatePosition(db, ticker);
    db.exec('COMMIT');
    return toPlain(db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function deleteTransaction(db, idValue) {
  const id = Number.parseInt(idValue, 10);
  const existing = toPlain(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
  if (!existing) throw new Error('交易记录不存在');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    calculatePosition(db, existing.ticker);
    db.exec('COMMIT');
    return existing;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function saveManualPrice(db, input) {
  const ticker = normalizeTicker(input.ticker);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tradeDate || '')) throw new Error('交易日期格式必须为YYYY-MM-DD');
  const close = positiveNumber(input.close, '收盘价');
  const open = input.open == null || input.open === '' ? null : positiveNumber(input.open, '开盘价');
  const high = input.high == null || input.high === '' ? null : positiveNumber(input.high, '最高价');
  const low = input.low == null || input.low === '' ? null : positiveNumber(input.low, '最低价');
  const volume = input.volume == null || input.volume === '' ? null : nonNegativeNumber(input.volume, '成交量');
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO prices_daily (
      ticker, trade_date, open, high, low, close, adjusted_close, volume,
      provider, available_at, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
    ON CONFLICT(ticker, trade_date, provider) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, adjusted_close = excluded.adjusted_close,
      volume = excluded.volume, available_at = excluded.available_at,
      ingested_at = excluded.ingested_at
  `).run(ticker, input.tradeDate, open, high, low, close, close, volume, timestamp, timestamp);
  return { ticker, tradeDate: input.tradeDate, open, high, low, close, volume, provider: 'manual' };
}

export function saveReliability(db, input) {
  const ticker = normalizeTicker(input.ticker);
  const horizonDays = Number.parseInt(input.horizonDays, 10);
  if (![21, 63, 126].includes(horizonDays)) throw new Error('预测期限必须为21、63或126个交易日');
  const score = calculateReliability({ ...input, horizonDays });
  const asOf = nowIso();
  const modelVersion = input.modelVersion || 'manual-evaluation-v1';
  db.prepare(`
    INSERT INTO reliability_scores (
      ticker, horizon_days, model_version, as_of, direction_accuracy,
      probability_calibration, interval_coverage, benchmark_skill,
      regime_stability, data_quality, effective_samples, composite_score,
      status, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticker, horizonDays, modelVersion, asOf,
    score.directionAccuracy, score.probabilityCalibration, score.intervalCoverage,
    score.benchmarkSkill, score.regimeStability, score.dataQuality,
    score.effectiveSamples, score.compositeScore, score.status,
    JSON.stringify({ requiredSamples: score.requiredSamples, gate: score.gate })
  );
  return { ticker, horizonDays, modelVersion, asOf, ...score };
}

export function listReliability(db) {
  return toPlainRows(db.prepare(`
    SELECT * FROM reliability_scores ORDER BY as_of DESC, ticker, horizon_days
  `).all());
}
