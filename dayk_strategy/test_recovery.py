import unittest

import pandas as pd

from fundamental_strategy import enriched
from position_research import ConfirmedPolicy,features
from recovery_research import RecoveryPolicy,decorate,local_reduction_audit,pnl_difference
from research import simulate
from strategy import Config,demo_bars
from test_fundamentals import financial_fixture
import test_position


class RecoveryTests(unittest.TestCase):
    def row(self,**changes):
        return pd.Series({**dict(RevenueAcceleration=.05,GrossMarginYoYAcceleration=.02,
                                 FinAgeDays=60,Close=110,PriorClose=111,PriorLow=108,PriorHigh=112,
                                 EMA=100,SMA=95,RelativeReturn20=.05,PriorOverheat=False,RSI2=50,
                                 FlowScore=10,PriorFlowScore=0),**changes})

    def test_memory_window_expires_and_sell_clears_it(self):
        policy=RecoveryPolicy('exit_memory')
        policy(self.row(PriorOverheat=True),None,True,None)
        for _ in range(8):self.assertEqual(policy(self.row(),None,True,None)[0],'')
        self.assertEqual(policy(self.row(Close=107),None,True,None)[0],'SELL')
        self.assertEqual(policy.arm,0)
        expired=RecoveryPolicy('exit_memory');expired(self.row(PriorOverheat=True),None,True,None)
        for _ in range(9):expired(self.row(),None,True,None)
        self.assertEqual(expired(self.row(Close=107),None,True,None)[0],'')

    def test_confirmed_reentry_waits_for_price_recovery(self):
        policy=RecoveryPolicy('reentry_confirmation')
        policy(self.row(Close=107,PriorOverheat=True),None,True,None)
        policy(self.row(Close=99),None,False,None)
        self.assertEqual(policy(self.row(Close=98,PriorClose=99),None,False,None)[0],'')
        self.assertEqual(policy(self.row(Close=99,PriorClose=98),None,False,None)[0],'BUY')

    def test_missing_financial_information_cancels_reentry(self):
        for rule in ['baseline','memory_confirmation','fast_reentry']:
            p=RecoveryPolicy(rule);p(self.row(Close=107,PriorOverheat=True),None,True,None)
            self.assertEqual(p(self.row(FinAgeDays=181),None,False,None)[0],'')
            self.assertFalse(p.tactical)

    def test_fast_reentry_still_fills_only_next_open(self):
        dates=pd.bdate_range('2024-01-01',periods=6)
        rows=[self.row().to_dict() for _ in dates]
        for r in rows:r.update(Open=100,High=120,Low=90,Close=99,ATR=5,Ready=True,PriorClose=110,PriorLow=108)
        rows[1]['PriorOverheat']=True
        data=pd.DataFrame(rows,index=dates)
        fast,_=simulate(data,dates[0],'fast_reentry',policy=RecoveryPolicy('fast_reentry'),allow_sell_day_signal=True)
        slow,_=simulate(data,dates[0],'baseline',policy=RecoveryPolicy('baseline'))
        self.assertEqual(fast.Fill.iloc[2],'SELL');self.assertEqual(fast.Signal.iloc[2],'BUY')
        self.assertEqual(fast.Fill.iloc[3],'BUY');self.assertEqual(fast.Units.iloc[2],0)
        self.assertEqual(slow.Fill.iloc[4],'BUY');self.assertEqual(slow.Units.iloc[3],0)

    def test_dollar_attribution_and_local_shadow_include_costs(self):
        data,core,tactical,config=test_position.PositionTests().fixture()
        core=decorate(data,core,config);tactical=decorate(data,tactical,config)
        components,stats=pnl_difference(data,tactical,core)
        self.assertAlmostEqual(stats['total'],tactical.Equity.iloc[-1]-core.Equity.iloc[-1])
        self.assertLess(stats['fees'],0);self.assertLess(stats['slippage'],0)
        self.assertAlmostEqual(stats['residual'],0)
        audit=local_reduction_audit(tactical,data)
        self.assertEqual(len(audit),1)
        self.assertAlmostEqual(audit.shadow_equity.iloc[0],tactical.Units.iloc[0]*data.Close.iloc[2])
        broken=tactical.copy();broken.loc[broken.index[-1],'Equity']+=1
        with self.assertRaisesRegex(ValueError,'不守恒'):pnl_difference(data,broken,core)

    def test_original_baseline_matches_and_all_replays_are_prefix_invariant(self):
        data,_=enriched(demo_bars(),financial_fixture());data=features(data);data['PriorHigh']=data.High.shift(1)
        data['RevenueAcceleration']=.05;data['GrossMarginYoYAcceleration']=.02;data['FinAgeDays']=60
        data['RelativeReturn20']=.05;data['FlowScore']=10.;data['PriorFlowScore']=0.
        reference,_=simulate(data,'2023-01-01','range_break',policy=ConfirmedPolicy())
        for rule in ['baseline','exit_memory','reentry_confirmation','memory_confirmation','flow_recovery','fast_reentry']:
            whole,_=simulate(data,'2023-01-01',rule,policy=RecoveryPolicy(rule),allow_sell_day_signal=rule=='fast_reentry')
            short,_=simulate(data.loc[:'2024-08-01'],'2023-01-01',rule,policy=RecoveryPolicy(rule),allow_sell_day_signal=rule=='fast_reentry')
            pd.testing.assert_frame_equal(short,whole.loc[short.index])
            self.assertGreater((whole.Fill=='SELL').sum(),0)
            if rule=='baseline':
                pd.testing.assert_frame_equal(whole[['Equity','Units','Fill']],reference[['Equity','Units','Fill']])


if __name__=='__main__':unittest.main()
