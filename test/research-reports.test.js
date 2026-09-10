import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import {
  compareResearchReports, createResearchReportJob, generateResearchReport, getResearchReport, getResearchReportJob,
  listResearchReports, recoverInterruptedResearchReportJobs, renderResearchReportHtml, runResearchReportJob
} from '../src/research-reports.js';
import { PREDICTION_MODEL_VERSION } from '../src/predictions.js';

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
  const comparison = compareResearchReports(db, first.report.id, second.report.id);
  assert.ok(comparison.materialChangeCount > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM research_report_diffs').get().count, 1);
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
  assert.equal(finished.stage, 'COMPLETED');
  assert.equal(finished.progress, 100);
  assert.equal(finished.attempt_count, 1);
  assert.ok(finished.report_id);
  assert.equal(getResearchReportJob(db, queued.id).status, 'SUCCESS');
  db.close();
});

test('服务重启可回收未完成研报任务并允许安全重试', () => {
  const db = seededDb();
  const queued = createResearchReportJob(db, { ticker: 'TEST', asOf: '2026-09-09' });
  const recovery = recoverInterruptedResearchReportJobs(db);
  const interrupted = getResearchReportJob(db, queued.id);
  assert.equal(recovery.recovered, 1);
  assert.equal(interrupted.status, 'FAILED');
  assert.equal(interrupted.stage, 'INTERRUPTED');
  const retry = createResearchReportJob(db, { ticker: 'TEST', asOf: '2026-09-09' });
  assert.notEqual(retry.id, queued.id);
  assert.equal(runResearchReportJob(db, retry.id).status, 'SUCCESS');
  db.close();
});

test('未通过发布闸门的预测不会从研报JSON或HTML旁路泄露目标数值', () => {
  const db = seededDb();
  db.prepare(`
    INSERT INTO predictions (
      ticker, as_of, target_date, horizon_days, current_price, return_p10, return_p50,
      return_p90, price_p10, price_p50, price_p90, probability_up, reliability_score,
      publication_status, model_version, feature_version, rationale_json, created_at
    ) VALUES ('TEST','2026-09-09','2026-10-09',21,11,-0.1,0.2,0.3,9.9,9876.54,14.3,0.876543,40,
      'OBSERVE',?,'test-feature','{"predictedDirection":"BULLISH"}','2026-09-09T22:00:00Z')
  `).run(PREDICTION_MODEL_VERSION);
  const generated = generateResearchReport(db, { ticker: 'TEST', asOf: '2026-09-09' });
  const prediction = generated.report.content.predictions.predictions[0];
  assert.equal(prediction.publication_status, 'OBSERVE');
  assert.equal(prediction.price_p50, undefined);
  assert.equal(prediction.probability_up, undefined);
  const html = renderResearchReportHtml(generated.report);
  assert.doesNotMatch(html, /9876\.54|0\.876543/);
  assert.match(html, /未通过综合可靠度发布闸门/);
  db.close();
});
