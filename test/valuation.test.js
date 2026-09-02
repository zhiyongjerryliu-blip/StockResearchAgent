import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import {
  addPeer,
  buildHistoricalStaticPeSeries,
  calculateTtmEps,
  deleteEarningsEstimate,
  getHistoricalValuation,
  getValuationOverview,
  removePeer,
  saveEarningsEstimate
} from '../src/valuation.js';

function insertFact(db, {
  ticker, metricKey, value, periodStart, periodEnd, periodType = 'quarter',
  fiscalPeriod = 'Q4', filedAt = '2026-08-01'
}) {
  const sourceKey = [ticker, metricKey, periodType, fiscalPeriod, periodEnd, value].join(':');
  const unit = metricKey === 'epsDiluted' ? 'USD/shares' : 'USD';
  db.prepare(`
    INSERT INTO financial_facts (
      source_key, ticker, cik, metric_key, tag_priority, taxonomy, tag, label,
      unit, period_start, period_end, period_type, fiscal_year, fiscal_period,
      form, filed_at, value, source_url, ingested_at
    ) VALUES (?, ?, '0000000001', ?, 0, 'us-gaap', ?, ?, ?, ?, ?, ?, 2026, ?,
              ?, ?, ?, 'https://www.sec.gov/test', ?)
  `).run(
    sourceKey, ticker, metricKey, metricKey, metricKey, unit, periodStart, periodEnd,
    periodType, fiscalPeriod, periodType === 'annual' ? '10-K' : '10-Q',
    filedAt, value, '2026-08-02T00:00:00.000Z'
  );
}

function addFourQuarters(db, ticker, values) {
  const periods = [
    ['2025-07-01', '2025-09-30'],
    ['2025-10-01', '2025-12-31'],
    ['2026-01-01', '2026-03-31'],
    ['2026-04-01', '2026-06-30']
  ];
  periods.forEach(([periodStart, periodEnd], index) => insertFact(db, {
    ticker, metricKey: 'epsDiluted', value: values[index], periodStart, periodEnd
  }));
}

test('静态PE使用四个连续季度EPS，动态PE使用最新可追溯预期EPS', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAA', name: 'Target' });
  saveManualPrice(db, { ticker: 'AAA', tradeDate: '2026-08-31', close: 100 });
  addFourQuarters(db, 'AAA', [1, 1, 1, 1]);
  const estimate = saveEarningsEstimate(db, {
    ticker: 'AAA', asOf: '2026-08-31', periodEnd: '2027-08-31', epsValue: 5,
    source: '测试一致预期', sourceUrl: 'https://example.com/estimate'
  });

  const overview = getValuationOverview(db, 'AAA');
  assert.equal(overview.target.ttmEps, 4);
  assert.equal(overview.target.staticPe, 25);
  assert.equal(overview.target.forwardEps, 5);
  assert.equal(overview.target.forwardPe, 20);
  assert.equal(overview.target.estimate.source, '测试一致预期');

  deleteEarningsEstimate(db, estimate.id);
  assert.equal(getValuationOverview(db, 'AAA').target.forwardPe, null);
  db.close();
});

test('同业中位数只统计竞争对手有效值且不包含目标公司', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAA' });
  saveManualPrice(db, { ticker: 'AAA', tradeDate: '2026-08-31', close: 100 });
  addFourQuarters(db, 'AAA', [1, 1, 1, 1]);

  addPeer(db, { ticker: 'AAA', relatedTicker: 'BBB', name: 'Peer B', activeFrom: '2026-08-01' });
  addPeer(db, { ticker: 'AAA', relatedTicker: 'CCC', name: 'Peer C', activeFrom: '2026-08-01' });
  saveManualPrice(db, { ticker: 'BBB', tradeDate: '2026-08-31', close: 60 });
  saveManualPrice(db, { ticker: 'CCC', tradeDate: '2026-08-31', close: 50 });
  addFourQuarters(db, 'BBB', [1, 1, 1, 1]);
  addFourQuarters(db, 'CCC', [-1, -1, -1, -1]);

  const overview = getValuationOverview(db, 'AAA');
  assert.deepEqual(overview.peers.map((peer) => peer.ticker), ['BBB', 'CCC']);
  assert.equal(overview.peers[0].staticPe, 15);
  assert.equal(overview.peers[1].staticPe, null);
  assert.equal(overview.peerMedian.staticPe, 15);
  assert.equal(overview.peerMedian.staticPeSamples, 1);

  removePeer(db, 'AAA', 'BBB');
  assert.deepEqual(getValuationOverview(db, 'AAA').peers.map((peer) => peer.ticker), ['CCC']);
  db.close();
});

test('动态PE相对同业中位数计算溢价折价并保留样本质量', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'AAA' });
  addPeer(db, { ticker: 'AAA', relatedTicker: 'BBB', activeFrom: '2026-08-01' });
  addPeer(db, { ticker: 'AAA', relatedTicker: 'CCC', activeFrom: '2026-08-01' });
  saveManualPrice(db, { ticker: 'AAA', tradeDate: '2026-08-31', close: 100 });
  saveManualPrice(db, { ticker: 'BBB', tradeDate: '2026-08-31', close: 120 });
  saveManualPrice(db, { ticker: 'CCC', tradeDate: '2026-08-31', close: 100 });
  saveEarningsEstimate(db, { ticker: 'AAA', asOf: '2026-08-31', epsValue: 10, source: 'test' });
  saveEarningsEstimate(db, { ticker: 'BBB', asOf: '2026-08-31', epsValue: 8, source: 'test' });
  saveEarningsEstimate(db, { ticker: 'CCC', asOf: '2026-08-31', epsValue: 4, source: 'test' });

  const overview = getValuationOverview(db, 'AAA');
  assert.equal(overview.target.forwardPe, 10);
  assert.equal(overview.peerMedian.forwardPe, 20);
  assert.equal(overview.relativeToPeers.forwardPePremium, -0.5);
  assert.equal(overview.relativeToPeers.forwardPeLabel, '较同业显著折价');
  assert.equal(overview.relativeToPeers.forwardQualityStatus, 'complete');
  assert.equal(overview.relativeToPeers.staticQualityStatus, 'limited_samples');
  db.close();
});

test('自动一致预期按NTM权重还原7日和30日EPS修订', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'REV' });
  const estimateId = Number(db.prepare(`
    INSERT INTO earnings_estimates (
      ticker, estimate_type, as_of, period_end, eps_value, analyst_count, source,
      provider, calculation_method, estimate_basis, quality_status, fetched_at, created_at
    ) VALUES ('REV', 'NTM_EPS', '2026-08-31', '2027-08-31', 6, 10, 'Alpha Vantage',
              'alpha_vantage', 'FISCAL_YEAR_BLEND', 'provider_consensus_adjusted',
              'complete', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  `).run().lastInsertRowid);
  const insertPeriod = db.prepare(`
    INSERT INTO earnings_estimate_periods (
      estimate_id, period_end, horizon, eps_average, analyst_count,
      eps_average_7_days_ago, eps_average_30_days_ago,
      revision_up_7_days, revision_down_7_days,
      revision_up_30_days, revision_down_30_days,
      ntm_weight, included_in_ntm
    ) VALUES (?, ?, 'fiscal year', ?, 10, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  insertPeriod.run(estimateId, '2027-06-30', 5, 4, 3.5, 3, 1, 5, 2, 0.4);
  insertPeriod.run(estimateId, '2028-06-30', 6.666667, 5, 4.5, 2, 2, 4, 3, 0.6);

  const revision = getValuationOverview(db, 'REV').target.estimate.revision;
  assert.equal(revision.sevenDay.previousEps, 4.6);
  assert.equal(revision.sevenDay.change, 1.4);
  assert.equal(revision.sevenDay.changePct, 0.304348);
  assert.equal(revision.sevenDay.revisionsUp, 5);
  assert.equal(revision.sevenDay.revisionsDown, 3);
  assert.equal(revision.thirtyDay.previousEps, 4.1);
  assert.equal(revision.thirtyDay.revisionNet, 4);
  db.close();
});

test('历史PE只使用价格日之前已提交的EPS并达到样本门槛后发布分位', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'PIT' });
  insertFact(db, {
    ticker: 'PIT', metricKey: 'epsDiluted', value: 2,
    periodStart: '2024-01-01', periodEnd: '2024-12-31',
    periodType: 'annual', fiscalPeriod: 'FY', filedAt: '2025-02-01'
  });
  insertFact(db, {
    ticker: 'PIT', metricKey: 'epsDiluted', value: 4,
    periodStart: '2025-01-01', periodEnd: '2025-12-31',
    periodType: 'annual', fiscalPeriod: 'FY', filedAt: '2026-02-01'
  });
  const start = Date.parse('2025-12-01T00:00:00.000Z');
  for (let index = 0; index < 100; index += 1) {
    const tradeDate = new Date(start + (index * 86_400_000)).toISOString().slice(0, 10);
    saveManualPrice(db, { ticker: 'PIT', tradeDate, close: 100 });
  }

  const series = buildHistoricalStaticPeSeries(db, 'PIT', '2025-12-01');
  assert.equal(series.find((sample) => sample.date === '2026-02-01').ttmEps, 2);
  assert.equal(series.find((sample) => sample.date === '2026-02-02').ttmEps, 4);
  assert.equal(series.find((sample) => sample.date === '2026-02-01').pe, 50);
  assert.equal(series.find((sample) => sample.date === '2026-02-02').pe, 25);

  const history = getHistoricalValuation(db, 'PIT', { lookbackYears: 1 });
  assert.equal(history.staticPe.sampleCount, 100);
  assert.equal(history.staticPe.current, 25);
  assert.equal(history.staticPe.qualityStatus, 'limited_history');
  assert.ok(history.staticPe.percentile > 0 && history.staticPe.percentile < 30);
  assert.equal(history.forwardPe.qualityStatus, 'insufficient_samples');
  db.close();
});

test('季度EPS不连续或不足四期时不发布静态PE', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'GAP' });
  saveManualPrice(db, { ticker: 'GAP', tradeDate: '2026-08-31', close: 80 });
  insertFact(db, {
    ticker: 'GAP', metricKey: 'epsDiluted', value: 1,
    periodStart: '2026-04-01', periodEnd: '2026-06-30'
  });
  insertFact(db, {
    ticker: 'GAP', metricKey: 'epsDiluted', value: 1,
    periodStart: '2025-01-01', periodEnd: '2025-03-31'
  });

  const target = getValuationOverview(db, 'GAP').target;
  assert.equal(target.ttmEps, null);
  assert.equal(target.staticPe, null);
  assert.match(target.issues.join(' '), /缺少完整年度EPS/);
  db.close();
});

test('最新财年结束后直接使用年度摊薄EPS计算TTM', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'FY' });
  saveManualPrice(db, { ticker: 'FY', tradeDate: '2026-08-31', close: 1597.22 });
  insertFact(db, {
    ticker: 'FY', metricKey: 'epsDiluted', value: 73.76,
    periodStart: '2025-06-28', periodEnd: '2026-07-03', periodType: 'annual', fiscalPeriod: 'FY'
  });

  const target = getValuationOverview(db, 'FY').target;
  assert.equal(target.ttmEps, 73.76);
  assert.equal(target.ttmMethod, 'LATEST_FY');
  assert.equal(target.staticPe, 21.65);
  db.close();
});

test('财年后的中期报告使用年度EPS加本期YTD减上年同期YTD', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'ROLL' });
  insertFact(db, {
    ticker: 'ROLL', metricKey: 'epsDiluted', value: 10,
    periodStart: '2024-01-01', periodEnd: '2024-12-31', periodType: 'annual', fiscalPeriod: 'FY'
  });
  insertFact(db, {
    ticker: 'ROLL', metricKey: 'epsDiluted', value: 4,
    periodStart: '2024-01-01', periodEnd: '2024-06-30', periodType: 'ytd', fiscalPeriod: 'Q2'
  });
  insertFact(db, {
    ticker: 'ROLL', metricKey: 'epsDiluted', value: 6,
    periodStart: '2025-01-01', periodEnd: '2025-06-30', periodType: 'ytd', fiscalPeriod: 'Q2'
  });

  const ttm = calculateTtmEps(db, 'ROLL');
  assert.equal(ttm.value, 12);
  assert.equal(ttm.method, 'FY_PLUS_YTD_DELTA');
  assert.deepEqual(ttm.periods.map((period) => period.role), ['LATEST_FY', 'CURRENT_YTD', 'PRIOR_YTD']);
  db.close();
});

test('预期EPS必须保留基准日和来源', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'SRC' });
  assert.throws(() => saveEarningsEstimate(db, {
    ticker: 'SRC', asOf: '2026-08-31', epsValue: 2, source: ''
  }), /来源/);
  assert.throws(() => saveEarningsEstimate(db, {
    ticker: 'SRC', asOf: 'not-a-date', epsValue: 2, source: 'test'
  }), /基准日无效/);
  db.close();
});
