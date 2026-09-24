import unittest

import pandas as pd

from one_year_analysis import holding_intervals, liquidate
from strategy import Config


class HorizonAccountingTests(unittest.TestCase):
    def test_liquidation_charges_stock_only_and_does_not_mutate(self):
        dates = pd.date_range('2025-01-01', periods=2)
        curve = pd.DataFrame({'Equity':[1000.,1200.], 'Units':[5.,5.]},index=dates)
        prices = pd.DataFrame({'Close':[100.,120.]},index=dates)
        result,cost=liquidate(curve,prices,Config(fee_bps=10,slippage_bps=20))
        self.assertAlmostEqual(result.Equity.iloc[-1],600+600*.998*.999)
        self.assertAlmostEqual(cost,600*(1-.998*.999))
        self.assertEqual(curve.Equity.iloc[-1],1200.)
        curve['Units']=0.
        result,cost=liquidate(curve,prices,Config())
        self.assertEqual(cost,0.)
        pd.testing.assert_frame_equal(result,curve)

    def test_open_interval_counts_in_holding_cap(self):
        curve=pd.DataFrame({'Fill':['BUY','SELL','BUY','']},index=pd.to_datetime(['2024-01-02','2024-02-02','2024-03-01','2025-03-03']))
        rows=holding_intervals(curve)
        self.assertEqual(rows[0]['calendar_days'],31)
        self.assertEqual(rows[1]['calendar_days'],367)
        self.assertEqual(rows[1]['status'],'期末仍持有')


if __name__=='__main__':
    unittest.main()
