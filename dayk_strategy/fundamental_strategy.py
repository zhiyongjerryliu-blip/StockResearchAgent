"""Connect point-in-time company financials to daily signals and fair comparisons."""
from __future__ import annotations

import argparse
from datetime import datetime
from hashlib import sha256
from html import escape
import json
from pathlib import Path
import re
from zoneinfo import ZoneInfo

import pandas as pd

from fundamentals import build_daily, read_snapshot
from research import entry_condition, exit_reason, features, metrics, simulate
from strategy import Config, HERE, validate_bars

LABELS = {'original':'原版技术', 'original_slow_exit':'原买点＋慢退出',
          'trend60_120':'纯技术60/120', 'fund_extend':'财务改善延长持有',
          'fund_regime':'财务状态＋趋势（主规则）', 'hold':'买入持有'}
STATES = {'EXPANSION':'改善','DETERIORATION':'转差','NEUTRAL':'中性','UNKNOWN':'缺失/冲突','STALE':'过期'}


def policy(row, rule, holding, stop):
    if rule in ('original','hold'):
        if holding:
            reason = exit_reason(row,rule,stop)
            return ('SELL',reason) if reason else ('','')
        return ('BUY','原版技术入场' if rule=='original' else '买入持有') if entry_condition(row,rule) else ('','')
    strong = row.FinState=='EXPANSION'
    weak = row.FinState=='DETERIORATION'
    unknown = row.FinState in ('UNKNOWN','STALE')
    if holding:
        if rule=='fund_extend' and not strong:
            reason=exit_reason(row,'original',stop)
            return ('SELL','财务未处于改善状态；'+reason) if reason else ('','')
        if rule=='fund_regime':
            if weak:
                return 'SELL','营收与毛利率同比转差'
            if unknown and row.Close<row.SMA:
                return 'SELL','财务数据不可用或过期；跌破SMA60'
        if row.Close<row.SMA120:
            return 'SELL','跌破SMA120持有防线'
    else:
        if rule in ('fund_extend','original_slow_exit'):
            buy=bool(row.EntryCondition)
        else:
            buy=row.Close>max(row.SMA,row.SMA120) and (strong if rule=='fund_regime' else True)
        if buy:
            return 'BUY', ('财务改善且价格高于SMA60和SMA120' if rule=='fund_regime' else '技术入场条件满足')
    return '',''


def enriched(bars,snapshot,delay=0):
    fin,audit=build_daily(snapshot,bars.index,delay)
    data=features(bars).join(fin)
    data['SMA120']=data.Close.rolling(120).mean()
    data['Ready']=data.Ready & data.SMA120.notna()
    return data,audit


def compare(data,start,config):
    result,curves,trades={}, {}, {}
    for name in LABELS:
        curve,ledger=simulate(data,start,name,config,policy=policy)
        result[name]=metrics(curve,ledger,config.initial_cash)
        curves[name],trades[name]=curve,ledger
    benchmark=result['hold']['return_pct']
    for value in result.values():
        value['excess_return_pp']=value['return_pct']-benchmark
    return result,curves,trades


def quarter_returns(curves,initial):
    pieces=[]
    for name,curve in curves.items():
        for quarter,group in curve.groupby(curve.index.to_period('Q')):
            loc=curve.index.get_loc(group.index[0])
            prior=curve.Equity.iloc[loc-1] if loc else initial
            pieces.append(dict(quarter=str(quarter),rule=name,return_pct=(group.Equity.iloc[-1]/prior-1)*100))
    return pd.DataFrame(pieces).pivot(index='quarter',columns='rule',values='return_pct')


def report(data,curves,trades,summary,protocol,output):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    primary=protocol['primary_rule']
    curve=curves[primary]
    shown=data.loc[curve.index]
    fig=make_subplots(rows=4,cols=1,shared_xaxes=True,vertical_spacing=.04,
                      row_heights=[.44,.11,.18,.27],
                      specs=[[{}],[{}],[{'secondary_y':True}],[{}]],
                      subplot_titles=['复权日K线 · 主规则买卖点','成交量','当时已知的季度财务变化','净值对照（对数刻度）'])
    x=shown.index.strftime('%Y-%m-%d').tolist()
    fig.add_trace(go.Candlestick(x=x,open=shown.Open.tolist(),high=shown.High.tolist(),low=shown.Low.tolist(),
                                 close=shown.Close.tolist(),name='复权日K',increasing_line_color='#178878',
                                 decreasing_line_color='#cd496a'),row=1,col=1)
    for col,label,color in [('SMA','SMA60','#a58032'),('SMA120','SMA120','#587ac5')]:
        fig.add_trace(go.Scatter(x=x,y=shown[col].tolist(),name=label,line=dict(color=color,width=1.5)),row=1,col=1)
    for side,label,color,symbol in [('BUY','买入','#087e6b','triangle-up'),('SELL','卖出','#d24566','triangle-down')]:
        for kind,field in [('成交','Fill'),('信号','Signal')]:
            subset=curve[curve[field]==side]
            price=subset.FillPrice if field=='Fill' else shown.loc[subset.index].Close
            descriptions=[]
            for date,row in subset.iterrows():
                fin=shown.loc[date]
                descriptions.append(f"财务季度 {fin.FinPeriod} · 状态 {STATES[fin.FinState]}<br>"+
                                    (row.Reason if field=='Signal' else '前一交易日信号，于本日开盘加不利滑点成交'))
            fig.add_trace(go.Scatter(x=subset.index.strftime('%Y-%m-%d').tolist(),y=price.tolist(),mode='markers',
                                     name=f'{label}{kind}',marker=dict(symbol=symbol if field=='Fill' else 'circle-open',
                                     color=color,size=12 if field=='Fill' else 8),text=descriptions,
                                     hovertemplate='%{x}<br>%{y:.2f}<br>%{text}<extra></extra>'),row=1,col=1)
    disclosure_mask=((data.FinSources!=data.FinSources.shift()) & (data.FinSources!='[]')).reindex(shown.index)
    disclosures=shown[disclosure_mask]
    fig.add_trace(go.Scatter(x=disclosures.index.strftime('%Y-%m-%d').tolist(),y=disclosures.Close.tolist(),
                             mode='markers',name='财务信息可用日',marker=dict(symbol='diamond-open',size=8,color='#8852ab'),
                             text=[f'财务季度 {r.FinPeriod}<br>{r.FinReason}' for _,r in disclosures.iterrows()],
                             hovertemplate='%{x}<br>%{text}<extra></extra>'),row=1,col=1)
    fig.add_trace(go.Bar(x=x,y=shown.Volume.tolist(),name='成交量',showlegend=False,marker_color='#b9c6d7'),row=2,col=1)
    for col,label,color in [('RevenueYoY','营收同比 %','#1d8b75'),('GrossMarginYoY','毛利率同比变化（百分点）','#ad7b2f')]:
        fig.add_trace(go.Scatter(x=x,y=(shown[col]*100).tolist(),name=label,line=dict(shape='hv',color=color)),row=3,col=1)
    fig.add_trace(go.Scatter(x=x,y=(shown.FCFTTM/1e6).tolist(),name='TTM自由现金流（百万美元，右轴）',
                             line=dict(shape='hv',color='#9363b3',dash='dot')),row=3,col=1,secondary_y=True)
    fig.update_yaxes(title_text='百万美元',row=3,col=1,secondary_y=True)
    colors={'fund_regime':'#147960','hold':'#2e405e','original':'#b4bbc7','trend60_120':'#c39243'}
    for name in ['fund_regime','hold','original','trend60_120']:
        values=curves[name].Equity/summary['config']['initial_cash']
        fig.add_trace(go.Scatter(x=x,y=values.tolist(),name=LABELS[name],line=dict(color=colors[name],width=2)),row=4,col=1)
    fig.update_yaxes(type='log',row=4,col=1,tickmode='array',tickvals=[.2,.5,1,2,5,10,20,50,100],
                     ticktext=['0.2','0.5','1','2','5','10','20','50','100'])
    fig.update_xaxes(rangeslider_visible=False,rangebreaks=[dict(bounds=['sat','mon'])])
    fig.update_layout(height=1200,template='plotly_white',hovermode='x unified',
                       legend=dict(orientation='h',y=1.12),margin=dict(l=55,r=30,t=150,b=35))
    graph=fig.to_html(full_html=False,include_plotlyjs=True,config={'responsive':True,'displaylogo':False})

    def metric_table(values):
        rows=[{'规则':LABELS[n],'收益 %':v['return_pct'],'超额百分点':v['excess_return_pp'],
               '最大回撤 %':v['max_drawdown_pct'],'完整交易':v['closed_trades'],'持仓日占比 %':v['exposure_pct']} for n,v in values.items()]
        return pd.DataFrame(rows).to_html(index=False,border=0,float_format=lambda x:f'{x:,.2f}')
    latest=shown.iloc[-1]
    state='持仓' if curve.Units.iloc[-1]>0 else '空仓'
    if curve.Signal.iloc[-1]:
        state+='；最新信号等待下一交易日执行'
    ledgers=trades[primary]
    if len(ledgers):
        table=ledgers[['entry_date','entry_price','exit_date','exit_price','return_pct','reason']].copy()
        table.columns=['买入日','买入价','卖出日','卖出价','净收益 %','卖出原因']
        trade_html=table.to_html(index=False,border=0,float_format=lambda x:f'{x:,.2f}')
    else:
        trade_html='<p>没有已平仓交易；未平仓收益已按期末收盘计入净值。</p>'
    used=json.loads(latest.FinSources)
    lookup={f['source_key']:f for f in summary['_snapshot']['facts']}
    references={lookup[k]['source_url']:lookup[k]['filed_at'] for k in used if k in lookup and str(lookup[k].get('source_url','')).startswith('https://www.sec.gov/')}
    links=' '.join(f'<a href="{escape(url,quote=True)}">SEC {date}</a>' for url,date in sorted(references.items(),key=lambda x:x[1],reverse=True)[:8])
    rule_html=''.join(f'<li><b>{LABELS[name]}</b>：{escape(text)}</li>' for name,text in protocol['rules'].items())
    quarterly=pd.DataFrame(summary['quarterly']).set_index('quarter')
    quarterly=quarterly[['fund_regime','hold','excess_return_pp']]
    quarterly.columns=['主规则收益 %','持有收益 %','超额百分点']
    changes=shown.loc[shown.FinSources.ne(shown.FinSources.shift()),
                      ['FinPeriod','FinKnownDay','RevenueYoY','GrossMarginYoY','FCFTTM','FinState']].copy()
    changes[['RevenueYoY','GrossMarginYoY']]*=100
    changes['FCFTTM']/=1e6
    changes['FinState']=changes.FinState.map(STATES)
    changes.columns=['财务季度','依据披露日','营收同比 %','毛利率同比变化 pp','TTM自由现金流（百万美元）','状态']
    changes.index.name='回测中首次出现日'
    primary_stats=summary['full'][primary]
    late_stats=summary['late'][primary]
    verdict='本轮历史回测未通过收益优先标准' if primary_stats['excess_return_pp']<=0 or late_stats['excess_return_pp']<=0 else '本轮早晚区间存在历史超额，仍待未见数据验证'
    if verdict.startswith('本轮早晚') and summary['early'][primary]['excess_return_pp']<=0:
        verdict='全期与后期有历史超额，早期未通过；尚未证明稳定优势'
    freshness='缺失' if pd.isna(latest.FinPeriod) else latest.FinPeriod
    html=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{summary['ticker']} 财务与日线策略</title>
<style>body{{margin:0;background:#f2f5f8;color:#21364b;font:15px/1.75 -apple-system,"PingFang SC",sans-serif}}main{{max-width:1320px;margin:32px auto;padding:0 22px}}h1{{font-size:30px}}h2{{font-size:20px}}section{{padding:22px;background:white;border:1px solid #dfe6ed;border-radius:12px;margin:20px 0;overflow:auto}}table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{padding:10px;text-align:left;border-bottom:1px solid #e4eaf0}}.muted{{color:#687a8e}}.verdict{{border-left:5px solid #956547}}.cards{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}}.card{{background:#f0f5f4;padding:16px;border-radius:8px}}strong{{display:block;font-size:26px}}a{{color:#246baf}}@media(max-width:700px){{.cards{{grid-template-columns:1fr}}}}</style></head><body><main>
<div class="muted">COMPANY + PRICE · 财务信息按披露时间还原</div><h1>{summary['ticker']} · 财务状态与日线交易</h1>
<p>{summary['start']} — {summary['end']} · 目标：扣费后跑赢买入持有 · 主规则预先固定，未按结果挑选冠军</p>
<section class="verdict"><h2>{verdict}</h2><div class="cards"><div class="card">主规则累计收益<strong>{primary_stats['return_pct']:+.2f}%</strong></div><div class="card">同期买入持有<strong>{summary['full']['hold']['return_pct']:+.2f}%</strong></div><div class="card">主规则最大回撤<strong>{primary_stats['max_drawdown_pct']:.2f}%</strong></div></div>
<p>最新状态：{state} · 财务状态：{STATES[latest.FinState]} · 财务季度：{freshness}<br>{escape(latest.FinReason)}</p></section>
<section>{graph}</section><section><h2>全期比较 · 同区间同费用</h2>{metric_table(summary['full'])}</section>
<section><h2>早期：2023—2024（独立账户）</h2>{metric_table(summary['early'])}<h2>后期：2025年至数据末日（重新从相同现金开始）</h2>{metric_table(summary['late'])}
<p class="muted">未在早期拟合参数。两段均为事后历史回放；此前已看过LITE历史，后期不能称为完全未见样本。</p></section>
<section><h2>逐季收益 · 连续账户</h2>{quarterly.to_html(border=0,float_format=lambda x:f'{x:,.2f}')}</section>
<section><h2>执行与信息延迟压力测试</h2><p>费用提高至单边10 bps、滑点20 bps：主规则 {summary['cost_stress'][primary]['return_pct']:+.2f}%，持有 {summary['cost_stress']['hold']['return_pct']:+.2f}%。</p>
<p>财务信息额外延迟一个交易日：主规则 {summary['delay_stress'][primary]['return_pct']:+.2f}%，持有 {summary['delay_stress']['hold']['return_pct']:+.2f}%。所有规则和阈值保持不变。</p></section>
<section><h2>主规则完整交易</h2>{trade_html}</section>
<section><h2>财务状态变化与入场门槛</h2>{changes.to_html(border=0,float_format=lambda x:f'{x:,.2f}')}
<p class="muted">首行是回测起点的已知状态，不代表该日新公布财报。同比变化来自当时可见版本，现金流为连续四个财务季度之和。</p></section>
<section><h2>规则与数据边界</h2><ul>{rule_html}</ul>
<p>改善状态要求营收季度同比为正、毛利率同比不下降、TTM自由现金流为正。转差要求营收与毛利率同比同时下降。其他完整数据为中性；数据缺失/冲突为未知，最新季度期末超过180日为过期。自由现金流=经营现金流−资本支出。累计现金流先差分为单季，第四季度由全年减前三季度得到，再汇总连续四季。</p>
<p>只读取交易信号日前已披露的版本。采用披露日期与美东接受日期较晚者，之后首个交易日收盘才可使用；买卖均下一交易日开盘加滑点成交。同优先级数值冲突保留为空。原始事实、计算依赖、逐日财务状态、交易及净值全部保存，来源可追溯。覆盖率：{summary['coverage_pct']:.2f}%（可判定财务状态的回测交易日）。</p>
<p>默认单边手续费5 bps＋滑点5 bps；全仓做多，无杠杆，不计现金利息。复权OHLC按复权等价单位模拟，不另加股息；期末未强行平仓。未建模税费、流动性、停牌或退市成交限制。财务数据来自现有工作台的SEC标准化事实，本次未逐份人工核对原始财报；企业自定义标签、并购口径变化和缺失标签可能影响可比性。</p>
<p>本版未接入历史覆盖不足的盈利预期、新闻评分或逐笔资金，也未使用当前研报评分回填过去。财务信息更多不等于已证明收益优势。</p>
<p>最新计算依据：{links or '见 financial_snapshot.json 中的 source_url 与 filed_at'}。</p>
<p>数据规则参考：<a href="https://www.sec.gov/search-filings/edgar-application-programming-interfaces">SEC XBRL 数据说明</a>；<a href="https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/backtesting-and-simulation">CFA 回测方法说明</a>。</p></section></main></body></html>'''
    path=output/f"{summary['ticker']}_fundamental_report.html"
    path.write_text(html,encoding='utf-8')
    return path,verdict


def run(args):
    ticker=args.ticker.strip().upper()
    if not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,14}',ticker):
        raise ValueError('请输入单只美股代码')
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    protocol=json.loads((HERE/'financial_protocol.json').read_text())
    snapshot=json.loads(args.snapshot.read_text()) if args.snapshot else read_snapshot(args.database,ticker)
    if snapshot['ticker']!=ticker:
        raise ValueError('财务快照股票与命令行代码不一致')
    bars=validate_bars(pd.read_csv(args.input,index_col='Date'))
    bars.to_csv(output/'price_snapshot.csv',encoding='utf-8-sig')
    snapshot_text=json.dumps(snapshot,ensure_ascii=False,indent=2,allow_nan=False)
    (output/'financial_snapshot.json').write_text(snapshot_text,encoding='utf-8')
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
    data,audit=enriched(bars,snapshot)
    data.to_csv(output/'financial_daily.csv',encoding='utf-8-sig')
    audit['backtest_state_counts']=data.loc[protocol['full_start']:].FinState.value_counts().to_dict()
    (output/'data_audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8')
    config=Config()
    full,curves,trades=compare(data,protocol['full_start'],config)
    early,_,_=compare(data.loc[data.index<pd.Timestamp(protocol['late_start'])],protocol['full_start'],config)
    late,late_curves,late_trades=compare(data,protocol['late_start'],config)
    cost,_,_=compare(data,protocol['full_start'],Config(fee_bps=10,slippage_bps=20))
    delayed,_=enriched(bars,snapshot,delay=1)
    delayed_stats,_,_=compare(delayed,protocol['full_start'],config)
    quarterly=quarter_returns(curves,config.initial_cash)
    quarterly['excess_return_pp']=quarterly[protocol['primary_rule']]-quarterly['hold']
    for name,curve in curves.items():
        detail=data.loc[curve.index].join(curve,rsuffix='_ledger')
        detail.to_csv(output/f'{name}_daily.csv',encoding='utf-8-sig')
        trades[name].to_csv(output/f'{name}_trades.csv',index=False,encoding='utf-8-sig')
        late_curves[name].to_csv(output/f'{name}_late_daily.csv',encoding='utf-8-sig')
    primary=protocol['primary_rule']
    index=curves[primary].index
    summary=dict(ticker=ticker,start=str(index[0].date()),end=str(index[-1].date()),
                 generated_at=datetime.now(ZoneInfo('UTC')).isoformat(),config=config.__dict__,
                 snapshot_sha256=sha256(snapshot_text.encode()).hexdigest(),
                 price_sha256=sha256(args.input.read_bytes()).hexdigest(),
                 protocol_sha256=sha256((HERE/'financial_protocol.json').read_bytes()).hexdigest(),
                 full=full,early=early,late=late,cost_stress=cost,delay_stress=delayed_stats,
                 quarterly=json.loads(quarterly.reset_index().to_json(orient='records')),
                 coverage_pct=float(data.loc[index].FinState.isin(['EXPANSION','NEUTRAL','DETERIORATION']).mean()*100),
                 _snapshot=snapshot)
    path,verdict=report(data,curves,trades,summary,protocol,output)
    summary.pop('_snapshot');summary['verdict']=verdict
    (output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    print('报告：',path)
    print('财务覆盖率：',summary['coverage_pct'])
    print(pd.DataFrame(full).T[['return_pct','excess_return_pp','max_drawdown_pct','closed_trades']].to_string())
    print('后期主规则：',late[primary])
    print(verdict)
    return summary


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ticker',default='LITE')
    parser.add_argument('--database',type=Path,default=HERE.parent/'data/research.sqlite')
    parser.add_argument('--input',type=Path,default=HERE/'reports/LITE_input.csv')
    parser.add_argument('--snapshot',type=Path,help='使用冻结财务快照，完全离线重放')
    parser.add_argument('--output',type=Path,default=HERE/'reports/fundamental')
    args=parser.parse_args()
    try:
        run(args)
    except (ValueError,OSError) as exc:
        parser.exit(2,f'错误：{exc}\n')
