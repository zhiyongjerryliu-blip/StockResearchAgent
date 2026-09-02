import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker, round } from './domain.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value, field) {
  const text = String(value || '');
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!DATE_PATTERN.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${field}无效`);
  }
  return text;
}

function optionalUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('来源链接无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('来源链接必须使用HTTP或HTTPS');
  return text;
}

function ensureSecurity(db, ticker, name = null) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO securities (
      ticker, name, benchmark, currency, created_at, updated_at
    ) VALUES (?, ?, 'SPY', 'USD', ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      name = COALESCE(excluded.name, securities.name),
      updated_at = excluded.updated_at
  `).run(ticker, String(name || '').trim() || null, timestamp, timestamp);
}

export function addPeer(db, input) {
  const ticker = normalizeTicker(input.ticker);
  const relatedTicker = normalizeTicker(input.relatedTicker);
  if (ticker === relatedTicker) throw new Error('不能将公司自身设为竞争对手');
  if (!db.prepare('SELECT 1 FROM securities WHERE ticker = ?').get(ticker)) throw new Error('目标股票不存在');
  const activeFrom = validDate(input.activeFrom || new Date().toISOString().slice(0, 10), '生效日期');

  db.exec('BEGIN');
  try {
    ensureSecurity(db, relatedTicker, input.name);
    const active = db.prepare(`
      SELECT id FROM company_relationships
      WHERE ticker = ? AND related_ticker = ? AND relationship_type = 'COMPETITOR' AND active_to IS NULL
    `).get(ticker, relatedTicker);
    if (!active) {
      const historical = db.prepare(`
        SELECT id FROM company_relationships
        WHERE ticker = ? AND related_ticker = ? AND relationship_type = 'COMPETITOR' AND active_from = ?
      `).get(ticker, relatedTicker, activeFrom);
      if (historical) {
        db.prepare('UPDATE company_relationships SET active_to = NULL, source = ? WHERE id = ?')
          .run(String(input.source || 'user').trim() || 'user', historical.id);
      } else {
        db.prepare(`
          INSERT INTO company_relationships (
            ticker, related_ticker, relationship_type, source, active_from, active_to
          ) VALUES (?, ?, 'COMPETITOR', ?, ?, NULL)
        `).run(ticker, relatedTicker, String(input.source || 'user').trim() || 'user', activeFrom);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return listPeers(db, ticker).find((peer) => peer.ticker === relatedTicker);
}

export function removePeer(db, tickerValue, relatedTickerValue) {
  const ticker = normalizeTicker(tickerValue);
  const relatedTicker = normalizeTicker(relatedTickerValue);
  const result = db.prepare(`
    UPDATE company_relationships SET active_to = ?
    WHERE ticker = ? AND related_ticker = ? AND relationship_type = 'COMPETITOR' AND active_to IS NULL
  `).run(new Date().toISOString().slice(0, 10), ticker, relatedTicker);
  if (!result.changes) throw new Error('竞争对手关系不存在');
  return { ticker, relatedTicker, removed: true };
}

export function listPeers(db, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  return toPlainRows(db.prepare(`
    SELECT s.ticker, s.name, s.sector, s.industry, r.source, r.active_from
    FROM company_relationships r
    JOIN securities s ON s.ticker = r.related_ticker
    WHERE r.ticker = ? AND r.relationship_type = 'COMPETITOR' AND r.active_to IS NULL
    ORDER BY s.ticker
  `).all(ticker));
}

export function saveEarningsEstimate(db, input) {
  const ticker = normalizeTicker(input.ticker);
  if (!db.prepare('SELECT 1 FROM securities WHERE ticker = ?').get(ticker)) throw new Error('股票不存在');
  const asOf = validDate(input.asOf, '估值基准日');
  const periodEnd = input.periodEnd ? validDate(input.periodEnd, '预测期末日') : null;
  const epsValue = Number(input.epsValue);
  if (!Number.isFinite(epsValue)) throw new Error('预期EPS必须是有效数字');
  const source = String(input.source || '').trim();
  if (!source) throw new Error('请填写预期EPS来源');
  const result = db.prepare(`
    INSERT INTO earnings_estimates (
      ticker, estimate_type, as_of, period_end, eps_value, source, source_url,
      provider, calculation_method, estimate_basis, quality_status, note, fetched_at, created_at
    ) VALUES (?, 'NTM_EPS', ?, ?, ?, ?, ?, 'manual', 'MANUAL_INPUT',
              'user_supplied', 'manual', ?, ?, ?)
  `).run(
    ticker, asOf, periodEnd, epsValue, source, optionalUrl(input.sourceUrl),
    String(input.note || '').trim() || null, nowIso(), nowIso()
  );
  return toPlain(db.prepare('SELECT * FROM earnings_estimates WHERE id = ?').get(result.lastInsertRowid));
}

export function deleteEarningsEstimate(db, idValue) {
  const id = Number.parseInt(idValue, 10);
  const estimate = toPlain(db.prepare('SELECT * FROM earnings_estimates WHERE id = ?').get(id));
  if (!estimate) throw new Error('预期EPS记录不存在');
  db.prepare('DELETE FROM earnings_estimates WHERE id = ?').run(id);
  return estimate;
}

function latestPrice(db, ticker) {
  return toPlain(db.prepare(`
    SELECT trade_date, close, provider
    FROM (
      SELECT trade_date, close, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily WHERE ticker = ?
    )
    WHERE row_number = 1
    ORDER BY trade_date DESC LIMIT 1
  `).get(ticker)) || null;
}

function latestEstimate(db, ticker) {
  return toPlain(db.prepare(`
    SELECT * FROM earnings_estimates
    WHERE ticker = ? AND estimate_type = 'NTM_EPS'
    ORDER BY as_of DESC, CASE WHEN provider = 'manual' THEN 1 ELSE 0 END DESC, id DESC LIMIT 1
  `).get(ticker)) || null;
}

function allEstimates(db, ticker) {
  return toPlainRows(db.prepare(`
    SELECT * FROM earnings_estimates
    WHERE ticker = ? AND estimate_type = 'NTM_EPS'
    ORDER BY as_of DESC, id DESC LIMIT 30
  `).all(ticker));
}

function estimatePeriods(db, estimateId) {
  if (!estimateId) return [];
  return toPlainRows(db.prepare(`
    SELECT period_end, horizon, eps_average, eps_high, eps_low, analyst_count,
           eps_average_7_days_ago, eps_average_30_days_ago,
           revision_up_7_days, revision_down_7_days,
           revision_up_30_days, revision_down_30_days,
           ntm_weight, included_in_ntm
    FROM earnings_estimate_periods
    WHERE estimate_id = ?
    ORDER BY period_end, horizon
  `).all(estimateId)).map((period) => ({
    ...period,
    included_in_ntm: Boolean(period.included_in_ntm)
  }));
}

function epsFacts(db, ticker) {
  const rows = toPlainRows(db.prepare(`
    SELECT value, period_start, period_end, period_type, fiscal_year, fiscal_period,
           filed_at, form, accession_number, source_url, tag_priority
    FROM financial_facts
    WHERE ticker = ? AND metric_key = 'epsDiluted'
      AND period_type IN ('annual', 'ytd', 'quarter')
    ORDER BY period_end DESC, filed_at DESC, tag_priority ASC
  `).all(ticker));
  const distinct = new Map();
  for (const row of rows) {
    const key = [row.period_type, row.period_start, row.period_end, row.fiscal_period].join(':');
    if (!distinct.has(key)) distinct.set(key, row);
  }
  return [...distinct.values()];
}

function periodsAreContinuous(rows) {
  if (rows.length !== 4) return false;
  for (let index = 1; index < rows.length; index += 1) {
    const days = (Date.parse(rows[index - 1].period_end) - Date.parse(rows[index].period_end)) / 86_400_000;
    if (days < 60 || days > 130) return false;
  }
  return true;
}

function ttmPeriod(fact, role) {
  return {
    role,
    periodStart: fact.period_start,
    periodEnd: fact.period_end,
    periodType: fact.period_type,
    fiscalPeriod: fact.fiscal_period,
    value: fact.value,
    filedAt: fact.filed_at,
    form: fact.form,
    sourceUrl: fact.source_url
  };
}

export function calculateTtmEps(db, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  const facts = epsFacts(db, ticker);
  const annual = facts.filter((fact) => fact.period_type === 'annual')[0] || null;
  const interim = facts.filter((fact) => (
    fact.period_type === 'ytd'
    || (fact.period_type === 'quarter' && fact.fiscal_period === 'Q1')
  ));
  const currentInterim = interim.find((fact) => !annual || fact.period_end > annual.period_end) || null;

  if (annual && !currentInterim) {
    return {
      value: Number(annual.value),
      method: 'LATEST_FY',
      label: `最新财年EPS（截至${annual.period_end}）`,
      periods: [ttmPeriod(annual, 'LATEST_FY')],
      issue: null
    };
  }

  if (annual && currentInterim) {
    const priorInterim = interim.find((fact) => {
      if (fact === currentInterim || fact.fiscal_period !== currentInterim.fiscal_period) return false;
      const days = (Date.parse(currentInterim.period_end) - Date.parse(fact.period_end)) / 86_400_000;
      return days >= 300 && days <= 430;
    }) || null;
    if (priorInterim) {
      return {
        value: Number(annual.value) + Number(currentInterim.value) - Number(priorInterim.value),
        method: 'FY_PLUS_YTD_DELTA',
        label: `年度EPS + ${currentInterim.fiscal_period}本期YTD − 上年同期YTD`,
        periods: [
          ttmPeriod(annual, 'LATEST_FY'),
          ttmPeriod(currentInterim, 'CURRENT_YTD'),
          ttmPeriod(priorInterim, 'PRIOR_YTD')
        ],
        issue: null
      };
    }
    return {
      value: null,
      method: null,
      label: null,
      periods: [ttmPeriod(annual, 'LATEST_FY'), ttmPeriod(currentInterim, 'CURRENT_YTD')],
      issue: `缺少${currentInterim.fiscal_period}上年同期EPS，无法滚动计算TTM`
    };
  }

  const quarters = facts.filter((fact) => fact.period_type === 'quarter').slice(0, 4);
  if (periodsAreContinuous(quarters)) {
    return {
      value: quarters.reduce((sum, item) => sum + Number(item.value), 0),
      method: 'FOUR_QUARTERS',
      label: '最近四个连续季度EPS之和',
      periods: quarters.map((fact) => ttmPeriod(fact, 'QUARTER')),
      issue: null
    };
  }
  return {
    value: null,
    method: null,
    label: null,
    periods: quarters.map((fact) => ttmPeriod(fact, 'QUARTER')),
    issue: '缺少完整年度EPS，且不足四个连续季度EPS'
  };
}

function annualMetricRows(db, ticker, metricKey) {
  const rows = toPlainRows(db.prepare(`
    SELECT value, period_end, filed_at, tag_priority
    FROM financial_facts
    WHERE ticker = ? AND metric_key = ? AND period_type = 'annual'
    ORDER BY period_end DESC, filed_at DESC, tag_priority ASC
  `).all(ticker, metricKey));
  const distinct = new Map();
  for (const row of rows) {
    if (!distinct.has(row.period_end)) distinct.set(row.period_end, row);
  }
  return [...distinct.values()];
}

function companyValuation(db, ticker) {
  const security = toPlain(db.prepare(`
    SELECT ticker, name, sector, industry FROM securities WHERE ticker = ?
  `).get(ticker));
  if (!security) throw new Error('股票不存在');
  const price = latestPrice(db, ticker);
  const ttm = calculateTtmEps(db, ticker);
  const ttmEps = ttm.value;
  const estimate = latestEstimate(db, ticker);
  const staticPe = price && ttmEps > 0 ? Number(price.close) / ttmEps : null;
  const forwardPe = price && estimate?.eps_value > 0 ? Number(price.close) / Number(estimate.eps_value) : null;
  const annualRevenue = annualMetricRows(db, ticker, 'revenue');
  const annualGrossProfit = annualMetricRows(db, ticker, 'grossProfit');
  const latestRevenue = annualRevenue[0] || null;
  const previousRevenue = annualRevenue[1] || null;
  const matchingGrossProfit = latestRevenue
    ? annualGrossProfit.find((row) => row.period_end === latestRevenue.period_end)
    : null;
  const revenueGrowth = latestRevenue && previousRevenue && previousRevenue.value !== 0
    ? (latestRevenue.value - previousRevenue.value) / Math.abs(previousRevenue.value)
    : null;
  const grossMargin = latestRevenue && matchingGrossProfit && latestRevenue.value !== 0
    ? matchingGrossProfit.value / latestRevenue.value
    : null;
  const issues = [];
  if (!price) issues.push('缺少股价');
  if (ttm.issue) issues.push(ttm.issue);
  else if (ttmEps <= 0) issues.push('TTM EPS不为正，静态PE无意义');
  if (!estimate) issues.push('缺少NTM预期EPS');
  else if (estimate.eps_value <= 0) issues.push('NTM预期EPS不为正，动态PE无意义');
  else if (estimate.quality_status === 'proxy') issues.push('NTM EPS使用下一完整财年一致预期近似');
  else if (estimate.quality_status === 'limited_coverage') issues.push('NTM EPS分析师覆盖少于3人');

  return {
    ...security,
    price: price ? round(price.close, 4) : null,
    priceDate: price?.trade_date || null,
    priceProvider: price?.provider || null,
    ttmEps: round(ttmEps, 4),
    ttmMethod: ttm.method,
    ttmLabel: ttm.label,
    ttmPeriods: ttm.periods,
    staticPe: round(staticPe, 2),
    forwardEps: estimate ? round(estimate.eps_value, 4) : null,
    forwardPe: round(forwardPe, 2),
    estimate: estimate ? {
      id: estimate.id, asOf: estimate.as_of, periodEnd: estimate.period_end,
      source: estimate.source, sourceUrl: estimate.source_url, note: estimate.note,
      provider: estimate.provider, calculationMethod: estimate.calculation_method,
      estimateBasis: estimate.estimate_basis, qualityStatus: estimate.quality_status,
      analystCount: estimate.analyst_count, epsHigh: round(estimate.eps_high, 4),
      epsLow: round(estimate.eps_low, 4), fetchedAt: estimate.fetched_at,
      periods: estimatePeriods(db, estimate.id)
    } : null,
    revenueGrowth: round(revenueGrowth, 6),
    grossMargin: round(grossMargin, 6),
    issues
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function getValuationOverview(db, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  const target = companyValuation(db, ticker);
  const peerRelationships = listPeers(db, ticker);
  const peers = peerRelationships.map((peer) => ({
    ...companyValuation(db, peer.ticker),
    relationship: { source: peer.source, activeFrom: peer.active_from }
  }));
  return {
    target,
    peers,
    peerMedian: {
      staticPe: round(median(peers.map((peer) => peer.staticPe)), 2),
      forwardPe: round(median(peers.map((peer) => peer.forwardPe)), 2),
      revenueGrowth: round(median(peers.map((peer) => peer.revenueGrowth)), 6),
      grossMargin: round(median(peers.map((peer) => peer.grossMargin)), 6),
      staticPeSamples: peers.filter((peer) => peer.staticPe != null).length,
      forwardPeSamples: peers.filter((peer) => peer.forwardPe != null).length
    },
    estimates: allEstimates(db, ticker),
    methodology: {
      staticPe: '最新收盘价 ÷ TTM GAAP摊薄EPS；优先使用最新财年EPS，跨财年时使用年度EPS + 本期YTD − 上年同期YTD',
      forwardPe: '最新收盘价 ÷ NTM一致预期EPS；优先汇总未来四个财季，不足四季时按财年剩余天数滚动加权未来两个财年预期',
      peerMedian: '仅统计已配置竞争对手中可计算的有效值，中位数不包含目标公司'
    }
  };
}

export function valuationGroupTickers(db, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  if (!db.prepare('SELECT 1 FROM securities WHERE ticker = ?').get(ticker)) throw new Error('股票不存在');
  return [ticker, ...listPeers(db, ticker).map((peer) => peer.ticker)];
}
