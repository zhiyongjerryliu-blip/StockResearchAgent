"""Read-only production factor scoring, with dated DB inputs and explicit exclusions."""
import json
import sqlite3
import sys
from pathlib import Path
import pandas as pd
from foreign_financials import META, TAGS, FORMS, make_fact
from quality_momentum import rank_on
from three_factor_research import build_value_panel, score, select


def compute(database, signal_dates):
    root=Path(__file__).resolve().parent
    base=json.loads((root/'industry18_protocol.json').read_text())
    protocol=json.loads((root/'three_factor_protocol.json').read_text())
    end=max(signal_dates);universe=base['universe'];marks=','.join('?' for _ in universe)
    with sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
        rows=lambda sql,args:[dict(r) for r in db.execute(sql,args)]
        facts=rows(f'SELECT * FROM financial_facts WHERE ticker IN ({marks}) AND filed_at<=? ORDER BY ticker,filed_at,source_key',(*universe,end))
        filings=rows(f'SELECT * FROM sec_filings WHERE ticker IN ({marks})',universe)
        symbols=universe+['SPY'];pm=','.join('?' for _ in symbols)
        prices=rows(f"SELECT * FROM prices_daily WHERE ticker IN ({pm}) AND provider='yahoo' AND trade_date<=? ORDER BY ticker,trade_date",(*symbols,end))
        cache={r['input_key']:json.loads(r['payload_json']) for r in db.execute('SELECT * FROM factor_input_cache')}
        originals={r['signal_date']:json.loads(r['rankings_json']) for r in db.execute('SELECT * FROM quality_momentum_signals')}
    missing=[key for key in [f'sec:{t}' for t in universe]+[f'chart:{t}' for t in universe+['TWD=X','EURUSD=X']] if key not in cache]
    if missing:raise RuntimeError('Missing observation inputs: '+','.join(missing))
    # Foreign quarterly statements are kept separate from the legacy financial DB.
    # Merge only source-key-distinct dated observations, never replace with current ratios.
    seen={f['source_key'] for f in facts}
    for ticker in META:
        extra=cache.get('foreign:'+ticker,{})
        facts.extend(f for f in extra.get('facts',[]) if f['source_key'] not in seen and f['filed_at']<=end)
        filings.extend(extra.get('filings',[]))
        recent=cache['sec:'+ticker]['submissions'].get('filings',{}).get('recent',{})
        for i,accn in enumerate(recent.get('accessionNumber',[])):
            filings.append(dict(accession_number=accn,ticker=ticker,filed_at=recent['filingDate'][i],
                                accepted_at=recent.get('acceptanceDateTime',[None]*len(recent['accessionNumber']))[i]))
        company=cache['sec:'+ticker]
        for taxonomy, concepts in company['companyFacts']['facts'].items():
            if taxonomy not in ('us-gaap','ifrs-full'):continue
            for tag,metric in TAGS.items():
                for f in concepts.get(tag,{}).get('units',{}).get(META[ticker]['currency'],[]):
                    if f.get('form') not in FORMS or f.get('filed','')>end:continue
                    rec=dict(ticker=ticker,form=f['form'],filed_at=f['filed'],accession_number=f['accn'],
                             source_url=f"https://www.sec.gov/Archives/edgar/data/{int(company['company']['cik'])}/{f['accn'].replace('-','')}/{f['accn']}-index.html")
                    point=make_fact(rec,metric,f['val'],f.get('start'),f['end'],taxonomy+':'+tag,priority=10)
                    if point['source_key'] not in seen:facts.append(point);seen.add(point['source_key'])
    # AMD omits a direct Liabilities tag in some filings; reconstruct from the
    # same filing's assets and equity, matching the original research adapter.
    concepts=cache['sec:AMD']['companyFacts']['facts'].get('us-gaap',{})
    for asset in list(facts):
        if asset['ticker']!='AMD' or asset['metric_key']!='assets':continue
        match=lambda tag:{f['val'] for f in concepts.get(tag,{}).get('units',{}).get('USD',[])
                          if not f.get('start') and f.get('accn')==asset['accession_number'] and f.get('end')==asset['period_end'] and f.get('filed')==asset['filed_at']}
        equity,total=match('StockholdersEquity'),match('LiabilitiesAndStockholdersEquity')
        if len(equity)==1 and total=={asset['value']}:
            point=make_fact(asset,'liabilities',asset['value']-next(iter(equity)),None,asset['period_end'],
                            'Assets-StockholdersEquity (same filing)',priority=99)
            if point['source_key'] not in seen:facts.append(point);seen.add(point['source_key'])
    snap=dict(universe=universe,facts=facts,filings=filings,prices=prices,financial_metadata=META)
    inputs=dict(sec={t:cache['sec:'+t] for t in universe},charts={t:cache['chart:'+t] for t in universe+['TWD=X','EURUSD=X']})
    _,frames,_,_,_=build_value_panel(snap,protocol,value_inputs=inputs)
    mapping={t:g for g,ts in base['groups'].items() for t in ts}
    result={}
    for date in signal_dates:
        day=pd.Timestamp(date)
        if day not in next(iter(frames.values())).index:raise RuntimeError('Missing complete signal-date calendar: '+date)
        rank=rank_on(frames,day)
        excluded=[dict(ticker=t,reason='价值数据不完整或超过时效') for t,f in frames.items()
                  if bool(f.loc[day,'QMOriginalEligible']) and not bool(f.loc[day,'Eligible'])]
        variants={}
        for key in ['QM','QV','QVM_equal']:
            weights=protocol['variants'][key];r=score(rank,mapping,weights);picked=select(rank,mapping,weights)
            if len(picked)!=5:raise RuntimeError(f'{date} {key}: expected five eligible selections, got {len(picked)}')
            r=r.assign(TickerKey=r.index).sort_values(['Score','TickerKey'],ascending=[False,True])
            rankings=[]
            for t,item in r.iterrows():
                rankings.append(dict(ticker=t,group=mapping[t],qualityRank=float(item.QualityRank),momentumRank=float(item.MomentumRank),
                    valueRank=float(item.ValueRank),combined=float(item.Score),selected=t in picked,
                    scoringDetails=dict(netMarginTTM=float(item.NetMarginTTM),ocfMarginTTM=float(item.OCFMarginTTM),
                        balanceSafety=float(item.BalanceSafety),momentum=float(item.Momentum),earningsYield=float(item.EarningsYield),
                        ocfYield=float(item.OCFYield),financialPeriod=item.FinPeriod,financialKnownDay=item.FinKnownDay,
                        shareEnd=item.ShareEnd,shareKnownDay=item.ShareKnownDay,shareSource=item.ShareSource,
                        reportingCurrency=item.ReportingCurrency,fxDate=item.FXDate,fx=float(item.FX))))
            # Reference holdings follow the original saved strategy, so the comparison
            # does not silently alter or reconstruct past production choices.
            if key=='QM' and date in originals:
                old=originals[date];oldmap={x['ticker']:x for x in old};newmap={x['ticker']:x for x in rankings}
                rankings=[{**newmap.get(x['ticker'],{}),**x,'valueRank':newmap.get(x['ticker'],{}).get('valueRank')}
                          for x in old]
            variants[key]=rankings
        result[date]=dict(rankings=variants,source=dict(calculator='compute_factor_signals.py',
            eligibleCount=len(rank),valueExclusions=excluded,valueRanking='subgroup-percentile',
            protocol='three_factor_protocol.json',execution='next-session-close',
            qmReference='saved-existing-signal' if date in originals else 'computed-same-pool'))
    return result


if __name__=='__main__':
    if len(sys.argv)!=3:raise SystemExit('usage: compute_factor_signals.py DATABASE DATE[,DATE]')
    print(json.dumps(compute(sys.argv[1],sys.argv[2].split(',')),ensure_ascii=False,allow_nan=False))
