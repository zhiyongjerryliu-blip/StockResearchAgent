import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  AlphaVantageEarningsProvider,
  calculateNtmConsensus,
  normalizeAlphaVantageEstimates,
  syncEarningsEstimate
} from '../src/earnings-estimates.js';
import { saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import { getValuationOverview } from '../src/valuation.js';

function providerRow(date, horizon, average, analystCount = 10, extra = {}) {
  return {
    date,
    horizon,
    eps_estimate_average: String(average),
    eps_estimate_high: String(average + 0.2),
    eps_estimate_low: String(average - 0.2),
    eps_estimate_analyst_count: String(analystCount),
    eps_estimate_average_7_days_ago: String(average - 0.05),
    eps_estimate_average_30_days_ago: String(average - 0.1),
    eps_estimate_revision_up_trailing_7_days: '2',
    eps_estimate_revision_down_trailing_7_days: '0',
    ...extra
  };
}

test('Alpha Vantage预期字段标准化并保留分析师覆盖与修订', () => {
  const rows = normalizeAlphaVantageEstimates({
    symbol: 'AAA',
    estimates: [providerRow('2026-12-31', 'fiscal quarter', 2.5, 12)]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].epsAverage, 2.5);
  assert.equal(rows[0].analystCount, 12);
  assert.equal(rows[0].revisionUp7Days, 2);
});

test('存在四个未来连续财季时直接求和生成NTM EPS', () => {
  const rows = normalizeAlphaVantageEstimates({ estimates: [
    providerRow('2026-12-31', 'fiscal quarter', 1),
    providerRow('2027-03-31', 'fiscal quarter', 2),
    providerRow('2027-06-30', 'fiscal quarter', 3),
    providerRow('2027-09-30', 'fiscal quarter', 4)
  ] });
  const ntm = calculateNtmConsensus(rows, '2026-09-30');
  assert.equal(ntm.value, 10);
  assert.equal(ntm.method, 'FOUR_QUARTER_CONSENSUS');
  assert.deepEqual(ntm.components.map((component) => component.weight), [1, 1, 1, 1]);
});

test('季度不足四期时按剩余天数滚动加权未来两个财年', () => {
  const rows = normalizeAlphaVantageEstimates({ estimates: [
    providerRow('2027-12-31', 'fiscal year', 12),
    providerRow('2028-12-31', 'fiscal year', 24)
  ] });
  const ntm = calculateNtmConsensus(rows, '2027-06-30');
  const firstWeight = 184 / 366;
  assert.equal(ntm.method, 'FISCAL_YEAR_BLEND');
  assert.ok(Math.abs(ntm.value - (12 * firstWeight + 24 * (1 - firstWeight))) < 1e-10);
  assert.equal(ntm.periodEnd, '2028-06-30');
});

test('下一财年几乎覆盖完整十二个月时允许以FY1近似NTM并明确降级', () => {
  const rows = normalizeAlphaVantageEstimates({ estimates: [
    providerRow('2027-08-31', 'fiscal year', 30, 15),
    providerRow('2026-11-30', 'fiscal quarter', 7, 14)
  ] });
  const ntm = calculateNtmConsensus(rows, '2026-09-02');
  assert.equal(ntm.value, 30);
  assert.equal(ntm.method, 'NEXT_FISCAL_YEAR_PROXY');
  assert.equal(ntm.qualityStatus, 'proxy');
  assert.match(ntm.methodLabel, /近似NTM/);
});

test('自动预期同步同日幂等并可计算动态PE', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAA' });
  saveManualPrice(db, { ticker: 'AAA', tradeDate: '2026-09-30', close: 100 });
  const payload = { symbol: 'AAA', estimates: [
    providerRow('2026-12-31', 'fiscal quarter', 1, 8),
    providerRow('2027-03-31', 'fiscal quarter', 1, 7),
    providerRow('2027-06-30', 'fiscal quarter', 1, 9),
    providerRow('2027-09-30', 'fiscal quarter', 2, 6)
  ] };
  let fetchCount = 0;
  const provider = new AlphaVantageEarningsProvider({
    apiKey: 'test-key',
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, json: async () => payload };
    }
  });

  await syncEarningsEstimate(db, provider, 'AAA', '2026-09-30');
  await syncEarningsEstimate(db, provider, 'AAA', '2026-09-30');
  const overview = getValuationOverview(db, 'AAA');
  assert.equal(overview.target.forwardEps, 5);
  assert.equal(overview.target.forwardPe, 20);
  assert.equal(overview.target.estimate.provider, 'alpha_vantage');
  assert.equal(overview.target.estimate.analystCount, 6);
  assert.equal(overview.target.estimate.periods.filter((period) => period.included_in_ntm).length, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM earnings_estimates WHERE provider = 'alpha_vantage'").get().count, 1);
  assert.equal(fetchCount, 1);
  db.close();
});

test('预期覆盖不足时拒绝生成不可靠NTM值', () => {
  const rows = normalizeAlphaVantageEstimates({ estimates: [
    providerRow('2026-12-31', 'fiscal quarter', 1),
    providerRow('2027-03-31', 'fiscal quarter', 2)
  ] });
  assert.throws(
    () => calculateNtmConsensus(rows, '2026-09-30'),
    /未来季度预期仅2期/
  );
});
