"""Core/tactical sizing with a strict 1.5x net-profit target and cash audit."""
from __future__ import annotations

import argparse
from hashlib import sha256
from html import escape
import json
from math import log10
from pathlib import Path

import pandas as pd

from cycle_research import add_peers
from fundamental_strategy import enriched
from research import metrics,simulate
from strategy import Config,HERE,validate_bars
from swing_research import SwingPolicy,matched_hold,rebuy_ledger,swing_features

LABELS={'reversal':'原回落退出','range_break':'跌破前日低点','range_volume':'破低＋量能确认'}
WEIGHTS=(0.,.25,.5,.75,1.)


def features(data):
    result=swing_features(data)
    result['PriorLow']=result.Low.shift(1)
    result['PriorVolume20']=result.Volume.shift(1).rolling(20).mean()
    return result


class ConfirmedPolicy(SwingPolicy):
    def __call__(self,row,rule,holding,stop):
        if rule not in LABELS:raise ValueError('未知退出规则')
        checked=row.copy()
        if holding and rule!='reversal':
            confirmed=row.Close<row.PriorLow
            if rule=='range_volume':confirmed=confirmed and row.Volume>row.PriorVolume20
            checked['PriorOverheat']=bool(row.PriorOverheat and confirmed)
        return super().__call__(checked,'swing_reversal',holding,stop)


def blend(data,core,tactical,weight,config):
    if not 0<=weight<=1:raise ValueError('波段仓比例必须在0到1之间')
    if not core.index.equals(tactical.index):raise ValueError('底仓与波段账户日期不一致')
    curve=tactical.copy()
    curve['Equity']=(1-weight)*core.Equity+weight*tactical.Equity
    curve['Units']=(1-weight)*core.Units+weight*tactical.Units
    curve['Cash']=curve.Equity-curve.Units*data.loc[curve.index,'Close']
    curve['Exposure']=curve.Units*data.loc[curve.index,'Close']/curve.Equity
    curve['CoreEquity']=(1-weight)*core.Equity
    curve['TacticalEquity']=weight*tactical.Equity
    curve['DeltaUnits']=curve.Units.diff().fillna(curve.Units.iloc[0])
    curve['Action']=''
    curve.loc[curve.DeltaUnits>1e-10,'Action']='加仓'
    curve.loc[curve.DeltaUnits<-1e-10,'Action']='减仓'
    curve['Fee']=0.
    traded=curve.DeltaUnits.abs()>1e-10
    fill=data.loc[curve.index,'Open']*(1+config.slippage_bps/10000*curve.DeltaUnits.apply(lambda v:1 if v>0 else -1))
    curve.loc[traded,'Fee']=curve.loc[traded,'DeltaUnits'].abs()*fill.loc[traded]*config.fee_bps/10000
    curve['TradePrice']=fill.where(traded)
    if curve.Cash.min()<-1e-6 or curve.Exposure.max()>1+1e-10 or curve.Units.min()<-1e-10:
        raise ValueError('仓位或现金越界')
    # Funded subaccounts are linear in initial cash; no extra deposits or leverage.
    equity_before=curve.Equity.shift(1).fillna(config.initial_cash)
    prior_units=curve.Units.shift(1).fillna(0)
    market_pnl=prior_units*(data.loc[curve.index,'Close']-data.loc[curve.index,'Close'].shift(1))
    market_pnl.iloc[0]=0
    trading_pnl=curve.DeltaUnits*(data.loc[curve.index,'Close']-fill)-curve.Fee
    if ((curve.Equity-equity_before)-(market_pnl+trading_pnl)).abs().max()>1e-6:
        raise ValueError('组合现金与每日损益不守恒')
    if weight==0:
        for col in ['Rule','Signal','Reason','Fill','FillPrice','Stop']:curve[col]=core[col]
    return curve


def target_check(strategy_return,hold_return):
    if hold_return<=0:return dict(target_return_pct=None,profit_multiple=None,target_pass=False)
    return dict(target_return_pct=1.5*hold_return,profit_multiple=strategy_return/hold_return,
                target_pass=bool(strategy_return>=1.5*hold_return-1e-8))


def compare(data,start,config):
    tactical,trades={},{}
    for rule in LABELS:
        tactical[rule],trades[rule]=simulate(data,start,rule,config,policy=ConfirmedPolicy())
    first=[c.index[c.Fill=='BUY'][0] if (c.Fill=='BUY').any() else None for c in tactical.values()]
    if len(set(first))!=1:raise ValueError('首次买入不一致')
    core=matched_hold(data,tactical['reversal'],config)
    hold,hold_trades=simulate(data,start,'hold',config)
    hold_stats=metrics(hold,hold_trades,config.initial_cash)
    core_stats=metrics(core,pd.DataFrame(),config.initial_cash)
    rows,curves,ledgers=[],{'core':core,'hold':hold},{}
    for rule in LABELS:
        ledger=rebuy_ledger(tactical[rule],config);ledgers[rule]=ledger
        done=ledger[ledger.status=='完成回补']
        durations=[tactical[rule].index.get_loc(pd.Timestamp(t.exit_date))-tactical[rule].index.get_loc(pd.Timestamp(t.entry_date)) for _,t in trades[rule].iterrows()]
        median=float(pd.Series(durations,dtype=float).median()) if durations else None
        for weight in WEIGHTS:
            key=f'{rule}_{int(weight*100)}'
            curve=blend(data,core,tactical[rule],weight,config);curves[key]=curve
            stats=metrics(curve,trades[rule] if weight else pd.DataFrame(),config.initial_cash)
            target=target_check(stats['return_pct'],hold_stats['return_pct'])
            rows.append(dict(rule=rule,tactical_weight=weight,**stats,**target,
                             excess_aligned_pp=stats['return_pct']-core_stats['return_pct'],
                             completed_rebuys=len(done) if weight else 0,positive_rebuys=int((done.unit_multiplier>1).sum()) if weight else 0,
                             median_tactical_hold_sessions=median if weight else None,
                             min_exposure_pct=float(curve.Exposure.min()*100),max_exposure_pct=float(curve.Exposure.max()*100),
                             min_cash=float(curve.Cash.min()),total_fees=float(curve.Fee.sum())))
    return dict(hold=hold_stats,aligned_hold=core_stats,candidates=rows),curves,ledgers


def acceptance(sections,rule,weight):
    checks={}
    for section,values in sections.items():
        row=next(r for r in values['candidates'] if r['rule']==rule and r['tactical_weight']==weight)
        checks[section]=bool(row['target_pass'] and row['excess_aligned_pp']>1e-8 and row['completed_rebuys']>=3
                             and row['median_tactical_hold_sessions'] is not None and row['median_tactical_hold_sessions']<=21)
    return dict(checks=checks,historical_pass=all(checks.values()),future_edge_verified=False)


def report(data,curves,result,protocol,output):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    primary=f"{protocol['primary_rule']}_{int(protocol['primary_tactical_weight']*100)}"
    view=data.loc[curves[primary].index];x=view.index.strftime('%Y-%m-%d').tolist()
    fig=make_subplots(rows=3,cols=1,shared_xaxes=True,row_heights=[.45,.2,.35],vertical_spacing=.07,
                      subplot_titles=['日K加减仓点（可切换组合）','实际股票仓位（市值/净资产）','净值与利润门槛（对数）'])
    fig.add_trace(go.Candlestick(x=x,open=view.Open.tolist(),high=view.High.tolist(),low=view.Low.tolist(),close=view.Close.tolist(),name='LITE日K'),row=1,col=1)
    for key,label in [('core','同买点持有'),('hold','期初持有')]:
        fig.add_trace(go.Scatter(x=x,y=(curves[key].Equity/100000).tolist(),name=label),row=3,col=1)
    groups=[]
    for rule in LABELS:
        for weight in WEIGHTS:
            key=f'{rule}_{int(weight*100)}';c=curves[key];indices=[]
            label=f'{LABELS[rule]} · 波段{weight:.0%}'
            for action,color,symbol in [('加仓','#168774','triangle-up'),('减仓','#cf4562','triangle-down')]:
                part=c[c.Action==action];indices.append(len(fig.data))
                fig.add_trace(go.Scatter(x=part.index.strftime('%Y-%m-%d').tolist(),y=part.TradePrice.tolist(),mode='markers',name=action,
                                        visible=key==primary,marker=dict(color=color,size=10,symbol=symbol),
                                        text=(part.Exposure*100).round(2).astype(str)+'% 收盘仓位',
                                        hovertemplate='%{x}<br>成交价 %{y:.2f}<br>%{text}<extra></extra>'),row=1,col=1)
            indices.append(len(fig.data))
            fig.add_trace(go.Scatter(x=x,y=(c.Exposure*100).tolist(),name='实际仓位 %',visible=key==primary,line=dict(shape='hv',color='#3988ae')),row=2,col=1)
            indices.append(len(fig.data))
            fig.add_trace(go.Scatter(x=x,y=(c.Equity/100000).tolist(),name=label,visible=key==primary,line=dict(color='#168774')),row=3,col=1)
            groups.append((key,label,indices))
    buttons=[dict(label=label,method='update',args=[dict(visible=[i<3 or i in indices for i in range(len(fig.data))])]) for key,label,indices in groups]
    fig.update_layout(updatemenus=[dict(buttons=buttons,active=next(i for i,g in enumerate(groups) if g[0]==primary),x=0,y=1.08,xanchor='left',yanchor='bottom')])
    target=result['full']['hold']['return_pct']*1.5
    fig.add_hline(y=1+target/100,row=3,col=1,line_dash='dot',line_color='#b87720')
    fig.add_annotation(x=.01,y=log10(1+target/100),xref='paper',yref='y3',text='期末利润目标',showarrow=False,yshift=12,xanchor='left')
    fig.update_yaxes(type='log',row=3,col=1,tickmode='array',tickvals=[.5,1,2,5,10,20,30,50],ticktext=['0.5','1','2','5','10','20','30','50'])
    fig.update_yaxes(range=[0,105],row=2,col=1)
    fig.update_xaxes(rangeslider_visible=False,rangebreaks=[dict(bounds=['sat','mon'])])
    fig.update_layout(height=1050,template='plotly_white',legend=dict(orientation='h',y=1.18),margin=dict(t=190,l=50,r=25,b=40),hovermode='x unified')
    def table(section):
        rows=[]
        for r in result[section]['candidates']:
            rows.append({'退出规则':LABELS[r['rule']],'初始波段仓 %':r['tactical_weight']*100,'净收益 %':r['return_pct'],
                         '相对持有利润倍数':r['profit_multiple'],'最大回撤 %':r['max_drawdown_pct'],
                         '完整回补':r['completed_rebuys'],'利润门槛':'通过' if r['target_pass'] else '未通过'})
        return pd.DataFrame(rows).to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')
    main=next(r for r in result['full']['candidates'] if r['rule']==protocol['primary_rule'] and r['tactical_weight']==protocol['primary_tactical_weight'])
    graph=fig.to_html(full_html=False,include_plotlyjs=True,config={'responsive':True,'displaylogo':False})
    rules=''.join(f'<p><b>{LABELS[n]}</b>：{escape(t)}。</p>' for n,t in protocol['rules'].items())
    html=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LITE 分仓与50%超额门槛</title><style>
body{{margin:0;background:#f2f5f8;color:#24384d;font:15px/1.75 -apple-system,"PingFang SC",sans-serif}}main{{max-width:1320px;margin:32px auto;padding:0 22px}}section{{background:white;border:1px solid #dfe6ed;border-radius:12px;padding:24px;margin:20px 0;overflow:auto}}h1{{font-size:30px}}h2{{font-size:20px}}table{{width:100%;border-collapse:collapse;font-size:13px}}td,th{{text-align:left;padding:10px;border-bottom:1px solid #e5eaf0}}.muted{{color:#637990}}a{{color:#246dba}}</style></head><body><main>
<div class="muted">第六轮 · 底仓与波段仓 · 利润至少增加50%</div><h1>LITE · 仓位控制与收益门槛</h1><p>{result['start']} — {result['end']} · {escape(protocol['status'])}</p>
<section><h2>目标净收益至少 {target:,.2f}%</h2><p>期初持有净收益 {result['full']['hold']['return_pct']:,.2f}%；按相同本金下净利润×1.5计算。这里不是多50个百分点，也不是最终财富增加50%。</p>
<p>预先固定的主假设：50%初始资金底仓＋50%波段仓，采用破低与量能确认。净收益 {main['return_pct']:,.2f}%，持有利润的{main['profit_multiple']:.3f}倍，最大回撤 {main['max_drawdown_pct']:.2f}%。</p>
<p>历史综合验收：{'通过' if result['acceptance']['historical_pass'] else '未通过'}。全程不加杠杆、现金非负，总股票仓位不超过100%；这不保证单只股票的投资风险适合任何具体账户。</p></section>
<section>{graph}</section><section><h2>全期：全部规则与仓位</h2>{table('full')}<p>初始波段仓0%为同买点持有边界，100%为全仓波段边界。0%不是有效波段候选。</p></section>
<section><h2>2025年起独立账户</h2><p>本段持有净收益 {result['late']['hold']['return_pct']:.2f}%，门槛 {result['late']['hold']['return_pct']*1.5:.2f}%。</p>{table('late')}</section>
<section><h2>成本压力：单边手续费10bps＋滑点20bps</h2>{table('cost_stress')}<h2>财务额外延迟一个交易日</h2>{table('delay_stress')}</section>
<section><h2>仓位模型能做到什么</h2><p>{escape(protocol['allocation'])}</p><p>{escape(protocol['limits'])}</p><p>{escape(protocol['feasibility'])}</p><p>对于上一轮信号，只改变固定初始分仓比例的历史收益上界为 {result['existing_signal_bound_pct']:.2f}%，低于新目标；调配比本身无法补足这一差距。</p></section>
<section><h2>固定规则</h2>{rules}<p>{escape(protocol['other_logic'])}</p><p>{escape(protocol['validation'])}</p><p>底仓始终持有；财务失效只影响波段账户，所以仍有长期单股下跌风险。采用原复权价格、历史财务版本及同业快照；未另加资金、现金利息或股息。</p><p><a href="summary.json">完整统计与输入哈希</a> · <a href="protocol.json">固定协议</a> · <a href="../swing/LITE_swing_report.html">上一轮完整波段</a></p></section></main></body></html>'''
    path=output/'LITE_position_report.html';path.write_text(html,encoding='utf-8');return path


def run(output):
    output.mkdir(parents=True,exist_ok=True)
    files=[HERE/'position_protocol.json',HERE/'reports/fundamental/financial_snapshot.json',HERE/'reports/fundamental/price_snapshot.csv',HERE/'reports/cycle/peer_snapshot.json']
    protocol,snapshot,peers=[json.loads(files[i].read_text()) for i in [0,1,3]]
    bars=validate_bars(pd.read_csv(files[2],index_col='Date'))
    base,_=enriched(bars,snapshot);data=features(add_peers(base,peers))
    full,curves,ledgers=compare(data,protocol['full_start'],Config())
    late,_,_=compare(data,protocol['late_start'],Config())
    stress,_,_=compare(data,protocol['full_start'],Config(fee_bps=10,slippage_bps=20))
    delayed,_=enriched(bars,snapshot,1)
    delay,_,_=compare(features(add_peers(delayed,peers)),protocol['full_start'],Config())
    result=dict(full=full,late=late,cost_stress=stress,delay_stress=delay,
                start=str(curves['hold'].index[0].date()),end=str(curves['hold'].index[-1].date()),
                input_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in files})
    result['acceptance']=acceptance({s:result[s] for s in ['full','late','cost_stress','delay_stress']},protocol['primary_rule'],protocol['primary_tactical_weight'])
    result['existing_signal_bound_pct']=max(r['return_pct'] for r in full['candidates'] if r['rule']=='reversal')
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
    for name,c in curves.items():c.to_csv(output/f'{name}_daily.csv',encoding='utf-8-sig')
    for name,ledger in ledgers.items():ledger.to_csv(output/f'{name}_tactical_rebuys.csv',index=False,encoding='utf-8-sig')
    path=report(data,curves,result,protocol,output)
    print('报告：',path)
    print(pd.DataFrame(full['candidates'])[['rule','tactical_weight','return_pct','profit_multiple','max_drawdown_pct','completed_rebuys','target_pass']].to_string(index=False))
    print('验收：',result['acceptance']);return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=HERE/'reports/position')
    run(parser.parse_args().output)
