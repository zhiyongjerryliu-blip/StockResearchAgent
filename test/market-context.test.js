import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { classifyMarketRegime, getMarketContext, syncMarketContext } from '../src/market-context.js';

test('美债与联邦基金期货代理生成可复核的利率逆风信号', async () => {
  const db = openDatabase(':memory:');
  const closes = {
    '^TNX': [4.10, 4.25], '^IRX': [4.00, 4.02],
    'ZN=F': [112, 111], 'ZQ=F': [95.00, 94.90], TLT: [90, 89]
  };
  const provider = {
    name: 'test',
    async fetchDaily(symbol) {
      return closes[symbol].map((close, index) => ({
        ticker: symbol, tradeDate: index ? '2026-09-01' : '2026-08-31', close,
        provider: 'test', availableAt: `2026-09-0${index + 1}T21:00:00.000Z`
      }));
    }
  };
  const result = await syncMarketContext(db, provider, '2026-09-01');
  assert.equal(result.snapshot.regime, 'RATE_HEADWIND');
  assert.equal(result.snapshot.metrics.US10Y_YIELD.changeBps, 15);
  assert.equal(result.snapshot.metrics.FED_FUNDS_FUTURES.impliedRate, 5.1);
  assert.equal(result.snapshot.metrics.FED_FUNDS_FUTURES.changeBps, 10);
  assert.match(result.snapshot.methodology.fedFunds, /不是CME FedWatch概率/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM market_events').get().count, 1);
  assert.equal(getMarketContext(db).asOf, '2026-09-01');
  db.close();
});
test('利率方向冲突时标为MIXED而不强行输出多空', () => {
  const result = classifyMarketRegime({
    US10Y_YIELD: { changeBps: 12 },
    FED_FUNDS_FUTURES: { changeBps: -8 }
  });
  assert.equal(result.regime, 'MIXED');
  assert.equal(result.severity, 'P2');
});
