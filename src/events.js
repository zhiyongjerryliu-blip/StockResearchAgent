import { nowIso, toPlainRows } from './db.js';
import { normalizeTicker, parseJson } from './domain.js';
import { createNotification } from './notifications.js';

const CLASSIFIER_VERSION = 'sec-8k-items-v1-2026-09-02';
const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

export const sec8kItemRules = Object.freeze({
  '1.01': { label: '签订重大最终协议', severity: 'P3' },
  '1.02': { label: '终止重大最终协议', severity: 'P1' },
  '1.03': { label: '破产或接管', severity: 'P0' },
  '1.04': { label: '矿山安全停产或违规', severity: 'P2' },
  '2.01': { label: '完成资产收购或处置', severity: 'P2' },
  '2.02': { label: '经营业绩和财务状况', severity: 'P2' },
  '2.03': { label: '新增直接或表外财务义务', severity: 'P2' },
  '2.04': { label: '触发财务义务加速或增加', severity: 'P1' },
  '2.05': { label: '退出或处置活动成本', severity: 'P2' },
  '2.06': { label: '重大资产减值', severity: 'P1' },
  '3.01': { label: '退市通知或不符合持续上市标准', severity: 'P1' },
  '3.02': { label: '未注册股权证券销售', severity: 'P2' },
  '3.03': { label: '证券持有人权利重大变更', severity: 'P2' },
  '4.01': { label: '注册会计师变更', severity: 'P2' },
  '4.02': { label: '历史财务报表不应再被依赖', severity: 'P1' },
  '5.01': { label: '公司控制权变更', severity: 'P2' },
  '5.02': { label: '董事或高管变动', severity: 'P2' },
  '5.03': { label: '公司章程或细则修订', severity: 'P3' },
  '5.07': { label: '股东表决结果', severity: 'P3' },
  '7.01': { label: 'Regulation FD 披露', severity: 'P3' },
  '8.01': { label: '其他重大事件', severity: 'P3' },
  '9.01': { label: '财务报表和附件', severity: 'P3' }
});

export function parseSec8kItems(value) {
  return [...new Set(String(value || '').match(/\b\d+\.\d+\b/g) || [])];
}

export function classifySec8kFiling(filing) {
  const items = parseSec8kItems(filing.items);
  const matches = items.map((item) => ({
    item,
    ...(sec8kItemRules[item] || { label: `未映射事项 ${item}`, severity: 'P3' })
  }));
  const primary = [...matches].sort((left, right) => (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
  ))[0] || { item: null, label: '未标注具体事项的8-K', severity: 'P3' };
  const labels = matches.length
    ? matches.map((match) => `Item ${match.item} ${match.label}`).join('；')
    : 'SEC 元数据未列出具体 Item';
  return {
    eventType: primary.item ? `SEC_8K_ITEM_${primary.item.replace('.', '_')}` : 'SEC_8K_UNSPECIFIED',
    severity: primary.severity,
    primaryItem: primary.item,
    primaryLabel: primary.label,
    items: matches,
    title: `${filing.ticker} 8-K：${primary.label}`,
    summary: `公司提交 Form 8-K，披露事项包括：${labels}。系统按“${primary.label}”规则标记为${primary.severity}，具体影响需核对原文。`
  };
}

function publicEvent(row) {
  return {
    ...row,
    evidence: parseJson(row.evidence_json, [])
  };
}

export function indexSecFilingEvents(db, tickerValue = null) {
  const ticker = tickerValue ? normalizeTicker(tickerValue) : null;
  const filings = toPlainRows(ticker
    ? db.prepare(`
        SELECT * FROM sec_filings
        WHERE ticker = ? AND form IN ('8-K', '8-K/A')
        ORDER BY filed_at, accession_number
      `).all(ticker)
    : db.prepare(`
        SELECT * FROM sec_filings
        WHERE form IN ('8-K', '8-K/A')
        ORDER BY filed_at, accession_number
      `).all());
  const timestamp = nowIso();
  const createdEvents = [];
  const statement = db.prepare(`
    INSERT INTO research_events (
      event_key, ticker, event_date, event_type, title, summary, severity,
      source_type, source_id, source_url, evidence_json, status, detected_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SEC_8K', ?, ?, ?, 'ACTIVE', ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET
      event_date = excluded.event_date,
      event_type = excluded.event_type,
      title = excluded.title,
      summary = excluded.summary,
      severity = excluded.severity,
      source_url = excluded.source_url,
      evidence_json = excluded.evidence_json,
      updated_at = excluded.updated_at
  `);
  for (const filing of filings) {
    const eventKey = `SEC_8K:${filing.accession_number}`;
    const existing = db.prepare('SELECT id FROM research_events WHERE event_key = ?').get(eventKey);
    const classification = classifySec8kFiling(filing);
    const evidence = [{
      source: 'SEC EDGAR',
      accessionNumber: filing.accession_number,
      form: filing.form,
      filedAt: filing.filed_at,
      acceptedAt: filing.accepted_at,
      reportDate: filing.report_date,
      items: classification.items,
      classifierVersion: CLASSIFIER_VERSION,
      sourceUrl: filing.filing_url
    }];
    statement.run(
      eventKey,
      filing.ticker,
      filing.filed_at,
      classification.eventType,
      classification.title,
      classification.summary,
      classification.severity,
      filing.accession_number,
      filing.filing_url,
      JSON.stringify(evidence),
      timestamp,
      timestamp
    );
    if (!existing) {
      createdEvents.push(publicEvent(db.prepare(
        'SELECT * FROM research_events WHERE event_key = ?'
      ).get(eventKey)));
    }
  }
  return {
    ticker,
    filingsIndexed: filings.length,
    created: createdEvents.length,
    createdEvents
  };
}

export async function syncSecFilingEvents(db, tickerValue, options = {}) {
  const ticker = normalizeTicker(tickerValue);
  const indexed = indexSecFilingEvents(db, ticker);
  const notifyAccessions = new Set(options.notifyAccessions || []);
  const notifier = options.notifier || createNotification;
  const isEnabledWatchlist = Boolean(db.prepare(
    'SELECT 1 FROM watchlist_items WHERE ticker = ? AND enabled = 1'
  ).get(ticker));
  let notified = 0;
  if (isEnabledWatchlist && notifyAccessions.size) {
    for (const event of indexed.createdEvents) {
      if (!['P0', 'P1'].includes(event.severity) || !notifyAccessions.has(event.source_id)) continue;
      await notifier(db, {
        ticker,
        severity: event.severity,
        category: 'SEC_RISK_EVENT',
        title: event.title,
        body: `${event.summary} 这是官方文件触发的风险提示，不构成买卖建议。`,
        evidence: event.evidence
      });
      notified += 1;
    }
  }
  return { ...indexed, notified };
}

export function backfillSecFilingEvents(db) {
  return indexSecFilingEvents(db);
}

export function listResearchEvents(db, options = {}) {
  const ticker = options.ticker ? normalizeTicker(options.ticker) : null;
  const severity = options.severity && options.severity !== 'ALL'
    ? String(options.severity).toUpperCase()
    : null;
  if (severity && !Object.hasOwn(SEVERITY_RANK, severity)) throw new Error('事件等级无效');
  const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 100));
  const baseFilters = [];
  const baseParams = [];
  if (ticker) {
    baseFilters.push('e.ticker = ?');
    baseParams.push(ticker);
  } else {
    baseFilters.push('EXISTS (SELECT 1 FROM watchlist_items w WHERE w.ticker = e.ticker)');
  }
  const filters = [...baseFilters];
  const params = [...baseParams];
  if (severity) {
    filters.push('e.severity = ?');
    params.push(severity);
  }
  params.push(limit);
  const events = toPlainRows(db.prepare(`
    SELECT e.*, s.name
    FROM research_events e
    JOIN securities s ON s.ticker = e.ticker
    WHERE ${filters.join(' AND ')}
    ORDER BY e.event_date DESC, e.id DESC
    LIMIT ?
  `).all(...params)).map(publicEvent);
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const countRows = toPlainRows(db.prepare(`
    SELECT e.severity, COUNT(*) AS count
    FROM research_events e
    WHERE ${baseFilters.join(' AND ')}
    GROUP BY e.severity
  `).all(...baseParams));
  for (const row of countRows) counts[row.severity] = Number(row.count);
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM research_events e
    WHERE ${filters.join(' AND ')}
  `).get(...params.slice(0, -1)).count);
  return { events, counts, total };
}
