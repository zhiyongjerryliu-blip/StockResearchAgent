import { nowIso, toPlainRows } from './db.js';
import { calculatePortfolio } from './portfolio.js';
import { explainStructuredReview } from './llm.js';
import { parseJson, round } from './domain.js';

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

function deterministicStockNarrative(review) {
  const { position, market, predictions } = review;
  const pieces = [];
  if (position.currentPrice == null) {
    pieces.push(`${position.ticker} 暂无有效收盘行情，今日无法完成收益和走势判断。`);
  } else {
    const direction = (position.dailyReturn ?? 0) >= 0 ? '上涨' : '下跌';
    const pct = position.dailyReturn == null ? '未知' : `${Math.abs(position.dailyReturn * 100).toFixed(2)}%`;
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
  const published = predictions.filter((prediction) => prediction.publicationStatus === 'PUBLISHED');
  if (published.length) {
    pieces.push(`有 ${published.length} 个期限通过综合可靠度发布门槛。`);
  } else {
    pieces.push('当前没有通过综合可靠度门槛的正式预测。');
  }
  pieces.push('本复盘仅陈述已入库数据；尚未接入的新闻、财报和资金行为不会被推测补全。');
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

export async function generateDailyReviews(db, reviewDate) {
  const portfolio = calculatePortfolio(db);
  const stockReviews = [];

  for (const position of portfolio.positions) {
    const structured = {
      reviewDate,
      type: 'STOCK',
      position,
      market: volumeContext(db, position.ticker),
      predictions: latestPredictions(db, position.ticker),
      limitations: [
        '公开成交数据不能确认最终交易账户身份',
        '未达到综合可靠度门槛的预测不得作为正式预测发布'
      ]
    };
    let narrative = deterministicStockNarrative(structured);
    try {
      narrative = await explainStructuredReview(structured) || narrative;
    } catch (error) {
      structured.llmError = error.message;
    }
    await saveReview(db, reviewDate, position.ticker, 'STOCK', structured, narrative, 'review-v1');
    stockReviews.push({ ticker: position.ticker, structured, narrative });
  }

  const portfolioStructured = {
    reviewDate,
    type: 'PORTFOLIO',
    totals: portfolio.totals,
    positions: portfolio.positions.map((position) => ({
      ticker: position.ticker,
      quantity: position.quantity,
      marketValue: position.marketValue,
      dailyPnl: position.dailyPnl,
      totalPnl: position.totalPnl,
      totalReturn: position.totalReturn
    }))
  };
  const portfolioNarrative = portfolio.positions.length
    ? `股票池共 ${portfolio.positions.length} 只股票，当前总市值 $${portfolio.totals.marketValue.toFixed(2)}，今日盈亏 $${portfolio.totals.dailyPnl.toFixed(2)}，累计总盈亏 $${portfolio.totals.totalPnl.toFixed(2)}。`
    : '股票池为空，请先录入测试股票和交易。';
  await saveReview(db, reviewDate, null, 'PORTFOLIO', portfolioStructured, portfolioNarrative, 'review-v1');

  return { reviewDate, stockReviews, portfolio: { structured: portfolioStructured, narrative: portfolioNarrative } };
}
