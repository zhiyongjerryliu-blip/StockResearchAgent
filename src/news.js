import { createHash } from 'node:crypto';
import { nowIso, toPlain, toPlainRows } from './db.js';
import { normalizeTicker, parseJson, round } from './domain.js';
import { createNotification } from './notifications.js';
import { sourceTier } from './news-sources.js';
import { listStockConcepts } from './concepts.js';

const ALPHA_VANTAGE_URL = 'https://www.alphavantage.co/query';
const NEWS_DOCUMENTATION = 'https://www.alphavantage.co/documentation/#news-sentiment';
const NEWS_CLASSIFIER_VERSION = 'news-risk-and-impact-keywords-v3-2026-09-02';

const P1_RULES = [
  ['BANKRUPTCY', '破产或偿付能力风险', /\b(bankrupt(?:cy)?|chapter\s*11|insolven(?:t|cy)|receivership)\b/i],
  ['DELISTING', '退市或上市资格风险', /\b(delist(?:ed|ing)?|listing deficiency|noncompliance notice)\b/i],
  ['DEFAULT', '债务违约风险', /\b(debt default|defaulted on|covenant breach|payment default)\b/i],
  ['FRAUD', '欺诈或重大会计风险', /\b(fraud|accounting irregularit|financial statements? should no longer be relied|restatement)\b/i],
  ['ENFORCEMENT', '重大执法或刑事调查风险', /\b(sec investigation|doj investigation|criminal investigation|indict(?:ed|ment))\b/i],
  ['BUYBACK_STOP', '股票回购计划暂停或终止', /\b(suspend(?:s|ed|ing)?|terminate(?:s|d|ing)?|cancel(?:s|led|ing)?)\b.{0,45}\b(share repurchase|stock buyback)\b/i],
  ['CUSTOMER_LOSS', '重大客户或合同流失', /\b(loses? (?:a )?(?:major|key) customer|customer cancels?|contract termination|terminates? (?:the )?supply agreement)\b/i]
];

const P2_RULES = [
  ['REGULATORY', '监管调查风险', /\b(regulatory probe|regulatory investigation|antitrust probe|subpoena)\b/i],
  ['SANCTIONS', '制裁或出口限制风险', /\b(sanction(?:ed|s)?|export ban|export restriction|entity list)\b/i],
  ['CYBER', '网络安全风险', /\b(cyberattack|cyber attack|data breach|ransomware)\b/i],
  ['RECALL', '产品召回或安全风险', /\b(product recall|safety recall|recalls? .* product)\b/i],
  ['LITIGATION', '重大诉讼风险', /\b(class action lawsuit|major lawsuit|patent infringement lawsuit)\b/i],
  ['GUIDANCE', '业绩预警或指引下调', /\b(profit warning|cuts? (?:its )?guidance|lowers? (?:its )?outlook|withdraws? guidance)\b/i],
  ['LAYOFF', '重大裁员或重组风险', /\b(mass layoffs?|workforce reduction|restructuring charges?)\b/i],
  ['CAPACITY_CUT', '减产、停产或工厂关闭风险', /\b(cuts? (?:production|output|capacity)|production halt|idles? (?:a )?(?:plant|factory|fab)|closes? (?:a )?(?:plant|factory|fab))\b/i]
];

const IMPACT_RULES = [
  ['BUYBACK_AUTHORIZATION', '股票回购计划新增或扩大', 'POSITIVE', 'P2', /\b(authoriz(?:e|es|ed|ing)|launch(?:es|ed|ing)|increase(?:s|d|ing)|expand(?:s|ed|ing)|resume(?:s|d|ing))\b.{0,55}\b(share repurchase|stock buyback|repurchase program)\b/i],
  ['BUYBACK_ACTIVITY', '股票回购执行进展', 'POSITIVE', 'P3', /\b(repurchase(?:d|s|ing)?|buy(?:s|ing|back))\b.{0,35}\b(shares?|common stock)\b/i],
  ['CAPACITY_EXPANSION', '新增或扩张产能', 'MIXED', 'P2', /\b(expand(?:s|ed|ing)? capacity|capacity expansion|new (?:plant|factory|fab)|opens? (?:a )?(?:plant|factory|fab)|production ramp|ramps? production)\b/i],
  ['CAPACITY_REDUCTION', '产能收缩或项目延期', 'NEGATIVE', 'P2', /\b(capacity reduction|cuts? (?:production|output|capacity)|delays? (?:a )?(?:plant|factory|fab|expansion)|idles? (?:a )?(?:plant|factory|fab))\b/i],
  ['MAJOR_INVESTMENT', '重大资本投资或项目', 'MIXED', 'P2', /\b(invest(?:s|ed|ing|ment)?|capital expenditure|capex)\b.{0,55}\b(?:\$|usd\s*)?\d+(?:\.\d+)?\s*(?:billion|million|bn|mn)\b/i],
  ['SUPPLY_AGREEMENT', '重大供应、客户或长期合同', 'POSITIVE', 'P2', /\b(supply agreement|long[- ]term contract|multi[- ]year contract|strategic customer|design win|purchase commitment)\b/i],
  ['INDUSTRY_PRICING', '行业价格与供需变化', 'MIXED', 'P2', /\b(price increase|price cut|pricing pressure|supply shortage|oversupply|inventory correction|demand recovery|demand slowdown)\b/i]
];

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function alphaTimeToIso(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '00'] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function isoToAlphaTime(value) {
  return String(value).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').slice(0, 13);
}

function daysBefore(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function articleKey(url, title, publishedAt) {
  return createHash('sha256').update(JSON.stringify([
    String(url || '').trim().toLowerCase(), String(title || '').trim(), publishedAt
  ])).digest('hex');
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|guccounter|guce_referrer|oc$|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return String(value || '').trim();
  }
}

function storyFingerprint(title) {
  const normalized = String(title || '').toLowerCase()
    .replace(/\s+-\s+[^-]{2,60}$/u, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, ' ')
    .trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

export function normalizeAlphaNews(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Alpha Vantage新闻数据格式无效');
  const providerError = payload['Error Message'] || payload.Information || payload.Note;
  if (providerError) throw new Error(`Alpha Vantage新闻暂不可用：${String(providerError).slice(0, 180)}`);
  if (!Array.isArray(payload.feed)) throw new Error('Alpha Vantage未返回新闻列表');
  return payload.feed.flatMap((row) => {
    const publishedAt = alphaTimeToIso(row.time_published);
    const url = validHttpUrl(row.url);
    const title = String(row.title || '').trim();
    if (!publishedAt || !url || !title) return [];
    return [{
      articleKey: articleKey(url, title, publishedAt),
      provider: 'alpha_vantage',
      sourceItemId: url,
      contentKind: 'NEWS',
      sourceTier: sourceTier(String(row.source_domain || '').trim(), 'NEWS'),
      publishedAt,
      title,
      summary: String(row.summary || '').trim() || null,
      sourceName: String(row.source || '').trim() || null,
      sourceDomain: String(row.source_domain || '').trim() || null,
      url,
      bannerImageUrl: validHttpUrl(row.banner_image),
      overallSentimentScore: numberOrNull(row.overall_sentiment_score),
      overallSentimentLabel: String(row.overall_sentiment_label || '').trim() || null,
      topics: Array.isArray(row.topics) ? row.topics.map((topic) => ({
        topic: String(topic.topic || '').trim(), relevanceScore: numberOrNull(topic.relevance_score)
      })).filter((topic) => topic.topic) : [],
      engagementScore: 0,
      rawMetrics: {},
      relationType: 'DIRECT',
      relationLabel: null,
      tickerSentiments: Array.isArray(row.ticker_sentiment) ? row.ticker_sentiment.map((item) => ({
        ticker: String(item.ticker || '').trim().toUpperCase(),
        relevanceScore: numberOrNull(item.relevance_score),
        sentimentScore: numberOrNull(item.ticker_sentiment_score),
        sentimentLabel: String(item.ticker_sentiment_label || '').trim() || null
      })).filter((item) => item.ticker) : []
    }];
  });
}

export function classifyNewsRisk(article, tickerLink) {
  const relevance = Number(tickerLink?.relevanceScore);
  if (!Number.isFinite(relevance) || relevance < 0.35) return null;
  const text = `${article.title}\n${article.summary || ''}`;
  const sentiment = Number(tickerLink.sentimentScore ?? article.overallSentimentScore);
  for (const [category, label, pattern] of P1_RULES) {
    const match = text.match(pattern);
    if (match && (!Number.isFinite(sentiment) || sentiment <= 0.05)) {
      if (article.contentKind === 'DISCUSSION') {
        return {
          severity: 'P2', category: `SOCIAL_${category}`, label: `社交讨论提及${label}`,
          matchedTerm: match[0], classifierVersion: NEWS_CLASSIFIER_VERSION
        };
      }
      return { severity: 'P1', category, label, matchedTerm: match[0], classifierVersion: NEWS_CLASSIFIER_VERSION };
    }
  }
  for (const [category, label, pattern] of P2_RULES) {
    const match = text.match(pattern);
    if (match) return { severity: 'P2', category, label, matchedTerm: match[0], classifierVersion: NEWS_CLASSIFIER_VERSION };
  }
  if (Number.isFinite(sentiment) && sentiment <= -0.5 && relevance >= 0.7) {
    return {
      severity: 'P2', category: 'NEGATIVE_SENTIMENT', label: '高相关强负面新闻',
      matchedTerm: null, classifierVersion: NEWS_CLASSIFIER_VERSION
    };
  }
  return null;
}

export function classifyNewsImpact(article, tickerLink) {
  const relevance = Number(tickerLink?.relevanceScore);
  if (!Number.isFinite(relevance) || relevance < 0.4) return null;
  const text = `${article.title}\n${article.summary || ''}`;
  for (const [category, label, direction, severity, pattern] of IMPACT_RULES) {
    const match = text.match(pattern);
    if (!match) continue;
    return {
      category, label, direction,
      severity: article.contentKind === 'DISCUSSION' && severity === 'P2' ? 'P3' : severity,
      matchedTerm: match[0], classifierVersion: NEWS_CLASSIFIER_VERSION
    };
  }
  return null;
}

export class AlphaVantageNewsProvider {
  constructor({
    apiKey = '', fetchImpl = fetch, minimumIntervalMs = 1100,
    sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    nowImpl = Date.now
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
    this.minimumIntervalMs = minimumIntervalMs;
    this.sleepImpl = sleepImpl;
    this.nowImpl = nowImpl;
    this.lastRequestAt = null;
    this.name = 'alpha_vantage';
  }

  assertConfigured() {
    if (!this.apiKey) throw new Error('请先在.env中配置ALPHA_VANTAGE_API_KEY');
  }

  async fetchNews(tickerValue, options = {}) {
    this.assertConfigured();
    const ticker = normalizeTicker(tickerValue);
    const url = new URL(ALPHA_VANTAGE_URL);
    url.searchParams.set('function', 'NEWS_SENTIMENT');
    url.searchParams.set('tickers', ticker);
    if (options.timeFrom) url.searchParams.set('time_from', isoToAlphaTime(options.timeFrom));
    url.searchParams.set('sort', 'LATEST');
    url.searchParams.set('limit', String(Math.min(1000, Math.max(1, options.limit || 200))));
    url.searchParams.set('apikey', this.apiKey);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.lastRequestAt != null) {
        const remaining = this.minimumIntervalMs - (this.nowImpl() - this.lastRequestAt);
        if (remaining > 0) await this.sleepImpl(remaining);
      }
      this.lastRequestAt = this.nowImpl();
      let response;
      try {
        response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      } catch (error) {
        const code = error?.cause?.code || error?.code;
        throw new Error(`Alpha Vantage新闻请求失败${code ? `（${code}）` : ''}`);
      }
      if (!response.ok) throw new Error(`Alpha Vantage新闻请求失败：HTTP ${response.status}`);
      const payload = await response.json();
      const providerMessage = String(payload?.Information || payload?.Note || '');
      if (attempt === 0 && /per second|more sparingly/i.test(providerMessage)) {
        await this.sleepImpl(this.minimumIntervalMs);
        this.lastRequestAt = null;
        continue;
      }
      return { ticker, articles: normalizeAlphaNews(payload) };
    }
    throw new Error('Alpha Vantage新闻请求超过频率限制');
  }
}

function saveArticle(db, article, ticker, link, timestamp) {
  const normalizedUrl = canonicalUrl(article.url);
  const fingerprint = storyFingerprint(article.title);
  const existingArticle = toPlain(db.prepare(`
    SELECT id FROM news_articles
    WHERE article_key = ? OR canonical_url = ? OR (
      story_fingerprint = ? AND ABS(julianday(published_at) - julianday(?)) <= 2
    )
    ORDER BY CASE WHEN article_key = ? THEN 0 WHEN canonical_url = ? THEN 1 ELSE 2 END
    LIMIT 1
  `).get(
    article.articleKey, normalizedUrl, fingerprint, article.publishedAt,
    article.articleKey, normalizedUrl
  ));
  let articleId;
  if (existingArticle) {
    articleId = Number(existingArticle.id);
    db.prepare(`
      UPDATE news_articles SET
        canonical_url = COALESCE(canonical_url, ?), story_fingerprint = COALESCE(story_fingerprint, ?),
        content_kind = CASE WHEN content_kind = 'NEWS' OR ? = 'NEWS' THEN 'NEWS' ELSE 'DISCUSSION' END,
        source_tier = CASE WHEN source_tier = 'TIER_1' OR ? <> 'TIER_1' THEN source_tier ELSE ? END,
        summary = COALESCE(summary, ?), banner_image_url = COALESCE(banner_image_url, ?),
        overall_sentiment_score = COALESCE(?, overall_sentiment_score),
        overall_sentiment_label = COALESCE(?, overall_sentiment_label),
        engagement_score = MAX(engagement_score, ?), raw_metrics_json = ?, last_seen_at = ?
      WHERE id = ?
    `).run(
      normalizedUrl, fingerprint, article.contentKind || 'NEWS', article.sourceTier || 'TIER_2',
      article.sourceTier || 'TIER_2', article.summary, article.bannerImageUrl,
      article.overallSentimentScore, article.overallSentimentLabel,
      article.engagementScore || 0, JSON.stringify(article.rawMetrics || {}), timestamp, articleId
    );
  } else {
    const result = db.prepare(`
      INSERT INTO news_articles (
        article_key, provider, canonical_url, story_fingerprint, content_kind, source_tier,
        published_at, title, summary, source_name, source_domain, url, banner_image_url,
        overall_sentiment_score, overall_sentiment_label, engagement_score, raw_metrics_json,
        topics_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      article.articleKey, article.provider || 'unknown', normalizedUrl, fingerprint,
      article.contentKind || 'NEWS', article.sourceTier || 'TIER_2', article.publishedAt,
      article.title, article.summary, article.sourceName, article.sourceDomain, article.url,
      article.bannerImageUrl, article.overallSentimentScore, article.overallSentimentLabel,
      article.engagementScore || 0, JSON.stringify(article.rawMetrics || {}),
      JSON.stringify(article.topics || []), timestamp, timestamp
    );
    articleId = Number(result.lastInsertRowid);
  }
  const existingSource = db.prepare(`
    SELECT 1 FROM news_article_sources
    WHERE article_id = ? AND provider = ? AND source_item_id = ?
  `).get(articleId, article.provider || 'unknown', article.sourceItemId || article.articleKey);
  db.prepare(`
    INSERT INTO news_article_sources (
      article_id, provider, source_item_id, publisher_name, publisher_domain,
      source_url, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(article_id, provider, source_item_id) DO UPDATE SET
      publisher_name = excluded.publisher_name, publisher_domain = excluded.publisher_domain,
      source_url = excluded.source_url, last_seen_at = excluded.last_seen_at
  `).run(
    articleId, article.provider || 'unknown', article.sourceItemId || article.articleKey,
    article.sourceName, article.sourceDomain, article.url, timestamp, timestamp
  );
  const existingLink = db.prepare(
    'SELECT 1 FROM news_article_links WHERE article_id = ? AND ticker = ?'
  ).get(articleId, ticker);
  db.prepare(`
    INSERT INTO news_article_links (
      article_id, ticker, relevance_score, sentiment_score, sentiment_label,
      relation_type, relation_label
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(article_id, ticker) DO UPDATE SET
      relevance_score = excluded.relevance_score,
      sentiment_score = excluded.sentiment_score,
      sentiment_label = excluded.sentiment_label,
      relation_type = CASE
        WHEN news_article_links.relation_type = 'DIRECT' OR excluded.relation_type <> 'DIRECT'
          THEN news_article_links.relation_type ELSE 'DIRECT' END,
      relation_label = CASE
        WHEN news_article_links.relation_type = 'DIRECT' THEN news_article_links.relation_label
        ELSE excluded.relation_label END
  `).run(
    articleId, ticker, link.relevanceScore, link.sentimentScore, link.sentimentLabel,
    article.relationType || 'DIRECT', article.relationLabel || null
  );
  const publisherCount = Number(db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(NULLIF(publisher_domain, ''), NULLIF(publisher_name, ''), provider)) AS count
    FROM news_article_sources WHERE article_id = ?
  `).get(articleId).count);
  return {
    articleId, newArticle: !existingArticle, newLink: !existingLink,
    newSource: !existingSource, publisherCount,
    storedArticleKey: db.prepare('SELECT article_key FROM news_articles WHERE id = ?').get(articleId).article_key
  };
}

function saveNewsRiskEvent(
  db, ticker, article, link, risk, timestamp, publisherCount = 1, storedArticleKey = article.articleKey
) {
  const eventKey = `NEWS_RISK:${storedArticleKey}:${ticker}`;
  const existing = db.prepare('SELECT id FROM research_events WHERE event_key = ?').get(eventKey);
  const evidence = [{
    source: article.sourceName || article.provider || '未知来源', provider: article.provider,
    sourceTier: article.sourceTier || 'TIER_2', contentKind: article.contentKind || 'NEWS',
    corroboratingPublishers: publisherCount,
    articleKey: storedArticleKey, publishedAt: article.publishedAt,
    relevanceScore: link.relevanceScore, sentimentScore: link.sentimentScore,
    sentimentLabel: link.sentimentLabel, matchedTerm: risk.matchedTerm,
    classifierVersion: risk.classifierVersion, sourceUrl: article.url,
    providerDocumentation: article.provider === 'alpha_vantage' ? NEWS_DOCUMENTATION : null
  }];
  const summary = `新闻“${article.title}”触发“${risk.label}”规则。该结论仅基于标题、摘要、相关性和情绪字段，必须核实原文及官方信息。`;
  db.prepare(`
    INSERT INTO research_events (
      event_key, ticker, event_date, event_type, title, summary, severity,
      source_type, source_id, source_url, evidence_json, status, detected_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'NEWS_RISK', ?, ?, ?, 'UNVERIFIED', ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET
      title = excluded.title, summary = excluded.summary, severity = excluded.severity,
      evidence_json = excluded.evidence_json, updated_at = excluded.updated_at
  `).run(
    eventKey, ticker, article.publishedAt.slice(0, 10), `NEWS_${risk.category}`,
    `${ticker} 新闻风险：${risk.label}`, summary, risk.severity,
    storedArticleKey, article.url, JSON.stringify(evidence), timestamp, timestamp
  );
  return {
    created: !existing,
    event: toPlain(db.prepare('SELECT * FROM research_events WHERE event_key = ?').get(eventKey))
  };
}

function saveNewsImpactEvent(
  db, ticker, article, link, impact, timestamp, publisherCount = 1,
  storedArticleKey = article.articleKey
) {
  const eventKey = `NEWS_IMPACT:${storedArticleKey}:${ticker}:${impact.category}`;
  const existing = db.prepare('SELECT id FROM research_events WHERE event_key = ?').get(eventKey);
  const relationType = article.relationType || 'DIRECT';
  const relationLabel = article.relationLabel || (relationType === 'DIRECT' ? '公司直接相关新闻' : '外部关联信息');
  const evidence = [{
    source: article.sourceName || article.provider || '未知来源', provider: article.provider,
    sourceTier: article.sourceTier || 'TIER_2', contentKind: article.contentKind || 'NEWS',
    corroboratingPublishers: publisherCount,
    articleKey: storedArticleKey, publishedAt: article.publishedAt,
    relevanceScore: link.relevanceScore, sentimentScore: link.sentimentScore,
    relationType, relationLabel, direction: impact.direction,
    matchedTerm: impact.matchedTerm, classifierVersion: impact.classifierVersion,
    sourceUrl: article.url,
    providerDocumentation: article.provider === 'alpha_vantage' ? NEWS_DOCUMENTATION : null
  }];
  const relationText = relationType === 'DIRECT'
    ? '公司直接相关新闻'
    : `${relationLabel}关联信息`;
  const summary = `“${article.title}”命中“${impact.label}”规则，方向标记为${impact.direction}。这是${relationText}，仅表示可能的股价驱动，待核实且不等于已确认因果。`;
  db.prepare(`
    INSERT INTO research_events (
      event_key, ticker, event_date, event_type, title, summary, severity,
      source_type, source_id, source_url, evidence_json, status, detected_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'NEWS_IMPACT', ?, ?, ?, 'UNVERIFIED', ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET
      title = excluded.title, summary = excluded.summary, severity = excluded.severity,
      source_url = excluded.source_url, evidence_json = excluded.evidence_json,
      updated_at = excluded.updated_at
  `).run(
    eventKey, ticker, article.publishedAt.slice(0, 10), `NEWS_${impact.category}`,
    `${ticker} 外部驱动：${impact.label}`, summary, impact.severity,
    storedArticleKey, article.url, JSON.stringify(evidence), timestamp, timestamp
  );
  return {
    created: !existing,
    event: toPlain(db.prepare('SELECT * FROM research_events WHERE event_key = ?').get(eventKey))
  };
}

export async function syncNewsForTicker(db, provider, tickerValue, asOf, options = {}) {
  const ticker = normalizeTicker(tickerValue);
  const providerName = provider.name || 'custom';
  const status = toPlain(db.prepare('SELECT * FROM news_sync_status WHERE ticker = ?').get(ticker));
  if (!options.force && status?.last_as_of === asOf) {
    return {
      ticker, ok: true, cached: true, articles: 0, newLinks: 0,
      riskEvents: 0, impactEvents: 0, notified: 0
    };
  }
  const initialSync = !status || status.provider !== providerName;
  const defaultFrom = `${daysBefore(asOf, 7)}T00:00:00.000Z`;
  const timeFrom = status?.last_fetched_at || defaultFrom;
  let payload;
  try {
    const security = toPlain(db.prepare('SELECT name FROM securities WHERE ticker = ?').get(ticker));
    payload = await provider.fetchNews(ticker, {
      timeFrom, limit: 200, companyName: security?.name || '',
      concepts: listStockConcepts(db, ticker)
    });
  } catch (error) {
    if (status) db.prepare(`
      UPDATE news_sync_status SET last_error = ?, updated_at = ? WHERE ticker = ?
    `).run(error.message, nowIso(), ticker);
    throw error;
  }
  const timestamp = nowIso();
  const notifier = options.notifier || createNotification;
  let newLinks = 0;
  let riskEvents = 0;
  let impactEvents = 0;
  let notified = 0;
  let latestPublishedAt = status?.last_published_at || null;
  for (const article of payload.articles) {
    const link = article.tickerSentiments.find((item) => item.ticker === ticker);
    if (!link) continue;
    const saved = saveArticle(db, article, ticker, link, timestamp);
    if (saved.newLink) newLinks += 1;
    if (!latestPublishedAt || article.publishedAt > latestPublishedAt) latestPublishedAt = article.publishedAt;
    const risk = classifyNewsRisk(article, link);
    if (risk) {
      const riskEvent = saveNewsRiskEvent(
        db, ticker, article, link, risk, timestamp, saved.publisherCount, saved.storedArticleKey
      );
      if (riskEvent.created) riskEvents += 1;
      const recentThreshold = daysBefore(asOf, 3);
      const categoryPublisherCount = Number(db.prepare(`
        SELECT COUNT(DISTINCT json_extract(evidence_json, '$[0].source')) AS count
        FROM research_events
        WHERE ticker = ? AND event_type = ? AND source_type = 'NEWS_RISK'
          AND date(event_date) BETWEEN date(?, '-2 days') AND date(?, '+2 days')
      `).get(ticker, riskEvent.event.event_type, riskEvent.event.event_date, riskEvent.event.event_date).count);
      const corroboratingPublishers = Math.max(saved.publisherCount, categoryPublisherCount);
      const alertEligible = article.contentKind !== 'DISCUSSION' && (
        article.sourceTier === 'TIER_1' || corroboratingPublishers >= 2
      );
      const alreadyAlerted = db.prepare(
        'SELECT 1 FROM news_risk_alerts WHERE event_key = ?'
      ).get(riskEvent.event.event_key);
      if (
        !initialSync && (saved.newLink || saved.newSource) && risk.severity === 'P1'
        && alertEligible && !alreadyAlerted
        && article.publishedAt.slice(0, 10) >= recentThreshold
      ) {
        await notifier(db, {
          ticker, severity: 'P1', category: 'NEWS_RISK_SIGNAL',
          title: `${ticker} 待核实新闻风险：${risk.label}`,
          body: `新闻“${article.title}”触发风险规则。请先核实原文和官方信息，不构成买卖建议。`,
          evidence: parseJson(riskEvent.event.evidence_json, [])
        });
        db.prepare(`
          INSERT INTO news_risk_alerts (event_key, notified_at, basis_json) VALUES (?, ?, ?)
        `).run(riskEvent.event.event_key, timestamp, JSON.stringify({
          sourceTier: article.sourceTier, corroboratingPublishers
        }));
        notified += 1;
      }
    }
    const impact = classifyNewsImpact(article, link);
    if (impact) {
      const impactEvent = saveNewsImpactEvent(
        db, ticker, article, link, impact, timestamp, saved.publisherCount, saved.storedArticleKey
      );
      if (impactEvent.created) impactEvents += 1;
    }
  }
  const articleCount = Number(db.prepare(
    'SELECT COUNT(*) AS count FROM news_article_links WHERE ticker = ?'
  ).get(ticker).count);
  db.prepare(`
    INSERT INTO news_sync_status (
      ticker, provider, last_as_of, last_fetched_at, last_published_at,
      article_count, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      provider = excluded.provider, last_as_of = excluded.last_as_of,
      last_fetched_at = excluded.last_fetched_at,
      last_published_at = excluded.last_published_at,
      article_count = excluded.article_count, last_error = NULL, updated_at = excluded.updated_at
  `).run(ticker, providerName, asOf, timestamp, latestPublishedAt, articleCount, timestamp);
  return {
    ticker, ok: true, initialSync, articles: payload.articles.length, newLinks,
    riskEvents, impactEvents, notified,
    sources: payload.sourceResults || [{ provider: providerName, ok: true, count: payload.articles.length }]
  };
}

export async function syncWatchlistNews(db, provider, asOf, options = {}) {
  if (!provider) return { skipped: true, reason: 'provider-unavailable', results: [] };
  try {
    provider.assertConfigured();
  } catch (error) {
    return { skipped: true, reason: 'not-configured', error: error.message, results: [] };
  }
  const stocks = toPlainRows(db.prepare(
    'SELECT ticker FROM watchlist_items WHERE enabled = 1 ORDER BY ticker'
  ).all());
  const results = [];
  for (const stock of stocks) {
    try {
      results.push(await syncNewsForTicker(db, provider, stock.ticker, asOf, options));
    } catch (error) {
      results.push({ ticker: stock.ticker, ok: false, error: error.message });
    }
  }
  return { skipped: false, asOf, results };
}

export function listNewsArticles(db, options = {}) {
  const ticker = options.ticker ? normalizeTicker(options.ticker) : null;
  const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 100));
  const filters = ticker
    ? ['l.ticker = ?']
    : ['EXISTS (SELECT 1 FROM watchlist_items w WHERE w.ticker = l.ticker)'];
  const params = ticker ? [ticker, limit] : [limit];
  const rows = toPlainRows(db.prepare(`
    SELECT a.*, l.ticker, l.relevance_score, l.sentiment_score, l.sentiment_label,
           l.relation_type, l.relation_label,
           s.name,
           (SELECT COUNT(DISTINCT COALESCE(NULLIF(ns.publisher_domain, ''), NULLIF(ns.publisher_name, ''), ns.provider))
            FROM news_article_sources ns WHERE ns.article_id = a.id) AS source_count,
           (SELECT json_group_array(DISTINCT ns.provider)
            FROM news_article_sources ns WHERE ns.article_id = a.id) AS providers_json,
           EXISTS (
             SELECT 1 FROM research_events e
             WHERE e.event_key = ('NEWS_RISK:' || a.article_key || ':' || l.ticker)
           ) AS has_risk_event,
           EXISTS (
             SELECT 1 FROM research_events e
             WHERE e.source_type = 'NEWS_IMPACT' AND e.source_id = a.article_key
               AND e.ticker = l.ticker
           ) AS has_impact_event
    FROM news_articles a
    JOIN news_article_links l ON l.article_id = a.id
    JOIN securities s ON s.ticker = l.ticker
    WHERE ${filters.join(' AND ')}
    ORDER BY a.published_at DESC, a.id DESC
    LIMIT ?
  `).all(...params));
  return rows.map((row) => ({
    ...row,
    has_risk_event: Boolean(row.has_risk_event),
    has_impact_event: Boolean(row.has_impact_event),
    topics: parseJson(row.topics_json, []),
    raw_metrics: parseJson(row.raw_metrics_json, {}),
    providers: parseJson(row.providers_json, []),
    relevance_score: round(row.relevance_score, 4),
    sentiment_score: round(row.sentiment_score, 4)
  }));
}

export function getNewsSentimentSummary(db, options = {}) {
  const ticker = options.ticker ? normalizeTicker(options.ticker) : null;
  const filters = ticker ? 'WHERE l.ticker = ?' : '';
  const rows = toPlainRows(db.prepare(`
    SELECT a.published_at, a.content_kind, a.source_name, a.source_domain,
           a.engagement_score, l.ticker, l.sentiment_score,
           EXISTS (
             SELECT 1 FROM research_events e
             WHERE e.event_key = ('NEWS_RISK:' || a.article_key || ':' || l.ticker)
           ) AS has_risk_event
    FROM news_articles a
    JOIN news_article_links l ON l.article_id = a.id
    ${filters}
  `).all(...(ticker ? [ticker] : [])));
  const now = options.asOf && /^\d{4}-\d{2}-\d{2}$/.test(options.asOf)
    ? Date.parse(`${options.asOf}T23:59:59.999Z`) : Date.now();
  const within = (row, hours) => {
    const age = now - Date.parse(row.published_at);
    return age >= 0 && age <= hours * 3_600_000;
  };
  const recent = rows.filter((row) => within(row, 168));
  const current24h = rows.filter((row) => within(row, 24));
  const previous24h = rows.filter((row) => {
    const age = now - Date.parse(row.published_at);
    return age > 24 * 3_600_000 && age <= 48 * 3_600_000;
  });
  const sentiments = recent.map((row) => Number(row.sentiment_score)).filter(Number.isFinite);
  const averageSentiment = sentiments.length
    ? sentiments.reduce((sum, value) => sum + value, 0) / sentiments.length : null;
  const negativeCount = sentiments.filter((value) => value <= -0.2).length;
  const sourceSet = new Set(recent.map((row) => row.source_domain || row.source_name).filter(Boolean));
  let trend = '数据不足';
  if (sentiments.length >= 3 && sourceSet.size >= 2) {
    if (averageSentiment >= 0.2) trend = '偏多';
    else if (averageSentiment <= -0.2) trend = '偏空';
    else trend = '中性';
  }
  return {
    ticker,
    windowHours: 168,
    total: recent.length,
    newsCount: recent.filter((row) => row.content_kind === 'NEWS').length,
    discussionCount: recent.filter((row) => row.content_kind === 'DISCUSSION').length,
    uniqueSources: sourceSet.size,
    riskSignals: recent.filter((row) => row.has_risk_event).length,
    averageSentiment: round(averageSentiment, 4),
    negativeRatio: sentiments.length ? round(negativeCount / sentiments.length, 4) : null,
    engagementScore: recent.reduce((sum, row) => sum + (Number(row.engagement_score) || 0), 0),
    buzzChange: previous24h.length
      ? round((current24h.length - previous24h.length) / previous24h.length, 4)
      : null,
    current24hCount: current24h.length,
    previous24hCount: previous24h.length,
    trend,
    sufficient: sentiments.length >= 3 && sourceSet.size >= 2
  };
}
