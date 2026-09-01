import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReliability, minimumSamples } from '../src/reliability.js';

test('综合可靠度达到85且样本充分时允许发布', () => {
  const result = calculateReliability({
    horizonDays: 63,
    directionAccuracy: 88,
    probabilityCalibration: 86,
    intervalCoverage: 84,
    benchmarkSkill: 87,
    regimeStability: 85,
    dataQuality: 92,
    effectiveSamples: 40
  });
  assert.equal(result.compositeScore, 86.9);
  assert.equal(result.status, 'PUBLISHED');
  assert.equal(result.requiredSamples, 32);
});

test('分数达标但样本不足时不得发布', () => {
  const result = calculateReliability({
    horizonDays: 126,
    directionAccuracy: 95,
    probabilityCalibration: 95,
    intervalCoverage: 95,
    benchmarkSkill: 95,
    regimeStability: 95,
    dataQuality: 95,
    effectiveSamples: 8
  });
  assert.equal(result.status, 'INSUFFICIENT');
  assert.equal(minimumSamples(126), 16);
});

test('无效指标会被拒绝', () => {
  assert.throws(() => calculateReliability({
    horizonDays: 21,
    directionAccuracy: 101,
    probabilityCalibration: 90,
    intervalCoverage: 90,
    benchmarkSkill: 90,
    regimeStability: 90,
    dataQuality: 90,
    effectiveSamples: 100
  }), /0到100/);
});
