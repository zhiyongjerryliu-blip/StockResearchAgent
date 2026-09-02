import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker, round } from './domain.js';

const ALPHA_VANTAGE_URL = 'https://www.alphavantage.co/query';
const ALPHA_VANTAGE_DOCUMENTATION = 'https://www.alphavantage.co/documentation/#earnings-estimates';
const SUPPORTED_HORIZONS = new Set(['fiscal quarter', 'fiscal year']);

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number == null ? null : Math.max(0, Math.round(number));
}

function validIsoDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}

function daysBetween(start, end) {
  return (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000;
}

function addOneYear(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCFullYear(value.getUTCFullYear() + 1);
  return value.toISOString().slice(0, 10);
}

function etDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeAlphaVantageEstimates(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Alpha Vantage预期数据格式无效');
  const providerError = payload['Error Message'] || payload.Information || payload.Note;
  if (providerError) throw new Error(`Alpha Vantage暂不可用：${String(providerError).slice(0, 180)}`);
  if (!Array.isArray(payload.estimates)) throw new Error('Alpha Vantage未返回预期数据');

  return payload.estimates.map((row) => ({
    periodEnd: validIsoDate(row.date),
    horizon: String(row.horizon || '').toLowerCase(),
    epsAverage: numberOrNull(row.eps_estimate_average),
    epsHigh: numberOrNull(row.eps_estimate_high),
    epsLow: numberOrNull(row.eps_estimate_low),
    analystCount: integerOrNull(row.eps_estimate_analyst_count),
    epsAverage7DaysAgo: numberOrNull(row.eps_estimate_average_7_days_ago),
    epsAverage30DaysAgo: numberOrNull(row.eps_estimate_average_30_days_ago),
    epsAverage60DaysAgo: numberOrNull(row.eps_estimate_average_60_days_ago),
    epsAverage90DaysAgo: numberOrNull(row.eps_estimate_average_90_days_ago),
    revisionUp7Days: integerOrNull(row.eps_estimate_revision_up_trailing_7_days),
    revisionDown7Days: integerOrNull(row.eps_estimate_revision_down_trailing_7_days),
    revisionUp30Days: integerOrNull(row.eps_estimate_revision_up_trailing_30_days),
    revisionDown30Days: integerOrNull(row.eps_estimate_revision_down_trailing_30_days)
  })).filter((row) => (
    row.periodEnd && SUPPORTED_HORIZONS.has(row.horizon) && row.epsAverage != null
  ));
}

function continuousQuarters(rows) {
  if (rows.length < 4) return false;
  for (let index = 1; index < 4; index += 1) {
    const gap = daysBetween(rows[index - 1].periodEnd, rows[index].periodEnd);
    if (gap < 60 || gap > 130) return false;
  }
  return true;
}

function weightedValue(components, field) {
  if (components.some((component) => component.row[field] == null)) return null;
  return components.reduce((sum, component) => sum + component.row[field] * component.weight, 0);
}

function coverageQuality(components) {
  const counts = components.map((component) => component.row.analystCount).filter(Number.isFinite);
  const analystCount = counts.length ? Math.min(...counts) : null;
  return {
    analystCount,
    qualityStatus: analystCount != null && analystCount < 3 ? 'limited_coverage' : 'complete'
  };
}

export function calculateNtmConsensus(rows, asOfValue) {
  const asOf = validIsoDate(asOfValue);
  if (!asOf) throw new Error('NTM估值基准日无效');
  const future = rows.filter((row) => row.periodEnd > asOf);
  const quarters = future
    .filter((row) => row.horizon === 'fiscal quarter')
    .sort((left, right) => left.periodEnd.localeCompare(right.periodEnd));

  if (continuousQuarters(quarters)) {
    const components = quarters.slice(0, 4).map((row) => ({ row, weight: 1 }));
    const coverage = coverageQuality(components);
    return {
      value: components.reduce((sum, component) => sum + component.row.epsAverage, 0),
      high: components.every((component) => component.row.epsHigh != null)
        ? components.reduce((sum, component) => sum + component.row.epsHigh, 0) : null,
      low: components.every((component) => component.row.epsLow != null)
        ? components.reduce((sum, component) => sum + component.row.epsLow, 0) : null,
      periodEnd: components[3].row.periodEnd,
      method: 'FOUR_QUARTER_CONSENSUS',
      methodLabel: '未来四个财季一致预期EPS之和',
      components,
      ...coverage
    };
  }

  const annual = future
    .filter((row) => row.horizon === 'fiscal year')
    .sort((left, right) => left.periodEnd.localeCompare(right.periodEnd));
  if (annual.length >= 2) {
    const first = annual[0];
    const second = annual[1];
    const yearSpan = daysBetween(first.periodEnd, second.periodEnd);
    const daysToFirstYearEnd = daysBetween(asOf, first.periodEnd);
    if (yearSpan >= 300 && yearSpan <= 430 && daysToFirstYearEnd >= 0 && daysToFirstYearEnd <= 430) {
      const firstWeight = Math.min(1, Math.max(0, daysToFirstYearEnd / yearSpan));
      const components = [
        { row: first, weight: firstWeight },
        { row: second, weight: 1 - firstWeight }
      ];
      const coverage = coverageQuality(components);
      return {
        value: weightedValue(components, 'epsAverage'),
        high: weightedValue(components, 'epsHigh'),
        low: weightedValue(components, 'epsLow'),
        periodEnd: addOneYear(asOf),
        method: 'FISCAL_YEAR_BLEND',
        methodLabel: `按距${first.periodEnd}财年末的天数滚动加权未来两个财年一致预期`,
        components,
        ...coverage
      };
    }
  }

  if (annual.length >= 1) {
    const first = annual[0];
    const daysToFirstYearEnd = daysBetween(asOf, first.periodEnd);
    if (daysToFirstYearEnd >= 330 && daysToFirstYearEnd <= 400) {
      const components = [{ row: first, weight: 1 }];
      const coverage = coverageQuality(components);
      return {
        value: first.epsAverage,
        high: first.epsHigh,
        low: first.epsLow,
        periodEnd: addOneYear(asOf),
        method: 'NEXT_FISCAL_YEAR_PROXY',
        methodLabel: `下一财年末距基准日${Math.round(daysToFirstYearEnd)}天，以完整下一财年一致预期近似NTM`,
        components,
        analystCount: coverage.analystCount,
        qualityStatus: 'proxy'
      };
    }
  }

  throw new Error(`未来季度预期仅${quarters.length}期，且缺少可滚动加权的两个未来财年预期`);
}

export class AlphaVantageEarningsProvider {
  constructor({ apiKey = '', fetchImpl = fetch } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
    this.name = 'alpha_vantage';
  }

  assertConfigured() {
    if (!this.apiKey) throw new Error('请先在.env中配置ALPHA_VANTAGE_API_KEY');
  }

  async fetchEstimates(tickerValue) {
    this.assertConfigured();
    const ticker = normalizeTicker(tickerValue);
    const url = new URL(ALPHA_VANTAGE_URL);
    url.searchParams.set('function', 'EARNINGS_ESTIMATES');
    url.searchParams.set('symbol', ticker);
    url.searchParams.set('apikey', this.apiKey);
    let response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      const code = error?.cause?.code || error?.code;
      throw new Error(`Alpha Vantage网络请求失败${code ? `（${code}）` : ''}`);
    }
    if (!response.ok) throw new Error(`Alpha Vantage请求失败：HTTP ${response.status}`);
    const payload = await response.json();
    return { ticker, rows: normalizeAlphaVantageEstimates(payload) };
  }
}

function saveAutomaticEstimate(db, ticker, asOf, fetchedAt, rows, ntm) {
  const existing = toPlain(db.prepare(`
    SELECT id FROM earnings_estimates
    WHERE ticker = ? AND estimate_type = 'NTM_EPS' AND as_of = ? AND provider = 'alpha_vantage'
  `).get(ticker, asOf));
  let estimateId = existing?.id || null;
  const note = ntm.methodLabel;

  db.exec('BEGIN');
  try {
    if (estimateId) {
      db.prepare(`
        UPDATE earnings_estimates
        SET period_end = ?, eps_value = ?, eps_high = ?, eps_low = ?, analyst_count = ?,
            source = 'Alpha Vantage分析师一致预期', source_url = ?,
            calculation_method = ?, estimate_basis = 'provider_consensus_adjusted',
            quality_status = ?, note = ?, fetched_at = ?, created_at = ?
        WHERE id = ?
      `).run(
        ntm.periodEnd, ntm.value, ntm.high, ntm.low, ntm.analystCount,
        ALPHA_VANTAGE_DOCUMENTATION, ntm.method, ntm.qualityStatus,
        note, fetchedAt, fetchedAt, estimateId
      );
      db.prepare('DELETE FROM earnings_estimate_periods WHERE estimate_id = ?').run(estimateId);
    } else {
      const result = db.prepare(`
        INSERT INTO earnings_estimates (
          ticker, estimate_type, as_of, period_end, eps_value, eps_high, eps_low,
          analyst_count, source, source_url, provider, calculation_method,
          estimate_basis, quality_status, note, fetched_at, created_at
        ) VALUES (?, 'NTM_EPS', ?, ?, ?, ?, ?, ?, 'Alpha Vantage分析师一致预期', ?,
                  'alpha_vantage', ?, 'provider_consensus_adjusted', ?, ?, ?, ?)
      `).run(
        ticker, asOf, ntm.periodEnd, ntm.value, ntm.high, ntm.low, ntm.analystCount,
        ALPHA_VANTAGE_DOCUMENTATION, ntm.method, ntm.qualityStatus, note, fetchedAt, fetchedAt
      );
      estimateId = Number(result.lastInsertRowid);
    }

    const included = new Map(ntm.components.map((component) => [
      `${component.row.horizon}:${component.row.periodEnd}`, component.weight
    ]));
    const statement = db.prepare(`
      INSERT INTO earnings_estimate_periods (
        estimate_id, period_end, horizon, eps_average, eps_high, eps_low, analyst_count,
        eps_average_7_days_ago, eps_average_30_days_ago, eps_average_60_days_ago,
        eps_average_90_days_ago, revision_up_7_days, revision_down_7_days,
        revision_up_30_days, revision_down_30_days, ntm_weight, included_in_ntm
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.filter((item) => item.periodEnd > asOf)) {
      const weight = included.get(`${row.horizon}:${row.periodEnd}`) ?? 0;
      statement.run(
        estimateId, row.periodEnd, row.horizon, row.epsAverage, row.epsHigh, row.epsLow,
        row.analystCount, row.epsAverage7DaysAgo, row.epsAverage30DaysAgo,
        row.epsAverage60DaysAgo, row.epsAverage90DaysAgo, row.revisionUp7Days,
        row.revisionDown7Days, row.revisionUp30Days, row.revisionDown30Days,
        weight, weight > 0 ? 1 : 0
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return toPlain(db.prepare('SELECT * FROM earnings_estimates WHERE id = ?').get(estimateId));
}

export async function syncEarningsEstimate(db, provider, tickerValue, asOf = etDate()) {
  const ticker = normalizeTicker(tickerValue);
  if (!db.prepare('SELECT 1 FROM securities WHERE ticker = ?').get(ticker)) throw new Error('股票不存在');
  const cached = toPlain(db.prepare(`
    SELECT id, eps_value, calculation_method, analyst_count, quality_status
    FROM earnings_estimates
    WHERE ticker = ? AND estimate_type = 'NTM_EPS' AND as_of = ? AND provider = 'alpha_vantage'
  `).get(ticker, asOf));
  if (cached) {
    return {
      ticker, ok: true, cached: true, estimateId: cached.id, asOf,
      ntmEps: round(cached.eps_value, 4), method: cached.calculation_method,
      analystCount: cached.analyst_count, qualityStatus: cached.quality_status
    };
  }
  const fetchedAt = nowIso();
  const payload = await provider.fetchEstimates(ticker);
  const ntm = calculateNtmConsensus(payload.rows, asOf);
  const estimate = saveAutomaticEstimate(db, ticker, asOf, fetchedAt, payload.rows, ntm);
  return {
    ticker, ok: true, estimateId: estimate.id, asOf,
    ntmEps: round(ntm.value, 4), method: ntm.method,
    analystCount: ntm.analystCount, qualityStatus: ntm.qualityStatus
  };
}

export async function syncWatchlistEarningsEstimates(db, provider, asOf = etDate()) {
  if (!provider) return { skipped: true, reason: 'provider-unavailable', results: [] };
  try {
    provider.assertConfigured();
  } catch (error) {
    return { skipped: true, reason: 'not-configured', error: error.message, results: [] };
  }
  const stocks = toPlainRows(db.prepare(`
    SELECT ticker FROM watchlist_items WHERE enabled = 1
    UNION
    SELECT r.related_ticker AS ticker
    FROM company_relationships r
    JOIN watchlist_items w ON w.ticker = r.ticker AND w.enabled = 1
    WHERE r.relationship_type = 'COMPETITOR' AND r.active_to IS NULL
    ORDER BY ticker
  `).all());
  const results = [];
  for (const { ticker } of stocks) {
    try {
      results.push(await syncEarningsEstimate(db, provider, ticker, asOf));
    } catch (error) {
      results.push({ ticker, ok: false, error: error.message });
    }
  }
  return { skipped: false, asOf, results };
}
