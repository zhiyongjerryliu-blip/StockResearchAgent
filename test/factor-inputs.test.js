import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDatabase } from '../src/db.js';
import { upsertWatchlistItem } from '../src/repository.js';
import { saveFactorChart,saveFactorInput,syncForeignFactorFacts } from '../src/factor-inputs.js';

test('季度6-K更新同时服务原策略和观察策略，重复同步不重复解析',async()=>{
  const db=openDatabase(':memory:');const folder=new URL('../dayk_strategy/reports/industry18/raw/foreign_filings/',import.meta.url);
  const manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',folder),'utf8'));
  const rec=manifest.filter(x=>x.ticker==='GFS').at(-1);
  for (const ticker of ['TSM','UMC','ASML','GFS']) {
    upsertWatchlistItem(db,{ticker});
    saveFactorInput(db,`sec:${ticker}`,{company:{cik:'1709048'},submissions:{filings:{recent:ticker==='GFS'?{
      form:['6-K'],accessionNumber:[rec.accession_number],filingDate:[rec.filed_at],primaryDocument:[rec.primary_document],
      acceptanceDateTime:[rec.accepted_at],reportDate:[rec.report_date]}:{form:[]}}}});
  }
  let requests=0;
  const provider={assertConfigured(){},async waitForRateLimit(){},userAgent:'fixture@example.com',
    async fetchImpl(){requests++;return {ok:true,async text(){return fs.readFileSync(new URL(rec.file,folder),'utf8');}};}};
  await syncForeignFactorFacts(db,provider,'2026-10-09');
  assert.equal(requests,1);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM financial_facts WHERE ticker='GFS'").get().n>0);
  assert.equal(db.prepare('SELECT accepted_at FROM sec_filings WHERE accession_number=?').get(rec.accession_number).accepted_at,rec.accepted_at);
  assert.ok(JSON.parse(db.prepare("SELECT payload_json FROM factor_input_cache WHERE input_key='foreign:GFS'").get().payload_json).facts.length>0);
  await syncForeignFactorFacts(db,provider,'2026-10-09');assert.equal(requests,1);db.close();
});

test('刷新保留既有拆股事件和历史汇率，不让短行情覆盖历史依赖',()=>{
  const db=openDatabase(':memory:');
  const chart=(timestamp,close,splits={})=>({chart:{result:[{meta:{exchangeTimezoneName:'Europe/London'},timestamp,
    indicators:{quote:[{close}]},events:{splits}}]}});
  saveFactorChart(db,'EURUSD=X',chart([1,2],[1.1,1.2],{s:{date:2,numerator:2,denominator:1}}));
  saveFactorChart(db,'EURUSD=X',chart([2,3],[1.25,1.3]));
  const x=JSON.parse(db.prepare("SELECT payload_json FROM factor_input_cache WHERE input_key='chart:EURUSD=X'").get().payload_json).chart.result[0];
  assert.deepEqual(x.timestamp,[1,2,3]);assert.deepEqual(x.indicators.quote[0].close,[1.1,1.25,1.3]);
  assert.equal(x.events.splits.s.numerator,2);db.close();
});
