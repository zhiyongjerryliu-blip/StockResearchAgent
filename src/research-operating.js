import { round } from './domain.js';

const OPERATING_MODEL_VERSION = 'operating-bridge-v1';

const METRICS = Object.freeze([
  ['revenue', '营业收入'],
  ['grossProfit', '毛利润'],
  ['operatingIncome', '营业利润'],
  ['netIncome', '合并净利润'],
  ['epsDiluted', 'GAAP摊薄EPS'],
  ['operatingCashFlow', '经营现金流'],
  ['capitalExpenditure', '资本开支现金支出'],
  ['shareRepurchases', '股票回购现金支出'],
  ['dilutedShares', '摊薄加权平均股数']
]);

function number(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function change(current, previous) {
  const currentValue = number(current);
  const previousValue = number(previous);
  if (currentValue == null || previousValue == null) return null;
  const absolute = currentValue - previousValue;
  return {
    absolute: round(absolute, 4),
    percent: previousValue === 0 ? null : round(absolute / Math.abs(previousValue), 6),
    percentStatus: previousValue === 0 ? 'NOT_MEANINGFUL_ZERO_BASE' : 'AVAILABLE'
  };
}

function fact(period, metricKey) {
  return period?.metrics?.[metricKey] || null;
}

function comparablePeriod(periods, index, mode) {
  const current = periods[index];
  if (!current) return null;
  if (mode === 'previous') return periods[index + 1] || null;
  return periods.slice(index + 1).find((candidate) => (
    current.fiscalPeriod && candidate.fiscalPeriod
      ? candidate.fiscalPeriod === current.fiscalPeriod
      : true
  )) || null;
}

function ratio(numerator, denominator) {
  const numeratorValue = number(numerator);
  const denominatorValue = number(denominator);
  if (numeratorValue == null || denominatorValue == null || denominatorValue === 0) return null;
  return round(numeratorValue / denominatorValue, 6);
}

function calculatedMetrics(period) {
  const revenue = fact(period, 'revenue')?.value;
  const grossProfit = fact(period, 'grossProfit')?.value;
  const operatingIncome = fact(period, 'operatingIncome')?.value;
  const netIncome = fact(period, 'netIncome')?.value;
  const operatingCashFlow = fact(period, 'operatingCashFlow')?.value;
  const capitalExpenditure = fact(period, 'capitalExpenditure')?.value;
  return {
    grossMargin: ratio(grossProfit, revenue),
    operatingMargin: ratio(operatingIncome, revenue),
    netMargin: ratio(netIncome, revenue),
    freeCashFlow: number(operatingCashFlow) == null || number(capitalExpenditure) == null
      ? null
      : round(number(operatingCashFlow) - number(capitalExpenditure), 4),
    operatingCashConversion: ratio(operatingCashFlow, netIncome)
  };
}

function periodAnalysis(periods, kind, limit) {
  return periods.slice(0, limit).map((period, index) => {
    const previous = comparablePeriod(periods, index, 'previous');
    const yearAgo = kind === 'quarter'
      ? comparablePeriod(periods, index, 'yearAgo')
      : previous;
    const metrics = Object.fromEntries(METRICS.map(([metricKey, label]) => {
      const currentFact = fact(period, metricKey);
      return [metricKey, {
        label,
        value: number(currentFact?.value),
        unit: currentFact?.unit || null,
        source: currentFact ? {
          filedAt: currentFact.filedAt,
          periodStart: currentFact.periodStart,
          periodEnd: currentFact.periodEnd,
          form: currentFact.form,
          accessionNumber: currentFact.accessionNumber,
          sourceUrl: currentFact.sourceUrl
        } : null,
        sequentialChange: kind === 'quarter' ? change(currentFact?.value, fact(previous, metricKey)?.value) : null,
        yearOverYearChange: change(currentFact?.value, fact(yearAgo, metricKey)?.value)
      }];
    }));
    return {
      periodEnd: period.periodEnd,
      fiscalYear: period.fiscalYear,
      fiscalPeriod: period.fiscalPeriod,
      form: period.form,
      filedAt: period.filedAt,
      comparison: {
        sequentialPeriodEnd: kind === 'quarter' ? previous?.periodEnd || null : null,
        yearAgoPeriodEnd: yearAgo?.periodEnd || null
      },
      metrics,
      calculated: calculatedMetrics(period)
    };
  });
}

export function calculateVolumePriceBridge(volumeChange, aspChange) {
  const volume = Number(volumeChange);
  const asp = Number(aspChange);
  if (!Number.isFinite(volume) || !Number.isFinite(asp)) throw new Error('量价变化必须是有效数字');
  return {
    volumeChange: round(volume, 6),
    aspChange: round(asp, 6),
    combinedRevenueChange: round(((1 + volume) * (1 + asp)) - 1, 6),
    formula: '(1 + 销量变化) × (1 + ASP变化) − 1'
  };
}

function chooseTemplate(company) {
  const text = `${company?.sector || ''} ${company?.industry || ''} ${company?.sic_description || ''}`.toLowerCase();
  if (/semiconductor|memory|storage/.test(text)) {
    return {
      key: 'SEMICONDUCTOR_CYCLE',
      label: '半导体/存储周期模板',
      variables: ['产品销量', 'ASP/产品组合', '库存与供需', '产能利用率与良率', '资本开支', '核心客户认证'],
      note: '当前SEC合并报表通常不披露完整销量、ASP、良率和产品分部；未映射字段保持未知。'
    };
  }
  if (/technology|software|communications|electronic|computer/.test(text)) {
    return {
      key: 'TECHNOLOGY_COMPETITION',
      label: '技术成长/竞争模板',
      variables: ['产品代际', '销量与ASP', '客户认证', '交付阶段', '研发与竞争质量', '旧业务替代风险'],
      note: '合并财务事实用于验证结果，产品经营变量仅在有明确披露或事件证据时填充。'
    };
  }
  return {
    key: 'GENERAL_FINANCIAL',
    label: '通用财务模板',
    variables: ['收入增长', '毛利率', '营业利润率', '经营现金流', '资本开支', '回购与摊薄股数'],
    note: '行业专属经营指标尚未可靠识别，回退到通用财务模板。'
  };
}

function expectationAnalysis(valuation) {
  const target = valuation?.target;
  const estimate = target?.estimate;
  return {
    ntmEps: target?.forwardEps ?? null,
    estimate: estimate || null,
    revision: estimate?.revision || null,
    peerForwardPeMedian: valuation?.peerMedian?.forwardPe ?? null,
    actualVsConsensus: {
      status: 'UNAVAILABLE',
      reason: '当前免费数据链路未保存财报发布前、同一财期的营收/EPS一致预期快照，不能事后用最新预期冒充当时市场预期。'
    },
    companyGuidance: {
      status: 'UNAVAILABLE',
      reason: 'SEC结构化事实不等同于公司指引；尚未接入可验证的指引区间与版本。'
    },
    revenueConsensus: {
      status: 'UNAVAILABLE',
      reason: '当前Alpha Vantage接入只形成可追溯NTM EPS，尚无同口径NTM营收一致预期。'
    }
  };
}

export function buildOperatingAnalysis(sec, valuation) {
  if (!sec || sec.unavailable) {
    return {
      modelVersion: OPERATING_MODEL_VERSION,
      status: 'UNAVAILABLE',
      issues: [sec?.reason || '缺少SEC结构化财务事实'],
      annual: [], quarterly: []
    };
  }
  const annual = periodAnalysis(sec.annual || [], 'annual', 5);
  const quarterly = periodAnalysis(sec.quarterly || [], 'quarter', 8);
  const template = chooseTemplate(sec.company);
  const latest = quarterly[0] || annual[0] || null;
  const missingLatest = METRICS
    .filter(([metricKey]) => latest?.metrics?.[metricKey]?.value == null)
    .map(([, label]) => label);
  const issues = [];
  if (!annual.length) issues.push('缺少可用年度财务期间');
  if (!quarterly.length) issues.push('缺少可用单季度财务期间；不使用YTD数值伪造季度环比');
  if (missingLatest.length) issues.push(`最近期间缺少：${missingLatest.join('、')}`);
  return {
    modelVersion: OPERATING_MODEL_VERSION,
    status: latest ? (issues.length ? 'LIMITED' : 'COMPLETE') : 'UNAVAILABLE',
    accountingScope: {
      statementScope: 'SEC合并报表事实',
      earningsScope: 'netIncome可能为NetIncomeLoss或ProfitLoss；没有额外证据时不称归母净利润',
      cashConversionFormula: '经营现金流 ÷ 同期合并净利润；净利润为0或缺失时不计算',
      freeCashFlowFormula: '经营现金流 − 资本开支现金支出'
    },
    template,
    segmentCoverage: {
      status: 'UNAVAILABLE',
      reason: '当前SEC Company Facts未提供经过业务/地区维度校验的分部明细，不将合并收入推断为分部收入。',
      uncoveredAmount: null
    },
    annual,
    quarterly,
    latest,
    expectations: expectationAnalysis(valuation),
    sensitivityVariables: template.variables.map((name) => ({ name, value: null, status: 'AWAITING_DISCLOSURE_MAPPING' })),
    issues
  };
}
