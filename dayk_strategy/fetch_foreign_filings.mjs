import fs from 'node:fs/promises';
import path from 'node:path';
export async function fetchForeignFilings(rawDir,userAgent,samples=false){
  const out=path.join(rawDir,'foreign_filings');await fs.mkdir(out,{recursive:true});
  const manifest=[];
  for(const ticker of ['TSM','UMC','ASML','GFS']){
    const company=JSON.parse(await fs.readFile(path.join(rawDir,`${ticker}_sec.json`),'utf8'));
    const r=company.submissions.filings.recent;const cik=Number(company.company.cik);let picked=0;
    for(let i=r.form.length-1;i>=0;i--){
      if(r.form[i]!=='6-K'||r.filingDate[i]<'2021-01-01'||r.filingDate[i]>'2026-09-18')continue;
      const doc=r.primaryDocument[i].toLowerCase(),filed=r.filingDate[i];
      const use=ticker==='TSM'?(/fsx/.test(doc)||(filed<'2023-05-01'&&(/tsm-6k/.test(doc)||doc==='d159037d6k.htm'))):
        ticker==='UMC'?/umcfs|quarterly_reports|annual_reports/.test(doc):
        ticker==='ASML'?/quarterlyfilings/.test(doc):/gfs-20|quarterlyrepo|quarterlyreportonfo/.test(doc);
      if(!use)continue;
      if(samples && !(filed>='2026-07-01'||(ticker==='TSM'&&filed==='2022-11-14')))continue;
      const accession=r.accessionNumber[i],url=`https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replaceAll('-','')}/${accession}.txt`;
      const name=`${ticker}_${accession}.txt`,file=path.join(out,name);
      try{await fs.access(file);}catch{
        let payload;
        for(let attempt=0;attempt<3;attempt++){
          await new Promise(resolve=>setTimeout(resolve,600+attempt*1500));
          try{const res=await fetch(url,{headers:{'User-Agent':userAgent},signal:AbortSignal.timeout(30000)});if(!res.ok)throw new Error(`HTTP ${res.status}`);payload=await res.text();break;}catch(e){if(attempt===2)throw e;}
        }
        await fs.writeFile(file,payload);
      }
      manifest.push({ticker,accession_number:accession,filed_at:filed,accepted_at:r.acceptanceDateTime[i],
        report_date:r.reportDate[i],primary_document:r.primaryDocument[i],source_url:url,file:name});picked++;
    }
    console.log(`${ticker}: ${picked} quarterly filing documents cached`);
  }
  await fs.writeFile(path.join(out,samples?'samples.json':'manifest.json'),JSON.stringify(manifest,null,2));
}
