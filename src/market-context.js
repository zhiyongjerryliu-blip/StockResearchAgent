import { nowIso, toPlain, toPlainRows } from './db.js';
import { round } from './domain.js';

const TREASURY_RATES_URL = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?page=0&type=daily_treasury_yield_curve';
const CME_METHOD_URL = 'https://www.cmegroup.com/content/dam/cmegroup/education/files/webinar-secured-overnight-funding-rate-sofr.pdf';

export const marketIndicators = Object.freeze([
  { key: 'US10Y_YIELD', symbol: '^TNX', label: '美国10年期国债收益率', kind: 'YIELD' },
  { key: 'US13W_YIELD', symbol: '^IRX', label: '美国13周期限收益率', kind: 'YIELD' },
  { key: 'US10Y_FUTURES', symbol: 'ZN=F', label: '10年期美国国债期货价格代理', kind: 'PRICE' },
  { key: 'FED_FUNDS_FUTURES', symbol: 'ZQ=F', label: '30天联邦基金期货', kind: 'FED_FUNDS' },
  { key: 'LONG_TREASURY_ETF', symbol: 'TLT', label: '长期美债ETF价格代理', kind: 'PRICE' }
]);

function latestPair(rows, asOf) {
  const eligible = rows.filter((row) => row.trade_date <= asOf)
    .sort((left, right) => right.trade_date.localeCompare(left.trade_date));
  return [eligible[0] || null, eligible[1] || null];
}
function publicMetric(definition, current, previous) {
  if (!current) return {
    key: definition.key, symbol: definition.symbol, label: definition.label,
    kind: definition.kind, available: false
  };
  const change = previous ? current.close - previous.close : null;
  const metric = {
    key: definition.key, symbol: definition.symbol, label: definition.label,
    kind: definition.kind, available: true, tradeDate: current.trade_date,
    value: round(current.close, 4), previousValue: round(previous?.close, 4),
    provider: current.provider, availableAt: current.available_at
  };
  if (definition.kind === 'YIELD') metric.changeBps = round(change == null ? null : change * 100, 2);
  if (definition.kind === 'PRICE') {
    metric.changePct = round(previous?.close ? change / previous.close : null, 6);
  }
  if (definition.kind === 'FED_FUNDS') {
    metric.impliedRate = round(100 - current.close, 4);
    metric.previousImpliedRate = previous ? round(100 - previous.close, 4) : null;
    metric.changeBps = round(change == null ? null : -change * 100, 2);
  }
  return metric;
}

export function classifyMarketRegime(metrics) {
  const tenYearBps = metrics.US10Y_YIELD?.changeBps;
  const expectedRateBps = metrics.FED_FUNDS_FUTURES?.changeBps;
  const signals = [];
  if (Number.isFinite(tenYearBps) && Math.abs(tenYearBps) >= 10) {
    signals.push({
      key: 'US10Y_MOVE', direction: tenYearBps > 0 ? 'HEADWIND' : 'TAILWIND',
      value: tenYearBps, unit: 'bp', label: `10年期美债收益率${tenYearBps > 0 ? '上行' : '下行'}`
    });
  }
  if (Number.isFinite(expectedRateBps) && Math.abs(expectedRateBps) >= 5) {
    signals.push({
      key: 'RATE_EXPECTATION_MOVE', direction: expectedRateBps > 0 ? 'HEADWIND' : 'TAILWIND',
      value: expectedRateBps, unit: 'bp', label: `联邦基金期货隐含利率${expectedRateBps > 0 ? '上行' : '下行'}`
    });
  }
  const directions = new Set(signals.map((signal) => signal.direction));
  let regime = 'NEUTRAL';
  if (directions.size > 1) regime = 'MIXED';
  else if (directions.has('HEADWIND')) regime = 'RATE_HEADWIND';
  else if (directions.has('TAILWIND')) regime = 'RATE_TAILWIND';
  const maxTenYear = Math.abs(tenYearBps || 0);
  const maxExpected = Math.abs(expectedRateBps || 0);
  const severity = maxTenYear >= 25 || maxExpected >= 15
    ? 'P1' : (maxTenYear >= 10 || maxExpected >= 5 ? 'P2' : 'P3');
  const labels = signals.map((signal) => `${signal.label}${Math.abs(signal.value).toFixed(1)}bp`);
  const summary = labels.length
    ? `${labels.join('；')}。该信号是利率环境代理，不代表单只股票必然涨跌。`
    : '美债收益率及联邦基金期货代理未出现达到当前阈值的单日变化。';
  return { regime, severity, summary, signals };
}

function saveBars(db, definition, bars, timestamp) {
  const statement = db.prepare(`
    INSERT INTO macro_market_bars (
      indicator_key, symbol, trade_date, close, provider, available_at, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(indicator_key, trade_date, provider) DO UPDATE SET
      symbol = excluded.symbol, close = excluded.close,
      available_at = excluded.available_at, ingested_at = excluded.ingested_at
  `);
  for (const bar of bars) {
    statement.run(
      definition.key, definition.symbol, bar.tradeDate, bar.close,
      bar.provider || 'yahoo', bar.availableAt || timestamp, timestamp
    );
  }
}

export async function syncMarketContext(db, provider, asOf) {
  if (!provider) return { skipped: true, reason: 'provider-unavailable', asOf };
  const timestamp = nowIso();
  const results = [];
  for (const definition of marketIndicators) {
    try {
      const bars = await provider.fetchDaily(definition.symbol);
      saveBars(db, definition, bars, timestamp);
      results.push({ key: definition.key, symbol: definition.symbol, ok: true, count: bars.length });
    } catch (error) {
      results.push({ key: definition.key, symbol: definition.symbol, ok: false, error: error.message });
    }
  }
  const snapshot = buildMarketContext(db, asOf);
  if (!snapshot.available) return { skipped: false, asOf, results, snapshot };
  db.prepare(`
    INSERT INTO macro_market_snapshots (
      as_of, regime, severity, summary, metrics_json, signals_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(as_of) DO UPDATE SET
      regime = excluded.regime, severity = excluded.severity, summary = excluded.summary,
      metrics_json = excluded.metrics_json, signals_json = excluded.signals_json,
      created_at = excluded.created_at
  `).run(
    asOf, snapshot.regime, snapshot.severity, snapshot.summary,
    JSON.stringify(snapshot.metrics), JSON.stringify(snapshot.signals), timestamp
  );
  if (['P1', 'P2'].includes(snapshot.severity) && snapshot.signals.length) {
    const eventKey = `MACRO_RATES:${asOf}:${snapshot.regime}`;
    db.prepare(`
      INSERT INTO market_events (
        event_key, event_date, category, title, summary, severity, direction,
        source_type, source_url, evidence_json, status, detected_at
      ) VALUES (?, ?, 'RATES_AND_TREASURIES', ?, ?, ?, ?, 'MARKET_PROXY', ?, ?, 'ACTIVE', ?)
      ON CONFLICT(event_key) DO UPDATE SET
        title = excluded.title, summary = excluded.summary, severity = excluded.severity,
        direction = excluded.direction, evidence_json = excluded.evidence_json,
        detected_at = excluded.detected_at
    `).run(
      eventKey, asOf, `利率与美债环境：${snapshot.regime}`, snapshot.summary,
      snapshot.severity, snapshot.regime, TREASURY_RATES_URL,
      JSON.stringify(snapshot.provenance), timestamp
    );
  }
  return { skipped: false, asOf, results, snapshot };
}

export function buildMarketContext(db, asOf) {
  const metrics = {};
  for (const definition of marketIndicators) {
    const rows = toPlainRows(db.prepare(`
      SELECT * FROM macro_market_bars
      WHERE indicator_key = ? AND trade_date <= ?
      ORDER BY trade_date DESC LIMIT 2
    `).all(definition.key, asOf));
    const [current, previous] = latestPair(rows, asOf);
    metrics[definition.key] = publicMetric(definition, current, previous);
  }
  const classification = classifyMarketRegime(metrics);
  return {
    asOf, available: Object.values(metrics).some((metric) => metric.available), metrics,
    ...classification,
    methodology: {
      fedFunds: 'ZQ=F 价格按 100−期货价格换算隐含月均有效联邦基金利率，仅作预期变化代理，不是CME FedWatch概率。',
      treasury: '^TNX、^IRX、ZN=F和TLT来自Yahoo免费行情代理；美国财政部曲线用于口径参考，不代表这些代理的官方成交价。'
    },
    provenance: [
      { source: 'Yahoo Finance chart', role: '免费市场行情代理', status: 'PROXY' },
      { source: 'U.S. Treasury daily yield curve', sourceUrl: TREASURY_RATES_URL, role: '官方收益率口径参考' },
      { source: 'CME Fed Funds futures convention', sourceUrl: CME_METHOD_URL, role: '100减期货价格的换算依据' }
    ]
  };
}

export function getMarketContext(db, asOf = null) {
  if (asOf) return buildMarketContext(db, asOf);
  const row = toPlain(db.prepare(`
    SELECT * FROM macro_market_snapshots ORDER BY as_of DESC LIMIT 1
  `).get());
  if (!row) return { available: false, asOf: null, metrics: {}, signals: [] };
  return buildMarketContext(db, row.as_of);
}
