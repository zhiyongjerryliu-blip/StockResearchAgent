import { toPlainRows } from './db.js';
import { normalizeTicker } from './domain.js';
import { calculatePosition } from './portfolio.js';

const POSITION_EPSILON = 1e-8;

export function heldTickers(db, asOf = null) {
  return toPlainRows(db.prepare(`
    SELECT DISTINCT ticker FROM transactions ORDER BY ticker
  `).all())
    .map(({ ticker }) => ticker)
    .filter((ticker) => calculatePosition(db, ticker, asOf).quantity > POSITION_EPSILON);
}

export function requireHeldTicker(db, tickerValue, asOf = null) {
  const ticker = normalizeTicker(tickerValue);
  if (!heldTickers(db, asOf).includes(ticker)) {
    throw new Error(`截至${asOf || '当前'}未持有股票：${ticker}`);
  }
  return ticker;
}
