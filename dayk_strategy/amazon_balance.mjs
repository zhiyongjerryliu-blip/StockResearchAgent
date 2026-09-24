// Amazon's consolidated balance sheet has no separate noncontrolling equity.
// Match the SAME filing and balance-sheet date; never combine disclosure vintages.
import { createHash } from 'node:crypto';

export function amazonLiabilities(payload, normalized) {
  const concepts=payload?.facts?.['us-gaap'] || {};
  const equities=concepts.StockholdersEquity?.units?.USD || [];
  const totals=concepts.LiabilitiesAndStockholdersEquity?.units?.USD || [];
  const match=(rows,a)=>rows.filter(e=>!e.start && e.end===a.periodEnd &&
    e.accn===a.accessionNumber && e.filed===a.filedAt && e.form===a.form);
  const unique=(rows)=>[...new Set(rows.map(r=>r.val))];
  const derived=[];
  for(const a of normalized.filter(f=>f.ticker==='AMZN'&&f.metricKey==='assets')) {
    if(normalized.some(l=>l.metricKey==='liabilities'&&l.accessionNumber===a.accessionNumber&&l.periodEnd===a.periodEnd&&l.filedAt===a.filedAt))continue;
    const eq=unique(match(equities,a)),total=unique(match(totals,a));
    if(eq.length!==1 || total.length!==1 || total[0]!==a.value || !Number.isFinite(eq[0]))continue;
    const value=a.value-eq[0];
    if(value<0)throw new Error('Invalid Amazon balance-sheet identity');
    const fact={...a,metricKey:'liabilities',tagPriority:99,taxonomy:'derived',
      tag:'AssetsMinusStockholdersEquity',label:'总负债（同份财报资产减股东权益）',
      description:'Amazon balance identity; Assets = LiabilitiesAndStockholdersEquity verified in same filing.',
      value,derivedComponents:{assetsSourceKey:a.sourceKey,assets:a.value,stockholdersEquity:eq[0],
        equityTag:'us-gaap:StockholdersEquity',accessionNumber:a.accessionNumber,periodEnd:a.periodEnd,filedAt:a.filedAt}};
    fact.sourceKey=createHash('sha256').update(JSON.stringify([a.sourceKey,fact.tag,eq[0],value])).digest('hex');
    derived.push(fact);
  }
  return derived;
}
