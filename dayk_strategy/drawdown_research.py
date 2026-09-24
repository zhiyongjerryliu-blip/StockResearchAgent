"""Causal exposure overlays; benchmark terminal drawdown is evaluation-only."""
import json
from hashlib import sha256

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from dynamic_research import execute_target
from integrated_research import build_data
from one_year_analysis import liquidate
from recovery_research import RecoveryPolicy, decorate
from research import metrics, simulate
from strategy import Config, HERE

NAMES={'hold':'买入持有','baseline':'原全仓波段','reserve50':'初始半仓＋隔离现金',
       'target50':'每日恢复50%仓位','target25':'每日恢复25%仓位',
       'cushion4':'20%回撤预算·乘数4','cushion2':'20%回撤预算·乘数2'}


def risk_target(rule, equity, peak, active):
    if not active:
        return 0.
    if rule in ('target50','target25'):
        return .5 if rule=='target50' else .25
    if rule not in ('cushion4','cushion2'):
        raise ValueError('Unknown risk overlay')
    multiplier=4 if rule=='cushion4' else 2
    return min(1.,multiplier*max(0.,equity-.8*peak)/equity)


def overlay(data, base, rule, config):
    """The original strategy runs as a causal shadow signal generator.

    Daily rebalancing deliberately differs from the old change-only allocator.
    Original strategic exits remain exits; tiny rebalance sales are not swing exits.
    """
    cash,units,peak=config.initial_cash,0.,config.initial_cash
    pending=0.;rows=[];prior_equity=config.initial_cash;prior_close=None
    for day, b in base.iterrows():
        bar=data.loc[day];old_units=units
        cash,units,delta,price,fee=execute_target(cash,units,float(bar.Open),pending,config)
        equity=cash+units*bar.Close
        expected=old_units*(bar.Close-prior_close) if prior_close is not None else 0.
        if abs(delta)>1e-10:
            expected+=delta*(bar.Close-price)-fee
        if abs(equity-prior_equity-expected)>1e-6:
            raise ValueError('Daily accounting identity failed')
        peak=max(peak,equity)
        active=b.Units>0
        if b.Signal=='BUY':active=True
        elif b.Signal=='SELL':active=False
        target=risk_target(rule,equity,peak,active)
        rows.append(dict(Date=day,Equity=equity,Cash=cash,Units=units,Exposure=units*bar.Close/equity,
                         Fill='BUY' if delta>1e-10 else ('SELL' if delta<-1e-10 else ''),
                         FillPrice=price,DeltaUnits=delta,Fee=fee,FillTarget=pending,Target=target,
                         Peak=peak,Floor=.8*peak,Signal=b.Signal))
        pending=target;prior_equity=equity;prior_close=bar.Close
    return pd.DataFrame(rows).set_index('Date')


def reserved(base, config):
    c=base.copy()
    for column in ['Equity','Cash','Units','DeltaUnits','Fee']:
        c[column]*=.5
    c['Equity']+=.5*config.initial_cash
    c['Cash']+=.5*config.initial_cash
    c['Exposure']=(c.Equity-c.Cash)/c.Equity
    return c


def evaluate(data,start,end,config):
    frame=data.loc[:end]
    hold,_=simulate(frame,start,'hold',config)
    base,bt=simulate(frame,start,'baseline',config,policy=RecoveryPolicy('baseline'))
    base=decorate(frame,base,config)
    raw={'hold':decorate(frame,hold,config),'baseline':base,'reserve50':reserved(base,config)}
    for rule in ('target50','target25','cushion4','cushion2'):
        raw[rule]=overlay(frame,base,rule,config)
    curves={};stats={}
    for rule,c in raw.items():
        settled,exit_cost=liquidate(c,frame,config)
        # Expose only terminal-equity series as settled, keeping trade ledger mark-based.
        s=metrics(settled,pd.DataFrame(),config.initial_cash)
        s.pop('closed_trades')
        s.update(terminal_exit_cost=exit_cost,fees_before_terminal=float(c.Fee.sum()),
                 mean_exposure_pct=float(c.Exposure.mean()*100),max_exposure_pct=float(c.Exposure.max()*100),
                 executed_rebalances=int((c.Fill!='').sum()),min_cash=float(c.Cash.min()),
                 min_units=float(c.Units.min()))
        curves[rule]=c.assign(SettledEquity=settled.Equity)
        stats[rule]=s
    limit=abs(stats['hold']['max_drawdown_pct'])/2
    for rule,s in stats.items():
        s.update(drawdown_limit_pct=limit,drawdown_pass=bool(abs(s['max_drawdown_pct'])<=limit+1e-8),
                 profit_multiple=s['return_pct']/stats['hold']['return_pct'] if stats['hold']['return_pct']>0 else None,
                 profit_target_pass=bool(stats['hold']['return_pct']>0 and s['return_pct']>=1.5*stats['hold']['return_pct']))
        s['both_pass']=s['drawdown_pass'] and s['profit_target_pass']
    return stats,curves


def table(stats):
    return pd.DataFrame([{'规则':NAMES[k],'净收益%':s['return_pct'],'最大回撤%':s['max_drawdown_pct'],
                          '平均仓位%':s['mean_exposure_pct'],'利润/持有利润':s['profit_multiple'],
                          '回撤减半':'达标' if s['drawdown_pass'] else '未达标',
                          '收益与回撤同时达标':'是' if s['both_pass'] else '否'} for k,s in stats.items()])


def run():
    out=HERE/'reports/drawdown';out.mkdir(parents=True,exist_ok=True)
    paths=[HERE/'drawdown_protocol.json',HERE/'reports/integrated/stockresearch_snapshot.json',HERE/'reports/integrated/stockresearch_flow.json']
    protocol,snapshot,flow=[json.loads(p.read_text()) for p in paths]
    data=build_data(snapshot,flow)
    cases=[('full','2023-01-03','2026-09-18',Config()),
           ('year2024','2023-09-18','2024-09-18',Config()),
           ('year2025','2024-09-18','2025-09-18',Config()),
           ('year2026','2025-09-18','2026-09-18',Config()),
           ('full_cost','2023-01-03','2026-09-18',Config(fee_bps=10,slippage_bps=20)),
           ('year2026_cost','2025-09-18','2026-09-18',Config(fee_bps=10,slippage_bps=20))]
    results={};all_curves={};sections=[]
    for key,start,end,config in cases:
        stats,curves=evaluate(data,start,end,config)
        results[key]=dict(start=start,end=end,stats=stats);all_curves[key]=curves
        folder=out/key;folder.mkdir(exist_ok=True)
        for rule,c in curves.items():c.to_csv(folder/f'{rule}_daily.csv')
        sections.append(f'<h2>{key}：{start} — {end}</h2><p>最大回撤允许幅度：{stats["hold"]["drawdown_limit_pct"]:.2f}%。</p>'+table(stats).to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}'))
        print(key,table(stats).to_string(index=False),sep='\n')
    summary=dict(protocol=protocol,results=results,
                 all_cases_drawdown_pass={r:all(results[k]['stats'][r]['drawdown_pass'] for k in results) for r in NAMES if r not in ('hold','baseline')},
                 any_both_pass=any(v['both_pass'] for s in results.values() for k,v in s['stats'].items() if k!='hold'),
                 input_hashes={str(p.relative_to(HERE)):sha256(p.read_bytes()).hexdigest() for p in paths},
                 code_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in [HERE/'drawdown_research.py',HERE/'dynamic_research.py',HERE/'recovery_research.py',HERE/'research.py']})
    (out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2,allow_nan=False))
    (out/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2))
    fig=make_subplots(rows=3,cols=1,shared_xaxes=True,subplot_titles=['最近一年账户价值','自净值高点回撤','收盘实际股票仓位'])
    for rule in ('hold','baseline','target50','target25','cushion4','cushion2'):
        c=all_curves['year2026'][rule];eq=c.SettledEquity
        for row,values in [(1,eq),(2,(eq/eq.cummax().clip(lower=100000)-1)*100),(3,c.Exposure*100)]:
            fig.add_trace(go.Scatter(x=c.index,y=values,name=NAMES[rule],legendgroup=rule,showlegend=row==1),row=row,col=1)
    fig.add_hline(y=-results['year2026']['stats']['hold']['drawdown_limit_pct'],row=2,col=1,line_dash='dot')
    fig.update_layout(height=1000,template='plotly_white',legend=dict(orientation='h'),margin=dict(t=100))
    graph=fig.to_html(full_html=False,include_plotlyjs=True)
    notes=''.join(f'<p><b>{k}</b>：{v}</p>' for k,v in protocol.items() if k not in ('rules','windows'))
    rules=''.join(f'<p><b>{NAMES[k]}</b>：{v}</p>' for k,v in protocol['rules'].items())
    html=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LITE 回撤减半研究</title>
<style>body{{max-width:1240px;margin:30px auto;padding:0 22px;font:16px/1.7 system-ui;color:#172b4d}}table{{border-collapse:collapse;width:100%;font-size:14px}}td,th{{padding:10px;border-bottom:1px solid #dde3eb;text-align:right}}td:first-child,th:first-child{{text-align:left}}</style>
<h1>LITE：最大回撤减半后，收益会怎样</h1><p>回撤取账户每日收盘净值相对此前高点的跌幅，包含初始资金和期末清仓成本；不代表盘中最大亏损。基准和策略使用相同资金及区间。</p>
<p>固定几种仓位规则作比较，没有把最终回撤直接截断，也没有把未来基准回撤用于交易。原来利润至少多50%的目标继续保留，单独显示验收。</p>
{graph}{''.join(sections)}<h2>规则</h2>{rules}<h2>口径与限制</h2>{notes}
<p>再平衡的小额买卖不是完整波段，不用成交笔数证明择时优势。强制留现金属于降低风险暴露，不等于预测下跌。初始资金减半后若盈利继续留在股票账户，实际股票占比会上升，因此回撤未必减半。</p>
<p>次日开盘执行可能越过预算。<a href="https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-15">SEC：止损触发价不保证成交价</a>。<a href="summary.json">完整统计与哈希</a></p></html>'''
    (out/'LITE_drawdown_report.html').write_text(html,encoding='utf-8')
    print('All cases:',summary['all_cases_drawdown_pass'],'Any both pass:',summary['any_both_pass'])
    return summary


if __name__=='__main__':
    run()
