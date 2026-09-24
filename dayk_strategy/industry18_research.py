"""Frozen eighteen-stock industry portfolio experiment, no parameter search."""
import json
from pathlib import Path
from hashlib import sha256
from collections import Counter
from html import escape
import numpy as np
import pandas as pd
from quality_momentum import build_panel,run_account,rank_on,weights
from fundamentals import prepare_facts
from strategy import HERE,Config

NAMES={'basket_hold':'期初可交易股票等权持有','equal_monthly':'合格池每月等权','capped5':'选5只·每组最多2只',
       'unrestricted5':'选5只·不限分组','one_per_group':'每组各选1只','SPY':'SPY持有'}
PERIODS={'full':'完整区间','late':'2025年起','one_year':'最近一年','all18':'18只均具备行情历史后',
         'cost_stress':'全期成本压力','one_year_cost':'一年成本压力','delay_stress':'财务额外延迟一天'}

def select(rank,groups,rule):
    if rank.empty:return {}
    mapping={t:g for g,ts in groups.items() for t in ts}
    ordered=rank.assign(TickerKey=rank.index).sort_values(['Combined','TickerKey'],ascending=[False,True])
    picked=[];counts=Counter()
    limit=1 if rule=='one_per_group' else 2 if rule=='capped5' else 5
    for ticker in ordered.index:
        if counts[mapping[ticker]]>=limit:continue
        picked.append(ticker);counts[mapping[ticker]]+=1
        if len(picked)==5:break
    return {t:.2 for t in picked}

def table(stats):
    return pd.DataFrame([{'方案':NAMES[k],'累计净收益%':s['return_pct'],'年化收益%':s['annual_return_pct'],
      '最大回撤%':s['max_drawdown_pct'],'期末美元':s['terminal_equity'],'平均仓位%':s['mean_exposure_pct'],
      '利润多50%':'是' if s['profit_pass'] else '否','回撤减半':'是' if s['drawdown_pass'] else '否'} for k,s in stats.items()])

def run():
    out=HERE/'reports/industry18';protocol=json.loads((HERE/'industry18_protocol.json').read_text())
    snapshot=json.loads((out/'enriched_snapshot.json').read_text());assert snapshot['universe']==protocol['universe']
    groups=protocol['groups'];mapping={t:g for g,ts in groups.items() for t in ts}
    prices,frames,coverage=build_panel(snapshot);_,delayed,_=build_panel(snapshot,1)
    dates=prices['SPY'].index;assert str(dates[-1].date())==protocol['end']
    gaps=[]
    for ticker,f in frames.items():
        expected=f.PriceReady & (f.index>=pd.Timestamp(protocol['start']))
        bad=f.index[expected & ~f.Eligible]
        if len(bad):
            sub={'facts':[x for x in snapshot['facts'] if x['ticker']==ticker],
                 'filings':[x for x in snapshot['filings'] if x['ticker']==ticker]}
            flows,_=prepare_facts(sub,metrics=('revenue',),**snapshot.get('financial_metadata',{}).get(ticker,{}))
            # A genuinely stale filing is a rule-based exclusion, not a parser gap.
            # Every other missing feature stops the experiment for investigation.
            for day in bad:
                available=[x['_end'] for x in flows if x['_known']<day]
                if not available or (day-max(available)).days<=180:
                    raise ValueError(f'Unexplained financial gap: {ticker} {day}')
            gaps.append(dict(ticker=ticker,days=len(bad),first=str(bad[0].date()),last=str(bad[-1].date()),
                             reason='最新已披露财务超过180日，按原规则暂不入选',dates=[str(d.date()) for d in bad]))
        p=prices[ticker];period=dates[(dates>=max(p.index[0],pd.Timestamp(protocol['start'])))];assert p.loc[period[0]:].index.equals(period),ticker
    coverage.to_csv(out/'coverage.csv',index=False)
    for t,f in frames.items():f.to_csv(out/f'{t}_features.csv')
    (out/'coverage_gaps.json').write_text(json.dumps(gaps,indent=2))
    print(coverage.to_string(index=False),flush=True)
    if gaps:print('Verified stale-filing exclusions:',json.dumps(gaps,ensure_ascii=False),flush=True)
    # Buy-and-hold requires tradability, not a 12-month momentum warmup.
    passive={t:f.assign(PriceReady=prices[t].Close.reindex(dates).notna()) for t,f in frames.items()}
    cases=[('full','2023-01-03',Config(),frames),('late','2025-01-02',Config(),frames),
      ('one_year','2025-09-18',Config(),frames),('all18','2026-03-02',Config(),frames),
      ('cost_stress','2023-01-03',Config(fee_bps=10,slippage_bps=20),frames),
      ('one_year_cost','2025-09-18',Config(fee_bps=10,slippage_bps=20),frames),('delay_stress','2023-01-03',Config(),delayed)]
    results={};stored={};ranks=[];latest={};contributions=[]
    for period,start,config,panel in cases:
        folder=out/period;folder.mkdir(exist_ok=True);stats={};curves={}
        for key in NAMES:
            rule=key if key in ('basket_hold','equal_monthly','SPY') else 'quality_momentum'
            selector=(lambda rank:select(rank,groups,key)) if key in ('capped5','unrestricted5','one_per_group') else None
            s,c,trades,targets,holdings=run_account(prices,passive if key=='basket_hold' else panel,start,protocol['end'],
               rule,config,top_n=5,selection_controller=selector)
            if key not in ('basket_hold','SPY'):
                assert (pd.to_datetime(trades.date)>pd.to_datetime(trades.signal_date)).all()
            if selector:
                assert c.Holdings.max()<=5
                for row in targets.itertuples():
                    w=json.loads(row.target);counts=Counter(mapping[t] for t in w)
                    assert all(abs(v-.2)<1e-9 for v in w.values())
                    if key=='capped5':assert max(counts.values(),default=0)<=2
                    if key=='one_per_group':assert max(counts.values(),default=0)<=1
                    assert all(panel[t].loc[row.signal_date,'Eligible'] for t in w)
                    if period=='full' and key=='capped5':
                        r=rank_on(panel,pd.Timestamp(row.signal_date)).assign(SignalDate=row.signal_date)
                        r['Group']=[mapping[t] for t in r.index];r['Selected']=[t in w for t in r.index];ranks.append(r.reset_index())
            holdings['Group']=holdings.Ticker.map(mapping).fillna('大盘')
            gw=holdings.groupby(['Date','Group']).Weight.sum()
            s['max_single_weight_pct']=float(holdings.Weight.max()*100)
            s['max_group_weight_pct']=float(gw.max()*100)
            s['initial_holdings']=sorted(holdings.loc[holdings.Date==holdings.Date.min(),'Ticker'].tolist())
            hold=s if key=='basket_hold' else stats['basket_hold']
            s['profit_multiple']=s['return_pct']/hold['return_pct'] if hold['return_pct']>0 else None
            s['profit_pass']=bool(hold['return_pct']>0 and s['return_pct']>=1.5*hold['return_pct'])
            s['drawdown_pass']=bool(abs(s['max_drawdown_pct'])<=abs(hold['max_drawdown_pct'])/2)
            s['both_pass']=s['profit_pass'] and s['drawdown_pass']
            stats[key]=s;curves[key]=c
            c.to_csv(folder/f'{key}_daily.csv');trades.to_csv(folder/f'{key}_trades.csv',index=False)
            targets.to_csv(folder/f'{key}_targets.csv',index=False);holdings.to_csv(folder/f'{key}_holdings.csv',index=False)
            if period=='full':latest[key]=holdings.loc[holdings.Date==holdings.Date.max()].to_dict('records')
        # Independent passive terminal-value reconciliation.
        names=stats['basket_hold']['initial_holdings'];fee=config.fee_bps/10000;slip=config.slippage_bps/10000
        individual=[prices[t].loc[protocol['end'],'Close']/prices[t].loc[start,'Open']*(1-slip)*(1-fee)/((1+slip)*(1+fee))-1 for t in names]
        assert np.isclose(np.mean(individual)*100,stats['basket_hold']['return_pct'],atol=1e-7)
        if period in ('full','one_year'):
            contributions.extend(dict(period=period,ticker=t,return_pct=r*100,contribution_pct=r*100/len(names)) for t,r in zip(names,individual))
        results[period]=dict(start=start,end=protocol['end'],stats=stats);stored[period]=curves
        print(period,table(stats).to_string(index=False),sep='\n',flush=True)
    pd.concat(ranks,ignore_index=True).to_csv(out/'decision_rankings.csv',index=False)
    pd.DataFrame(contributions).to_csv(out/'passive_contributions.csv',index=False)
    result={'protocol':protocol,'coverage':coverage.to_dict('records'),'coverage_exclusions':gaps,'results':results,'latest_holdings':latest,
      'passive_contributions':contributions,
      'input_hashes':{p.name:sha256(p.read_bytes()).hexdigest() for p in [HERE/'industry18_protocol.json',out/'enriched_snapshot.json']},
      'code_hashes':{p.name:sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),HERE/'quality_momentum.py',HERE/'foreign_financials.py',HERE/'fundamentals.py']}}
    (out/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False));render(result,stored,out)

def render(result,curves,out):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    tables=''.join(f'<h2>{PERIODS[k]}：{r["start"]}—{r["end"]}</h2>'+table(r['stats']).to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}') for k,r in result['results'].items())
    graphs=[]
    for period in ('full','one_year'):
        fig=make_subplots(rows=2,cols=1,shared_xaxes=True,subplot_titles=['账户资产（美元，对数）','账户回撤%'])
        for key,c in curves[period].items():
            e=c.SettledEquity;fig.add_trace(go.Scatter(x=c.index,y=e,name=NAMES[key],legendgroup=key),row=1,col=1)
            fig.add_trace(go.Scatter(x=c.index,y=(e/e.cummax().clip(lower=100000)-1)*100,name=NAMES[key],legendgroup=key,showlegend=False),row=2,col=1)
        fig.update_yaxes(type='log',row=1,col=1);fig.update_layout(template='plotly_white',height=800,legend=dict(orientation='h',y=1.17),margin=dict(t=140),hovermode='x unified')
        graphs.append(f'<h2>{PERIODS[period]}曲线</h2>'+fig.to_html(full_html=False,include_plotlyjs=period=='full'))
    p=result['protocol'];notes=''.join(f'<p><b>{escape(k)}</b>：{escape(str(v))}</p>' for k,v in p.items())
    coverage=pd.DataFrame(result['coverage']).to_html(index=False,border=0)
    latest=pd.DataFrame(result['latest_holdings']['capped5'])[['Ticker','Group','Weight']].rename(columns={'Ticker':'股票','Group':'分组','Weight':'实际仓位'})
    attribution=pd.DataFrame(result['passive_contributions']).query('period=="one_year"').sort_values('contribution_pct',ascending=False)
    attribution=attribution[['ticker','return_pct','contribution_pct']].rename(columns={'ticker':'股票','return_pct':'个股净收益%','contribution_pct':'对持有组合收益贡献（百分点）'})
    links='<a href="full/capped5_trades.csv">主策略逐笔成交</a> · <a href="full/capped5_targets.csv">每月目标仓位</a> · <a href="decision_rankings.csv">历次评分</a> · <a href="summary.json">完整结果</a> · <a href="foreign_audit.json">季度财报来源核验</a>'
    (out/'report.html').write_text(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>18股产业链组合回测</title><style>body{{max-width:1350px;margin:30px auto;padding:0 20px;font:16px/1.7 system-ui;color:#172b4d}}table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{padding:9px;border-bottom:1px solid #dde3eb;text-align:right}}td:first-child,th:first-child{{text-align:left}}</style><h1>光通信、存储与半导体：18只候选股</h1>
<p>主规则：月末选5只，每组最多2只，调仓时各20%；质量与动量各50%。保留原评分，暂未引入新的行业指标或空仓条件。</p>
<p><strong>结论：全期主策略净收益1,035.69%，持有824.64%，利润多25.59%，未达多50%的目标。最大回撤37.98%，也未达到持有回撤37.90%的一半。最近一年主策略209.94%，落后于持有279.16%。</strong></p>
<p>基准在期初买入当时可交易股票：2023年及2025年初为17只，最近一年为18只；SNDK仅从2025-02-24开始取价，并到2026-02-25具备一年动量历史。月度等权对照随合格池变化，以检验新股加入带来的影响。</p>
<p>GFS在2023年及2024年春季合计32个交易日因最新已披露财报超过180天而暂不具备入选资格，保持原规则；详见 coverage_gaps.json。其余股票在行情预热完成后财务覆盖完整。</p>

{tables}

{''.join(graphs)}
<h2>最近一年：持有收益来源</h2><p>SNDK贡献约96.55个百分点，但主动策略须等待上市满253个交易日才有足够动量历史。因此最近一年对照同时受到新股资格与选股、调仓效果影响。全池月度等权199.03%提供另一参照，不能将落后全部归因于轮动无效。</p>
{attribution.to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')}
<h2>主策略期末实际持仓</h2>{latest.to_html(index=False,border=0,float_format=lambda v:f'{v:.2%}')}<h2>数据覆盖</h2>{coverage}<p>{links}</p>
<h2>方法与限制</h2>{notes}</html>''',encoding='utf-8')

if __name__=='__main__':run()
