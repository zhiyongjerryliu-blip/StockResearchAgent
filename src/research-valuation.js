import { round } from './domain.js';

export const RESEARCH_VALUATION_FORMULA_VERSION = 'pe-scenario-v1';

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function peBasis(valuation) {
  const peer = positive(valuation?.peerMedian?.forwardPe);
  const peerSamples = Number(valuation?.peerMedian?.forwardPeSamples || 0);
  if (peer && peerSamples >= 2) {
    return { value: peer, source: 'PEER_FORWARD_PE_MEDIAN', sampleCount: peerSamples, label: '有效同业动态PE中位数' };
  }
  const historical = valuation?.historicalValuation?.forwardPe;
  const historyMedian = positive(historical?.median);
  if (historyMedian && Number(historical?.sampleCount || 0) >= Number(historical?.minimumSamples || 20)) {
    return {
      value: historyMedian,
      source: 'HISTORICAL_FORWARD_PE_MEDIAN',
      sampleCount: historical.sampleCount,
      label: `${valuation.historicalValuation.lookbackYears || 5}年历史动态PE中位数`
    };
  }
  return null;
}

function epsLevels(valuation) {
  const estimate = valuation?.target?.estimate;
  const base = positive(valuation?.target?.forwardEps);
  if (!base) return null;
  const low = positive(estimate?.epsLow);
  const high = positive(estimate?.epsHigh);
  return {
    BEAR: {
      value: low || base * 0.85,
      source: low ? 'PROVIDER_ESTIMATE_LOW' : 'SYSTEM_SENSITIVITY_MINUS_15_PERCENT'
    },
    BASE: { value: base, source: 'NTM_CONSENSUS_EPS' },
    BULL: {
      value: high || base * 1.15,
      source: high ? 'PROVIDER_ESTIMATE_HIGH' : 'SYSTEM_SENSITIVITY_PLUS_15_PERCENT'
    }
  };
}

function shareConsistency(operating) {
  const latest = operating?.latest?.metrics || {};
  const profit = Number(latest.netIncome?.value);
  const eps = Number(latest.epsDiluted?.value);
  const declared = Number(latest.dilutedShares?.value);
  if (![profit, eps, declared].every(Number.isFinite) || eps === 0 || declared <= 0) {
    return {
      status: 'UNAVAILABLE', inferredShares: null, declaredDilutedShares: Number.isFinite(declared) ? declared : null,
      reason: '缺少同一期间合并净利润、GAAP摊薄EPS或摊薄加权平均股数，无法核对隐含股数。'
    };
  }
  const inferred = profit / eps;
  const difference = (inferred / declared) - 1;
  return {
    status: Math.abs(difference) > 0.05 ? 'CONFLICT' : 'CONSISTENT',
    inferredShares: round(inferred, 6),
    declaredDilutedShares: round(declared, 6),
    differencePct: round(difference, 6),
    tolerancePct: 0.05,
    reason: Math.abs(difference) > 0.05
      ? '利润÷EPS与声明摊薄加权股数相差超过5%；可能来自合并/归母、季度/累计、单位或每股口径差异，需先核实。'
      : '利润÷EPS与声明摊薄加权股数在5%容差内。'
  };
}

function scenario(key, eps, pe, analysisPrice, basis) {
  const conditionalValue = eps.value * pe;
  return {
    key,
    label: ({ BEAR: '悲观', BASE: '基准', BULL: '乐观' })[key],
    status: 'AVAILABLE',
    eps: round(eps.value, 4),
    epsSource: eps.source,
    pe: round(pe, 2),
    peSource: basis.source,
    peBasis: basis,
    conditionalValue: round(conditionalValue, 4),
    upsideDownside: positive(analysisPrice) ? round((conditionalValue / analysisPrice) - 1, 6) : null,
    formula: '条件估值 = NTM EPS情景 × 动态PE情景',
    probability: null,
    trigger: key === 'BEAR'
      ? '盈利或估值倍数落入悲观假设'
      : key === 'BULL' ? '盈利和估值倍数兑现乐观假设' : '盈利及估值维持显式基准假设'
  };
}

export function buildPeScenarioAnalysis(valuation, operating) {
  const analysisPrice = positive(valuation?.target?.price);
  const levels = epsLevels(valuation);
  const basis = peBasis(valuation);
  const shares = shareConsistency(operating);
  const issues = [];
  if (!levels) issues.push('NTM EPS缺失、为零或为负，PE条件估值不适用');
  if (!basis) issues.push('有效同业不足2家且历史动态PE样本未达门槛，不能凭当前价格反推估值倍数');
  if (!analysisPrice) issues.push('缺少正数分析价，无法计算相对空间');
  if (shares.status === 'CONFLICT') issues.push(shares.reason);
  if (!levels || !basis) {
    return {
      formulaVersion: RESEARCH_VALUATION_FORMULA_VERSION,
      status: 'UNAVAILABLE',
      classification: 'CONDITIONAL_VALUATION_NOT_PRICE_FORECAST',
      analysisPrice,
      scenarios: [], sensitivity: [], shareConsistency: shares, issues,
      publicationIsolation: '不属于21/63/126交易日正式预测，不带概率，不解锁买卖建议。'
    };
  }
  const peLevels = {
    BEAR: basis.value * 0.8,
    BASE: basis.value,
    BULL: basis.value * 1.2
  };
  const scenarios = ['BEAR', 'BASE', 'BULL'].map((key) => scenario(key, levels[key], peLevels[key], analysisPrice, basis));
  const sensitivity = ['BEAR', 'BASE', 'BULL'].map((epsKey) => ({
    epsKey,
    eps: round(levels[epsKey].value, 4),
    values: ['BEAR', 'BASE', 'BULL'].map((peKey) => ({
      peKey,
      pe: round(peLevels[peKey], 2),
      conditionalValue: round(levels[epsKey].value * peLevels[peKey], 4)
    }))
  }));
  return {
    formulaVersion: RESEARCH_VALUATION_FORMULA_VERSION,
    status: issues.length ? 'LIMITED' : 'AVAILABLE',
    classification: 'CONDITIONAL_VALUATION_NOT_PRICE_FORECAST',
    analysisPrice,
    earningsPeriod: valuation.target.estimate?.periodEnd || 'NTM',
    scenarios,
    sensitivity,
    shareConsistency: shares,
    assumptions: {
      eps: levels,
      pe: {
        basis,
        bear: '基准倍数×0.8（系统敏感性假设）',
        bull: '基准倍数×1.2（系统敏感性假设）'
      },
      probabilityCalibrated: false
    },
    issues,
    publicationIsolation: '条件估值演示，非正式价格预测；情景概率未校准，不改变既有预测发布状态或投资建议。'
  };
}

export function persistValuationScenarios(db, report, scenarioAnalysis, createdAt) {
  if (!scenarioAnalysis?.scenarios?.length) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO valuation_scenarios (
      report_id, ticker, as_of, scenario_key, status, eps_value, pe_multiple,
      conditional_value, upside_downside, formula_version, assumptions_json,
      quality_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of scenarioAnalysis.scenarios) {
    insert.run(
      report.id, report.ticker, report.asOf, item.key, item.status, item.eps, item.pe,
      item.conditionalValue, item.upsideDownside, scenarioAnalysis.formulaVersion,
      JSON.stringify({ epsSource: item.epsSource, peBasis: item.peBasis, trigger: item.trigger }),
      JSON.stringify({ shareConsistency: scenarioAnalysis.shareConsistency, issues: scenarioAnalysis.issues }),
      createdAt
    );
  }
}
