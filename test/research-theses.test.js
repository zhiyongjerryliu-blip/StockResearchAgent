import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { upsertWatchlistItem } from '../src/repository.js';
import { buildResearchTheses, persistResearchTheses } from '../src/research-theses.js';

function input(overrides = {}) {
  return {
    asOf: '2026-09-09',
    valuation: { target: { estimate: null } },
    operating: { latest: null, quarterly: [] },
    events: { events: [] }, advice: null,
    ...overrides
  };
}

test('缺少证据时论点保持待验证而不是自动证伪', () => {
  const result = buildResearchTheses(input());
  assert.equal(result.theses.length, 3);
  assert.ok(result.theses.every((item) => item.status === 'PENDING'));
  assert.ok(result.theses.every((item) => item.unknownReason));
});

test('盈利预期下修超过明确阈值才把对应论点标为已证伪', () => {
  const result = buildResearchTheses(input({
    valuation: { target: { estimate: {
      asOf: '2026-09-09', source: 'provider', revision: { thirtyDay: { changePct: -0.03 } }
    } } }
  }));
  const thesis = result.theses.find((item) => item.key === 'EARNINGS_REVISION_IMPROVING');
  assert.equal(thesis.status, 'FALSIFIED');
  assert.equal(thesis.opposingEvidence.length, 1);
});

test('正反事件证据同屏且重复事件只计一次，并生成可验证传导链', () => {
  const positive = {
    id: 1, event_key: 'E1', event_date: '2026-09-08', event_type: 'NEWS_SUPPLY_AGREEMENT',
    title: 'Supply agreement', severity: 'P2', source_type: 'NEWS_IMPACT', source_url: 'https://example.com/1',
    status: 'UNVERIFIED', evidence: [{ direction: 'POSITIVE' }]
  };
  const negative = {
    id: 2, event_key: 'E2', event_date: '2026-09-09', event_type: 'NEWS_CUSTOMER_LOSS',
    title: 'Customer risk', severity: 'P2', source_type: 'NEWS_RISK', source_url: 'https://example.com/2',
    status: 'UNVERIFIED', evidence: []
  };
  const result = buildResearchTheses(input({ events: { events: [positive, positive, negative] } }));
  const thesis = result.theses.find((item) => item.key === 'CATALYSTS_OUTWEIGH_RISKS');
  assert.equal(thesis.status, 'WEAKENED');
  assert.equal(thesis.supportingEvidence.length, 1);
  assert.equal(thesis.opposingEvidence.length, 1);
  assert.equal(result.transmissionChains.length, 2);
  assert.equal(result.transmissionChains[0].affectedVariable, '销量、ASP与收入');
  assert.equal(result.transmissionChains[0].causalityStatus, 'HYPOTHESIS_NOT_PROVEN');
});

test('论点定义和每版观测追加保存且同一报告幂等', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST', name: 'Test' });
  const inserted = db.prepare(`
    INSERT INTO research_reports (
      ticker, as_of, generated_at, input_hash, schema_version, template_version,
      generation_mode, quality_status, content_json, evidence_json, limitations_json
    ) VALUES ('TEST','2026-09-09','2026-09-10T00:00:00Z','hash','schema','template','MANUAL','COMPLETE','{}','[]','[]')
  `).run();
  const report = { id: Number(inserted.lastInsertRowid), ticker: 'TEST', asOf: '2026-09-09' };
  const analysis = buildResearchTheses(input());
  persistResearchTheses(db, report, analysis, '2026-09-10T00:00:00Z');
  persistResearchTheses(db, report, analysis, '2026-09-10T00:00:01Z');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM research_theses').get().count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM research_thesis_observations').get().count, 3);
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM research_theses').get().version, 1);
  db.close();
});
