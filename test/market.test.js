import test from 'node:test';
import assert from 'node:assert/strict';
import { YahooDailyProvider } from '../src/market.js';

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
