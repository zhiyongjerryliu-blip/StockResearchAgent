import { nowIso } from './db.js';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.js';

export function saveFactorInput(db, key, payload) {
  db.prepare(`INSERT INTO factor_input_cache(input_key,payload_json,fetched_at)
    VALUES(?,?,?) ON CONFLICT(input_key) DO UPDATE SET
    payload_json=excluded.payload_json,fetched_at=excluded.fetched_at`)
    .run(key, JSON.stringify(payload), nowIso());
}

export function saveFactorChart(db, ticker, payload) {
  const old = db.prepare('SELECT payload_json FROM factor_input_cache WHERE input_key=?').get(`chart:${ticker}`);
  const previous = old ? JSON.parse(old.payload_json)?.chart?.result?.[0] : null;
  const current = payload?.chart?.result?.[0];
  if (!current) throw new Error(`${ticker}公司行动或汇率数据为空`);
  const merged = structuredClone(payload);
  merged.chart.result[0].events = {
    ...previous?.events, ...current.events,
    splits: { ...previous?.events?.splits, ...current.events?.splits }
  };
  // Currency history must retain earlier observations for reproducible replay.
  if (ticker.includes('=X') && previous?.timestamp) {
    const values = new Map(previous.timestamp.map((stamp, i) => [stamp, previous.indicators.quote[0].close[i]]));
    for (const [i,stamp] of (current.timestamp || []).entries()) values.set(stamp,current.indicators.quote[0].close[i]);
    const ordered=[...values].sort((a,b)=>a[0]-b[0]);
    merged.chart.result[0].timestamp=ordered.map(([stamp])=>stamp);
    merged.chart.result[0].indicators={quote:[{close:ordered.map(([,value])=>value)}]};
  }
  saveFactorInput(db, `chart:${ticker}`, merged);
}

export async function syncFactorFx(db, provider) {
  if (!provider?.fetchRange) throw new Error('观察策略需要Yahoo历史汇率数据源');
  for (const symbol of ['TWD=X','EURUSD=X']) {
    await provider.fetchRange(symbol,'5y');
    saveFactorChart(db,symbol,provider.factorCharts.get(symbol));
  }
  return { currencies: ['TWD','EUR'] };
}

export async function syncForeignFactorFacts(db, provider, throughDate) {
  const results=[];
  for (const ticker of ['TSM','UMC','ASML','GFS']) {
    const input=db.prepare('SELECT payload_json FROM factor_input_cache WHERE input_key=?').get(`sec:${ticker}`);
    if (!input) throw new Error(`${ticker}缺少SEC原始数据`);
    const company=JSON.parse(input.payload_json);const recent=company.submissions.filings.recent;
    const old=db.prepare('SELECT payload_json FROM factor_input_cache WHERE input_key=?').get(`foreign:${ticker}`);
    const extra=old?JSON.parse(old.payload_json):{facts:[],filings:[]};
    const seen=new Set(extra.filings.map(f=>f.accession_number));
    const latest=db.prepare('SELECT MAX(filed_at) d FROM financial_facts WHERE ticker=?').get(ticker)?.d || '2021-01-01';
    let count=0;
    for (let i=recent.form.length-1;i>=0;i--) {
      if (recent.form[i]!=='6-K' || recent.filingDate[i]<=latest || recent.filingDate[i]>throughDate || seen.has(recent.accessionNumber[i])) continue;
      const doc=recent.primaryDocument[i].toLowerCase();
      const quarterly=ticker==='TSM'?/fsx/.test(doc):ticker==='UMC'?/umcfs|quarterly_reports|annual_reports/.test(doc)
        :ticker==='ASML'?/quarterlyfilings/.test(doc):/gfs-20|quarterlyrepo|quarterlyreportonfo/.test(doc);
      if (!quarterly) continue;
      if (!provider) throw new Error(`${ticker}有新季度财报但SEC数据源不可用`);
      provider.assertConfigured();await provider.waitForRateLimit();
      const accn=recent.accessionNumber[i];
      const url=`https://www.sec.gov/Archives/edgar/data/${Number(company.company.cik)}/${accn.replaceAll('-','')}/${accn}.txt`;
      const response=await provider.fetchImpl(url,{headers:{'User-Agent':provider.userAgent},signal:AbortSignal.timeout(30_000)});
      if (!response.ok) throw new Error(`${ticker}季度财报请求失败：HTTP ${response.status}`);
      const record={ticker,accession_number:accn,filed_at:recent.filingDate[i],accepted_at:recent.acceptanceDateTime[i],
        report_date:recent.reportDate[i],form:'6-K',source_url:url};
      const parsed=spawnSync(process.env.QUALITY_MOMENTUM_PYTHON || path.join(config.projectRoot,'dayk_strategy/.venv/bin/python'),
        [path.join(config.projectRoot,'dayk_strategy/parse_factor_foreign.py')],{
          input:JSON.stringify({record,raw:await response.text()}),encoding:'utf8',timeout:45_000,maxBuffer:10*1024*1024});
      if (parsed.error || parsed.status!==0) throw new Error(`${ticker}财报解析失败：${parsed.error?.message || parsed.stderr}`);
      const facts=JSON.parse(parsed.stdout);
      if (!facts.length) throw new Error(`${ticker}新季度财报未解析出有效指标，停止新增观察信号`);
      extra.facts.push(...facts);extra.filings.push(record);count+=facts.length;
    }
    if (count) {
      db.exec('BEGIN IMMEDIATE');
      try {
        saveFactorInput(db,`foreign:${ticker}`,extra);
        const insert=db.prepare(`INSERT OR IGNORE INTO financial_facts(source_key,ticker,cik,metric_key,tag_priority,taxonomy,tag,
          label,unit,period_start,period_end,period_type,fiscal_year,form,filed_at,accession_number,value,source_url,ingested_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const f of extra.facts) insert.run(f.source_key,ticker,String(company.company.cik),f.metric_key,f.tag_priority,
          f.taxonomy,f.tag,f.metric_key,f.unit,f.period_start,f.period_end,f.period_type,Number(f.period_end.slice(0,4)),
          f.form,f.filed_at,f.accession_number,f.value,f.source_url,nowIso());
        for (const f of extra.filings) db.prepare(`INSERT OR IGNORE INTO sec_filings(accession_number,ticker,cik,form,filed_at,
          report_date,accepted_at,filing_url,ingested_at) VALUES(?,?,?,'6-K',?,?,?,?,?)`).run(f.accession_number,ticker,
            String(company.company.cik),f.filed_at,f.report_date,f.accepted_at,f.source_url,nowIso());
        db.exec('COMMIT');
      } catch(error) {db.exec('ROLLBACK');throw error;}
    }
    results.push({ticker,ok:true,count});
  }
  return {results};
}
