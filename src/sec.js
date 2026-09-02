import { createHash } from 'node:crypto';
import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker } from './domain.js';
import { configureAutomaticPeers } from './peer-selection.js';
import { syncSecFilingEvents } from './events.js';

const SEC_BASE = 'https://www.sec.gov';
const SEC_DATA_BASE = 'https://data.sec.gov';
const ALLOWED_FILING_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A']);
const ALLOWED_FACT_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A']);

export const secMetricDefinitions = [
  {
    key: 'revenue', label: '营业收入', unit: 'USD', balance: false,
    tags: [
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet'
    ]
  },
  { key: 'grossProfit', label: '毛利润', unit: 'USD', balance: false, tags: ['GrossProfit'] },
  { key: 'operatingIncome', label: '营业利润', unit: 'USD', balance: false, tags: ['OperatingIncomeLoss'] },
  { key: 'netIncome', label: '净利润', unit: 'USD', balance: false, tags: ['NetIncomeLoss', 'ProfitLoss'] },
  { key: 'epsDiluted', label: '摊薄每股收益', unit: 'USD/shares', balance: false, tags: ['EarningsPerShareDiluted'] },
  {
    key: 'operatingCashFlow', label: '经营现金流', unit: 'USD', balance: false,
    tags: ['NetCashProvidedByUsedInOperatingActivities']
  },
  {
    key: 'capitalExpenditure', label: '资本开支', unit: 'USD', balance: false,
    tags: ['PaymentsToAcquirePropertyPlantAndEquipment']
  },
  {
    key: 'shareRepurchases', label: '普通股回购现金支出', unit: 'USD', balance: false,
    tags: ['PaymentsForRepurchaseOfCommonStock']
  },
  { key: 'assets', label: '总资产', unit: 'USD', balance: true, tags: ['Assets'] },
  { key: 'liabilities', label: '总负债', unit: 'USD', balance: true, tags: ['Liabilities'] },
  {
    key: 'equity', label: '股东权益', unit: 'USD', balance: true,
    tags: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']
  },
  {
    key: 'cash', label: '现金及等价物', unit: 'USD', balance: true,
    tags: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents']
  },
  {
    key: 'dilutedShares', label: '摊薄加权股数', unit: 'shares', balance: false,
    tags: ['WeightedAverageNumberOfDilutedSharesOutstanding']
  }
];

function normalizeCik(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits || digits.length > 10) throw new Error('SEC CIK格式无效');
  return digits.padStart(10, '0');
}

function filingIndexUrl(cik, accessionNumber) {
  if (!accessionNumber) return null;
  const accessionPath = accessionNumber.replaceAll('-', '');
  return `${SEC_BASE}/Archives/edgar/data/${Number(cik)}/${accessionPath}/${accessionNumber}-index.html`;
}

function filingDocumentUrl(cik, accessionNumber, primaryDocument) {
  if (!accessionNumber) return null;
  const accessionPath = accessionNumber.replaceAll('-', '');
  if (!primaryDocument) return filingIndexUrl(cik, accessionNumber);
  return `${SEC_BASE}/Archives/edgar/data/${Number(cik)}/${accessionPath}/${encodeURIComponent(primaryDocument)}`;
}

function durationDays(start, end) {
  if (!start || !end) return null;
  const milliseconds = new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`);
  return Number.isFinite(milliseconds) ? Math.round(milliseconds / 86_400_000) : null;
}

export function classifySecPeriod(start, end) {
  if (!start) return 'instant';
  const days = durationDays(start, end);
  if (days == null) return 'other';
  if (days >= 300) return 'annual';
  if (days >= 70 && days <= 120) return 'quarter';
  if (days > 120 && days < 300) return 'ytd';
  return 'other';
}

function sourceKey(fact) {
  return createHash('sha256').update(JSON.stringify([
    fact.ticker, fact.taxonomy, fact.tag, fact.unit, fact.periodStart, fact.periodEnd,
    fact.fiscalYear, fact.fiscalPeriod, fact.form, fact.filedAt,
    fact.accessionNumber, fact.frame, fact.value
  ])).digest('hex');
}

export function normalizeCompanyFacts(payload, tickerValue, cikValue) {
  const ticker = normalizeTicker(tickerValue);
  const cik = normalizeCik(cikValue || payload?.cik);
  const taxonomy = 'us-gaap';
  const concepts = payload?.facts?.[taxonomy] || {};
  const normalized = [];

  for (const metric of secMetricDefinitions) {
    metric.tags.forEach((tag, priority) => {
      const concept = concepts[tag];
      const values = concept?.units?.[metric.unit] || [];
      for (const fact of values) {
        if (!ALLOWED_FACT_FORMS.has(fact.form) || !Number.isFinite(Number(fact.val)) || !fact.end || !fact.filed) continue;
        const normalizedFact = {
          ticker,
          cik,
          metricKey: metric.key,
          tagPriority: priority,
          taxonomy,
          tag,
          label: concept.label || metric.label,
          description: concept.description || null,
          unit: metric.unit,
          periodStart: fact.start || null,
          periodEnd: fact.end,
          periodType: classifySecPeriod(fact.start, fact.end),
          fiscalYear: Number.isInteger(fact.fy) ? fact.fy : Number.parseInt(fact.fy, 10) || null,
          fiscalPeriod: fact.fp || null,
          form: fact.form,
          filedAt: fact.filed,
          accessionNumber: fact.accn || null,
          frame: fact.frame || null,
          value: Number(fact.val),
          sourceUrl: filingIndexUrl(cik, fact.accn)
        };
        normalizedFact.sourceKey = sourceKey(normalizedFact);
        normalized.push(normalizedFact);
      }
    });
  }
  return normalized;
}

export function normalizeSubmissions(payload, tickerValue, cikValue) {
  const ticker = normalizeTicker(tickerValue);
  const cik = normalizeCik(cikValue || payload?.cik);
  const recent = payload?.filings?.recent || {};
  const accessionNumbers = recent.accessionNumber || [];
  const filings = [];

  for (let index = 0; index < accessionNumbers.length; index += 1) {
    const form = recent.form?.[index];
    const accessionNumber = accessionNumbers[index];
    const filedAt = recent.filingDate?.[index] || null;
    if (!ALLOWED_FILING_FORMS.has(form) || !accessionNumber || !filedAt) continue;
    const primaryDocument = recent.primaryDocument?.[index] || null;
    filings.push({
      accessionNumber,
      ticker,
      cik,
      form,
      filedAt,
      reportDate: recent.reportDate?.[index] || null,
      acceptedAt: recent.acceptanceDateTime?.[index] || null,
      primaryDocument,
      primaryDocDescription: recent.primaryDocDescription?.[index] || null,
      items: recent.items?.[index] || null,
      filingUrl: filingDocumentUrl(cik, accessionNumber, primaryDocument),
      isXbrl: Boolean(recent.isXBRL?.[index]),
      isInlineXbrl: Boolean(recent.isInlineXBRL?.[index])
    });
  }
  return filings;
}

export class SecEdgarProvider {
  constructor({ userAgent = '', requestsPerSecond = 5, fetchImpl = fetch } = {}) {
    this.userAgent = String(userAgent).trim();
    this.requestsPerSecond = Math.min(10, Math.max(1, Number(requestsPerSecond) || 5));
    this.fetchImpl = fetchImpl;
    this.nextRequestAt = 0;
    this.tickerMap = null;
  }

  assertConfigured() {
    if (!this.userAgent || !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(this.userAgent)) {
      throw new Error('请先在.env中配置包含真实联系邮箱的SEC_USER_AGENT');
    }
  }

  async waitForRateLimit() {
    const wait = this.nextRequestAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.nextRequestAt = Date.now() + Math.ceil(1000 / this.requestsPerSecond);
  }

  async fetchJson(url) {
    this.assertConfigured();
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.waitForRateLimit();
      try {
        const response = await this.fetchImpl(url, {
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate'
          },
          signal: AbortSignal.timeout(20_000)
        });
        if (response.ok) return await response.json();
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) throw new Error(`SEC请求失败：HTTP ${response.status}`);
        lastError = new Error(`SEC暂时不可用：HTTP ${response.status}`);
      } catch (error) {
        if (/SEC请求失败：HTTP 4\d\d/.test(error.message)) throw error;
        const code = error.cause?.code || error.code;
        lastError = new Error(`SEC网络请求失败${code ? `（${code}）` : ''}：${error.message}`, { cause: error });
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
    throw lastError || new Error('SEC请求失败');
  }

  async resolveCompany(tickerValue, knownCik = null) {
    const ticker = normalizeTicker(tickerValue);
    if (knownCik) return { ticker, cik: normalizeCik(knownCik), title: null };
    if (!this.tickerMap) this.tickerMap = await this.fetchJson(`${SEC_BASE}/files/company_tickers.json`);
    const aliases = new Set([ticker, ticker.replaceAll('.', '-'), ticker.replaceAll('-', '.')]);
    const match = Object.values(this.tickerMap).find((entry) => aliases.has(String(entry.ticker || '').toUpperCase()));
    if (!match) throw new Error(`SEC未找到股票代码${ticker}对应的CIK`);
    return { ticker, cik: normalizeCik(match.cik_str), title: match.title || null };
  }

  async fetchCompanyData(tickerValue, knownCik = null) {
    const company = await this.resolveCompany(tickerValue, knownCik);
    const submissions = await this.fetchJson(`${SEC_DATA_BASE}/submissions/CIK${company.cik}.json`);
    const companyFacts = await this.fetchJson(`${SEC_DATA_BASE}/api/xbrl/companyfacts/CIK${company.cik}.json`);
    return { company, submissions, companyFacts };
  }
}

export function saveSecCompanyData(db, tickerValue, cikValue, submissions, companyFacts) {
  const ticker = normalizeTicker(tickerValue);
  const cik = normalizeCik(cikValue);
  const filings = normalizeSubmissions(submissions, ticker, cik);
  const facts = normalizeCompanyFacts(companyFacts, ticker, cik);
  const entityName = companyFacts?.entityName || submissions?.name || null;
  const sic = submissions?.sic ? String(submissions.sic) : null;
  const sicDescription = submissions?.sicDescription || null;
  const ingestedAt = nowIso();
  const existingFilings = new Set(toPlainRows(db.prepare(
    'SELECT accession_number FROM sec_filings WHERE ticker = ?'
  ).all(ticker)).map((filing) => filing.accession_number));
  const initialFilingSync = existingFilings.size === 0;
  const newFilingAccessions = [];

  const filingStatement = db.prepare(`
    INSERT INTO sec_filings (
      accession_number, ticker, cik, form, filed_at, report_date, accepted_at,
      primary_document, primary_doc_description, items, filing_url,
      is_xbrl, is_inline_xbrl, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(accession_number) DO UPDATE SET
      form = excluded.form, filed_at = excluded.filed_at, report_date = excluded.report_date,
      accepted_at = excluded.accepted_at, primary_document = excluded.primary_document,
      primary_doc_description = excluded.primary_doc_description, items = excluded.items,
      filing_url = excluded.filing_url, is_xbrl = excluded.is_xbrl,
      is_inline_xbrl = excluded.is_inline_xbrl, ingested_at = excluded.ingested_at
  `);
  const factStatement = db.prepare(`
    INSERT OR IGNORE INTO financial_facts (
      source_key, ticker, cik, metric_key, tag_priority, taxonomy, tag, label, description,
      unit, period_start, period_end, period_type, fiscal_year, fiscal_period,
      form, filed_at, accession_number, frame, value, source_url, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE securities
      SET cik = ?, name = COALESCE(name, ?), sic = COALESCE(?, sic),
          sic_description = COALESCE(?, sic_description), updated_at = ?
      WHERE ticker = ?
    `).run(cik, entityName, sic, sicDescription, ingestedAt, ticker);
    for (const filing of filings) {
      if (!existingFilings.has(filing.accessionNumber)) newFilingAccessions.push(filing.accessionNumber);
      filingStatement.run(
        filing.accessionNumber, ticker, cik, filing.form, filing.filedAt,
        filing.reportDate, filing.acceptedAt, filing.primaryDocument,
        filing.primaryDocDescription, filing.items, filing.filingUrl,
        filing.isXbrl ? 1 : 0, filing.isInlineXbrl ? 1 : 0, ingestedAt
      );
    }
    let insertedFacts = 0;
    for (const fact of facts) {
      const result = factStatement.run(
        fact.sourceKey, ticker, cik, fact.metricKey, fact.tagPriority,
        fact.taxonomy, fact.tag, fact.label, fact.description, fact.unit,
        fact.periodStart, fact.periodEnd, fact.periodType, fact.fiscalYear,
        fact.fiscalPeriod, fact.form, fact.filedAt, fact.accessionNumber,
        fact.frame, fact.value, fact.sourceUrl, ingestedAt
      );
      insertedFacts += Number(result.changes || 0);
    }
    const filingCount = Number(db.prepare('SELECT COUNT(*) AS count FROM sec_filings WHERE ticker = ?').get(ticker).count);
    const factCount = Number(db.prepare('SELECT COUNT(*) AS count FROM financial_facts WHERE ticker = ?').get(ticker).count);
    db.prepare(`
      INSERT INTO sec_sync_status (
        ticker, cik, entity_name, last_synced_at, filings_count, facts_count, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        cik = excluded.cik, entity_name = excluded.entity_name,
        last_synced_at = excluded.last_synced_at, filings_count = excluded.filings_count,
        facts_count = excluded.facts_count, last_error = NULL, updated_at = excluded.updated_at
    `).run(ticker, cik, entityName, ingestedAt, filingCount, factCount, ingestedAt);
    db.exec('COMMIT');
    return {
      ticker, cik, entityName, sic, sicDescription,
      filingsReceived: filings.length, newFilingAccessions, initialFilingSync,
      factsReceived: facts.length, insertedFacts, filingCount, factCount, syncedAt: ingestedAt
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function recordSecSyncError(db, ticker, error) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO sec_sync_status (ticker, last_error, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at
  `).run(ticker, error.message || String(error), timestamp);
}

export async function syncSecCompany(db, provider, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  const security = toPlain(db.prepare('SELECT ticker, cik FROM securities WHERE ticker = ?').get(ticker));
  if (!security) throw new Error('请先将股票加入股票池');
  try {
    const data = await provider.fetchCompanyData(ticker, security.cik);
    const saved = saveSecCompanyData(db, ticker, data.company.cik, data.submissions, data.companyFacts);
    const events = await syncSecFilingEvents(db, ticker, {
      notifyAccessions: saved.initialFilingSync ? [] : saved.newFilingAccessions
    });
    return { ...saved, events };
  } catch (error) {
    recordSecSyncError(db, ticker, error);
    throw error;
  }
}

export async function syncSecWatchlist(db, provider) {
  if (!provider) return { skipped: true, reason: 'provider-unavailable', results: [] };
  try {
    provider.assertConfigured();
  } catch (error) {
    return { skipped: true, reason: 'not-configured', error: error.message, results: [] };
  }
  const targetTickers = new Set(toPlainRows(db.prepare(`
    SELECT ticker FROM watchlist_items WHERE enabled = 1 ORDER BY ticker
  `).all()).map((stock) => stock.ticker));
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
  const selections = [];
  const queue = stocks.map(({ ticker }) => ticker);
  const processed = new Set();
  while (queue.length) {
    const ticker = queue.shift();
    if (processed.has(ticker)) continue;
    processed.add(ticker);
    try {
      const result = await syncSecCompany(db, provider, ticker);
      results.push({ ticker, ok: true, filingCount: result.filingCount, factCount: result.factCount });
      if (targetTickers.has(ticker)) {
        const selection = configureAutomaticPeers(db, ticker);
        selections.push(selection);
        for (const peer of selection.peers || []) {
          if (!processed.has(peer.ticker)) queue.push(peer.ticker);
        }
      }
    } catch (error) {
      results.push({ ticker, ok: false, error: error.message });
    }
  }
  return { skipped: false, selections, results };
}

function isBetterFact(candidate, current) {
  if (!current) return true;
  if (candidate.filed_at !== current.filed_at) return candidate.filed_at > current.filed_at;
  return candidate.tag_priority < current.tag_priority;
}

function publicFact(fact) {
  if (!fact) return null;
  return {
    metricKey: fact.metric_key,
    value: fact.value,
    unit: fact.unit,
    periodStart: fact.period_start,
    periodEnd: fact.period_end,
    periodType: fact.period_type,
    fiscalYear: fact.fiscal_year,
    fiscalPeriod: fact.fiscal_period,
    form: fact.form,
    filedAt: fact.filed_at,
    accessionNumber: fact.accession_number,
    sourceUrl: fact.source_url,
    label: fact.label
  };
}

function buildPeriods(facts, periodType, limit = 8) {
  const anchorEnds = new Set(
    facts.filter((fact) => fact.period_type === periodType).map((fact) => fact.period_end)
  );
  const balanceMetricKeys = new Set(
    secMetricDefinitions.filter((metric) => metric.balance).map((metric) => metric.key)
  );
  const periods = new Map();
  const periodFacts = facts.filter((fact) => (
    fact.period_type === periodType
    || (fact.period_type === 'instant' && balanceMetricKeys.has(fact.metric_key) && anchorEnds.has(fact.period_end))
  ));
  for (const fact of periodFacts) {
    const key = fact.period_end;
    const period = periods.get(key) || {
      periodEnd: fact.period_end,
      fiscalYear: fact.fiscal_year,
      fiscalPeriod: fact.fiscal_period,
      form: fact.form,
      filedAt: fact.filed_at,
      metrics: {},
      _raw: {}
    };
    if (isBetterFact(fact, period._raw[fact.metric_key])) {
      period._raw[fact.metric_key] = fact;
      period.metrics[fact.metric_key] = publicFact(fact);
    }
    if (fact.filed_at > period.filedAt) {
      period.filedAt = fact.filed_at;
      period.form = fact.form;
      period.fiscalYear = fact.fiscal_year;
      period.fiscalPeriod = fact.fiscal_period;
    }
    periods.set(key, period);
  }
  return [...periods.values()]
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
    .slice(0, limit)
    .map(({ _raw, ...period }) => period);
}

export function getSecOverview(db, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  const company = toPlain(db.prepare(`
    SELECT ticker, name, cik, sic, sic_description, exchange, sector, industry FROM securities WHERE ticker = ?
  `).get(ticker));
  if (!company) throw new Error('股票不存在');
  const status = toPlain(db.prepare('SELECT * FROM sec_sync_status WHERE ticker = ?').get(ticker)) || null;
  const facts = toPlainRows(db.prepare(`
    SELECT * FROM financial_facts
    WHERE ticker = ?
    ORDER BY period_end DESC, filed_at DESC, tag_priority ASC
  `).all(ticker));
  const filings = toPlainRows(db.prepare(`
    SELECT accession_number, form, filed_at, report_date, accepted_at,
           primary_doc_description, items, filing_url, is_xbrl, is_inline_xbrl
    FROM sec_filings WHERE ticker = ?
    ORDER BY filed_at DESC, accepted_at DESC LIMIT 30
  `).all(ticker)).map((filing) => ({
    ...filing,
    is_xbrl: Boolean(filing.is_xbrl),
    is_inline_xbrl: Boolean(filing.is_inline_xbrl)
  }));

  const latest = {};
  for (const metric of secMetricDefinitions) {
    const candidates = facts.filter((fact) => fact.metric_key === metric.key);
    const preferred = metric.balance
      ? candidates.filter((fact) => fact.period_type === 'instant')
      : candidates.filter((fact) => fact.period_type === 'quarter');
    const pool = preferred.length ? preferred : candidates.filter((fact) => fact.period_type === 'annual');
    latest[metric.key] = publicFact(pool[0] || candidates[0] || null);
  }

  return {
    company,
    status,
    metrics: Object.fromEntries(secMetricDefinitions.map((metric) => [metric.key, {
      label: metric.label, unit: metric.unit, balance: metric.balance
    }])),
    latest,
    annual: buildPeriods(facts, 'annual'),
    quarterly: buildPeriods(facts, 'quarter'),
    filings
  };
}
