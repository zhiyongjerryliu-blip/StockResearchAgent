"""Test completed sell/rebuy cycles against both ordinary and entry-matched hold."""
from __future__ import annotations

import argparse
from hashlib import sha256
from html import escape
import json
from pathlib import Path

import pandas as pd

from cycle_research import add_peers, cycle_policy
from fundamental_strategy import enriched
from inflection_research import operating_signals
from research import metrics, simulate
from strategy import Config, HERE, validate_bars

RULES=('swing_reversal','swing_overheat')
NAMES={'swing_reversal':'过热后回落卖出（主假设）','swing_overheat':'过热即卖出（对照）',
       'aligned_hold':'同首次买点一直持有','hold':'期初买入持有'}


def swing_features(data):
    data=data.copy()
    data['Overheat']=(data.Close>data.EMA+2*data.ATR)&(data.RSI2>90)
    data['PriorOverheat']=data.Overheat.shift(1,fill_value=False)
    data['PriorClose']=data.Close.shift(1)
    return data


class SwingPolicy:
    """One fresh instance per replay. State is derived only from prior fills/signals."""
    def __init__(self):
        self.tactical=False
        self.exit_close=None
        self.cash_days=0

    def __call__(self,row,rule,holding,stop):
        ready,_,worsening=operating_signals(row,'inflection')
        if holding:
            self.cash_days=0
            self.tactical=False
            signal,reason=cycle_policy(row,'cycle_relative',True,stop)
            if signal:
                return signal,reason
            sell=bool(row.Overheat) if rule=='swing_overheat' else bool(row.PriorOverheat and row.Close<row.PriorClose)
            if sell:
                self.tactical=True
                self.exit_close=float(row.Close)
                return 'SELL','波段：'+('过热即卖出' if rule=='swing_overheat' else '过热后的首次回落')
            return '',''
        if self.tactical:
            self.cash_days+=1
            if worsening or not ready:
                self.tactical=False
                return '',''
            if self.cash_days==1:
                return '',''  # Actual sell fill day: shared engine also forbids same-day rebuy.
            reasons=[]
            if row.Close<=row.EMA:reasons.append('回到EMA20')
            if row.RSI2<30:reasons.append('RSI2回落')
            if row.Close>self.exit_close:reasons.append('突破卖出信号价，防止继续踏空')
            if self.cash_days>=5:reasons.append('空仓达到5个交易日')
            if reasons:return 'BUY','回补：'+'；'.join(reasons)
            return '',''
        return cycle_policy(row,'cycle_relative',False,stop)


def matched_hold(data,curve,config):
    buys=curve.index[curve.Fill=='BUY']
    result=pd.DataFrame(index=curve.index)
    for column in curve.columns:
        result[column]='' if column in ('Rule','Signal','Reason','Fill') else float('nan')
    result['Equity']=float(config.initial_cash)
    result['Units']=0.
    if len(buys):
        first=buys[0]
        price=float(data.loc[first,'Open'])*(1+config.slippage_bps/10000)
        units=config.initial_cash/(price*(1+config.fee_bps/10000))
        result.loc[first:,'Units']=units
        result.loc[first:,'Equity']=units*data.loc[result.index[result.index>=first],'Close']
        result.loc[first,'Fill']='BUY'
        result.loc[first,'FillPrice']=price
    result['Rule']='aligned_hold'
    return result


def rebuy_ledger(curve,config):
    """Measure completed SELL→BUY units, not the unrelated preceding trade P&L."""
    rows=[]
    pending=None
    fee=config.fee_bps/10000
    for i,(date,row) in enumerate(curve.iterrows()):
        if row.Fill=='SELL':
            pending=dict(sell_date=str(date.date()),sell_fill=float(row.FillPrice),
                         units_before=float(curve.Units.iloc[i-1]),
                         sell_reason=curve.Reason.iloc[i-1],sell_location=i)
        elif row.Fill=='BUY' and pending:
            factor=float(row.Units/pending['units_before'])
            formula=pending['sell_fill']*(1-fee)/(row.FillPrice*(1+fee))
            if abs(factor-formula)>1e-10:raise ValueError('回补持股数量与双边费用公式不一致')
            rows.append({**pending,'rebuy_date':str(date.date()),'rebuy_fill':float(row.FillPrice),
                         'cash_sessions':i-pending['sell_location'],'unit_multiplier':factor,
                         'unit_change_pct':100*(factor-1),'status':'完成回补'})
            pending=None
    if pending:
        rows.append({**pending,'rebuy_date':None,'rebuy_fill':None,'cash_sessions':len(curve)-pending['sell_location'],
                     'unit_multiplier':None,'unit_change_pct':None,'status':'期末尚未回补'})
    columns=['sell_date','rebuy_date','sell_fill','rebuy_fill','cash_sessions','unit_multiplier','unit_change_pct','status','sell_reason']
    return pd.DataFrame(rows).reindex(columns=columns)


def compare(data,start,config):
    curves,trades,ledgers,stats={},{},{},{}
    for name in RULES:
        curves[name],trades[name]=simulate(data,start,name,config,policy=SwingPolicy())
    first_buys=[c.index[c.Fill=='BUY'][0] if (c.Fill=='BUY').any() else None for c in curves.values()]
    if first_buys[0]!=first_buys[1]:raise ValueError('新规则首次入场不同，不能共用同买点对照')
    curves['aligned_hold']=matched_hold(data,curves[RULES[0]],config)
    trades['aligned_hold']=pd.DataFrame()
    curves['hold'],trades['hold']=simulate(data,start,'hold',config)
    for name,curve in curves.items():
        stats[name]=metrics(curve,trades[name],config.initial_cash)
        ledgers[name]=rebuy_ledger(curve,config)
        done=ledgers[name].loc[ledgers[name].status=='完成回补']
        stats[name]['completed_rebuys']=len(done)
        stats[name]['positive_rebuys']=int((done.unit_multiplier>1).sum())
        stats[name]['completed_unit_multiplier']=float(done.unit_multiplier.prod())
        buys=curve.index[curve.Fill=='BUY'];sells=curve.index[curve.Fill=='SELL']
        durations=[curve.index.get_loc(sell)-curve.index.get_loc(buys[i]) for i,sell in enumerate(sells)]
        stats[name]['median_closed_holding_sessions']=float(pd.Series(durations,dtype=float).median()) if durations else None
        stats[name]['max_holding_sessions']=max(durations+([len(curve)-1-curve.index.get_loc(buys[-1])] if len(buys)>len(sells) else []),default=0)
    for name,value in stats.items():
        value['excess_hold_pp']=value['return_pct']-stats['hold']['return_pct']
        value['excess_aligned_pp']=value['return_pct']-stats['aligned_hold']['return_pct']
        value['relative_aligned_wealth_pct']=(curves[name].Equity.iloc[-1]/curves['aligned_hold'].Equity.iloc[-1]-1)*100
    return stats,curves,trades,ledgers


def acceptance(result,name):
    full=result['full'][name]
    checks={s:result[s][name]['excess_hold_pp']>1e-8 and result[s][name]['excess_aligned_pp']>1e-8
            for s in ['full','late','cost_stress']}
    checks['at_least_3_rebuys']=full['completed_rebuys']>=3
    median=full['median_closed_holding_sessions']
    checks['median_hold_at_most_21_sessions']=median is not None and median<=21
    return dict(checks=checks,historical_pass=all(checks.values()),future_edge_verified=False)


def make_report(data,curves,ledgers,result,protocol,output):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    primary=protocol['primary_rule']
    view=data.loc[curves[primary].index];x=view.index.strftime('%Y-%m-%d').tolist()
    fig=make_subplots(rows=2,cols=1,shared_xaxes=True,vertical_spacing=.1,row_heights=[.6,.4],
                      subplot_titles=['完整波段：日K、信号与成交','净值与两个持有对照（对数）'])
    fig.add_trace(go.Candlestick(x=x,open=view.Open.tolist(),high=view.High.tolist(),low=view.Low.tolist(),
                                 close=view.Close.tolist(),name='LITE日K'),row=1,col=1)
    indexes={}
    for name in RULES:
        indexes[name]=[]
        for side,label,color,symbol in [('BUY','买','#168774','triangle-up'),('SELL','卖','#cf4562','triangle-down')]:
            for field in ['Signal','Fill']:
                part=curves[name].loc[curves[name][field]==side];indexes[name].append(len(fig.data))
                fig.add_trace(go.Scatter(x=part.index.strftime('%Y-%m-%d').tolist(),
                                         y=(part.FillPrice if field=='Fill' else view.loc[part.index].Close).tolist(),
                                         mode='markers',name=label+('成交' if field=='Fill' else '信号'),visible=name==primary,
                                         text=part.Reason.tolist() if field=='Signal' else ['前日信号，次日开盘加不利滑点']*len(part),
                                         hovertemplate='%{x}<br>%{y:.2f}<br>%{text}<extra></extra>',
                                         marker=dict(color=color,size=11 if field=='Fill' else 7,
                                                     symbol=symbol if field=='Fill' else 'circle-open')),row=1,col=1)
    for name in NAMES:
        fig.add_trace(go.Scatter(x=x,y=(curves[name].Equity/100000).tolist(),name=NAMES[name]),row=2,col=1)
    buttons=[]
    for name in RULES:
        visible=[True]*len(fig.data)
        for n,indices in indexes.items():
            for i in indices:visible[i]=n==name
        buttons.append(dict(label=NAMES[name],method='update',args=[{'visible':visible},{'annotations[0].text':NAMES[name]+' · 日K买卖点'}]))
    fig.update_layout(height=930,template='plotly_white',hovermode='x unified',margin=dict(t=155,l=50,r=25,b=35),
                       legend=dict(orientation='h',y=1.16),updatemenus=[dict(buttons=buttons,x=1,xanchor='right',y=1.06,yanchor='bottom')])
    fig.update_yaxes(type='log',row=2,col=1,tickmode='array',tickvals=[.1,.2,.5,1,2,5,10,20,50],ticktext=['0.1','0.2','0.5','1','2','5','10','20','50'])
    fig.update_xaxes(rangeslider_visible=False,rangebreaks=[dict(bounds=['sat','mon'])])
    graph=fig.to_html(full_html=False,include_plotlyjs=True,config={'responsive':True,'displaylogo':False})
    def table(section):
        return pd.DataFrame([{'规则':NAMES[n],'收益 %':v['return_pct'],'比期初持有 pp':v['excess_hold_pp'],
                              '比同买点持有 pp':v['excess_aligned_pp'],'最大回撤 %':v['max_drawdown_pct'],
                              '完成卖出回补':v['completed_rebuys'],'增股回补数':v['positive_rebuys']} for n,v in result[section].items()]).to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')
    ledger_html=''
    for name in RULES:
        frame=ledgers[name].drop(columns=['unit_multiplier']).rename(columns={
            'sell_date':'卖出日','rebuy_date':'回补日','sell_fill':'卖出成交价','rebuy_fill':'回补成交价',
            'cash_sessions':'空仓交易日','unit_change_pct':'扣费后持股变化 %','status':'状态','sell_reason':'卖出原因'})
        ledger_html+=f'<h2>{NAMES[name]} · 卖出后有没有买回更多股</h2>'+frame.to_html(index=False,border=0,float_format=lambda v:f'{v:.3f}')
    main=result['full'][primary]
    verdict='本轮历史波段验收通过，未来尚未验证' if result['acceptance'][primary]['historical_pass'] else '本轮波段验收未通过'
    rules=''.join(f'<p><b>{NAMES[n]}</b>：{escape(t)}。</p>' for n,t in protocol['rules'].items())
    html=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LITE 完整波段验收</title><style>
body{{margin:0;background:#f2f5f8;color:#24384d;font:15px/1.75 -apple-system,"PingFang SC",sans-serif}}main{{max-width:1320px;margin:32px auto;padding:0 22px}}section{{background:white;border:1px solid #dfe6ed;border-radius:12px;padding:24px;margin:20px 0;overflow:auto}}h1{{font-size:30px}}h2{{font-size:20px}}table{{width:100%;border-collapse:collapse;font-size:13px}}td,th{{text-align:left;padding:10px;border-bottom:1px solid #e5eaf0}}.muted{{color:#637990}}.verdict{{border-left:5px solid #916044}}a{{color:#246dba}}</style></head><body><main>
<div class="muted">第五轮 · 逐笔卖出与回补核算 · 探索性研究</div><h1>LITE · 波段交易是否增加持股数量</h1><p>{result['start']} — {result['end']} · {escape(protocol['status'])}</p>
<section class="verdict"><h2>{verdict}</h2><p>主假设累计净收益 {main['return_pct']:+.2f}%；期初持有 {result['full']['hold']['return_pct']:+.2f}%；同买点持有 {result['full']['aligned_hold']['return_pct']:+.2f}%。</p><p>完成卖出→回补 {main['completed_rebuys']} 组，其中 {main['positive_rebuys']} 组扣费后增加持股数量。已完成持仓段中位数 {main['median_closed_holding_sessions']} 个交易日，最长持仓（含未平仓）{main['max_holding_sessions']} 个交易日。</p>
<p>相对同买点持有的最终财富变化为 {main['relative_aligned_wealth_pct']:+.2f}%，这项比较排除了首次买得便宜的贡献；负值代表波段本身拖累收益。</p></section>
<section><p>右上角可切换两条规则的买卖点；信号按下一交易日开盘成交。</p>{graph}</section><section><h2>全期比较</h2>{table('full')}</section>
<section><h2>早期2023—2024</h2>{table('early')}<h2>后期2025年起独立账户</h2>{table('late')}</section>
<section><h2>成本压力</h2>{table('cost_stress')}<h2>财务信息额外延迟1日</h2>{table('delay_stress')}</section>
<section>{ledger_html}<p>每组持股倍数=卖出成交价×(1−卖出费率)÷[回补成交价×(1＋买入费率)]，成交价已含不利滑点。只比较实际完成的回补；期末仍空仓单列，不假设未来能低价买回。</p></section>
<section><h2>本轮规则</h2>{rules}<p><b>首次买入：</b>{escape(protocol['entry'])}。</p><p><b>回补：</b>{escape(protocol['reentry'])}</p><p><b>基本面失效：</b>{escape(protocol['fundamental_exit'])}</p><p>{escape(protocol['execution'])}。</p><p><b>验收：</b>{escape(protocol['acceptance'])}</p><p>{escape(protocol['data'])}</p><p><a href="summary.json">完整统计与验收</a> · <a href="protocol.json">固定协议</a> · <a href="../cycle/LITE_cycle_report.html">上一轮择时买入报告</a></p></section></main></body></html>'''
    path=output/'LITE_swing_report.html';path.write_text(html,encoding='utf-8')
    return path


def run(input_dir,peer_path,output):
    output.mkdir(parents=True,exist_ok=True)
    protocol_path=HERE/'swing_protocol.json';protocol=json.loads(protocol_path.read_text())
    financial_path=input_dir/'financial_snapshot.json';prices_path=input_dir/'price_snapshot.csv'
    snapshot=json.loads(financial_path.read_text())
    if snapshot['ticker']!='LITE':raise ValueError('协议只适用于LITE')
    bars=validate_bars(pd.read_csv(prices_path,index_col='Date'));peers=json.loads(peer_path.read_text())
    data,_=enriched(bars,snapshot);data=swing_features(add_peers(data,peers))
    start,late_start=protocol['full_start'],protocol['late_start']
    full,curves,trades,ledgers=compare(data,start,Config())
    early,_,_,_=compare(data.loc[data.index<pd.Timestamp(late_start)],start,Config())
    late,_,_,_=compare(data,late_start,Config())
    stress,_,_,_=compare(data,start,Config(fee_bps=10,slippage_bps=20))
    delayed,_=enriched(bars,snapshot,1)
    delay,_,_,_=compare(swing_features(add_peers(delayed,peers)),start,Config())
    result=dict(start=str(curves['hold'].index[0].date()),end=str(curves['hold'].index[-1].date()),
                full=full,early=early,late=late,cost_stress=stress,delay_stress=delay,
                input_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in [protocol_path,financial_path,prices_path,peer_path]})
    result['acceptance']={n:acceptance(result,n) for n in RULES}
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
    for name in NAMES:
        data.loc[curves[name].index].join(curves[name],rsuffix='_ledger').to_csv(output/f'{name}_daily.csv',encoding='utf-8-sig')
        trades[name].to_csv(output/f'{name}_trades.csv',index=False,encoding='utf-8-sig')
        ledgers[name].to_csv(output/f'{name}_rebuys.csv',index=False,encoding='utf-8-sig')
    path=make_report(data,curves,ledgers,result,protocol,output)
    print('报告：',path)
    print(pd.DataFrame(full).T[['return_pct','excess_hold_pp','excess_aligned_pp','completed_rebuys','positive_rebuys','median_closed_holding_sessions']].to_string())
    print('验收：',json.dumps(result['acceptance'],ensure_ascii=False))
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir',type=Path,default=HERE/'reports/fundamental')
    parser.add_argument('--peer-snapshot',type=Path,default=HERE/'reports/cycle/peer_snapshot.json')
    parser.add_argument('--output',type=Path,default=HERE/'reports/swing')
    args=parser.parse_args();run(args.input_dir,args.peer_snapshot,args.output)
