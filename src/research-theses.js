import { createHash } from 'node:crypto';
import { round } from './domain.js';

export const RESEARCH_THESIS_RULE_VERSION = 'thesis-rules-v1';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.eventKey || item.evidenceId || `${item.url || ''}:${item.title || ''}:${item.periodEnd || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function eventDirection(event) {
  const explicit = event.evidence?.find?.((item) => item.direction)?.direction;
  if (['POSITIVE', 'NEGATIVE', 'MIXED'].includes(explicit)) return explicit;
  const riskType = `${event.source_type || ''} ${event.event_type || ''}`.toUpperCase();
  if (/NEWS_RISK|CUSTOMER_LOSS|GUIDANCE_CUT|CAPACITY_CUT|BUYBACK_STOP/.test(riskType)) return 'NEGATIVE';
  if (['P0', 'P1'].includes(event.severity)) return 'NEGATIVE';
  return 'MIXED';
}

function eventEvidence(event) {
  return {
    evidenceId: event.event_key || `EVENT:${event.id}`,
    eventKey: event.event_key || null,
    kind: 'EVENT',
    date: event.event_date,
    title: event.title,
    severity: event.severity,
    sourceType: event.source_type,
    url: event.source_url || null,
    verificationStatus: event.status,
    direction: eventDirection(event)
  };
}

function metricEvidence(key, title, value, periodEnd, source, interpretation) {
  return {
    evidenceId: `METRIC:${key}:${periodEnd || 'UNKNOWN'}`,
    kind: 'METRIC', title, value: round(value, 6), periodEnd, source, interpretation
  };
}

function card(definition, observation) {
  return {
    ...definition,
    ruleVersion: RESEARCH_THESIS_RULE_VERSION,
    status: observation.status,
    score: observation.score,
    supportingEvidence: dedupe(observation.supportingEvidence || []),
    opposingEvidence: dedupe(observation.opposingEvidence || []),
    unknownReason: observation.unknownReason || null,
    lastCheckedAt: observation.asOf
  };
}

function earningsRevisionThesis(valuation, asOf) {
  const revision = valuation?.target?.estimate?.revision?.thirtyDay;
  const changePct = Number(revision?.changePct);
  const definition = {
    key: 'EARNINGS_REVISION_IMPROVING',
    title: 'NTM盈利预期正在改善',
    direction: 'BULLISH', horizon: '1-6个月',
    affectedVariable: 'NTM EPS与动态PE',
    conditions: {
      strengthened: '30日NTM EPS修订幅度 > +2%',
      falsified: '30日NTM EPS修订幅度 < -2%',
      pending: '修订数据缺失或处于±2%区间'
    }
  };
  if (!Number.isFinite(changePct)) return card(definition, {
    asOf, status: 'PENDING', score: 0,
    unknownReason: '没有可复核的30日NTM EPS修订快照；未知不等于证伪。'
  });
  const evidence = metricEvidence(
    'NTM_EPS_REVISION_30D', '30日NTM EPS修订', changePct,
    valuation.target.estimate.asOf, valuation.target.estimate.source, changePct > 0 ? '上修' : changePct < 0 ? '下修' : '持平'
  );
  if (changePct > 0.02) return card(definition, { asOf, status: 'STRENGTHENED', score: 1, supportingEvidence: [evidence] });
  if (changePct < -0.02) return card(definition, { asOf, status: 'FALSIFIED', score: -1, opposingEvidence: [evidence] });
  return card(definition, { asOf, status: 'PENDING', score: 0, supportingEvidence: changePct > 0 ? [evidence] : [], opposingEvidence: changePct < 0 ? [evidence] : [] });
}

function profitabilityThesis(operating, asOf) {
  const latest = operating?.latest;
  const current = Number(latest?.calculated?.operatingMargin);
  const yearAgo = operating?.quarterly?.find?.((item) => item.periodEnd === latest?.comparison?.yearAgoPeriodEnd);
  const previous = Number(yearAgo?.calculated?.operatingMargin);
  const difference = current - previous;
  const definition = {
    key: 'OPERATING_MARGIN_IMPROVING',
    title: '营业利润率同比改善',
    direction: 'BULLISH', horizon: '下一次财报至12个月',
    affectedVariable: '营业利润与EPS',
    conditions: {
      strengthened: '同口径单季度营业利润率同比提高 > 1个百分点',
      falsified: '同口径单季度营业利润率同比下降 > 1个百分点',
      pending: '变化在±1个百分点内或缺少同季度对比'
    }
  };
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return card(definition, {
    asOf, status: 'PENDING', score: 0,
    unknownReason: '缺少同口径单季度营业收入/营业利润或去年同期；不使用YTD拼接。'
  });
  const evidence = metricEvidence(
    'OPERATING_MARGIN_YOY', '营业利润率同比变化（百分点）', difference,
    latest.periodEnd, latest.metrics?.operatingIncome?.source?.sourceUrl, difference > 0 ? '改善' : difference < 0 ? '下降' : '持平'
  );
  if (difference > 0.01) return card(definition, { asOf, status: 'STRENGTHENED', score: 1, supportingEvidence: [evidence] });
  if (difference < -0.01) return card(definition, { asOf, status: 'FALSIFIED', score: -1, opposingEvidence: [evidence] });
  return card(definition, { asOf, status: 'PENDING', score: 0, supportingEvidence: difference > 0 ? [evidence] : [], opposingEvidence: difference < 0 ? [evidence] : [] });
}

function catalystThesis(events, asOf) {
  const eventList = events?.events || [];
  const positives = dedupe(eventList.filter((event) => eventDirection(event) === 'POSITIVE').map(eventEvidence));
  const negatives = dedupe(eventList.filter((event) => eventDirection(event) === 'NEGATIVE').map(eventEvidence));
  const definition = {
    key: 'CATALYSTS_OUTWEIGH_RISKS',
    title: '已核实催化剂能够覆盖重大风险',
    direction: 'BULLISH', horizon: '1-6个月',
    affectedVariable: '收入、成本、股数或估值风险溢价',
    conditions: {
      strengthened: '至少1项正向事件且没有P0/P1反向事件，仍需核实事件原文',
      weakened: '存在P0/P1或明确负向事件',
      pending: '没有方向明确且可追溯的事件证据'
    }
  };
  if (!positives.length && !negatives.length) return card(definition, {
    asOf, status: 'PENDING', score: 0,
    unknownReason: '没有方向明确的可追溯事件；没有公告不等于没有订单或催化剂。'
  });
  const status = negatives.length ? 'WEAKENED' : 'STRENGTHENED';
  return card(definition, {
    asOf, status, score: positives.length - negatives.length,
    supportingEvidence: positives, opposingEvidence: negatives
  });
}

const CHAIN_RULES = [
  [/BUYBACK/, '股数/资本配置', 'EPS与估值', '1-6个月', '后续SEC回购现金支出、实际股数和授权进度'],
  [/CAPACITY|PRODUCTION/, '产能/产量/单位成本', '收入、毛利率与资本开支', '3-18个月', '建设、试产、量产、利用率及订单兑现'],
  [/INVESTMENT|CAPEX/, '资本开支/现金', '折旧、自由现金流与未来产能', '3-24个月', '现金支出、项目里程碑与收入贡献'],
  [/SUPPLY|CUSTOMER|CONTRACT/, '订单/核心客户', '销量、ASP与收入', '1-12个月', '合同范围、交付、收入确认和客户集中度'],
  [/GUIDANCE|EARNINGS/, '公司指引/市场预期', 'EPS预期与估值倍数', '1-6个月', '下一份正式指引及一致预期修订'],
  [/RATE|TREASURY|FED/, '无风险利率/风险溢价', '估值倍数与融资成本', '1-6个月', '美债收益率与联邦基金预期变化']
];

function transmissionChain(event) {
  const type = `${event.event_type || ''} ${event.title || ''}`.toUpperCase();
  const matched = CHAIN_RULES.find(([pattern]) => pattern.test(type));
  const [, exposure, variable, horizon, verification] = matched || [null, '相关经营或风险暴露', '经营结果或估值假设', '待评估', '核对公司正式披露和后续可观测指标'];
  return {
    eventKey: event.event_key || `EVENT:${event.id}`,
    eventDate: event.event_date,
    eventTitle: event.title,
    sourceUrl: event.source_url || null,
    sourceStatus: event.status,
    direction: eventDirection(event),
    exposedBusiness: exposure,
    affectedVariable: variable,
    horizon,
    verificationCondition: verification,
    causalityStatus: 'HYPOTHESIS_NOT_PROVEN',
    explanation: '该链路用于说明可能影响路径，不表示事件已经造成股价变化。'
  };
}

export function buildResearchTheses(input) {
  const theses = [
    earningsRevisionThesis(input.valuation, input.asOf),
    profitabilityThesis(input.operating, input.asOf),
    catalystThesis(input.events, input.asOf)
  ];
  return {
    ruleVersion: RESEARCH_THESIS_RULE_VERSION,
    asOf: input.asOf,
    theses,
    transmissionChains: dedupe((input.events?.events || []).map(transmissionChain)),
    adviceReference: input.advice?.recommendations || input.advice || null,
    advicePolicy: '论点仅解释和跟踪证据，不修改既有建议动作、可靠度、阈值或模型权重。'
  };
}

export function persistResearchTheses(db, report, analysis, observedAt) {
  const select = db.prepare('SELECT * FROM research_theses WHERE ticker = ? AND thesis_key = ?');
  const insert = db.prepare(`
    INSERT INTO research_theses (
      ticker, thesis_key, title, direction, horizon, definition_hash,
      conditions_json, current_status, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE research_theses SET title = ?, direction = ?, horizon = ?, definition_hash = ?,
      conditions_json = ?, current_status = ?, version = version + ?, updated_at = ? WHERE id = ?
  `);
  const observe = db.prepare(`
    INSERT OR IGNORE INTO research_thesis_observations (
      thesis_id, report_id, as_of, status, score, supporting_json, opposing_json,
      evidence_hash, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const thesis of analysis?.theses || []) {
    const definition = {
      title: thesis.title, direction: thesis.direction, horizon: thesis.horizon,
      affectedVariable: thesis.affectedVariable, conditions: thesis.conditions,
      ruleVersion: thesis.ruleVersion
    };
    const definitionHash = hash(definition);
    let row = select.get(report.ticker, thesis.key);
    if (!row) {
      const result = insert.run(
        report.ticker, thesis.key, thesis.title, thesis.direction, thesis.horizon,
        definitionHash, JSON.stringify(thesis.conditions), thesis.status, observedAt, observedAt
      );
      row = { id: Number(result.lastInsertRowid) };
    } else {
      update.run(
        thesis.title, thesis.direction, thesis.horizon, definitionHash,
        JSON.stringify(thesis.conditions), thesis.status,
        row.definition_hash === definitionHash ? 0 : 1, observedAt, row.id
      );
    }
    const supporting = thesis.supportingEvidence || [];
    const opposing = thesis.opposingEvidence || [];
    observe.run(
      row.id, report.id, report.asOf, thesis.status, thesis.score,
      JSON.stringify(supporting), JSON.stringify(opposing),
      hash({ supporting, opposing, status: thesis.status }), observedAt
    );
  }
}
