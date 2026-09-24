import unittest
from dataclasses import replace

import pandas as pd

from strategy import Config, backtest, demo_bars, indicators, validate_bars


def fixture():
    opens = [10, 10, 10, 10, 20, 13, 5]
    closes = [10, 10, 10, 12, 13, 9, 8]
    return pd.DataFrame({"Open": opens, "High": [max(a, b) + 1 for a, b in zip(opens, closes)],
                         "Low": [min(a, b) - 1 for a, b in zip(opens, closes)], "Close": closes,
                         "Volume": [100, 100, 100, 200, 100, 100, 100]},
                        index=pd.bdate_range("2024-01-01", periods=7))


SMALL = Config(fast=2, slow=3, breakout=2, volume_window=2, atr_window=2,
               volume_multiple=1.2, fee_bps=10, slippage_bps=10)


class StrategyTests(unittest.TestCase):
    def test_next_open_gap_and_two_sided_costs(self):
        bars = fixture()
        daily, trades, summary = backtest(bars, SMALL, str(bars.index[2].date()))
        self.assertEqual(daily.Signal.tolist(), ["", "BUY", "", "SELL", ""])
        self.assertEqual(daily.Fill.tolist(), ["", "", "BUY", "", "SELL"])
        self.assertEqual(len(trades), 1)
        buy_price, sell_price = 20 * 1.001, 5 * .999
        units = SMALL.initial_cash / (buy_price * 1.001)
        ending_cash = units * sell_price * .999
        self.assertAlmostEqual(trades.entry_price.iloc[0], buy_price)
        self.assertAlmostEqual(trades.exit_price.iloc[0], sell_price)
        self.assertAlmostEqual(summary["final_equity"], ending_cash)
        self.assertAlmostEqual(trades.pnl.iloc[0], ending_cash - SMALL.initial_cash)
        self.assertAlmostEqual(trades.fees.iloc[0], units * (buy_price + sell_price) * .001)
        self.assertIsNone(summary["open_position"])
        # The huge gap is filled at the next open, never at the previous stop/close.
        self.assertLess(summary["max_drawdown_pct"], -70)

    def test_final_signal_is_pending_not_filled(self):
        bars = fixture().iloc[:4]
        daily, trades, summary = backtest(bars, SMALL, str(bars.index[2].date()))
        self.assertEqual(summary["pending_order"]["side"], "BUY")
        self.assertEqual(summary["final_equity"], SMALL.initial_cash)
        self.assertTrue((daily.Fill == "").all())
        self.assertTrue(trades.empty)
        self.assertIsNone(summary["win_rate_pct"])

    def test_open_position_is_marked_not_liquidated(self):
        bars = fixture().iloc[:5]
        daily, trades, summary = backtest(bars, SMALL, str(bars.index[2].date()))
        self.assertIsNotNone(summary["open_position"])
        self.assertTrue(trades.empty)
        self.assertAlmostEqual(summary["final_equity"], summary["open_position"]["units"] * 13)

    def test_prefix_invariance_no_future_bars(self):
        bars = demo_bars()
        whole, _, _ = backtest(bars, Config(), "2023-01-01")
        for length in (350, 500, 700):
            short, _, _ = backtest(bars.iloc[:length], Config(), "2023-01-01")
            pd.testing.assert_frame_equal(short, whole.loc[short.index], check_freq=False)

    def test_rolling_high_and_volume_exclude_today(self):
        data = indicators(fixture(), SMALL)
        self.assertEqual(data.BreakoutHigh.iloc[3], 11)
        self.assertEqual(data.VolumeBase.iloc[3], 100)
        self.assertTrue(data.EntryCondition.iloc[3])

    def test_stop_only_ratchets_up_within_position(self):
        daily, _, _ = backtest(demo_bars(), Config(), "2023-01-01")
        last_stop = None
        for _, row in daily.iterrows():
            if row.Fill == "SELL":
                last_stop = None
            if row.Units > 0:
                if last_stop is not None:
                    self.assertGreaterEqual(row.NextStop, last_stop)
                last_stop = row.NextStop

    def test_atr_stop_signal_uses_previous_threshold(self):
        bars = fixture()
        config = replace(SMALL, atr_multiple=.1)
        daily, _, summary = backtest(bars.iloc[:5], config, str(bars.index[2].date()))
        self.assertEqual(daily.Signal.iloc[-1], "SELL")
        self.assertEqual(summary["pending_order"]["reason"], "收盘触及 ATR 跟踪止损")
        self.assertEqual(daily.Fill.iloc[-1], "BUY")

    def test_no_trades_zero_return_and_no_fake_win_rate(self):
        bars = fixture()
        config = replace(SMALL, volume_multiple=1000)
        _, trades, summary = backtest(bars, config, str(bars.index[2].date()))
        self.assertTrue(trades.empty)
        self.assertEqual(summary["total_return_pct"], 0)
        self.assertEqual(summary["max_drawdown_pct"], 0)
        self.assertIsNone(summary["win_rate_pct"])

    def test_bad_data_is_rejected(self):
        bars = fixture()
        for bad in (pd.concat([bars, bars.iloc[:1]]), bars.assign(Volume=-1),
                    bars.assign(Open=float("nan")), bars.assign(High=1)):
            with self.assertRaises(ValueError):
                validate_bars(bad)

    def test_warmup_and_invalid_parameters(self):
        with self.assertRaises(ValueError):
            backtest(fixture(), SMALL)
        for config in (replace(SMALL, fee_bps=-1), replace(SMALL, fast=3),
                       replace(SMALL, atr_multiple=float("nan"))):
            with self.assertRaises(ValueError):
                config.validate()


if __name__ == "__main__":
    unittest.main()
