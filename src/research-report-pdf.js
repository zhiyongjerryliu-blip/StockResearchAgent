import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { sanitizeResearchReportForExport } from './research-reports.js';

const FONT_CANDIDATES = [
  { path: '/System/Library/Fonts/STHeiti Medium.ttc', family: 'STHeitiSC-Medium' },
  { path: '/System/Library/Fonts/Hiragino Sans GB.ttc', family: 'HiraginoSansGB-W3' },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' }
];
const C = Object.freeze({ ink: '#172033', muted: '#667085', faint: '#F6F8FB', line: '#DCE2EA', accent: '#0F766E', accentSoft: '#E6F5F2', positive: '#D92D20', negative: '#079455', warning: '#B54708', white: '#FFFFFF' });
const HORIZONS = Object.freeze({ 21: '1个月', 63: '3个月', 126: '6个月' });

function num(value) { return value == null || !Number.isFinite(Number(value)) ? null : Number(value); }
function decimal(value, digits = 2) { const n = num(value); return n == null ? '数据不足' : n.toFixed(digits); }
function money(value) { const n = num(value); return n == null ? '数据不足' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }
function compact(value) { const n = num(value); return n == null ? '数据不足' : new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(n); }
function percent(value, digits = 2) { const n = num(value); return n == null ? '数据不足' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`; }
function accuracyPercent(value) { const n = num(value); return n == null ? '数据不足' : `${(Math.abs(n) > 1 ? n : n * 100).toFixed(2)}%`; }
function sectionData(report, key) { return report.content?.sections?.find((item) => item.key === key)?.data || {}; }
function adviceRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.advice)) return value.advice;
  if (Array.isArray(value?.recommendations)) return value.recommendations;
  return [];
}

function pdfFont(options) {
  const explicit = options.fontPath || process.env.RESEARCH_PDF_FONT_PATH;
  const known = FONT_CANDIDATES.find((item) => item.path === explicit);
  const selected = explicit
    ? { path: explicit, family: options.fontFamily || process.env.RESEARCH_PDF_FONT_FAMILY || known?.family }
    : FONT_CANDIDATES.find((item) => fs.existsSync(item.path));
  if (!selected?.path || !fs.existsSync(selected.path)) throw new Error('缺少中文PDF字体；请通过 RESEARCH_PDF_FONT_PATH 配置中文TTF/TTC字体');
  if (selected.path.endsWith('.ttc') && !selected.family) {
    throw new Error('TTC字体需要通过 RESEARCH_PDF_FONT_FAMILY 指定PostScript字体名称');
  }
  return selected;
}

function writer(doc) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const ensure = (height = 40) => {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom - 24) doc.addPage();
  };
  const note = (text, warning = false) => {
    if (!text) return;
    const height = doc.heightOfString(String(text), { width: width - 20, fontSize: 9 }) + 16;
    ensure(height + 8);
    const y = doc.y;
    doc.roundedRect(left, y, width, height, 5).fill(warning ? '#FFF4E8' : C.faint);
    doc.fillColor(warning ? C.warning : C.muted).fontSize(9).text(String(text), left + 10, y + 8, { width: width - 20 });
    doc.y = y + height + 8;
  };
  const section = (order, title, status = 'AVAILABLE') => {
    ensure(64);
    doc.moveDown(0.7).fillColor(C.accent).fontSize(9).text(`${order}/9  ${status}`, left);
    doc.fillColor(C.ink).fontSize(17).text(title, { width }).moveDown(0.35);
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(C.line).lineWidth(0.6).stroke().moveDown(0.7);
  };
  const metrics = (items, columns = 3) => {
    const gap = 8;
    const cellWidth = (width - gap * (columns - 1)) / columns;
    for (let index = 0; index < items.length; index += columns) {
      const row = items.slice(index, index + columns);
      const height = Math.max(52, ...row.map((item) => doc.heightOfString(String(item.value ?? '数据不足'), { width: cellWidth - 16, fontSize: 11 }) + 33));
      ensure(height + 8);
      const y = doc.y;
      row.forEach((item, offset) => {
        const x = left + offset * (cellWidth + gap);
        doc.roundedRect(x, y, cellWidth, height, 5).fillAndStroke(C.faint, C.line);
        doc.fillColor(C.muted).fontSize(8).text(String(item.label), x + 8, y + 8, { width: cellWidth - 16 });
        doc.fillColor(item.color || C.ink).fontSize(11).text(String(item.value ?? '数据不足'), x + 8, y + 25, { width: cellWidth - 16 });
      });
      doc.y = y + height + 8;
    }
  };
  const rows = (headers, values, ratios = null) => {
    if (!values.length) return note('当前没有可展示的数据。');
    const widths = ratios || headers.map(() => 1 / headers.length);
    const xs = [];
    let cursor = left;
    widths.forEach((ratio) => { xs.push(cursor); cursor += width * ratio; });
    const rowHeight = (cells, header = false) => {
      const heights = cells.map((cell, index) => doc.heightOfString(String(cell ?? '—'), { width: width * widths[index] - 10, fontSize: header ? 8 : 8.5 }));
      return Math.max(header ? 25 : 24, Math.max(...heights) + 12);
    };
    const draw = (cells, header = false) => {
      const height = rowHeight(cells, header);
      const y = doc.y;
      doc.rect(left, y, width, height).fillAndStroke(header ? C.accentSoft : C.white, C.line);
      cells.forEach((cell, index) => doc.fillColor(header ? C.accent : C.ink).fontSize(header ? 8 : 8.5).text(String(cell ?? '—'), xs[index] + 5, y + 6, { width: width * widths[index] - 10 }));
      doc.y = y + height;
    };
    const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
    if (doc.y + rowHeight(headers, true) + rowHeight(values[0]) > bottom()) doc.addPage();
    draw(headers, true);
    values.forEach((value) => {
      if (doc.y + rowHeight(value) > bottom()) {
        doc.addPage();
        draw(headers, true);
      }
      draw(value);
    });
    doc.moveDown(0.7);
  };
  const bullets = (values, limit = 10) => {
    const list = values.filter(Boolean).slice(0, limit);
    if (!list.length) return note('当前没有可展示的数据。');
    for (const value of list) {
      const text = String(value);
      ensure(doc.heightOfString(text, { width: width - 20, fontSize: 9 }) + 5);
      doc.fillColor(C.accent).fontSize(9).text('•', left, doc.y, { continued: true });
      doc.fillColor(C.ink).text(`  ${text}`, { width: width - 12 }).moveDown(0.25);
    }
  };
  return { note, section, metrics, rows, bullets };
}

function summary(w, report) {
  const data = sectionData(report, 'summary');
  const position = data.position || {};
  const advice = adviceRows(data.advice);
  w.section(1, '结论摘要', data.researchStatus || 'AVAILABLE');
  w.metrics([
    { label: '分析价格', value: money(position.currentPrice) },
    { label: '当日涨跌', value: percent(position.dailyReturn), color: num(position.dailyReturn) >= 0 ? C.positive : C.negative },
    { label: '正式发布预测', value: `${data.publishedPredictionCount || 0} 个期限` }
  ]);
  w.note(data.researchStatus === 'COMPLETE' ? '报告核心数据完整，可继续结合各章节证据复核。' : '报告存在缺失或受限数据；未知项保持未知，不以推测补齐。', data.researchStatus !== 'COMPLETE');
  w.rows(['期限', '倾向', '建议', '置信度', '发布状态'], advice.map((item) => [item.horizonLabel || HORIZONS[item.horizonDays] || '—', item.stance || '—', item.actionLabel || item.action || '—', `${decimal(item.confidenceScore, 1)}分`, item.publicationStatus || '—']), [0.14, 0.15, 0.27, 0.18, 0.26]);
  w.bullets((data.highlights || []).map((item) => `${item.event_date || ''} ${item.title || ''}（${item.severity || '未评级'}）`), 5);
}

function operations(w, report) {
  const operating = sectionData(report, 'operations').operating || {};
  const latest = operating.latest;
  w.section(2, '公司与经营驱动', operating.status || 'UNAVAILABLE');
  w.note(`${operating.template?.label || '通用模板'}；${operating.accountingScope?.statementScope || '财务口径待确认'}`);
  if (!latest) return w.note((operating.issues || ['缺少可用经营财务数据']).join('；'), true);
  w.rows(['指标', '最新值', '环比', '同比', '期间'], Object.values(latest.metrics || {}).map((metric) => [metric.label, ['USD', 'shares'].includes(metric.unit) ? compact(metric.value) : decimal(metric.value, 4), percent(metric.sequentialChange?.percent), percent(metric.yearOverYearChange?.percent), metric.source?.periodEnd || '—']), [0.24, 0.2, 0.16, 0.16, 0.24]);
  w.metrics([
    { label: '毛利率', value: percent(latest.calculated?.grossMargin) },
    { label: '营业利润率', value: percent(latest.calculated?.operatingMargin) },
    { label: '净利率', value: percent(latest.calculated?.netMargin) },
    { label: '自由现金流', value: compact(latest.calculated?.freeCashFlow) },
    { label: '经营现金转换', value: decimal(latest.calculated?.operatingCashConversion, 2) }
  ]);
}

function expectations(w, report) {
  const data = sectionData(report, 'expectations');
  const expected = data.expectations || {};
  w.section(3, '市场预期与核心争议');
  w.metrics([
    { label: 'NTM预期EPS', value: decimal(expected.ntmEps, 2) },
    { label: '同业动态PE中位数', value: expected.peerForwardPeMedian == null ? '数据不足' : `${decimal(expected.peerForwardPeMedian, 2)}×` },
    { label: '7日EPS修订', value: percent(expected.revision?.sevenDay?.changePct) },
    { label: '30日EPS修订', value: percent(expected.revision?.thirtyDay?.changePct) }
  ]);
  w.rows(['论点', '状态', '期限', '支持/反对'], (data.thesisCards || []).map((item) => [item.title, item.status, item.horizon, `${item.supportingEvidence?.length || 0}/${item.opposingEvidence?.length || 0}`]), [0.38, 0.18, 0.26, 0.18]);
  const unknown = ['actualVsConsensus', 'companyGuidance', 'revenueConsensus'].map((key) => expected[key]).filter((item) => item?.status === 'UNAVAILABLE').map((item) => item.reason);
  if (unknown.length) w.bullets(unknown, 4);
}

function earnings(w, report) {
  const data = sectionData(report, 'earnings');
  const latest = data.operatingTrend?.latest;
  w.section(4, '盈利展望');
  w.metrics([
    { label: 'TTM EPS', value: decimal(data.ttmEps, 2) }, { label: 'NTM EPS', value: decimal(data.ntmEps, 2) },
    { label: 'TTM计算方法', value: data.ttmMethod || '数据不足' }, { label: '最新财务期间', value: latest?.periodEnd || '数据不足' }
  ], 2);
  w.rows(['季度', '收入', '营业利润', '净利润', '摊薄EPS'], (data.operatingTrend?.quarterly || []).slice(0, 6).map((item) => [item.periodEnd, compact(item.metrics?.revenue?.value), compact(item.metrics?.operatingIncome?.value), compact(item.metrics?.netIncome?.value), decimal(item.metrics?.epsDiluted?.value, 2)]), [0.19, 0.21, 0.21, 0.21, 0.18]);
  if (data.estimate?.source) w.note(`预期来源：${data.estimate.source}；基准日：${data.estimate.asOf || '未记录'}。`);
  else w.note('缺少可追溯的一致预期来源或财报发布前快照，不能判断超预期或低于预期。', true);
}

function valuation(w, report) {
  const data = sectionData(report, 'valuation');
  const current = data.current || {};
  const scenarios = data.scenarios || {};
  w.section(5, '估值与情景分析', scenarios.status || 'AVAILABLE');
  w.metrics([
    { label: '静态PE', value: current.staticPe == null ? '数据不足' : `${decimal(current.staticPe, 2)}×` },
    { label: '动态PE', value: current.forwardPe == null ? '数据不足' : `${decimal(current.forwardPe, 2)}×` },
    { label: 'TTM EPS', value: decimal(current.ttmEps, 2) }, { label: 'NTM EPS', value: decimal(current.forwardEps, 2) }
  ]);
  w.note(scenarios.publicationIsolation || '估值情景是条件演示，不等同于正式价格预测。', true);
  w.rows(['情景', 'EPS', 'PE', '条件估值', '相对分析价'], (scenarios.scenarios || []).map((item) => [item.label, decimal(item.eps, 2), `${decimal(item.pe, 2)}×`, money(item.conditionalValue), percent(item.upsideDownside)]), [0.18, 0.18, 0.18, 0.24, 0.22]);
}

function market(w, report) {
  const data = sectionData(report, 'market');
  const position = data.position || {};
  const flow = data.capitalFlow || {};
  const intraday = data.intradayFlow || {};
  const behavior = data.capitalBehavior?.latest || data.capitalBehavior || {};
  w.section(6, '价格、成交量与资金行为');
  w.metrics([
    { label: '收盘价', value: money(position.currentPrice) }, { label: '当日涨跌', value: percent(position.dailyReturn) },
    { label: '日线资金信号', value: flow.signalLabel || '数据不足' }, { label: '连续资金阶段', value: behavior.stageLabel || '数据不足' },
    { label: '主动成交信号', value: intraday.signalLabel || '数据不足' }, { label: '量比20日', value: flow.metrics?.relativeVolume == null ? '数据不足' : `${decimal(flow.metrics.relativeVolume, 2)}倍` }
  ]);
  w.note(flow.explanation || '公开成交数据只能用于概率推断，不能确认机构或最终账户身份。');
  w.rows(['日期', '收盘', '涨跌', '成交量', '量比', '资金行为'], (data.capitalHistory || []).slice(0, 10).map((item) => [item.priceDate || item.asOf, money(item.close), percent(item.dailyReturn), compact(item.volume), item.relativeVolume == null ? '—' : `${decimal(item.relativeVolume, 2)}倍`, item.signalLabel || '—']), [0.17, 0.16, 0.15, 0.17, 0.15, 0.2]);
}

function risks(w, report) {
  const data = sectionData(report, 'risks');
  w.section(7, '催化剂、风险与条件式建议');
  w.rows(['论点', '状态', '分数', '支持/反对'], (data.thesisCards || []).map((item) => [item.title, item.status, decimal(item.score, 1), `${item.supportingEvidence?.length || 0}/${item.opposingEvidence?.length || 0}`]), [0.42, 0.2, 0.14, 0.24]);
  w.rows(['日期', '事件', '方向', '影响变量', '期限'], (data.transmissionChains || []).slice(0, 10).map((item) => [item.eventDate, item.eventTitle, item.direction, item.affectedVariable, item.horizon]), [0.15, 0.35, 0.13, 0.24, 0.13]);
  w.bullets(adviceRows(data.advice).map((item) => item.advice || `${item.horizonLabel || ''}：${item.actionLabel || item.action || ''}`), 4);
  w.note(data.advicePolicy || '所有建议均为复核提示，不执行自动交易。', true);
}

function forecast(w, report) {
  const data = sectionData(report, 'forecast');
  w.section(8, '1/3/6个月预测及后续验证');
  w.note(data.publicationNote || '未通过发布闸门的预测不展示正式目标价和收益区间。', true);
  w.rows(['期限', '目标日', '方向', '可靠度', '状态', 'P50'], (data.predictions || []).map((item) => [HORIZONS[item.horizon_days] || `${item.horizon_days}日`, item.target_date || '—', item.rationale?.predictedDirection || '—', `${decimal(item.reliability_score, 1)}分`, item.publication_status || '—', item.publication_status === 'PUBLISHED' ? money(item.price_p50) : '未发布']), [0.13, 0.18, 0.16, 0.17, 0.2, 0.16]);
  w.rows(['期限', '有效样本', '方向准确率', '可靠度', '状态'], (data.reliability || []).map((item) => [HORIZONS[item.horizon_days] || `${item.horizon_days}日`, item.effective_samples ?? '—', accuracyPercent(item.direction_accuracy), `${decimal(item.composite_score, 1)}分`, item.status || '—']), [0.16, 0.2, 0.22, 0.22, 0.2]);
}

function methodology(w, report) {
  const data = sectionData(report, 'methodology');
  w.section(9, '数据来源、计算方法与质量限制');
  w.metrics([
    { label: '研究截止', value: data.asOf || report.asOf }, { label: '行情日期', value: data.priceDate || report.priceDate || '数据不足' },
    { label: '结构版本', value: data.schemaVersion || report.schemaVersion }, { label: '模板版本', value: data.templateVersion || report.templateVersion }
  ], 2);
  w.bullets(data.limitations || report.limitations || [], 12);
  const evidence = data.evidence || report.evidence || [];
  w.rows(['编号', '日期', '类型', '来源标题'], evidence.slice(0, 30).map((item) => [item.id, item.publishedAt || '—', item.sourceType || '—', item.title || '—']), [0.1, 0.18, 0.18, 0.54]);
  if (evidence.length > 30) w.note(`证据共 ${evidence.length} 条；PDF展示前30条，完整冻结记录保存在本地数据库。`);
}

export function renderResearchReportPdf(report, options = {}) {
  if (!report) throw new Error('研报不存在');
  const sanitized = sanitizeResearchReportForExport(report);
  const selectedFont = pdfFont(options);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margins: { top: 46, bottom: 48, left: 42, right: 42 }, bufferPages: true, info: { Title: `${sanitized.ticker} 个股综合研报`, Author: 'StockResearchAgent', Subject: `冻结版本 #${sanitized.id}` } });
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.registerFont('ResearchCjk', selectedFont.path, selectedFont.family).font('ResearchCjk');
    const w = writer(doc);
    doc.fillColor(C.accent).fontSize(10).text(`STOCKRESEARCHAGENT · 冻结版本 #${sanitized.id}`).moveDown(0.6);
    doc.fillColor(C.ink).fontSize(25).text(`${sanitized.ticker} 个股综合研报`);
    doc.fillColor(C.muted).fontSize(11).text(sanitized.content?.company?.name || '公司名称待补充').moveDown(1);
    w.metrics([{ label: '研究截止', value: sanitized.asOf }, { label: '行情日期', value: sanitized.priceDate || '数据不足' }, { label: '分析价格', value: money(sanitized.analysisPrice) }, { label: '数据质量', value: sanitized.qualityStatus }], 2);
    w.note('本PDF从冻结研报生成。默认不包含持仓数量、成本、个人盈亏或个性化仓位建议；研究内容不构成交易指令。', true);
    summary(w, sanitized); operations(w, sanitized); expectations(w, sanitized); earnings(w, sanitized);
    valuation(w, sanitized); market(w, sanitized); risks(w, sanitized); forecast(w, sanitized); methodology(w, sanitized);
    const range = doc.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page += 1) {
      doc.switchToPage(page);
      const originalBottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fillColor(C.muted).fontSize(8);
      doc.text(`${sanitized.ticker} · ${sanitized.asOf} · 仅供个人研究`, 42, doc.page.height - 30, { width: 360, lineBreak: false });
      doc.text(`第 ${page + 1} / ${range.count} 页`, doc.page.width - 120, doc.page.height - 30, { width: 78, align: 'right', lineBreak: false });
      doc.page.margins.bottom = originalBottomMargin;
    }
    doc.end();
  });
}
