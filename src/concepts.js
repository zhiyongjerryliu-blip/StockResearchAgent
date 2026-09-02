import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker, parseJson } from './domain.js';

const CONCEPT_VERSION = 'stock-concepts-v1-2026-09-02';

const tickerConcepts = {
  LITE: [{
    key: 'ai_optical_interconnect',
    name: 'AI数据中心高速光互连',
    type: 'DEMAND_DRIVER',
    query: '("optical interconnect" OR "data center optics" OR "silicon photonics") (NVIDIA OR Microsoft OR Amazon OR Google OR hyperscaler)',
    confidence: 0.9,
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1633978/000130817923001000/llite2023_ars.pdf',
    entities: [
      { name: 'NVIDIA', ticker: 'NVDA', role: '需求与生态代理', verifiedDirectRelationship: false },
      { name: 'Microsoft', ticker: 'MSFT', role: '云数据中心需求代理', verifiedDirectRelationship: false },
      { name: 'Amazon', ticker: 'AMZN', role: '云数据中心需求代理', verifiedDirectRelationship: false },
      { name: 'Alphabet', ticker: 'GOOGL', role: '云数据中心需求代理', verifiedDirectRelationship: false }
    ]
  }, {
    key: 'optical_component_capacity',
    name: '光通信器件供需与扩产',
    type: 'SUPPLY_CHAIN',
    query: '("optical components" OR photonics OR Coherent OR Ciena) (capacity OR factory OR supply OR demand OR investment)',
    confidence: 0.85,
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1633978/000130817923001000/llite2023_ars.pdf',
    entities: [
      { name: 'Coherent', ticker: 'COHR', role: '产业链及竞争代理', verifiedDirectRelationship: false },
      { name: 'Ciena', ticker: 'CIEN', role: '下游设备需求代理', verifiedDirectRelationship: false },
      { name: 'Applied Optoelectronics', ticker: 'AAOI', role: '产业链及竞争代理', verifiedDirectRelationship: false }
    ]
  }],
  SNDK: [{
    key: 'nand_supply_pricing',
    name: 'NAND闪存供需与价格周期',
    type: 'INDUSTRY_TREND',
    query: '("NAND flash" OR "flash memory" OR Kioxia OR Micron OR Samsung) (price OR supply OR demand OR capacity OR investment)',
    confidence: 0.95,
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/2023554/000162828026057406/sndk-20260703.htm',
    entities: [
      { name: 'Kioxia', ticker: null, role: '合资制造伙伴', verifiedDirectRelationship: true },
      { name: 'Micron Technology', ticker: 'MU', role: '行业供需代理', verifiedDirectRelationship: false },
      { name: 'Western Digital', ticker: 'WDC', role: '行业生态代理', verifiedDirectRelationship: false },
      { name: 'Samsung Electronics', ticker: null, role: '全球NAND供给代理', verifiedDirectRelationship: false }
    ]
  }, {
    key: 'ai_storage_demand',
    name: 'AI数据中心存储需求',
    type: 'DEMAND_DRIVER',
    query: '("AI data center" OR hyperscaler OR Amazon OR Microsoft OR Google) (storage OR NAND OR "flash memory")',
    confidence: 0.85,
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/2023554/000162828026057406/sndk-20260703.htm',
    entities: [
      { name: 'Amazon', ticker: 'AMZN', role: '云数据中心需求代理', verifiedDirectRelationship: false },
      { name: 'Microsoft', ticker: 'MSFT', role: '云数据中心需求代理', verifiedDirectRelationship: false },
      { name: 'Alphabet', ticker: 'GOOGL', role: '云数据中心需求代理', verifiedDirectRelationship: false }
    ]
  }]
};

function genericConcept(security) {
  const label = security.industry || security.sic_description || security.sector;
  if (!label) return [];
  return [{
    key: 'declared_industry_context',
    name: `${label}行业供需与投资`,
    type: 'INDUSTRY_TREND',
    query: `"${label}" (capacity OR investment OR demand OR supply OR regulation)`,
    confidence: 0.55,
    sourceUrl: null,
    entities: []
  }];
}

export function configureStockConcepts(db, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  const security = toPlain(db.prepare(`
    SELECT ticker, name, sector, industry, sic_description FROM securities WHERE ticker = ?
  `).get(ticker));
  if (!security) throw new Error('股票不存在');
  const concepts = tickerConcepts[ticker] || genericConcept(security);
  const timestamp = nowIso();
  db.prepare('UPDATE stock_concepts SET active = 0, updated_at = ? WHERE ticker = ?')
    .run(timestamp, ticker);
  const statement = db.prepare(`
    INSERT INTO stock_concepts (
      ticker, concept_key, concept_name, concept_type, search_query,
      related_entities_json, confidence, source, source_url, active, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(ticker, concept_key) DO UPDATE SET
      concept_name = excluded.concept_name, concept_type = excluded.concept_type,
      search_query = excluded.search_query, related_entities_json = excluded.related_entities_json,
      confidence = excluded.confidence, source = excluded.source,
      source_url = excluded.source_url, active = 1, updated_at = excluded.updated_at
  `);
  for (const concept of concepts) {
    statement.run(
      ticker, concept.key, concept.name, concept.type, concept.query,
      JSON.stringify(concept.entities), concept.confidence, CONCEPT_VERSION,
      concept.sourceUrl, timestamp
    );
  }
  return listStockConcepts(db, ticker);
}

export function configureWatchlistConcepts(db) {
  const tickers = toPlainRows(db.prepare(
    'SELECT ticker FROM watchlist_items WHERE enabled = 1 ORDER BY ticker'
  ).all());
  return tickers.map(({ ticker }) => configureStockConcepts(db, ticker));
}

export function listStockConcepts(db, tickerValue) {
  const ticker = normalizeTicker(tickerValue);
  return toPlainRows(db.prepare(`
    SELECT * FROM stock_concepts WHERE ticker = ? AND active = 1
    ORDER BY confidence DESC, concept_key
  `).all(ticker)).map((row) => ({
    ...row,
    related_entities: parseJson(row.related_entities_json, [])
  }));
}
