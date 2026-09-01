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

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL REFERENCES securities(ticker),
  side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
  trade_time TEXT NOT NULL,
  quantity REAL NOT NULL CHECK(quantity > 0),
  price REAL NOT NULL CHECK(price >= 0),
  fee REAL NOT NULL DEFAULT 0 CHECK(fee >= 0),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_ticker_time
ON transactions(ticker, trade_time, id);

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
