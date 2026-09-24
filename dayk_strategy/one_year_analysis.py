"""Frozen-rule horizon comparison; no rule or parameter selection on these windows."""
import json
from hashlib import sha256

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from integrated_research import build_data
from recovery_research import compare
from strategy import Config, HERE


def liquidate(curve, prices, config):
    """Predeclared terminal close liquidation, distinct from next-open signals.

    Deduct slippage and sale fee only from remaining stock, never from cash.
    Do not count this evaluation-only sale as a tactical exit/rebuy cycle.
    """
    result = curve.copy()
    last = result.index[-1]
    mark = float(result.Units.iloc[-1] * prices.loc[last, 'Close'])
    proceeds = mark * (1 - config.slippage_bps / 10000) * (1 - config.fee_bps / 10000)
    cost = mark - proceeds
    result.loc[last, 'Equity'] -= cost
    return result, cost


def holding_intervals(curve):
    rows = []
    entry = None
    for date, row in curve.iterrows():
        if row.Fill == 'BUY':
            entry = date
        elif row.Fill == 'SELL' and entry is not None:
            rows.append(dict(entry=str(entry.date()), exit=str(date.date()),
                             calendar_days=(date-entry).days, status='已平仓'))
            entry = None
    if entry is not None:
        rows.append(dict(entry=str(entry.date()), exit=str(curve.index[-1].date()),
                         calendar_days=(curve.index[-1]-entry).days, status='期末仍持有'))
    return rows


def run():
    output = HERE / 'reports/one_year'
    output.mkdir(parents=True, exist_ok=True)
    inputs = [HERE/'reports/integrated/stockresearch_snapshot.json',
              HERE/'reports/integrated/stockresearch_flow.json']
    data = build_data(*[json.loads(p.read_text()) for p in inputs])
    config = Config()
    results = []
    for end_year in (2024, 2025, 2026):
        start, end = f'{end_year-1}-09-18', f'{end_year}-09-18'
        # Full prehistory remains available to indicators; account and policy reset.
        frame = data.loc[:end]
        stats, curves, trades, ledgers = compare(
            frame, start, config, names={'baseline': '原全仓破低波段'})
        row = dict(start=str(curves['hold'].index[0].date()), end=str(curves['hold'].index[-1].date()),
                   sessions=len(curves['hold']), mark_to_close_stats=stats,
                   tactical_rebuy_cycles=stats['candidates']['baseline']['reduction_increase_cycles'])
        settled = {}
        folder = output / str(end_year)
        folder.mkdir(exist_ok=True)
        for key in ('hold', 'baseline', 'baseline_aligned'):
            settled[key], cost = liquidate(curves[key], frame, config)
            row[key] = dict(return_pct=float((settled[key].Equity.iloc[-1]/config.initial_cash-1)*100),
                            terminal_equity=float(settled[key].Equity.iloc[-1]), terminal_exit_cost=cost,
                            max_drawdown_pct=float((settled[key].Equity / settled[key].Equity.cummax().clip(lower=config.initial_cash)-1).min()*100))
            curves[key].to_csv(folder/f'{key}_mark_daily.csv')
            settled[key].Equity.rename('LiquidatedEquity').to_csv(folder/f'{key}_settled_equity.csv')
        trades['baseline'].to_csv(folder/'strategy_trades.csv', index=False)
        ledgers['baseline'].to_csv(folder/'strategy_rebuys.csv', index=False)
        hold, strategy = row['hold']['return_pct'], row['baseline']['return_pct']
        row.update(excess_pp=strategy-hold, profit_multiple=strategy/hold if hold>0 else None,
                   target_return_pct=1.5*hold if hold>0 else None,
                   target_pass=bool(hold>0 and strategy>=1.5*hold))
        results.append(row)

    # Check both closed positions and the still-open position, from a fresh full replay.
    _, full_curves, _, _ = compare(data, '2023-01-03', config, names={'baseline': '原全仓破低波段'})
    intervals = holding_intervals(full_curves['baseline'])
    cap = dict(max_closed_calendar_days=max(r['calendar_days'] for r in intervals if r['status']=='已平仓'),
               max_including_open_calendar_days=max(r['calendar_days'] for r in intervals),
               intervals=intervals,
               any_one_year_anniversary_reached=any(pd.Timestamp(r['exit']) >= pd.Timestamp(r['entry'])+pd.DateOffset(years=1) for r in intervals))
    protocol = dict(rule='原全仓破低波段：使用之前全期表现最好的固定规则，不按一年窗口重新选优',
                    start='每个窗口独立从10万美元现金开始，不继承早期持仓或策略状态；指标保留预热历史',
                    timing='策略收盘信号、下一交易日开盘成交；基准期初开盘买入',
                    end='双方在预先规定的区间末收盘估算清仓，未持股者不重复扣费；强制清仓不计入波段次数',
                    costs='每边手续费5bps、滑点5bps；现金无利息，不计税，无杠杆',
                    interpretation='一年投资区间不同于单笔持仓上限；年份窗口共享边界日期，不可连乘',
                    validation='冻结历史数据的事后区间诊断，并非独立样本外结果；未重新优化规则')
    summary = dict(protocol=protocol, windows=results, holding_cap_audit=cap,
                   input_hashes={str(p.relative_to(HERE)):sha256(p.read_bytes()).hexdigest() for p in inputs},
                   code_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in [HERE/'one_year_analysis.py',HERE/'recovery_research.py',HERE/'research.py']})
    (output/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False))
    table = pd.DataFrame([{'一年区间':r['start']+' → '+r['end'], '波段收益%':r['baseline']['return_pct'],
                           '买入持有收益%':r['hold']['return_pct'], '超额百分点':r['excess_pp'],
                           '利润倍数':r['profit_multiple'], '卖出再买回次数':r['tactical_rebuy_cycles'],
                           '达到1.5倍利润':'是' if r['target_pass'] else '否'} for r in results])
    latest = results[-1]
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True, row_heights=[.55,.45], vertical_spacing=.08)
    bars = data.loc[curves['hold'].index]
    fig.add_trace(go.Candlestick(x=bars.index, open=bars.Open, high=bars.High, low=bars.Low, close=bars.Close, name='LITE复权日K'), row=1,col=1)
    for side,color,symbol in [('BUY','#087f5b','triangle-up'),('SELL','#c92a2a','triangle-down')]:
        points=curves['baseline'].loc[curves['baseline'].Fill==side]
        fig.add_trace(go.Scatter(x=points.index,y=points.FillPrice,mode='markers',name='策略买入' if side=='BUY' else '策略卖出',marker=dict(color=color,size=11,symbol=symbol)),row=1,col=1)
    for key,name in [('baseline','波段'),('hold','买入持有'),('baseline_aligned','同首次买入日持有')]:
        fig.add_trace(go.Scatter(x=settled[key].index,y=settled[key].Equity,name=name),row=2,col=1)
    fig.update_layout(height=760,template='plotly_white',xaxis_rangeslider_visible=False,title='最近一年：固定规则、独立账户、期末统一清仓')
    fig.update_yaxes(title_text='复权价格',row=1,col=1)
    fig.update_yaxes(title_text='账户价值（美元）',row=2,col=1)
    paragraphs=''.join(f'<p><b>{k}</b>：{v}</p>' for k,v in protocol.items())
    html=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>LITE 一年持有期限比较</title>
<style>body{{max-width:1180px;margin:32px auto;padding:0 20px;font:16px/1.7 system-ui;color:#172b4d}}table{{border-collapse:collapse;width:100%;font-size:14px}}th,td{{padding:10px;border-bottom:1px solid #dde3eb;text-align:right}}th:first-child,td:first-child{{text-align:left}}</style>
<h1>LITE：缩短到一年会怎样</h1><p>单笔最长持有一年：既有最好规则的最长已完成持仓为{cap['max_closed_calendar_days']}个自然日，期末未平仓也未超过一年，所以当前样本的交易与收益不会变化。</p>
<p>改为最近一年投资：波段净收益{latest['baseline']['return_pct']:.2f}%，买入持有{latest['hold']['return_pct']:.2f}%，利润高{(latest['profit_multiple']-1)*100:.2f}%；目标为{latest['target_return_pct']:.2f}%，仍未达标。</p>
{table.to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')}
<p>2023—2024区间没有策略主动卖出再回补，收益差来自首次买入时点，不能算波段优势。最近一年策略首次买入为2025-09-19；同日买入持有清仓收益为{latest['baseline_aligned']['return_pct']:.2f}%。期末统一清仓不是策略产生的卖出信号。</p>
{fig.to_html(full_html=False,include_plotlyjs=True)}<h2>计算口径</h2>{paragraphs}</html>'''
    (output/'LITE_one_year_report.html').write_text(html,encoding='utf-8')
    print(table.to_string(index=False))
    print('Holding cap:',json.dumps(cap,ensure_ascii=False))
    print('Report:',output/'LITE_one_year_report.html')
    return summary


if __name__ == '__main__':
    run()
