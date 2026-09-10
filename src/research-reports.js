import { createHash } from 'node:crypto';
import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker, parseJson } from './domain.js';
import { calculatePosition } from './portfolio.js';
import { getSecOverview } from './sec.js';
import { getValuationOverview } from './valuation.js';
import { getPredictionOverview } from './predictions.js';
import { analyzeCapitalFlow, listRecentCapitalFlowDays } from './capital-flow.js';
import { analyzeIntradayFlow } from './intraday-flow.js';
import { getCapitalBehaviorOverview } from './capital-behavior.js';
import { getExternalDriversOverview } from './external-drivers.js';
import { getNewsSentimentSummary } from './news.js';
import { listResearchEvents } from './events.js';
import { buildInvestmentAdvice } from './advice.js';

export const RESEARCH_REPORT_SCHEMA_VERSION = 'research-report-v1';
export const RESEARCH_REPORT_TEMPLATE_VERSION = 'nine-section-v1';

const SECTION_DEFINITIONS = Object.freeze([
  ['summary', '结论摘要'],
  ['operations', '公司与经营驱动'],
  ['expectations', '市场预期与核心争议'],
  ['earnings', '盈利展望'],
  ['valuation', '估值与情景分析'],
  ['market', '价格、成交量与资金行为'],
  ['risks', '催化剂、风险与条件式建议'],
  ['forecast', '1/3/6个月预测及后续验证'],
  ['methodology', '数据来源、计算方法与质量限制']
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function safely(run, fallback = null) {
  try {
    return run();
  } catch (error) {
    return { unavailable: true, reason: error.message, fallback };
  }
}

function security(db, ticker) {
  return toPlain(db.prepare(`
    SELECT s.*, w.enabled, w.note FROM securities s
    JOIN watchlist_items w ON w.ticker = s.ticker WHERE s.ticker = ?
  `).get(ticker));
}

function evidenceForReport(db, ticker, asOf) {
  const filings = toPlainRows(db.prepare(`
    SELECT accession_number AS sourceId, form AS sourceType, filed_at AS publishedAt,
           filing_url AS url, primary_doc_description AS title
    FROM sec_filings WHERE ticker = ? AND filed_at <= ?
    ORDER BY filed_at DESC LIMIT 12
  `).all(ticker, asOf));
  const events = toPlainRows(db.prepare(`
    SELECT event_key AS sourceId, source_type AS sourceType, event_date AS publishedAt,
           source_url AS url, title
    FROM research_events WHERE ticker = ? AND event_date <= ?
    ORDER BY event_date DESC, id DESC LIMIT 20
  `).all(ticker, asOf));
  return [...filings, ...events].map((item, index) => ({
    id: `E${String(index + 1).padStart(3, '0')}`,
    sourceId: item.sourceId,
    sourceType: item.sourceType,
    publishedAt: item.publishedAt,
    title: item.title || item.sourceType,
    url: /^https?:\/\//i.test(item.url || '') ? item.url : null
  }));
}

function buildQuality(position, sec, valuation, prediction, evidence) {
  const issues = [];
  if (position.priceDataStatus !== 'COMPLETE') issues.push(`行情：${position.priceDataStatus}`);
  if (sec?.unavailable) issues.push(`SEC：${sec.reason}`);
  if (valuation?.unavailable) issues.push(`估值：${valuation.reason}`);
  if (prediction?.unavailable) issues.push(`预测：${prediction.reason}`);
  if (!evidence.length) issues.push('尚无可追溯SEC文件或研究事件');
  return { status: issues.length ? 'LIMITED' : 'COMPLETE', issues };
}

function reportSections(snapshot, quality) {
  const { company, position, sec, valuation, predictions, capitalFlow, capitalHistory,
    intradayFlow, capitalBehavior, sentiment, events, drivers, advice, evidence } = snapshot;
  const published = (predictions?.predictions || []).filter((item) => item.publication_status === 'PUBLISHED');
  const limitations = [
    ...quality.issues,
    '公开成交及富途主动方向不能确认最终账户或机构身份',
    '当前基础研报聚合已有数据，不包含尚未实现的分部经营模型或Bull/Base/Bear估值引擎',
    '研究内容不构成自动交易指令'
  ];
  return SECTION_DEFINITIONS.map(([key, title], order) => {
    const data = {
      summary: {
        company, position,
        researchStatus: quality.status,
        publishedPredictionCount: published.length,
        advice: advice?.recommendations || advice,
        highlights: events?.events?.slice?.(0, 3) || []
      },
      operations: {
        latestFinancials: sec?.latest || sec?.metrics || null,
        annualTrends: sec?.annual || sec?.annualTrends || [],
        quarterlyTrends: sec?.quarterly || sec?.quarterlyTrends || [],
        externalDrivers: drivers
      },
      expectations: {
        earningsEstimate: valuation?.target?.estimate || null,
        estimateHistory: valuation?.estimates || [],
        peers: valuation?.peers || [], sentiment,
        supportingEvents: (events?.events || []).filter((item) => !['P0', 'P1'].includes(item.severity)).slice(0, 10),
        opposingEvents: (events?.events || []).filter((item) => ['P0', 'P1'].includes(item.severity)).slice(0, 10)
      },
      earnings: {
        ttmEps: valuation?.target?.ttmEps ?? null,
        ttmMethod: valuation?.target?.ttmMethod || null,
        ttmPeriods: valuation?.target?.ttmPeriods || [],
        ntmEps: valuation?.target?.forwardEps ?? null,
        estimate: valuation?.target?.estimate || null,
        estimatePeriods: valuation?.target?.estimate?.periods || []
      },
      valuation: {
        current: valuation?.target || valuation,
        peers: valuation?.peers || [],
        history: valuation?.historicalValuation || null,
        scenarioStatus: 'NOT_IMPLEMENTED'
      },
      market: { position, capitalFlow, capitalHistory, intradayFlow, capitalBehavior },
      risks: { events: events?.events || [], drivers, advice },
      forecast: {
        predictions: predictions?.predictions || [],
        reliability: predictions?.reliability || [],
        changes: predictions?.changes || [],
        modelComparisons: predictions?.modelComparisons || [],
        publicationNote: published.length
          ? '仅PUBLISHED期限属于已通过当前发布状态的预测。'
          : '当前没有通过发布状态的正式预测；其余数值仅供模型研究。'
      },
      methodology: {
        asOf: snapshot.asOf,
        priceDate: position.priceDate,
        schemaVersion: RESEARCH_REPORT_SCHEMA_VERSION,
        templateVersion: RESEARCH_REPORT_TEMPLATE_VERSION,
        evidence,
        limitations
      }
    }[key];
    return { key, order: order + 1, title, status: data ? 'AVAILABLE' : 'UNAVAILABLE', data };
  });
}

export function buildResearchReportSnapshot(db, tickerValue, asOf) {
  const ticker = normalizeTicker(tickerValue);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ''))) throw new Error('研报截止日期无效');
  const company = security(db, ticker);
  if (!company) throw new Error('股票不在股票池中');
  const position = calculatePosition(db, ticker, asOf);
  const sec = safely(() => getSecOverview(db, ticker, asOf));
  const valuation = safely(() => getValuationOverview(db, ticker, { asOf }));
  const predictions = safely(() => getPredictionOverview(db, ticker, asOf));
  const capitalFlow = safely(() => analyzeCapitalFlow(db, ticker, asOf));
  const capitalHistory = safely(() => listRecentCapitalFlowDays(db, ticker, asOf, 10), []);
  const intradayFlow = safely(() => analyzeIntradayFlow(db, ticker, asOf));
  const capitalBehavior = safely(() => getCapitalBehaviorOverview(db, ticker, asOf));
  const sentiment = safely(() => getNewsSentimentSummary(db, { ticker, asOf }));
  const events = safely(() => {
    const listed = listResearchEvents(db, { ticker, limit: 100 });
    const filtered = listed.events.filter((item) => item.event_date <= asOf).slice(0, 50);
    return { ...listed, events: filtered, total: filtered.length };
  }, { events: [] });
  const drivers = safely(() => getExternalDriversOverview(db, ticker, asOf));
  const advice = safely(() => buildInvestmentAdvice(db, ticker, asOf));
  const evidence = evidenceForReport(db, ticker, asOf);
  const input = { ticker, asOf, company, position, sec, valuation, predictions, capitalFlow,
    capitalHistory, intradayFlow, capitalBehavior, sentiment, events, drivers, advice, evidence };
  const quality = buildQuality(position, sec, valuation, predictions, evidence);
  return { ...input, quality, sections: reportSections(input, quality) };
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id, ticker: row.ticker, asOf: row.as_of, generatedAt: row.generated_at,
    analysisPrice: row.analysis_price, priceDate: row.price_date, inputHash: row.input_hash,
    schemaVersion: row.schema_version, templateVersion: row.template_version,
    generationMode: row.generation_mode, qualityStatus: row.quality_status,
    content: parseJson(row.content_json, {}), evidence: parseJson(row.evidence_json, []),
    limitations: parseJson(row.limitations_json, [])
  };
}

export function generateResearchReport(db, input) {
  const snapshot = buildResearchReportSnapshot(db, input.ticker, input.asOf);
  const inputHash = hash(snapshot);
  const existing = toPlain(db.prepare(`
    SELECT * FROM research_reports
    WHERE ticker = ? AND as_of = ? AND input_hash = ?
      AND schema_version = ? AND template_version = ? LIMIT 1
  `).get(snapshot.ticker, snapshot.asOf, inputHash,
    RESEARCH_REPORT_SCHEMA_VERSION, RESEARCH_REPORT_TEMPLATE_VERSION));
  if (existing) return { report: hydrate(existing), created: false };
  const generatedAt = nowIso();
  const limitations = snapshot.sections.find((item) => item.key === 'methodology')?.data?.limitations || [];
  const result = db.prepare(`
    INSERT INTO research_reports (
      ticker, as_of, generated_at, analysis_price, price_date, input_hash,
      schema_version, template_version, generation_mode, quality_status,
      content_json, evidence_json, limitations_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.ticker, snapshot.asOf, generatedAt, snapshot.position.currentPrice,
    snapshot.position.priceDate, inputHash, RESEARCH_REPORT_SCHEMA_VERSION,
    RESEARCH_REPORT_TEMPLATE_VERSION, input.generationMode || 'MANUAL',
    snapshot.quality.status, JSON.stringify(snapshot), JSON.stringify(snapshot.evidence),
    JSON.stringify(limitations)
  );
  return { report: getResearchReport(db, Number(result.lastInsertRowid)), created: true };
}

export function createResearchReportJob(db, input) {
  const ticker = normalizeTicker(input.ticker);
  const asOf = String(input.asOf || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('研报截止日期无效');
  if (!security(db, ticker)) throw new Error('股票不在股票池中');
  const active = toPlain(db.prepare(`
    SELECT * FROM research_report_jobs
    WHERE ticker = ? AND as_of = ? AND status IN ('QUEUED','RUNNING')
    ORDER BY id DESC LIMIT 1
  `).get(ticker, asOf));
  if (active) return { ...active, merged: true };
  const result = db.prepare(`
    INSERT INTO research_report_jobs (ticker, as_of, status, created_at)
    VALUES (?, ?, 'QUEUED', ?)
  `).run(ticker, asOf, nowIso());
  return { ...toPlain(db.prepare('SELECT * FROM research_report_jobs WHERE id = ?').get(result.lastInsertRowid)), merged: false };
}

export function getResearchReportJob(db, idValue) {
  const id = Number.parseInt(idValue, 10);
  if (!Number.isInteger(id) || id < 1) throw new Error('研报任务ID无效');
  return toPlain(db.prepare('SELECT * FROM research_report_jobs WHERE id = ?').get(id));
}

export function runResearchReportJob(db, idValue) {
  const job = getResearchReportJob(db, idValue);
  if (!job) throw new Error('研报任务不存在');
  if (!['QUEUED', 'RUNNING'].includes(job.status)) return job;
  const startedAt = nowIso();
  db.prepare(`
    UPDATE research_report_jobs SET status = 'RUNNING', started_at = ?, error_message = NULL
    WHERE id = ?
  `).run(startedAt, job.id);
  try {
    const generated = generateResearchReport(db, {
      ticker: job.ticker, asOf: job.as_of, generationMode: 'MANUAL'
    });
    db.prepare(`
      UPDATE research_report_jobs SET status = ?, report_id = ?, finished_at = ? WHERE id = ?
    `).run(generated.created ? 'SUCCESS' : 'NO_CHANGE', generated.report.id, nowIso(), job.id);
  } catch (error) {
    db.prepare(`
      UPDATE research_report_jobs SET status = 'FAILED', error_message = ?, finished_at = ? WHERE id = ?
    `).run(error.message, nowIso(), job.id);
  }
  return getResearchReportJob(db, job.id);
}

export function listResearchReports(db, tickerValue, limit = 30) {
  const ticker = normalizeTicker(tickerValue);
  return toPlainRows(db.prepare(`
    SELECT id, ticker, as_of, generated_at, analysis_price, price_date, input_hash,
           schema_version, template_version, generation_mode, quality_status,
           content_json, evidence_json, limitations_json
    FROM research_reports WHERE ticker = ? ORDER BY as_of DESC, id DESC LIMIT ?
  `).all(ticker, Math.min(100, Math.max(1, Number(limit) || 30)))).map(hydrate);
}

export function getResearchReport(db, idValue) {
  const id = Number.parseInt(idValue, 10);
  if (!Number.isInteger(id) || id < 1) throw new Error('研报ID无效');
  return hydrate(toPlain(db.prepare('SELECT * FROM research_reports WHERE id = ?').get(id)));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function human(value) {
  if (value == null) return '<span class="muted">数据不足</span>';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return escapeHtml(value);
  }
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

export function renderResearchReportHtml(report) {
  if (!report) throw new Error('研报不存在');
  const sanitized = structuredClone(report);
  const publicPosition = sanitized.content?.position ? {
    ticker: sanitized.content.position.ticker,
    currentPrice: sanitized.content.position.currentPrice,
    previousClose: sanitized.content.position.previousClose,
    priceDate: sanitized.content.position.priceDate,
    previousPriceDate: sanitized.content.position.previousPriceDate,
    priceDataStatus: sanitized.content.position.priceDataStatus,
    dailyReturn: sanitized.content.position.dailyReturn
  } : null;
  if (sanitized.content) {
    sanitized.content.position = publicPosition;
    sanitized.content.advice = {
      redacted: true,
      reason: '默认导出不包含持仓个性化建议'
    };
  }
  for (const section of sanitized.content?.sections || []) {
    if (section.data?.position) section.data.position = publicPosition;
    if (section.data?.advice) section.data.advice = { redacted: true, reason: '默认导出不包含持仓个性化建议' };
    if (section.data?.summary?.position) section.data.summary.position = publicPosition;
    if (section.data?.summary?.advice) section.data.summary.advice = { redacted: true };
  }
  const sections = (sanitized.content.sections || []).map((section) => `
    <section id="${escapeHtml(section.key)}"><h2>${section.order}. ${escapeHtml(section.title)}</h2>${human(section.data)}</section>
  `).join('');
  const frozenJson = JSON.stringify(sanitized).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.ticker)} 个股综合研报</title><style>
  :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{max-width:1100px;margin:0 auto;padding:32px;line-height:1.65;background:#0d1117;color:#e6edf3}header,section{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin:16px 0}h1,h2{margin-top:0}small,.muted{color:#8b949e}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}@media print{body{background:white;color:#111}header,section{border:1px solid #ddd;background:white;break-inside:avoid}}</style></head><body>
  <header><small>StockResearchAgent · 冻结版本 #${report.id}</small><h1>${escapeHtml(report.ticker)} 个股综合研报</h1><p>研究截止 ${escapeHtml(report.asOf)} · 行情 ${escapeHtml(report.priceDate || '数据不足')} · 生成 ${escapeHtml(report.generatedAt)} · 状态 ${escapeHtml(report.qualityStatus)}</p></header>
  ${sections}<script type="application/json" id="research-report-data">${frozenJson}</script></body></html>`;
}
