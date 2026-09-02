import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker } from './domain.js';

const CATALOG_VERSION = 'industry-leaders-v1-2026-09-02';

// 股票级映射优先于宽泛行业分类，来源用于说明业务可比性而非投资建议。
const tickerRules = {
  LITE: {
    industry: '光通信与光子器件',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1633978/000130817923001000/llite2023_ars.pdf',
    candidates: [
      { ticker: 'COHR', name: 'Coherent Corp.' },
      { ticker: 'CIEN', name: 'Ciena Corporation' }
    ]
  },
  SNDK: {
    industry: 'NAND闪存与数据存储',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/2023554/000162828026057406/sndk-20260703.htm',
    candidates: [
      { ticker: 'MU', name: 'Micron Technology, Inc.' },
      { ticker: 'WDC', name: 'Western Digital Corporation' }
    ]
  }
};

// SIC目录提供通用回退；多放一个候选，避免目标公司本身出现在候选中。
const sicRules = {
  '3571': { industry: '计算机硬件', candidates: [['DELL', 'Dell Technologies Inc.'], ['HPE', 'Hewlett Packard Enterprise'], ['SMCI', 'Super Micro Computer, Inc.']] },
  '3572': { industry: '数据存储设备', candidates: [['STX', 'Seagate Technology Holdings plc'], ['WDC', 'Western Digital Corporation'], ['SNDK', 'Sandisk Corporation']] },
  '3661': { industry: '通信设备', candidates: [['CSCO', 'Cisco Systems, Inc.'], ['CIEN', 'Ciena Corporation'], ['NOK', 'Nokia Oyj']] },
  '3663': { industry: '无线通信设备', candidates: [['QCOM', 'QUALCOMM Incorporated'], ['ERIC', 'Telefonaktiebolaget LM Ericsson'], ['NOK', 'Nokia Oyj']] },
  '3669': { industry: '光通信与通信设备', candidates: [['COHR', 'Coherent Corp.'], ['CIEN', 'Ciena Corporation'], ['CSCO', 'Cisco Systems, Inc.']] },
  '3674': { industry: '半导体', candidates: [['NVDA', 'NVIDIA Corporation'], ['AVGO', 'Broadcom Inc.'], ['AMD', 'Advanced Micro Devices, Inc.']] },
  '3711': { industry: '汽车制造', candidates: [['TSLA', 'Tesla, Inc.'], ['GM', 'General Motors Company'], ['F', 'Ford Motor Company']] },
  '4813': { industry: '电信运营', candidates: [['TMUS', 'T-Mobile US, Inc.'], ['VZ', 'Verizon Communications Inc.'], ['T', 'AT&T Inc.']] },
  '6021': { industry: '大型银行', candidates: [['JPM', 'JPMorgan Chase & Co.'], ['BAC', 'Bank of America Corporation'], ['C', 'Citigroup Inc.']] },
  '6211': { industry: '证券经纪', candidates: [['SCHW', 'The Charles Schwab Corporation'], ['IBKR', 'Interactive Brokers Group, Inc.'], ['HOOD', 'Robinhood Markets, Inc.']] },
  '7372': { industry: '软件', candidates: [['MSFT', 'Microsoft Corporation'], ['ORCL', 'Oracle Corporation'], ['ADBE', 'Adobe Inc.']] },
  '7374': { industry: '云计算与数据服务', candidates: [['AMZN', 'Amazon.com, Inc.'], ['MSFT', 'Microsoft Corporation'], ['GOOGL', 'Alphabet Inc.']] },
  '7812': { industry: '影视娱乐', candidates: [['DIS', 'The Walt Disney Company'], ['NFLX', 'Netflix, Inc.'], ['WBD', 'Warner Bros. Discovery, Inc.']] }
};

const textRules = [
  { pattern: /semiconductor|半导体|芯片/i, sic: '3674' },
  { pattern: /storage|存储/i, sic: '3572' },
  { pattern: /communication|optical|通信|光学|光子/i, sic: '3669' },
  { pattern: /software|软件/i, sic: '7372' },
  { pattern: /bank|银行/i, sic: '6021' }
];

function normalizeCandidates(rule) {
  return (rule?.candidates || []).map((candidate) => Array.isArray(candidate)
    ? { ticker: candidate[0], name: candidate[1] }
    : candidate);
}

export function selectIndustryLeaders(security) {
  const ticker = normalizeTicker(security.ticker);
  let rule = tickerRules[ticker] || null;
  let method = rule ? 'TICKER_RULE' : null;
  if (!rule && security.sic && sicRules[String(security.sic)]) {
    rule = sicRules[String(security.sic)];
    method = 'SEC_SIC';
  }
  if (!rule) {
    const searchable = [security.sic_description, security.industry, security.sector].filter(Boolean).join(' ');
    const textRule = textRules.find((candidate) => candidate.pattern.test(searchable));
    if (textRule) {
      rule = sicRules[textRule.sic];
      method = 'INDUSTRY_TEXT';
    }
  }
  if (!rule) {
    return {
      matched: false,
      ticker,
      peers: [],
      reason: '尚无可验证的股票或SEC SIC行业龙头映射'
    };
  }
  const peers = normalizeCandidates(rule)
    .filter((candidate) => candidate.ticker !== ticker)
    .slice(0, 2);
  return {
    matched: peers.length === 2,
    ticker,
    industry: rule.industry,
    method,
    source: CATALOG_VERSION,
    sourceUrl: rule.sourceUrl || null,
    peers,
    reason: peers.length === 2 ? null : '行业目录中不足两个可用上市公司'
  };
}

function ensurePeerSecurity(db, peer, selection) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO securities (
      ticker, name, sector, industry, benchmark, currency, created_at, updated_at
    ) VALUES (?, ?, 'Industry Peer', ?, 'SPY', 'USD', ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      name = COALESCE(securities.name, excluded.name),
      industry = COALESCE(securities.industry, excluded.industry),
      updated_at = excluded.updated_at
  `).run(peer.ticker, peer.name, selection.industry, timestamp, timestamp);
}

export function configureAutomaticPeers(db, tickerValue, effectiveDate = new Date().toISOString().slice(0, 10)) {
  const ticker = normalizeTicker(tickerValue);
  const security = toPlain(db.prepare(`
    SELECT ticker, name, sic, sic_description, sector, industry
    FROM securities WHERE ticker = ?
  `).get(ticker));
  if (!security) throw new Error('股票不存在');
  const selection = selectIndustryLeaders(security);
  if (!selection.matched) return { ...selection, changed: false };
  const selectedTickers = new Set(selection.peers.map((peer) => peer.ticker));
  let changed = false;

  db.exec('BEGIN');
  try {
    const active = toPlainRows(db.prepare(`
      SELECT id, related_ticker FROM company_relationships
      WHERE ticker = ? AND relationship_type = 'COMPETITOR' AND active_to IS NULL
    `).all(ticker));
    for (const relationship of active) {
      if (!selectedTickers.has(relationship.related_ticker)) {
        db.prepare('UPDATE company_relationships SET active_to = ? WHERE id = ?')
          .run(effectiveDate, relationship.id);
        changed = true;
      }
    }
    for (const peer of selection.peers) {
      ensurePeerSecurity(db, peer, selection);
      const existing = db.prepare(`
        SELECT id FROM company_relationships
        WHERE ticker = ? AND related_ticker = ? AND relationship_type = 'COMPETITOR' AND active_to IS NULL
      `).get(ticker, peer.ticker);
      if (!existing) {
        db.prepare(`
          INSERT INTO company_relationships (
            ticker, related_ticker, relationship_type, source, active_from, active_to
          ) VALUES (?, ?, 'COMPETITOR', ?, ?, NULL)
        `).run(ticker, peer.ticker, selection.source, effectiveDate);
        changed = true;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ...selection, changed };
}

export function configureWatchlistPeers(db, effectiveDate = new Date().toISOString().slice(0, 10)) {
  const stocks = toPlainRows(db.prepare(`
    SELECT ticker FROM watchlist_items WHERE enabled = 1 ORDER BY ticker
  `).all());
  return stocks.map(({ ticker }) => configureAutomaticPeers(db, ticker, effectiveDate));
}
