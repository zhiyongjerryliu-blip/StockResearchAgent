import math
import unittest

import pandas as pd

from conviction_research import attribution, cash_gaps, conviction_policy
from fundamental_strategy import enriched
from research import simulate
from strategy import Config, demo_bars
from test_fundamentals import financial_fixture


class ConvictionTests(unittest.TestCase):
    def row(self, **changes):
        return pd.Series({**dict(RevenueYoY=.1,GrossMarginYoY=.03,RevenueAcceleration=.04,
                                 GrossMarginYoYAcceleration=.01,FinAgeDays=60,
                                 Close=110,SMA=100,SMA120=95),**changes})

    def test_healthy_operations_suspend_price_and_acceleration_exits(self):
        row=self.row(Close=80,RevenueAcceleration=-.02,GrossMarginYoYAcceleration=-.01)
        self.assertEqual(conviction_policy(row,'conviction_exit',True,90),('',''))
        row.RevenueYoY=-.1
        self.assertEqual(conviction_policy(row,'conviction_exit',True,90)[0],'SELL')

    def test_missing_or_stale_data_cannot_protect_a_broken_trend(self):
        for changes in [dict(FinAgeDays=181),dict(RevenueYoY=float('nan'))]:
            row=self.row(Close=80,**changes)
            self.assertEqual(conviction_policy(row,'conviction_exit',True,90)[0],'SELL')

    def test_entry_ablation_and_price_guard(self):
        row=self.row(RevenueAcceleration=-.02,GrossMarginYoYAcceleration=-.01)
        self.assertEqual(conviction_policy(row,'conviction_exit',False,None),('',''))
        self.assertEqual(conviction_policy(row,'level_or_inflection',False,None)[0],'BUY')
        row.SMA120=115
        self.assertEqual(conviction_policy(row,'level_or_inflection',False,None),('',''))
        row=self.row(RevenueYoY=-.1,GrossMarginYoY=-.03)
        self.assertEqual(conviction_policy(row,'level_or_inflection',False,None)[0],'BUY')

    def test_cash_intervals_include_initial_wait_and_terminal_mark(self):
        dates=pd.bdate_range('2024-01-01',periods=5)
        data=pd.DataFrame(dict(Open=[100,120,90,110,130],Close=[105,125,95,115,140]),index=dates)
        curve=pd.DataFrame(dict(Fill=['','BUY','SELL','BUY','SELL']),index=dates)
        gaps=cash_gaps(data,curve)
        expected=[120/100,110/90,140/130]
        self.assertEqual(len(gaps),3)
        for got,ratio in zip(gaps.relative_log_pp,expected):
            self.assertAlmostEqual(got,-100*math.log(ratio))
        self.assertEqual(gaps.iloc[-1].end_mark,'期末收盘')
        never=pd.DataFrame(dict(Fill=['']*5),index=dates)
        self.assertAlmostEqual(cash_gaps(data,never).relative_log_pp.sum(),-100*math.log(1.4))

    def test_bad_ledger_rejected(self):
        dates=pd.bdate_range('2024-01-01',periods=2)
        data=pd.DataFrame(dict(Open=[100,110],Close=[100,110]),index=dates)
        for fills in [['SELL',''],['BUY','BUY']]:
            with self.assertRaises(ValueError):
                cash_gaps(data,pd.DataFrame(dict(Fill=fills),index=dates))

    def test_replay_causality_next_open_and_attribution_conservation(self):
        data,_=enriched(demo_bars(),financial_fixture())
        # Alternate fully known synthetic regimes to force multiple round trips.
        for i,day in enumerate(data.index):
            good=(i//60)%2==0
            data.loc[day,['RevenueYoY','GrossMarginYoY','RevenueAcceleration','GrossMarginYoYAcceleration']]=.05 if good else -.05
        data['FinAgeDays']=60
        hold,_=simulate(data,'2023-01-01','hold',policy=conviction_policy)
        zero=Config(fee_bps=0,slippage_bps=0)
        zero_hold,_=simulate(data,'2023-01-01','hold',zero,policy=conviction_policy)
        for rule in ['conviction_exit','level_or_inflection']:
            curve,trades=simulate(data,'2023-01-01',rule,policy=conviction_policy)
            short,_=simulate(data.loc[:'2024-08-01'],'2023-01-01',rule,policy=conviction_policy)
            pd.testing.assert_frame_equal(short,curve.loc[short.index])
            self.assertGreater(len(trades),1)
            for i in range(1,len(curve)):
                if curve.Fill.iloc[i]:
                    self.assertEqual(curve.Fill.iloc[i],curve.Signal.iloc[i-1])
            gross,_=simulate(data,'2023-01-01',rule,zero,policy=conviction_policy)
            got=attribution(data,curve,hold,gross,zero_hold)
            self.assertAlmostEqual(got['identity_residual_log_pp'],0)
            self.assertLess(got['extra_cost_log_pp'],0)
            self.assertAlmostEqual(got['net_relative_log_pp'],got['missed_rallies_log_pp']+
                                   got['avoided_declines_log_pp']+got['extra_cost_log_pp'])


if __name__=='__main__':
    unittest.main()
