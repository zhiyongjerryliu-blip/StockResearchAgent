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
const reportRoot = path.join(config.projectRoot,'dayk_strategy','reports','industry18');
const snapshot = JSON.parse(fs.readFileSync(path.join(reportRoot,'enriched_snapshot.json'),'utf8'));
const simulation = JSON.parse(fs.readFileSync(
  path.join(config.projectRoot,'dayk_strategy','quality_momentum_simulation_signals.json'),'utf8'
));
const ciks = Object.fromEntries(universe.map((ticker) => {
  const raw=JSON.parse(fs.readFileSync(path.join(reportRoot,'raw',`${ticker}_sec.json`),'utf8'));
  return [ticker,String(raw.company.cik)];
}));
function closesOn(tradeDate) {
  const closes = Object.fromEntries(snapshot.prices
    .filter((row) => row.trade_date === tradeDate && universe.includes(row.ticker))
    .map((row) => [row.ticker,row.close]));
  if (Object.keys(closes).length !== universe.length) throw new Error(`${tradeDate}收盘价不完整`);
  return closes;
}
function targetSelection(rankings, tradeDate, portfolioValue) {
  const closes = closesOn(tradeDate);
  const targetValue = portfolioValue / 5;
  return rankings.filter((row) => row.selected).map((row) => ({
    ticker:row.ticker, group:row.group, targetWeight:.2, targetValue,
    entryPrice:closes[row.ticker], quantity:targetValue/closes[row.ticker]
  }));
}
function rebalanceSelection(previous, rankings, tradeDate) {
  const closes = closesOn(tradeDate);
  const portfolioValue = previous.reduce((sum,item) => sum + item.quantity * closes[item.ticker],0);
  return { portfolioValue, selected:targetSelection(rankings,tradeDate,portfolioValue) };
}
const cycles = simulation.signals.map((signal) => ({
  ...signal,
  rankings:signal.rankings.map((row) => ({ ...row,group:groupOf[row.ticker] }))
}));
if (cycles[0]?.tradeDate !== '2026-01-02') throw new Error('模拟起始日必须为2026-01-02');
if (cycles.some((cycle) => cycle.rankings.filter((row) => row.selected).length !== 5)) {
  throw new Error('每期必须恰好选中5只股票');
}
if (cycles.some((cycle) => Object.values(Object.groupBy(
  cycle.rankings.filter((row) => row.selected),row => row.group
)).some((rows) => rows.length > 2))) throw new Error('选股结果违反每组最多2只限制');
cycles[0].portfolioValue=1000000;
cycles[0].selected=targetSelection(cycles[0].rankings,cycles[0].tradeDate,cycles[0].portfolioValue);
for (let index=1;index<cycles.length;index+=1) {
  Object.assign(cycles[index],rebalanceSelection(cycles[index-1].selected,cycles[index].rankings,cycles[index].tradeDate));
}

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
  const transaction=db.prepare(`INSERT INTO transactions (
    ticker,side,trade_time,quantity,price,fee,note,created_at,updated_at
  ) VALUES (?,?,?,?,?,0,?,?,?)`);
  let previousSelected=[];
  for (const [index,cycle] of cycles.entries()) {
    saveQualityMomentumStrategy(db,{
      name:'选股策略：质量—动量',capital:1000000,selectionCount:5,maxPerGroup:2,targetWeight:.2,
      rebalanceRule:'每月最后一个交易日收盘评分，下一交易日执行；2026-01-02首次建仓；每组最多2只；按调仓前组合净值等权配置',
      scoring:{qualityWeight:.5,momentumWeight:.5,description:'TTM净利率、TTM经营现金流率和低负债率构成质量分；跳过最近21个交易日的12个月动量构成动量分；两者各占50%'},
      universe,groups,signalDate:cycle.signalDate,tradeDate:cycle.tradeDate,
      rankings:cycle.rankings,selected:cycle.selected,
      source:{protocol:'dayk_strategy/industry18_protocol.json',report:'dayk_strategy/reports/industry18/summary.json',signals:'dayk_strategy/quality_momentum_simulation_signals.json'}
    });
    const currentQuantities=new Map(previousSelected.map((item) => [item.ticker,item.quantity]));
    const targetQuantities=new Map(cycle.selected.map((item) => [item.ticker,item.quantity]));
    const closes=closesOn(cycle.tradeDate);
    const changes=[...new Set([...currentQuantities.keys(),...targetQuantities.keys()])].map((ticker) => ({
      ticker,delta:(targetQuantities.get(ticker) || 0) - (currentQuantities.get(ticker) || 0)
    }));
    const note=index===0
      ? `质量—动量策略初始建仓 · 目标20% · ${cycle.signalDate}信号`
      : `质量—动量月度调仓 · ${cycle.signalDate}信号`;
    for (const item of changes.filter((item) => item.delta < -1e-9)) transaction.run(
      item.ticker,'SELL',`${cycle.tradeDate}T20:00:00.000Z`,-item.delta,closes[item.ticker],note,timestamp,timestamp
    );
    for (const item of changes.filter((item) => item.delta > 1e-9)) transaction.run(
      item.ticker,'BUY',`${cycle.tradeDate}T20:00:00.000Z`,item.delta,closes[item.ticker],note,timestamp,timestamp
    );
    previousSelected=cycle.selected;
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
const counts=Object.fromEntries(['watchlist_items','transactions','daily_position_snapshots','portfolio_risk_snapshots']
  .map((table) => [table,Number(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count)]));
console.log(JSON.stringify({backup,cycles,counts},null,2));
db.close();
