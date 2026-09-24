"""Apply the frozen quality/momentum and all-down rules to a user-specified pool."""
import json
from hashlib import sha256
from pathlib import Path

import numpy as np
import pandas as pd

from portfolio_risk import risk_inputs, exposure, local_windows
from quality_momentum import build_panel, run_account, rank_on
from strategy import Config,HERE

NAMES={'basket_hold':'六股等权买入持有','baseline':'质量＋动量满仓','all_down':'质量＋动量＋普跌空仓','SPY':'SPY买入持有'}


def individual(prices,start,end,config):
    rows=[]
    for t,p in prices.items():
        b=p.loc[start:end]
        if str(b.index[0].date())!=start or str(b.index[-1].date())!=end:raise ValueError('Incomplete individual price range')
        fee=config.fee_bps/10000;slip=config.slippage_bps/10000
        units=config.initial_cash/(float(b.Open.iloc[0])*(1+slip)*(1+fee))
        equity=units*b.Close;equity.iloc[-1]*=(1-slip)*(1-fee)
        rows.append(dict(ticker=t,return_pct=float((equity.iloc[-1]/config.initial_cash-1)*100),
                         max_drawdown_pct=float((equity/equity.cummax().clip(lower=config.initial_cash)-1).min()*100),
                         terminal_equity=float(equity.iloc[-1]),start=start,end=end))
    return rows


def table(stats):
    return pd.DataFrame([{'方案':NAMES[k],'净收益%':s['return_pct'],'最大回撤%':s['max_drawdown_pct'],
                          '期末资产美元':s['terminal_equity'],'平均仓位%':s['mean_exposure_pct'],
                          '成交日数':s['rebalance_dates'],'利润至少多50%':'是' if s['profit_pass'] else '否',
                          '回撤至多一半':'是' if s['drawdown_pass'] else '否'} for k,s in stats.items()])


def run():
    output=HERE/'reports/mega6';output.mkdir(parents=True,exist_ok=True)
    files=[HERE/'mega6_protocol.json',output/'snapshot.json']
    protocol,snapshot=[json.loads(p.read_text()) for p in files]
    if snapshot['universe']!=protocol['universe']:raise ValueError('Wrong universe')
    prices,frames,coverage=build_panel(snapshot);_,delayed,_=build_panel(snapshot,1)
    calendar=prices['SPY'].index
    if str(calendar[-1].date())!=protocol['end']:raise ValueError('End date not available')
    for t,p in prices.items():
        if not p.loc['2023-01-03':].index.equals(calendar[calendar>=pd.Timestamp('2023-01-03')]):raise ValueError('Missing trading dates: '+t)
    for t,f in frames.items():
        if not f.loc['2023-01-03':,'Eligible'].all():raise ValueError('Incomplete six-stock financial coverage: '+t)
    coverage.to_csv(output/'coverage.csv',index=False)
    for ticker,frame in frames.items():frame.to_csv(output/f'{ticker}_features.csv')
    signals=risk_inputs(prices,frames);signals['TargetExposure']=signals.apply(lambda r:exposure(r,'all_down'),axis=1)
    signals.to_csv(output/'risk_signals.csv')
    cases=[('full','2023-01-03',Config(),frames),('late','2025-01-02',Config(),frames),
           ('one_year','2025-09-18',Config(),frames),('cost_stress','2023-01-03',Config(fee_bps=10,slippage_bps=20),frames),
           ('one_year_cost','2025-09-18',Config(fee_bps=10,slippage_bps=20),frames),('delay_stress','2023-01-03',Config(),delayed)]
    results={};stored={};risk_windows={}
    for section,start,config,panel in cases:
        stats={};curves={};folder=output/section;folder.mkdir(exist_ok=True)
        for key in NAMES:
            rule=key if key in ('basket_hold','SPY') else 'quality_momentum'
            control=(lambda day:signals.loc[day,'TargetExposure']) if key=='all_down' else None
            stats[key],curves[key],trades,sel,holdings=run_account(prices,panel,start,protocol['end'],rule,config,exposure_controller=control)
            curves[key].to_csv(folder/f'{key}_daily.csv');trades.to_csv(folder/f'{key}_trades.csv',index=False)
            sel.to_csv(folder/f'{key}_targets.csv',index=False);holdings.to_csv(folder/f'{key}_holdings.csv',index=False)
            if key=='all_down':
                risk_windows[section]=local_windows(curves[key],curves['baseline'],sel)
                risk_windows[section].to_csv(folder/'risk_windows.csv',index=False)
        hold=stats['basket_hold'];base=stats['baseline']
        for key,s in stats.items():
            s['profit_multiple']=s['return_pct']/hold['return_pct'] if hold['return_pct']>0 else None
            s['profit_pass']=bool(hold['return_pct']>0 and s['return_pct']>=1.5*hold['return_pct'])
            s['drawdown_pass']=bool(abs(s['max_drawdown_pct'])<=abs(hold['max_drawdown_pct'])/2)
            s['both_pass']=s['profit_pass'] and s['drawdown_pass']
            s['excess_full_exposure_pp']=s['return_pct']-base['return_pct']
            s['dominates_full_exposure']=bool(s['return_pct']>base['return_pct'] and abs(s['max_drawdown_pct'])<abs(base['max_drawdown_pct']))
        stocks=individual(prices,start,protocol['end'],config)
        expected=np.mean([s['return_pct'] for s in stocks if s['ticker']!='SPY'])
        if not np.isclose(expected,hold['return_pct'],atol=1e-7):raise ValueError('Equal-weight benchmark does not reconcile')
        results[section]=dict(start=start,end=protocol['end'],stats=stats,individual=stocks)
        stored[section]=curves
        print(section,table(stats).to_string(index=False),sep='\n')
    latest=rank_on(frames,calendar[-1]);latest.to_csv(output/'latest_rankings.csv')
    ranks=[]
    for day in stored['full']['baseline'].index:
        loc=calendar.get_loc(day)
        if day==stored['full']['baseline'].index[0] or (loc+1<len(calendar) and calendar[loc+1].month!=day.month):
            r=rank_on(frames,day)
            if len(r):ranks.append(r.assign(SignalDate=str(day.date())).reset_index())
    if ranks:pd.concat(ranks,ignore_index=True).to_csv(output/'decision_rankings.csv',index=False)
    result=dict(protocol=protocol,coverage=coverage.to_dict('records'),results=results,
                future_edge_verified=False,strict_acceptance=all(v['stats']['all_down']['both_pass'] for v in results.values()),
                input_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in files},
                code_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),HERE/'quality_momentum.py',HERE/'portfolio_risk.py',HERE/'fundamentals.py',HERE/'fetch_quality_universe.mjs',HERE/'amazon_balance.mjs']})
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False))
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2))
    report(result,stored,risk_windows,latest,output)
    print('Coverage:',coverage.to_string(index=False))
    return result


def report(result,stored,risk_windows,latest,output):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    from html import escape
    graphs=[]
    for key in ('full','one_year'):
        fig=make_subplots(rows=3,cols=1,shared_xaxes=True,subplot_titles=['账户价值','账户回撤%','股票实际占比%'])
        for rule,c in stored[key].items():
            eq=c.SettledEquity
            for row,y in [(1,eq),(2,(eq/eq.cummax().clip(lower=100000)-1)*100),(3,c.Exposure*100)]:
                fig.add_trace(go.Scatter(x=c.index,y=y,name=NAMES[rule],legendgroup=rule,showlegend=row==1),row=row,col=1)
        fig.update_layout(height=1000,template='plotly_white',legend=dict(orientation='h',y=1.13),margin=dict(t=130),hovermode='x unified')
        graphs.append('<h2>'+('完整区间' if key=='full' else '最近一年')+'</h2>'+fig.to_html(full_html=False,include_plotlyjs=key=='full'))
    tables=''.join(f'<h2>{key}：{r["start"]} — {r["end"]}</h2>'+table(r['stats']).to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}') for key,r in result['results'].items())
    single=pd.DataFrame(result['results']['full']['individual']).rename(columns={'ticker':'股票','return_pct':'净收益%','max_drawdown_pct':'最大回撤%','terminal_equity':'10万美元期末资产','start':'起始日','end':'结束日'})
    ranking=latest[['NetMarginTTM','OCFMarginTTM','BalanceSafety','Momentum','QualityRank','MomentumRank','Combined']].sort_values('Combined',ascending=False)
    coverage=pd.DataFrame(result['coverage'])
    notes=''.join(f'<p><b>{escape(k)}</b>：{escape(str(v))}</p>' for k,v in result['protocol'].items())
    windows=risk_windows['full'].to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')
    (output/'mega6_report.html').write_text(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>六只大型美股：原策略迁移检验</title><style>body{{max-width:1300px;margin:30px auto;padding:0 20px;font:16px/1.7 system-ui;color:#172b4d}}table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{padding:9px;border-bottom:1px solid #dde3eb;text-align:right}}td:first-child,th:first-child{{text-align:left}}</style>
<h1>AAPL · GOOGL · AMZN · META · TSLA · NVDA</h1><p>更换股票池，保留原规则：质量与动量各占50%，月末选前三只等权；另测试全池20日涨幅为负时次日空仓，条件解除后次日买回。没有看新股票收益再调参数。</p>
{tables}<h2>六股单独持有与SPY</h2>{single.to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')}{''.join(graphs)}<h2>减仓与恢复区间</h2><p>局部比较从减仓前一日收盘归一化，到恢复满仓当天收盘；各段百分比不能相加，不是因果收益归因。</p>{windows}<h2>数据覆盖</h2>{coverage.to_html(index=False,border=0)}<h2>样本末日排名（不是当日下单指令）</h2>{ranking.to_html(border=0,float_format=lambda v:f'{v:.4f}')}<h2>方法</h2>{notes}<p>逐日净值、目标仓位、持仓和交易金额均另存；包含原始数据缓存、披露时间及来源键。未修改应用数据库或发送交易指令。<a href="summary.json">完整结果</a> · <a href="decision_rankings.csv">历次排名</a> · <a href="full/all_down_trades.csv">全期逐笔成交</a></p></html>''',encoding='utf-8')


if __name__=='__main__':run()
