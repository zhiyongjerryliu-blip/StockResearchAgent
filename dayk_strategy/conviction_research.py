"""Attribute missed returns and test two frozen operating-conviction hypotheses."""
from __future__ import annotations

import argparse
from hashlib import sha256
from html import escape
import json
import math
from pathlib import Path

import pandas as pd

from fundamental_strategy import enriched, quarter_returns
from inflection_research import operating_policy, operating_signals
from research import metrics, simulate
from strategy import Config, HERE, validate_bars

NAMES = {'inflection': '上一轮经营改善速度', 'no_cash_gate': '上一轮去现金流门槛',
         'conviction_exit': '经营向好时延长持有（主假设）',
         'level_or_inflection': '扩大入场＋延长持有',
         'trend60_120': '纯技术60/120', 'hold': '买入持有'}


def conviction_policy(row, rule, holding, stop):
    if rule not in ('conviction_exit', 'level_or_inflection'):
        return operating_policy(row, rule, holding, stop)
    level_ready, level_good, _ = operating_signals(row, 'no_cash_gate')
    if holding:
        if level_ready and level_good:
            return '', ''
        return operating_policy(row, 'inflection', True, stop)
    if rule == 'conviction_exit':
        return operating_policy(row, 'inflection', False, stop)
    _, inflection_good, _ = operating_signals(row, 'inflection')
    if (level_good or inflection_good) and row.Close > max(row.SMA, row.SMA120):
        return 'BUY', '经营水平或改善速度向好，且收盘高于SMA60和SMA120'
    return '', ''


def cash_gaps(data, curve):
    """Exact relative log-wealth attribution for an unlevered all-in/cash ledger.

    Uses raw adjusted opens (no slippage). Each held interval earns the same
    price return as hold. Only cash intervals and execution costs differ.
    """
    view = data.loc[curve.index]
    start, price = curve.index[0], float(view.Open.iloc[0])
    rows = []

    def record(end, end_price, terminal=False):
        ratio = float(end_price) / price
        rows.append(dict(cash_from=str(start.date()), cash_to=str(end.date()),
                         end_mark='期末收盘' if terminal else '回补开盘',
                         market_return_pct=(ratio - 1) * 100,
                         relative_log_pp=-100 * math.log(ratio)))

    for day, row in curve.iterrows():
        if row.Fill == 'SELL':
            if start is not None:
                raise ValueError('空仓期间出现卖出')
            start, price = day, float(view.loc[day, 'Open'])
        elif row.Fill == 'BUY':
            if start is None:
                raise ValueError('持仓期间出现买入')
            record(day, view.loc[day, 'Open'])
            start = None
    if start is not None:
        record(curve.index[-1], view.Close.iloc[-1], True)
    return pd.DataFrame(rows)


def attribution(data, curve, hold, zero_curve, zero_hold):
    gaps = cash_gaps(data, curve)
    relative = 100 * math.log(curve.Equity.iloc[-1] / hold.Equity.iloc[-1])
    gross_relative = 100 * math.log(zero_curve.Equity.iloc[-1] / zero_hold.Equity.iloc[-1])
    gap_total = float(gaps.relative_log_pp.sum())
    residual = gross_relative - gap_total
    if abs(residual) > 1e-8:
        raise ValueError(f'空仓归因不守恒，可能存在成本影响信号：{residual}')
    return dict(relative_wealth_ratio=float(curve.Equity.iloc[-1] / hold.Equity.iloc[-1]),
                net_relative_log_pp=relative,
                missed_rallies_log_pp=float(gaps.loc[gaps.relative_log_pp < 0, 'relative_log_pp'].sum()),
                avoided_declines_log_pp=float(gaps.loc[gaps.relative_log_pp > 0, 'relative_log_pp'].sum()),
                extra_cost_log_pp=relative - gross_relative,
                identity_residual_log_pp=residual,
                gaps=gaps.to_dict('records'))


def compare(data, start, config):
    stats, curves, trades = {}, {}, {}
    for name in NAMES:
        curves[name], trades[name] = simulate(data, start, name, config, policy=conviction_policy)
        stats[name] = metrics(curves[name], trades[name], config.initial_cash)
    for values in stats.values():
        values['excess_return_pp'] = values['return_pct'] - stats['hold']['return_pct']
    return stats, curves, trades


def rolling_windows(data, start):
    """Each month-start, independent cash start, 12 calendar months, complete only."""
    rows = []
    for _, group in data.loc[start:].groupby(data.loc[start:].index.to_period('M')):
        first = group.index[0]
        end = first + pd.DateOffset(years=1)
        if end > data.index[-1]:
            break
        part = data.loc[data.index < end]
        stats, _, _ = compare(part, str(first.date()), Config())
        for name in NAMES:
            rows.append(dict(start=str(first.date()), end=str(part.index[-1].date()), rule=name,
                             return_pct=stats[name]['return_pct'],
                             excess_return_pp=stats[name]['excess_return_pp']))
    return pd.DataFrame(rows)


def make_report(data, curves, trades, result, protocol, output):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    primary = protocol['primary_rule']
    view = data.loc[curves[primary].index]
    x = view.index.strftime('%Y-%m-%d').tolist()
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True, vertical_spacing=.10,
                        row_heights=[.6,.4], subplot_titles=['主假设日K与买卖点', '净值：同资金、同费用（对数刻度）'])
    fig.add_trace(go.Candlestick(x=x, open=view.Open.tolist(), high=view.High.tolist(),
                                 low=view.Low.tolist(), close=view.Close.tolist(), name='LITE复权日K'), row=1,col=1)
    for side, label, color, symbol in [('BUY','买入','#168774','triangle-up'),('SELL','卖出','#cf4562','triangle-down')]:
        for field in ['Signal','Fill']:
            piece=curves[primary].loc[curves[primary][field]==side]
            fig.add_trace(go.Scatter(x=piece.index.strftime('%Y-%m-%d').tolist(),
                          y=(piece.FillPrice if field=='Fill' else view.loc[piece.index].Close).tolist(),
                          mode='markers', name=label+('成交' if field=='Fill' else '信号'),
                          text=piece.Reason.tolist() if field=='Signal' else ['前日信号，开盘加不利滑点']*len(piece),
                          hovertemplate='%{x}<br>%{y:.2f}<br>%{text}<extra></extra>',
                          marker=dict(color=color,size=12 if field=='Fill' else 8,
                                      symbol=symbol if field=='Fill' else 'circle-open')),row=1,col=1)
    for name in NAMES:
        fig.add_trace(go.Scatter(x=x,y=(curves[name].Equity/100000).tolist(),name=NAMES[name],
                                 line=dict(width=3 if name in (primary,'hold') else 1.5)),row=2,col=1)
    fig.update_yaxes(type='log', row=2,col=1,tickmode='array',
                     tickvals=[.2,.5,1,2,5,10,20,50],ticktext=['0.2','0.5','1','2','5','10','20','50'])
    fig.update_xaxes(rangeslider_visible=False,rangebreaks=[dict(bounds=['sat','mon'])])
    fig.update_layout(height=870,template='plotly_white',hovermode='x unified',
                       legend=dict(orientation='h',y=1.15),margin=dict(t=150,b=35,l=55,r=30))
    def table(section):
        frame=pd.DataFrame([{'规则':NAMES[n], '累计收益 %':v['return_pct'],
                            '超额百分点':v['excess_return_pp'],'最大回撤 %':v['max_drawdown_pct'],
                            '已平仓交易':v['closed_trades'],'持仓日 %':v['exposure_pct']} for n,v in result[section].items()])
        return frame.to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')
    atr=result['attribution']['inflection']
    gaps=pd.DataFrame(atr['gaps']).rename(columns={'cash_from':'空仓开始','cash_to':'空仓结束','end_mark':'结束价格',
                                                'market_return_pct':'期间股价涨跌 %','relative_log_pp':'相对财富对数贡献 ×100'})
    rolling=pd.DataFrame(result['rolling_summary']).T
    rolling.index=rolling.index.map(NAMES)
    rolling=rolling.rename(columns={'windows':'窗口数','beats_hold':'胜过持有窗口数','median_excess_pp':'超额中位数 pp',
                                    'min_excess_pp':'最差超额 pp','max_excess_pp':'最好超额 pp'})
    ledger=trades[primary]
    trade_html=ledger[['entry_date','exit_date','return_pct','reason']].rename(columns={
        'entry_date':'买入日','exit_date':'卖出日','return_pct':'净收益 %','reason':'退出原因'
    }).to_html(index=False,border=0,float_format=lambda v:f'{v:.2f}') if len(ledger) else '<p>暂无已平仓交易。</p>'
    last=curves[primary].iloc[-1]
    status='持仓' if last.Units>0 else '空仓'
    holding_note=''
    if last.Units>0:
        last_buy=curves[primary].index[curves[primary].Fill=='BUY'][-1]
        holding_note=f'当前仓位从{last_buy.date()}持有至样本末日，已跨越{(curves[primary].index[-1]-last_buy).days}个自然日；这项改法已偏离数日至数周的波段节奏。'
    verdict='主假设历史收益超过持有，仍需未见数据验证' if result['full'][primary]['excess_return_pp']>0 else '主假设有所改善，但全期仍未超过持有'
    graph=fig.to_html(full_html=False,include_plotlyjs=True,config={'responsive':True,'displaylogo':False})
    html=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LITE 持有与空仓归因</title>
<style>body{{margin:0;background:#f2f5f8;color:#24384d;font:15px/1.75 -apple-system,"PingFang SC",sans-serif}}main{{max-width:1320px;margin:32px auto;padding:0 22px}}section{{background:white;border:1px solid #dfe6ed;border-radius:12px;padding:24px;margin:20px 0;overflow:auto}}h1{{font-size:30px}}h2{{font-size:20px}}table{{width:100%;border-collapse:collapse;font-size:13px}}td,th{{text-align:left;padding:10px;border-bottom:1px solid #e5eaf0}}.muted{{color:#637990}}.verdict{{border-left:5px solid #916044}}a{{color:#246dba}}</style></head><body><main>
<div class="muted">第三轮 · 收益归因与经营持有逻辑 · 探索性研究</div><h1>LITE · 问题主要发生在卖出以后</h1>
<p>{result['start']} — {result['end']} · {escape(protocol['status'])}</p>
<section class="verdict"><h2>{verdict}</h2><p>主假设累计收益 {result['full'][primary]['return_pct']:+.2f}%，买入持有 {result['full']['hold']['return_pct']:+.2f}%。截至样本末日为{status}，末日待执行信号：{last.Signal or '无'}。这只是历史规则状态，不是实时交易建议。</p><p>{holding_note}</p></section>
<section><h2>上一轮为什么输给持有</h2><p>旧规则最终财富仅为持有的 {atr['relative_wealth_ratio']:.2%}。按可加的相对财富对数分解：错过上涨 {atr['missed_rallies_log_pp']:.2f}，避开下跌 +{atr['avoided_declines_log_pp']:.2f}，额外成本 {atr['extra_cost_log_pp']:.2f}，合计 {atr['net_relative_log_pp']:.2f}。</p>
<p class="muted">以上对数贡献×100用于严格归因，不是累计收益百分点，不能与普通收益百分比混用。零成本回放与空仓区间之和已校验一致；每段按真实成交日开盘到开盘计量，最后空仓按期末收盘。</p>{gaps.to_html(index=False,border=0,float_format=lambda v:f'{v:.2f}')}</section>
<section>{graph}</section><section><h2>全部候选 · 全期</h2>{table('full')}</section>
<section><h2>早期2023—2024 · 独立账户</h2>{table('early')}<h2>后期2025年至末日 · 独立账户</h2>{table('late')}</section>
<section><h2>成本压力：手续费10bps＋滑点20bps（单边）</h2>{table('cost_stress')}<h2>财务可见时间额外延迟一天</h2>{table('delay_stress')}</section>
<section><h2>滚动12个月 · 每月独立现金起点</h2>{rolling.to_html(border=0,float_format=lambda v:f'{v:.2f}')}<p>只保留完整窗口；窗口互相重叠，胜出比例不是统计显著性或未来胜率。账户在每个窗口首日从现金开始，不继承已有仓位；因此与全期持有路径可能明显不同。所有窗口均属于已观察过的历史。</p></section>
<section><h2>主假设已平仓交易</h2>{trade_html}<p>期末未平仓按最后收盘估值，不纳入已平仓交易数。</p></section>
<section><h2>规则与限制</h2><p><b>延长持有：</b>{escape(protocol['rules']['conviction_exit'])}。</p><p><b>扩大入场：</b>{escape(protocol['rules']['level_or_inflection'])}。</p>
<p>{escape(protocol['timing'])}。</p><p>{escape(protocol['limitations'])}</p><p>沿用同一份895条财务事实和冻结价格，保留信息披露日期、历史修订与缺失处理。没有加入不足以覆盖历史的预期数据。</p>
<p><a href="../inflection/LITE_inflection_report.html">上一轮报告</a> · <a href="summary.json">完整统计与归因</a> · <a href="protocol.json">冻结协议</a></p></section></main></body></html>'''
    path=output/'LITE_conviction_report.html'
    path.write_text(html,encoding='utf-8')
    return path,verdict


def run(input_dir, output):
    output.mkdir(parents=True,exist_ok=True)
    protocol_path=HERE/'conviction_protocol.json'
    protocol=json.loads(protocol_path.read_text())
    source,prices=input_dir/'financial_snapshot.json',input_dir/'price_snapshot.csv'
    snapshot=json.loads(source.read_text())
    if snapshot['ticker']!='LITE':
        raise ValueError('本协议仅针对LITE')
    bars=validate_bars(pd.read_csv(prices,index_col='Date'))
    data,_=enriched(bars,snapshot)
    start,late_start=protocol['full_start'],protocol['late_start']
    full,curves,trades=compare(data,start,Config())
    early,_,_=compare(data.loc[data.index<pd.Timestamp(late_start)],start,Config())
    late,late_curves,_=compare(data,late_start,Config())
    stress,_,_=compare(data,start,Config(fee_bps=10,slippage_bps=20))
    delayed,_=enriched(bars,snapshot,1)
    delay_stats,_,_=compare(delayed,start,Config())
    _,zero_curves,_=compare(data,start,Config(fee_bps=0,slippage_bps=0))
    attrs={name:attribution(data,curves[name],curves['hold'],zero_curves[name],zero_curves['hold']) for name in NAMES}
    windows=rolling_windows(data,start)
    window_stats={n:dict(windows=len(g),beats_hold=int((g.excess_return_pp>1e-8).sum()),
                         median_excess_pp=float(g.excess_return_pp.median()),
                         min_excess_pp=float(g.excess_return_pp.min()),max_excess_pp=float(g.excess_return_pp.max()))
                  for n,g in windows.groupby('rule',sort=False)}
    quarters=quarter_returns(curves,100000)
    result=dict(start=str(curves['hold'].index[0].date()),end=str(curves['hold'].index[-1].date()),
                full=full,early=early,late=late,cost_stress=stress,delay_stress=delay_stats,
                attribution=attrs,rolling_summary=window_stats,
                quarterly=json.loads(quarters.reset_index().to_json(orient='records')),
                input_dir=str(input_dir.resolve()),snapshot_sha256=sha256(source.read_bytes()).hexdigest(),
                price_sha256=sha256(prices.read_bytes()).hexdigest(),protocol_sha256=sha256(protocol_path.read_bytes()).hexdigest())
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
    for name in NAMES:
        data.loc[curves[name].index].join(curves[name],rsuffix='_ledger').to_csv(output/f'{name}_daily.csv',encoding='utf-8-sig')
        trades[name].to_csv(output/f'{name}_trades.csv',index=False,encoding='utf-8-sig')
        late_curves[name].to_csv(output/f'{name}_late_daily.csv',encoding='utf-8-sig')
        pd.DataFrame(attrs[name]['gaps']).to_csv(output/f'{name}_cash_gaps.csv',index=False,encoding='utf-8-sig')
    windows.to_csv(output/'rolling_12m.csv',index=False,encoding='utf-8-sig')
    path,verdict=make_report(data,curves,trades,result,protocol,output)
    result['verdict']=verdict
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    print('报告：',path)
    print(pd.DataFrame(full).T[['return_pct','excess_return_pp','max_drawdown_pct','closed_trades']].to_string())
    print('后期：',json.dumps({n:v['return_pct'] for n,v in late.items()},ensure_ascii=False))
    print('滚动：',json.dumps(window_stats,ensure_ascii=False))
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir',type=Path,default=HERE/'reports/fundamental')
    parser.add_argument('--output',type=Path,default=HERE/'reports/conviction')
    args=parser.parse_args()
    run(args.input_dir,args.output)
