import { config } from './config.js';
import { round } from './domain.js';

export const reliabilityWeights = Object.freeze({
  directionAccuracy: 0.30,
  probabilityCalibration: 0.15,
  intervalCoverage: 0.15,
  benchmarkSkill: 0.15,
  regimeStability: 0.15,
  dataQuality: 0.10
});

export function minimumSamples(horizonDays) {
  if (horizonDays <= 21) return 60;
  if (horizonDays <= 63) return 32;
  return 16;
}

function metric(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new Error(`${name}必须在0到100之间`);
  }
  return number;
}

export function calculateReliability(input, gate = config.reliabilityGate) {
  const scores = {
    directionAccuracy: metric(input.directionAccuracy, '方向准确率'),
    probabilityCalibration: metric(input.probabilityCalibration, '概率校准度'),
    intervalCoverage: metric(input.intervalCoverage, '区间覆盖率'),
    benchmarkSkill: metric(input.benchmarkSkill, '基准预测能力'),
    regimeStability: metric(input.regimeStability, '市场状态稳定性'),
    dataQuality: metric(input.dataQuality, '数据质量')
  };
  const effectiveSamples = Number.parseInt(input.effectiveSamples, 10);
  if (!Number.isInteger(effectiveSamples) || effectiveSamples < 0) {
    throw new Error('有效样本量无效');
  }
  const requiredSamples = minimumSamples(input.horizonDays);
  const compositeScore = Object.entries(reliabilityWeights)
    .reduce((sum, [key, weight]) => sum + scores[key] * weight, 0);

  let status = 'REJECTED';
  if (effectiveSamples < requiredSamples) status = 'INSUFFICIENT';
  else if (compositeScore >= gate) status = 'PUBLISHED';
  else if (compositeScore >= gate - 10) status = 'OBSERVE';

  return {
    ...scores,
    effectiveSamples,
    requiredSamples,
    compositeScore: round(compositeScore, 2),
    gate,
    status
  };
}
