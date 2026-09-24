import test from 'node:test';
import assert from 'node:assert/strict';
import { amazonLiabilities } from './amazon_balance.mjs';

test('Amazon liabilities preserve filing vintage and reject incomplete or ambiguous inputs',()=>{
  const a={ticker:'AMZN',metricKey:'assets',periodEnd:'2024-12-31',filedAt:'2025-02-07',
    accessionNumber:'original',form:'10-K',value:100,sourceKey:'asset-original'};
  const eq={end:a.periodEnd,filed:a.filedAt,accn:a.accessionNumber,form:a.form,val:40};
  const payload=(equity,total=[{...eq,val:100}])=>({facts:{'us-gaap':{
    StockholdersEquity:{units:{USD:equity}},LiabilitiesAndStockholdersEquity:{units:{USD:total}}}}});
  const result=amazonLiabilities(payload([eq,{...eq,accn:'future',filed:'2026-02-01',val:70}]),[a]);
  assert.equal(result[0].value,60);assert.equal(result[0].filedAt,a.filedAt);
  assert.equal(result[0].derivedComponents.assetsSourceKey,a.sourceKey);
  assert.equal(amazonLiabilities(payload([{...eq,accn:'future'}]),[a]).length,0);
  assert.equal(amazonLiabilities(payload([eq,{...eq,val:50}]),[a]).length,0);
  assert.equal(amazonLiabilities(payload([eq],[{...eq,val:101}]),[a]).length,0);
  assert.equal(amazonLiabilities(payload([eq]),[a,{...a,metricKey:'liabilities',value:60}]).length,0);
});
