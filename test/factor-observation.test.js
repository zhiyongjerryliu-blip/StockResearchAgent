import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { upsertWatchlistItem,saveManualPrice } from '../src/repository.js';
import { configureFactorObservations, saveFactorSignals, advanceFactorAccounts, getFactorObservations,
  observationClose, FACTOR_VARIANTS,runFactorObservationAutomation } from '../src/factor-observation.js';
import { saveFactorChart } from '../src/factor-inputs.js';
import { isRegularUsTradingDay } from '../src/trading-calendar.js';

function fixture(start='2026-10-01',end='2026-10-05') {
  const db=openDatabase(':memory:');const universe=['A','B','C','D','E','F'];const groups={一:['A','B'],二:['C','D'],三:['E','F']};
  configureFactorObservations(db,{capital:1000000,universe,groups,observationStart:'2026-10-02'});
  for (const ticker of [...universe,'SPY']) {
    upsertWatchlistItem(db,{ticker});
    saveFactorChart(db,ticker,{chart:{result:[{meta:{exchangeTimezoneName:'America/New_York'},events:{},timestamp:[],indicators:{quote:[{close:[]}]}}]}});
    for (let d=new Date(start+'T00:00:00Z');d.toISOString().slice(0,10)<=end;d.setUTCDate(d.getUTCDate()+1)) {
      const date=d.toISOString().slice(0,10);if (isRegularUsTradingDay(date)) saveManualPrice(db,{ticker,tradeDate:date,close:100});
    }
  }
  return db;
}
function rankings(names=['A','B','C','D','E']) {
  const all=['A','B','C','D','E','F'];const group={A:'一',B:'一',C:'二',D:'二',E:'三',F:'三'};
  const rank=all.map((ticker,i)=>({ticker,group:group[ticker],qualityRank:1-i/10,momentumRank:.8,valueRank:.7,
    combined:1-i/10,selected:names.includes(ticker)}));
  return {rankings:Object.fromEntries(FACTOR_VARIANTS.map(v=>[v.key,rank])),source:{fixture:true}};
}

test('三账户相互隔离、沿下一交易日收盘成交，并将历史与前瞻收益分开',()=>{
  const db=fixture();saveFactorSignals(db,'2026-09-30',rankings());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n,0);
  assert.equal(advanceFactorAccounts(db,'2026-09-30').days,0);
  advanceFactorAccounts(db,'2026-10-01');
  saveManualPrice(db,{ticker:'A',tradeDate:'2026-10-02',close:110});
  advanceFactorAccounts(db,'2026-10-02');
  const result=getFactorObservations(db);
  for (const s of result.strategies) {
    assert.equal(s.positions.length,5);assert.equal(s.signal.tradeDate,'2026-10-01');
    assert.equal(s.signal.mode,'HISTORICAL');assert.ok(Math.abs(s.forward.totalReturn-.02)<1e-12);
    assert.ok(Math.abs(s.totals.marketValue-1020000)<1e-6);assert.equal(s.forward.baselineDate,'2026-10-01');
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n,0);
  db.close();
});

test('已执行信号不可被重算覆盖，重跑不重复调仓或日账',()=>{
  const db=fixture();saveFactorSignals(db,'2026-09-30',rankings());advanceFactorAccounts(db,'2026-10-05');
  const before=db.prepare('SELECT * FROM factor_observation_daily ORDER BY 1,2').all();
  saveFactorSignals(db,'2026-09-30',rankings(['A','C','D','E','F']));advanceFactorAccounts(db,'2026-10-05');
  assert.deepEqual(db.prepare('SELECT * FROM factor_observation_daily ORDER BY 1,2').all(),before);
  assert.equal(getFactorObservations(db).strategies[1].positions.some(x=>x.ticker==='B'),true);
  db.close();
});

test('卖出股票缺少成交价时，三个账户共同暂停，补齐后可继续',()=>{
  const db=fixture('2026-10-01','2026-11-02');saveFactorSignals(db,'2026-09-30',rankings());
  advanceFactorAccounts(db,'2026-10-30');saveFactorSignals(db,'2026-10-30',rankings(['A','C','D','E','F']));
  db.prepare("DELETE FROM prices_daily WHERE ticker='B' AND trade_date='2026-11-02'").run();
  const result=advanceFactorAccounts(db,'2026-11-02');assert.equal(result.status,'DEGRADED');
  assert.deepEqual(result.missing,['B']);assert.equal(getFactorObservations(db).asOf,'2026-10-30');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM factor_observation_signals WHERE signal_date='2026-10-30' AND status='PENDING'").get().n,3);
  saveManualPrice(db,{ticker:'B',tradeDate:'2026-11-02',close:100});advanceFactorAccounts(db,'2026-11-02');
  for (const s of getFactorObservations(db).strategies) {
    assert.equal(s.signal.mode,'FORWARD');assert.equal(s.positions.some(x=>x.ticker==='B'),false);
    assert.equal(s.positions.some(x=>x.ticker==='F'),true);assert.ok(Math.abs(s.totals.marketValue-1000000)<1e-6);
  }
  db.close();
});

test('拆股按一次增加股数并降低单位成本，不能产生虚假亏损',()=>{
  const db=fixture();
  saveFactorChart(db,'A',{chart:{result:[{events:{splits:{x:{date:Date.parse('2026-10-02T13:30:00Z')/1000,numerator:2,denominator:1}}}}]}});
  saveManualPrice(db,{ticker:'A',tradeDate:'2026-10-02',close:50});
  saveFactorSignals(db,'2026-09-30',rankings());advanceFactorAccounts(db,'2026-10-02');
  const s=getFactorObservations(db).strategies[0];const a=s.positions.find(x=>x.ticker==='A');
  assert.equal(a.quantity,4000);assert.equal(a.averageCost,50);assert.equal(s.forward.totalReturn,0);
  advanceFactorAccounts(db,'2026-10-02');assert.equal(getFactorObservations(db).strategies[0].positions.find(x=>x.ticker==='A').quantity,4000);
  db.close();
});

test('Yahoo历史价格恢复名义股价，但WDC分拆不会增加母公司股数',()=>{
  const db=fixture();const ticker='A';
  db.prepare(`UPDATE prices_daily SET provider='yahoo' WHERE ticker=?`).run(ticker);
  saveFactorChart(db,ticker,{chart:{result:[{events:{splits:{x:{date:Date.parse('2026-10-02T13:30:00Z')/1000,numerator:2,denominator:1}}}}]}});
  assert.equal(observationClose(db,ticker,'2026-10-01'),200);
  assert.equal(observationClose(db,ticker,'2026-10-02'),100);
  db.close();
});

test('缺失月末信号会在之后的交易日补算，数据源失败不推进账户',async()=>{
  const db=fixture('2026-10-01','2026-11-04');saveFactorSignals(db,'2026-09-30',rankings());advanceFactorAccounts(db,'2026-10-29');
  await assert.rejects(runFactorObservationAutomation(db,'2026-11-04',{syncInputs:false,computeSignals:()=>{throw new Error('FX过期');}}),/FX过期/);
  assert.equal(getFactorObservations(db).asOf,'2026-10-29');
  let called=[];
  await runFactorObservationAutomation(db,'2026-11-04',{syncInputs:false,computeSignals:(_,dates)=>{called=dates;return Object.fromEntries(dates.map(d=>[d,rankings()]));}});
  assert.deepEqual(called,['2026-10-30']);assert.equal(getFactorObservations(db).asOf,'2026-11-04');
  db.close();
});
