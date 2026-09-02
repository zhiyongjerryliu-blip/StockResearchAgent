import { toPlain, toPlainRows } from './db.js';
import { normalizeTicker, parseJson, round } from './domain.js';
import { listStockConcepts } from './concepts.js';
import { getMarketContext } from './market-context.js';

const FACT_LABELS = {
  shareRepurchases: '普通股回购现金支出',
  capitalExpenditure: '资本开支'
};

function factPriority(periodType) {
  return { quarter: 0, ytd: 1, annual: 2, other: 3 }[periodType] ?? 4;
}

function corporateFactSeries(db, ticker, metricKey, asOf = null) {
  const rows = toPlainRows(db.prepare(`
    SELECT metric_key, tag, unit, period_start, period_end, period_type,
           fiscal_year, fiscal_period, form, filed_at, value, source_url
    FROM financial_facts
    WHERE ticker = ? AND metric_key = ? ${asOf ? 'AND filed_at <= ?' : ''}
    ORDER BY period_end DESC, filed_at DESC, tag_priority ASC
  `).all(...(asOf ? [ticker, metricKey, asOf] : [ticker, metricKey])));
  const deduped = [];
  const periods = new Set();
  for (const row of rows) {
    const key = `${row.period_start || ''}:${row.period_end}:${row.period_type}`;
    if (periods.has(key)) continue;
    periods.add(key);
    deduped.push(row);
  }
  deduped.sort((left, right) => {
    const dateOrder = right.period_end.localeCompare(left.period_end);
    return dateOrder || factPriority(left.period_type) - factPriority(right.period_type);
  });
  const latest = deduped[0] || null;
  const previous = latest
    ? deduped.find((row) => (
      row.period_type === latest.period_type
      && row.period_end < latest.period_end
      && (latest.fiscal_period !== 'FY' || row.fiscal_period === 'FY')
    )) || null
    : null;
  if (!latest) return { metricKey, label: FACT_LABELS[metricKey], available: false };
  return {
    metricKey, label: FACT_LABELS[metricKey], available: true,
    value: latest.value, unit: latest.unit, periodStart: latest.period_start,
    periodEnd: latest.period_end, periodType: latest.period_type,
    fiscalYear: latest.fiscal_year, fiscalPeriod: latest.fiscal_period,
    form: latest.form, filedAt: latest.filed_at, sourceUrl: latest.source_url,
    previousComparable: previous ? {
      value: previous.value, periodStart: previous.period_start, periodEnd: previous.period_end,
      periodType: previous.period_type, fiscalYear: previous.fiscal_year,
      fiscalPeriod: previous.fiscal_period, filedAt: previous.filed_at,
      changePct: previous.value ? round((latest.value - previous.value) / Math.abs(previous.value), 6) : null
    } : null
  };
}

export function getCorporateActionFacts(db, tickerValue, asOf = null) {
  const ticker = normalizeTicker(tickerValue);
  return {
    ticker,
    shareRepurchases: corporateFactSeries(db, ticker, 'shareRepurchases', asOf),
    capitalExpenditure: corporateFactSeries(db, ticker, 'capitalExpenditure', asOf),
    limitations: [
      '回购金额是SEC XBRL披露的现金支出口径，不等同于仍可用的董事会授权额度。',
      '资本开支只是投资活动代理，不能单独证明新增产能；必须结合公司公告、10-Q/10-K和项目进度核实。',
      '只有相同期间类型的数据才计算可比变化，季度、年初至今和年度数据不得直接混比。'
    ]
  };
}

function recentDriverEvents(db, ticker, asOf, days = 30) {
  return toPlainRows(db.prepare(`
    SELECT id, event_date, event_type, title, summary, severity, source_type,
           source_url, evidence_json, status
    FROM research_events
    WHERE ticker = ? AND source_type IN ('NEWS_IMPACT', 'NEWS_RISK')
      AND event_date BETWEEN date(?, ?) AND date(?)
    ORDER BY event_date DESC, id DESC LIMIT 50
  `).all(ticker, asOf, `-${days - 1} days`, asOf)).map((event) => ({
    ...event,
    evidence: parseJson(event.evidence_json, [])
  }));
}

export function getExternalDriversOverview(db, tickerValue, asOf = null) {
  const ticker = normalizeTicker(tickerValue);
  const company = toPlain(db.prepare(`
    SELECT ticker, name, sector, industry, sic_description FROM securities WHERE ticker = ?
  `).get(ticker));
  if (!company) throw new Error('股票不存在');
  const effectiveAsOf = asOf || new Date().toISOString().slice(0, 10);
  return {
    company,
    asOf: effectiveAsOf,
    concepts: listStockConcepts(db, ticker),
    corporateActions: getCorporateActionFacts(db, ticker, effectiveAsOf),
    macro: getMarketContext(db, effectiveAsOf),
    events: recentDriverEvents(db, ticker, effectiveAsOf),
    relationshipPolicy: {
      verified: '仅当公开文件明确披露关系时标为“已核实关系”。',
      proxy: '行业龙头、需求方或产业链公司默认仅作代理观察，不得表述为公司的已确认客户或供应商。'
    }
  };
}
