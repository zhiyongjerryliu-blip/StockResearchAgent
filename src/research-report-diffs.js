import { nowIso, toPlain } from './db.js';
import { parseJson } from './domain.js';

export const RESEARCH_REPORT_DIFF_VERSION = 'research-report-diff-v1';

function reportProjection(report) {
  const content = report.content || {};
  const target = content.valuation?.target || {};
  const operatingLatest = content.operating?.latest || {};
  return {
    report: {
      asOf: report.asOf,
      analysisPrice: report.analysisPrice,
      priceDate: report.priceDate,
      qualityStatus: report.qualityStatus,
      schemaVersion: report.schemaVersion,
      templateVersion: report.templateVersion
    },
    operating: {
      periodEnd: operatingLatest.periodEnd || null,
      metrics: Object.fromEntries(Object.entries(operatingLatest.metrics || {}).map(([key, metric]) => [key, {
        value: metric?.value ?? null,
        yearOverYearPercent: metric?.yearOverYearChange?.percent ?? null,
        sequentialPercent: metric?.sequentialChange?.percent ?? null
      }])),
      calculated: operatingLatest.calculated || null
    },
    expectations: {
      ntmEps: target.forwardEps ?? null,
      estimateAsOf: target.estimate?.asOf || null,
      revision7d: target.estimate?.revision?.sevenDay?.changePct ?? null,
      revision30d: target.estimate?.revision?.thirtyDay?.changePct ?? null
    },
    valuation: {
      staticPe: target.staticPe ?? null,
      forwardPe: target.forwardPe ?? null,
      peerForwardPeMedian: content.valuation?.peerMedian?.forwardPe ?? null,
      scenarios: Object.fromEntries((content.valuationScenarios?.scenarios || []).map((item) => [item.key, {
        eps: item.eps, pe: item.pe, conditionalValue: item.conditionalValue, status: item.status
      }]))
    },
    theses: Object.fromEntries((content.theses?.theses || []).map((item) => [item.key, {
      status: item.status, score: item.score,
      supportingCount: item.supportingEvidence?.length || 0,
      opposingCount: item.opposingEvidence?.length || 0
    }])),
    predictions: Object.fromEntries((content.predictions?.predictions || []).map((item) => [
      `${item.horizon_days || item.horizonDays || 'UNKNOWN'}:${item.model_version || item.modelVersion || 'UNKNOWN'}`,
      {
        targetDate: item.target_date || item.targetDate || null,
        publicationStatus: item.publication_status || item.publicationStatus || null,
        expectedReturn: item.return_p50 ?? item.expectedReturn ?? null,
        p50: item.price_p50 ?? item.p50Price ?? null,
        reliabilityScore: item.reliability_score ?? item.reliabilityScore ?? null
      }
    ])),
    events: (content.events?.events || []).map((item) => item.event_key || item.id).filter(Boolean).sort(),
    evidence: (report.evidence || []).map((item) => item.sourceId || item.id).filter(Boolean).sort()
  };
}

function scalar(value) {
  return value == null || ['string', 'number', 'boolean'].includes(typeof value);
}

function flatten(value, prefix = '', output = {}) {
  if (scalar(value)) {
    output[prefix] = value;
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, output));
    if (!value.length) output[prefix] = [];
    return output;
  }
  const entries = Object.entries(value || {});
  if (!entries.length) output[prefix] = {};
  for (const [key, item] of entries) flatten(item, prefix ? `${prefix}.${key}` : key, output);
  return output;
}

function category(path) {
  if (path.startsWith('report.analysisPrice') || path.startsWith('report.priceDate')) return 'PRICE';
  if (path.startsWith('operating')) return 'OPERATING';
  if (path.startsWith('expectations')) return 'EXPECTATION';
  if (path.startsWith('valuation')) return 'VALUATION';
  if (path.startsWith('theses')) return 'THESIS';
  if (path.startsWith('predictions')) return 'PREDICTION';
  if (path.startsWith('events')) return 'EVENT';
  if (path.startsWith('evidence')) return 'EVIDENCE';
  return 'REPORT_META';
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildResearchReportDiff(fromReport, toReport) {
  if (!fromReport || !toReport) throw new Error('对比需要两份有效研报');
  if (fromReport.ticker !== toReport.ticker) throw new Error('只能对比同一股票的研报');
  if (fromReport.id === toReport.id) throw new Error('请选择两个不同研报版本');
  const fromFlat = flatten(reportProjection(fromReport));
  const toFlat = flatten(reportProjection(toReport));
  const paths = [...new Set([...Object.keys(fromFlat), ...Object.keys(toFlat)])].sort();
  const changes = paths.flatMap((path) => {
    if (equal(fromFlat[path], toFlat[path])) return [];
    const changeCategory = category(path);
    return [{
      path,
      category: changeCategory,
      changeType: path === 'report.asOf' ? 'ROLLING_DATE'
        : path.includes('Version') ? 'RULE_OR_MODEL_CHANGE' : 'NEW_INFORMATION_OR_CORRECTION',
      oldValue: Object.hasOwn(fromFlat, path) ? fromFlat[path] : null,
      newValue: Object.hasOwn(toFlat, path) ? toFlat[path] : null,
      material: !['REPORT_META'].includes(changeCategory)
    }];
  });
  const counts = changes.reduce((result, item) => {
    result[item.category] = (result[item.category] || 0) + 1;
    return result;
  }, {});
  const warnings = [];
  if (fromReport.schemaVersion !== toReport.schemaVersion) warnings.push('报告Schema版本不同，部分字段可能不可直接比较。');
  if (fromReport.templateVersion !== toReport.templateVersion) warnings.push('报告模板/规则版本不同，变化可能来自计算规则升级。');
  return {
    version: RESEARCH_REPORT_DIFF_VERSION,
    ticker: fromReport.ticker,
    fromReport: { id: fromReport.id, asOf: fromReport.asOf, generatedAt: fromReport.generatedAt },
    toReport: { id: toReport.id, asOf: toReport.asOf, generatedAt: toReport.generatedAt },
    changeCount: changes.length,
    materialChangeCount: changes.filter((item) => item.material).length,
    counts,
    warnings,
    changes
  };
}

export function persistResearchReportDiff(db, fromReport, toReport) {
  const comparison = buildResearchReportDiff(fromReport, toReport);
  db.prepare(`
    INSERT OR IGNORE INTO research_report_diffs (
      ticker, from_report_id, to_report_id, change_count, material_change_count,
      comparison_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    comparison.ticker, fromReport.id, toReport.id, comparison.changeCount,
    comparison.materialChangeCount, JSON.stringify(comparison), nowIso()
  );
  return comparison;
}

export function getSavedResearchReportDiff(db, fromId, toId) {
  const row = toPlain(db.prepare(`
    SELECT * FROM research_report_diffs WHERE from_report_id = ? AND to_report_id = ?
  `).get(fromId, toId));
  return row ? parseJson(row.comparison_json, null) : null;
}
