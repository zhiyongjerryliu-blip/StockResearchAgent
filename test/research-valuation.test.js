import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { upsertWatchlistItem } from '../src/repository.js';
import { buildPeScenarioAnalysis, persistValuationScenarios } from '../src/research-valuation.js';

function valuation(overrides = {}) {
  return {
    target: {
      price: 20,
      forwardEps: 1,
      estimate: { epsLow: 0.8, epsHigh: 1.2, periodEnd: '2027-06-30' },
      ...overrides.target
    },
    peerMedian: { forwardPe: 20, forwardPeSamples: 2, ...overrides.peerMedian },
    historicalValuation: overrides.historicalValuation || {}
  };
}

test('正盈利PE情景按EPS乘倍数计算并与正式预测隔离', () => {
  const result = buildPeScenarioAnalysis(valuation(), { latest: { metrics: {} } });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.scenarios.find((item) => item.key === 'BEAR').conditionalValue, 12.8);
  assert.equal(result.scenarios.find((item) => item.key === 'BASE').conditionalValue, 20);
  assert.equal(result.scenarios.find((item) => item.key === 'BULL').conditionalValue, 28.8);
  assert.equal(result.assumptions.probabilityCalibrated, false);
  assert.match(result.publicationIsolation, /非正式价格预测/);
});

test('利润、EPS与声明股数冲突会被识别且不会被舍入掩盖', () => {
  const operating = { latest: { metrics: {
    netIncome: { value: 5.67 }, epsDiluted: { value: 0.9 }, dilutedShares: { value: 7.53 }
  } } };
  const result = buildPeScenarioAnalysis(valuation(), operating);
  assert.equal(result.shareConsistency.status, 'CONFLICT');
  assert.equal(result.shareConsistency.inferredShares, 6.3);
  assert.ok(result.issues.some((item) => item.includes('超过5%')));
});

test('利润区间除股数再乘20倍可复算为14.61至15.94而非虚构区间', () => {
  const low = (5.5 / 7.53) * 20;
  const high = (6 / 7.53) * 20;
  assert.equal(Number(low.toFixed(2)), 14.61);
  assert.equal(Number(high.toFixed(2)), 15.94);
});

test('负EPS或缺少独立倍数依据时禁用PE情景', () => {
  const negative = buildPeScenarioAnalysis(valuation({ target: { forwardEps: -1 } }), {});
  assert.equal(negative.status, 'UNAVAILABLE');
  const noBasis = buildPeScenarioAnalysis(valuation({ peerMedian: { forwardPeSamples: 1 } }), {});
  assert.equal(noBasis.status, 'UNAVAILABLE');
  assert.equal(noBasis.scenarios.length, 0);
});

test('条件估值按报告和情景幂等保存，历史报告输入不会被覆盖', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST', name: 'Test' });
  const inserted = db.prepare(`
    INSERT INTO research_reports (
      ticker, as_of, generated_at, input_hash, schema_version, template_version,
      generation_mode, quality_status, content_json, evidence_json, limitations_json
    ) VALUES ('TEST','2026-09-09','2026-09-10T00:00:00Z','hash','schema','template','MANUAL','COMPLETE','{}','[]','[]')
  `).run();
  const report = { id: Number(inserted.lastInsertRowid), ticker: 'TEST', asOf: '2026-09-09' };
  const analysis = buildPeScenarioAnalysis(valuation(), { latest: { metrics: {} } });
  persistValuationScenarios(db, report, analysis, '2026-09-10T00:00:00Z');
  persistValuationScenarios(db, report, analysis, '2026-09-10T00:00:01Z');
  const rows = db.prepare('SELECT * FROM valuation_scenarios ORDER BY scenario_key').all();
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.scenario_key === 'BASE').conditional_value, 20);
  assert.equal(rows[0].created_at, '2026-09-10T00:00:00Z');
  db.close();
});
