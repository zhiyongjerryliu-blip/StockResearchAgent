import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function intEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export const config = Object.freeze({
  projectRoot,
  host: process.env.APP_HOST || '127.0.0.1',
  port: intEnv('APP_PORT', 3789),
  timezone: process.env.APP_TIMEZONE || 'Asia/Shanghai',
  databasePath: resolveProjectPath(process.env.DATABASE_PATH || './data/research.sqlite'),
  marketDataProvider: process.env.MARKET_DATA_PROVIDER || 'yahoo',
  marketRefreshIntervalMinutes: intEnv('MARKET_REFRESH_INTERVAL_MINUTES', 30),
  dailyReviewHourEt: intEnv('DAILY_REVIEW_HOUR_ET', 18),
  dailyReviewMinuteEt: intEnv('DAILY_REVIEW_MINUTE_ET', 15),
  sec: {
    userAgent: process.env.SEC_USER_AGENT || '',
    requestsPerSecond: Math.min(10, Math.max(1, intEnv('SEC_REQUESTS_PER_SECOND', 5)))
  },
  alphaVantage: {
    apiKey: process.env.ALPHA_VANTAGE_API_KEY || ''
  },
  futu: {
    enabled: boolEnv(
      'FUTU_ENABLED',
      process.platform === 'darwin' && fs.existsSync('/Applications/Futu_OpenD.app')
    ),
    host: process.env.FUTU_OPEND_HOST || '127.0.0.1',
    port: intEnv('FUTU_OPEND_PORT', 11111),
    pythonPath: resolveProjectPath(process.env.FUTU_PYTHON_PATH || './.venv-futu/bin/python'),
    session: process.env.FUTU_MARKET_SESSION || 'RTH',
    backfillDays: Math.min(60, Math.max(0, intEnv('FUTU_BACKFILL_DAYS', 35))),
    tickRetentionDays: Math.min(30, Math.max(1, intEnv('FUTU_TICK_RETENTION_DAYS', 7)))
  },
  reliabilityGate: intEnv('RELIABILITY_GATE', 85),
  notifications: {
    macosEnabled: boolEnv('MACOS_NOTIFICATIONS_ENABLED', true),
    emailEnabled: boolEnv('EMAIL_NOTIFICATIONS_ENABLED', false),
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: intEnv('SMTP_PORT', 465),
      secure: boolEnv('SMTP_SECURE', true),
      username: process.env.SMTP_USERNAME || '',
      password: process.env.SMTP_PASSWORD || '',
      from: process.env.EMAIL_FROM || '',
      to: process.env.EMAIL_TO || ''
    }
  },
  llm: {
    enabled: boolEnv('LLM_ENABLED', false),
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || ''
  }
});
