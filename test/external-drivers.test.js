import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, nowIso } from '../src/db.js';
import { upsertWatchlistItem } from '../src/repository.js';
import { configureStockConcepts } from '../src/concepts.js';
import { getExternalDriversOverview } from '../src/external-drivers.js';

function insertFact(db, input) {
  db.prepare(`
    INSERT INTO financial_facts (
      source_key, ticker, cik, metric_key, taxonomy, tag, unit, period_start,
      period_end, period_type, form, filed_at, value, ingested_at
    ) VALUES (?, 'LITE', '0001633978', ?, 'us-gaap', ?, 'USD', ?, ?, ?, '10-Q', ?, ?, ?)
  `).run(
    input.key, input.metric, input.tag, input.start, input.end,
    input.periodType, input.filedAt, input.value, nowIso()
  );
}

test('外部驱动概览保留回购、资本开支口径和关系防误判说明', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'LITE', name: 'Lumentum' });
  configureStockConcepts(db, 'LITE');
  insertFact(db, {
    key: 'rep-q2', metric: 'shareRepurchases', tag: 'PaymentsForRepurchaseOfCommonStock',
    start: '2026-04-01', end: '2026-06-30', periodType: 'quarter',
    filedAt: '2026-08-01', value: 100
  });
  insertFact(db, {
    key: 'rep-future', metric: 'shareRepurchases', tag: 'PaymentsForRepurchaseOfCommonStock',
    start: '2026-07-01', end: '2026-09-30', periodType: 'quarter',
    filedAt: '2026-10-20', value: 999
  });
  insertFact(db, {
    key: 'rep-q1', metric: 'shareRepurchases', tag: 'PaymentsForRepurchaseOfCommonStock',
    start: '2026-01-01', end: '2026-03-31', periodType: 'quarter',
    filedAt: '2026-05-01', value: 80
  });
  insertFact(db, {
    key: 'capex-ytd', metric: 'capitalExpenditure', tag: 'PaymentsToAcquirePropertyPlantAndEquipment',
    start: '2026-01-01', end: '2026-06-30', periodType: 'ytd',
    filedAt: '2026-08-01', value: 250
  });
  const overview = getExternalDriversOverview(db, 'LITE', '2026-09-01');
  assert.equal(overview.corporateActions.shareRepurchases.value, 100);
  assert.equal(overview.corporateActions.shareRepurchases.previousComparable.value, 80);
  assert.equal(overview.corporateActions.capitalExpenditure.previousComparable, null);
  assert.match(overview.relationshipPolicy.proxy, /不得表述为.*已确认/);
  assert.ok(overview.concepts.flatMap((concept) => concept.related_entities)
    .every((entity) => !entity.verifiedDirectRelationship));
  db.close();
});
