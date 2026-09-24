import unittest

import pandas as pd

from fundamental_strategy import enriched
from fundamentals import build_daily
from inflection_research import operating_policy, operating_signals
from research import simulate
from strategy import demo_bars
from test_fundamentals import fact, financial_fixture, snapshot


class InflectionTests(unittest.TestCase):
    def row(self,**kwargs):
        values=dict(RevenueYoY=.1,GrossMarginYoY=.03,RevenueAcceleration=.04,
                    GrossMarginYoYAcceleration=.01,FinAgeDays=60,FCFTTM=-100,
                    FinState='NEUTRAL',Close=110,SMA=100,SMA120=95)
        return pd.Series({**values,**kwargs})

    def test_cash_gate_ablation_changes_only_financial_entry_condition(self):
        row=self.row()
        self.assertEqual(operating_policy(row,'no_cash_gate',False,None)[0],'BUY')
        self.assertEqual(operating_policy(row,'fund_regime',False,None),('',''))
        self.assertEqual(operating_policy(self.row(Close=90),'no_cash_gate',False,None),('',''))

    def test_inflection_can_detect_less_negative_growth(self):
        row=self.row(RevenueYoY=-.1,GrossMarginYoY=-.03)
        self.assertEqual(operating_policy(row,'inflection',False,None)[0],'BUY')
        self.assertEqual(operating_policy(row,'no_cash_gate',False,None),('',''))
        row=self.row(RevenueAcceleration=-.02,GrossMarginYoYAcceleration=-.01)
        self.assertEqual(operating_policy(row,'inflection',True,90)[0],'SELL')

    def test_missing_stale_and_numerical_noise_not_improvement(self):
        for row in [self.row(FinAgeDays=181),self.row(RevenueAcceleration=float('nan')),
                    self.row(GrossMarginYoYAcceleration=1e-14)]:
            self.assertFalse(operating_signals(row,'inflection')[1])
        self.assertEqual(operating_policy(self.row(FinAgeDays=181,Close=99),'inflection',True,90)[0],'SELL')

    def test_margin_acceleration_uses_yoy_differences_not_raw_qoq(self):
        facts=[]
        for start,end,margin in [('2022-07-01','2022-09-30',.2),('2022-10-01','2022-12-31',.2),
                                  ('2023-07-01','2023-09-30',.3),('2023-10-01','2023-12-31',.4)]:
            facts.extend([fact('revenue',start,end,100),fact('grossProfit',start,end,100*margin)])
        daily,_=build_daily(snapshot(facts),pd.bdate_range('2024-02-15','2024-02-20'))
        self.assertAlmostEqual(daily.GrossMarginYoY.iloc[-1],.2)
        self.assertAlmostEqual(daily.GrossMarginYoYAcceleration.iloc[-1],.1)

    def test_prefix_causality_and_next_open_for_both_new_rules(self):
        data,_=enriched(demo_bars(),financial_fixture())
        # Vary only already-known synthetic financial features to exercise entries/exits.
        data['RevenueAcceleration']=.03
        data['GrossMarginYoYAcceleration']=.02
        for rule in ['no_cash_gate','inflection']:
            whole,_=simulate(data,'2023-01-01',rule,policy=operating_policy)
            short,_=simulate(data.loc[:'2024-08-01'],'2023-01-01',rule,policy=operating_policy)
            pd.testing.assert_frame_equal(short,whole.loc[short.index])
            self.assertGreater((whole.Fill=='BUY').sum(),0)
            for i in range(1,len(whole)):
                if whole.Fill.iloc[i]:
                    self.assertEqual(whole.Fill.iloc[i],whole.Signal.iloc[i-1])


if __name__=='__main__':
    unittest.main()
