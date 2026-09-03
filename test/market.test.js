import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { YahooDailyProvider, refreshWatchlistPrices } from '../src/market.js';
import { configureAutomaticPeers } from '../src/peer-selection.js';
import { upsertWatchlistItem } from '../src/repository.js';

test('Yahoo Provider将返回值标准化为日线', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      chart: {
        result: [{
          timestamp: [1788134400, 1788220800],
          indicators: {
            quote: [{ open: [100, 102], high: [103, 106], low: [99, 101], close: [102, 105], volume: [1000, 1200] }],
            adjclose: [{ adjclose: [102, 105] }]
          }
        }]
      }
    })
  });
  const provider = new YahooDailyProvider(fakeFetch);
  const bars = await provider.fetchDaily('BRK.B');
  assert.equal(bars.length, 2);
  assert.equal(bars[1].close, 105);
  assert.equal(bars[1].provider, 'yahoo');
});

test('Yahoo十日行情缺少上一交易日时自动用一个月行情补齐', async () => {
  const requests = [];
  const responseFor = (dates, closes) => ({
    ok: true,
    json: async () => ({
      chart: {
        result: [{
          timestamp: dates.map((date) => Date.parse(`${date}T13:30:00Z`) / 1000),
          indicators: {
            quote: [{
              open: closes, high: closes, low: closes, close: closes,
              volume: closes.map(() => 1000)
            }],
            adjclose: [{ adjclose: closes }]
          }
        }]
      }
    })
  });
  const fakeFetch = async (url) => {
    requests.push(url);
    if (url.includes('range=10d')) {
      return responseFor(['2026-08-27', '2026-08-31'], [956.14, 914.76]);
    }
    return responseFor(['2026-08-27', '2026-08-28', '2026-08-31'], [956.14, 895, 914.76]);
  };

  const provider = new YahooDailyProvider(fakeFetch);
  const bars = await provider.fetchDaily('LITE');
  assert.equal(requests.length, 2);
  assert.match(requests[1], /range=1mo/);
  assert.deepEqual(bars.map((bar) => bar.tradeDate), ['2026-08-27', '2026-08-28', '2026-08-31']);
});

test('Yahoo会按最早建仓日扩展历史行情范围', async () => {
  const requests = [];
  const fakeFetch = async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => ({
        chart: { result: [{
          timestamp: [Date.parse('2026-08-31T13:30:00Z') / 1000],
          indicators: {
            quote: [{ open: [100], high: [100], low: [100], close: [100], volume: [1000] }],
            adjclose: [{ adjclose: [100] }]
          }
        }] }
      })
    };
  };
  const provider = new YahooDailyProvider(fakeFetch);
  await provider.fetchDaily('LITE', { historyStart: '2026-02-01' });
  assert.equal(requests.length, 2);
  assert.match(requests[1], /range=1y/);
});

test('行情刷新会同时更新对标公司和市场基准', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'LITE' });
  configureAutomaticPeers(db, 'LITE', '2026-09-02');
  const requested = [];
  const provider = {
    name: 'test',
    async fetchDaily(ticker) {
      requested.push(ticker);
      return [{
        ticker, tradeDate: '2026-09-01', open: 100, high: 101, low: 99,
        close: 100, adjustedClose: 100, volume: 1000, provider: 'test',
        availableAt: '2026-09-02T00:00:00.000Z'
      }];
    }
  };

  const result = await refreshWatchlistPrices(db, provider);
  assert.deepEqual(requested, ['CIEN', 'COHR', 'LITE', 'SPY']);
  assert.equal(result.results.every((item) => item.ok), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM prices_daily').get().count, 4);
  assert.equal(result.results.find((item) => item.ticker === 'SPY').role, 'BENCHMARK');
  db.close();
});

test('行情刷新会自动创建并同步股票池配置的行业ETF', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'TEST', industryEtf: 'SMH' });
  const requested = [];
  const provider = {
    name: 'test',
    async fetchDaily(ticker) {
      requested.push(ticker);
      return [{
        ticker, tradeDate: '2026-09-01', open: 100, high: 101, low: 99,
        close: 100, adjustedClose: 100, volume: 1000, provider: 'test',
        availableAt: '2026-09-02T00:00:00.000Z'
      }];
    }
  };

  await refreshWatchlistPrices(db, provider);
  assert.deepEqual(requested, ['SMH', 'SPY', 'TEST']);
  assert.ok(db.prepare("SELECT 1 FROM securities WHERE ticker = 'SMH'").get());
  db.close();
});
