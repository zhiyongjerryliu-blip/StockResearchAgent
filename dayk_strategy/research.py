"""有限候选规则比较与按季度滚动选择；目标：扣费后总收益。"""
from __future__ import annotations

import argparse
from dataclasses import asdict
from html import escape
import json
from pathlib import Path

import numpy as np
import pandas as pd

from strategy import Config, HERE, indicators, validate_bars


# Frozen before looking at candidate results. No parameter grid / result-driven search.
RULES = {
    "original": "原版：EMA20>SMA60＋放量突破20日高点；EMA20或3ATR退出",
    "no_volume": "去掉量能门槛：趋势＋突破20日高点；EMA20或3ATR退出",
    "trend20": "快趋势：收盘高于EMA20买入，低于EMA20退出",
    "trend60": "慢趋势：收盘高于SMA60买入，低于SMA60退出",
    "channel": "通道：收盘突破前20日最高价买入，跌破前10日最低价退出",
    "pullback": "回调：收盘高于SMA60且RSI2<15买入；RSI2>70或跌破SMA60退出",
    "hold": "买入持有（作为候选及基准）",
}


def features(bars):
    data = indicators(bars, Config())
    data["Low10"] = data.Low.shift(1).rolling(10).min()
    change = data.Close.diff()
    gain = change.clip(lower=0).ewm(alpha=.5, adjust=False, min_periods=2).mean()
    loss = (-change.clip(upper=0)).ewm(alpha=.5, adjust=False, min_periods=2).mean()
    data["RSI2"] = 100 * gain / (gain + loss)
    data.loc[(gain + loss) == 0, "RSI2"] = 50
    return data


def entry_condition(row, rule):
    if rule == "hold":
        return True
    if rule == "original":
        return bool(row.EntryCondition)
    if rule == "no_volume":
        return row.Close > row.EMA > row.SMA and row.Close > row.BreakoutHigh
    if rule == "trend20":
        return row.Close > row.EMA
    if rule == "trend60":
        return row.Close > row.SMA
    if rule == "channel":
        return row.Close > row.BreakoutHigh
    if rule == "pullback":
        return row.Close > row.SMA and row.RSI2 < 15
    raise ValueError(f"未知规则 {rule}")


def exit_reason(row, rule, stop):
    if rule in ("original", "no_volume"):
        if row.Close <= stop:
            return "收盘触及 ATR 跟踪止损"
        if row.Close < row.EMA:
            return "收盘跌破 EMA"
    if rule == "trend20" and row.Close < row.EMA:
        return "收盘跌破 EMA20"
    if rule == "trend60" and row.Close < row.SMA:
        return "收盘跌破 SMA60"
    if rule == "channel" and row.Close < row.Low10:
        return "跌破此前10日最低价"
    if rule == "pullback" and (row.RSI2 > 70 or row.Close < row.SMA):
        return "RSI2回升或趋势失效"
    return ""


def simulate(data, start, rule, config=None, schedule=None, policy=None, allow_sell_day_signal=False):
    """Cash/units ledger, no shorting/leverage. Schedule takes effect at the close.

    A pending fill from yesterday is always honored, including on rule-switch days.
    Positions carry across quarters. Upon a rule switch, an existing position's
    ATR anchor resets at the switch-day close (then applies from the next day).
    """
    config = config or Config()
    config.validate()
    if rule not in RULES and policy is None:
        raise ValueError("未知规则")
    data = data.loc[pd.Timestamp(start):]
    if len(data) < 2 or not data.Ready.iloc[0]:
        raise ValueError("区间过短或预热不足")
    fee, slip = config.fee_bps / 10000, config.slippage_bps / 10000
    cash, units, stop, pending, entry = config.initial_cash, 0., None, None, None
    daily, trades = [], []
    current = rule
    for i, (date, row) in enumerate(data.iterrows()):
        fill, price = "", np.nan
        # A fixed hold benchmark has a pre-declared first-day market-on-open buy.
        if i == 0 and rule == "hold" and schedule is None:
            pending = ("BUY", str(date.date()), "期初买入持有", float(row.ATR))
        if pending:
            fill, signal_day, reason, prior_atr = pending
            price = row.Open * (1 + slip if fill == "BUY" else 1 - slip)
            if fill == "BUY":
                units = cash / (price * (1 + fee))
                entry = dict(entry_signal_date=signal_day, entry_date=str(date.date()),
                             entry_price=price, cost=cash, units=units,
                             entry_rule=current, entry_fee=units * price * fee)
                cash = 0.
                stop = max(0., price - config.atr_multiple * prior_atr)
            else:
                cash = units * price * (1 - fee)
                trades.append({**entry, "exit_signal_date": signal_day, "exit_date": str(date.date()),
                               "exit_price": price, "reason": reason, "pnl": cash - entry['cost'],
                               "return_pct": (cash / entry['cost'] - 1) * 100,
                               "fees": entry['entry_fee'] + units * price * fee})
                units, stop, entry = 0., None, None
            pending = None
        if schedule and date in schedule and schedule[date] != current:
            current = schedule[date]
            if units:
                stop = max(0., row.Close - config.atr_multiple * row.ATR)
        signal, reason = "", ""
        stop_at_close = stop
        if policy is not None:
            signal, reason = policy(row, current, units > 0, stop)
            if not units and fill == "SELL" and not allow_sell_day_signal:
                signal, reason = "", ""
            if units and not signal:
                stop = max(stop, row.Close - config.atr_multiple * row.ATR)
        elif units:
            reason = exit_reason(row, current, stop)
            if reason:
                signal = "SELL"
            else:
                stop = max(stop, row.Close - config.atr_multiple * row.ATR)
        elif fill != "SELL" and entry_condition(row, current):
            signal, reason = "BUY", RULES[current]
        if signal:
            pending = (signal, str(date.date()), reason, row.ATR)
        daily.append(dict(Date=date, Equity=cash + units * row.Close, Units=units, Rule=current,
                          Signal=signal, Reason=reason, Fill=fill, FillPrice=price, Stop=stop_at_close))
    return pd.DataFrame(daily).set_index("Date"), pd.DataFrame(trades)


def metrics(daily, trades, initial=100000.):
    equity = daily.Equity
    returns = equity.pct_change()
    returns.iloc[0] = equity.iloc[0] / initial - 1
    volatility = returns.std(ddof=1)
    days = max((daily.index[-1] - daily.index[0]).days, 1)
    total = equity.iloc[-1] / initial - 1
    return dict(return_pct=float(total * 100),
                max_drawdown_pct=float(((equity / equity.cummax().clip(lower=initial) - 1) * 100).min()),
                closed_trades=len(trades), exposure_pct=float((daily.Units > 0).mean() * 100),
                sharpe_rf0=float(returns.mean() / volatility * np.sqrt(252)) if volatility > 0 else None,
                annual_return_pct=float(((1 + total) ** (365.25 / days) - 1) * 100) if days >= 365 else None)


def walk_forward(data, start="2024-01-01", train_start="2023-01-01", config=None):
    """Select maximum net terminal wealth using only bars before each quarter.

    Expanding training window; no realized forward returns enter selection.
    Hold wins ties. Selection becomes active at the first close of the quarter.
    """
    config = config or Config()
    rows, schedule = [], {}
    for quarter, group in data.loc[start:].groupby(data.loc[start:].index.to_period("Q")):
        day = group.index[0]
        past = data.loc[data.index < day]
        if len(past.loc[train_start:]) < 200:
            raise ValueError("至少需要200个交易日的训练期")
        scores = {}
        for rule in ["hold"] + [r for r in RULES if r != "hold"]:
            curve, trades = simulate(past, train_start, rule, config)
            # Estimate net realizable value, including exit costs for any open position.
            final = curve.Equity.iloc[-1]
            units = curve.Units.iloc[-1]
            if units:
                mark = units * past.Close.iloc[-1]
                final -= mark * (1 - (1 - config.slippage_bps / 10000) * (1 - config.fee_bps / 10000))
            scores[rule] = float((final / config.initial_cash - 1) * 100)
        selected = max(scores, key=scores.get)
        schedule[day] = selected
        rows.append(dict(quarter=str(quarter), decision_date=str(day.date()),
                         train_start=str(past.loc[train_start:].index[0].date()),
                         train_end=str(past.index[-1].date()), selected=selected,
                         train_return_pct=scores[selected], hold_train_return_pct=scores['hold'],
                         all_scores=scores))
    curve, trades = simulate(data, start, rows[0]['selected'], config, schedule)
    for row in rows:
        mask = curve.index.to_period("Q") == pd.Period(row["quarter"])
        piece = curve.loc[mask]
        first = curve.index.get_loc(piece.index[0])
        prior = curve.Equity.iloc[first - 1] if first else config.initial_cash
        row["forward_return_pct"] = float((piece.Equity.iloc[-1] / prior - 1) * 100)
    return curve, trades, rows


def run(input_path, output):
    output.mkdir(parents=True, exist_ok=True)
    bars = validate_bars(pd.read_csv(input_path, index_col="Date"))
    data = features(bars)
    comparisons, curves = [], {}
    for rule in RULES:
        curve, trades = simulate(data, "2023-01-01", rule)
        comparisons.append(dict(rule=rule, description=RULES[rule], **metrics(curve, trades)))
        curves[rule] = curve.Equity / 100000
        curve.to_csv(output / f"{rule}_daily.csv")
        trades.to_csv(output / f"{rule}_trades.csv", index=False)
    walk, walk_trades, selections = walk_forward(data)
    hold, hold_trades = simulate(data, "2024-01-01", "hold")
    walk_stats = metrics(walk, walk_trades)
    hold_stats = metrics(hold, hold_trades)
    for row in selections:
        piece = hold.loc[hold.index.to_period("Q") == pd.Period(row["quarter"])]
        first = hold.index.get_loc(piece.index[0])
        prior = hold.Equity.iloc[first-1] if first else 100000.
        row["hold_forward_return_pct"] = float((piece.Equity.iloc[-1] / prior - 1) * 100)
    # Cost stress keeps the already selected rules fixed to isolate execution costs.
    schedule = {pd.Timestamp(row['decision_date']): row['selected'] for row in selections}
    stress, stress_trades = simulate(data, "2024-01-01", selections[0]['selected'],
                                    Config(fee_bps=10, slippage_bps=20), schedule)
    stress_hold, stress_hold_trades = simulate(data, "2024-01-01", "hold", Config(fee_bps=10, slippage_bps=20))
    result = dict(input=str(input_path.resolve()), objective="扣费后总收益超过同期买入持有", config=asdict(Config()),
                  rules=RULES, full_sample=comparisons, walk_forward=walk_stats, walk_hold=hold_stats,
                  cost_stress=metrics(stress, stress_trades), cost_stress_hold=metrics(stress_hold, stress_hold_trades),
                  selections=selections,
                  limitation="规则是在查看过LITE历史表现之后提出；时间隔离的回放不是完全未见样本验证，不能证明未来优势。")
    (output / "research.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    walk.to_csv(output / "walk_forward_daily.csv")
    walk_trades.to_csv(output / "walk_forward_trades.csv", index=False)
    pd.DataFrame(comparisons).to_csv(output / "comparison.csv", index=False)

    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    figure = make_subplots(rows=2, cols=1, vertical_spacing=.14,
                           subplot_titles=["全样本规则比较（用于诊断，不能用于证明优势）", "滚动选择与同期持有（2024年起）"])
    for rule, curve in curves.items():
        figure.add_trace(go.Scatter(x=curve.index, y=curve, name=RULES[rule].split('：')[0],
                                   line=dict(width=3 if rule == 'hold' else 1.5)), row=1, col=1)
    for curve, label in [(walk, "滚动选择"), (hold, "同期持有")]:
        figure.add_trace(go.Scatter(x=curve.index, y=curve.Equity / 100000, name=label), row=2, col=1)
    figure.update_layout(height=850, template="plotly_white", margin=dict(l=55,r=30,t=55,b=40),
                         legend=dict(orientation="h", y=-.08), hovermode="x unified")
    figure.update_yaxes(type="log", title_text="净值（对数刻度）", tickmode="array",
                        tickvals=[.1, .2, .5, 1, 2, 5, 10, 20, 50, 100],
                        ticktext=["0.1", "0.2", "0.5", "1", "2", "5", "10", "20", "50", "100"])
    graph = figure.to_html(full_html=False, include_plotlyjs=True, config={"responsive":True,"displaylogo":False})
    table = pd.DataFrame(comparisons)[['description','return_pct','max_drawdown_pct','closed_trades','exposure_pct']]
    table.columns = ['规则','收益 %','最大回撤 %','完整交易','持仓日占比 %']
    selection_table = pd.DataFrame(selections)[['quarter','train_end','selected','train_return_pct','forward_return_pct','hold_forward_return_pct']]
    selection_table['selected'] = selection_table['selected'].map(lambda name: RULES[name].split('：')[0])
    selection_table.columns = ['执行季度','训练截止','选择规则','训练累计收益 %','季度策略收益 %','季度持有收益 %']
    comparison_pass = walk_stats['return_pct'] > hold_stats['return_pct']
    verdict = "滚动回放收益超过基准，但仍须在未见数据验证" if comparison_pass else "未通过收益优先标准：滚动回放仍跑输买入持有"
    html = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LITE 策略优势审查</title>
<style>body{{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;color:#20324b;background:#f1f4f8;margin:0}}main{{max-width:1250px;margin:36px auto;padding:0 20px}}section{{background:white;padding:24px;margin:20px 0;border-radius:12px;overflow:auto}}h1{{font-size:30px}}h2{{font-size:20px}}table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{padding:10px;text-align:left;border-bottom:1px solid #e5eaf0}}.verdict{{border-left:5px solid #b85848}}.muted{{color:#66778c}}</style></head><body><main>
<h1>LITE · 策略优势审查</h1><p class="muted">目标：扣费后总收益跑赢买入持有 · 数据截至 {data.index[-1].date()} · 不加杠杆、不做空</p>
<section class="verdict"><h2>{verdict}</h2><p>滚动选择收益 {walk_stats['return_pct']:+.2f}%，同期持有 {hold_stats['return_pct']:+.2f}%；最大回撤分别为 {walk_stats['max_drawdown_pct']:.2f}% 和 {hold_stats['max_drawdown_pct']:.2f}%。</p>
<p>成本压力测试（单边手续费10 bps＋滑点20 bps，选择序列固定）：滚动选择 {result['cost_stress']['return_pct']:+.2f}%，持有 {result['cost_stress_hold']['return_pct']:+.2f}%。</p></section>
<section>{graph}</section><section><h2>全部候选结果（2023年起）</h2>{table.to_html(index=False,border=0,float_format=lambda x:f'{x:.2f}')}</section>
<section><h2>滚动选择账本</h2>{selection_table.to_html(index=False,border=0,float_format=lambda x:f'{x:.2f}')}</section>
<section><h2>验证方式与结论边界</h2><p>固定6组交易规则＋买入持有，共7个候选，不做参数网格搜索。每季只使用2023年开始至上一季结束的数据，以扣除模拟期末退出成本后的训练收益选规则，持有在收益相同时优先。2024年起拼接后续回测收益。</p>
<p>选择在季度第一个交易日收盘生效，下一交易日开盘执行；先兑现旧规则已经产生的待执行订单。持仓跨季延续，不强行平仓；切换规则时，对已有仓位以切换日收盘重新设置ATR线。固定持有基准按回测首日开盘买入。费用、滑点和复权口径与第一版相同。</p>
<p>此处“滚动”只保证选规则的计算没有读取未来收益。{escape(result['limitation'])} 本报告没有多股票外部验证，不能把全样本冠军或单只股票的收益差当作统计显著优势。期末未平仓按收盘估值，季度内实际持有规则可能含上季度遗留订单。</p>
<p>方法参考：<a href="https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf">The Probability of Backtest Overfitting</a>；<a href="https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/backtesting-and-simulation">CFA Institute：Backtesting &amp; Simulation</a>。</p></section></main></body></html>'''
    (output / 'LITE_research.html').write_text(html, encoding='utf-8')
    print(table.to_string(index=False, float_format=lambda x:f'{x:.2f}'))
    print(json.dumps({"walk_forward":walk_stats,"hold":hold_stats,"verdict":verdict},ensure_ascii=False,indent=2))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=HERE/'reports/LITE_input.csv')
    parser.add_argument('--output', type=Path, default=HERE/'reports/research')
    args = parser.parse_args()
    run(args.input, args.output)
