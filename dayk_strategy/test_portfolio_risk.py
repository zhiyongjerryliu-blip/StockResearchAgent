import unittest
from types import SimpleNamespace

import numpy as np
import pandas as pd

from portfolio_risk import exposure,risk_inputs
from quality_momentum import run_account
from strategy import Config
import test_quality_momentum as fixtures


class PortfolioRiskTests(unittest.TestCase):
    def test_risk_thresholds_and_cash_fallback(self):
        row=SimpleNamespace(Count=6,Breadth=2/3,SPYMA200=100.,MarketWeak=False,AllDown=False)
        self.assertEqual(exposure(row,'breadth'),1.)
        row.Breadth=1/3
        self.assertEqual(exposure(row,'breadth'),.5)
        row.Breadth=1/6
        self.assertEqual(exposure(row,'breadth'),0.)
        self.assertEqual(exposure(row,'combined'),.5)
        row.MarketWeak=True
        self.assertEqual(exposure(row,'combined'),0.)
        row.AllDown=True
        self.assertEqual(exposure(row,'all_down'),0.)
        row.AllDown=False
        self.assertEqual(exposure(row,'all_down'),1.)
        row.Count=2
        self.assertEqual(exposure(row,'all_down'),0.)

    def test_risk_inputs_prefix_and_new_listing_denominator(self):
        days=pd.bdate_range('2023-01-02',periods=330)
        p=pd.DataFrame({'Close':100.+np.arange(len(days))},index=days)
        prices={t:p.copy() for t in ('A','B','C','NEW','SPY')}
        frames={t:pd.DataFrame({'PriceReady':np.arange(len(days))>=252},index=days) for t in ('A','B','C')}
        frames['NEW']=pd.DataFrame({'PriceReady':False},index=days)
        before=risk_inputs(prices,frames)
        self.assertEqual(before.Count.iloc[-1],3)
        self.assertFalse(before.AllDown.iloc[-1])
        for t in prices:prices[t].iloc[310:,0]=10.
        after=risk_inputs(prices,frames)
        pd.testing.assert_frame_equal(before.iloc[:310],after.iloc[:310])
        self.assertTrue(after.AllDown.iloc[310])

    def test_constant_full_exposure_preserves_old_account(self):
        prices,frames=fixtures.QualityMomentumTests().market_sample()
        args=(prices,frames,'2024-01-29','2024-02-06','quality_momentum',Config())
        old=run_account(*args);new=run_account(*args,exposure_controller=lambda day:1.)
        self.assertEqual(old[0],new[0])
        for a,b in zip(old[1:],new[1:]):pd.testing.assert_frame_equal(a,b)

    def test_daily_risk_trades_next_open_and_restores_midmonth(self):
        prices,frames=fixtures.QualityMomentumTests().market_sample()
        days=prices['SPY'].index
        signals=pd.Series([1.,.5,0.,0.,1.,1.,1.],index=days)
        _,c,t,_,_=run_account(prices,frames,'2024-01-29','2024-02-06','quality_momentum',Config(),
                             exposure_controller=lambda day:signals.loc[day])
        self.assertEqual(c.Exposure.iloc[0],0.)
        self.assertAlmostEqual(c.Exposure.iloc[1],1.)
        self.assertAlmostEqual(c.Exposure.iloc[2],.5)
        self.assertEqual(c.Exposure.iloc[3],0.)
        self.assertEqual(c.Exposure.iloc[4],0.)
        self.assertAlmostEqual(c.Exposure.iloc[5],1.)
        self.assertTrue((pd.to_datetime(t.date)>pd.to_datetime(t.signal_date)).all())
        signals.iloc[5:]=0.
        _,changed,_,_,_=run_account(prices,frames,'2024-01-29','2024-02-06','quality_momentum',Config(),
                                   exposure_controller=lambda day:signals.loc[day])
        pd.testing.assert_frame_equal(c.iloc[:6],changed.iloc[:6])


if __name__=='__main__':unittest.main()
