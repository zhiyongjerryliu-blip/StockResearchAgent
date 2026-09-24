"""Causal changes in exposure, financed from a single cash/stock account."""
from __future__ import annotations

import argparse
from hashlib import sha256
from html import escape
import json
from pathlib import Path

import numpy as np
import pandas as pd

from cycle_research import add_peers,cycle_policy
from fundamental_strategy import enriched
from position_research import features,target_check
from research import metrics,simulate
from strategy import Config,HERE,validate_bars
from swing_research import matched_hold

NAMES={'partial_break':'动态半仓波段','trend_defense':'趋势分级仓位（主假设）','relative_defense':'趋势＋同业仓位'}


class ExposurePolicy:
    def __init__(self,rule):
        if rule not in NAMES:raise ValueError('未知动态仓位规则')
        self.rule=rule;self.active=False;self.reduced=False;self.days=0;self.exit_close=None

    def tactical_trigger(self,row):
        return bool(row.PriorOverheat and row.Close<row.PriorClose and row.Close<row.PriorLow)

    def __call__(self,row,fill=''):
        if self.active:
            signal,reason=cycle_policy(row,'cycle_relative',True,None)
            if signal=='SELL':
                self.active=False;self.reduced=False
                return 0.,reason
        else:
            if fill=='SELL':return 0.,'财务退出成交日不回补'
            signal,_=cycle_policy(row,'cycle_relative',False,None)
            if signal!='BUY':return 0.,'等待财务与同业入场'
            self.active=True
        reason=[]
        if self.reduced:
            self.days+=1
            if self.days>1 and (row.Close<=row.EMA or row.RSI2<30 or row.Close>self.exit_close or self.days>=5):
                self.reduced=False;reason.append('解除波段减仓')
        elif self.tactical_trigger(row):
            self.reduced=True;self.days=0;self.exit_close=float(row.Close)
            reason.append('过热后破低，波段减半')
        target=.5 if self.reduced else 1.
        if self.rule!='partial_break':
            cap=.25 if row.Close<row.SMA120 else (.5 if row.Close<row.SMA else 1.)
            target=min(target,cap)
            if cap<1:reason.append('价格趋势限制仓位')
        if self.rule=='relative_defense' and (pd.isna(row.RelativeReturn20) or row.RelativeReturn20<=0):
            target=min(target,.5);reason.append('同业相对强弱限制仓位')
        return target,'；'.join(reason) or '维持或恢复趋势仓位'


def execute_target(cash,units,open_price,target,config):
    """Solve target stock/open-marked NAV *after* fees and adverse slippage."""
    if not 0<=target<=1 or open_price<=0:raise ValueError('非法仓位或价格')
    equity=cash+units*open_price
    gap=target*equity-units*open_price
    if abs(gap)<1e-10:return cash,units,0.,float('nan'),0.
    direction=1 if gap>0 else -1
    price=open_price*(1+direction*config.slippage_bps/10000)
    cost_per_unit=direction*(price-open_price)+price*config.fee_bps/10000
    delta=gap/(open_price+direction*target*cost_per_unit)
    fee=abs(delta)*price*config.fee_bps/10000
    new_cash=cash-delta*price-fee;new_units=units+delta
    if new_cash<-1e-6 or new_units<-1e-8:raise ValueError('现金或持股越界')
    new_cash=max(0.,new_cash);new_units=max(0.,new_units)
    actual=new_units*open_price/(new_cash+new_units*open_price)
    if abs(actual-target)>1e-9:raise ValueError('扣费后开盘仓位不符合目标')
    return new_cash,new_units,delta,price,fee


def dynamic_simulate(data,start,rule,config=None,policy=None):
    config=config or Config();config.validate()
    view=data.loc[pd.Timestamp(start):]
    if len(view)<2 or not view.Ready.iloc[0]:raise ValueError('区间过短或预热不足')
    policy=policy or ExposurePolicy(rule)
    cash=float(config.initial_cash);units=0.;pending=None;command=0.;rows=[];trades=[]
    prior_equity=cash;prior_close=None
    for date,row in view.iterrows():
        old_units=units;fill='';price=float('nan');delta=0.;fee=0.;fill_target=float('nan')
        if pending is not None:
            fill_target,signal_date,fill_reason=pending
            cash,units,delta,price,fee=execute_target(cash,units,row.Open,fill_target,config)
            fill='BUY' if delta>1e-10 else ('SELL' if delta<-1e-10 else '')
            if fill:
                trades.append(dict(signal_date=signal_date,date=str(date.date()),fill=fill,price=price,
                                   delta_units=delta,fee=fee,target=fill_target,cash=cash,units=units,reason=fill_reason))
            pending=None
        equity=cash+units*row.Close
        expected=old_units*(row.Close-prior_close) if prior_close is not None else 0.
        if delta:expected+=delta*(row.Close-price)-fee
        if abs(equity-prior_equity-expected)>1e-6:raise ValueError('每日资金损益不守恒')
        target,reason=policy(row,fill)
        if not np.isfinite(target) or not 0<=target<=1:raise ValueError('信号仓位越界')
        signal=''
        if abs(target-command)>1e-10:
            signal='TARGET';command=float(target);pending=(command,str(date.date()),reason)
        rows.append(dict(Date=date,Equity=equity,Units=units,Cash=cash,Exposure=units*row.Close/equity,
                         Rule=rule,Signal=signal,Target=command,Reason=reason,Fill=fill,FillPrice=price,
                         FillTarget=fill_target,DeltaUnits=delta,Fee=fee))
        prior_equity=equity;prior_close=row.Close
    return pd.DataFrame(rows).set_index('Date'),pd.DataFrame(trades,columns=['signal_date','date','fill','price','delta_units','fee','target','cash','units','reason'])


def reduction_intervals(curve):
    rows=[];pending=None
    for i,(day,row) in enumerate(curve.iterrows()):
        if row.Fill=='SELL' and pending is None:pending=(i,day)
        elif row.Fill=='BUY' and pending is not None:
            loc,first=pending
            rows.append(dict(reduction_date=str(first.date()),increase_date=str(day.date()),
                             sessions=i-loc,status='减仓后再加仓'))
            pending=None
    if pending is not None:
        loc,first=pending
        rows.append(dict(reduction_date=str(first.date()),increase_date=None,sessions=len(curve)-loc-1,status='期末尚未加仓'))
    return pd.DataFrame(rows,columns=['reduction_date','increase_date','sessions','status'])


def compare(data,start,config):
    hold,hold_trades=simulate(data,start,'hold',config)
    hold_stats=metrics(hold,hold_trades,config.initial_cash)
    stats={};curves={'hold':hold};trades={};intervals={}
    for rule in NAMES:
        curve,ledger=dynamic_simulate(data,start,rule,config)
        aligned=matched_hold(data,curve,config)
        s=metrics(curve,pd.DataFrame(),config.initial_cash)
        # Partial reductions are not fully closed round-trip positions.
        s.pop('closed_trades')
        interval=reduction_intervals(curve);done=interval[interval.status=='减仓后再加仓']
        aligned_return=metrics(aligned,pd.DataFrame(),config.initial_cash)['return_pct']
        s.update(target_check(s['return_pct'],hold_stats['return_pct']))
        s.update(aligned_return_pct=aligned_return,excess_aligned_pp=s['return_pct']-aligned_return,
                 reduction_increase_cycles=len(done),median_reduced_sessions=float(done.sessions.median()) if len(done) else None,
                 fills=len(ledger),fees=float(curve.Fee.sum()),mean_exposure_pct=float(curve.Exposure.mean()*100),
                 min_cash=float(curve.Cash.min()),max_exposure_pct=float(curve.Exposure.max()*100))
        s['section_pass']=bool(s['target_pass'] and s['excess_aligned_pp']>1e-8 and len(done)>=3)
        stats[rule]=s;curves[rule]=curve;curves[rule+'_aligned']=aligned;trades[rule]=ledger;intervals[rule]=interval
    return dict(hold=hold_stats,candidates=stats),curves,trades,intervals


def report(data,result,curves,protocol,output,names=None,round_label='第七轮',extra_html='',filename='LITE_dynamic_report.html'):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    names=names or NAMES
    view=data.loc[curves['hold'].index];x=view.index.strftime('%Y-%m-%d').tolist()
    fig=make_subplots(rows=3,cols=1,shared_xaxes=True,row_heights=[.46,.2,.34],vertical_spacing=.07,
                      subplot_titles=['LITE日K及加減仓成交','实际股票市值 / 净资产','净值（对数）与期末利润目标'])
    fig.add_trace(go.Candlestick(x=x,open=view.Open.tolist(),high=view.High.tolist(),low=view.Low.tolist(),close=view.Close.tolist(),name='LITE日K'),row=1,col=1)
    fig.add_trace(go.Scatter(x=x,y=(curves['hold'].Equity/100000).tolist(),name='期初持有'),row=3,col=1)
    groups=[]
    for rule,label in names.items():
        c=curves[rule];indices=[];visible=rule==protocol['primary_rule']
        for fill,color,symbol,name in [('BUY','#168774','triangle-up','加仓'),('SELL','#cf4562','triangle-down','减仓')]:
            part=c[c.Fill==fill];indices.append(len(fig.data))
            fig.add_trace(go.Scatter(x=part.index.strftime('%Y-%m-%d').tolist(),y=part.FillPrice.tolist(),name=name,mode='markers',visible=visible,
                                     marker=dict(color=color,size=10,symbol=symbol),text=(part.Exposure*100).round(2).astype(str)+'% 收盘仓位',
                                     hovertemplate='%{x}<br>成交价 %{y:.2f}<br>%{text}<extra></extra>'),row=1,col=1)
        indices.append(len(fig.data));fig.add_trace(go.Scatter(x=x,y=(c.Exposure*100).tolist(),name='实际仓位%',visible=visible,line=dict(color='#3988ae')),row=2,col=1)
        for key,name,color in [(rule,label,'#168774'),(rule+'_aligned','同买点持有','#e69b42')]:
            indices.append(len(fig.data));fig.add_trace(go.Scatter(x=x,y=(curves[key].Equity/100000).tolist(),name=name,visible=visible,line=dict(color=color)),row=3,col=1)
        groups.append((rule,label,indices))
    buttons=[dict(label=label,method='update',args=[dict(visible=[i<2 or i in ids for i in range(len(fig.data))])]) for rule,label,ids in groups]
    fig.update_layout(updatemenus=[dict(buttons=buttons,active=list(names).index(protocol['primary_rule']),x=0,y=1.08,xanchor='left',yanchor='bottom')],
                      height=1050,template='plotly_white',margin=dict(t=190,l=60,r=25,b=40),legend=dict(orientation='h',y=1.18),hovermode='x unified')
    target=result['full']['hold']['return_pct']*1.5
    fig.add_hline(y=1+target/100,row=3,col=1,line_dash='dot',line_color='#b87720')
    fig.add_annotation(x=.99,y=float(np.log10(1+target/100)),xref='paper',yref='y3',text='期末利润目标',showarrow=False,yshift=12,xanchor='right')
    fig.update_yaxes(type='log',row=3,col=1,tickmode='array',tickvals=[.5,1,2,5,10,20,30,50],ticktext=['0.5','1','2','5','10','20','30','50'])
    fig.update_yaxes(range=[0,105],row=2,col=1);fig.update_xaxes(rangeslider_visible=False,rangebreaks=[dict(bounds=['sat','mon'])])
    graph=fig.to_html(full_html=False,include_plotlyjs=True,config={'responsive':True,'displaylogo':False})
    sections=[]
    for section,label in [('full','完整区间'),('late','2025年起独立账户'),('cost_stress','成本压力'),('delay_stress','财务信息延迟一天')]:
        rows=[]
        for rule,s in result[section]['candidates'].items():
            rows.append({'规则':names[rule],'净收益%':s['return_pct'],'持有利润倍数':s['profit_multiple'],
                         '最大回撤%':s['max_drawdown_pct'],'平均仓位%':s['mean_exposure_pct'],
                         '减仓后再加仓':s['reduction_increase_cycles'],'同买点持有收益%':s['aligned_return_pct'],
                         '验收':'通过' if s['section_pass'] else '未通过'})
        table=pd.DataFrame(rows).to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')
        hold=result[section]['hold']['return_pct']
        sections.append(f'<section><h2>{label}</h2><p>持有收益 {hold:,.2f}%；目标 {hold*1.5:,.2f}%。</p>{table}</section>')
    rules=''.join(f'<p><b>{escape(names[k])}</b>：{escape(v)}。</p>' for k,v in protocol['rules'].items())
    notes=''.join(f'<p>{escape(protocol[k])}</p>' for k in ['timing','reentry','risk','validation','status'])
    main=result['full']['candidates'][protocol['primary_rule']]
    html=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LITE 动态仓位研究</title><style>
body{{margin:0;background:#f2f5f8;color:#24384d;font:15px/1.75 -apple-system,"PingFang SC",sans-serif}}main{{max-width:1320px;margin:32px auto;padding:0 22px}}section{{background:white;border:1px solid #dfe6ed;border-radius:12px;padding:24px;margin:20px 0;overflow:auto}}h1{{font-size:30px}}h2{{font-size:20px}}table{{width:100%;border-collapse:collapse;font-size:13px}}td,th{{text-align:left;padding:10px;border-bottom:1px solid #e5eaf0}}a{{color:#246dba}}</style></head><body><main>
<p>{escape(round_label)} · 单账户动态仓位 · {result['start']} — {result['end']}</p><h1>LITE · 随状态加减仓</h1>
<section><h2>净利润至少为持有的1.5倍</h2><p>本区间目标净收益 {target:,.2f}%。主假设净收益 {main['return_pct']:,.2f}%，最大回撤 {main['max_drawdown_pct']:.2f}%。</p><p>主假设历史综合验收：{'通过' if result['historical_pass'] else '未通过'}；未来优势未验证。</p><p>本轮为动态目标仓位：{escape(protocol.get('levels','0%、25%、50%、100%'))}。目标改变才交易，不每日再平衡。图中三角为次日开盘模拟成交；有部分减仓，不能把减仓次数当作全部平仓次数。</p></section>
{extra_html}<section>{graph}</section>{''.join(sections)}<section><h2>规则与记账</h2>{rules}{notes}<p>默认单边手续费5bps＋滑点5bps；压力测试为10bps＋20bps。复权等价单位沿用冻结行情，未另加股息；现金无利息，不含税费和市场冲击。期末按收盘估值，不强制平仓。仓位通过成交后的开盘标记净资产计算，随后实际占比会漂移。逐日检查现金及损益守恒。</p>
<p><a href="summary.json">完整结果及哈希</a> · <a href="protocol.json">本轮协议</a> · <a href="../position/LITE_position_report.html">上一轮固定分仓</a></p></section></main></body></html>'''
    if protocol.get('full_position'):
        html=html.replace('有部分减仓，不能把减仓次数当作全部平仓次数。','本轮按全仓与现金切换；已完成回补与期末待回补分别统计。')
    path=output/filename;path.write_text(html,encoding='utf-8');return path


def run(output):
    output.mkdir(parents=True,exist_ok=True)
    files=[HERE/'dynamic_protocol.json',HERE/'reports/fundamental/financial_snapshot.json',HERE/'reports/fundamental/price_snapshot.csv',HERE/'reports/cycle/peer_snapshot.json']
    protocol,snapshot,peers=[json.loads(files[i].read_text()) for i in [0,1,3]]
    bars=validate_bars(pd.read_csv(files[2],index_col='Date'))
    base,_=enriched(bars,snapshot);data=features(add_peers(base,peers))
    delayed,_=enriched(bars,snapshot,1)
    cases=[('full',data,protocol['full_start'],Config()),('late',data,protocol['late_start'],Config()),
           ('cost_stress',data,protocol['full_start'],Config(fee_bps=10,slippage_bps=20)),
           ('delay_stress',features(add_peers(delayed,peers)),protocol['full_start'],Config())]
    result={};full_curves=None
    for section,frame,start,config in cases:
        stats,curves,trades,intervals=compare(frame,start,config);result[section]=stats
        if section=='full':full_curves=curves
        folder=output/section;folder.mkdir(exist_ok=True)
        for name,c in curves.items():c.to_csv(folder/f'{name}_daily.csv',encoding='utf-8-sig')
        for name,ledger in trades.items():ledger.to_csv(folder/f'{name}_fills.csv',index=False,encoding='utf-8-sig')
        for name,ledger in intervals.items():ledger.to_csv(folder/f'{name}_reductions.csv',index=False,encoding='utf-8-sig')
    result.update(start=str(full_curves['hold'].index[0].date()),end=str(full_curves['hold'].index[-1].date()),
                  historical_pass=all(result[s]['candidates'][protocol['primary_rule']]['section_pass'] for s,_,_,_ in cases),
                  future_edge_verified=False,input_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in files})
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
    print('报告：',report(data,result,full_curves,protocol,output))
    for section,_,_,_ in cases:
        print(section,pd.DataFrame(result[section]['candidates']).T[['return_pct','profit_multiple','max_drawdown_pct','reduction_increase_cycles','section_pass']].to_string())
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=HERE/'reports/dynamic')
    run(parser.parse_args().output)
