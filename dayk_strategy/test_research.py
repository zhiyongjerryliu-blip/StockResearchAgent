import unittest

import pandas as pd

from strategy import Config, backtest, demo_bars
from research import RULES, features, simulate, walk_forward


class ResearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bars = demo_bars()
        cls.data = features(cls.bars)

    def test_original_engine_matches_daily_ledger(self):
        original, _, _ = backtest(self.bars, Config(), '2023-01-01')
        research, _ = simulate(self.data, '2023-01-01', 'original')
        for name in ['Equity', 'Units', 'Signal', 'Fill', 'FillPrice', 'Stop']:
            pd.testing.assert_series_equal(original[name], research[name], check_freq=False)

    def test_all_rules_are_prefix_invariant(self):
        cutoff = '2024-08-01'
        for rule in RULES:
            whole, _ = simulate(self.data, '2023-01-01', rule)
            short, _ = simulate(features(self.bars.loc[:cutoff]), '2023-01-01', rule)
            pd.testing.assert_frame_equal(short, whole.loc[:cutoff])

    def test_walk_forward_does_not_read_later_quarters(self):
        cutoff = '2024-08-01'
        whole, _, all_selections = walk_forward(self.data)
        short, _, short_selections = walk_forward(features(self.bars.loc[:cutoff]))
        pd.testing.assert_frame_equal(short, whole.loc[:cutoff])
        for past, full in zip(short_selections, all_selections):
            self.assertEqual(past['selected'], full['selected'])
            self.assertEqual(past['all_scores'], full['all_scores'])
            self.assertLess(past['train_end'], past['decision_date'])

    def test_hold_uses_identical_costs_and_no_extra_dividend(self):
        daily, trades = simulate(self.data, '2023-01-01', 'hold')
        first = self.data.loc[daily.index[0]]
        units = 100000 / (first.Open * 1.0005 * 1.0005)
        pd.testing.assert_series_equal(daily.Equity, (units * self.data.loc[daily.index].Close).rename('Equity'))
        self.assertTrue(trades.empty)
        self.assertEqual((daily.Fill == 'BUY').sum(), 1)


if __name__ == '__main__':
    unittest.main()
