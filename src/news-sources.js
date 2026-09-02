import { createHash } from 'node:crypto';
import { normalizeTicker } from './domain.js';

const GOOGLE_NEWS_RSS_URL = 'https://news.google.com/rss/search';
const YAHOO_FINANCE_SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const HACKER_NEWS_SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date';

const POSITIVE_WORDS = new Set([
  'beat', 'beats', 'growth', 'surge', 'surges', 'gain', 'gains', 'upgrade', 'upgraded',
  'record', 'strong', 'bullish', 'outperform', 'expands', 'expansion', 'raises', 'raised',
  'profit', 'profitable', 'partnership', 'approval', 'approved', 'breakthrough'
]);
const NEGATIVE_WORDS = new Set([
  'miss', 'misses', 'decline', 'declines', 'drop', 'drops', 'downgrade', 'downgraded',
  'weak', 'bearish', 'underperform', 'cuts', 'cut', 'loss', 'losses', 'warning', 'risk',
  'probe', 'investigation', 'lawsuit', 'recall', 'breach', 'layoff', 'layoffs', 'bankruptcy',
  'default', 'fraud', 'delisting', 'sanction', 'sanctions'
]);
const TIER_ONE_DOMAINS = [
  'reuters.com', 'apnews.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'cnbc.com',
  'nytimes.com', 'washingtonpost.com', 'economist.com', 'barrons.com', 'marketwatch.com'
];

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function validUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function domainOf(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    const suffix = parts.slice(-2).join('.');
    const multiPartSuffixes = new Set(['co.uk', 'com.au', 'co.jp', 'co.in', 'com.cn', 'com.sg']);
    return multiPartSuffixes.has(suffix) ? parts.slice(-3).join('.') : suffix;
  } catch {
    return null;
  }
}

function keyFor(provider, id, url, publishedAt) {
  return createHash('sha256').update(JSON.stringify([provider, id || url, publishedAt])).digest('hex');
}

function tokenize(value) {
  return String(value || '').toLowerCase().match(/[a-z][a-z'-]*/g) || [];
}

export function estimateTextSentiment(value) {
  let positive = 0;
  let negative = 0;
  for (const word of tokenize(value)) {
    if (POSITIVE_WORDS.has(word)) positive += 1;
    if (NEGATIVE_WORDS.has(word)) negative += 1;
  }
  const total = positive + negative;
  if (!total) return 0;
  return Math.max(-1, Math.min(1, (positive - negative) / Math.max(2, total)));
}

export function sourceTier(sourceDomain, contentKind = 'NEWS') {
  if (contentKind === 'DISCUSSION') return 'SOCIAL';
  const domain = String(sourceDomain || '').toLowerCase();
  return TIER_ONE_DOMAINS.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))
    ? 'TIER_1' : 'TIER_2';
}

function relevanceFor(text, ticker, companyName) {
  const haystack = String(text || '').toLowerCase();
  if (haystack.includes(`$${ticker.toLowerCase()}`)) return 1;
  if (companyName && haystack.includes(companyName.toLowerCase())) return 0.95;
  if (new RegExp(`\\b${ticker.toLowerCase()}\\b`, 'i').test(haystack)) return 0.72;
  return 0;
}

function sentimentLabel(score) {
  if (score >= 0.35) return 'Bullish';
  if (score <= -0.35) return 'Bearish';
  if (score > 0) return 'Somewhat-Bullish';
  if (score < 0) return 'Somewhat-Bearish';
  return 'Neutral';
}

function articleFromSource(input) {
  const sentiment = input.sentiment ?? estimateTextSentiment(`${input.title}\n${input.summary || ''}`);
  return {
    articleKey: keyFor(input.provider, input.sourceItemId, input.url, input.publishedAt),
    provider: input.provider,
    sourceItemId: String(input.sourceItemId || input.url),
    contentKind: input.contentKind || 'NEWS',
    sourceTier: input.sourceTier || sourceTier(input.sourceDomain, input.contentKind),
    publishedAt: input.publishedAt,
    title: input.title,
    summary: input.summary || null,
    sourceName: input.sourceName || null,
    sourceDomain: input.sourceDomain || null,
    url: input.url,
    bannerImageUrl: input.bannerImageUrl || null,
    overallSentimentScore: sentiment,
    overallSentimentLabel: sentimentLabel(sentiment),
    topics: input.topics || [],
    engagementScore: input.engagementScore || 0,
    rawMetrics: input.rawMetrics || {},
    relationType: input.relationType || 'DIRECT',
    relationLabel: input.relationLabel || null,
    tickerSentiments: [{
      ticker: input.ticker,
      relevanceScore: input.relevance,
      sentimentScore: sentiment,
      sentimentLabel: sentimentLabel(sentiment)
    }]
  };
}

async function fetchWithTimeout(fetchImpl, url, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'User-Agent': 'StockResearchAgent/0.1 (personal research)' },
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    const code = error?.cause?.code || error?.code;
    throw new Error(`${label}请求失败${code ? `（${code}）` : ''}`);
  }
  if (!response.ok) throw new Error(`${label}请求失败：HTTP ${response.status}`);
  return response;
}

export function normalizeGoogleNewsRss(xml, tickerValue, companyName = '', options = {}) {
  const ticker = normalizeTicker(tickerValue);
  const items = String(xml || '').match(/<item>[\s\S]*?<\/item>/gi) || [];
  return items.flatMap((block) => {
    const rawTitle = tagValue(block, 'title');
    const sourceName = tagValue(block, 'source') || 'Google News';
    const sourceUrl = block.match(/<source[^>]*\surl="([^"]+)"[^>]*>/i)?.[1] || '';
    const sourceDomain = domainOf(decodeXml(sourceUrl)) || sourceName.toLowerCase();
    const suffix = ` - ${sourceName}`;
    const title = rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length) : rawTitle;
    const url = validUrl(tagValue(block, 'link'));
    const publishedDate = new Date(tagValue(block, 'pubDate'));
    const publishedAt = Number.isNaN(publishedDate.getTime()) ? null : publishedDate.toISOString();
    const relevance = options.contextType
      ? Math.max(0.45, Math.min(0.75, Number(options.contextRelevance) || 0.55))
      : relevanceFor(`${title}\n${url || ''}`, ticker, companyName);
    if (!title || !url || !publishedAt || relevance < 0.35) return [];
    return [articleFromSource({
      provider: 'google_news', sourceItemId: tagValue(block, 'guid') || url,
      ticker, companyName, publishedAt, title, url, sourceName, sourceDomain, relevance,
      relationType: options.contextType || 'DIRECT', relationLabel: options.contextLabel || null,
      rawMetrics: { channel: 'Google News RSS', contextKey: options.contextKey || null }
    })];
  });
}

export class GoogleNewsRssProvider {
  constructor({ fetchImpl = fetch } = {}) { this.fetchImpl = fetchImpl; this.name = 'google_news'; }
  assertConfigured() {}
  async fetchNews(tickerValue, options = {}) {
    const ticker = normalizeTicker(tickerValue);
    const companyName = String(options.companyName || '').trim();
    const query = companyName ? `"${companyName}" OR "$${ticker}" when:7d` : `"$${ticker}" OR "${ticker} stock" when:7d`;
    const url = new URL(GOOGLE_NEWS_RSS_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('hl', 'en-US'); url.searchParams.set('gl', 'US'); url.searchParams.set('ceid', 'US:en');
    const response = await fetchWithTimeout(this.fetchImpl, url, 'Google News');
    const articles = normalizeGoogleNewsRss(await response.text(), ticker, companyName);
    for (const concept of (options.concepts || []).slice(0, 2)) {
      const conceptUrl = new URL(GOOGLE_NEWS_RSS_URL);
      conceptUrl.searchParams.set('q', `${concept.search_query} when:7d`);
      conceptUrl.searchParams.set('hl', 'en-US');
      conceptUrl.searchParams.set('gl', 'US');
      conceptUrl.searchParams.set('ceid', 'US:en');
      try {
        const conceptResponse = await fetchWithTimeout(this.fetchImpl, conceptUrl, 'Google News行业信息');
        articles.push(...normalizeGoogleNewsRss(
          await conceptResponse.text(), ticker, companyName, {
            contextType: concept.concept_type,
            contextLabel: concept.concept_name,
            contextKey: concept.concept_key,
            contextRelevance: concept.confidence * 0.7
          }
        ));
      } catch {
        // 单个概念检索失败不影响公司新闻和其他概念。
      }
    }
    return { ticker, articles };
  }
}

export function normalizeYahooFinanceNews(payload, tickerValue, companyName = '') {
  const ticker = normalizeTicker(tickerValue);
  if (!Array.isArray(payload?.news)) throw new Error('Yahoo Finance未返回新闻列表');
  return payload.news.flatMap((row) => {
    const url = validUrl(row.link);
    const publishedAt = Number.isFinite(Number(row.providerPublishTime))
      ? new Date(Number(row.providerPublishTime) * 1000).toISOString() : null;
    const title = String(row.title || '').trim();
    const related = Array.isArray(row.relatedTickers) && row.relatedTickers.includes(ticker);
    const relevance = related ? 1 : relevanceFor(`${title}\n${url || ''}`, ticker, companyName);
    if (!title || !url || !publishedAt || relevance < 0.35) return [];
    const sourceName = String(row.publisher || 'Yahoo Finance').trim();
    return [articleFromSource({
      provider: 'yahoo_finance', sourceItemId: row.uuid || url, ticker, publishedAt, title, url,
      sourceName, sourceDomain: domainOf(url), relevance,
      bannerImageUrl: validUrl(row.thumbnail?.resolutions?.[0]?.url),
      rawMetrics: { relatedTickers: row.relatedTickers || [] }
    })];
  });
}

export class YahooFinanceNewsProvider {
  constructor({ fetchImpl = fetch } = {}) { this.fetchImpl = fetchImpl; this.name = 'yahoo_finance'; }
  assertConfigured() {}
  async fetchNews(tickerValue, options = {}) {
    const ticker = normalizeTicker(tickerValue);
    const url = new URL(YAHOO_FINANCE_SEARCH_URL);
    url.searchParams.set('q', ticker); url.searchParams.set('quotesCount', '0'); url.searchParams.set('newsCount', '40');
    const response = await fetchWithTimeout(this.fetchImpl, url, 'Yahoo Finance新闻');
    return { ticker, articles: normalizeYahooFinanceNews(await response.json(), ticker, options.companyName) };
  }
}

export function normalizeHackerNews(payload, tickerValue, companyName = '') {
  const ticker = normalizeTicker(tickerValue);
  if (!Array.isArray(payload?.hits)) throw new Error('Hacker News未返回讨论列表');
  return payload.hits.flatMap((hit) => {
    const id = String(hit.objectID || hit.story_id || '');
    const title = String(hit.title || hit.story_title || '').trim();
    const externalUrl = validUrl(hit.url || hit.story_url);
    const discussionUrl = id ? `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}` : externalUrl;
    const publishedAt = hit.created_at && !Number.isNaN(Date.parse(hit.created_at))
      ? new Date(hit.created_at).toISOString() : null;
    const relevance = relevanceFor(`${title}\n${externalUrl || ''}`, ticker, companyName);
    if (!title || !discussionUrl || !publishedAt || relevance < 0.35) return [];
    const points = Math.max(0, Number(hit.points) || 0);
    const comments = Math.max(0, Number(hit.num_comments) || 0);
    return [articleFromSource({
      provider: 'hacker_news', sourceItemId: id || discussionUrl, contentKind: 'DISCUSSION',
      ticker, publishedAt, title, summary: externalUrl ? `讨论关联链接：${externalUrl}` : null,
      url: discussionUrl, sourceName: 'Hacker News', sourceDomain: 'news.ycombinator.com', relevance,
      engagementScore: points + comments * 2, rawMetrics: { points, comments, externalUrl }
    })];
  });
}

export class HackerNewsDiscussionProvider {
  constructor({ fetchImpl = fetch } = {}) { this.fetchImpl = fetchImpl; this.name = 'hacker_news'; }
  assertConfigured() {}
  async fetchNews(tickerValue, options = {}) {
    const ticker = normalizeTicker(tickerValue);
    const companyName = String(options.companyName || '').trim();
    const url = new URL(HACKER_NEWS_SEARCH_URL);
    url.searchParams.set('query', companyName || ticker);
    url.searchParams.set('tags', 'story'); url.searchParams.set('hitsPerPage', '50');
    const response = await fetchWithTimeout(this.fetchImpl, url, 'Hacker News');
    return { ticker, articles: normalizeHackerNews(await response.json(), ticker, companyName) };
  }
}

export class CompositeNewsProvider {
  constructor(providers = []) { this.providers = providers.filter(Boolean); this.name = 'multi_source'; }
  assertConfigured() {
    if (!this.providers.length) throw new Error('没有可用的新闻来源');
  }
  async fetchNews(tickerValue, options = {}) {
    const ticker = normalizeTicker(tickerValue);
    const articles = [];
    const sourceResults = [];
    for (const provider of this.providers) {
      try {
        provider.assertConfigured();
        const result = await provider.fetchNews(ticker, options);
        articles.push(...result.articles);
        sourceResults.push({ provider: provider.name, ok: true, count: result.articles.length });
      } catch (error) {
        sourceResults.push({ provider: provider.name, ok: false, error: error.message });
      }
    }
    if (!sourceResults.some((result) => result.ok)) {
      throw new Error(`全部新闻来源同步失败：${sourceResults.map((result) => `${result.provider}: ${result.error}`).join('；')}`);
    }
    return { ticker, articles, sourceResults };
  }
}
