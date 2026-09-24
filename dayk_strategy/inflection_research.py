"""Exploratory ablation: FCF gate vs operating improvement, with frozen inputs."""
from __future__ import annotations

import argparse
from hashlib import sha256
from html import escape
import json
import math
from pathlib import Path

import pandas as pd

from fundamental_strategy import enriched, policy as original_policy, quarter_returns
from research import metrics, simulate
from strategy import Config, HERE, validate_bars

NAMES={'original':'原版技术','fund_regime':'财务硬门槛（上一轮）','no_cash_gate':'去掉现金流门槛',
       'inflection':'经营改善速度（本轮主假设）','trend60_120':'纯技术60/120','hold':'买入持有'}
EPSILON=1e-10


def operating_signals(row,rule):
    columns=('RevenueYoY','GrossMarginYoY') if rule=='no_cash_gate' else ('RevenueAcceleration','GrossMarginYoYAcceleration')
    values=[row[c] for c in columns]
    ready=all(pd.notna(v) and math.isfinite(v) for v in values) and pd.notna(row.FinAgeDays) and row.FinAgeDays<=180
    if not ready:
        return False,False,False
    a,b=values
    improving=a>EPSILON and (b>=-EPSILON if rule=='no_cash_gate' else b>EPSILON)
    worsening=a<-EPSILON and b<-EPSILON
    return True,improving,worsening


def operating_policy(row,rule,holding,stop):
    if rule not in ('no_cash_gate','inflection'):
        return original_policy(row,rule,holding,stop)
    ready,improving,worsening=operating_signals(row,rule)
    if holding:
        if not ready and row.Close<row.SMA:
            return 'SELL','财务特征缺失或过期；跌破SMA60'
        if worsening:
            return 'SELL','营收与毛利率改善速度同时转差' if rule=='inflection' else '营收与毛利率同比同时下降'
        if row.Close<row.SMA120:
            return 'SELL','跌破SMA120持有防线'
    elif ready and improving and row.Close>max(row.SMA,row.SMA120):
        return 'BUY','营收与毛利率改善速度同时为正' if rule=='inflection' else '营收增长、毛利率同比未下降；不设现金流正值门槛'
    return '',''


def compare(data,start,config):
    stats,curves,trades={},{},{}
    for name in NAMES:
        curves[name],trades[name]=simulate(data,start,name,config,policy=operating_policy)
        stats[name]=metrics(curves[name],trades[name],config.initial_cash)
    for values in stats.values():
        values['excess_return_pp']=values['return_pct']-stats['hold']['return_pct']
    return stats,curves,trades


def make_report(data,curves,trades,result,protocol,output):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    primary=protocol['primary_rule']
    view=data.loc[curves[primary].index]
    x=view.index.strftime('%Y-%m-%d').tolist()
    fig=make_subplots(rows=3,cols=1,shared_xaxes=True,vertical_spacing=.06,row_heights=[.48,.22,.30],
                      subplot_titles=['探索规则买卖点 · 复权日线','营收与毛利率的改善速度（百分点）','各规则净值（对数刻度）'])
    fig.add_trace(go.Candlestick(x=x,open=view.Open.tolist(),high=view.High.tolist(),low=view.Low.tolist(),
                                 close=view.Close.tolist(),name='复权日K',increasing_line_color='#168774',decreasing_line_color='#cf4562'),row=1,col=1)
    for side,label,color,symbol in [('BUY','买','#168774','triangle-up'),('SELL','卖','#cf4562','triangle-down')]:
        for kind,field in [('成交','Fill'),('信号','Signal')]:
            part=curves[primary].loc[curves[primary][field]==side]
            prices=part.FillPrice if field=='Fill' else view.loc[part.index].Close
            fig.add_trace(go.Scatter(x=part.index.strftime('%Y-%m-%d').tolist(),y=prices.tolist(),mode='markers',
                                     name=label+kind,marker=dict(color=color,size=12 if field=='Fill' else 8,
                                     symbol=symbol if field=='Fill' else 'circle-open'),
                                     text=part.Reason.tolist() if field=='Signal' else ['上一交易日信号；次日开盘加滑点']*len(part),
                                     hovertemplate='%{x}<br>%{y:.2f}<br>%{text}<extra></extra>'),row=1,col=1)
    for col,label in [('RevenueAcceleration','营收同比增速变化'),('GrossMarginYoYAcceleration','毛利率同比变化的变化')]:
        fig.add_trace(go.Scatter(x=x,y=(view[col]*100).tolist(),name=label,line=dict(shape='hv')),row=2,col=1)
    for name in NAMES:
        fig.add_trace(go.Scatter(x=x,y=(curves[name].Equity/100000).tolist(),name=NAMES[name],
                                 line=dict(width=3 if name in (primary,'hold') else 1.5)),row=3,col=1)
    fig.update_yaxes(type='log',row=3,col=1,tickmode='array',tickvals=[.2,.5,1,2,5,10,20,50,100],
                     ticktext=['0.2','0.5','1','2','5','10','20','50','100'])
    fig.update_xaxes(rangeslider_visible=False,rangebreaks=[dict(bounds=['sat','mon'])])
    fig.update_layout(height=1000,template='plotly_white',hovermode='x unified',
                       legend=dict(orientation='h',y=1.13),margin=dict(l=55,r=30,t=140,b=35))
    def table(section):
        frame=pd.DataFrame([{'规则':NAMES[n],'收益 %':v['return_pct'],'超额百分点':v['excess_return_pp'],
                              '最大回撤 %':v['max_drawdown_pct'],'完整交易':v['closed_trades']} for n,v in result[section].items()])
        return frame.to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')
    main=result['full'][primary]
    verdict='探索性历史结果超过持有，尚未证明未来优势' if main['excess_return_pp']>0 else '本轮探索仍未超过买入持有'
    quarterly=pd.DataFrame(result['quarterly']).set_index('quarter')[[primary,'hold','excess_return_pp']]
    quarterly.index.name='季度'
    quarterly.columns=['主假设收益 %','持有收益 %','超额百分点']
    history=view.loc[view.FinSources.ne(view.FinSources.shift()),
                     ['FinPeriod','RevenueYoY','GrossMarginYoY','RevenueAcceleration','GrossMarginYoYAcceleration','FCFTTM']].copy()
    for col in ['RevenueYoY','GrossMarginYoY','RevenueAcceleration','GrossMarginYoYAcceleration']:
        history[col]*=100
    history.FCFTTM/=1e6
    history.index.name='回测中首次出现日'
    history.columns=['财务季度','营收同比 %','毛利率同比 pp','营收增速变化 pp','毛利率改善速度 pp','TTM自由现金流（百万美元）']
    ledger=trades[primary]
    if len(ledger):
        visible=ledger[['entry_date','exit_date','return_pct','reason']].copy()
        visible.columns=['买入日','卖出日','净收益 %','退出原因']
        ledger_html=visible.to_html(index=False,border=0,float_format=lambda v:f'{v:.2f}')
    else:
        ledger_html='<p>没有已平仓交易。</p>'
    graph=fig.to_html(full_html=False,include_plotlyjs=True,config={'responsive':True,'displaylogo':False})
    html=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LITE 经营拐点探索</title>
<style>body{{margin:0;background:#f2f5f8;color:#24384d;font:15px/1.75 -apple-system,"PingFang SC",sans-serif}}main{{max-width:1320px;margin:32px auto;padding:0 22px}}section{{background:white;border:1px solid #dfe6ed;border-radius:12px;padding:24px;margin:20px 0;overflow:auto}}h1{{font-size:30px}}h2{{font-size:20px}}table{{width:100%;border-collapse:collapse;font-size:13px}}td,th{{text-align:left;padding:10px;border-bottom:1px solid #e5eaf0}}.muted{{color:#637990}}.verdict{{border-left:5px solid #916044}}a{{color:#246dba}}</style></head><body><main>
<div class="muted">第二轮 · 经营改善速度 · 探索性研究</div><h1>LITE · 把财务水平与改善速度分开检验</h1>
<p>{result['start']} — {result['end']} · {escape(protocol['status'])}</p>
<section class="verdict"><h2>{verdict}</h2><p>主假设收益 {main['return_pct']:+.2f}%，持有 {result['full']['hold']['return_pct']:+.2f}%；主假设最大回撤 {main['max_drawdown_pct']:.2f}%。</p>
<p>两个新假设在本轮计算前固定。协议和全部候选均保留；没有按结果挑选“最佳参数”。</p></section>
<section>{graph}</section><section><h2>全期比较</h2>{table('full')}</section>
<section><h2>早期 2023—2024</h2>{table('early')}<h2>后期 2025年至末日</h2>{table('late')}<p class="muted">各段独立从相同现金开始；未拟合参数。后期也已被观察过，不是完全未见样本。</p></section>
<section><h2>成本增加后的比较</h2>{table('cost_stress')}<p>单边手续费10 bps＋滑点20 bps；所有规则不变。</p>
<h2>财务信息额外延迟一个交易日</h2>{table('delay_stress')}</section>
<section><h2>逐季收益 · 连续账户</h2>{quarterly.to_html(border=0,float_format=lambda v:f'{v:.2f}')}</section>
<section><h2>主假设完整交易</h2>{ledger_html}</section>
<section><h2>当时可见的经营变化</h2>{history.to_html(border=0,float_format=lambda v:f'{v:.2f}')}</section>
<section><h2>两个新假设</h2><p><b>去掉现金流门槛：</b>{escape(protocol['no_cash_gate'])}。</p>
<p><b>经营改善速度：</b>{escape(protocol['inflection'])}。</p>
<p>营收改善速度=本季度营收同比−上一季度营收同比；毛利率改善速度=本季度毛利率同比变化−上一季度毛利率同比变化。不是直接把季节性环比当作增长。</p>
<p>{escape(protocol['missing_policy'])}。财报只能在披露与美东接受日期较晚者之后的首个交易日收盘使用。信号于下一交易日开盘加不利滑点成交，默认手续费与滑点各5 bps。</p>
<p>使用上一轮冻结的895条财务事实和同一份行情；未来修订不回写过去，期末持仓按收盘估值。数据源完整性、并购可比性、历史选择偏差等限制仍存在。本报告不含历史盈利预期或事后新闻评分。</p>
<p><a href="../fundamental/LITE_fundamental_report.html">上一轮财务硬门槛报告</a> · <a href="https://www.sec.gov/search-filings/edgar-application-programming-interfaces">SEC 数据说明</a></p></section></main></body></html>'''
    path=output/'LITE_inflection_report.html';path.write_text(html,encoding='utf-8')
    return path,verdict


def run(input_dir,output):
    output.mkdir(parents=True,exist_ok=True)
    protocol_path=HERE/'inflection_protocol.json'
    protocol=json.loads(protocol_path.read_text())
    source=input_dir/'financial_snapshot.json'
    prices=input_dir/'price_snapshot.csv'
    snapshot=json.loads(source.read_text())
    if snapshot['ticker']!='LITE':
        raise ValueError('本轮研究协议仅用于LITE')
    bars=validate_bars(pd.read_csv(prices,index_col='Date'))
    data,audit=enriched(bars,snapshot)
    full,curves,trades=compare(data,protocol['full_start'],Config())
    early,_,_=compare(data.loc[data.index<pd.Timestamp(protocol['late_start'])],protocol['full_start'],Config())
    late,late_curves,_=compare(data,protocol['late_start'],Config())
    stress,_,_=compare(data,protocol['full_start'],Config(fee_bps=10,slippage_bps=20))
    delayed,_=enriched(bars,snapshot,1)
    delay_stats,_,_=compare(delayed,protocol['full_start'],Config())
    quarters=quarter_returns(curves,100000)
    quarters['excess_return_pp']=quarters[protocol['primary_rule']]-quarters['hold']
    result=dict(start=str(curves['hold'].index[0].date()),end=str(curves['hold'].index[-1].date()),
                full=full,early=early,late=late,cost_stress=stress,delay_stress=delay_stats,
                quarterly=json.loads(quarters.reset_index().to_json(orient='records')),
                input_dir=str(input_dir.resolve()),snapshot_sha256=sha256(source.read_bytes()).hexdigest(),
                price_sha256=sha256(prices.read_bytes()).hexdigest(),protocol_sha256=sha256(protocol_path.read_bytes()).hexdigest())
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
    data.to_csv(output/'financial_daily.csv',encoding='utf-8-sig')
    for name in NAMES:
        data.loc[curves[name].index].join(curves[name],rsuffix='_ledger').to_csv(output/f'{name}_daily.csv',encoding='utf-8-sig')
        trades[name].to_csv(output/f'{name}_trades.csv',index=False,encoding='utf-8-sig')
        late_curves[name].to_csv(output/f'{name}_late_daily.csv',encoding='utf-8-sig')
    path,verdict=make_report(data,curves,trades,result,protocol,output)
    result['verdict']=verdict
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    print('报告：',path)
    print(pd.DataFrame(full).T[['return_pct','excess_return_pp','max_drawdown_pct','closed_trades']].to_string())
    print('后期：',json.dumps({n:v['return_pct'] for n,v in late.items()},ensure_ascii=False))
    print(verdict)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir',type=Path,default=HERE/'reports/fundamental')
    parser.add_argument('--output',type=Path,default=HERE/'reports/inflection')
    args=parser.parse_args()
    run(args.input_dir,args.output)
