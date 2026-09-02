import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import {
  addPeer,
  calculateTtmEps,
  deleteEarningsEstimate,
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
