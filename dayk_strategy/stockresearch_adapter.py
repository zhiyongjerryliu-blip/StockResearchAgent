"""Freeze StockResearchAgent inputs read-only; preserve publication-time availability."""
from collections import defaultdict
from datetime import datetime,timezone
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import subprocess

import numpy as np
import pandas as pd

from fundamentals import METRICS,prepare_facts,select_vintages,quarterly_points
from strategy import HERE,validate_bars


def freeze_database(database,output,end):
    with sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
        rows=lambda query,args=():[dict(r) for r in db.execute(query,args)]
        facts=rows('SELECT * FROM financial_facts WHERE ticker=? ORDER BY filed_at,source_key',('LITE',))
        filings=rows('SELECT accession_number,filed_at,accepted_at,form,filing_url FROM sec_filings WHERE ticker=? ORDER BY filed_at,accession_number',('LITE',))
        prices=rows("SELECT ticker,trade_date,open,high,low,close,adjusted_close,volume,provider,available_at,ingested_at FROM prices_daily WHERE ticker IN ('LITE','SPY','CIEN','COHR') AND provider='yahoo' AND trade_date<=? ORDER BY ticker,trade_date",(end,))
        coverage={}
        for table,date in [('earnings_estimates','as_of'),('ticks_intraday','trade_date'),('intraday_tick_minutes','trade_date')]:
            coverage[table]=rows(f'SELECT count(*) records,count(distinct {date}) days,min({date}) first,max({date}) last FROM {table} WHERE ticker=?',('LITE',))[0]
        coverage['macro_market_bars']=rows('SELECT indicator_key,count(*) records,min(trade_date) first,max(trade_date) last FROM macro_market_bars GROUP BY indicator_key')
        snapshot=dict(version='stockresearch-frozen-v1',ticker='LITE',captured_at=datetime.now(timezone.utc).isoformat(),
                      facts=facts,filings=filings,prices=prices,excluded_coverage=coverage)
    path=output/'stockresearch_snapshot.json'
    path.write_text(json.dumps(snapshot,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    return snapshot


def adjusted_prices(snapshot,ticker):
    records=[r for r in snapshot['prices'] if r['ticker']==ticker]
    if not records:raise ValueError('缺少行情：'+ticker)
    frame=pd.DataFrame(records).set_index('trade_date')
    if frame.index.has_duplicates:raise ValueError('重复行情')
    raw=pd.to_numeric(frame.close);adjusted=pd.to_numeric(frame.adjusted_close)
    if (raw<=0).any() or (adjusted<=0).any() or not np.isfinite(raw).all() or not np.isfinite(adjusted).all():raise ValueError('复权收盘缺失或错误')
    factor=adjusted/raw
    result=pd.DataFrame({k.capitalize():pd.to_numeric(frame[k])*factor for k in ['open','high','low','close']})
    result['Volume']=pd.to_numeric(frame.volume);result.index.name='Date'
    return validate_bars(result)


def export_flow(bars,output):
    bars=validate_bars(bars).rename_axis('Date')
    rows=json.loads(bars.reset_index().assign(Date=lambda f:f.Date.dt.strftime('%Y-%m-%d')).to_json(orient='records',double_precision=15))
    source=output/'flow_price_input.json';target=output/'stockresearch_flow.json'
    source.write_text(json.dumps(rows,allow_nan=False),encoding='utf-8')
    subprocess.run(['node',str(HERE/'stockresearch_flow.mjs'),str(source),str(target)],check=True,capture_output=True,text=True)
    return json.loads(target.read_text())


def add_market_flow(data,snapshot,flow):
    result=data.copy();market=adjusted_prices(snapshot,'SPY').Close.reindex(data.index)
    result['SPYClose']=market
    result['SPYSMA200']=market.rolling(200,min_periods=200).mean()
    result['SPYReturn20']=market.pct_change(20,fill_method=None).where(market.notna().rolling(21).sum()==21)
    result['MarketAvailable']=result[['SPYClose','SPYSMA200','SPYReturn20']].notna().all(axis=1)
    result['MarketRiskOff']=result.MarketAvailable&(result.SPYClose<result.SPYSMA200)&(result.SPYReturn20<0)
    rows=pd.DataFrame(flow['rows']);rows['Date']=pd.to_datetime(rows.Date)
    if rows.Date.duplicated().any():raise ValueError('资金特征日期重复')
    if not (rows.Date.dt.strftime('%Y-%m-%d')==rows.priceDate).all():raise ValueError('资金特征使用了非当日行情')
    rows=rows.set_index('Date')
    if not rows.index.equals(data.index):raise ValueError('资金特征与回测日期不一致')
    if not np.allclose(rows.close,data.Close,rtol=1e-12,atol=1e-9):raise ValueError('资金特征与回测价格不一致')
    result['FlowScore']=rows.score;result['PriorFlowScore']=rows.score.shift(1)
    result['FlowSignal']=rows.signal
    for field,label in [('cmf20','CMF20'),('mfi14','MFI14'),('obvSlope20d','OBVProxy20'),('relativeVolume','RelativeVolume')]:
        result[label]=rows.metrics.map(lambda m:m.get(field) if isinstance(m,dict) else np.nan)
    result['FlowAvailable']=result.FlowScore.notna()
    return result


def extra_financial_daily(snapshot,dates,extra_delay=0):
    if not isinstance(extra_delay,int) or extra_delay<0:raise ValueError('非法延迟')
    dates=pd.DatetimeIndex(dates)
    if dates.has_duplicates or not dates.is_monotonic_increasing:raise ValueError('交易日期必须唯一且升序')
    clean,_=prepare_facts(snapshot,metrics=(*METRICS,'netIncome'))
    incoming=defaultdict(list)
    for fact in clean:
        first=dates.searchsorted(fact['_known'],side='right')+extra_delay
        if first<len(dates):incoming[first].append(fact)
    visible=[];quarters={};output=[]
    for i,date in enumerate(dates):
        if incoming[i]:
            visible.extend(incoming[i]);quarters=quarterly_points(select_vintages(visible))
        ends=sorted(e for m,e in quarters if m=='revenue')
        row=dict(Date=date,OCFMargin=np.nan,OCFMarginYoY=np.nan,OperatingMarginYoY=np.nan,
                 NetMargin=np.nan,CashConversion=np.nan,ExtraFinKnownDay=None,ExtraFinSources='[]')
        deps=[]
        def amount(metric,end):
            p=quarters.get((metric,end));r=quarters.get(('revenue',end))
            if p:deps.append(p)
            if not p or not r or p['start']!=r['start'] or p['value'] is None:return None
            return p['value']
        if ends and (date-ends[-1]).days<=180:
            end=ends[-1];rev=amount('revenue',end);ocf=amount('operatingCashFlow',end)
            op=amount('operatingIncome',end);net=amount('netIncome',end)
            if rev and rev>0:
                if ocf is not None:row['OCFMargin']=ocf/rev
                if net is not None:row['NetMargin']=net/rev
                if net is not None and net>0 and ocf is not None:row['CashConversion']=ocf/net
                old=[e for e in ends if 350<=(end-e).days<=380]
                if old:
                    prev=min(old,key=lambda e:abs((end-e).days-365));prev_rev=amount('revenue',prev)
                    prev_ocf=amount('operatingCashFlow',prev);prev_op=amount('operatingIncome',prev)
                    if prev_rev and prev_rev>0:
                        if ocf is not None and prev_ocf is not None:row['OCFMarginYoY']=ocf/rev-prev_ocf/prev_rev
                        if op is not None and prev_op is not None:row['OperatingMarginYoY']=op/rev-prev_op/prev_rev
        if deps:
            row['ExtraFinKnownDay']=str(max(p['known'] for p in deps).date())
            row['ExtraFinSources']=json.dumps(sorted({s for p in deps for s in p['sources']}))
        output.append(row)
    return pd.DataFrame(output).set_index('Date')


def source_hashes():
    paths=[HERE/name for name in ['stockresearch_adapter.py','stockresearch_flow.mjs','integrated_research.py','fundamentals.py','dynamic_research.py','cycle_research.py','position_research.py','strategy.py']]
    paths += [HERE.parent/'src/capital-flow.js',HERE.parent/'src/domain.js']
    return {str(p.relative_to(HERE.parent)):sha256(p.read_bytes()).hexdigest() for p in paths}
