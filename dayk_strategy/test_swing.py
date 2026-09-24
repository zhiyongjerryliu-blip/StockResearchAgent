import unittest

import pandas as pd

from fundamental_strategy import enriched
from research import simulate
from strategy import Config,demo_bars
from swing_research import RULES,SwingPolicy,acceptance,matched_hold,rebuy_ledger,swing_features
from test_fundamentals import financial_fixture


class SwingTests(unittest.TestCase):
    def row(self,**changes):
        return pd.Series({**dict(RevenueAcceleration=.05,GrossMarginYoYAcceleration=.02,
                                 FinAgeDays=60,Close=109,PriorClose=110,EMA=100,SMA=95,
                                 RelativeReturn20=.05,Overheat=False,PriorOverheat=True,RSI2=50),**changes})

    def test_wait_for_reversal_and_rebuy_not_on_sell_day(self):
        policy=SwingPolicy()
        self.assertEqual(policy(self.row(Close=111),'swing_reversal',True,None),('',''))
        self.assertEqual(policy(self.row(),'swing_reversal',True,None)[0],'SELL')
        self.assertEqual(policy(self.row(Close=99),'swing_reversal',False,None),('',''))
        self.assertEqual(policy(self.row(Close=99),'swing_reversal',False,None)[0],'BUY')

    def test_cash_timeout_and_breakout_reentry(self):
        policy=SwingPolicy()
        policy(self.row(),'swing_reversal',True,None)
        for _ in range(4):self.assertEqual(policy(self.row(Close=105),'swing_reversal',False,None),('',''))
        self.assertEqual(policy(self.row(Close=105),'swing_reversal',False,None)[0],'BUY')
        policy=SwingPolicy();policy(self.row(),'swing_reversal',True,None)
        policy(self.row(),'swing_reversal',False,None)
        self.assertEqual(policy(self.row(Close=110),'swing_reversal',False,None)[0],'BUY')

    def test_bad_fundamentals_cancel_tactical_rebuy(self):
        policy=SwingPolicy();policy(self.row(),'swing_reversal',True,None)
        bad=self.row(RevenueAcceleration=-.05,GrossMarginYoYAcceleration=-.02)
        self.assertEqual(policy(bad,'swing_reversal',False,None),('',''))
        self.assertFalse(policy.tactical)
        policy=SwingPolicy()
        self.assertEqual(policy(bad,'swing_reversal',True,None)[0],'SELL')
        self.assertFalse(policy.tactical)

    def test_rebuy_ledger_deducts_two_fees_and_leaves_terminal_exit_open(self):
        dates=pd.bdate_range('2024-01-01',periods=5)
        new_units=10*.99/1.01
        curve=pd.DataFrame(dict(Fill=['BUY','SELL','','BUY','SELL'],FillPrice=[100,100,float('nan'),100,100],
                                Units=[10,0,0,new_units,0],Reason=['exit','','','exit','']),index=dates)
        ledger=rebuy_ledger(curve,Config(fee_bps=100,slippage_bps=0))
        self.assertAlmostEqual(ledger.unit_multiplier.iloc[0],.99/1.01)
        self.assertLess(ledger.unit_change_pct.iloc[0],0)
        self.assertEqual(ledger.status.iloc[-1],'期末尚未回补')
        self.assertTrue(pd.isna(ledger.unit_multiplier.iloc[-1]))

    def test_matched_hold_stays_cash_before_entry_even_when_entry_is_last_day(self):
        dates=pd.bdate_range('2024-01-01',periods=3)
        data=pd.DataFrame(dict(Open=[100,110,90],Close=[110,90,99]),index=dates)
        curve=pd.DataFrame(dict(Fill=['','','BUY'],Units=[0,0,1],Equity=[100,100,110]),index=dates)
        config=Config(initial_cash=1000,fee_bps=100,slippage_bps=100)
        got=matched_hold(data,curve,config)
        self.assertEqual(got.Equity.iloc[0],1000)
        self.assertEqual(got.Equity.iloc[1],1000)
        self.assertAlmostEqual(got.Equity.iloc[-1],1000/(90*1.01*1.01)*99)
        curve['Fill']=''
        self.assertTrue((matched_hold(data,curve,config).Equity==1000).all())

    def test_beating_ordinary_hold_alone_does_not_pass(self):
        values=dict(excess_hold_pp=10,excess_aligned_pp=-1,completed_rebuys=10,
                    median_closed_holding_sessions=5)
        result={s:{'swing_reversal':values.copy()} for s in ['full','late','cost_stress']}
        self.assertFalse(acceptance(result,'swing_reversal')['historical_pass'])
        for section in result:result[section]['swing_reversal']['excess_aligned_pp']=1
        self.assertTrue(acceptance(result,'swing_reversal')['historical_pass'])

    def test_prefix_next_open_and_unit_attribution_identity(self):
        data,_=enriched(demo_bars(),financial_fixture())
        data['RevenueAcceleration']=.05;data['GrossMarginYoYAcceleration']=.02
        data['FinAgeDays']=60;data['RelativeReturn20']=.05
        data=swing_features(data)
        for rule in RULES:
            whole,_=simulate(data,'2023-01-01',rule,policy=SwingPolicy())
            short,_=simulate(data.loc[:'2024-08-01'],'2023-01-01',rule,policy=SwingPolicy())
            pd.testing.assert_frame_equal(short,whole.loc[short.index])
            for i in range(1,len(whole)):
                if whole.Fill.iloc[i]:self.assertEqual(whole.Fill.iloc[i],whole.Signal.iloc[i-1])
            buys=whole.index[whole.Fill=='BUY']
            self.assertGreater(len(buys),2)
            through_last_buy=whole.loc[:buys[-1]]
            aligned=matched_hold(data,through_last_buy,Config())
            ledger=rebuy_ledger(through_last_buy,Config())
            self.assertAlmostEqual(through_last_buy.Equity.iloc[-1]/aligned.Equity.iloc[-1],ledger.unit_multiplier.prod())


if __name__=='__main__':unittest.main()
