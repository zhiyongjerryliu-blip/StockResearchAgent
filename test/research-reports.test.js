import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import {
  createResearchReportJob, generateResearchReport, getResearchReport, getResearchReportJob,
  listResearchReports, renderResearchReportHtml, runResearchReportJob
} from '../src/research-reports.js';

function seededDb() {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST', name: 'Test Company', industry: 'Semiconductors' });
  addTransaction(db, { ticker: 'TEST', side: 'BUY', tradeDate: '2026-09-08', quantity: 12, price: 10, fee: 1 });
  saveManualPrice(db, { ticker: 'TEST', tradeDate: '2026-09-08', close: 10, volume: 1000 });
  saveManualPrice(db, { ticker: 'TEST', tradeDate: '2026-09-09', close: 11, volume: 1200 });
  return db;
}

test('基础综合研报生成九章冻结快照并对相同输入保持幂等', () => {
  const db = seededDb();
  const first = generateResearchReport(db, { ticker: 'TEST', asOf: '2026-09-09' });
  const second = generateResearchReport(db, { ticker: 'TEST', asOf: '2026-09-09' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.report.id, first.report.id);
  assert.equal(first.report.content.sections.length, 9);
  assert.deepEqual(first.report.content.sections.map((item) => item.order), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(listResearchReports(db, 'TEST').length, 1);
  assert.equal(getResearchReport(db, first.report.id).inputHash, first.report.inputHash);
  db.close();
});

test('输入变化生成新版本且默认HTML导出移除个人持仓字段', () => {
  const db = seededDb();
  const first = generateResearchReport(db, { ticker: 'TEST', asOf: '2026-09-09' });
  saveManualPrice(db, { ticker: 'TEST', tradeDate: '2026-09-09', close: 11.5, volume: 1300 });
  const second = generateResearchReport(db, { ticker: 'TEST', asOf: '2026-09-09' });
  assert.equal(second.created, true);
  assert.notEqual(second.report.id, first.report.id);
  assert.equal(listResearchReports(db, 'TEST').length, 2);
  const html = renderResearchReportHtml(second.report);
  assert.match(html, /TEST 个股综合研报/);
  assert.doesNotMatch(html, /averageCost|remainingCost|totalBuyCash|"lots"/);
  assert.match(html, /默认导出不包含持仓个性化建议/);
  db.close();
});

test('研报任务持久化状态且合并同股票同截止日的并发请求', () => {
  const db = seededDb();
  const queued = createResearchReportJob(db, { ticker: 'TEST', asOf: '2026-09-09' });
  const merged = createResearchReportJob(db, { ticker: 'TEST', asOf: '2026-09-09' });
  assert.equal(queued.status, 'QUEUED');
  assert.equal(merged.id, queued.id);
  assert.equal(merged.merged, true);
  const finished = runResearchReportJob(db, queued.id);
  assert.equal(finished.status, 'SUCCESS');
  assert.ok(finished.report_id);
  assert.equal(getResearchReportJob(db, queued.id).status, 'SUCCESS');
  db.close();
});
