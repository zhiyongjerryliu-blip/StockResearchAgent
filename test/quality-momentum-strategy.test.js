import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { addTransaction, saveManualPrice, upsertWatchlistItem } from '../src/repository.js';
import { getQualityMomentumStrategy, saveQualityMomentumStrategy } from '../src/quality-momentum-strategy.js';

test('质量动量策略保存规则、信号并汇总模拟持仓', () => {
  const db=openDatabase(':memory:');
  for (const ticker of ['A','B']) {
    upsertWatchlistItem(db,{ticker});
    saveManualPrice(db,{ticker,tradeDate:'2026-09-01',close:ticker==='A'?100:200});
    saveManualPrice(db,{ticker,tradeDate:'2026-09-02',close:ticker==='A'?110:180});
  }
  addTransaction(db,{ticker:'A',side:'BUY',tradeDate:'2026-09-01',quantity:10,price:100,fee:0});
  addTransaction(db,{ticker:'B',side:'BUY',tradeDate:'2026-09-01',quantity:5,price:200,fee:0});
  saveQualityMomentumStrategy(db,{
    name:'测试策略',capital:2000,selectionCount:2,maxPerGroup:1,targetWeight:.5,
    rebalanceRule:'月末评分',scoring:{description:'各50%'},universe:['A','B'],groups:{一:['A'],二:['B']},
    signalDate:'2026-08-31',tradeDate:'2026-09-01',rankings:[
      {ticker:'A',group:'一',combined:.9,selected:true},{ticker:'B',group:'二',combined:.8,selected:true}],
    selected:[{ticker:'A',group:'一',targetWeight:.5,targetValue:1000,entryPrice:100},
      {ticker:'B',group:'二',targetWeight:.5,targetValue:1000,entryPrice:200}]
  });
  const strategy=getQualityMomentumStrategy(db);
  assert.equal(strategy.positions.length,2);
  assert.equal(strategy.totals.investedCapital,2000);
  assert.equal(strategy.totals.marketValue,2000);
  assert.equal(strategy.totals.totalPnl,0);
  assert.equal(strategy.signal.signalDate,'2026-08-31');
  assert.equal(strategy.signal.rankings.length,2);
  assert.equal(strategy.signal.rebalance.length,2);
  assert.deepEqual(strategy.signal.rebalance.map((item) => item.action),['BUY','BUY']);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM quality_momentum_score_records').get().count,2);
  db.close();
});

test('每次选股保留逐股评分、入选原因和可执行调仓数据', () => {
  const db=openDatabase(':memory:');
  for (const ticker of ['A','B','C']) {
    upsertWatchlistItem(db,{ticker});
    saveManualPrice(db,{ticker,tradeDate:'2026-09-01',close:{A:100,B:200,C:400}[ticker]});
    saveManualPrice(db,{ticker,tradeDate:'2026-10-01',close:{A:120,B:250,C:500}[ticker]});
  }
  const common={
    name:'选股策略：质量—动量',capital:2000,selectionCount:2,maxPerGroup:1,targetWeight:.5,
    rebalanceRule:'月末评分',scoring:{description:'各50%'},universe:['A','B','C'],groups:{一:['A','C'],二:['B']}
  };
  saveQualityMomentumStrategy(db,{...common,signalDate:'2026-08-31',tradeDate:'2026-09-01',rankings:[
    {ticker:'A',group:'一',qualityRank:.9,momentumRank:.8,combined:.85,selected:true},
    {ticker:'B',group:'二',qualityRank:.8,momentumRank:.7,combined:.75,selected:true},
    {ticker:'C',group:'一',qualityRank:.7,momentumRank:.6,combined:.65,selected:false}],
  selected:[
    {ticker:'A',group:'一',targetWeight:.5,targetValue:1000,entryPrice:100,quantity:10},
    {ticker:'B',group:'二',targetWeight:.5,targetValue:1000,entryPrice:200,quantity:5}]});
  saveQualityMomentumStrategy(db,{...common,signalDate:'2026-09-30',tradeDate:'2026-10-01',rankings:[
    {ticker:'C',group:'一',qualityRank:.95,momentumRank:.9,combined:.925,selected:true},
    {ticker:'B',group:'二',qualityRank:.8,momentumRank:.8,combined:.8,selected:true},
    {ticker:'A',group:'一',qualityRank:.7,momentumRank:.7,combined:.7,selected:false}],
  selected:[
    {ticker:'C',group:'一',targetWeight:.5,targetValue:1000,entryPrice:500,quantity:2},
    {ticker:'B',group:'二',targetWeight:.5,targetValue:1000,entryPrice:250,quantity:4}]});

  const strategy=getQualityMomentumStrategy(db);
  assert.equal(strategy.signals.length,2);
  assert.deepEqual(strategy.signal.rebalance.map((item) => [item.ticker,item.action,item.deltaQuantity]),[
    ['A','SELL',-10],['B','REDUCE',-1],['C','BUY',2]
  ]);
  assert.equal(strategy.signal.rebalanceSummary.sellCash,1450);
  assert.equal(strategy.signal.rebalanceSummary.buyCash,1000);
  assert.equal(strategy.signal.rebalanceSummary.netCash,450);
  assert.match(strategy.signal.rankings[2].selectionReason,/组内上限/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM quality_momentum_score_records').get().count,6);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM quality_momentum_rebalances').get().count,5);
  db.close();
});
