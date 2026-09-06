import { nowIso, toPlainRows } from './db.js';
import { calculatePortfolio, saveDailySnapshots } from './portfolio.js';
import { explainStructuredReview } from './llm.js';
import { parseJson, round } from './domain.js';
import { getNewsSentimentSummary } from './news.js';
import { getExternalDriversOverview } from './external-drivers.js';
import { getMarketContext } from './market-context.js';
import { buildInvestmentAdvice } from './advice.js';
import { analyzeCapitalFlow } from './capital-flow.js';
import { analyzeIntradayFlow } from './intraday-flow.js';

function volumeContext(db, ticker) {
  const rows = toPlainRows(db.prepare(`
    SELECT trade_date, close, volume
    FROM (
      SELECT trade_date, close, volume, provider, ingested_at,
             ROW_NUMBER() OVER (
               PARTITION BY trade_date
               ORDER BY CASE WHEN provider = 'manual' THEN 0 ELSE 1 END, ingested_at DESC
             ) AS row_number
      FROM prices_daily WHERE ticker = ?
    )
    WHERE row_number = 1
    ORDER BY trade_date DESC
    LIMIT 21
  `).all(ticker));
  const latest = rows[0];
  const history = rows.slice(1).filter((row) => Number.isFinite(row.volume));
  const averageVolume = history.length
    ? history.reduce((sum, row) => sum + row.volume, 0) / history.length
    : null;
  return {
    volume: latest?.volume ?? null,
    averageVolume20d: round(averageVolume, 0),
    relativeVolume: latest?.volume && averageVolume
      ? round(latest.volume / averageVolume, 2)
      : null
  };
}

function latestPredictions(db, ticker) {
  const rows = toPlainRows(db.prepare(`
    SELECT p.* FROM predictions p
    JOIN (
      SELECT horizon_days, MAX(as_of) AS max_as_of
      FROM predictions WHERE ticker = ? GROUP BY horizon_days
    ) latest
      ON latest.horizon_days = p.horizon_days AND latest.max_as_of = p.as_of
    WHERE p.ticker = ?
    ORDER BY p.horizon_days
  `).all(ticker, ticker));
  return rows.map((row) => ({
    horizonDays: row.horizon_days,
    returnP50: row.return_p50,
    priceP50: row.price_p50,
    probabilityUp: row.probability_up,
    reliabilityScore: row.reliability_score,
    publicationStatus: row.publication_status,
    rationale: parseJson(row.rationale_json, {})
  }));
}

function recentResearchEvents(db, ticker, reviewDate, lookbackDays = 7) {
  const start = new Date(`${reviewDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - (lookbackDays - 1));
  const startDate = start.toISOString().slice(0, 10);
  return toPlainRows(db.prepare(`
    SELECT id, event_date, event_type, title, summary, severity, status,
           source_type, source_id, source_url, evidence_json
    FROM research_events
    WHERE ticker = ? AND event_date BETWEEN ? AND ?
    ORDER BY event_date DESC, id DESC
  `).all(ticker, startDate, reviewDate)).map((event) => ({
    ...event,
    evidence: parseJson(event.evidence_json, [])
  }));
}

function deterministicStockNarrative(review) {
  const {
    position, market, predictions, events, sentiment, externalDrivers,
    investmentAdvice, capitalFlow, intradayFlow
  } = review;
  const pieces = [];
  if (position.currentPrice == null) {
    pieces.push(`${position.ticker} 暂无有效收盘行情，今日无法完成收益和走势判断。`);
  } else if (position.dailyReturn == null) {
    pieces.push(
      `${position.ticker} 截至 ${position.priceDate} 收盘价 $${position.currentPrice.toFixed(2)}。` +
      `前一交易日 ${position.expectedPreviousPriceDate || '未知'} 的收盘行情缺失，暂不计算当日涨跌和当日盈亏。`
    );
  } else {
    const direction = position.dailyReturn >= 0 ? '上涨' : '下跌';
    const pct = `${Math.abs(position.dailyReturn * 100).toFixed(2)}%`;
    pieces.push(`${position.ticker} 今日${direction}${pct}，收盘价 $${position.currentPrice.toFixed(2)}。`);
  }
  if (position.quantity > 0 && position.totalPnl != null) {
    pieces.push(`当前持有 ${position.quantity} 股，累计总盈亏 $${position.totalPnl.toFixed(2)}，未实现盈亏 $${position.unrealizedPnl.toFixed(2)}。`);
  } else if (position.quantity === 0) {
    pieces.push(`当前无持仓，累计已实现盈亏 $${position.realizedPnl.toFixed(2)}。`);
  }
  if (market.relativeVolume != null) {
    pieces.push(`成交量为近20日均量的 ${market.relativeVolume.toFixed(2)} 倍。`);
  }
  if (capitalFlow?.signal && capitalFlow.signal !== 'INSUFFICIENT') {
    pieces.push(
      `日线资金行为为${capitalFlow.signalLabel}（评分${capitalFlow.score >= 0 ? '+' : ''}${capitalFlow.score.toFixed(1)}，` +
      `证据置信${capitalFlow.confidence.toFixed(1)}分）；该结论是公开量价代理，不能确认机构账户身份。`
    );
  } else {
    pieces.push('资金行为有效成交量历史不足，暂不判断建仓或派发。');
  }
  if (intradayFlow?.asOf) {
    if (['FUTU_TICK_DIRECTION', 'FUTU_TICK_DIRECTION_PARTIAL'].includes(intradayFlow.dataLevel)) {
      pieces.push(
        `分钟主动资金为${intradayFlow.signalLabel}（评分${intradayFlow.score >= 0 ? '+' : ''}${intradayFlow.score.toFixed(1)}，` +
        `证据置信${intradayFlow.confidence.toFixed(1)}分，截至${intradayFlow.asOf.slice(11, 19)} ET）；` +
        '逐笔方向不能确认机构或最终账户身份。'
      );
    } else {
      pieces.push('当日仅有分钟量价代理，逐笔主动买卖覆盖不足，不纳入高置信资金判断。');
    }
  } else {
    pieces.push('当日未采集到可用的富途分钟成交数据。');
  }
  const secEvents = events.filter((event) => event.source_type === 'SEC_8K');
  const newsRisks = events.filter((event) => event.source_type === 'NEWS_RISK');
  const newsImpacts = events.filter((event) => event.source_type === 'NEWS_IMPACT');
  const officialHighRisk = secEvents.filter((event) => ['P0', 'P1'].includes(event.severity));
  pieces.push(
    `近7日有 ${secEvents.length} 个已入库SEC 8-K事件` +
    `${officialHighRisk.length ? `，其中${officialHighRisk.length}个为P0/P1风险` : ''}；` +
    `${newsRisks.length} 个待核实新闻风险信号，${newsImpacts.length} 个待核实外部驱动信号。`
  );
  if (events.length) pieces.push(`最新事项为“${events[0].title}”。`);
  if (sentiment.sufficient) {
    pieces.push(
      `近7日纳入${sentiment.newsCount}条新闻、${sentiment.discussionCount}条公开讨论，` +
      `覆盖${sentiment.uniqueSources}个独立来源，综合情绪为${sentiment.trend}` +
      `（平均${sentiment.averageSentiment.toFixed(2)}，负面占比${(sentiment.negativeRatio * 100).toFixed(0)}%）。`
    );
  } else {
    pieces.push(`近7日舆情样本不足，当前不输出多空趋势。`);
  }
  const repurchases = externalDrivers?.corporateActions?.shareRepurchases;
  const capex = externalDrivers?.corporateActions?.capitalExpenditure;
  if (repurchases?.available) {
    pieces.push(
      `SEC披露的最近一期普通股回购现金支出为 $${Number(repurchases.value).toFixed(0)}` +
      `（${repurchases.periodStart || '期初未知'}至${repurchases.periodEnd}，${repurchases.periodType}口径）；` +
      '该金额不等同于剩余回购授权额度。'
    );
  }
  if (capex?.available) {
    pieces.push(
      `SEC披露的最近一期资本开支为 $${Number(capex.value).toFixed(0)}` +
      `（${capex.periodStart || '期初未知'}至${capex.periodEnd}，${capex.periodType}口径）；` +
      '资本开支只是投资代理，不能单独证明产能已经增加。'
    );
  }
  const macro = externalDrivers?.macro;
  if (macro?.available) {
    const tenYear = macro.metrics?.US10Y_YIELD;
    const expectedRate = macro.metrics?.FED_FUNDS_FUTURES;
    const metricParts = [];
    if (Number.isFinite(tenYear?.changeBps)) metricParts.push(`10年期收益率单日变动${tenYear.changeBps >= 0 ? '+' : ''}${tenYear.changeBps.toFixed(1)}bp`);
    if (Number.isFinite(expectedRate?.changeBps)) metricParts.push(`联邦基金期货隐含利率变动${expectedRate.changeBps >= 0 ? '+' : ''}${expectedRate.changeBps.toFixed(1)}bp`);
    pieces.push(`利率与美债环境为${macro.regime}${metricParts.length ? `（${metricParts.join('，')}）` : ''}；这些是免费市场代理，不代表个股确定方向。`);
  }
  if (investmentAdvice?.advice?.length) {
    pieces.push(`条件式研究建议：${investmentAdvice.advice.map((item) => (
      `${item.horizonLabel}${item.actionLabel}（影响分${item.impactScore >= 0 ? '+' : ''}${item.impactScore.toFixed(1)}，${item.publicationStatus}）`
    )).join('；')}。`);
    if (!investmentAdvice.advice.some((item) => item.formalReady)) {
      pieces.push('当前没有期限通过预测可靠度闸门，以上只用于观察或风险复核，不作为正式买卖指令。');
    }
  }
  const published = predictions.filter((prediction) => prediction.publicationStatus === 'PUBLISHED');
  if (published.length) {
    pieces.push(`有 ${published.length} 个期限通过综合可靠度发布门槛。`);
  } else {
    pieces.push('当前没有通过综合可靠度门槛的正式预测。');
  }
  pieces.push('新闻风险仅是规则初筛，必须核实原文及官方披露；公开成交数据不能确认最终交易账户身份。');
  return pieces.join('');
}

async function saveReview(db, reviewDate, ticker, type, structured, narrative, modelVersion = null) {
  db.prepare(`
    INSERT INTO daily_reviews (
      ticker, review_date, review_type, status, structured_json, narrative, model_version, created_at
    ) VALUES (?, ?, ?, 'FINAL', ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      structured_json = excluded.structured_json,
      narrative = excluded.narrative,
      model_version = excluded.model_version,
      created_at = excluded.created_at
  `).run(
    ticker,
    reviewDate,
    type,
    JSON.stringify(structured),
    narrative,
    modelVersion,
    nowIso()
  );
}

export async function generateDailyReviews(db, reviewDate, options = {}) {
  const portfolio = calculatePortfolio(db, reviewDate);
  const stockReviews = [];
  const targetTicker = options.ticker ? String(options.ticker).trim().toUpperCase() : null;

  for (const position of portfolio.positions.filter((item) => !targetTicker || item.ticker === targetTicker)) {
    const structured = {
      reviewDate,
      type: 'STOCK',
      position,
      market: volumeContext(db, position.ticker),
      capitalFlow: analyzeCapitalFlow(db, position.ticker, reviewDate),
      intradayFlow: analyzeIntradayFlow(db, position.ticker, reviewDate),
      events: recentResearchEvents(db, position.ticker, reviewDate),
      sentiment: getNewsSentimentSummary(db, { ticker: position.ticker, asOf: reviewDate }),
      externalDrivers: getExternalDriversOverview(db, position.ticker, reviewDate),
      investmentAdvice: buildInvestmentAdvice(db, position.ticker, reviewDate),
      predictions: latestPredictions(db, position.ticker),
      limitations: [
        '公开成交数据不能确认最终交易账户身份',
        '日线资金行为仍为量价代理；富途逐笔方向也不能识别机构或最终账户',
        '分钟资金信号只有在交易日匹配且覆盖和置信度达标时才进入条件式建议',
        '未达到综合可靠度门槛的预测不得作为正式预测发布',
        ...(position.priceDataStatus === 'MISSING_PREVIOUS'
          ? [`前一交易日 ${position.expectedPreviousPriceDate} 的收盘行情缺失，不得计算当日涨跌和当日盈亏`]
          : [])
      ]
    };
    let narrative = deterministicStockNarrative(structured);
    try {
      narrative = await explainStructuredReview(structured) || narrative;
    } catch (error) {
      structured.llmError = error.message;
    }
    await saveReview(db, reviewDate, position.ticker, 'STOCK', structured, narrative, 'review-v2');
    stockReviews.push({ ticker: position.ticker, structured, narrative });
  }

  if (targetTicker) {
    return { reviewDate, stockReviews, portfolio: null };
  }

  const portfolioStructured = {
    reviewDate,
    type: 'PORTFOLIO',
    totals: portfolio.totals,
    macro: getMarketContext(db, reviewDate),
    positions: portfolio.positions.map((position) => ({
      ticker: position.ticker,
      quantity: position.quantity,
      marketValue: position.marketValue,
      dailyPnl: position.dailyPnl,
      totalPnl: position.totalPnl,
      totalReturn: position.totalReturn
    })),
    recentEvents: stockReviews.flatMap((review) => review.structured.events.map((event) => ({
      ticker: review.ticker,
      eventDate: event.event_date,
      title: event.title,
      severity: event.severity,
      sourceType: event.source_type,
      status: event.status,
      sourceUrl: event.source_url
    }))),
    sentiment: stockReviews.map((review) => ({
      ticker: review.ticker,
      trend: review.structured.sentiment.trend,
      sufficient: review.structured.sentiment.sufficient,
      total: review.structured.sentiment.total,
      uniqueSources: review.structured.sentiment.uniqueSources,
      averageSentiment: review.structured.sentiment.averageSentiment
    })),
    intradayFlow: stockReviews.map((review) => ({
      ticker: review.ticker,
      tradeDate: review.structured.intradayFlow.tradeDate,
      asOf: review.structured.intradayFlow.asOf,
      signal: review.structured.intradayFlow.signal,
      signalLabel: review.structured.intradayFlow.signalLabel,
      score: review.structured.intradayFlow.score,
      confidence: review.structured.intradayFlow.confidence,
      dataLevel: review.structured.intradayFlow.dataLevel
    }))
  };
  const portfolioSecEvents = portfolioStructured.recentEvents.filter(
    (event) => event.sourceType === 'SEC_8K'
  );
  const portfolioNewsRisks = portfolioStructured.recentEvents.filter(
    (event) => event.sourceType === 'NEWS_RISK'
  );
  const portfolioRiskCount = portfolioSecEvents.filter(
    (event) => ['P0', 'P1'].includes(event.severity)
  ).length;
  const intradayOutflowCount = portfolioStructured.intradayFlow.filter((item) => (
    item.signal === 'STRONG_OUTFLOW' && item.confidence >= 60
  )).length;
  const portfolioNarrative = portfolio.positions.length
    ? `股票池共 ${portfolio.positions.length} 只股票，当前总市值 $${portfolio.totals.marketValue.toFixed(2)}，今日盈亏 $${portfolio.totals.dailyPnl.toFixed(2)}，累计总盈亏 $${portfolio.totals.totalPnl.toFixed(2)}。近7日有 ${portfolioSecEvents.length} 个SEC 8-K事件${portfolioRiskCount ? `，其中${portfolioRiskCount}个为P0/P1风险` : ''}，以及${portfolioNewsRisks.length}个待核实新闻风险信号；${intradayOutflowCount}只股票出现高置信分钟主动卖出显著占优。`
    : '股票池为空，请先录入测试股票和交易。';
  await saveReview(db, reviewDate, null, 'PORTFOLIO', portfolioStructured, portfolioNarrative, 'review-v2');

  return { reviewDate, stockReviews, portfolio: { structured: portfolioStructured, narrative: portfolioNarrative } };
}

function equalReviewValue(left, right) {
  if (left == null && right == null) return true;
  return left === right;
}

function storedPositionMatches(stored, current) {
  return [
    'currentPrice',
    'previousClose',
    'priceDate',
    'previousPriceDate',
    'expectedPreviousPriceDate',
    'priceDataStatus',
    'dailyPnl',
    'dailyReturn'
  ].every((field) => equalReviewValue(stored?.[field], current[field]));
}

export async function refreshDailyReviewsIfNeeded(db, reviewDate) {
  const existingRows = toPlainRows(db.prepare(`
    SELECT ticker, structured_json
    FROM daily_reviews
    WHERE review_date = ? AND review_type = 'STOCK' AND status = 'FINAL'
  `).all(reviewDate));
  if (!existingRows.length) {
    return { refreshed: false, reason: 'NO_EXISTING_STOCK_REVIEW', tickers: [] };
  }

  const existing = new Map(existingRows.map((row) => [
    row.ticker,
    parseJson(row.structured_json, {}).position
  ]));
  const portfolio = calculatePortfolio(db, reviewDate);
  const staleTickers = portfolio.positions
    .filter((position) => !storedPositionMatches(existing.get(position.ticker), position))
    .map((position) => position.ticker);

  if (!staleTickers.length) {
    return { refreshed: false, reason: 'UP_TO_DATE', tickers: [] };
  }

  saveDailySnapshots(db, reviewDate);
  await generateDailyReviews(db, reviewDate);
  return { refreshed: true, reason: 'PRICE_DATA_CHANGED', tickers: staleTickers };
}
