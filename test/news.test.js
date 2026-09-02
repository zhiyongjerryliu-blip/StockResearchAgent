import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { upsertWatchlistItem } from '../src/repository.js';
import {
  AlphaVantageNewsProvider,
  classifyNewsRisk,
  getNewsSentimentSummary,
  listNewsArticles,
  normalizeAlphaNews,
  syncNewsForTicker
} from '../src/news.js';

function article({ key, publishedAt, title, summary = '', sentiment = -0.1, relevance = 0.9 }) {
  return {
    articleKey: key,
    provider: 'test_news',
    sourceItemId: key,
    contentKind: 'NEWS',
    sourceTier: 'TIER_1',
    publishedAt,
    title,
    summary,
    sourceName: 'Example News',
    sourceDomain: 'example.com',
    url: `https://example.com/${key}`,
    bannerImageUrl: null,
    overallSentimentScore: sentiment,
    overallSentimentLabel: sentiment < 0 ? 'Bearish' : 'Neutral',
    topics: [{ topic: 'Technology', relevanceScore: 0.8 }],
    engagementScore: 0,
    rawMetrics: {},
    tickerSentiments: [{
      ticker: 'RISK', relevanceScore: relevance, sentimentScore: sentiment,
      sentimentLabel: sentiment < 0 ? 'Bearish' : 'Neutral'
    }]
  };
}

test('Alpha Vantage新闻标准化保留发布时间、来源和股票情绪', () => {
  const rows = normalizeAlphaNews({ feed: [{
    title: 'Test headline', url: 'https://example.com/story', time_published: '20260901T123045',
    summary: 'Summary', source: 'Example', source_domain: 'example.com',
    overall_sentiment_score: '-0.25', overall_sentiment_label: 'Bearish',
    topics: [{ topic: 'Technology', relevance_score: '0.8' }],
    ticker_sentiment: [{
      ticker: 'RISK', relevance_score: '0.91', ticker_sentiment_score: '-0.4',
      ticker_sentiment_label: 'Bearish'
    }]
  }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].publishedAt, '2026-09-01T12:30:45.000Z');
  assert.equal(rows[0].tickerSentiments[0].relevanceScore, 0.91);
  assert.equal(rows[0].tickerSentiments[0].sentimentScore, -0.4);
});

test('新闻分类不会生成P0且低相关内容不触发风险', () => {
  const risky = article({
    key: 'risk', publishedAt: '2026-09-01T12:00:00.000Z',
    title: 'Company faces SEC investigation and accounting irregularities', sentiment: -0.6
  });
  const classification = classifyNewsRisk(risky, risky.tickerSentiments[0]);
  assert.equal(classification.severity, 'P1');
  assert.notEqual(classification.severity, 'P0');
  assert.equal(classifyNewsRisk(risky, { ...risky.tickerSentiments[0], relevanceScore: 0.1 }), null);
  const social = classifyNewsRisk(
    { ...risky, contentKind: 'DISCUSSION' }, risky.tickerSentiments[0]
  );
  assert.equal(social.severity, 'P2');
  assert.match(social.category, /^SOCIAL_/);
});

test('Alpha Vantage每秒频率提示会等待后自动重试一次', async () => {
  let fetchCount = 0;
  const waits = [];
  const provider = new AlphaVantageNewsProvider({
    apiKey: 'test-key', minimumIntervalMs: 1100,
    sleepImpl: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? { Information: 'Please spread requests more sparingly: 1 request per second.' }
          : { feed: [] };
      }
    })
  });
  const result = await provider.fetchNews('RISK');
  assert.equal(fetchCount, 2);
  assert.deepEqual(waits, [1100]);
  assert.deepEqual(result.articles, []);
});

test('首次新闻同步静默回填，后续新P1新闻只通知一次', async () => {
  const db = openDatabase(':memory:');
  upsertWatchlistItem(db, { ticker: 'RISK', name: 'Risk Corp' });
  const safe = article({
    key: 'safe', publishedAt: '2026-09-01T12:00:00.000Z',
    title: 'Company launches new product', sentiment: 0.1
  });
  const risky = article({
    key: 'new-risk', publishedAt: '2026-09-02T11:00:00.000Z',
    title: 'Company receives delisting notice', sentiment: -0.4
  });
  let call = 0;
  const provider = {
    async fetchNews() {
      call += 1;
      return { ticker: 'RISK', articles: call === 1 ? [safe] : [risky, safe] };
    }
  };
  const notifications = [];
  const notifier = async (_db, input) => { notifications.push(input); return input; };

  const first = await syncNewsForTicker(db, provider, 'RISK', '2026-09-01', { notifier });
  const second = await syncNewsForTicker(db, provider, 'RISK', '2026-09-02', { notifier });
  const cached = await syncNewsForTicker(db, provider, 'RISK', '2026-09-02', { notifier });
  assert.equal(first.initialSync, true);
  assert.equal(first.notified, 0);
  assert.equal(second.riskEvents, 1);
  assert.equal(second.notified, 1);
  assert.equal(cached.cached, true);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, /核实原文和官方信息/);
  assert.equal(listNewsArticles(db, { ticker: 'RISK' }).length, 2);
  const sentiment = getNewsSentimentSummary(db, { ticker: 'RISK', asOf: '2026-09-02' });
  assert.equal(sentiment.total, 2);
  assert.equal(sentiment.uniqueSources, 1);
  assert.equal(sentiment.sufficient, false);
  assert.equal(sentiment.trend, '数据不足');
  db.close();
});
