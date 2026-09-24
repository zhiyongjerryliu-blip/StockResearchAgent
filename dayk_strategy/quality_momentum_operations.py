"""Human-readable operations ledger for the frozen full-period primary account."""
import json
from html import escape

import pandas as pd

from strategy import HERE


def run():
    root=HERE/'reports/quality_momentum';folder=root/'full'
    selections=pd.read_csv(folder/'quality_momentum_selections.csv')
    trades=pd.read_csv(folder/'quality_momentum_trades.csv')
    holdings=pd.read_csv(folder/'quality_momentum_holdings.csv')
    daily=pd.read_csv(folder/'quality_momentum_daily.csv').set_index('Date')
    summary=json.loads((root/'summary.json').read_text())
    stats=summary['results']['full']['stats']['quality_momentum']
    old=set();rows=[];details=[];changes=0
    for _,s in selections.iterrows():
        if not s.executes_in_window:continue
        target=json.loads(s.target);new=set(target);day=s.next_fill_date
        entry,exit_=new-old,old-new
        replaced=bool(old and new!=old);changes+=int(replaced)
        operation='首次建仓' if not old else ('更换股票＋恢复等权' if replaced else '原三只恢复等权')
        rows.append({'信号日':s.signal_date,'成交日':day,'操作':operation,
                     '全部卖出':', '.join(sorted(exit_)) or '—','新建仓':', '.join(sorted(entry)) or '—',
                     '调仓后持有':', '.join(sorted(new)),'目标比例':'各33.33%',
                     '当日收盘账户美元':float(daily.loc[day,'Equity'])})
        event=trades[trades.date==day].copy()
        event['操作']=[('全部卖出' if r.ticker in exit_ else '减持再平衡') if r.fill=='SELL' else ('新建仓' if r.ticker in entry else '增持再平衡') for _,r in event.iterrows()]
        event['成交金额美元']=event.delta_units.abs()*event.price
        event['现金变化美元']=-event.delta_units*event.price-event.fee
        event=event.rename(columns={'ticker':'股票','delta_units':'复权单位变化','price':'含滑点复权价格','fee':'手续费美元','slippage_cost':'已含滑点美元'})
        view=event[['股票','操作','复权单位变化','含滑点复权价格','成交金额美元','手续费美元','已含滑点美元','现金变化美元']]
        details.append(f'<details><summary>{day} · {operation} · {escape(", ".join(sorted(new)))}</summary><p>信号日：{s.signal_date}。价格为次日开盘复权价格加不利滑点；滑点已含在价格中，不能重复扣除。</p>{view.to_html(index=False,border=0,float_format=lambda v:f"{v:,.4f}")}</details>')
        old=new
    timeline=pd.DataFrame(rows)
    changed=timeline[timeline['操作']!='原三只恢复等权']
    ending=holdings[holdings.Date==holdings.Date.max()].copy()
    ending['Weight']*=100
    ending=ending.rename(columns={'Date':'日期','Ticker':'股票','Units':'剩余复权单位','Weight':'收盘仓位%'})
    final_day=daily.index[-1];terminal_cost=float(daily.Equity.iloc[-1]-daily.SettledEquity.iloc[-1])
    html=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>质量＋动量具体操作账本</title>
<style>body{{max-width:1300px;margin:28px auto;padding:0 20px;font:16px/1.7 system-ui;color:#172b4d}}table{{border-collapse:collapse;width:100%;font-size:13px}}th,td{{padding:9px;border-bottom:1px solid #dfe5ee;text-align:right}}th:first-child,td:first-child{{text-align:left}}details{{padding:12px;border:1px solid #dfe5ee;margin:10px 0;overflow:auto}}summary{{cursor:pointer;font-weight:600}}.table{{overflow:auto}}</style>
<h1>质量＋动量：这笔回测资金怎样操作</h1><p>对应2023-01-03至2026-09-18、初始10万美元、累计收益{stats['return_pct']:,.2f}%的主规则账户。其他开始日期是独立账户，不能把其成交数量和本账本混用。所有内容均为模拟，未向券商发送订单。</p>
<p>开始日和之后每个月最后交易日收盘，按当时可用的质量与动量排名选3只；下一交易日开盘卖出不再入选的股票，并把入选股票调整到扣费后账户各1/3。仍入选的股票只买卖差额，不全部清仓重买。月内不根据涨跌主动止盈或止损，仓位随价格漂移，观察到的最大单股收盘占比为{holdings.Weight.max()*100:.2f}%。</p>
<p>共{trades.date.nunique()}个成交日（首次建仓＋月度调整），{len(trades)}条单股成交记录；其中{changes}次更换入选股票，其余调整为恢复等权。以下时间为美股交易日期。</p>
<h2>股票成员发生变化的全部日期</h2><div class="table">{changed.to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')}</div>
<h2>全部月度操作（包含不换股票的再平衡）</h2><div class="table">{timeline.to_html(index=False,border=0,float_format=lambda v:f'{v:,.2f}')}</div>
<h2>逐日成交明细：展开查看数量、价格、金额</h2><p>数量和价格为复权等价单位，不是券商历史实际股数或原始报价。支持小数单位；没有整数股约束。买卖每边手续费5bps、滑点5bps，现金无利息，不追加资金、不加杠杆。总成交手续费（不含期末评估清仓）为{trades.fee.sum():,.2f}美元，模拟滑点成本为{trades.slippage_cost.sum():,.2f}美元。</p>{''.join(details)}
<h2>期末持仓与收益结算</h2>{ending.to_html(index=False,border=0,float_format=lambda v:f'{v:,.4f}')}<p>{final_day}不是月末换仓日，策略本身没有产生清仓信号。期末按收盘估值为{daily.Equity.iloc[-1]:,.2f}美元；为统一比较，额外估算全部卖出的滑点和手续费{terminal_cost:,.2f}美元，得到{daily.SettledEquity.iloc[-1]:,.2f}美元，即初始10万美元的{daily.SettledEquity.iloc[-1]/100000:.4f}倍，净收益{stats['return_pct']:,.2f}%。期末评估清仓未计入上述157条策略成交记录。</p>
<p>新上市SNDK必须有足够行情及已披露财务数据，实际在2026-03-02才首次入选成交。这是现有六股池的事后研究，不能据此当作未来操作指令。</p>
<p><a href="full/quality_momentum_trades.csv">原始逐笔成交账本</a> · <a href="full/quality_momentum_holdings.csv">逐日持仓账本</a> · <a href="quality_momentum_report.html">研究报告</a></p></html>'''
    path=root/'quality_momentum_operations.html';path.write_text(html,encoding='utf-8')
    print(path)
    print(json.dumps(dict(trade_dates=int(trades.date.nunique()),fills=len(trades),composition_changes=changes,
                          terminal_mark=float(daily.Equity.iloc[-1]),terminal_exit_cost=terminal_cost,
                          terminal_cash=float(daily.SettledEquity.iloc[-1])),ensure_ascii=False))


if __name__=='__main__':run()
