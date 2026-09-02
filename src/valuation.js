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
  `).all(ticker)).map((estimate) => ({
    ...estimate,
    revision: estimateRevision(db, estimate)
  }));
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

function weightedPeriodValue(periods, field) {
  const included = periods.filter((period) => period.included_in_ntm);
  if (
    !included.length
    || included.some((period) => period[field] == null || !Number.isFinite(Number(period[field])))
  ) return null;
  return included.reduce(
    (sum, period) => sum + (Number(period[field]) * Number(period.ntm_weight)),
    0
  );
}

function revisionWindow(currentValue, previousValue, periods, suffix) {
  const up = periods.reduce((sum, period) => sum + Number(period[`revision_up_${suffix}`] || 0), 0);
  const down = periods.reduce((sum, period) => sum + Number(period[`revision_down_${suffix}`] || 0), 0);
  const change = previousValue == null ? null : currentValue - previousValue;
  return {
    previousEps: round(previousValue, 4),
    change: round(change, 4),
    changePct: previousValue && change != null ? round(change / Math.abs(previousValue), 6) : null,
    revisionsUp: up,
    revisionsDown: down,
    revisionNet: up - down,
    revisionBreadth: up + down ? round((up - down) / (up + down), 6) : null
  };
}

function estimateRevision(db, estimate) {
  if (!estimate || estimate.provider === 'manual') return null;
  const periods = estimatePeriods(db, estimate.id).filter((period) => period.included_in_ntm);
  if (!periods.length) return null;
  const currentValue = Number(estimate.eps_value);
  return {
    sevenDay: revisionWindow(
      currentValue,
      weightedPeriodValue(periods, 'eps_average_7_days_ago'),
      periods,
      '7_days'
    ),
    thirtyDay: revisionWindow(
      currentValue,
      weightedPeriodValue(periods, 'eps_average_30_days_ago'),
      periods,
      '30_days'
    )
  };
}

function epsFacts(db, ticker, asOf = null) {
  const sql = `
    SELECT value, period_start, period_end, period_type, fiscal_year, fiscal_period,
           filed_at, form, accession_number, source_url, tag_priority
    FROM financial_facts
    WHERE ticker = ? AND metric_key = 'epsDiluted'
      AND period_type IN ('annual', 'ytd', 'quarter')
      ${asOf ? 'AND filed_at < ?' : ''}
    ORDER BY period_end DESC, filed_at DESC, tag_priority ASC
  `;
  const rows = toPlainRows(asOf
    ? db.prepare(sql).all(ticker, asOf)
    : db.prepare(sql).all(ticker));
  const distinct = new Map();
  for (const row of rows) {
    const key = [row.period_type, row.period_start, row.period_end, row.fiscal_period].join(':');
    if (!distinct.has(key)) distinct.set(key, row);
  }
  return [...distinct.values()];
}

function rawEpsFacts(db, ticker) {
  return toPlainRows(db.prepare(`
    SELECT value, period_start, period_end, period_type, fiscal_year, fiscal_period,
           filed_at, form, accession_number, source_url, tag_priority
    FROM financial_facts
    WHERE ticker = ? AND metric_key = 'epsDiluted'
      AND period_type IN ('annual', 'ytd', 'quarter')
    ORDER BY filed_at, tag_priority DESC, period_end
  `).all(ticker));
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

function calculateTtmFromFacts(facts) {
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

export function calculateTtmEps(db, tickerValue, asOf = null) {
  const ticker = normalizeTicker(tickerValue);
  return calculateTtmFromFacts(epsFacts(db, ticker, asOf));
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
  const estimateRevisionSummary = estimateRevision(db, estimate);
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
      periods: estimatePeriods(db, estimate.id), revision: estimateRevisionSummary
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

function relativePremium(value, peerValue) {
  if (!Number.isFinite(value) || !Number.isFinite(peerValue) || peerValue <= 0) return null;
  return round((value / peerValue) - 1, 6);
}

function relativeLabel(premium) {
  if (premium == null) return null;
  if (premium <= -0.2) return '较同业显著折价';
  if (premium < -0.05) return '较同业折价';
  if (premium <= 0.05) return '接近同业';
  if (premium < 0.2) return '较同业溢价';
  return '较同业显著溢价';
}

function dateYearsBefore(dateValue, years) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function quantile(sortedValues, fraction) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + ((sortedValues[upper] - sortedValues[lower]) * (index - lower));
}

function percentileRank(values, current) {
  if (!Number.isFinite(current) || !values.length) return null;
  const less = values.filter((value) => value < current).length;
  const equal = values.filter((value) => value === current).length;
  return ((less + (equal * 0.5)) / values.length) * 100;
}

function percentileLabel(percentile) {
  if (percentile == null) return null;
  if (percentile <= 10) return '历史低位';
  if (percentile < 30) return '历史偏低';
  if (percentile <= 70) return '历史中部';
  if (percentile < 90) return '历史偏高';
  return '历史高位';
}

function distribution(samples, current, minimumSamples) {
  const values = samples.map((sample) => sample.pe).filter(Number.isFinite).sort((left, right) => left - right);
  const rank = values.length >= minimumSamples ? percentileRank(values, current) : null;
  return {
    sampleCount: values.length,
    from: samples[0]?.date || null,
    to: samples.at(-1)?.date || null,
    minimum: round(values[0], 2),
    p10: round(quantile(values, 0.1), 2),
    median: round(quantile(values, 0.5), 2),
    p90: round(quantile(values, 0.9), 2),
    maximum: round(values.at(-1), 2),
    current: round(current, 2),
    percentile: round(rank, 2),
    label: percentileLabel(rank),
    qualityStatus: values.length >= 252
      ? 'complete'
      : values.length >= minimumSamples ? 'limited_history' : 'insufficient_samples',
    minimumSamples
  };
}

function historicalPrices(db, ticker, startDate) {
  return toPlainRows(db.prepare(`
    SELECT trade_date AS date, close
    FROM (
      SELECT trade_date, close, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily
      WHERE ticker = ? AND trade_date >= ?
    )
    WHERE row_number = 1
    ORDER BY trade_date
  `).all(ticker, startDate));
}

export function buildHistoricalStaticPeSeries(db, tickerValue, startDate) {
  const ticker = normalizeTicker(tickerValue);
  const prices = historicalPrices(db, ticker, startDate);
  const facts = rawEpsFacts(db, ticker);
  const availableFacts = new Map();
  let factIndex = 0;
  return prices.flatMap((price) => {
    while (factIndex < facts.length && facts[factIndex].filed_at < price.date) {
      const fact = facts[factIndex];
      const key = [fact.period_type, fact.period_start, fact.period_end, fact.fiscal_period].join(':');
      const current = availableFacts.get(key);
      if (
        !current
        || fact.filed_at > current.filed_at
        || (fact.filed_at === current.filed_at && fact.tag_priority < current.tag_priority)
      ) availableFacts.set(key, fact);
      factIndex += 1;
    }
    const pointInTimeFacts = [...availableFacts.values()].sort((left, right) => (
      right.period_end.localeCompare(left.period_end)
      || right.filed_at.localeCompare(left.filed_at)
      || left.tag_priority - right.tag_priority
    ));
    const ttm = calculateTtmFromFacts(pointInTimeFacts);
    if (!Number.isFinite(ttm.value) || ttm.value <= 0 || !Number.isFinite(Number(price.close))) return [];
    return [{
      date: price.date,
      price: round(Number(price.close), 4),
      ttmEps: round(ttm.value, 4),
      pe: round(Number(price.close) / ttm.value, 6),
      ttmMethod: ttm.method
    }];
  });
}

function buildHistoricalForwardPeSeries(db, ticker, startDate) {
  const estimates = toPlainRows(db.prepare(`
    SELECT * FROM (
      SELECT e.*,
             ROW_NUMBER() OVER (
               PARTITION BY e.as_of
               ORDER BY CASE WHEN e.provider = 'manual' THEN 0 ELSE 1 END, e.id DESC
             ) AS row_number
      FROM earnings_estimates e
      WHERE e.ticker = ? AND e.estimate_type = 'NTM_EPS' AND e.as_of >= ?
    )
    WHERE row_number = 1
    ORDER BY as_of
  `).all(ticker, startDate));
  const priceStatement = db.prepare(`
    SELECT trade_date, close FROM (
      SELECT trade_date, close, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily WHERE ticker = ? AND trade_date <= ?
    ) WHERE row_number = 1 ORDER BY trade_date DESC LIMIT 1
  `);
  return estimates.flatMap((estimate) => {
    const price = toPlain(priceStatement.get(ticker, estimate.as_of));
    if (!price || estimate.eps_value <= 0) return [];
    return [{
      date: estimate.as_of,
      priceDate: price.trade_date,
      price: round(Number(price.close), 4),
      forwardEps: round(Number(estimate.eps_value), 4),
      pe: round(Number(price.close) / Number(estimate.eps_value), 6),
      provider: estimate.provider
    }];
  });
}

export function getHistoricalValuation(db, tickerValue, options = {}) {
  const ticker = normalizeTicker(tickerValue);
  const years = [1, 3, 5].includes(Number(options.lookbackYears)) ? Number(options.lookbackYears) : 5;
  const latest = latestPrice(db, ticker);
  if (!latest) {
    return { lookbackYears: years, startDate: null, staticPe: distribution([], null, 60), forwardPe: distribution([], null, 20) };
  }
  const startDate = dateYearsBefore(latest.trade_date, years);
  const current = companyValuation(db, ticker);
  const staticSeries = buildHistoricalStaticPeSeries(db, ticker, startDate);
  const forwardSeries = buildHistoricalForwardPeSeries(db, ticker, startDate);
  return {
    lookbackYears: years,
    startDate,
    staticPe: distribution(staticSeries, current.staticPe, 60),
    forwardPe: distribution(forwardSeries, current.forwardPe, 20),
    recentStaticSamples: staticSeries.slice(-10).reverse(),
    recentForwardSamples: forwardSeries.slice(-10).reverse(),
    methodology: '历史静态PE仅使用价格日之前已向SEC提交的EPS事实；动态PE仅使用当日留存的一致预期快照，禁止用当前预期回填历史'
  };
}

export function getValuationOverview(db, tickerValue, options = {}) {
  const ticker = normalizeTicker(tickerValue);
  const target = companyValuation(db, ticker);
  const peerRelationships = listPeers(db, ticker);
  const peers = peerRelationships.map((peer) => ({
    ...companyValuation(db, peer.ticker),
    relationship: { source: peer.source, activeFrom: peer.active_from }
  }));
  const peerMedian = {
    staticPe: round(median(peers.map((peer) => peer.staticPe)), 2),
    forwardPe: round(median(peers.map((peer) => peer.forwardPe)), 2),
    revenueGrowth: round(median(peers.map((peer) => peer.revenueGrowth)), 6),
    grossMargin: round(median(peers.map((peer) => peer.grossMargin)), 6),
    staticPeSamples: peers.filter((peer) => peer.staticPe != null).length,
    forwardPeSamples: peers.filter((peer) => peer.forwardPe != null).length
  };
  const staticPremium = relativePremium(target.staticPe, peerMedian.staticPe);
  const forwardPremium = relativePremium(target.forwardPe, peerMedian.forwardPe);
  return {
    target,
    peers,
    peerMedian,
    relativeToPeers: {
      staticPePremium: staticPremium,
      staticPeLabel: relativeLabel(staticPremium),
      forwardPePremium: forwardPremium,
      forwardPeLabel: relativeLabel(forwardPremium),
      staticQualityStatus: peerMedian.staticPeSamples >= 2 ? 'complete' : 'limited_samples',
      forwardQualityStatus: peerMedian.forwardPeSamples >= 2 ? 'complete' : 'limited_samples'
    },
    historicalValuation: getHistoricalValuation(db, ticker, options),
    estimates: allEstimates(db, ticker),
    methodology: {
      staticPe: '最新收盘价 ÷ TTM GAAP摊薄EPS；优先使用最新财年EPS，跨财年时使用年度EPS + 本期YTD − 上年同期YTD',
      forwardPe: '最新收盘价 ÷ NTM一致预期EPS；优先汇总未来四个财季，不足四季时按财年剩余天数滚动加权未来两个财年预期',
      peerMedian: '仅统计已配置竞争对手中可计算的有效值，中位数不包含目标公司',
      revisions: 'EPS修订幅度按构成NTM的各预测期及其NTM权重还原；上调/下调次数仅作一致预期变化证据，不等同于投资建议'
    }
  };
}

export function valuationGroupTickers(db, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  if (!db.prepare('SELECT 1 FROM securities WHERE ticker = ?').get(ticker)) throw new Error('股票不存在');
  return [ticker, ...listPeers(db, ticker).map((peer) => peer.ticker)];
}
