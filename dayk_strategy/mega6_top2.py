"""User-requested holding-count comparisons on the same frozen data."""
import argparse
import json
from hashlib import sha256
from pathlib import Path
from html import escape
import numpy as np
import pandas as pd
from quality_momentum import build_panel,run_account
from portfolio_risk import risk_inputs,exposure
from strategy import Config,HERE

NAMES={'basket_hold':'六股等权持有','top3':'选3只满仓','top2':'选2只满仓','top1':'选1只满仓',
       'top3_cash':'选3只＋普跌空仓','top2_cash':'选2只＋普跌空仓','top1_cash':'选1只＋普跌空仓'}
PERIODS={'full':'完整区间','late':'2025年起','one_year':'最近一年','cost_stress':'全期高成本','one_year_cost':'最近一年高成本','delay_stress':'财务额外延迟一天'}

def run(holdings=2):
    if holdings not in (1,2):raise ValueError('Requested holding count must be 1 or 2')
    keys=[k for k in NAMES if holdings==1 or not k.startswith('top1')]
    source=HERE/'reports/mega6';out=source/f'top{holdings}';out.mkdir(exist_ok=True)
    snapshot=json.loads((source/'snapshot.json').read_text());previous=json.loads((source/'summary.json').read_text())
    assert sha256((source/'snapshot.json').read_bytes()).hexdigest()==previous['input_hashes']['snapshot.json']
    prices,frames,coverage=build_panel(snapshot);_,delayed,_=build_panel(snapshot,1)
    for t,f in frames.items():assert f.loc['2023-01-03':,'Eligible'].all(),t
    signals=risk_inputs(prices,frames).apply(lambda r:exposure(r,'all_down'),axis=1)
    cases=[('full','2023-01-03',Config(),frames),('late','2025-01-02',Config(),frames),
           ('one_year','2025-09-18',Config(),frames),('cost_stress','2023-01-03',Config(fee_bps=10,slippage_bps=20),frames),
           ('one_year_cost','2025-09-18',Config(fee_bps=10,slippage_bps=20),frames),('delay_stress','2023-01-03',Config(),delayed)]
    results={};stored={};monthly=[]
    for period,start,config,panel in cases:
        folder=out/period;folder.mkdir(exist_ok=True);stats={};curves={}
        for key in keys:
            count=int(key[3]) if key.startswith('top') else 3
            control=(lambda day:signals.loc[day]) if key.endswith('_cash') else None
            s,c,t,selections,h=run_account(prices,panel,start,snapshot['end'],
                'basket_hold' if key=='basket_hold' else 'quality_momentum',config,exposure_controller=control,top_n=count)
            if key in ('basket_hold','top3','top3_cash'):
                oldkey={'basket_hold':'basket_hold','top3':'baseline','top3_cash':'all_down'}[key]
                old=previous['results'][period]['stats'][oldkey]
                for metric in ('return_pct','max_drawdown_pct','terminal_equity'):
                    assert np.isclose(s[metric],old[metric],atol=1e-8,rtol=1e-12),(period,key,metric)
                oldcurve=pd.read_csv(source/period/f'{oldkey}_daily.csv',index_col=0,parse_dates=True)
                pd.testing.assert_frame_equal(c,oldcurve,check_freq=False,atol=1e-8,rtol=1e-12)
            if holdings==1 and key.startswith('top2'):
                oldcurve=pd.read_csv(source/'top2'/period/f'{key}_daily.csv',index_col=0,parse_dates=True)
                pd.testing.assert_frame_equal(c,oldcurve,check_freq=False,atol=1e-8,rtol=1e-12)
            if key!='basket_hold':
                assert c.Holdings.max()<=count
                assert (pd.to_datetime(t.date)>pd.to_datetime(t.signal_date)).all()
                for target in selections.target:
                    w=json.loads(target);assert not w or len(w)==count
                    assert not w or all(abs(v-1/count)<1e-10 for v in w.values())
            s['max_single_stock_weight_pct']=float(h.Weight.max()*100)
            s['profit_multiple']=s['return_pct']/stats['basket_hold']['return_pct'] if key!='basket_hold' else 1.
            s['profit_pass']=bool(s['profit_multiple']>=1.5)
            hold_dd=s['max_drawdown_pct'] if key=='basket_hold' else stats['basket_hold']['max_drawdown_pct']
            s['drawdown_pass']=bool(abs(s['max_drawdown_pct'])<=abs(hold_dd)/2)
            stats[key]=s;curves[key]=c
            c.to_csv(folder/f'{key}_daily.csv');t.to_csv(folder/f'{key}_trades.csv',index=False)
            selections.to_csv(folder/f'{key}_targets.csv',index=False);h.to_csv(folder/f'{key}_holdings.csv',index=False)
            if period=='full' and key==f'top{holdings}':
                monthly=selections.copy();monthly['选中股票']=monthly.target.map(lambda v:'、'.join(json.loads(v)))
        results[period]={'start':start,'end':snapshot['end'],'stats':stats};stored[period]=curves
        print(period,display(stats).to_string(index=False),sep='\n')
    protocol={**previous['protocol'],'rule':f'每月选择排名前{holdings}只，每只目标1/{holdings}；保留此前持仓数量作为对照。普跌条件仍检查六只股票。',
        'comparison':'固定样本的持仓数量敏感性分析；没有再搜索其他数量或参数。仓位在调仓时等权，月内随价格漂移。',
        'data_snapshot_sha256':previous['input_hashes']['snapshot.json']}
    result={'protocol':protocol,'results':results,'top3_reproduction_passed':True,'top2_reproduction_passed':holdings==1,
            'code_hashes':{p.name:sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),HERE/'quality_momentum.py',HERE/'portfolio_risk.py',HERE/'fundamentals.py']}}
    (out/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False))
    render(result,stored,monthly,out,holdings)

def display(stats):
    return pd.DataFrame([{'方案':NAMES[k],'累计净收益%':s['return_pct'],'最大回撤%':s['max_drawdown_pct'],
       '10万美元期末资产':s['terminal_equity'],'成交日数':s['rebalance_dates'],
       '历史最高单股占比%':s['max_single_stock_weight_pct'],
       '利润多50%':'是' if s['profit_pass'] else '否','回撤减半':'是' if s['drawdown_pass'] else '否'} for k,s in stats.items()])

def render(result,curves,monthly,out,holdings=2):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    tables=''.join(f'<h2>{PERIODS[k]}：{r["start"]}—{r["end"]}</h2>'+display(r['stats']).to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}') for k,r in result['results'].items())
    graphs=[]
    for period in ('full','one_year'):
        fig=make_subplots(rows=2,cols=1,shared_xaxes=True,subplot_titles=['账户资产（美元）','回撤%'])
        for key,c in curves[period].items():
            e=c.SettledEquity
            fig.add_trace(go.Scatter(x=c.index,y=e,name=NAMES[key],legendgroup=key),row=1,col=1)
            fig.add_trace(go.Scatter(x=c.index,y=(e/e.cummax().clip(lower=100000)-1)*100,name=NAMES[key],legendgroup=key,showlegend=False),row=2,col=1)
        fig.update_layout(template='plotly_white',height=750,legend=dict(orientation='h',y=1.15),margin=dict(t=130),hovermode='x unified')
        graphs.append(f'<h2>{PERIODS[period]}曲线</h2>'+fig.to_html(full_html=False,include_plotlyjs=period=='full'))
    notes=''.join(f'<p><b>{escape(k)}</b>：{escape(str(v))}</p>' for k,v in result['protocol'].items())
    picks=monthly[['signal_date','next_fill_date','选中股票']].rename(columns={'signal_date':'评分日','next_fill_date':'执行日'})
    (out/'report.html').write_text(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>六股选{holdings}只回测对照</title><style>body{{max-width:1300px;margin:30px auto;padding:0 20px;font:16px/1.7 system-ui;color:#172b4d}}table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{padding:9px;border-bottom:1px solid #dde3eb;text-align:right}}td:first-child,th:first-child{{text-align:left}}</style><h1>六股选{holdings}只：固定规则对照</h1><p>AAPL、GOOGL、AMZN、META、TSLA、NVDA。使用上一轮完全相同的数据快照；此前账户逐日净值已与上轮核对一致。选{holdings}只时每只目标{100/holdings:.0f}%，月内权重随价格变化。含手续费、滑点与期末清仓成本，不计税，现金无息。仅持有一只且排名未变时，月末保持持有，不强制卖出再买入。</p>{tables}{''.join(graphs)}<h2>选{holdings}只满仓：历次选择</h2>{picks.to_html(index=False,border=0)}<p><a href="full/top{holdings}_trades.csv">选{holdings}只逐笔成交</a> · <a href="full/top{holdings}_cash_trades.csv">选{holdings}只加空仓逐笔成交</a> · <a href="summary.json">完整数据</a></p><h2>计算口径</h2>{notes}</html>''',encoding='utf-8')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--holdings',type=int,choices=(1,2),default=2)
    run(parser.parse_args().holdings)
