import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { configureAutomaticPeers, selectIndustryLeaders } from '../src/peer-selection.js';
import { upsertWatchlistItem } from '../src/repository.js';
import { listPeers } from '../src/valuation.js';

test('LITE和SNDK自动选择两个可追溯的行业对标公司', () => {
  assert.deepEqual(
    selectIndustryLeaders({ ticker: 'LITE' }).peers.map((peer) => peer.ticker),
    ['COHR', 'CIEN']
  );
  assert.deepEqual(
    selectIndustryLeaders({ ticker: 'SNDK' }).peers.map((peer) => peer.ticker),
    ['MU', 'WDC']
  );
});

test('自动同业写入恰好两个关系且重复执行幂等', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'LITE' });
  const first = configureAutomaticPeers(db, 'LITE', '2026-09-02');
  const second = configureAutomaticPeers(db, 'LITE', '2026-09-02');

  assert.equal(first.matched, true);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(listPeers(db, 'LITE').map((peer) => peer.ticker), ['CIEN', 'COHR']);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM company_relationships
    WHERE ticker = 'LITE' AND active_to IS NULL
  `).get().count, 2);
  db.close();
});

test('没有股票级规则时按SEC SIC选择行业龙头', () => {
  const selection = selectIndustryLeaders({ ticker: 'CHIP', sic: '3674' });
  assert.equal(selection.matched, true);
  assert.equal(selection.method, 'SEC_SIC');
  assert.deepEqual(selection.peers.map((peer) => peer.ticker), ['NVDA', 'AVGO']);
});

test('无法可靠识别行业时明确返回未匹配而不猜测', () => {
  const selection = selectIndustryLeaders({ ticker: 'UNKNOWN' });
  assert.equal(selection.matched, false);
  assert.deepEqual(selection.peers, []);
  assert.match(selection.reason, /尚无可验证/);
});
