import unittest

import pandas as pd

from drawdown_research import overlay, reserved, risk_target
from strategy import Config


class DrawdownOverlayTests(unittest.TestCase):
    def sample(self):
        index=pd.date_range('2025-01-01',periods=5)
        data=pd.DataFrame({'Open':[100.,100.,110.,40.,45.],
                           'Close':[100.,110.,110.,45.,47.]},index=index)
        base=pd.DataFrame({'Units':[0.,1.,1.,1.,1.],
                           'Signal':['BUY','','','','']},index=index)
        return data,base

    def test_cushion_uses_account_high_water_mark(self):
        self.assertAlmostEqual(risk_target('cushion4',100,100,True),.8)
        self.assertAlmostEqual(risk_target('cushion2',100,100,True),.4)
        self.assertAlmostEqual(risk_target('cushion4',90,100,True),4/9)
        self.assertEqual(risk_target('cushion4',79,100,True),0.)
        self.assertEqual(risk_target('cushion4',100,100,False),0.)

    def test_prefix_invariance_and_next_open(self):
        data,base=self.sample()
        for rule in ('target50','target25','cushion4','cushion2'):
            full=overlay(data,base,rule,Config())
            short=overlay(data.iloc[:3],base.iloc[:3],rule,Config())
            pd.testing.assert_frame_equal(full.iloc[:3],short)
            self.assertEqual(full.Units.iloc[0],0.)
            self.assertGreater(full.Units.iloc[1],0.)
            self.assertGreaterEqual(full.Cash.min(),0.)
            self.assertLessEqual(full.Exposure.max(),1.)

    def test_gap_can_breach_budget_no_clipping(self):
        data,base=self.sample()
        c=overlay(data,base,'cushion4',Config())
        dd=c.Equity/c.Equity.cummax().clip(lower=100000)-1
        self.assertLess(dd.min(),-.2)
        self.assertEqual(c.Target.iloc[3],0.)
        self.assertEqual(c.Units.iloc[4],0.)

    def test_half_initial_cash_does_not_halve_drawdown(self):
        c=pd.DataFrame({'Equity':[100000.,300000.,150000.],
                        'Cash':[0.,0.,0.],'Units':[100.,100.,100.],
                        'DeltaUnits':[100.,0.,0.],'Fee':[50.,0.,0.]})
        result=reserved(c,Config())
        self.assertEqual(result.Equity.iloc[-1],125000.)
        self.assertAlmostEqual((result.Equity/result.Equity.cummax()-1).min(),-.375)


if __name__=='__main__':
    unittest.main()
