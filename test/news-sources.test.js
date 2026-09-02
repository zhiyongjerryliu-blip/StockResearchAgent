import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompositeNewsProvider,
  normalizeGoogleNewsRss,
  normalizeHackerNews,
  normalizeYahooFinanceNews
} from '../src/news-sources.js';

test('Google News RSS保留实际媒体来源并过滤无关结果', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Lumentum raises outlook - Reuters</title>
      <link>https://news.google.com/rss/articles/story-one?oc=5</link>
      <guid>story-one</guid><pubDate>Wed, 02 Sep 2026 01:00:00 GMT</pubDate>
      <source url="https://www.reuters.com">Reuters</source></item>
    <item><title>Unrelated company update - Example</title>
      <link>https://example.com/no-match</link><guid>no-match</guid>
      <pubDate>Wed, 02 Sep 2026 01:00:00 GMT</pubDate>
      <source url="https://example.com">Example</source></item>
  </channel></rss>`;
  const rows = normalizeGoogleNewsRss(xml, 'LITE', 'Lumentum');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceName, 'Reuters');
  assert.equal(rows[0].sourceTier, 'TIER_1');
  assert.equal(rows[0].provider, 'google_news');
});

test('Yahoo Finance新闻必须与目标ticker关联', () => {
  const rows = normalizeYahooFinanceNews({ news: [{
    uuid: 'one', title: 'Analyst updates Lumentum outlook', publisher: 'Example',
    link: 'https://finance.yahoo.com/example', providerPublishTime: 1788310800,
    relatedTickers: ['LITE']
  }, {
    uuid: 'two', title: 'Unrelated update', publisher: 'Example',
    link: 'https://finance.yahoo.com/unrelated', providerPublishTime: 1788310800,
    relatedTickers: ['OTHER']
  }] }, 'LITE', 'Lumentum');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tickerSentiments[0].relevanceScore, 1);
});

test('Hacker News按公开讨论处理并保留热度', () => {
  const rows = normalizeHackerNews({ hits: [{
    objectID: '123', title: 'Lumentum announces optical networking breakthrough',
    url: 'https://example.com/lumentum', created_at: '2026-09-02T01:00:00.000Z',
    points: 12, num_comments: 4
  }] }, 'LITE', 'Lumentum');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contentKind, 'DISCUSSION');
  assert.equal(rows[0].sourceTier, 'SOCIAL');
  assert.equal(rows[0].engagementScore, 20);
});

test('组合新闻源隔离单一来源故障并返回逐源诊断', async () => {
  const provider = new CompositeNewsProvider([{
    name: 'failed', assertConfigured() {}, async fetchNews() { throw new Error('offline'); }
  }, {
    name: 'working', assertConfigured() {}, async fetchNews(ticker) {
      return { ticker, articles: [{ articleKey: 'ok' }] };
    }
  }]);
  const result = await provider.fetchNews('LITE');
  assert.equal(result.articles.length, 1);
  assert.deepEqual(result.sourceResults.map((row) => row.ok), [false, true]);
});
