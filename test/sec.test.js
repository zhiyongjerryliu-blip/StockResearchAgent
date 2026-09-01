import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { upsertWatchlistItem } from '../src/repository.js';
import {
  classifySecPeriod,
  getSecOverview,
  normalizeCompanyFacts,
  normalizeSubmissions,
  saveSecCompanyData,
  SecEdgarProvider,
  syncSecWatchlist
} from '../src/sec.js';

const submissions = {
  cik: '0000320193',
  name: 'APPLE INC',
  filings: {
    recent: {
      accessionNumber: ['0000320193-25-000079', '0000320193-25-000088', '0000320193-25-000090'],
      filingDate: ['2025-08-01', '2025-08-08', '2025-08-09'],
      reportDate: ['2025-06-28', '2025-08-08', '2025-08-09'],
      acceptanceDateTime: ['2025-08-01T16:00:00.000Z', '2025-08-08T16:00:00.000Z', '2025-08-09T16:00:00.000Z'],
      form: ['10-Q', '8-K', '4'],
      primaryDocument: ['aapl-20250628.htm', 'aapl-8k.htm', 'ownership.xml'],
      primaryDocDescription: ['Quarterly report', 'Current report', 'Ownership'],
      items: ['', '2.02,9.01', ''],
      isXBRL: [1, 1, 0],
      isInlineXBRL: [1, 1, 0]
    }
  }
};

const companyFacts = {
  cik: 320193,
  entityName: 'Apple Inc.',
  facts: {
    'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: 'Revenue', description: 'Revenue from customers', units: { USD: [
          { start: '2023-10-01', end: '2024-09-28', val: 100, accn: 'annual-1', fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' },
          { start: '2025-03-30', end: '2025-06-28', val: 25, accn: 'quarter-1', fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01' }
        ] }
      },
      GrossProfit: {
        label: 'Gross Profit', units: { USD: [
          { start: '2023-10-01', end: '2024-09-28', val: 45, accn: 'annual-1', fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' }
        ] }
      },
      NetIncomeLoss: {
        label: 'Net Income', units: { USD: [
          { start: '2023-10-01', end: '2024-09-28', val: 20, accn: 'annual-1', fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' },
          { start: '2025-03-30', end: '2025-06-28', val: 6, accn: 'quarter-1', fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01' }
        ] }
      },
      EarningsPerShareDiluted: {
        label: 'Diluted EPS', units: { 'USD/shares': [
          { start: '2025-03-30', end: '2025-06-28', val: 1.57, accn: 'quarter-1', fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01' }
        ] }
      },
      Assets: {
        label: 'Assets', units: { USD: [
          { end: '2024-09-28', val: 300, accn: 'annual-1', fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' },
          { end: '2025-06-28', val: 350, accn: 'quarter-1', fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01' }
        ] }
      },
      CashAndCashEquivalentsAtCarryingValue: {
        label: 'Cash', units: { USD: [
          { end: '2025-06-28', val: 50, accn: 'quarter-1', fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-08-01' }
        ] }
      }
    }
  }
};

test('SEC报告期分类区分时点、季度、年初至今和年度', () => {
  assert.equal(classifySecPeriod(null, '2025-06-28'), 'instant');
  assert.equal(classifySecPeriod('2025-03-30', '2025-06-28'), 'quarter');
  assert.equal(classifySecPeriod('2025-01-01', '2025-06-28'), 'ytd');
  assert.equal(classifySecPeriod('2023-10-01', '2024-09-28'), 'annual');
});

test('SEC submissions只保留受支持的10-K、10-Q和8-K系列', () => {
  const filings = normalizeSubmissions(submissions, 'AAPL', '320193');
  assert.equal(filings.length, 2);
  assert.deepEqual(filings.map((filing) => filing.form), ['10-Q', '8-K']);
  assert.match(filings[0].filingUrl, /aapl-20250628\.htm$/);
});

test('Company Facts标准化核心指标并保留来源', () => {
  const facts = normalizeCompanyFacts(companyFacts, 'AAPL', '320193');
  const revenue = facts.filter((fact) => fact.metricKey === 'revenue');
  assert.equal(revenue.length, 2);
  assert.equal(revenue[0].periodType, 'annual');
  assert.equal(revenue[1].periodType, 'quarter');
  assert.match(revenue[1].sourceUrl, /quarter-1-index\.html$/);
});

test('SEC数据保存幂等且可生成年度、季度和最新指标概览', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAPL' });

  const first = saveSecCompanyData(db, 'AAPL', '320193', submissions, companyFacts);
  const second = saveSecCompanyData(db, 'AAPL', '320193', submissions, companyFacts);
  const overview = getSecOverview(db, 'AAPL');

  assert.equal(first.insertedFacts, first.factsReceived);
  assert.equal(second.insertedFacts, 0);
  assert.equal(overview.company.cik, '0000320193');
  assert.equal(overview.company.name, 'Apple Inc.');
  assert.equal(overview.latest.revenue.value, 25);
  assert.equal(overview.latest.cash.value, 50);
  assert.equal(overview.annual[0].metrics.revenue.value, 100);
  assert.equal(overview.annual[0].metrics.assets.value, 300);
  assert.equal(overview.quarterly[0].metrics.netIncome.value, 6);
  assert.equal(overview.quarterly[0].metrics.assets.value, 350);
  assert.equal(overview.filings.length, 2);
  db.close();
});

test('SEC Provider拒绝没有真实联系邮箱的User-Agent', async () => {
  let requested = false;
  const provider = new SecEdgarProvider({
    userAgent: 'anonymous bot',
    fetchImpl: async () => { requested = true; return { ok: true, json: async () => ({}) }; }
  });
  await assert.rejects(() => provider.fetchJson('https://data.sec.gov/test.json'), /SEC_USER_AGENT/);
  assert.equal(requested, false);
});

test('SEC Provider会有限重试临时网络错误', async () => {
  let attempts = 0;
  const provider = new SecEdgarProvider({
    userAgent: 'Stock Research test@example.com',
    requestsPerSecond: 10,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        const cause = new Error('connection reset');
        cause.code = 'ECONNRESET';
        throw new TypeError('fetch failed', { cause });
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }
  });
  const payload = await provider.fetchJson('https://data.sec.gov/test.json');
  assert.deepEqual(payload, { ok: true });
  assert.equal(attempts, 2);
});

test('股票池SEC同步按股票隔离错误且未配置时安全跳过', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAPL' });
  upsertWatchlistItem(db, { ticker: 'MSFT', enabled: false });
  const provider = {
    assertConfigured() {},
    async fetchCompanyData(ticker) {
      assert.equal(ticker, 'AAPL');
      return { company: { cik: '0000320193' }, submissions, companyFacts };
    }
  };

  const result = await syncSecWatchlist(db, provider);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.results.map((item) => [item.ticker, item.ok]), [['AAPL', true]]);

  const skipped = await syncSecWatchlist(db, {
    assertConfigured() { throw new Error('未配置'); }
  });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'not-configured');
  db.close();
});
