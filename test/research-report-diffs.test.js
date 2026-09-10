import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import { buildResearchReportDiff } from '../src/research-report-diffs.js';
import {
  generateWatchlistResearchReports, researchMaterialHash
} from '../src/research-reports.js';

function report(id, overrides = {}) {
  return {
    id, ticker: 'TEST', asOf: id === 1 ? '2026-09-08' : '2026-09-09',
    generatedAt: `2026-09-${String(8 + id).padStart(2, '0')}T00:00:00Z`,
    analysisPrice: id === 1 ? 10 : 11,
    priceDate: id === 1 ? '2026-09-08' : '2026-09-09',
    qualityStatus: 'COMPLETE', schemaVersion: 'v1', templateVersion: 'v1', evidence: [],
    content: {
      operating: { latest: null },
      valuation: { target: { forwardEps: id === 1 ? 1 : 1.1, staticPe: 10, forwardPe: 10 } },
      valuationScenarios: { scenarios: [] },
      theses: { theses: [{ key: 'T1', status: id === 1 ? 'PENDING' : 'STRENGTHENED', score: id - 1 }] },
      predictions: { predictions: [{ horizon_days: 21, model_version: 'v1', publication_status: 'OBSERVE' }] },
      events: { events: [] }
    },
    ...overrides
  };
}

test('版本对比按价格、预期和论点分类返回旧值新值', () => {
  const diff = buildResearchReportDiff(report(1), report(2));
  assert.ok(diff.materialChangeCount >= 3);
  assert.ok(diff.changes.some((item) => item.path === 'report.analysisPrice' && item.category === 'PRICE'));
  assert.ok(diff.changes.some((item) => item.path === 'expectations.ntmEps' && item.oldValue === 1 && item.newValue === 1.1));
  assert.ok(diff.changes.some((item) => item.path === 'theses.T1.status' && item.newValue === 'STRENGTHENED'));
});

test('不同股票和相同版本不能对比', () => {
  assert.throws(() => buildResearchReportDiff(report(1), report(2, { ticker: 'OTHER' })), /同一股票/);
  assert.throws(() => buildResearchReportDiff(report(1), report(1)), /不同研报版本/);
});

test('输入哈希忽略采集时间但保留数值变化', () => {
  const first = researchMaterialHash({ ticker: 'TEST', value: 1, updated_at: 'A', nested: { fetchedAt: 'A' } });
  const timestampOnly = researchMaterialHash({ ticker: 'TEST', value: 1, updated_at: 'B', nested: { fetchedAt: 'B' } });
  const changed = researchMaterialHash({ ticker: 'TEST', value: 2, updated_at: 'B', nested: { fetchedAt: 'B' } });
  assert.equal(first, timestampOnly);
  assert.notEqual(first, changed);
});

test('日终研报只处理启用股票且同一截止日无实质变化不重复建版', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST', name: 'Test' });
  upsertWatchlistItem(db, { ticker: 'PAUSE', name: 'Paused', enabled: false });
  saveManualPrice(db, { ticker: 'TEST', tradeDate: '2026-09-09', close: 10, volume: 1000 });
  saveManualPrice(db, { ticker: 'PAUSE', tradeDate: '2026-09-09', close: 20, volume: 1000 });
  const first = generateWatchlistResearchReports(db, '2026-09-09');
  const second = generateWatchlistResearchReports(db, '2026-09-09');
  assert.deepEqual(first.map((item) => item.ticker), ['TEST']);
  assert.equal(first[0].status, 'CREATED');
  assert.equal(second[0].status, 'NO_CHANGE');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM research_reports').get().count, 1);
  db.close();
});
