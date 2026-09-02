import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { upsertWatchlistItem } from '../src/repository.js';
import {
  classifySec8kFiling,
  indexSecFilingEvents,
  listResearchEvents,
  parseSec8kItems,
  syncSecFilingEvents
} from '../src/events.js';

function insert8k(db, {
  ticker = 'RISK', accession = '0000000001-26-000001',
  filedAt = '2026-09-01', items = '1.03,2.04,9.01'
} = {}) {
  db.prepare(`
    INSERT INTO sec_filings (
      accession_number, ticker, cik, form, filed_at, report_date, accepted_at,
      primary_document, primary_doc_description, items, filing_url,
      is_xbrl, is_inline_xbrl, ingested_at
    ) VALUES (?, ?, '0000000001', '8-K', ?, ?, ?, 'risk-8k.htm', 'Current report', ?,
              ?, 1, 1, '2026-09-01T22:00:00.000Z')
  `).run(
    accession, ticker, filedAt, filedAt, `${filedAt}T20:30:00.000Z`, items,
    `https://www.sec.gov/Archives/${accession}`
  );
}

test('8-K事项解析去重并以最高风险事项决定文件等级', () => {
  assert.deepEqual(parseSec8kItems('Item 9.01, 1.03; 9.01 and 2.04'), ['9.01', '1.03', '2.04']);
  const event = classifySec8kFiling({ ticker: 'RISK', items: '9.01,1.03,2.04' });
  assert.equal(event.severity, 'P0');
  assert.equal(event.primaryItem, '1.03');
  assert.match(event.title, /破产或接管/);
  assert.match(event.summary, /具体影响需核对原文/);
});

test('SEC事件回填幂等并保留官方来源和规则证据', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'RISK', name: 'Risk Corp' });
  insert8k(db);
  const first = indexSecFilingEvents(db, 'RISK');
  const second = indexSecFilingEvents(db, 'RISK');
  const listed = listResearchEvents(db, { ticker: 'RISK' });
  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(listed.total, 1);
  assert.equal(listed.events[0].severity, 'P0');
  assert.equal(listed.events[0].source_type, 'SEC_8K');
  assert.equal(listed.events[0].evidence[0].classifierVersion, 'sec-8k-items-v1-2026-09-02');
  db.close();
});

test('只有新出现的股票池P0/P1文件触发一次风险通知', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'RISK' });
  const accession = '0000000001-26-000002';
  insert8k(db, { accession, items: '3.01,9.01' });
  const notifications = [];
  const notifier = async (_db, input) => { notifications.push(input); return input; };

  const first = await syncSecFilingEvents(db, 'RISK', {
    notifyAccessions: [accession], notifier
  });
  const second = await syncSecFilingEvents(db, 'RISK', {
    notifyAccessions: [accession], notifier
  });
  assert.equal(first.created, 1);
  assert.equal(first.notified, 1);
  assert.equal(second.created, 0);
  assert.equal(second.notified, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].severity, 'P1');
  assert.match(notifications[0].body, /不构成买卖建议/);
  db.close();
});
