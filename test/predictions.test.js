import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, nowIso } from '../src/db.js';
import { saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import {
  FEATURE_VERSION, PREDICTION_MODEL_VERSION, buildFeatureSnapshot, buildFixedTargetComparisons,
  getPredictionOverview, listPredictionChanges, predictFromSnapshot, runPredictionBacktest
} from '../src/predictions.js';

function businessDates(start, count) {
  const dates = [];
  const date = new Date(`${start}T00:00:00.000Z`);
  while (dates.length < count) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

function seedPrices(db, ticker, count = 240) {
  const dates = businessDates('2025-01-02', count);
  dates.forEach((tradeDate, index) => saveManualPrice(db, {
    ticker, tradeDate,
    open: 100 + (index * 0.18), high: 101 + (index * 0.18),
    low: 99 + (index * 0.18), close: 100 + (index * 0.2),
    volume: 1_000_000 + (index * 1000)
  }));
  return dates;
}

test('时点特征只读取基准日及之前的数据', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  const dates = seedPrices(db, 'TEST', 80);
  const asOf = dates[60];
  const snapshot = buildFeatureSnapshot(db, 'TEST', asOf);

  assert.equal(snapshot.asOf, asOf);
  assert.equal(snapshot.priceDate, asOf);
  assert.equal(snapshot.features.price.currentPrice, 112);
  assert.equal(snapshot.features.price.sampleSize, 61);
  assert.equal(snapshot.featureVersion, FEATURE_VERSION);
  assert.equal(snapshot.eligibleForTraining, true);
  db.close();
});

test('预测模型输出三个分位、方向和可追溯信号', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  const dates = seedPrices(db, 'TEST', 140);
  const snapshot = buildFeatureSnapshot(db, 'TEST', dates.at(-1));
  const prediction = predictFromSnapshot(snapshot, 21);

  assert.equal(prediction.modelVersion, PREDICTION_MODEL_VERSION);
  assert.equal(prediction.predictedDirection, 'BULLISH');
  assert.ok(prediction.returnP10 < prediction.returnP50);
  assert.ok(prediction.returnP50 < prediction.returnP90);
  assert.ok(prediction.priceP10 < prediction.priceP50);
  assert.ok(Number.isFinite(prediction.signals.momentum));
  const explained = Object.values(prediction.factorContributions)
    .filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(explained - prediction.returnP50) < 0.000001);
  db.close();
});

test('连续交易日预测按因子拆解变化且重复运行不会重复记账', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  const dates = seedPrices(db, 'TEST', 170);
  const previousDate = dates[165];
  const currentDate = dates[166];

  runPredictionBacktest(db, 'TEST', previousDate, { maxSessions: 170 });
  const current = runPredictionBacktest(db, 'TEST', currentDate, { maxSessions: 170 });
  runPredictionBacktest(db, 'TEST', currentDate, { maxSessions: 170 });
  const changes = listPredictionChanges(db, 'TEST');
  const historicalOverview = getPredictionOverview(db, 'TEST', previousDate);

  assert.equal(current.changes.length, 3);
  assert.equal(changes.length, 3);
  assert.ok(historicalOverview.predictions.every((prediction) => prediction.as_of === previousDate));
  assert.equal(historicalOverview.changes.length, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM prediction_change_snapshots
    WHERE ticker = 'TEST' AND as_of = ? AND model_version = ?
  `).get(currentDate, PREDICTION_MODEL_VERSION).count, 3);
  for (const change of changes) {
    assert.equal(change.previous_as_of, previousDate);
    assert.equal(change.as_of, currentDate);
    assert.equal(change.contributions.length, 8);
    assert.ok(Math.abs(change.residual_return_change) < 0.000001);
    assert.match(change.summary.headline, /预期收益较/);
    assert.match(change.summary.boundary, /不等同于.*因果关系/);
  }
  db.close();
});

test('固定目标日期比较按同一终点串联长期到短期预测', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  const dates = seedPrices(db, 'TEST', 240);
  const asOf = dates.at(-1);

  runPredictionBacktest(db, 'TEST', asOf, { maxSessions: 240 });
  const comparisons = buildFixedTargetComparisons(db, 'TEST', asOf);
  const overview = getPredictionOverview(db, 'TEST', asOf);

  assert.equal(comparisons.length, 2);
  assert.deepEqual(comparisons[0].points.map((point) => point.horizonDays), [126, 63, 21]);
  assert.equal(comparisons[0].anchorHorizonDays, 21);
  assert.ok(comparisons[0].points.every((point) => point.targetDateOffsetDays <= 7));
  assert.equal(comparisons[0].summary.exactMatches, 3);
  assert.match(comparisons[0].summary.headline, /目标中位价/);
  assert.match(comparisons[0].summary.headline, /%/);
  assert.match(comparisons[0].summary.boundary, /不同起点的收益率不直接互比/);
  assert.equal(overview.fixedTargetComparisons.length, 2);
  const historical = buildFixedTargetComparisons(db, 'TEST', dates[180]);
  assert.ok(historical.flatMap((comparison) => comparison.points)
    .every((point) => point.asOf <= dates[180]));
  db.close();
});

test('回测按交易日到期、幂等保存并自动生成可靠度和最新预测', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  const dates = seedPrices(db, 'TEST', 240);
  const asOf = dates.at(-1);

  const first = runPredictionBacktest(db, 'TEST', asOf, { maxSessions: 240 });
  const second = runPredictionBacktest(db, 'TEST', asOf, { maxSessions: 240 });
  const overview = getPredictionOverview(db, 'TEST');

  assert.equal(first.predictions.length, 3);
  assert.equal(second.predictions.length, 3);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM feature_snapshots
    WHERE ticker = 'TEST' AND feature_version = ?
  `).get(FEATURE_VERSION).count, 240);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM prediction_backtest_results
    WHERE ticker = 'TEST' AND model_version = ?
  `).get(PREDICTION_MODEL_VERSION).count, 720);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM predictions
    WHERE ticker = 'TEST' AND model_version = ?
  `).get(PREDICTION_MODEL_VERSION).count, 3);
  assert.ok(overview.backtest.find((item) => item.horizonDays === 21).matured > 0);
  assert.ok(overview.backtest.find((item) => item.horizonDays === 126).pending > 0);
  assert.ok(overview.reliability.every((item) => item.status === 'INSUFFICIENT'));
  assert.ok(overview.predictions.every((item) => item.publication_status === 'INSUFFICIENT'));
  db.close();
});

test('财务事实按提交日截断，后续提交不会进入较早特征快照', () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST' });
  const dates = seedPrices(db, 'TEST', 80);
  db.prepare(`
    INSERT INTO financial_facts (
      source_key, ticker, cik, metric_key, taxonomy, tag, unit,
      period_end, period_type, form, filed_at, value, ingested_at
    ) VALUES ('future-revenue', 'TEST', '1', 'revenue', 'us-gaap', 'Revenue', 'USD',
              '2025-03-31', 'annual', '10-K', ?, 500, ?)
  `).run(dates[70], nowIso());

  const earlier = buildFeatureSnapshot(db, 'TEST', dates[60]);
  const later = buildFeatureSnapshot(db, 'TEST', dates[71]);
  assert.equal(earlier.features.fundamentals.available, false);
  assert.equal(later.features.fundamentals.available, true);
  db.close();
});
