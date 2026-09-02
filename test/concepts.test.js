import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { upsertWatchlistItem } from '../src/repository.js';
import { configureStockConcepts } from '../src/concepts.js';

test('个股概念明确区分已核实关系和行业代理', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'LITE', name: 'Lumentum' });
  upsertWatchlistItem(db, { ticker: 'SNDK', name: 'Sandisk' });
  const lite = configureStockConcepts(db, 'LITE');
  const sndk = configureStockConcepts(db, 'SNDK');
  assert.equal(lite.length, 2);
  assert.ok(lite.flatMap((item) => item.related_entities)
    .every((entity) => entity.verifiedDirectRelationship === false));
  const kioxia = sndk.flatMap((item) => item.related_entities)
    .find((entity) => entity.name === 'Kioxia');
  assert.equal(kioxia.verifiedDirectRelationship, true);
  const hyperscalers = sndk.flatMap((item) => item.related_entities)
    .filter((entity) => ['AMZN', 'MSFT', 'GOOGL'].includes(entity.ticker));
  assert.ok(hyperscalers.every((entity) => !entity.verifiedDirectRelationship));
  db.close();
});
test('没有专用规则时只基于用户填写的行业生成低置信度通用概念', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST', industry: 'Industrial Software' });
  const concepts = configureStockConcepts(db, 'TEST');
  assert.equal(concepts.length, 1);
  assert.equal(concepts[0].concept_type, 'INDUSTRY_TREND');
  assert.equal(concepts[0].confidence, 0.55);
  assert.deepEqual(concepts[0].related_entities, []);
  db.close();
});
