"""Fixed financial-cycle hypotheses with explicit, strict benchmark acceptance."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
from html import escape
import json
import math
from pathlib import Path
import sqlite3

import pandas as pd

from conviction_research import attribution, conviction_policy
from fundamental_strategy import enriched
from inflection_research import operating_signals
from research import metrics, simulate
from strategy import Config, HERE, validate_bars

NAMES={'cycle_turn':'财务拐点（主假设）','cycle_price':'财务拐点＋价格确认',
       'cycle_relative':'财务拐点＋同业确认','conviction_exit':'上一轮延长持有','hold':'买入持有'}
NEW_RULES=('cycle_turn','cycle_price','cycle_relative')
SECTIONS=('full','early','late','cost_stress','delay_1','delay_2')


def peer_snapshot(database, end):
    with sqlite3.connect(f'file:{database.resolve()}?mode=ro',uri=True) as connection:
        connection.row_factory=sqlite3.Row
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        rows=connection.execute('''SELECT ticker,trade_date,close,adjusted_close,provider
                                   FROM prices_daily WHERE ticker IN ('CIEN','COHR')
                                   AND provider='yahoo' AND trade_date<=? ORDER BY trade_date,ticker''',(end,)).fetchall()
    return dict(captured_at=datetime.now(timezone.utc).isoformat(),database=str(database.resolve()),
                tickers=['CIEN','COHR'],rows=[dict(row) for row in rows],
                note='历史复权收盘价；当前供应商版本；名单按当前已有数据选择，未证明历史选股可重复')


def add_peers(data, snapshot):
    rows=pd.DataFrame(snapshot['rows'])
    if rows.empty or rows.duplicated(['ticker','trade_date']).any():
        raise ValueError('同业快照为空或有重复日期')
    rows['trade_date']=pd.to_datetime(rows.trade_date)
    rows['adjusted_close']=pd.to_numeric(rows.adjusted_close,errors='raise')
    if not rows.adjusted_close.map(math.isfinite).all() or (rows.adjusted_close<=0).any():
        raise ValueError('同业复权价格缺失或非正')
    prices=rows.pivot(index='trade_date',columns='ticker',values='adjusted_close').reindex(data.index)
    if not {'CIEN','COHR'}.issubset(prices.columns):
        raise ValueError('缺少指定同业')
    result=data.copy()
    peer_returns=prices[['CIEN','COHR']].pct_change(20,fill_method=None)
    # No lookahead or forward fill. Require all 21 aligned sessions for each peer.
    valid=prices[['CIEN','COHR']].notna().rolling(21).sum().eq(21).all(axis=1)
    result['PeerReturn20']=peer_returns.mean(axis=1,skipna=False).where(valid)
    result['RelativeReturn20']=data.Close.pct_change(20,fill_method=None)-result.PeerReturn20
    return result


def cycle_policy(row, rule, holding, stop):
    if rule not in NEW_RULES:
        return conviction_policy(row,rule,holding,stop)
    ready, improving, worsening=operating_signals(row,'inflection')
    if holding:
        if not ready and row.Close<row.SMA:
            return 'SELL','财务数据不可用或过期，收盘低于SMA60'
        if ready and worsening:
            return 'SELL','营收与毛利率的改善速度均转负'
    elif ready and improving:
        if rule=='cycle_price' and not row.Close>row.EMA:
            return '',''
        if rule=='cycle_relative' and not (pd.notna(row.RelativeReturn20) and row.RelativeReturn20>0):
            return '',''
        return 'BUY',NAMES[rule]+'：两项经营改善速度均为正'
    return '',''


def compare(data,start,config):
    stats,curves,trades={},{},{}
    for name in NAMES:
        curves[name],trades[name]=simulate(data,start,name,config,policy=cycle_policy)
        stats[name]=metrics(curves[name],trades[name],config.initial_cash)
        buys=curves[name].index[curves[name].Fill=='BUY']
        sells=curves[name].index[curves[name].Fill=='SELL']
        durations=[(sells[i]-buy).days if i<len(sells) else (curves[name].index[-1]-buy).days
                   for i,buy in enumerate(buys)]
        stats[name]['entries']=len(buys)
        stats[name]['longest_hold_calendar_days']=max(durations,default=0)
        stats[name]['open_entry_date']=str(buys[-1].date()) if len(buys)>len(sells) else None
    for values in stats.values():
        values['excess_return_pp']=values['return_pct']-stats['hold']['return_pct']
        values['beats_hold']=bool(values['excess_return_pp']>1e-8)
    return stats,curves,trades


def acceptance(result):
    return {name:dict(checks={s:bool(result[s][name]['beats_hold']) for s in SECTIONS},
                      all_historical_checks_pass=all(result[s][name]['beats_hold'] for s in SECTIONS),
                      future_edge_verified=False)
            for name in NEW_RULES}


def rolling(data,start):
    records=[]
    for _,group in data.loc[start:].groupby(data.loc[start:].index.to_period('M')):
        first=group.index[0]
        end=first+pd.DateOffset(years=1)
        if end>data.index[-1]:break
        values,_,_=compare(data.loc[data.index<end],str(first.date()),Config())
        for name in NAMES:
            records.append(dict(start=str(first.date()),end=str(data.index[data.index<end][-1].date()),
                                rule=name,excess_return_pp=values[name]['excess_return_pp']))
    return pd.DataFrame(records)


def report(data,curves,trades,result,protocol,output):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    primary=protocol['primary_rule']
    fig=make_subplots(rows=3,cols=1,shared_xaxes=True,row_heights=[.45,.20,.35],vertical_spacing=.07,
                      subplot_titles=['财务拐点主假设 · 日K买卖点','当时可见的经营改善速度（百分点）','净值对照（对数刻度）'])
    view=data.loc[curves[primary].index]
    x=view.index.strftime('%Y-%m-%d').tolist()
    fig.add_trace(go.Candlestick(x=x,open=view.Open.tolist(),high=view.High.tolist(),low=view.Low.tolist(),
                                 close=view.Close.tolist(),name='LITE复权日K'),row=1,col=1)
    signal_traces={}
    for name in NEW_RULES:
        signal_traces[name]=[]
        for side,color,symbol,label in [('BUY','#168774','triangle-up','买'),('SELL','#cf4562','triangle-down','卖')]:
            for field in ['Signal','Fill']:
                part=curves[name].loc[curves[name][field]==side]
                signal_traces[name].append(len(fig.data))
                fig.add_trace(go.Scatter(x=part.index.strftime('%Y-%m-%d').tolist(),
                                         y=(part.FillPrice if field=='Fill' else view.loc[part.index].Close).tolist(),
                                         name=label+('成交' if field=='Fill' else '信号'),mode='markers',visible=name==primary,
                                         text=part.Reason.tolist() if field=='Signal' else ['前日收盘信号，今日开盘加不利滑点']*len(part),
                                         hovertemplate='%{x}<br>%{y:.2f}<br>%{text}<extra></extra>',
                                         marker=dict(color=color,size=13 if field=='Fill' else 9,
                                                     symbol=symbol if field=='Fill' else 'circle-open')),row=1,col=1)
    for col,label in [('RevenueAcceleration','营收同比增速变化'),('GrossMarginYoYAcceleration','毛利率同比变化的变化')]:
        fig.add_trace(go.Scatter(x=x,y=(view[col]*100).tolist(),name=label,line=dict(shape='hv')),row=2,col=1)
    for name in NAMES:
        fig.add_trace(go.Scatter(x=x,y=(curves[name].Equity/100000).tolist(),name=NAMES[name],
                                 line=dict(width=3 if name in (primary,'hold') else 1.5)),row=3,col=1)
    fig.update_yaxes(type='log',row=3,col=1,tickmode='array',tickvals=[.2,.5,1,2,5,10,20,50],
                     ticktext=['0.2','0.5','1','2','5','10','20','50'])
    fig.update_xaxes(rangeslider_visible=False,rangebreaks=[dict(bounds=['sat','mon'])])
    fig.update_layout(height=1050,template='plotly_white',hovermode='x unified',
                       legend=dict(orientation='h',y=1.15),margin=dict(l=55,r=25,t=155,b=40))
    buttons=[]
    for name in NEW_RULES:
        visible=[True]*len(fig.data)
        for candidate,indices in signal_traces.items():
            for index in indices:visible[index]=candidate==name
        buttons.append(dict(label=NAMES[name],method='update',args=[{'visible':visible},
                       {'annotations[0].text':NAMES[name]+' · 日K买卖点'}]))
    fig.update_layout(updatemenus=[dict(buttons=buttons,direction='down',x=1,xanchor='right',y=1.06,yanchor='bottom')])
    graph=fig.to_html(full_html=False,include_plotlyjs=True,config={'responsive':True,'displaylogo':False})
    def table(section):
        frame=pd.DataFrame([{'规则':NAMES[n],'净收益 %':v['return_pct'],'超额百分点':v['excess_return_pp'],
                              '最大回撤 %':v['max_drawdown_pct'],'完整买卖':v['closed_trades'],
                              '区间验收':'基准' if n=='hold' else ('通过' if v['beats_hold'] else '未通过')} for n,v in result[section].items()])
        return frame.to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')
    main=result['full'][primary]
    verdict='主假设全期历史净收益超过持有' if main['beats_hold'] else '主假设全期历史净收益仍未超过持有'
    checks=pd.DataFrame({NAMES[n]:{'全期':a['checks']['full'],'早期':a['checks']['early'],
                                      '后期':a['checks']['late'],'成本压力':a['checks']['cost_stress'],
                                      '信息延迟1日':a['checks']['delay_1'],'信息延迟2日':a['checks']['delay_2'],
                                      '全部历史检查':a['all_historical_checks_pass']} for n,a in result['acceptance'].items()}).T
    checks=checks.map(lambda v:'通过' if v else '未通过')
    windows=pd.DataFrame(result['rolling_summary']).T.rename(index=NAMES,columns={
        'windows':'窗口数','wins':'胜过持有次数','median_excess_pp':'超额中位数 pp'})
    ledger=trades[primary]
    ledger_html=ledger.to_html(index=False,border=0) if len(ledger) else '<p>主假设没有已平仓交易，尚无完整退出案例；不能据此宣称买卖周期已经验证。</p>'
    rules=''.join(f'<p><b>{NAMES[n]}</b>：{escape(t)}。</p>' for n,t in protocol['rules'].items())
    gaps=pd.DataFrame(result['attribution'][primary]['gaps']).rename(columns={'cash_from':'空仓开始','cash_to':'空仓结束',
        'end_mark':'结束口径','market_return_pct':'期间股价涨跌 %','relative_log_pp':'相对对数贡献×100'})
    html=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LITE 财务拐点验收</title>
<style>body{{margin:0;background:#f2f5f8;color:#24384d;font:15px/1.75 -apple-system,"PingFang SC",sans-serif}}main{{max-width:1320px;margin:32px auto;padding:0 22px}}section{{background:white;border:1px solid #dfe6ed;border-radius:12px;padding:24px;margin:20px 0;overflow:auto}}h1{{font-size:30px}}h2{{font-size:20px}}table{{width:100%;border-collapse:collapse;font-size:13px}}td,th{{text-align:left;padding:10px;border-bottom:1px solid #e5eaf0}}.muted{{color:#637990}}.verdict{{border-left:5px solid #916044}}a{{color:#246dba}}</style></head><body><main>
<div class="muted">第四轮 · 严格比较扣费净收益 · 探索性历史研究</div><h1>LITE · 财务拐点与同业确认</h1><p>{result['start']} — {result['end']} · {escape(protocol['status'])}</p>
<section class="verdict"><h2>{verdict}</h2><p>主假设 {main['return_pct']:+.2f}%，持有 {result['full']['hold']['return_pct']:+.2f}%，相差 {main['excess_return_pp']:+.2f}个百分点。最大回撤 {main['max_drawdown_pct']:.2f}%。</p>
<p>共买入{main['entries']}次，完成买卖{main['closed_trades']}次，最长持有{main['longest_hold_calendar_days']}个自然日（含未平仓仓位）。当前未平仓买入日期：{main['open_entry_date'] or '无'}。</p>
<p>跨区间严格验收：{'通过' if result['acceptance'][primary]['all_historical_checks_pass'] else '未通过'}；未来优势尚未验证。不能把全期通过解释为任意买入时间都能跑赢，也不能将长期持仓视为已验证的日线波段。</p></section>
<section><h2>逐项验收：净收益必须严格大于持有</h2>{checks.to_html(border=0)}<p>相同收益也不算通过。主假设在计算结果前固定；其他候选不替换主假设。</p></section>
<section><p>图表右上角可切换三条候选规则的买卖点。空心圆为信号、三角形为下一交易日成交。</p>{graph}</section><section><h2>全期 · 同资金同成本</h2>{table('full')}</section>
<section><h2>早期2023—2024</h2>{table('early')}<h2>后期2025年至末日</h2>{table('late')}<p>各段独立从现金开始。持有首日开盘买入，策略首日收盘开始判断；两者均扣费。后期已被观察，不是未见样本。</p></section>
<section><h2>成本提高</h2>{table('cost_stress')}<h2>财务信息再延迟1个交易日</h2>{table('delay_1')}<h2>再延迟2个交易日</h2>{table('delay_2')}</section>
<section><h2>{result['rolling_summary'][primary]['windows']}个完整滚动12个月窗口（重叠）</h2>{windows.to_html(border=0,float_format=lambda v:f'{v:.2f}')}<p>每月首个交易日独立从现金开始；重叠窗口不能用作独立统计样本或未来胜率。</p></section>
<section><h2>主假设超额来源</h2>{gaps.to_html(index=False,border=0,float_format=lambda v:f'{v:.4f}')}<p>对数贡献只用于严格归因，不能当作普通收益百分点；已用零成本回放验证守恒。</p><h2>主假设完整买卖记录</h2>{ledger_html}</section>
<section><h2>规则和数据</h2>{rules}<p>{escape(protocol['missing_policy'])}</p><p>{escape(protocol['scope'])}</p><p>{escape(protocol['design'])}</p><p>{escape(protocol['timing'])}</p>
<p>财务沿用895条事实快照，同业CIEN和COHR来自本地数据库的Yahoo历史复权价格，仅作信号，不交易同业。不回填同业缺失日。没有增加资金、使用杠杆或改变持有基准。</p>
<p><a href="protocol.json">固定协议</a> · <a href="summary.json">完整统计</a> · <a href="../conviction/LITE_conviction_report.html">上一轮报告</a></p></section></main></body></html>'''
    path=output/'LITE_cycle_report.html';path.write_text(html,encoding='utf-8')
    return path


def run(input_dir,output,database,peer_input=None):
    output.mkdir(parents=True,exist_ok=True)
    protocol_file=HERE/'cycle_protocol.json'
    protocol=json.loads(protocol_file.read_text())
    source,price_file=input_dir/'financial_snapshot.json',input_dir/'price_snapshot.csv'
    snapshot=json.loads(source.read_text())
    if snapshot['ticker']!='LITE':raise ValueError('本轮协议仅适用于LITE')
    bars=validate_bars(pd.read_csv(price_file,index_col='Date'))
    peers=json.loads(peer_input.read_text()) if peer_input else peer_snapshot(database,str(bars.index[-1].date()))
    (output/'peer_snapshot.json').write_text(json.dumps(peers,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    data,_=enriched(bars,snapshot)
    data=add_peers(data,peers)
    start,late_start=protocol['full_start'],protocol['late_start']
    full,curves,trades=compare(data,start,Config())
    early,_,_=compare(data.loc[data.index<pd.Timestamp(late_start)],start,Config())
    late,late_curves,_=compare(data,late_start,Config())
    stress,_,_=compare(data,start,Config(fee_bps=10,slippage_bps=20))
    delays={}
    for delay in (1,2):
        delayed,_=enriched(bars,snapshot,delay)
        delays[f'delay_{delay}'],_,_=compare(add_peers(delayed,peers),start,Config())
    _,zero,_=compare(data,start,Config(fee_bps=0,slippage_bps=0))
    attrs={n:attribution(data,curves[n],curves['hold'],zero[n],zero['hold']) for n in NAMES}
    windows=rolling(data,start)
    window_stats={n:dict(windows=len(g),wins=int((g.excess_return_pp>1e-8).sum()),median_excess_pp=float(g.excess_return_pp.median())) for n,g in windows.groupby('rule',sort=False)}
    result=dict(start=str(curves['hold'].index[0].date()),end=str(curves['hold'].index[-1].date()),
                full=full,early=early,late=late,cost_stress=stress,**delays,attribution=attrs,
                rolling_summary=window_stats,protocol_sha256=sha256(protocol_file.read_bytes()).hexdigest(),
                financial_sha256=sha256(source.read_bytes()).hexdigest(),prices_sha256=sha256(price_file.read_bytes()).hexdigest(),
                peers_sha256=sha256((output/'peer_snapshot.json').read_bytes()).hexdigest())
    result['acceptance']=acceptance(result)
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    for n in NAMES:
        data.loc[curves[n].index].join(curves[n],rsuffix='_ledger').to_csv(output/f'{n}_daily.csv',encoding='utf-8-sig')
        trades[n].to_csv(output/f'{n}_trades.csv',index=False,encoding='utf-8-sig')
        late_curves[n].to_csv(output/f'{n}_late_daily.csv',encoding='utf-8-sig')
    windows.to_csv(output/'rolling_12m.csv',index=False,encoding='utf-8-sig')
    path=report(data,curves,trades,result,protocol,output)
    print('报告：',path)
    print(pd.DataFrame(full).T[['return_pct','excess_return_pp','max_drawdown_pct','closed_trades','longest_hold_calendar_days']].to_string())
    print('后期：',json.dumps({n:v['return_pct'] for n,v in late.items()}))
    print('验收：',json.dumps(result['acceptance'],ensure_ascii=False))
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir',type=Path,default=HERE/'reports/fundamental')
    parser.add_argument('--output',type=Path,default=HERE/'reports/cycle')
    parser.add_argument('--database',type=Path,default=HERE.parent/'data/research.sqlite')
    parser.add_argument('--peer-snapshot',type=Path)
    args=parser.parse_args()
    run(args.input_dir,args.output,args.database,args.peer_snapshot)
