#!/usr/bin/env python3
"""单只美股日线策略：收盘确认信号，下一根日线开盘模拟成交。"""
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime
from html import escape
import json
import math
from pathlib import Path
import re
from typing import Optional
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
OHLCV = ["Open", "High", "Low", "Close", "Volume"]
TRADE_COLUMNS = ["entry_signal_date", "entry_date", "entry_price", "exit_signal_date",
                 "exit_date", "exit_price", "units", "fees", "pnl", "return_pct", "reason"]


@dataclass(frozen=True)
class Config:
    fast: int = 20
    slow: int = 60
    breakout: int = 20
    volume_window: int = 20
    volume_multiple: float = 1.2
    atr_window: int = 14
    atr_multiple: float = 3.0
    initial_cash: float = 100000.0
    fee_bps: float = 5.0
    slippage_bps: float = 5.0

    def validate(self):
        for key in ("fast", "slow", "breakout", "volume_window", "atr_window"):
            value = getattr(self, key)
            if not isinstance(value, int) or isinstance(value, bool) or value < 2:
                raise ValueError(f"{key} 必须为至少 2 的整数")
        if self.fast >= self.slow:
            raise ValueError("快线周期必须小于慢线周期")
        for key in ("volume_multiple", "atr_multiple", "initial_cash"):
            if not math.isfinite(getattr(self, key)) or getattr(self, key) <= 0:
                raise ValueError(f"{key} 必须为有限正数")
        for key in ("fee_bps", "slippage_bps"):
            if not math.isfinite(getattr(self, key)) or not 0 <= getattr(self, key) < 10000:
                raise ValueError(f"{key} 必须在 [0, 10000) 内")


def validate_bars(frame: pd.DataFrame) -> pd.DataFrame:
    """Reject damaged data rather than filling prices or silently dropping rows."""
    if not set(OHLCV).issubset(frame.columns):
        raise ValueError("缺少行情字段：需要 Open, High, Low, Close, Volume")
    bars = frame[OHLCV].copy()
    bars.index = pd.DatetimeIndex(pd.to_datetime(bars.index, errors="raise"))
    if bars.index.tz is not None:
        bars.index = bars.index.tz_localize(None)
    bars.index = bars.index.normalize()
    if bars.empty or bars.index.hasnans or bars.index.has_duplicates:
        raise ValueError("行情为空、日期缺失或交易日重复")
    bars = bars.sort_index().apply(pd.to_numeric, errors="raise")
    if not np.isfinite(bars.to_numpy(dtype=float)).all():
        raise ValueError("行情含空值或无穷值，请检查数据源")
    if (bars[OHLCV[:4]] <= 0).any().any() or (bars.Volume < 0).any():
        raise ValueError("价格必须为正数，成交量不能为负数")
    if ((bars.High < bars[["Open", "Close", "Low"]].max(axis=1)) |
            (bars.Low > bars[["Open", "Close", "High"]].min(axis=1))).any():
        raise ValueError("OHLC 高低价关系错误")
    bars.index.name = "Date"
    return bars


def indicators(bars: pd.DataFrame, config: Config) -> pd.DataFrame:
    config.validate()
    data = validate_bars(bars)
    data["EMA"] = data.Close.ewm(span=config.fast, adjust=False, min_periods=config.fast).mean()
    data["SMA"] = data.Close.rolling(config.slow).mean()
    # Breakout and volume comparisons exclude the current day.
    data["BreakoutHigh"] = data.High.shift(1).rolling(config.breakout).max()
    data["VolumeBase"] = data.Volume.shift(1).rolling(config.volume_window).mean()
    prior_close = data.Close.shift(1)
    tr = pd.concat([data.High - data.Low, (data.High - prior_close).abs(),
                    (data.Low - prior_close).abs()], axis=1).max(axis=1)
    data["ATR"] = tr.rolling(config.atr_window).mean()
    data["Ready"] = data[["EMA", "SMA", "BreakoutHigh", "VolumeBase", "ATR"]].notna().all(axis=1)
    data["EntryCondition"] = (data.Ready & (data.Close > data.EMA) & (data.EMA > data.SMA)
                              & (data.Close > data.BreakoutHigh)
                              & (data.VolumeBase > 0)
                              & (data.Volume >= config.volume_multiple * data.VolumeBase))
    return data


def backtest(bars: pd.DataFrame, config: Config, start: Optional[str] = None):
    data = indicators(bars, config)
    if start is not None:
        data = data.loc[pd.Timestamp(start):].copy()
    if data.empty:
        raise ValueError("指定回测区间没有行情")
    if not bool(data.Ready.iloc[0]):
        raise ValueError("首个回测日缺少指标预热数据，请提供更早的历史行情或推迟 --start")
    if len(data) < 2:
        raise ValueError("回测区间至少需要两个交易日")

    cash = config.initial_cash
    units = 0.0
    stop = None
    pending = None
    entry = None
    trades, daily = [], []
    fee_rate, slip = config.fee_bps / 10000, config.slippage_bps / 10000
    # Benchmark uses identical first-day funding and entry costs, ending marked to market.
    benchmark_units = cash / (float(data.Open.iloc[0]) * (1 + slip) * (1 + fee_rate))
    for date, bar in data.iterrows():
        day = date.strftime("%Y-%m-%d")
        fill, fill_price, fill_reason = "", float("nan"), ""
        # Only the preceding close may cause a fill at this open.
        if pending is not None:
            fill, signal_date, fill_reason, prior_atr = pending
            if fill == "BUY":
                fill_price = float(bar.Open) * (1 + slip)
                units = cash / (fill_price * (1 + fee_rate))
                entry_fee = units * fill_price * fee_rate
                entry = dict(entry_signal_date=signal_date, entry_date=day,
                             entry_price=fill_price, units=units, cost=cash, entry_fee=entry_fee)
                cash = 0.0
                stop = max(0.0, fill_price - config.atr_multiple * prior_atr)
            else:
                fill_price = float(bar.Open) * (1 - slip)
                exit_fee = units * fill_price * fee_rate
                cash = units * fill_price - exit_fee
                pnl = cash - entry["cost"]
                trades.append({key: entry[key] for key in ("entry_signal_date", "entry_date", "entry_price", "units")}
                              | dict(exit_signal_date=signal_date, exit_date=day, exit_price=fill_price,
                                     fees=entry["entry_fee"] + exit_fee, pnl=pnl,
                                     return_pct=pnl / entry["cost"] * 100, reason=fill_reason))
                units, stop, entry = 0.0, None, None
            pending = None

        signal, reason = "", ""
        # The stop used at today's close was known before today's close.
        stop_for_close = stop
        if units > 0:
            if float(bar.Close) <= stop:
                signal, reason = "SELL", "收盘触及 ATR 跟踪止损"
            elif float(bar.Close) < float(bar.EMA):
                signal, reason = "SELL", "收盘跌破 EMA"
            if signal:
                pending = (signal, day, reason, float(bar.ATR))
            else:
                stop = max(stop, float(bar.Close) - config.atr_multiple * float(bar.ATR))
        elif fill != "SELL" and bool(bar.EntryCondition):
            signal, reason = "BUY", "趋势向上且放量突破前期高点"
            pending = (signal, day, reason, float(bar.ATR))

        daily.append(dict(Date=date, Signal=signal, Reason=reason, Fill=fill,
                          FillPrice=fill_price, FillReason=fill_reason,
                          Stop=stop_for_close, NextStop=stop, Units=units,
                          Equity=cash + units * float(bar.Close),
                          Benchmark=benchmark_units * float(bar.Close)))

    daily = data.join(pd.DataFrame(daily).set_index("Date"))
    closed = pd.DataFrame(trades, columns=TRADE_COLUMNS)
    initial = config.initial_cash
    equity = daily.Equity
    peaks = equity.cummax().clip(lower=initial)
    daily["DrawdownPct"] = (equity / peaks - 1) * 100
    days = max((daily.index[-1] - daily.index[0]).days, 1)
    total = float(equity.iloc[-1] / initial - 1)
    benchmark_peaks = daily.Benchmark.cummax().clip(lower=initial)
    summary = dict(
        start=daily.index[0].strftime("%Y-%m-%d"), end=daily.index[-1].strftime("%Y-%m-%d"),
        bars=len(daily), initial_cash=initial, final_equity=float(equity.iloc[-1]),
        total_return_pct=total * 100,
        cagr_pct=((1 + total) ** (365.25 / days) - 1) * 100 if days >= 365 else None,
        max_drawdown_pct=float(daily.DrawdownPct.min()),
        benchmark_return_pct=float((daily.Benchmark.iloc[-1] / initial - 1) * 100),
        benchmark_max_drawdown_pct=float(((daily.Benchmark / benchmark_peaks - 1) * 100).min()),
        closed_trades=len(closed),
        win_rate_pct=float((closed.pnl > 0).mean() * 100) if len(closed) else None,
        exposure_pct=float((daily.Units > 0).mean() * 100),
        open_position=entry,
        pending_order=dict(side=pending[0], signal_date=pending[1], reason=pending[2]) if pending else None,
        config=asdict(config),
    )
    return daily, closed, summary


def load_yahoo(ticker: str, start: str, end: str, config: Config) -> pd.DataFrame:
    import yfinance as yf
    cache = HERE / ".cache"
    cache.mkdir(exist_ok=True)
    yf.set_tz_cache_location(str(cache))
    lookback = max(config.slow, config.breakout + 1, config.volume_window + 1, config.atr_window)
    warmup = (pd.Timestamp(start) - pd.Timedelta(days=max(365, lookback * 3))).strftime("%Y-%m-%d")
    bars = yf.download(ticker, start=warmup, end=end, interval="1d", auto_adjust=True,
                       prepost=False, progress=False, threads=False, multi_level_index=False)
    if bars is None or bars.empty:
        raise ValueError("Yahoo 未返回行情，请检查代码、日期或网络；可用 --csv 导入已复权行情")
    return validate_bars(bars)


def demo_bars() -> pd.DataFrame:
    """Deterministic synthetic fixture; never presented as actual stock history."""
    rng = np.random.default_rng(21)
    dates = pd.bdate_range("2022-01-03", periods=900)
    returns = 0.001 + 0.005 * np.sin(np.arange(len(dates)) / 22) + rng.normal(0, 0.014, len(dates))
    close = 100 * np.exp(np.cumsum(returns))
    opening = np.r_[100, close[:-1]] * np.exp(rng.normal(0, .004, len(dates)))
    spread = rng.uniform(.002, .014, len(dates))
    return pd.DataFrame(dict(Open=opening, High=np.maximum(opening, close) * (1 + spread),
                             Low=np.minimum(opening, close) * (1 - spread), Close=close,
                             Volume=rng.integers(800000, 2400000, len(dates))), index=dates)


def write_report(daily, trades, summary, ticker: str, output: Path):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots

    output.mkdir(parents=True, exist_ok=True)
    fig = make_subplots(rows=3, cols=1, shared_xaxes=True, vertical_spacing=.035,
                        row_heights=[.60, .15, .25], subplot_titles=["日K线与交易点", "成交量", "账户净值对照"])
    dates = daily.index.strftime("%Y-%m-%d").tolist()
    fig.add_trace(go.Candlestick(x=dates, open=daily.Open.tolist(), high=daily.High.tolist(),
                                 low=daily.Low.tolist(), close=daily.Close.tolist(), name="复权日K",
                                 increasing_line_color="#168e80", decreasing_line_color="#d25167"), row=1, col=1)
    for column, name, color, dash in [("EMA", f"EMA {summary['config']['fast']}", "#4772d8", "solid"),
                                       ("SMA", f"SMA {summary['config']['slow']}", "#aa7b36", "solid"),
                                       ("Stop", "本日收盘止损参考线", "#cd6788", "dot")]:
        fig.add_trace(go.Scatter(x=dates, y=daily[column].tolist(), name=name,
                                 line=dict(color=color, width=1.5, dash=dash)), row=1, col=1)
    for side, label, color, symbol in [("BUY", "买入", "#087f6c", "triangle-up"),
                                        ("SELL", "卖出", "#ce4161", "triangle-down")]:
        fills = daily[daily.Fill == side]
        fig.add_trace(go.Scatter(x=fills.index.strftime("%Y-%m-%d").tolist(), y=fills.FillPrice.tolist(),
                                 mode="markers", name=f"{label}成交（次日开盘＋滑点）",
                                 marker=dict(symbol=symbol, size=13, color=color), text=fills.FillReason.tolist(),
                                 hovertemplate="%{x}<br>成交价 %{y:.2f}<br>%{text}<extra></extra>"), row=1, col=1)
        signals = daily[daily.Signal == side]
        fig.add_trace(go.Scatter(x=signals.index.strftime("%Y-%m-%d").tolist(), y=signals.Close.tolist(),
                                 mode="markers", name=f"{label}信号（收盘确认）",
                                 marker=dict(symbol="circle-open", size=10, color=color, line=dict(width=2)),
                                 text=signals.Reason.tolist(),
                                 hovertemplate="%{x}<br>信号收盘价 %{y:.2f}<br>%{text}<extra></extra>"), row=1, col=1)
    colors = np.where(daily.Close >= daily.Open, "#8acbc0", "#e4a4b0").tolist()
    fig.add_trace(go.Bar(x=dates, y=daily.Volume.tolist(), marker_color=colors, name="成交量", showlegend=False), row=2, col=1)
    for column, name, color in [("Equity", "策略净值", "#167b68"), ("Benchmark", "买入并持有", "#8a97ac")]:
        fig.add_trace(go.Scatter(x=dates, y=(daily[column] / summary["initial_cash"]).tolist(), name=name,
                                 line=dict(color=color, width=2)), row=3, col=1)
    fig.update_layout(height=900, template="plotly_white", margin=dict(l=55, r=30, t=95, b=35),
                      font=dict(family="Arial, PingFang SC, sans-serif"), paper_bgcolor="#ffffff",
                      legend=dict(orientation="h", y=1.11, x=0), hovermode="x unified")
    fig.update_xaxes(type="date", rangebreaks=[dict(bounds=["sat", "mon"])], rangeslider_visible=False)
    chart = fig.to_html(full_html=False, include_plotlyjs=True, config={"responsive": True, "displaylogo": False})
    def pct(value):
        return "—" if value is None else f"{value:+.2f}%"
    stats = [("策略收益", pct(summary["total_return_pct"])), ("买入持有收益", pct(summary["benchmark_return_pct"])),
             ("策略最大回撤", pct(summary["max_drawdown_pct"])), ("完整交易", str(summary["closed_trades"])),
             ("交易胜率", pct(summary["win_rate_pct"]))]
    cards = "".join(f'<div class="card"><small>{name}</small><strong>{value}</strong></div>' for name, value in stats)
    pending = summary["pending_order"]
    state = "持有多头仓位" if summary["open_position"] else "空仓观察"
    if pending:
        state += " · 最新收盘已确认" + ("买入" if pending["side"] == "BUY" else "卖出") + "信号，等待下一交易日开盘"
    c = summary["config"]
    table = trades.tail(30).copy()
    if len(table):
        table = table[["entry_date", "entry_price", "exit_date", "exit_price", "return_pct", "reason"]]
        table.columns = ["买入日", "买入价", "卖出日", "卖出价", "净收益 %", "卖出原因"]
        table_html = table.to_html(index=False, float_format=lambda x: f"{x:,.2f}", border=0)
    else:
        table_html = "<p>此区间没有已完成的买卖交易。</p>"
    html = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(ticker)} · 日线策略研究</title><style>
body{{margin:0;background:#f3f5f7;color:#233147;font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}
main{{max-width:1320px;margin:36px auto;padding:0 22px}}h1{{font-size:30px;margin:8px 0}}h2{{font-size:19px}}.eyebrow{{color:#16816e;letter-spacing:2px;font-size:12px;font-weight:700}}
.muted,small{{color:#69788b}}.cards{{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin:24px 0}}.card,.panel{{background:white;border:1px solid #e0e6eb;border-radius:12px;padding:20px}}strong{{display:block;font-size:25px;margin-top:6px}}.panel{{margin:18px 0}}.chart{{padding:8px;overflow:hidden}}table{{border-collapse:collapse;width:100%;text-align:left}}td,th{{padding:10px;border-bottom:1px solid #e7ecf0;text-align:left}}.table{{overflow:auto}}.state{{color:#176d5e;background:#e8f3ef;padding:12px 18px;border-radius:8px}}
@media(max-width:800px){{.cards{{grid-template-columns:repeat(2,1fr)}}main{{padding:0 12px}}}}
</style></head><body><main><div class="eyebrow">DAILY STRATEGY LAB · 日线波段研究</div>
<h1>{escape(ticker)} · 买卖信号与历史回测</h1>
<div class="muted">{summary['start']} — {summary['end']} · {summary['bars']} 个交易日 · {escape(summary['source'])}</div>
<div class="cards">{cards}</div><div class="state">{state}</div><section class="panel chart">{chart}</section>
<section class="panel"><h2>信号怎么产生</h2>
<p>买入：收盘价 &gt; EMA{c['fast']} &gt; SMA{c['slow']}，收盘突破此前 {c['breakout']} 日最高价，且成交量至少为此前 {c['volume_window']} 日均量的 {c['volume_multiple']:g} 倍。</p>
<p>卖出：收盘跌破 EMA{c['fast']}，或收盘触及上一日确定的 {c['atr_multiple']:g}×ATR{c['atr_window']} 跟踪止损线。止损线只上移；这是收盘止损，非盘中止损委托。买入当日从成交价减去 {c['atr_multiple']:g}×上一日 ATR 设置初始线。</p>
<p>空心圆是收盘确认信号，三角形是下一交易日开盘模拟成交。卖出当天不再发出新买入信号。每次全仓做多、允许分数单位、不加杠杆；单边手续费 {c['fee_bps']:g} bps，滑点 {c['slippage_bps']:g} bps（1 bps = 0.01%）。</p></section>
<section class="panel table"><h2>最近 30 笔完整交易</h2>{table_html}</section>
<p class="muted">采用分红、拆股复权 OHLC，成交价为复权等价价格，仓位为复权等价单位；收益为复权价格模型的近似总回报，不另加股息。期末持仓按收盘估值，未强行卖出，未扣未来平仓费用；基准采用相同区间与买入成本。胜率仅统计已平仓交易。数据末日无下一根K线时，信号保持待执行。</p>
<p class="muted">参数是待验证的初始规则，未进行样本外有效性验证。未建模税费、现金利息、市场冲击、停牌或退市执行；历史回测不代表未来收益。</p>
</main></body></html>'''
    report = output / f"{ticker}_report.html"
    report.write_text(html, encoding="utf-8")
    daily.to_csv(output / f"{ticker}_daily.csv", encoding="utf-8-sig")
    trades.to_csv(output / f"{ticker}_trades.csv", index=False, encoding="utf-8-sig")
    (output / f"{ticker}_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ticker", default="LITE", help="单只美股代码，默认 LITE")
    parser.add_argument("--start", default="2023-01-01", help="回测开始日期（含）")
    parser.add_argument("--end", help="结束日期（不含）；默认美东当天，保守排除当日日线")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--csv", type=Path, help="本地已复权日线：Date,Open,High,Low,Close,Volume，含预热数据")
    source.add_argument("--demo", action="store_true", help="使用合成行情验证工具，不代表任何真实股票")
    parser.add_argument("--output", type=Path, default=HERE / "reports")
    for key, field in Config.__dataclass_fields__.items():
        parser.add_argument("--" + key.replace("_", "-"), type=type(field.default), default=field.default)
    args = parser.parse_args(argv)
    try:
        config = Config(**{key: getattr(args, key) for key in Config.__dataclass_fields__})
        config.validate()
        ticker = args.ticker.strip().upper()
        if not re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,14}", ticker):
            raise ValueError("请输入单只美股代码，如 AAPL、NVDA、BRK-B")
        # Exclude the current US calendar date even after close: conservative, deterministic.
        today = datetime.now(ZoneInfo("America/New_York")).date()
        end = pd.Timestamp(args.end).date() if args.end else today
        end = min(end, today)
        start = pd.Timestamp(args.start).date()
        if start >= end:
            raise ValueError("--start 必须早于 --end 和美东当前日期")
        if args.demo:
            bars, ticker, source_name = demo_bars(), "DEMO", "合成行情演示 · 非真实股票"
        elif args.csv:
            frame = pd.read_csv(args.csv)
            if "Date" not in frame.columns:
                raise ValueError("CSV 缺少 Date 列")
            bars = validate_bars(frame.set_index("Date"))
            source_name = f"本地 CSV（用户须确保 OHLC 均已复权）：{args.csv.name}"
        else:
            bars = load_yahoo(ticker, str(start), str(end), config)
            source_name = "Yahoo Finance / yfinance · 分红拆股复权日线"
        bars = bars.loc[bars.index < pd.Timestamp(end)]
        daily, trades, summary = backtest(bars, config, str(start))
        summary.update(ticker=ticker, source=source_name, requested_start=str(start), exclusive_end=str(end),
                       generated_at=datetime.now(ZoneInfo("UTC")).isoformat())
        report = write_report(daily, trades, summary, ticker, args.output.resolve())
        bars.to_csv(report.parent / f"{ticker}_input.csv", encoding="utf-8-sig", index_label="Date")
        print(f"报告：{report}\n回测区间：{summary['start']} 至 {summary['end']}\n"
              f"策略收益：{summary['total_return_pct']:.2f}% | 最大回撤：{summary['max_drawdown_pct']:.2f}% | "
              f"完整交易：{summary['closed_trades']}")
        return 0
    except (ValueError, OSError, ImportError) as error:
        parser.exit(2, f"错误：{error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
