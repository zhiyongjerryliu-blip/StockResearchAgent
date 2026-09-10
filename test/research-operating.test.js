import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperatingAnalysis, calculateVolumePriceBridge } from '../src/research-operating.js';

function metric(value, unit = 'USD', end = '2026-06-30') {
  return {
    value, unit, periodStart: '2026-04-01', periodEnd: end, filedAt: '2026-08-01',
    form: '10-Q', accessionNumber: 'sample', sourceUrl: 'https://www.sec.gov/sample'
  };
}

function period(end, fiscalPeriod, values) {
  return {
    periodEnd: end,
    fiscalYear: Number(end.slice(0, 4)),
    fiscalPeriod,
    filedAt: end,
    form: '10-Q',
    metrics: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, metric(value, key === 'dilutedShares' ? 'shares' : 'USD', end)]))
  };
}

test('量价桥接使用乘法交叉项，销量加40%且ASP降20%得到收入加12%', () => {
  const result = calculateVolumePriceBridge(0.4, -0.2);
  assert.equal(result.combinedRevenueChange, 0.12);
});

test('经营分析分开季度环比与同比并计算利润率、自由现金流和股数变化', () => {
  const sec = {
    company: { sector: 'Technology', industry: 'Semiconductors' },
    annual: [],
    quarterly: [
      period('2026-06-30', 'Q2', {
        revenue: 140, grossProfit: 56, operatingIncome: 28, netIncome: 21,
        operatingCashFlow: 30, capitalExpenditure: 8, dilutedShares: 10
      }),
      period('2026-03-31', 'Q1', {
        revenue: 120, grossProfit: 42, operatingIncome: 20, netIncome: 15,
        operatingCashFlow: 18, capitalExpenditure: 7, dilutedShares: 10.2
      }),
      period('2025-06-30', 'Q2', {
        revenue: 100, grossProfit: 30, operatingIncome: 10, netIncome: 8,
        operatingCashFlow: 11, capitalExpenditure: 5, dilutedShares: 11
      })
    ]
  };
  const result = buildOperatingAnalysis(sec, { target: { forwardEps: 3, estimate: null }, peerMedian: {} });
  assert.equal(result.template.key, 'SEMICONDUCTOR_CYCLE');
  assert.equal(result.latest.metrics.revenue.sequentialChange.percent, 0.166667);
  assert.equal(result.latest.metrics.revenue.yearOverYearChange.percent, 0.4);
  assert.equal(result.latest.metrics.dilutedShares.yearOverYearChange.percent, -0.090909);
  assert.equal(result.latest.calculated.grossMargin, 0.4);
  assert.equal(result.latest.calculated.freeCashFlow, 22);
  assert.equal(result.latest.calculated.operatingCashConversion, 1.428571);
  assert.equal(result.segmentCoverage.status, 'UNAVAILABLE');
});

test('缺少财报前一致预期时明确未知，不使用最新预期伪造超预期', () => {
  const result = buildOperatingAnalysis({ company: {}, annual: [], quarterly: [] }, { target: {} });
  assert.equal(result.expectations.actualVsConsensus.status, 'UNAVAILABLE');
  assert.match(result.expectations.actualVsConsensus.reason, /不能事后/);
  assert.equal(result.status, 'UNAVAILABLE');
});
