"""Daily causal exposure controls layered on unchanged monthly stock selection."""
import json
from hashlib import sha256
from pathlib import Path

import numpy as np
import pandas as pd

from quality_momentum import build_panel, run_account
from strategy import Config,HERE

NAMES={'basket_hold':'同池等权持有','baseline':'原满仓质量＋动量','monthly':'原月度SPY减仓',
       'market':'每日SPY趋势减半','all_down':'全池20日下跌时空仓',
       'breadth':'股票池趋势分级仓位','combined':'股票池＋SPY联合风控（主规则）'}


def risk_inputs(prices,frames):
    calendar=prices['SPY'].index
    close=pd.DataFrame({t:prices[t].Close for t in frames}).reindex(calendar)
    ma=close.rolling(60,min_periods=60).mean()
    returns=close.pct_change(20,fill_method=None)
    ready=pd.DataFrame({t:f.PriceReady for t,f in frames.items()}).reindex(calendar).fillna(False).astype(bool)
    available=ready&ma.notna()&returns.notna()&close.notna()
    count=available.sum(axis=1)
    result=pd.DataFrame(index=calendar)
    result['Count']=count
    result['Breadth']=((close>ma)&available).sum(axis=1)/count.replace(0,np.nan)
    result['Negative20']=((returns<0)&available).sum(axis=1)
    result['AllDown']=(result.Negative20==count)&(count>=3)
    result['SPYClose']=prices['SPY'].Close
    result['SPYMA200']=result.SPYClose.rolling(200,min_periods=200).mean()
    result['MarketWeak']=result.SPYClose<result.SPYMA200
    return result


def exposure(row,rule):
    if row.Count<3 or not np.isfinite(row.Breadth) or not np.isfinite(row.SPYMA200):return 0.
    if rule=='market':return .5 if row.MarketWeak else 1.
    if rule=='all_down':return 0. if row.AllDown else 1.
    if rule=='breadth':return 1. if row.Breadth>=2/3 else (.5 if row.Breadth>=1/3 else 0.)
    if rule=='combined':
        if row.Breadth<1/3 and row.MarketWeak:return 0.
        return .5 if row.Breadth<.5 or row.MarketWeak else 1.
    raise ValueError('Unknown risk rule')


def local_windows(curve,baseline,selections):
    """Conditionally compare each lower-exposure window with the original account.

    Normalize both accounts at the preceding close. Each row starts anew, so these
    percentages must not be added as a whole-period or causal P&L decomposition.
    """
    commanded=1.;start=None;rows=[]
    filled=selections[selections.executes_in_window]
    for _,s in filled.iterrows():
        new=sum(json.loads(s.target).values());date=pd.Timestamp(s.next_fill_date)
        if new<1-1e-9 and commanded>=1-1e-9:start=date
        if new>=1-1e-9 and commanded<1-1e-9 and start is not None:
            j=curve.index.get_loc(start);anchor=j-1
            own_initial=curve.Equity.iloc[anchor] if anchor>=0 else 100000.
            base_initial=baseline.Equity.iloc[anchor] if anchor>=0 else 100000.
            a=curve.loc[date,'Equity']/own_initial-1;b=baseline.loc[date,'Equity']/base_initial-1
            rows.append(dict(reduce_date=str(start.date()),restore_date=str(date.date()),status='已恢复满仓',
                             controlled_return_pct=float(a*100),baseline_return_pct=float(b*100),local_excess_pp=float((a-b)*100)))
            start=None
        commanded=new
    if start is not None:rows.append(dict(reduce_date=str(start.date()),restore_date=None,status='期末未恢复满仓',controlled_return_pct=None,baseline_return_pct=None,local_excess_pp=None))
    return pd.DataFrame(rows,columns=['reduce_date','restore_date','status','controlled_return_pct','baseline_return_pct','local_excess_pp'])


def stats_table(stats):
    return pd.DataFrame([{'方案':NAMES[k],'收益%':s['return_pct'],'最大回撤%':s['max_drawdown_pct'],
                          '平均仓位%':s['mean_exposure_pct'],'交易日数':s['rebalance_dates'],
                          '收益和回撤均优于原满仓':'是' if s['dominates_baseline'] else '否',
                          '利润1.5倍且回撤减半':'是' if s['strict_pass'] else '否'} for k,s in stats.items()])


def run():
    output=HERE/'reports/portfolio_risk';output.mkdir(parents=True,exist_ok=True)
    inputs=[HERE/'portfolio_risk_protocol.json',HERE/'reports/quality_momentum/snapshot.json']
    protocol,snapshot=[json.loads(p.read_text()) for p in inputs]
    prices,frames,_=build_panel(snapshot);_,delayed,_=build_panel(snapshot,1)
    signals=risk_inputs(prices,frames)
    for rule in protocol['rules']:signals[rule]=signals.apply(lambda r:exposure(r,rule),axis=1)
    signals.to_csv(output/'risk_signals.csv')
    results={};stored={};windows={}
    cases=[('full','2023-01-03',Config(),frames),('late','2025-01-02',Config(),frames),
           ('one_year','2025-09-18',Config(),frames),('cost_stress','2023-01-03',Config(fee_bps=10,slippage_bps=20),frames),
           ('one_year_cost','2025-09-18',Config(fee_bps=10,slippage_bps=20),frames),('delay_stress','2023-01-03',Config(),delayed)]
    for section,start,config,panel in cases:
        folder=output/section;folder.mkdir(exist_ok=True);stats={};curves={};intervals={}
        for name in NAMES:
            rule={'basket_hold':'basket_hold','baseline':'quality_momentum','monthly':'qm_defensive'}.get(name,'quality_momentum')
            controller=(lambda day,key=name:signals.loc[day,key]) if name in protocol['rules'] else None
            stats[name],curves[name],trades,sel,holdings=run_account(prices,panel,start,'2026-09-18',rule,config,exposure_controller=controller)
            curves[name].to_csv(folder/f'{name}_daily.csv');trades.to_csv(folder/f'{name}_trades.csv',index=False)
            sel.to_csv(folder/f'{name}_targets.csv',index=False);holdings.to_csv(folder/f'{name}_holdings.csv',index=False)
            if name in protocol['rules']:
                intervals[name]=local_windows(curves[name],curves['baseline'],sel)
                intervals[name].to_csv(folder/f'{name}_risk_windows.csv',index=False)
        base=stats['baseline'];hold=stats['basket_hold']
        for s in stats.values():
            s['excess_baseline_pp']=s['return_pct']-base['return_pct']
            s['drawdown_reduction_pp']=abs(base['max_drawdown_pct'])-abs(s['max_drawdown_pct'])
            s['dominates_baseline']=bool(s['return_pct']>base['return_pct']+1e-8 and abs(s['max_drawdown_pct'])<abs(base['max_drawdown_pct'])-1e-8)
            s['strict_pass']=bool(hold['return_pct']>0 and s['return_pct']>=1.5*hold['return_pct'] and abs(s['max_drawdown_pct'])<=abs(hold['max_drawdown_pct'])/2)
        # Guard original behavior against silent regressions from adding the hook.
        previous=HERE/'reports/quality_momentum'/section/'quality_momentum_daily.csv'
        if previous.exists():
            old=pd.read_csv(previous,index_col='Date',parse_dates=True)
            if not np.allclose(old.SettledEquity,curves['baseline'].SettledEquity,rtol=1e-12,atol=1e-7):raise ValueError('Baseline changed')
        results[section]=dict(start=start,end='2026-09-18',stats=stats);stored[section]=curves;windows[section]=intervals
        print(section,stats_table(stats).to_string(index=False),sep='\n')
    result=dict(protocol=protocol,results=results,
                consistent_improvement={r:all(v['stats'][r]['dominates_baseline'] for v in results.values()) for r in protocol['rules']},
                strict_acceptance={r:all(v['stats'][r]['strict_pass'] for v in results.values()) for r in protocol['rules']},
                future_edge_verified=False,
                input_hashes={str(p.relative_to(HERE)):sha256(p.read_bytes()).hexdigest() for p in inputs},
                code_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),HERE/'quality_momentum.py',HERE/'fundamentals.py']})
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False))
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2))
    report(result,stored,windows,output)
    return result


def report(result,stored,windows,output):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    from html import escape
    graphs=[]
    for section,label in [('full','完整区间'),('one_year','最近一年')]:
        fig=make_subplots(rows=3,cols=1,shared_xaxes=True,subplot_titles=['账户价值','账户回撤%','股票实际占比%'])
        for name in ('baseline','market','all_down','breadth','combined'):
            c=stored[section][name];eq=c.SettledEquity
            for row,y in [(1,eq),(2,(eq/eq.cummax().clip(lower=100000)-1)*100),(3,c.Exposure*100)]:
                fig.add_trace(go.Scatter(x=c.index,y=y,name=NAMES[name],legendgroup=name,showlegend=row==1),row=row,col=1)
        fig.update_yaxes(type='log',row=1,col=1)
        fig.update_layout(height=1000,template='plotly_white',legend=dict(orientation='h',y=1.15),margin=dict(t=140),hovermode='x unified')
        graphs.append('<h2>'+label+'</h2>'+fig.to_html(full_html=False,include_plotlyjs=section=='full'))
    tables=''.join(f'<h2>{k}：{v["start"]} — {v["end"]}</h2>'+stats_table(v['stats']).to_html(index=False,border=0,float_format=lambda x:f'{x:,.2f}') for k,v in result['results'].items())
    audits=[]
    for rule in result['protocol']['rules']:
        ints=windows['full'][rule];done=ints[ints.status=='已恢复满仓']
        audits.append(f'<h3>{NAMES[rule]}</h3><p>已恢复满仓的区间{len(done)}个；局部效果正的{int((done.local_excess_pp>0).sum())}个。以下列出局部收益差最差的5段，完整记录另存。</p>'+done.sort_values('local_excess_pp').head(5).to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}'))
    notes=''.join(f'<p><b>{escape(k)}</b>：{escape(str(v))}</p>' for k,v in result['protocol'].items())
    path=output/'portfolio_risk_report.html'
    path.write_text(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>组合每日仓位控制</title><style>body{{max-width:1300px;margin:30px auto;padding:0 20px;font:16px/1.7 system-ui;color:#172b4d}}table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{padding:9px;border-bottom:1px solid #dde3eb;text-align:right}}td:first-child,th:first-child{{text-align:left}}</style>
<h1>质量＋动量选股：在普跌时减仓是否有效</h1><p>本轮保留月末三股选择，只增加每日收盘评估、次日开盘执行的仓位控制。目标可为0%、50%、100%，月内实际仓位漂移，信号变化时恢复所选股票等权。</p>{tables}{''.join(graphs)}
<h2>减仓与恢复区间诊断</h2><p>每段从减仓前一日收盘分别把风控账户和原满仓账户归一化，到恢复满仓当天收盘比较收益。两账户持股权重和历史状态可不同；这些是条件比较，不能相加或当成严格因果归因。</p>{''.join(audits)}<h2>协议与局限</h2>{notes}<p><a href="summary.json">完整统计</a> · <a href="risk_signals.csv">每日市场信号及目标仓位</a> · <a href="../quality_momentum/quality_momentum_report.html">原策略报告</a></p></html>''',encoding='utf-8')
    print('Report:',path)


if __name__=='__main__':run()
