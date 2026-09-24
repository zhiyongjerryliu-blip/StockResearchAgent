import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, nowIso } from '../src/db.js';
import { config } from '../src/config.js';
import { saveQualityMomentumStrategy } from '../src/quality-momentum-strategy.js';

const universe = ['LITE','COHR','CIEN','MU','SNDK','WDC','STX','NVDA','AMD','AVGO','MRVL','TSM','GFS','UMC','ASML','AMAT','LRCX','KLAC'];
const groups = {
  光通信: ['LITE','COHR','CIEN'], 存储: ['MU','SNDK','WDC','STX'],
  芯片设计: ['NVDA','AMD','AVGO','MRVL'], 晶圆制造: ['TSM','GFS','UMC'],
  半导体设备: ['ASML','AMAT','LRCX','KLAC']
};
const names = {
  LITE:'Lumentum',COHR:'Coherent',CIEN:'Ciena',MU:'Micron Technology',SNDK:'Sandisk',
  WDC:'Western Digital',STX:'Seagate Technology',NVDA:'NVIDIA',AMD:'Advanced Micro Devices',
  AVGO:'Broadcom',MRVL:'Marvell Technology',TSM:'Taiwan Semiconductor Manufacturing',
  GFS:'GlobalFoundries',UMC:'United Microelectronics',ASML:'ASML',AMAT:'Applied Materials',
  LRCX:'Lam Research',KLAC:'KLA'
};
const groupOf = Object.fromEntries(Object.entries(groups).flatMap(([group,tickers]) => tickers.map((ticker) => [ticker,group])));
const rankingValues = [
  ['MU',.907407,.944444,.925926],['SNDK',.777778,1,.888889],['WDC',.629630,.888889,.759259],
  ['UMC',.666667,.611111,.638889],['LRCX',.5,.666667,.583333],['LITE',.185185,.833333,.509259],
  ['STX',.240741,.777778,.509259],['TSM',.851852,.166667,.509259],['NVDA',.925926,.055556,.490741],
  ['AMAT',.425926,.555556,.490741],['CIEN',.185185,.722222,.453704],['AMD',.5,.388889,.444444],
  ['MRVL',.425926,.444444,.435185],['KLAC',.5,.333333,.416667],['AVGO',.648148,.111111,.379630],
  ['ASML',.444444,.277778,.361111],['COHR',.203704,.5,.351852],['GFS',.481481,.222222,.351852]
];
const selectedTickers = new Set(['MU','SNDK','UMC','LRCX','LITE']);
const rankings = rankingValues.map(([ticker,qualityRank,momentumRank,combined]) => ({
  ticker, group:groupOf[ticker], qualityRank, momentumRank, combined, selected:selectedTickers.has(ticker)
}));
const augustRankingValues = [
  ['SNDK',.870370,1,.935185],['MU',.888889,.944444,.916667],['WDC',.703704,.888889,.796296],
  ['UMC',.648148,.611111,.629630],['LITE',.277778,.833333,.555556],['AMAT',.407407,.666667,.537037],
  ['STX',.296296,.777778,.537037],['TSM',.833333,.222222,.527778],['AMD',.5,.5,.5],
  ['LRCX',.407407,.555556,.481481],['NVDA',.870370,.055556,.462963],['CIEN',.148148,.722222,.435185],
  ['MRVL',.407407,.388889,.398148],['ASML',.444444,.333333,.388889],['KLAC',.462963,.277778,.370370],
  ['AVGO',.611111,.111111,.361111],['COHR',.240741,.444444,.342593],['GFS',.481481,.166667,.324074]
];
const augustSelectedTickers = new Set(['SNDK','MU','UMC','LITE','AMAT']);
const augustRankings = augustRankingValues.map(([ticker,qualityRank,momentumRank,combined]) => ({
  ticker, group:groupOf[ticker], qualityRank, momentumRank, combined, selected:augustSelectedTickers.has(ticker)
}));

const reportRoot = path.join(config.projectRoot,'dayk_strategy','reports','industry18');
const snapshot = JSON.parse(fs.readFileSync(path.join(reportRoot,'enriched_snapshot.json'),'utf8'));
const ciks = Object.fromEntries(universe.map((ticker) => {
  const raw=JSON.parse(fs.readFileSync(path.join(reportRoot,'raw',`${ticker}_sec.json`),'utf8'));
  return [ticker,String(raw.company.cik)];
}));
const closeByTicker = Object.fromEntries(snapshot.prices
  .filter((row) => selectedTickers.has(row.ticker) && row.trade_date==='2026-08-03')
  .map((row) => [row.ticker,row.close]));
if (Object.keys(closeByTicker).length !== 5) throw new Error('8月3日收盘价不完整');
const selected = rankings.filter((row) => row.selected).map((row) => ({
  ticker:row.ticker, group:row.group, targetWeight:.2, targetValue:200000,
  entryPrice:closeByTicker[row.ticker], quantity:200000/closeByTicker[row.ticker]
}));
const septemberCloseByTicker = Object.fromEntries(snapshot.prices
  .filter((row) => new Set([...selectedTickers,...augustSelectedTickers]).has(row.ticker) && row.trade_date==='2026-09-01')
  .map((row) => [row.ticker,row.close]));
if (Object.keys(septemberCloseByTicker).length !== 6) throw new Error('9月1日调仓收盘价不完整');
const augustNav = selected.reduce((sum,item) => sum + item.quantity * septemberCloseByTicker[item.ticker],0);
const augustTargetValue = augustNav / augustSelectedTickers.size;
const augustSelected = augustRankings.filter((row) => row.selected).map((row) => ({
  ticker:row.ticker, group:row.group, targetWeight:.2, targetValue:augustTargetValue,
  entryPrice:septemberCloseByTicker[row.ticker], quantity:augustTargetValue/septemberCloseByTicker[row.ticker]
}));

const db = openDatabase();
const backup = path.join(config.projectRoot,'data','backups','research-before-quality-momentum-2026-09-24.sqlite');
if (!fs.existsSync(backup)) {
  const escaped=backup.replaceAll("'","''");
  db.exec(`VACUUM INTO '${escaped}'`);
}
const timestamp=nowIso();
db.exec('BEGIN IMMEDIATE');
try {
  db.exec(`
    DELETE FROM transactions;
    DELETE FROM transaction_import_batches;
    DELETE FROM daily_position_snapshots;
    DELETE FROM portfolio_risk_snapshots;
    DELETE FROM daily_reviews;
    DELETE FROM quality_momentum_score_records;
    DELETE FROM quality_momentum_rebalances;
    DELETE FROM quality_momentum_signals;
    DELETE FROM quality_momentum_strategies;
    DELETE FROM watchlist_items;
  `);
  const security=db.prepare(`INSERT INTO securities (
    ticker,name,sector,industry,benchmark,industry_etf,currency,created_at,updated_at
  ) VALUES (?,?,?,?,?,'SOXX','USD',?,?) ON CONFLICT(ticker) DO UPDATE SET
    name=excluded.name,sector=excluded.sector,industry=excluded.industry,benchmark=excluded.benchmark,
    industry_etf=excluded.industry_etf,updated_at=excluded.updated_at`);
  const watch=db.prepare(`INSERT INTO watchlist_items (
    ticker,enabled,note,risk_tags,continue_after_exit,created_at,updated_at
  ) VALUES (?,1,?,'[]',1,?,?)`);
  for (const ticker of universe) {
    security.run(ticker,names[ticker],'信息技术',groupOf[ticker],'SPY',timestamp,timestamp);
    watch.run(ticker,`质量—动量股票池 · ${groupOf[ticker]}`,timestamp,timestamp);
  }
  const price=db.prepare(`INSERT INTO prices_daily (
    ticker,trade_date,open,high,low,close,adjusted_close,volume,provider,available_at,ingested_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ticker,trade_date,provider) DO UPDATE SET
    open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
    adjusted_close=excluded.adjusted_close,volume=excluded.volume,available_at=excluded.available_at`);
  for (const row of snapshot.prices) if (universe.includes(row.ticker)) price.run(
    row.ticker,row.trade_date,row.open,row.high,row.low,row.close,row.adjusted_close,row.volume,
    row.provider,row.available_at,row.ingested_at || timestamp
  );
  const fact=db.prepare(`INSERT OR REPLACE INTO financial_facts (
    source_key,ticker,cik,metric_key,tag_priority,taxonomy,tag,label,description,unit,
    period_start,period_end,period_type,fiscal_year,fiscal_period,form,filed_at,
    accession_number,frame,value,source_url,ingested_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of snapshot.facts) if (universe.includes(row.ticker)) fact.run(
    row.source_key,row.ticker,ciks[row.ticker],row.metric_key,row.tag_priority ?? 0,row.taxonomy,row.tag,
    row.label ?? null,row.description ?? null,row.unit,row.period_start ?? null,row.period_end,row.period_type,
    row.fiscal_year ?? Number(row.period_end.slice(0,4)),row.fiscal_period ?? null,row.form,row.filed_at,
    row.accession_number ?? null,row.frame ?? null,row.value,row.source_url ?? null,row.ingested_at ?? timestamp
  );
  const filing=db.prepare(`INSERT OR REPLACE INTO sec_filings (
    accession_number,ticker,cik,form,filed_at,report_date,accepted_at,primary_document,
    primary_doc_description,items,filing_url,is_xbrl,is_inline_xbrl,ingested_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of snapshot.filings) if (universe.includes(row.ticker)) filing.run(
    row.accession_number,row.ticker,ciks[row.ticker],row.form,row.filed_at,row.report_date ?? null,
    row.accepted_at ?? null,row.primary_document ?? null,row.primary_doc_description ?? null,row.items ?? null,
    row.filing_url ?? row.source_url ?? 'https://www.sec.gov/',Number(Boolean(row.is_xbrl)),Number(Boolean(row.is_inline_xbrl)),row.ingested_at ?? timestamp
  );
  saveQualityMomentumStrategy(db,{
    name:'选股策略：质量—动量',capital:1000000,selectionCount:5,maxPerGroup:2,targetWeight:.2,
    rebalanceRule:'每月最后一个交易日收盘评分，下一交易日执行；本次于2026-08-03收盘价建仓，每组最多2只',
    scoring:{qualityWeight:.5,momentumWeight:.5,description:'TTM净利率、TTM经营现金流率和低负债率构成质量分；跳过最近21个交易日的12个月动量构成动量分；两者各占50%'},
    universe,groups,signalDate:'2026-07-31',tradeDate:'2026-08-03',rankings,selected,
    source:{protocol:'dayk_strategy/industry18_protocol.json',report:'dayk_strategy/reports/industry18/summary.json'}
  });
  const initialTransaction=db.prepare(`INSERT INTO transactions (
    ticker,side,trade_time,quantity,price,fee,note,created_at,updated_at
  ) VALUES (?,'BUY','2026-08-03T20:00:00.000Z',?,?,0,?,?,?)`);
  for (const item of selected) initialTransaction.run(
    item.ticker,item.quantity,item.entryPrice,'质量—动量策略初始建仓 · 目标20% · 2026-07-31信号',timestamp,timestamp
  );
  saveQualityMomentumStrategy(db,{
    name:'选股策略：质量—动量',capital:1000000,selectionCount:5,maxPerGroup:2,targetWeight:.2,
    rebalanceRule:'每月最后一个交易日收盘评分，下一交易日执行；每组最多2只；按调仓前组合净值等权配置',
    scoring:{qualityWeight:.5,momentumWeight:.5,description:'TTM净利率、TTM经营现金流率和低负债率构成质量分；跳过最近21个交易日的12个月动量构成动量分；两者各占50%'},
    universe,groups,signalDate:'2026-08-31',tradeDate:'2026-09-01',rankings:augustRankings,selected:augustSelected,
    source:{protocol:'dayk_strategy/industry18_protocol.json',report:'dayk_strategy/reports/industry18/summary.json'}
  });
  const currentQuantities = new Map(selected.map((item) => [item.ticker,item.quantity]));
  const targetQuantities = new Map(augustSelected.map((item) => [item.ticker,item.quantity]));
  const rebalanceTransaction=db.prepare(`INSERT INTO transactions (
    ticker,side,trade_time,quantity,price,fee,note,created_at,updated_at
  ) VALUES (?,?, '2026-09-01T20:00:00.000Z',?,?,0,?,?,?)`);
  const changes = [...new Set([...currentQuantities.keys(),...targetQuantities.keys()])].map((ticker) => ({
    ticker, delta:(targetQuantities.get(ticker) || 0) - (currentQuantities.get(ticker) || 0)
  }));
  for (const item of changes.filter((item) => item.delta < -1e-9)) rebalanceTransaction.run(
    item.ticker,'SELL',-item.delta,septemberCloseByTicker[item.ticker],
    '质量—动量月度调仓 · 2026-08-31信号',timestamp,timestamp
  );
  for (const item of changes.filter((item) => item.delta > 1e-9)) rebalanceTransaction.run(
    item.ticker,'BUY',item.delta,septemberCloseByTicker[item.ticker],
    '质量—动量月度调仓 · 2026-08-31信号',timestamp,timestamp
  );
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
const counts=Object.fromEntries(['watchlist_items','transactions','daily_position_snapshots','portfolio_risk_snapshots']
  .map((table) => [table,Number(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count)]));
console.log(JSON.stringify({backup,initialSelected:selected,augustNav,augustSelected,counts},null,2));
db.close();
