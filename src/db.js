import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS securities (
  ticker TEXT PRIMARY KEY,
  name TEXT,
  exchange TEXT,
  cik TEXT,
  sic TEXT,
  sic_description TEXT,
  sector TEXT,
  industry TEXT,
  benchmark TEXT NOT NULL DEFAULT 'SPY',
  industry_etf TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  ticker TEXT PRIMARY KEY REFERENCES securities(ticker) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  risk_tags TEXT NOT NULL DEFAULT '[]',
  continue_after_exit INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  related_ticker TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  active_from TEXT NOT NULL,
  active_to TEXT,
  UNIQUE(ticker, related_ticker, relationship_type, active_from)
);

CREATE INDEX IF NOT EXISTS idx_company_relationships_active
ON company_relationships(ticker, relationship_type, active_to);

CREATE TABLE IF NOT EXISTS stock_concepts (
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  concept_key TEXT NOT NULL,
  concept_name TEXT NOT NULL,
  concept_type TEXT NOT NULL,
  search_query TEXT NOT NULL,
  related_entities_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL,
  source_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(ticker, concept_key)
);

CREATE INDEX IF NOT EXISTS idx_stock_concepts_active
ON stock_concepts(ticker, active, concept_type);

CREATE TABLE IF NOT EXISTS earnings_estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  estimate_type TEXT NOT NULL CHECK(estimate_type IN ('NTM_EPS')),
  as_of TEXT NOT NULL,
  period_end TEXT,
  eps_value REAL NOT NULL,
  eps_high REAL,
  eps_low REAL,
  analyst_count INTEGER,
  source TEXT NOT NULL,
  source_url TEXT,
  provider TEXT NOT NULL DEFAULT 'manual',
  calculation_method TEXT,
  estimate_basis TEXT,
  quality_status TEXT,
  note TEXT,
  fetched_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_earnings_estimates_lookup
ON earnings_estimates(ticker, estimate_type, as_of DESC, id DESC);

CREATE TABLE IF NOT EXISTS earnings_estimate_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES earnings_estimates(id) ON DELETE CASCADE,
  period_end TEXT NOT NULL,
  horizon TEXT NOT NULL CHECK(horizon IN ('fiscal quarter','fiscal year')),
  eps_average REAL NOT NULL,
  eps_high REAL,
  eps_low REAL,
  analyst_count INTEGER,
  eps_average_7_days_ago REAL,
  eps_average_30_days_ago REAL,
  eps_average_60_days_ago REAL,
  eps_average_90_days_ago REAL,
  revision_up_7_days INTEGER,
  revision_down_7_days INTEGER,
  revision_up_30_days INTEGER,
  revision_down_30_days INTEGER,
  ntm_weight REAL NOT NULL DEFAULT 0,
  included_in_ntm INTEGER NOT NULL DEFAULT 0,
  UNIQUE(estimate_id, period_end, horizon)
);

CREATE INDEX IF NOT EXISTS idx_earnings_estimate_periods_estimate
ON earnings_estimate_periods(estimate_id, period_end);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL REFERENCES securities(ticker),
  side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
  trade_time TEXT NOT NULL,
  quantity REAL NOT NULL CHECK(quantity > 0),
  price REAL NOT NULL CHECK(price >= 0),
  fee REAL NOT NULL DEFAULT 0 CHECK(fee >= 0),
  note TEXT,
  import_batch_id INTEGER,
  import_row_number INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_ticker_time
ON transactions(ticker, trade_time, id);

CREATE TABLE IF NOT EXISTS transaction_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL UNIQUE,
  row_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prices_daily (
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  trade_date TEXT NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  close REAL NOT NULL,
  adjusted_close REAL,
  volume REAL,
  provider TEXT NOT NULL,
  available_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY(ticker, trade_date, provider)
);

CREATE INDEX IF NOT EXISTS idx_prices_ticker_date
ON prices_daily(ticker, trade_date DESC);

CREATE TABLE IF NOT EXISTS sec_filings (
  accession_number TEXT PRIMARY KEY,
  ticker TEXT NOT NULL REFERENCES securities(ticker),
  cik TEXT NOT NULL,
  form TEXT NOT NULL,
  filed_at TEXT NOT NULL,
  report_date TEXT,
  accepted_at TEXT,
  primary_document TEXT,
  primary_doc_description TEXT,
  items TEXT,
  filing_url TEXT NOT NULL,
  is_xbrl INTEGER NOT NULL DEFAULT 0,
  is_inline_xbrl INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sec_filings_ticker_filed
ON sec_filings(ticker, filed_at DESC);

CREATE TABLE IF NOT EXISTS research_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  event_date TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('P0','P1','P2','P3')),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_events_ticker_date
ON research_events(ticker, event_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_research_events_severity_date
ON research_events(severity, event_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS news_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  canonical_url TEXT,
  story_fingerprint TEXT,
  content_kind TEXT NOT NULL DEFAULT 'NEWS',
  source_tier TEXT NOT NULL DEFAULT 'TIER_2',
  published_at TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  source_name TEXT,
  source_domain TEXT,
  url TEXT NOT NULL,
  banner_image_url TEXT,
  overall_sentiment_score REAL,
  overall_sentiment_label TEXT,
  engagement_score REAL NOT NULL DEFAULT 0,
  raw_metrics_json TEXT NOT NULL DEFAULT '{}',
  language TEXT,
  topics_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_articles_published
ON news_articles(published_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS news_article_sources (
  article_id INTEGER NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  publisher_name TEXT,
  publisher_domain TEXT,
  source_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(article_id, provider, source_item_id)
);

CREATE INDEX IF NOT EXISTS idx_news_article_sources_article
ON news_article_sources(article_id, provider);

CREATE TABLE IF NOT EXISTS news_article_links (
  article_id INTEGER NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  relevance_score REAL,
  sentiment_score REAL,
  sentiment_label TEXT,
  relation_type TEXT NOT NULL DEFAULT 'DIRECT',
  relation_label TEXT,
  PRIMARY KEY(article_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_news_article_links_ticker
ON news_article_links(ticker, article_id DESC);

CREATE TABLE IF NOT EXISTS news_sync_status (
  ticker TEXT PRIMARY KEY REFERENCES securities(ticker) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  last_as_of TEXT,
  last_fetched_at TEXT,
  last_published_at TEXT,
  article_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news_risk_alerts (
  event_key TEXT PRIMARY KEY,
  notified_at TEXT NOT NULL,
  basis_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS macro_market_bars (
  indicator_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  close REAL NOT NULL,
  provider TEXT NOT NULL,
  available_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY(indicator_key, trade_date, provider)
);

CREATE INDEX IF NOT EXISTS idx_macro_market_bars_latest
ON macro_market_bars(indicator_key, trade_date DESC);

CREATE TABLE IF NOT EXISTS macro_market_snapshots (
  as_of TEXT PRIMARY KEY,
  regime TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_events (
  event_key TEXT PRIMARY KEY,
  event_date TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL,
  direction TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  detected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_events_date
ON market_events(event_date DESC, severity);

CREATE TABLE IF NOT EXISTS financial_facts (
  source_key TEXT PRIMARY KEY,
  ticker TEXT NOT NULL REFERENCES securities(ticker),
  cik TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  tag_priority INTEGER NOT NULL DEFAULT 0,
  taxonomy TEXT NOT NULL,
  tag TEXT NOT NULL,
  label TEXT,
  description TEXT,
  unit TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT NOT NULL,
  period_type TEXT NOT NULL,
  fiscal_year INTEGER,
  fiscal_period TEXT,
  form TEXT NOT NULL,
  filed_at TEXT NOT NULL,
  accession_number TEXT,
  frame TEXT,
  value REAL NOT NULL,
  source_url TEXT,
  ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_financial_facts_metric_period
ON financial_facts(ticker, metric_key, period_type, period_end DESC, filed_at DESC);

CREATE TABLE IF NOT EXISTS sec_sync_status (
  ticker TEXT PRIMARY KEY REFERENCES securities(ticker) ON DELETE CASCADE,
  cik TEXT,
  entity_name TEXT,
  last_synced_at TEXT,
  filings_count INTEGER NOT NULL DEFAULT 0,
  facts_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_position_snapshots (
  ticker TEXT NOT NULL REFERENCES securities(ticker),
  snapshot_date TEXT NOT NULL,
  quantity REAL NOT NULL,
  average_cost REAL,
  remaining_cost REAL NOT NULL,
  close REAL,
  previous_close REAL,
  market_value REAL,
  daily_pnl REAL,
  unrealized_pnl REAL,
  realized_pnl REAL NOT NULL,
  total_pnl REAL,
  total_return REAL,
  calculation_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(ticker, snapshot_date)
);

CREATE TABLE IF NOT EXISTS capital_flow_snapshots (
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  price_date TEXT,
  signal TEXT NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  data_level TEXT NOT NULL,
  close REAL,
  volume REAL,
  daily_return REAL,
  average_volume_5d REAL,
  average_volume_20d REAL,
  volume_trend TEXT,
  volume_trend_pct REAL,
  relative_volume REAL,
  directional_notional_ratio REAL,
  cmf_20 REAL,
  mfi_14 REAL,
  up_down_volume_imbalance_20 REAL,
  obv_slope_20 REAL,
  close_location REAL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  anomalies_json TEXT NOT NULL DEFAULT '[]',
  limitations_json TEXT NOT NULL DEFAULT '[]',
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(ticker, as_of, model_version)
);

CREATE INDEX IF NOT EXISTS idx_capital_flow_ticker_asof
ON capital_flow_snapshots(ticker, as_of DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS volume_alerts (
  event_key TEXT PRIMARY KEY,
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  trade_date TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  basis_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_volume_alerts_ticker_date
ON volume_alerts(ticker, trade_date DESC, alert_type);

CREATE TABLE IF NOT EXISTS prices_intraday (
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  bar_time_et TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  interval TEXT NOT NULL DEFAULT '1M',
  session TEXT NOT NULL DEFAULT 'RTH',
  open REAL,
  high REAL,
  low REAL,
  close REAL NOT NULL,
  volume REAL,
  turnover REAL,
  provider TEXT NOT NULL DEFAULT 'futu',
  is_final INTEGER NOT NULL DEFAULT 1,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY(ticker, bar_time_et, interval, session, provider)
);

CREATE INDEX IF NOT EXISTS idx_prices_intraday_ticker_time
ON prices_intraday(ticker, bar_time_et DESC);

CREATE TABLE IF NOT EXISTS ticks_intraday (
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  sequence TEXT NOT NULL,
  trade_time_et TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  price REAL NOT NULL,
  volume REAL NOT NULL,
  turnover REAL NOT NULL,
  direction TEXT NOT NULL,
  trade_type TEXT,
  session TEXT NOT NULL DEFAULT 'RTH',
  provider TEXT NOT NULL DEFAULT 'futu',
  ingested_at TEXT NOT NULL,
  PRIMARY KEY(ticker, trade_date, sequence, provider)
);

CREATE INDEX IF NOT EXISTS idx_ticks_intraday_ticker_time
ON ticks_intraday(ticker, trade_time_et DESC);

CREATE TABLE IF NOT EXISTS intraday_tick_minutes (
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  minute_et TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  session TEXT NOT NULL DEFAULT 'RTH',
  buy_turnover REAL NOT NULL DEFAULT 0,
  sell_turnover REAL NOT NULL DEFAULT 0,
  neutral_turnover REAL NOT NULL DEFAULT 0,
  buy_count INTEGER NOT NULL DEFAULT 0,
  sell_count INTEGER NOT NULL DEFAULT 0,
  neutral_count INTEGER NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 0,
  last_price REAL,
  provider TEXT NOT NULL DEFAULT 'futu',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(ticker, minute_et, provider)
);

CREATE INDEX IF NOT EXISTS idx_intraday_tick_minutes_ticker_time
ON intraday_tick_minutes(ticker, minute_et DESC);

CREATE TABLE IF NOT EXISTS intraday_flow_snapshots (
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  as_of_minute TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  signal TEXT NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  limitations_json TEXT NOT NULL DEFAULT '[]',
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(ticker, as_of_minute, model_version)
);

CREATE INDEX IF NOT EXISTS idx_intraday_flow_ticker_time
ON intraday_flow_snapshots(ticker, as_of_minute DESC);

CREATE TABLE IF NOT EXISTS feature_snapshots (
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  price_date TEXT,
  feature_version TEXT NOT NULL,
  features_json TEXT NOT NULL DEFAULT '{}',
  availability_json TEXT NOT NULL DEFAULT '{}',
  data_quality_score REAL NOT NULL,
  eligible_for_training INTEGER NOT NULL DEFAULT 0,
  exclusion_reasons_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY(ticker, as_of, feature_version)
);

CREATE INDEX IF NOT EXISTS idx_feature_snapshots_ticker_asof
ON feature_snapshots(ticker, as_of DESC, feature_version);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL REFERENCES securities(ticker),
  as_of TEXT NOT NULL,
  target_date TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  current_price REAL NOT NULL,
  return_p10 REAL,
  return_p50 REAL,
  return_p90 REAL,
  price_p10 REAL,
  price_p50 REAL,
  price_p90 REAL,
  probability_up REAL,
  reliability_score REAL,
  publication_status TEXT NOT NULL CHECK(publication_status IN ('PUBLISHED','OBSERVE','REJECTED','INSUFFICIENT')),
  model_version TEXT NOT NULL,
  feature_version TEXT,
  rationale_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_predictions_ticker_horizon_asof
ON predictions(ticker, horizon_days, as_of DESC);

CREATE TABLE IF NOT EXISTS prediction_backtest_results (
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  target_date TEXT,
  actual_date TEXT,
  current_price REAL NOT NULL,
  predicted_direction TEXT NOT NULL,
  probability_up REAL,
  return_p10 REAL,
  return_p50 REAL,
  return_p90 REAL,
  actual_return REAL,
  benchmark_return REAL,
  excess_return REAL,
  direction_hit INTEGER,
  interval_hit INTEGER,
  status TEXT NOT NULL CHECK(status IN ('PENDING','MATURED','EXCLUDED')),
  exclusion_reason TEXT,
  data_quality_score REAL NOT NULL,
  feature_version TEXT NOT NULL,
  model_version TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(ticker, as_of, horizon_days, model_version)
);

CREATE INDEX IF NOT EXISTS idx_prediction_backtest_lookup
ON prediction_backtest_results(ticker, horizon_days, status, as_of DESC);

CREATE TABLE IF NOT EXISTS investment_advice_snapshots (
  ticker TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  action TEXT NOT NULL,
  stance TEXT NOT NULL,
  impact_score REAL NOT NULL,
  confidence_score REAL NOT NULL,
  publication_status TEXT NOT NULL,
  current_price REAL,
  target_price REAL,
  stop_price REAL,
  rationale_json TEXT NOT NULL DEFAULT '{}',
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(ticker, as_of, horizon_days, model_version)
);

CREATE INDEX IF NOT EXISTS idx_advice_ticker_asof
ON investment_advice_snapshots(ticker, as_of DESC, horizon_days);

CREATE TABLE IF NOT EXISTS reliability_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL REFERENCES securities(ticker),
  horizon_days INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  as_of TEXT NOT NULL,
  direction_accuracy REAL,
  probability_calibration REAL,
  interval_coverage REAL,
  benchmark_skill REAL,
  regime_stability REAL,
  data_quality REAL,
  effective_samples INTEGER NOT NULL DEFAULT 0,
  composite_score REAL NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_reliability_lookup
ON reliability_scores(ticker, horizon_days, model_version, as_of DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reliability_snapshot_unique
ON reliability_scores(ticker, horizon_days, model_version, as_of);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT,
  severity TEXT NOT NULL CHECK(severity IN ('P0','P1','P2','P3','INFO')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'UNREAD',
  created_at TEXT NOT NULL,
  macos_sent_at TEXT,
  email_sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_created
ON notifications(created_at DESC);

CREATE TABLE IF NOT EXISTS daily_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT REFERENCES securities(ticker),
  review_date TEXT NOT NULL,
  review_type TEXT NOT NULL CHECK(review_type IN ('STOCK','PORTFOLIO')),
  status TEXT NOT NULL DEFAULT 'FINAL',
  structured_json TEXT NOT NULL,
  narrative TEXT NOT NULL,
  model_version TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(ticker, review_date, review_type, status)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reviews_unique
ON daily_reviews(COALESCE(ticker, '__PORTFOLIO__'), review_date, review_type, status);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function openDatabase(databasePath = config.databasePath) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec(schema);
  const transactionColumns = new Set(
    toPlainRows(db.prepare('PRAGMA table_info(transactions)').all()).map((column) => column.name)
  );
  if (!transactionColumns.has('import_batch_id')) {
    db.exec('ALTER TABLE transactions ADD COLUMN import_batch_id INTEGER');
  }
  if (!transactionColumns.has('import_row_number')) {
    db.exec('ALTER TABLE transactions ADD COLUMN import_row_number INTEGER');
  }
  const securityColumns = new Set(
    toPlainRows(db.prepare('PRAGMA table_info(securities)').all()).map((column) => column.name)
  );
  if (!securityColumns.has('sic')) {
    db.exec('ALTER TABLE securities ADD COLUMN sic TEXT');
  }
  if (!securityColumns.has('sic_description')) {
    db.exec('ALTER TABLE securities ADD COLUMN sic_description TEXT');
  }
  const estimateColumns = new Set(
    toPlainRows(db.prepare('PRAGMA table_info(earnings_estimates)').all()).map((column) => column.name)
  );
  const estimateMigrations = [
    ['eps_high', 'REAL'],
    ['eps_low', 'REAL'],
    ['analyst_count', 'INTEGER'],
    ['provider', "TEXT NOT NULL DEFAULT 'manual'"],
    ['calculation_method', 'TEXT'],
    ['estimate_basis', 'TEXT'],
    ['quality_status', 'TEXT'],
    ['fetched_at', 'TEXT']
  ];
  for (const [column, definition] of estimateMigrations) {
    if (!estimateColumns.has(column)) db.exec(`ALTER TABLE earnings_estimates ADD COLUMN ${column} ${definition}`);
  }
  const newsColumns = new Set(
    toPlainRows(db.prepare('PRAGMA table_info(news_articles)').all()).map((column) => column.name)
  );
  const newsMigrations = [
    ['canonical_url', 'TEXT'],
    ['story_fingerprint', 'TEXT'],
    ['content_kind', "TEXT NOT NULL DEFAULT 'NEWS'"],
    ['source_tier', "TEXT NOT NULL DEFAULT 'TIER_2'"],
    ['engagement_score', 'REAL NOT NULL DEFAULT 0'],
    ['raw_metrics_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['language', 'TEXT']
  ];
  for (const [column, definition] of newsMigrations) {
    if (!newsColumns.has(column)) db.exec(`ALTER TABLE news_articles ADD COLUMN ${column} ${definition}`);
  }
  const newsLinkColumns = new Set(
    toPlainRows(db.prepare('PRAGMA table_info(news_article_links)').all()).map((column) => column.name)
  );
  if (!newsLinkColumns.has('relation_type')) {
    db.exec("ALTER TABLE news_article_links ADD COLUMN relation_type TEXT NOT NULL DEFAULT 'DIRECT'");
  }
  if (!newsLinkColumns.has('relation_label')) {
    db.exec('ALTER TABLE news_article_links ADD COLUMN relation_label TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_news_articles_canonical
    ON news_articles(canonical_url);
    CREATE INDEX IF NOT EXISTS idx_news_articles_story
    ON news_articles(story_fingerprint, published_at DESC)
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_estimates_provider_snapshot
    ON earnings_estimates(ticker, estimate_type, as_of, provider)
    WHERE provider <> 'manual'
  `);
  const capitalFlowColumns = new Set(
    toPlainRows(db.prepare('PRAGMA table_info(capital_flow_snapshots)').all()).map((column) => column.name)
  );
  const capitalFlowMigrations = [
    ['volume', 'REAL'],
    ['average_volume_5d', 'REAL'],
    ['average_volume_20d', 'REAL'],
    ['volume_trend', 'TEXT'],
    ['volume_trend_pct', 'REAL']
  ];
  for (const [column, definition] of capitalFlowMigrations) {
    if (!capitalFlowColumns.has(column)) {
      db.exec(`ALTER TABLE capital_flow_snapshots ADD COLUMN ${column} ${definition}`);
    }
  }
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

export function toPlain(row) {
  return row ? { ...row } : row;
}

export function toPlainRows(rows) {
  return rows.map((row) => ({ ...row }));
}
