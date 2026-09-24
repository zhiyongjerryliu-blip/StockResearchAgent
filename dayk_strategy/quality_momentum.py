"""Monthly cross-sectional quality/momentum pilot with dated financial vintages."""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import sqlite3

import numpy as np
import pandas as pd

from fundamentals import prepare_facts, quarterly_points, select_vintages
from stockresearch_adapter import adjusted_prices
from strategy import Config, HERE

QUALITY = ['NetMarginTTM','OCFMarginTTM','BalanceSafety']
LABELS = {'basket_hold':'期初等权买入持有','equal_monthly':'合格池月度等权',
          'quality':'仅质量','momentum':'仅动量','quality_momentum':'质量＋动量（主规则）',
          'qm_defensive':'质量＋动量＋市场减仓','SPY':'SPY持有','LITE':'LITE持有'}


def freeze(database, universe, end, output):
    with sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
        placeholders=','.join('?' for _ in universe)
        get=lambda q,p:[dict(r) for r in db.execute(q,p)]
        facts=get(f'SELECT * FROM financial_facts WHERE ticker IN ({placeholders}) AND filed_at<=? ORDER BY ticker,filed_at,source_key',(*universe,end))
        filings=get(f'SELECT ticker,accession_number,filed_at,accepted_at,form,filing_url FROM sec_filings WHERE ticker IN ({placeholders}) ORDER BY ticker,filed_at',universe)
        symbols=sorted(set(universe)|{'SPY'})
        prices=get('SELECT ticker,trade_date,open,high,low,close,adjusted_close,volume,provider,available_at,ingested_at FROM prices_daily WHERE ticker IN ('+','.join('?' for _ in symbols)+") AND provider='yahoo' AND trade_date<=? ORDER BY ticker,trade_date",(*symbols,end))
    snap=dict(version='quality-momentum-frozen-v1',captured_at=datetime.now(timezone.utc).isoformat(),
              universe=universe,end=end,facts=facts,filings=filings,prices=prices)
    output.write_text(json.dumps(snap,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    return snap


def balance_facts(snapshot,currency='USD',forms=('10-K','10-Q','10-K/A','10-Q/A')):
    """Instantaneous facts use the same conservative disclosure clock as flows."""
    accepted={f['accession_number']:f.get('accepted_at') for f in snapshot['filings']}
    balance=[]
    for fact in snapshot['facts']:
        if fact['metric_key'] not in ('assets','liabilities'):continue
        try:
            if fact['unit']!=currency or fact['form'] not in forms:continue
            end,filed=[pd.Timestamp(fact[k]).normalize() for k in ('period_end','filed_at')]
            if pd.isna(end) or pd.isna(filed) or end>filed or not np.isfinite(float(fact['value'])):continue
            known=filed;stamp=accepted.get(fact['accession_number'])
            if stamp:
                instant=pd.Timestamp(stamp)
                acceptance=instant.normalize()+pd.Timedelta(days=1) if instant.tzinfo is None else instant.tz_convert('America/New_York').tz_localize(None).normalize()
                known=max(known,acceptance)
            balance.append({**fact,'_start':end,'_end':end,'_known':known})
        except (ValueError,TypeError,KeyError):continue
    return balance


def financial_features(snapshot, dates, delay=0,currency='USD',forms=('10-K','10-Q','10-K/A','10-Q/A')):
    """Quarterly flow reconstruction plus instantaneous balance-sheet vintages."""
    if not isinstance(delay,int) or delay<0:raise ValueError('Invalid financial delay')
    flows,_=prepare_facts(snapshot,metrics=('revenue','netIncome','operatingCashFlow'),currency=currency,forms=forms)
    balance=balance_facts(snapshot,currency,forms)
    incoming=defaultdict(list)
    for f in flows+balance:
        pos=dates.searchsorted(f['_known'],side='right')+delay
        if pos<len(dates):incoming[pos].append(f)
    visible=[];quarters={};balances={};rows=[]
    for i,day in enumerate(dates):
        if incoming[i]:
            visible.extend(incoming[i]);selected=select_vintages(visible)
            quarters=quarterly_points({k:v for k,v in selected.items() if k[0] not in ('assets','liabilities')})
            balances={(m,e):p for (m,s,e),p in selected.items() if m in ('assets','liabilities')}
        row=dict(Date=day,NetMarginTTM=np.nan,OCFMarginTTM=np.nan,BalanceSafety=np.nan,
                 FinPeriod=None,FinKnownDay=None,FinSources='[]')
        ends=sorted(e for m,e in quarters if m=='revenue')[-4:]
        if len(ends)==4 and 0<=(day-ends[-1]).days<=180:
            deps=[];totals=defaultdict(float);valid=True
            for j,end in enumerate(ends):
                rev=quarters[('revenue',end)]
                if j and abs((rev['start']-ends[j-1]).days-1)>3:valid=False;break
                for metric in ('revenue','netIncome','operatingCashFlow'):
                    point=quarters.get((metric,end))
                    if not point or point['value'] is None or point['start']!=rev['start']:
                        valid=False;break
                    deps.append(point);totals[metric]+=point['value']
                if not valid:break
            a,l=[balances.get((metric,ends[-1])) for metric in ('assets','liabilities')]
            if valid and totals['revenue']>0 and a and l and a['value'] is not None and a['value']>0 and l['value'] is not None and l['value']>=0:
                deps.extend([a,l]);row.update(NetMarginTTM=totals['netIncome']/totals['revenue'],
                    OCFMarginTTM=totals['operatingCashFlow']/totals['revenue'],BalanceSafety=-l['value']/a['value'],
                    FinPeriod=str(ends[-1].date()),FinKnownDay=str(max(p['known'] for p in deps).date()),
                    FinSources=json.dumps(sorted({key for p in deps for key in p['sources']})))
        rows.append(row)
    return pd.DataFrame(rows).set_index('Date')


def build_panel(snapshot,delay=0):
    prices={t:adjusted_prices(snapshot,t) for t in snapshot['universe']+['SPY']}
    dates=prices['SPY'].index
    frames={};coverage=[]
    for ticker in snapshot['universe']:
        p=prices[ticker].reindex(dates)
        sub=dict(facts=[f for f in snapshot['facts'] if f['ticker']==ticker],
                 filings=[f for f in snapshot['filings'] if f['ticker']==ticker])
        f=financial_features(sub,dates,delay,**snapshot.get('financial_metadata',{}).get(ticker,{}))
        f['Momentum']=p.Close.shift(21)/p.Close.shift(252)-1
        f['PriceReady']=p.Close.notna().rolling(253,min_periods=253).sum()==253
        f['Eligible']=f.PriceReady&f[QUALITY+['Momentum']].notna().all(axis=1)
        frames[ticker]=f
        eligible=f.index[f.Eligible]
        coverage.append(dict(ticker=ticker,price_start=str(prices[ticker].index[0].date()),price_end=str(prices[ticker].index[-1].date()),
                             facts=len(sub['facts']),financial_days=int(f[QUALITY].notna().all(axis=1).sum()),
                             eligible_days=len(eligible),first_eligible=str(eligible[0].date()) if len(eligible) else None))
    return prices,frames,pd.DataFrame(coverage)


def rank_on(frames,date):
    rows={t:f.loc[date] for t,f in frames.items() if bool(f.loc[date,'Eligible'])}
    if not rows:return pd.DataFrame(columns=QUALITY+['Momentum','QualityRank','MomentumRank','Combined'])
    rank=pd.DataFrame(rows).T
    rank['QualityRank']=rank[QUALITY].astype(float).rank(pct=True).mean(axis=1)
    rank['MomentumRank']=rank.Momentum.astype(float).rank(pct=True)
    rank['Combined']=.5*rank.QualityRank+.5*rank.MomentumRank
    rank.index.name='Ticker'
    return rank


def weights(rank,rule,defensive=False,top_n=3):
    if not isinstance(top_n,int) or isinstance(top_n,bool) or top_n<1:raise ValueError('Invalid holding count')
    if len(rank)<top_n:return {}
    if rule=='equal_monthly':return {t:1/len(rank) for t in sorted(rank.index)}
    field={'quality':'QualityRank','momentum':'MomentumRank','quality_momentum':'Combined','qm_defensive':'Combined'}[rule]
    ordered=rank.assign(TickerKey=rank.index).sort_values([field,'TickerKey'],ascending=[False,True])
    selected=ordered.head(top_n)
    scale=.5 if rule=='qm_defensive' and defensive else 1.
    return {t:scale/top_n for t in selected.index}


def rebalance(cash,units,opens,target,config):
    """Solve post-cost NAV once for the whole portfolio, then sell before buying."""
    if any(w<0 for w in target.values()) or sum(target.values())>1+1e-10:raise ValueError('Invalid weights')
    keys=sorted(set(units)|set(target));opens={t:float(opens[t]) for t in keys}
    if any(not np.isfinite(p) or p<=0 for p in opens.values()):raise ValueError('Missing executable open')
    old={t:units.get(t,0.) for t in keys};nav=cash+sum(old[t]*opens[t] for t in keys)
    fee,slip=config.fee_bps/10000,config.slippage_bps/10000
    def proposal(v):
        desired={t:target.get(t,0.)*v/opens[t] for t in keys}
        cost=0.
        for t in keys:
            delta=desired[t]-old[t];price=opens[t]*(1+slip if delta>=0 else 1-slip)
            cost+=abs(delta)*(abs(price-opens[t])+price*fee)
        return desired,cost
    lo,hi=0.,nav
    for _ in range(65):
        mid=(lo+hi)/2;_,cost=proposal(mid)
        if mid+cost>nav:hi=mid
        else:lo=mid
    desired,_=proposal((lo+hi)/2);trades=[]
    for t in sorted(keys,key=lambda t:desired[t]-old[t]):
        delta=desired[t]-old[t]
        if abs(delta)<1e-10:continue
        price=opens[t]*(1+slip if delta>0 else 1-slip);charge=abs(delta)*price*fee
        cash-=delta*price+charge
        trades.append(dict(ticker=t,delta_units=delta,fill='BUY' if delta>0 else 'SELL',price=price,fee=charge,
                           slippage_cost=abs(delta)*abs(price-opens[t]),target=target.get(t,0.)))
    if cash < -1e-6:raise ValueError('Portfolio overspent cash')
    actual_nav=max(0.,cash)+sum(desired[t]*opens[t] for t in keys)
    for t in keys:
        if abs(desired[t]*opens[t]/actual_nav-target.get(t,0.))>1e-8:raise ValueError('Target mismatch')
    return max(0.,cash),{t:u for t,u in desired.items() if u>1e-10},trades


def run_account(prices,frames,start,end,rule,config,exposure_controller=None,top_n=3,selection_controller=None):
    calendar=prices['SPY'].index;dates=calendar[(calendar>=pd.Timestamp(start))&(calendar<=pd.Timestamp(end))]
    if len(dates)<2:raise ValueError('Insufficient dates')
    spy=prices['SPY'].Close;ma=spy.rolling(200).mean()
    opens=pd.DataFrame({t:p.Open for t,p in prices.items()}).reindex(calendar)
    closes=pd.DataFrame({t:p.Close for t,p in prices.items()}).reindex(calendar)
    cash=config.initial_cash;units={};pending=None;daily=[];ledger=[];selections=[];holdings=[]
    # Passive basket uses only pre-start information; no future IPO inclusion.
    before=calendar[calendar<dates[0]]
    initial=[t for t in frames if len(before) and bool(frames[t].loc[before[-1],'PriceReady'])]
    if rule=='basket_hold':pending=({t:1/len(initial) for t in initial},'预设期初等权') if initial else None
    elif rule in ('SPY','LITE'):pending=({rule:1.},'预设期初持有')
    passive=rule in ('basket_hold','SPY','LITE')
    if passive and exposure_controller is not None:raise ValueError('Risk overlay is for active portfolios only')
    selected_weights={};commanded_weights={}
    old_equity=config.initial_cash;previous_close={}
    for i,day in enumerate(dates):
        old_units=units.copy();day_trades=[]
        if pending is not None:
            target,signal_day=pending
            cash,units,day_trades=rebalance(cash,units,opens.loc[day],target,config)
            for t in day_trades:ledger.append(dict(date=str(day.date()),signal_date=signal_day,**t))
            pending=None
        if any(not np.isfinite(closes.loc[day,t]) for t in units):raise ValueError('Missing held close; no silent forward fill')
        equity=cash+sum(u*closes.loc[day,t] for t,u in units.items())
        pnl=sum(u*(closes.loc[day,t]-previous_close[t]) for t,u in old_units.items()) if i else 0.
        pnl+=sum(t['delta_units']*(closes.loc[day,t['ticker']]-t['price'])-t['fee'] for t in day_trades)
        if abs(equity-old_equity-pnl)>1e-5:raise ValueError('Portfolio P&L identity failed')
        # Use a following session only to identify calendar month-end, not its prices.
        loc=calendar.get_loc(day)
        month_end=loc+1<len(calendar) and calendar[loc+1].month!=day.month
        selection_day=not passive and (i==0 or month_end)
        if selection_day:
            rank=rank_on(frames,day)
            selected_weights=selection_controller(rank) if selection_controller else weights(rank,rule,bool(spy.loc[day]<ma.loc[day]),top_n=top_n)
        if not passive:
            scale=float(exposure_controller(day)) if exposure_controller else 1.
            if not np.isfinite(scale) or not 0<=scale<=1:raise ValueError('Invalid exposure signal')
            target={t:w*scale for t,w in selected_weights.items() if w*scale>0}
        if not passive and (selection_day or target!=commanded_weights):
            commanded_weights=target.copy()
            pending=(target,str(day.date()))
            selections.append(dict(signal_date=str(day.date()),eligible_count=len(rank),target=json.dumps(target),
                                   next_fill_date=str(calendar[loc+1].date()) if loc+1<len(calendar) else None,
                                   executes_in_window=bool(i+1<len(dates))))
        fees=sum(t['fee'] for t in day_trades)
        daily.append(dict(Date=day,Equity=equity,Cash=cash,Exposure=1-cash/equity,Holdings=len(units),
                          Fee=fees,Turnover=sum(abs(t['delta_units'])*opens.loc[day,t['ticker']] for t in day_trades)/equity))
        holdings.extend(dict(Date=str(day.date()),Ticker=t,Units=u,Weight=u*closes.loc[day,t]/equity) for t,u in units.items())
        old_equity=equity;previous_close={t:closes.loc[day,t] for t in units}
    curve=pd.DataFrame(daily).set_index('Date')
    mark=equity-cash;exit_cost=mark*(1-(1-config.slippage_bps/10000)*(1-config.fee_bps/10000))
    curve['SettledEquity']=curve.Equity;curve.loc[curve.index[-1],'SettledEquity']-=exit_cost
    eq=curve.SettledEquity;days=(dates[-1]-dates[0]).days;ret=eq.iloc[-1]/config.initial_cash-1
    stats=dict(return_pct=float(ret*100),annual_return_pct=float(((1+ret)**(365.25/days)-1)*100),
               max_drawdown_pct=float((eq/eq.cummax().clip(lower=config.initial_cash)-1).min()*100),
               terminal_equity=float(eq.iloc[-1]),mean_exposure_pct=float(curve.Exposure.mean()*100),
               total_fees_before_terminal=float(curve.Fee.sum()),terminal_exit_cost=float(exit_cost),
               rebalance_dates=len({t['date'] for t in ledger}),trade_fills=len(ledger),
               gross_turnover=float(curve.Turnover.sum()),first_purchase=min((t['date'] for t in ledger if t['fill']=='BUY'),default=None))
    return stats,curve,pd.DataFrame(ledger),pd.DataFrame(selections),pd.DataFrame(holdings)


def display(stats):
    return pd.DataFrame([{'规则':LABELS[k],'累计收益%':s['return_pct'],'年化收益%':s['annual_return_pct'],
                          '最大回撤%':s['max_drawdown_pct'],'平均仓位%':s['mean_exposure_pct'],
                          '相对等权持有利润倍数':s['profit_multiple'],'收益/回撤同时达标':'是' if s['both_pass'] else '否'} for k,s in stats.items()])


def sensitivity(prices,frames,out):
    """Post-result diagnostic, never used to choose a better stock universe."""
    rows=[]
    for drop in frames:
        reduced={t:f for t,f in frames.items() if t!=drop}
        for period,start in [('full','2023-01-03'),('one_year','2025-09-18')]:
            stats={r:run_account(prices,reduced,start,'2026-09-18',r,Config())[0]
                   for r in ('basket_hold','momentum','quality_momentum')}
            h,m,q=[stats[r] for r in ('basket_hold','momentum','quality_momentum')]
            rows.append(dict(period=period,excluded=drop,hold_return=h['return_pct'],momentum_return=m['return_pct'],
                             combined_return=q['return_pct'],combined_dd=q['max_drawdown_pct'],
                             profit_multiple=q['return_pct']/h['return_pct'],quality_increment_pp=q['return_pct']-m['return_pct']))
    result=dict(purpose='主结果观察后进行固定规则逐股剔除诊断，不按结果重新选池；全部结果公开',rows=rows)
    pd.DataFrame(rows).to_csv(out/'leave_one_out.csv',index=False)
    (out/'sensitivity.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    return result


def report(results,curves,coverage,latest,protocol,out,audit):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    fig=make_subplots(rows=2,cols=1,shared_xaxes=True,subplot_titles=['组合账户价值（对数）','最大回撤路径'])
    for rule,c in curves.items():
        eq=c.SettledEquity
        fig.add_trace(go.Scatter(x=c.index,y=eq,name=LABELS[rule],legendgroup=rule),row=1,col=1)
        fig.add_trace(go.Scatter(x=c.index,y=(eq/eq.cummax().clip(lower=100000)-1)*100,name=LABELS[rule],legendgroup=rule,showlegend=False),row=2,col=1)
    fig.update_yaxes(type='log',row=1,col=1)
    fig.update_layout(height=850,template='plotly_white',legend=dict(orientation='h',y=1.15),margin=dict(t=130),hovermode='x unified')
    graph=fig.to_html(full_html=False,include_plotlyjs=True)
    tables=''.join(f'<h2>{key}：{s["start"]} — {s["end"]}</h2>'+display(s['stats']).to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}') for key,s in results.items())
    cols=[*QUALITY,'Momentum','QualityRank','MomentumRank','Combined']
    ranking=latest[cols].sort_values('Combined',ascending=False).to_html(border=0,float_format=lambda v:f'{v:.3f}')
    sensitivity_table=pd.DataFrame(audit['rows']).rename(columns={'period':'区间','excluded':'剔除股票','hold_return':'等权持有收益%',
        'momentum_return':'动量收益%','combined_return':'组合收益%','combined_dd':'组合最大回撤%',
        'profit_multiple':'持有利润倍数','quality_increment_pp':'相对仅动量增量百分点'}).to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')
    notes=''.join(f'<p><b>{k}</b>：{v}</p>' for k,v in protocol.items() if k not in ('sources','controls'))
    html=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>多股票质量＋动量研究</title><style>body{{max-width:1260px;margin:30px auto;padding:0 22px;font:16px/1.7 system-ui;color:#172b4d}}table{{border-collapse:collapse;width:100%;font-size:14px}}td,th{{padding:9px;border-bottom:1px solid #dde3eb;text-align:right}}td:first-child,th:first-child{{text-align:left}}</style>
<h1>质量＋动量：六股票池第一版</h1><p>这是集中于光通信和存储的试验池，股票名单事后确定，尚不能证明跨行业选股优势。原利润1.5倍及回撤减半目标继续保留，主要基准改为同池期初等权持有；LITE仅作附加对照。</p>
{graph}{tables}<h2>逐股剔除敏感性</h2><p>{audit['purpose']}。若某次剔除使质量增量消失或变负，说明质量增益依赖股票池；即便其他剔除结果仍正，也不能消除原股票池的事后选择偏差。</p>{sensitivity_table}
<h2>财务口径核验</h2><p>净利润并不等同于经常性经营利润。LITE在2026财年第四季度出现大额GAAP亏损，官方披露主要来自一次性非现金债务清偿损失；WDC净利润包含持有Sandisk权益的估值收益。本轮保留原始GAAP规则和结果，没有看过收益后手工修正评分。因此质量因子仍有一次性项目污染，不能仅凭组合收益认定其识别了经营质量。</p>
<p><a href="https://investor.lumentum.com/financial-news-releases/news-details/2026/Lumentum-Announces-Fourth-Quarter-and-Full-Fiscal-Year-2026-Results/default.aspx">Lumentum官方业绩公告</a> · <a href="https://investor.wdc.com/node/28586">WDC官方业绩公告</a></p>
<h2>数据覆盖</h2>{coverage.to_html(index=False,border=0)}<h2>样本末日排名（研究快照，不是即时下单指令）</h2>{ranking}
<p>本表并非月末调仓指令。质量数据必须全部存在，缺失时不强行打分。所有消融组共享合格池，因而“仅动量”也会受财务覆盖限制；等权被动基准不依赖财务齐全。</p>
<h2>方法与限制</h2>{notes}<p>因子研究参考：<a href="{protocol['sources'][0]}">Quality Minus Junk</a>；<a href="{protocol['sources'][1]}">Value and Momentum Everywhere</a>。本研究是自定义简化模型，不代表文献原策略的复现。</p><p><a href="summary.json">完整统计与哈希</a> · <a href="protocol.json">固定协议</a></p></html>'''
    path=out/'quality_momentum_report.html';path.write_text(html,encoding='utf-8');return path


def run(out,snapshot_path=None):
    out.mkdir(parents=True,exist_ok=True)
    protocol=json.loads((HERE/'quality_momentum_protocol.json').read_text())
    snapshot=json.loads(snapshot_path.read_text()) if snapshot_path else freeze(HERE.parent/'data/research.sqlite',protocol['universe'],protocol['end'],out/'snapshot.json')
    if snapshot_path:(out/'snapshot.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2))
    prices,frames,coverage=build_panel(snapshot)
    _,delayed,_=build_panel(snapshot,1)
    coverage.to_csv(out/'coverage.csv',index=False)
    for ticker,f in frames.items():f.to_csv(out/f'{ticker}_features.csv')
    cases=[('full','2023-01-03',Config(),frames),('late','2025-01-02',Config(),frames),
           ('one_year','2025-09-18',Config(),frames),('cost_stress','2023-01-03',Config(fee_bps=10,slippage_bps=20),frames),
           ('delay_stress','2023-01-03',Config(),delayed)]
    results={};full_curves=None
    for key,start,config,panel in cases:
        stats={};curves={};folder=out/key;folder.mkdir(exist_ok=True)
        for rule in LABELS:
            stats[rule],curves[rule],trades,selections,holdings=run_account(prices,panel,start,protocol['end'],rule,config)
            curves[rule].to_csv(folder/f'{rule}_daily.csv');trades.to_csv(folder/f'{rule}_trades.csv',index=False)
            selections.to_csv(folder/f'{rule}_selections.csv',index=False);holdings.to_csv(folder/f'{rule}_holdings.csv',index=False)
        for rule,s in stats.items():
            h=stats['basket_hold'];s['profit_multiple']=s['return_pct']/h['return_pct'] if h['return_pct']>0 else None
            s['profit_pass']=bool(h['return_pct']>0 and s['return_pct']>=1.5*h['return_pct'])
            s['drawdown_pass']=bool(abs(s['max_drawdown_pct'])<=abs(h['max_drawdown_pct'])/2)
            s['both_pass']=s['profit_pass'] and s['drawdown_pass']
            s['excess_equal_monthly_pp']=s['return_pct']-stats['equal_monthly']['return_pct']
        results[key]=dict(start=start,end=protocol['end'],stats=stats)
        if key=='full':full_curves=curves
        print(key,display(stats).to_string(index=False),sep='\n')
    latest=rank_on(frames,prices['SPY'].index[-1]);latest.to_csv(out/'latest_ranking.csv')
    # Record each decision-date input score and source keys for auditability.
    ranks=[]
    for day in full_curves['quality_momentum'].index:
        loc=prices['SPY'].index.get_loc(day)
        if day==full_curves['quality_momentum'].index[0] or (loc+1<len(prices['SPY']) and prices['SPY'].index[loc+1].month!=day.month):
            rank=rank_on(frames,day)
            if len(rank):ranks.append(rank.assign(SignalDate=str(day.date())).reset_index())
    if ranks:pd.concat(ranks,ignore_index=True).to_csv(out/'decision_rankings.csv',index=False)
    audit=sensitivity(prices,frames,out)
    summary=dict(protocol=protocol,results=results,coverage=coverage.to_dict('records'),
                 sensitivity=audit,
                 historical_pass=all(s['stats']['quality_momentum']['both_pass'] for s in results.values()),future_edge_verified=False,
                 input_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in [out/'snapshot.json',HERE/'quality_momentum_protocol.json']},
                 code_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),HERE/'fundamentals.py',HERE/'stockresearch_adapter.py']})
    (out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2,allow_nan=False))
    (out/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2))
    print('Report:',report(results,full_curves,coverage,latest,protocol,out,audit))
    print('Coverage:',coverage.to_string(index=False))
    return summary


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=HERE/'reports/quality_momentum')
    parser.add_argument('--snapshot',type=Path)
    args=parser.parse_args();run(args.output,args.snapshot)
