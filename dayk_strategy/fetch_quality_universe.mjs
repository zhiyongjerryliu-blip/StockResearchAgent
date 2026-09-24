// Read-only reuse of StockResearchAgent's data providers; writes research files only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SecEdgarProvider, normalizeCompanyFacts, normalizeSubmissions } from '../src/sec.js';
import { YahooDailyProvider } from '../src/market.js';
import { config } from '../src/config.js';
import { amazonLiabilities } from './amazon_balance.mjs';
import { fetchForeignFilings } from './fetch_foreign_filings.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const industry=process.argv.includes('--industry18');
const out=path.join(root,industry?'reports/industry18':'reports/mega6');
const rawDir=path.join(out,'raw');
await fs.mkdir(rawDir,{recursive:true});
const universe=industry?['LITE','COHR','CIEN','MU','SNDK','WDC','STX','NVDA','AMD','AVGO','MRVL','TSM','GFS','UMC','ASML','AMAT','LRCX','KLAC']:['AAPL','GOOGL','AMZN','META','TSLA','NVDA'];
const end='2026-09-18';
const provider=new SecEdgarProvider({userAgent:config.sec.userAgent,requestsPerSecond:2});
provider.assertConfigured();
const yahoo=new YahooDailyProvider();
const read=async(file)=>JSON.parse(await fs.readFile(file,'utf8'));
const cache=async(name,fetcher)=>{
  const file=path.join(rawDir,name);
  try{return await read(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  const payload=await fetcher();
  await fs.writeFile(file,JSON.stringify(payload));
  return payload;
};
const snake=(object)=>Object.fromEntries(Object.entries(object).map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),v]));
const facts=[],filings=[],prices=[];const captured=new Date().toISOString();
for(const ticker of universe){
  const company=await cache(`${ticker}_sec.json`,()=>provider.fetchCompanyData(ticker));
  const normalized=normalizeCompanyFacts(company.companyFacts,ticker,company.company.cik);
  if(ticker==='AMZN')normalized.push(...amazonLiabilities(company.companyFacts,normalized));
  facts.push(...normalized
    .filter(f=>['revenue','netIncome','operatingCashFlow','assets','liabilities'].includes(f.metricKey)&&f.filedAt<=end)
    .map(f=>({...snake(f),ingested_at:captured})));
  filings.push(...normalizeSubmissions(company.submissions,ticker,company.company.cik).map(snake));
  console.log(`${ticker}: SEC financial records frozen`);
}
for(const ticker of [...universe,'SPY']){
  // Yahoo may silently aggregate range=max into monthly/quarterly bars.
  const bars=await cache(`${ticker}_prices_5y_daily.json`,()=>yahoo.fetchRange(ticker,'5y'));
  const studyBars=bars.filter(b=>b.tradeDate>='2023-01-03'&&b.tradeDate<=end);
  if(studyBars.length<(ticker==='SNDK'?300:900)||studyBars.at(-1)?.tradeDate!==end)
    throw new Error(`${ticker}: incomplete daily history (${studyBars.length} bars)`);
  prices.push(...bars.filter(b=>b.tradeDate>=(ticker==='SNDK'?'2025-02-24':'2021-09-02')&&b.tradeDate<=end).map(b=>({...snake(b),ingested_at:captured})));
  console.log(`${ticker}: price records frozen`);
}
const sourceHashes={};
for(const entry of await fs.readdir(rawDir,{withFileTypes:true}))if(entry.isFile())
  sourceHashes[entry.name]=createHash('sha256').update(await fs.readFile(path.join(rawDir,entry.name))).digest('hex');
const snapshot={version:'quality-momentum-frozen-v1',captured_at:captured,universe,end,facts,filings,prices,
  source_hashes:sourceHashes,provider:'StockResearchAgent SEC/Yahoo providers; no database writes'};
await fs.writeFile(path.join(out,'snapshot.json'),JSON.stringify(snapshot,null,2));
console.log(`Snapshot ready: ${facts.length} facts, ${prices.length} prices`);
if(industry && process.argv.includes('--foreign-filings'))
  await fetchForeignFilings(rawDir,config.sec.userAgent,process.argv.includes('--samples'));
