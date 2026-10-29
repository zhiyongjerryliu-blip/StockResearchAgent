import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { nowIso, toPlainRows } from './db.js';
import { nextRegularUsTradingDate, previousRegularUsTradingDate } from './trading-calendar.js';
import { syncFactorFx, syncForeignFactorFacts } from './factor-inputs.js';

export const FACTOR_VARIANTS = [
  { key:'QM', strategyKey:'industry18-quality-momentum-reference',name:'质量＋动量（对照）',weights:[.5,.5,0] },
  { key:'QV', strategyKey:'industry18-quality-value',name:'质量＋价值',weights:[.5,0,.5] },
  { key:'QVM_equal', strategyKey:'industry18-quality-value-momentum',name:'三因子等权',weights:[1/3,1/3,1/3] }
];
const parse=(value,fallback)=>value?JSON.parse(value):fallback;
const monthEnd=date=>nextRegularUsTradingDate(date).slice(0,7)!==date.slice(0,7);

export function configureFactorObservations(db, {capital,universe,groups,observationStart}) {
  if (!(capital>0) || !/^\d{4}-\d{2}-\d{2}$/.test(observationStart)) throw new Error('观察策略资金或起始日无效');
  const timestamp=nowIso();
  for (const variant of FACTOR_VARIANTS) {
    const cfg={universe,groups,selectionCount:5,maxPerGroup:2,targetWeight:.2,weights:variant.weights,
      execution:'next-session-close',feesBps:0,slippageBps:0,dividendsIncluded:false,
      description:variant.key==='QV'?'质量与价值各50%；价值为子行业内盈利收益率与经营现金流收益率排名均值。'
        :variant.key==='QM'?'质量与动量各50%；历史对照沿用原策略已保存的选股。'
        :'质量、动量、价值各占三分之一；价值采用子行业内排名。'};
    db.prepare(`INSERT INTO factor_observation_strategies(strategy_key,name,capital,observation_start,config_json,created_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(strategy_key) DO NOTHING`).run(variant.strategyKey,variant.name,capital,observationStart,JSON.stringify(cfg),timestamp);
    db.prepare(`INSERT INTO factor_observation_accounts(strategy_key,cash,updated_at) VALUES(?,?,?)
      ON CONFLICT(strategy_key) DO NOTHING`).run(variant.strategyKey,capital,timestamp);
  }
}

export function computeFactorSignals(databasePath, dates) {
  const python=process.env.QUALITY_MOMENTUM_PYTHON || path.join(config.projectRoot,'dayk_strategy/.venv/bin/python');
  const result=spawnSync(python,[path.join(config.projectRoot,'dayk_strategy/compute_factor_signals.py'),databasePath,dates.join(',')],
    {cwd:config.projectRoot,encoding:'utf8',timeout:120_000,maxBuffer:20*1024*1024});
  if (result.error || result.status!==0) throw new Error(result.error?.message || String(result.stderr).trim() || '观察策略评分失败');
  return JSON.parse(result.stdout);
}

function configured(db) {
  return toPlainRows(db.prepare('SELECT * FROM factor_observation_strategies WHERE enabled=1 ORDER BY strategy_key').all());
}

function reason(rankings,index,cfg) {
  const row=rankings[index];
  if (row.selected) return `综合排名第${index+1}，在每组最多${cfg.maxPerGroup}只限制下入选。`;
  const same=rankings.slice(0,index).filter(x=>x.selected && x.group===row.group).length;
  return same>=cfg.maxPerGroup?'组内已有更高分股票入选，触发每组最多2只限制。':'综合排名未进入前5个有效席位。';
}

export function saveFactorSignals(db, signalDate, result) {
  const tradeDate=nextRegularUsTradingDate(signalDate);
  if (!monthEnd(signalDate)) throw new Error('观察策略只接受月末信号');
  const rows=configured(db);
  if (rows.length!==3) throw new Error('三个观察账户尚未完整配置');
  const prepared=rows.map(row=>{
    const variant=FACTOR_VARIANTS.find(x=>x.strategyKey===row.strategy_key);const cfg=parse(row.config_json,{});
    const rankings=result.rankings?.[variant.key];
    if (!rankings?.length || new Set(rankings.map(x=>x.ticker)).size!==rankings.length) throw new Error(`${row.name}评分缺失或重复`);
    const selected=rankings.filter(x=>x.selected);const counts={};
    for (const item of rankings) {
      if (!cfg.universe.includes(item.ticker) || !Number.isFinite(item.combined) ||
          !Object.entries(cfg.groups).some(([group,ts])=>group===item.group && ts.includes(item.ticker))) throw new Error(`${row.name}评分无效`);
      if (item.selected) counts[item.group]=(counts[item.group]||0)+1;
    }
    if (selected.length!==5 || Object.values(counts).some(x=>x>2)) throw new Error(`${row.name}不满足5只、每组最多2只规则`);
    return {row,rankings:rankings.map((x,i)=>({...x,rank:i+1,selectionReason:reason(rankings,i,cfg)}))};
  });
  const timestamp=nowIso();
  const digest=createHash('sha256').update(JSON.stringify(result)).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const {row,rankings} of prepared) db.prepare(`INSERT INTO factor_observation_signals(
      strategy_key,signal_date,trade_date,status,mode,rankings_json,source_json,created_at)
      VALUES(?,?,?,'PENDING',?,?,?,?) ON CONFLICT(strategy_key,signal_date) DO NOTHING`)
      .run(row.strategy_key,signalDate,tradeDate,signalDate<row.observation_start?'HISTORICAL':'FORWARD',JSON.stringify(rankings),
        JSON.stringify({...result.source,inputDigest:digest}),timestamp);
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}

function actions(db,ticker) {
  const cache=db.prepare('SELECT payload_json FROM factor_input_cache WHERE input_key=?').get(`chart:${ticker}`);
  const chart=parse(cache?.payload_json,{}).chart?.result?.[0];
  if (!chart) throw new Error(`${ticker}缺少公司行动元数据`);
  return Object.values(chart.events?.splits || {}).map(x=>{
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(x.date*1000));
    return {date,ratio:Number(x.numerator)/Number(x.denominator),genuine:!(ticker==='WDC' && date==='2025-02-24')};
  });
}

export function observationClose(db,ticker,date) {
  const row=db.prepare(`SELECT close,provider FROM prices_daily WHERE ticker=? AND trade_date=?
    ORDER BY CASE WHEN provider='manual' THEN 0 WHEN provider='yahoo' THEN 1 ELSE 2 END,ingested_at DESC LIMIT 1`).get(ticker,date);
  if (!(Number(row?.close)>0)) return null;
  // Yahoo closes are split adjusted. Restore each day's actual share unit;
  // manual quotes are already nominal. Split events change held units below.
  const factor=row.provider==='yahoo'?actions(db,ticker).filter(x=>x.date>date).reduce((p,x)=>p*x.ratio,1):1;
  return Number(row.close)*factor;
}

function prepareDay(db,row,day) {
  const account=db.prepare('SELECT * FROM factor_observation_accounts WHERE strategy_key=?').get(row.strategy_key);
  const positions=parse(account.positions_json,{});let cash=account.cash;
  const pending=db.prepare(`SELECT * FROM factor_observation_signals WHERE strategy_key=? AND status='PENDING'
    AND trade_date<=? ORDER BY signal_date LIMIT 1`).get(row.strategy_key,day);
  if (pending && pending.trade_date!==day) return {missing:[`缺少${pending.trade_date}调仓日数据`]};
  for (const [ticker,position] of Object.entries(positions)) {
    for (const split of actions(db,ticker).filter(x=>x.genuine && x.date>(account.last_date || '') && x.date<=day)) {
      position.quantity*=split.ratio;position.averageCost/=split.ratio;
    }
  }
  const rankings=parse(pending?.rankings_json,[]);const selected=rankings.filter(x=>x.selected);
  const tickers=[...new Set([...Object.keys(positions),...selected.map(x=>x.ticker)])];
  const prices=Object.fromEntries(tickers.map(t=>[t,observationClose(db,t,day)]));
  const missing=tickers.filter(t=>!(prices[t]>0));if (missing.length) return {missing};
  let equity=cash+Object.entries(positions).reduce((s,[t,p])=>s+p.quantity*prices[t],0);
  let target=[];let rebalance=[];
  if (pending) {
    const previous=structuredClone(positions);const cfg=parse(row.config_json,{});
    target=selected.map(item=>({ticker:item.ticker,group:item.group,combined:item.combined,targetWeight:cfg.targetWeight,
      targetValue:equity*cfg.targetWeight,entryPrice:prices[item.ticker],quantity:equity*cfg.targetWeight/prices[item.ticker]}));
    const desired=Object.fromEntries(target.map(x=>[x.ticker,x]));
    for (const ticker of tickers.sort()) {
      const old=previous[ticker];const next=desired[ticker];const delta=(next?.quantity||0)-(old?.quantity||0);
      const action=!next?'SELL':!old?'BUY':delta>1e-6?'INCREASE':delta<-1e-6?'REDUCE':'HOLD';
      const averageCost=next?(delta>0?((old?.quantity||0)*(old?.averageCost||0)+delta*prices[ticker])/next.quantity:old?.averageCost||prices[ticker]):0;
      if (next) positions[ticker]={quantity:next.quantity,averageCost,group:next.group};else delete positions[ticker];
      cash-=delta*prices[ticker];
      rebalance.push({ticker,action,previousQuantity:old?.quantity||0,targetQuantity:next?.quantity||0,deltaQuantity:delta,
        executionPrice:prices[ticker],cashAmount:Math.abs(delta*prices[ticker]),targetWeight:next?.targetWeight||0,
        reason:action==='SELL'?'本期未入选，模拟退出。':action==='BUY'?'本期新入选，模拟建仓。':'调至20%目标权重。'});
    }
    if (cash<-1e-5) throw new Error('观察账户现金不足');cash=Math.max(0,cash);
  }
  const marked=cash+Object.entries(positions).reduce((s,[t,p])=>s+p.quantity*prices[t],0);
  if (Math.abs(marked-equity)>1e-5) throw new Error('观察账户自融资核对失败');
  return {cash,positions,equity:marked,pending,target,rebalance};
}

export function advanceFactorAccounts(db,throughDate) {
  const rows=configured(db);if (!rows.length) return {skipped:true,reason:'observation-not-configured'};
  const starts=rows.map(row=>db.prepare('SELECT last_date FROM factor_observation_accounts WHERE strategy_key=?').get(row.strategy_key)?.last_date
    || db.prepare('SELECT MIN(trade_date) d FROM factor_observation_signals WHERE strategy_key=?').get(row.strategy_key)?.d);
  if (starts.some(x=>!x)) return {skipped:true,reason:'no-observation-signals'};
  const calendar=toPlainRows(db.prepare(`SELECT DISTINCT trade_date FROM prices_daily
    WHERE ticker='SPY' AND trade_date>=? AND trade_date<=? ORDER BY trade_date`).all(starts.sort()[0],throughDate));
  let days=0;
  for (const {trade_date:day} of calendar) {
    const prepared=[];
    for (const row of rows) {
      const last=db.prepare('SELECT last_date FROM factor_observation_accounts WHERE strategy_key=?').get(row.strategy_key).last_date;
      if (last && last>=day) continue;
      if (last && nextRegularUsTradingDate(last)!==day) return {status:'DEGRADED',days,missing:[`SPY缺少${nextRegularUsTradingDate(last)}交易日`],asOf:last};
      const result=prepareDay(db,row,day);
      if (result.missing) return {status:'DEGRADED',days,missing:result.missing,date:day};
      prepared.push({row,...result});
    }
    if (!prepared.length) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      const timestamp=nowIso();
      for (const item of prepared) {
        db.prepare(`UPDATE factor_observation_accounts SET cash=?,positions_json=?,last_date=?,updated_at=? WHERE strategy_key=?`)
          .run(item.cash,JSON.stringify(item.positions),day,timestamp,item.row.strategy_key);
        db.prepare(`INSERT INTO factor_observation_daily(strategy_key,trade_date,equity,cash,holdings_json) VALUES(?,?,?,?,?)`)
          .run(item.row.strategy_key,day,item.equity,item.cash,JSON.stringify(item.positions));
        if (item.pending) db.prepare(`UPDATE factor_observation_signals SET status='EXECUTED',selected_json=?,rebalance_json=?
          WHERE strategy_key=? AND signal_date=? AND status='PENDING'`).run(JSON.stringify(item.target),JSON.stringify(item.rebalance),item.row.strategy_key,item.pending.signal_date);
      }
      db.exec('COMMIT');days++;
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  return {status:'SUCCESS',days,asOf:configured(db).map(row=>db.prepare('SELECT last_date FROM factor_observation_accounts WHERE strategy_key=?').get(row.strategy_key).last_date).sort()[0]};
}

export async function runFactorObservationAutomation(db,analysisDate,options={}) {
  if (!configured(db).length) return {skipped:true,reason:'observation-not-configured'};
  const previous=previousRegularUsTradingDate(analysisDate);
  const signalDate=monthEnd(analysisDate)?analysisDate:monthEnd(previous)?previous:null;
  const first=db.prepare('SELECT MIN(signal_date) d FROM factor_observation_signals').get().d;
  const candidates=new Set(signalDate?[signalDate]:[]);
  if (first) {
    for (const row of db.prepare('SELECT DISTINCT signal_date FROM quality_momentum_signals WHERE signal_date>=? AND signal_date<=?').all(first,analysisDate)) candidates.add(row.signal_date);
    for (const row of db.prepare("SELECT DISTINCT trade_date FROM prices_daily WHERE ticker='SPY' AND trade_date>=? AND trade_date<=?").all(first,analysisDate)) {
      if (monthEnd(row.trade_date)) candidates.add(row.trade_date);
    }
  }
  const needed=[...candidates].filter(d=>Number(db.prepare('SELECT COUNT(*) n FROM factor_observation_signals WHERE signal_date=?').get(d).n)!==3).sort();
  if (needed.length) {
      if (options.syncInputs!==false) {
        await syncFactorFx(db,options.provider);
        await syncForeignFactorFacts(db,options.secProvider,needed.at(-1));
      }
      const signals=(options.computeSignals || computeFactorSignals)(options.databasePath || config.databasePath,needed);
      for (const date of needed) saveFactorSignals(db,date,signals[date]);
  }
  return advanceFactorAccounts(db,analysisDate);
}

function performance(daily,capital) {
  if (!daily.length) return {totalReturn:null,maxDrawdown:null};
  let peak=capital;let dd=0;
  for (const d of daily) {peak=Math.max(peak,d.equity);dd=Math.min(dd,d.equity/peak-1);}
  return {totalReturn:daily.at(-1).equity/capital-1,maxDrawdown:dd};
}

export function getFactorObservations(db) {
  const rows=configured(db);
  if (!rows.length) return {strategies:[],comparison:[],observationStart:null};
  const lastDates=rows.map(row=>db.prepare('SELECT last_date FROM factor_observation_accounts WHERE strategy_key=?').get(row.strategy_key)?.last_date);
  const asOf=lastDates.every(Boolean)?lastDates.sort()[0]:null;
  const strategies=rows.map(row=>{
    const cfg=parse(row.config_json,{});const account=db.prepare('SELECT * FROM factor_observation_accounts WHERE strategy_key=?').get(row.strategy_key);
    const daily=toPlainRows(db.prepare('SELECT * FROM factor_observation_daily WHERE strategy_key=? AND trade_date<=? ORDER BY trade_date').all(row.strategy_key,asOf||''));
    const signals=toPlainRows(db.prepare('SELECT * FROM factor_observation_signals WHERE strategy_key=? ORDER BY signal_date DESC').all(row.strategy_key)).map(s=>{
      const rebalance=parse(s.rebalance_json,[]);const buyCash=rebalance.filter(x=>['BUY','INCREASE'].includes(x.action)).reduce((v,x)=>v+x.cashAmount,0);
      const sellCash=rebalance.filter(x=>['SELL','REDUCE'].includes(x.action)).reduce((v,x)=>v+x.cashAmount,0);
      return {signalDate:s.signal_date,tradeDate:s.trade_date,status:s.status,mode:s.mode,rankings:parse(s.rankings_json,[]),
        selected:parse(s.selected_json,[]),source:parse(s.source_json,{}),rebalance,
        rebalanceSummary:{buyCash,sellCash,netCash:sellCash-buyCash,buyCount:rebalance.filter(x=>['BUY','INCREASE'].includes(x.action)).length,
          sellCount:rebalance.filter(x=>['SELL','REDUCE'].includes(x.action)).length,holdCount:rebalance.filter(x=>x.action==='HOLD').length}};
    });
    const signal=signals.find(s=>s.status==='EXECUTED') || signals[0] || null;
    const commonHoldings=parse(daily.at(-1)?.holdings_json,{});
    const positions=Object.entries(commonHoldings).map(([ticker,p])=>{
      const target=signal?.selected.find(x=>x.ticker===ticker) || {};const currentPrice=observationClose(db,ticker,asOf);
      return {...target,ticker,...p,currentPrice,priceDate:asOf,marketValue:p.quantity*currentPrice,
        totalPnl:p.quantity*(currentPrice-p.averageCost),totalReturn:currentPrice/p.averageCost-1};
    });
    const base=daily.filter(d=>d.trade_date<row.observation_start).at(-1);const forward=daily.filter(d=>d.trade_date>=row.observation_start);
    const forwardCapital=base?.equity || row.capital;const forwardMetrics=performance(forward,forwardCapital);
    const yearlyMonths=new Map();let previousEquity=row.capital;
    for (const d of daily) {
      const month=d.trade_date.slice(0,7);let item=yearlyMonths.get(month);
      if (!item) {item={month,firstDate:d.trade_date,startEquity:previousEquity};yearlyMonths.set(month,item);}
      item.lastDate=d.trade_date;item.equity=d.equity;previousEquity=d.equity;
    }
    const months=[...yearlyMonths.values()].map(m=>({...m,totalPnl:m.equity-m.startEquity,positions:[],incompleteDays:0,monthlyReturn:m.equity/m.startEquity-1,cumulativeReturn:m.equity/row.capital-1}));
    const equity=daily.at(-1)?.equity ?? row.capital;
    const benchmarkReturn=date=>{
      const ratios=cfg.universe.map(t=>{
        const initial=db.prepare("SELECT close FROM prices_daily WHERE ticker=? AND trade_date=? AND provider='yahoo'").get(t,daily[0]?.trade_date)?.close;
        const end=db.prepare("SELECT close FROM prices_daily WHERE ticker=? AND trade_date=? AND provider='yahoo'").get(t,date)?.close;
        return initial>0 && end>0?end/initial-1:null;
      });
      return ratios.some(x=>x==null)?null:ratios.reduce((s,x)=>s+x,0)/ratios.length;
    };
    let previousBenchmark=0;
    const returns=months.map(m=>{
      const b=benchmarkReturn(m.lastDate);const monthly=b==null || previousBenchmark==null?null:(1+b)/(1+previousBenchmark)-1;previousBenchmark=b;
      return {month:m.month,date:m.lastDate,strategyMonthlyReturn:m.monthlyReturn,benchmarkMonthlyReturn:monthly,
        strategyCumulativeReturn:m.cumulativeReturn,benchmarkCumulativeReturn:b};
    });
    const returnComparison={startDate:daily[0]?.trade_date || null,benchmarkName:`股票池${cfg.universe.length}只等金额买入持有`,returns,
      benchmarkReturn:returns.at(-1)?.benchmarkCumulativeReturn??null};
    return {strategyKey:row.strategy_key,name:row.name,enabled:Boolean(row.enabled),observation:true,reference:row.strategy_key===FACTOR_VARIANTS[0].strategyKey,
      capital:row.capital,selectionCount:cfg.selectionCount,maxPerGroup:cfg.maxPerGroup,targetWeight:cfg.targetWeight,universe:cfg.universe,groups:cfg.groups,
      scoring:{description:cfg.description,qualityWeight:cfg.weights[0],momentumWeight:cfg.weights[1],valueWeight:cfg.weights[2]},
      rebalanceRule:'月末收盘评分，下一交易日收盘模拟调仓；选5只，各20%，每组最多2只',
      signal,signals,positions,returnComparison,totals:{investedCapital:row.capital,marketValue:equity,totalPnl:equity-row.capital,totalReturn:equity/row.capital-1},
      historical:{...performance(daily,row.capital),startDate:daily[0]?.trade_date || null},
      forward:{...forwardMetrics,startDate:row.observation_start,baselineDate:base?.trade_date || null,baselineEquity:forwardCapital},
      asOf,updatedAt:account.updated_at,performance:{months,tickers:[],priceDate:asOf,returnComparison},
      curve:daily.map(d=>({date:d.trade_date,equity:d.equity,historicalReturn:d.equity/row.capital-1,
        forwardReturn:d.trade_date>=row.observation_start?d.equity/forwardCapital-1:null}))};
  });
  const order=new Map(FACTOR_VARIANTS.map((v,i)=>[v.strategyKey,i]));strategies.sort((a,b)=>order.get(a.strategyKey)-order.get(b.strategyKey));
  const reference=new Set(strategies[0].positions.map(x=>x.ticker));
  return {strategies,asOf,observationStart:rows[0].observation_start,
    costNote:'与现有模拟策略一致：下一交易日收盘成交，未计手续费、滑点、分红和税费。',
    comparison:strategies.map(s=>({strategyKey:s.strategyKey,name:s.name,historical:s.historical,forward:s.forward,
      selected:s.positions.map(x=>x.ticker),overlap:s.positions.filter(x=>reference.has(x.ticker)).length/5}))};
}
