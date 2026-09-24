import unittest

import pandas as pd

from fundamental_strategy import enriched
from position_research import features
from recovery_research import RecoveryPolicy
from research import simulate
from strategy import demo_bars
from structural_research import StructuralPolicy,structural_features
from test_fundamentals import financial_fixture


class StructuralTests(unittest.TestCase):
    def row(self,**changes):
        return pd.Series({**dict(RevenueAcceleration=.05,GrossMarginYoYAcceleration=.02,FinAgeDays=60,
                                Close=100,PriorClose=110,PriorLow=105,PriorHigh=111,PriorLow20=80,
                                EMA=95,SMA=90,ATR=5,RelativeReturn20=.05,PriorOverheat=False,RSI2=50),**changes})

    def test_trailing_stop_uses_previous_line_and_never_moves_down(self):
        p=StructuralPolicy('atr4');self.assertEqual(p(self.row(),None,False,None)[0],'BUY')
        self.assertEqual(p.stop,80)
        p(self.row(Close=120),None,True,None);self.assertEqual(p.stop,100)
        p(self.row(Close=110,ATR=10),None,True,None);self.assertEqual(p.stop,100)
        self.assertEqual(p(self.row(Close=99,ATR=20),None,True,None)[0],'SELL')
        self.assertEqual(p.exit_mode,'trend')

    def test_trend_reentry_requires_both_ema_and_prior_high(self):
        p=StructuralPolicy('channel');p(self.row(),None,False,None)
        self.assertEqual(p(self.row(Close=79),None,True,None)[0],'SELL')
        p(self.row(Close=112),None,False,None)
        self.assertEqual(p(self.row(Close=110),None,False,None)[0],'')
        self.assertEqual(p(self.row(Close=112),None,False,None)[0],'BUY')
        self.assertEqual(p.stop,92)

    def test_hybrid_distinguishes_exit_types_and_trend_has_priority(self):
        p=StructuralPolicy('hybrid');p(self.row(),None,False,None)
        self.assertEqual(p(self.row(Close=99,PriorOverheat=True),None,True,None)[0],'SELL')
        self.assertEqual(p.exit_mode,'tactical')
        p(self.row(Close=94),None,False,None)
        self.assertEqual(p(self.row(Close=94),None,False,None)[0],'BUY')
        p=StructuralPolicy('hybrid');p(self.row(),None,False,None)
        p(self.row(Close=79,PriorOverheat=True),None,True,None)
        self.assertEqual(p.exit_mode,'trend')

    def test_prefix_causality_original_baseline_and_prior_day_stop_ledger(self):
        data,_=enriched(demo_bars(),financial_fixture());data=structural_features(features(data))
        data['RevenueAcceleration']=.05;data['GrossMarginYoYAcceleration']=.02
        data['FinAgeDays']=60;data['RelativeReturn20']=.05
        ref,_=simulate(data,'2023-01-01','fixture',policy=RecoveryPolicy('baseline'))
        for rule in ['baseline','channel','atr4','hybrid']:
            policy=StructuralPolicy(rule)
            whole,_=simulate(data,'2023-01-01','fixture',policy=policy)
            short,_=simulate(data.loc[:'2024-08-01'],'2023-01-01','fixture',policy=StructuralPolicy(rule))
            pd.testing.assert_frame_equal(short,whole.loc[short.index])
            self.assertGreater((whole.Fill=='SELL').sum(),0)
            if rule=='baseline':pd.testing.assert_frame_equal(ref,whole)
            if rule=='atr4':
                for day,row in whole[whole.Signal=='SELL'].iterrows():
                    self.assertLessEqual(data.loc[day,'Close'],policy.stop_history[day])


if __name__=='__main__':unittest.main()
