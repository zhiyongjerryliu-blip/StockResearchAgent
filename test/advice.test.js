import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, nowIso } from '../src/db.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import {
  ADVICE_MODEL_VERSION, buildInvestmentAdvice, saveInvestmentAdvice
} from '../src/advice.js';
import { ingestFutuBars, ingestFutuTicks } from '../src/intraday-flow.js';
import { CAPITAL_BEHAVIOR_MODEL_VERSION } from '../src/capital-behavior.js';
import {
  CANDIDATE_MODEL_VERSION, PREDICTION_MODEL_VERSION, getPredictionOverview
} from '../src/predictions.js';

function seedPrices(db, ticker, count = 130, step = 1) {
  const end = new Date('2026-09-01T00:00:00.000Z');
  for (let index = count - 1; index >= 0; index -= 1) {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - index);
    saveManualPrice(db, {
      ticker, tradeDate: date.toISOString().slice(0, 10),
      open: 200 + (step * (count - 1 - index)),
      high: (200 + (step * (count - 1 - index))) * 1.01,
      low: (200 + (step * (count - 1 - index))) * 0.99,
      close: 200 + (step * (count - 1 - index)), volume: 1000
    });
  }
}

function insertImpactEvent(db, ticker) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO research_events (
      event_key, ticker, event_date, event_type, title, summary, severity,
      source_type, source_id, source_url, evidence_json, status, detected_at, updated_at
    ) VALUES (
      'impact-positive', ?, '2026-08-31', 'NEWS_SUPPLY_AGREEMENT',
      '重大长期合同', '长期供应协议待核实', 'P2', 'NEWS_IMPACT', 'article-1',
      'https://example.com/impact', ?, 'UNVERIFIED', ?, ?
    )
  `).run(ticker, JSON.stringify([{
    sourceTier: 'TIER_1', relationType: 'DIRECT', direction: 'POSITIVE'
  }]), timestamp, timestamp);
}

function seedFullSessionOutflow(db, ticker) {
  const bars = [];
  const ticks = [];
  for (let index = 0; index < 390; index += 1) {
    const totalMinutes = (9 * 60) + 30 + index;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const minuteText = `2026-09-01 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const price = 200 - (index * 0.01);
    bars.push({
      ticker, barTimeEt: `${minuteText}:00`, tradeDate: '2026-09-01',
      open: price + 0.01, high: price + 0.02, low: price - 0.02, close: price,
      volume: 1000, turnover: price * 1000, isFinal: true, session: 'RTH'
    });
    ticks.push({
      ticker, sequence: String(index), tradeTimeEt: `${minuteText}:30`,
      tradeDate: '2026-09-01', price, volume: 1000, turnover: price * 1000,
      direction: 'SELL', tradeType: 'AUTO_MATCH', session: 'RTH'
    });
  }
  ingestFutuBars(db, bars);
  ingestFutuTicks(db, ticks);
}

function seedValidatedContinuousDistribution(db, ticker) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO capital_behavior_snapshots (
      ticker, as_of, price_date, stage, direction, score, confidence, close,
      daily_flow_score, intraday_flow_score, active_turnover_ratio, price_vs_vwap,
      persistence_score, positive_days_5, negative_days_5, directional_streak,
      data_level, evidence_json, limitations_json, model_version, created_at
    ) VALUES (
      ?, '2026-09-01', '2026-09-01', 'ACCELERATED_DISTRIBUTION', 'BEARISH',
      -70, 80, 200, -30, -85, -0.75, -0.03, 100, 0, 5, 5,
      'DAILY_AND_FUTU_TICK', '[]', '[]', ?, ?
    )
  `).run(ticker, CAPITAL_BEHAVIOR_MODEL_VERSION, timestamp);
  const insert = db.prepare(`
    INSERT INTO capital_behavior_validation (
      ticker, signal_as_of, horizon_days, target_date, actual_date, stage, direction,
      start_price, actual_return, maximum_favorable_excursion, maximum_adverse_excursion,
      direction_hit, status, exclusion_reason, signal_confidence, model_version,
      created_at, updated_at
    ) VALUES (
      ?, ?, 20, ?, ?, 'ACCELERATED_DISTRIBUTION', 'BEARISH',
      200, -0.08, 0.10, -0.02, 1, 'MATURED', NULL, 80, ?, ?, ?
    )
  `);
  for (let index = 0; index < 10; index += 1) {
    const signalDate = new Date(Date.UTC(2025, 0, 2 + (index * 35))).toISOString().slice(0, 10);
    const actualDate = new Date(Date.UTC(2025, 0, 23 + (index * 35))).toISOString().slice(0, 10);
    insert.run(
      ticker, signalDate, actualDate, actualDate,
      CAPITAL_BEHAVIOR_MODEL_VERSION, timestamp, timestamp
    );
  }
}

test('没有通过可靠度闸门时只输出观察建议且不发布目标位', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  seedPrices(db, 'TEST', 30);
  saveManualPrice(db, { ticker: 'TEST', tradeDate: '2026-09-02', close: 999, volume: 1000 });
  const overview = buildInvestmentAdvice(db, 'TEST', '2026-09-01');
  assert.deepEqual(overview.advice.map((item) => item.action), ['WATCH', 'WATCH', 'WATCH']);
  assert.ok(overview.advice.every((item) => !item.formalReady));
  assert.ok(overview.advice.every((item) => item.targetPrice == null));
  assert.equal(overview.position.currentPrice, 229);
  assert.match(overview.policy.formalGate, /综合可靠度≥85分/);
  assert.ok(overview.advice.every((item) => !item.components.capitalBehavior.usedInImpact));
  db.close();
});

test('正向证据与已发布高可靠预测共同满足时才给出候选买入', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  seedPrices(db, 'TEST');
  insertImpactEvent(db, 'TEST');
  db.prepare(`
    INSERT INTO predictions (
      ticker, as_of, target_date, horizon_days, current_price,
      return_p10, return_p50, return_p90, price_p10, price_p50, price_p90,
      probability_up, reliability_score, publication_status, model_version,
      rationale_json, created_at
    ) VALUES (
      'TEST', '2026-09-01', '2026-09-30', 21, 329,
      -0.05, 0.10, 0.20, 300, 362, 395, 0.65, 90,
      'PUBLISHED', 'validated-test-v1', '{}', ?
    )
  `).run(nowIso());
  const item = buildInvestmentAdvice(db, 'TEST', '2026-09-01').advice[0];
  assert.equal(item.action, 'BUY_CANDIDATE');
  assert.equal(item.publicationStatus, 'PUBLISHED');
  assert.equal(item.formalReady, true);
  assert.equal(item.targetPrice, 362);
  assert.equal(item.stopPrice, 300);
  assert.ok(item.impactScore >= 20);
  db.close();
});

test('SEC官方高风险事件可覆盖预测闸门并触发持仓风险退出评估', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  addTransaction(db, {
    ticker: 'TEST', side: 'BUY', tradeTime: '2026-08-01', quantity: 10, price: 100
  });
  seedPrices(db, 'TEST', 30);
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO research_events (
      event_key, ticker, event_date, event_type, title, summary, severity,
      source_type, source_id, evidence_json, status, detected_at, updated_at
    ) VALUES (
      'sec-critical', 'TEST', '2026-08-31', 'SEC_8K_ITEM_3_01',
      '退市风险', '公司收到上市资格通知', 'P1', 'SEC_8K',
      'accession-1', '[]', 'ACTIVE', ?, ?
    )
  `).run(timestamp, timestamp);
  const overview = saveInvestmentAdvice(db, 'TEST', '2026-09-01');
  assert.ok(overview.advice.every((item) => item.action === 'EXIT_RISK_REVIEW'));
  assert.ok(overview.advice.every((item) => item.publicationStatus === 'RISK_OVERRIDE'));
  saveInvestmentAdvice(db, 'TEST', '2026-09-01');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM investment_advice_snapshots
    WHERE ticker = 'TEST' AND model_version = ?
  `).get(ADVICE_MODEL_VERSION).count, 3);
  db.close();
});

test('未过预测闸门但负面综合分达到阈值时只建议评估减仓', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  addTransaction(db, {
    ticker: 'TEST', side: 'BUY', tradeTime: '2026-08-01', quantity: 10, price: 100
  });
  seedPrices(db, 'TEST', 30, -0.15);
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO research_events (
      event_key, ticker, event_date, event_type, title, summary, severity,
      source_type, source_id, evidence_json, status, detected_at, updated_at
    ) VALUES (
      'news-risk', 'TEST', '2026-08-31', 'NEWS_GUIDANCE',
      '指引下调', '业绩指引下调', 'P2', 'NEWS_RISK', 'article-risk',
      ?, 'UNVERIFIED', ?, ?
    )
  `).run(JSON.stringify([{ sourceTier: 'TIER_1', relationType: 'DIRECT' }]), timestamp, timestamp);
  const item = buildInvestmentAdvice(db, 'TEST', '2026-09-01').advice[0];
  assert.equal(item.formalReady, false);
  assert.equal(item.action, 'REDUCE_REVIEW');
  assert.equal(item.publicationStatus, 'OBSERVE');
  db.close();
});

test('高置信分钟主动卖出进入建议但不能单独触发清仓结论', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  addTransaction(db, {
    ticker: 'TEST', side: 'BUY', tradeTime: '2026-08-01', quantity: 10, price: 100
  });
  seedPrices(db, 'TEST', 30, 0);
  seedFullSessionOutflow(db, 'TEST');

  const overview = buildInvestmentAdvice(db, 'TEST', '2026-09-01');
  assert.ok(overview.advice.every((item) => item.components.intradayFlow.available));
  assert.ok(overview.advice.every((item) => item.components.intradayFlow.signal === 'STRONG_OUTFLOW'));
  assert.ok(overview.advice.every((item) => item.action === 'REDUCE_REVIEW'));
  assert.ok(overview.advice.every((item) => item.formalReady === false));
  assert.ok(overview.advice.every((item) => item.targetPrice == null));
  assert.match(overview.policy.riskOverride, /不能单独触发清仓/);
  db.close();
});

test('通过20日85分门槛的连续派发才合并资金分并触发减仓复核', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  addTransaction(db, {
    ticker: 'TEST', side: 'BUY', tradeTime: '2026-08-01', quantity: 10, price: 100
  });
  seedPrices(db, 'TEST', 130, 0);
  seedValidatedContinuousDistribution(db, 'TEST');

  const overview = buildInvestmentAdvice(db, 'TEST', '2026-09-01');

  assert.ok(overview.advice.every((item) => item.components.capitalBehavior.usedInImpact));
  assert.ok(overview.advice.every((item) => item.components.capitalBehavior.publicationStatus === 'PUBLISHED'));
  assert.ok(overview.advice.every((item) => item.components.capitalBehavior.reliability.reliabilityScore >= 85));
  assert.ok(overview.advice.every((item) => item.components.capitalFlow.continuousBehaviorApplied));
  assert.ok(overview.advice.every((item) => item.components.capitalFlow.score < item.components.capitalFlow.rawScore));
  assert.ok(overview.advice.every((item) => item.action === 'REDUCE_REVIEW'));
  assert.ok(overview.advice.every((item) => item.formalReady === false));
  db.close();
});

test('投资建议只读取模型评估选中的预测版本', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  seedPrices(db, 'TEST', 130, 0);
  const timestamp = nowIso();
  const insertPrediction = db.prepare(`
    INSERT INTO predictions (
      ticker, as_of, target_date, horizon_days, current_price,
      return_p10, return_p50, return_p90, price_p10, price_p50, price_p90,
      probability_up, reliability_score, publication_status, model_version,
      feature_version, rationale_json, created_at
    ) VALUES (
      'TEST', '2026-09-01', '2026-09-30', 21, 200,
      ?, ?, ?, ?, ?, ?, ?, 90, 'PUBLISHED', ?, 'test-features', '{}', ?
    )
  `);
  insertPrediction.run(-0.15, -0.10, -0.05, 170, 180, 190, 0.2, PREDICTION_MODEL_VERSION, timestamp);
  insertPrediction.run(0.05, 0.10, 0.15, 210, 220, 230, 0.8, CANDIDATE_MODEL_VERSION, timestamp);
  const insertEvaluation = db.prepare(`
    INSERT INTO prediction_model_evaluations (
      ticker, as_of, horizon_days, baseline_model_version, candidate_model_version,
      selected_model_version, decision, training_samples, baseline_metrics_json,
      candidate_metrics_json, reason, created_at
    ) VALUES ('TEST', '2026-09-01', 21, ?, ?, ?, ?, 100, '{}', '{}', 'test', ?)
  `);
  insertEvaluation.run(
    PREDICTION_MODEL_VERSION, CANDIDATE_MODEL_VERSION,
    PREDICTION_MODEL_VERSION, 'KEEP_BASELINE', timestamp
  );

  let item = buildInvestmentAdvice(db, 'TEST', '2026-09-01').advice
    .find((candidate) => candidate.horizonDays === 21);
  assert.equal(item.prediction.modelVersion, PREDICTION_MODEL_VERSION);
  assert.equal(item.prediction.returnP50, -0.10);
  assert.equal(
    getPredictionOverview(db, 'TEST', '2026-09-01').predictions[0].model_version,
    PREDICTION_MODEL_VERSION
  );

  db.prepare(`
    UPDATE prediction_model_evaluations
    SET selected_model_version = ?, decision = 'PROMOTE_CANDIDATE'
    WHERE ticker = 'TEST' AND as_of = '2026-09-01' AND horizon_days = 21
  `).run(CANDIDATE_MODEL_VERSION);
  item = buildInvestmentAdvice(db, 'TEST', '2026-09-01').advice
    .find((candidate) => candidate.horizonDays === 21);
  assert.equal(item.prediction.modelVersion, CANDIDATE_MODEL_VERSION);
  assert.equal(item.prediction.returnP50, 0.10);
  assert.equal(
    getPredictionOverview(db, 'TEST', '2026-09-01').predictions[0].model_version,
    CANDIDATE_MODEL_VERSION
  );
  db.close();
});
