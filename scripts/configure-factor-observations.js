import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { saveFactorChart, saveFactorInput } from '../src/factor-inputs.js';
import { configureFactorObservations, computeFactorSignals, saveFactorSignals, advanceFactorAccounts, getFactorObservations } from '../src/factor-observation.js';
import { latestStableUsMarketDate } from '../src/trading-calendar.js';

const databasePath=path.resolve(process.argv[2] || config.databasePath);
const observationStart=process.argv[3] || new Intl.DateTimeFormat('en-CA',{timeZone:config.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const backup=path.join(path.dirname(databasePath),'backups',`research-before-factor-observations-${observationStart}.sqlite`);
fs.mkdirSync(path.dirname(backup),{recursive:true});
const originalDb=new DatabaseSync(databasePath);
if (!fs.existsSync(backup)) originalDb.prepare('VACUUM INTO ?').run(backup);
originalDb.close();
const db=openDatabase(databasePath);
const digest=table=>createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())).digest('hex');
const protectedTables=['transactions','quality_momentum_strategies','quality_momentum_signals'];
const before=Object.fromEntries(protectedTables.map(t=>[t,digest(t)]));
try {
  const base=db.prepare("SELECT * FROM quality_momentum_strategies WHERE strategy_key='industry18-quality-momentum'").get();
  if (!base || base.selection_count!==5 || base.max_per_group!==2) throw new Error('现有18股质量动量策略未配置或规则不一致');
  const universe=JSON.parse(base.universe_json);
  const folder=path.join(config.projectRoot,'dayk_strategy/reports');
  const inputMissing=key=>!db.prepare('SELECT 1 FROM factor_input_cache WHERE input_key=?').get(key);
  for (const ticker of universe) {
    if (inputMissing(`sec:${ticker}`)) saveFactorInput(db,`sec:${ticker}`,JSON.parse(fs.readFileSync(path.join(folder,'industry18/raw',`${ticker}_sec.json`),'utf8')));
  }
  for (const ticker of [...universe,'TWD=X','EURUSD=X']) {
    if (inputMissing(`chart:${ticker}`)) saveFactorChart(db,ticker,JSON.parse(fs.readFileSync(path.join(folder,'three_factor/inputs',`${ticker}_chart.json`),'utf8')));
  }
  configureFactorObservations(db,{capital:Number(base.capital),universe,groups:JSON.parse(base.groups_json),observationStart});
  const latest=db.prepare("SELECT MAX(trade_date) d FROM prices_daily WHERE ticker='SPY' AND provider='yahoo' AND trade_date<=?").get(latestStableUsMarketDate()).d;
  const dates=db.prepare('SELECT signal_date FROM quality_momentum_signals WHERE strategy_key=? AND signal_date<=? ORDER BY signal_date').all(base.strategy_key,latest)
    .map(r=>r.signal_date).filter(d=>Number(db.prepare('SELECT COUNT(*) n FROM factor_observation_signals WHERE signal_date=?').get(d).n)!==3);
  if (dates.length) {
    const result=computeFactorSignals(databasePath,dates);
    for (const date of dates) saveFactorSignals(db,date,result[date]);
  }
  const advanced=advanceFactorAccounts(db,latest);
  if (advanced.status!=='SUCCESS') throw new Error('观察账户未完全更新：'+JSON.stringify(advanced));
  for (const table of protectedTables) assert.equal(digest(table),before[table],`${table}发生了不应有的变化`);
  const result=getFactorObservations(db);
  console.log(JSON.stringify({backup,observationStart:result.observationStart,asOf:result.asOf,
    protectedTablesUnchanged:true,comparison:result.comparison,signalCounts:result.strategies.map(s=>({name:s.name,signals:s.signals.length}))},null,2));
} finally {db.close();}
