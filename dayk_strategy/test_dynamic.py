import unittest

import pandas as pd

from dynamic_research import ExposurePolicy,dynamic_simulate,execute_target,reduction_intervals
from fundamental_strategy import enriched
from position_research import features
from strategy import Config,demo_bars
from test_fundamentals import financial_fixture


class DynamicTests(unittest.TestCase):
    def row(self,**changes):
        return pd.Series({**dict(RevenueAcceleration=.05,GrossMarginYoYAcceleration=.02,
                                 FinAgeDays=60,Close=110,PriorClose=111,PriorLow=108,EMA=100,SMA=95,
                                 SMA120=90,RelativeReturn20=.05,PriorOverheat=False,RSI2=50),**changes})

    def test_execution_uses_post_cost_nav_for_every_target(self):
        config=Config(fee_bps=100,slippage_bps=100)
        for cash,units in [(1000,0),(0,10),(500,5)]:
            for target in [0,.25,.5,1]:
                new_cash,new_units,delta,price,fee=execute_target(cash,units,100,target,config)
                self.assertGreaterEqual(new_cash,0);self.assertGreaterEqual(new_units,0)
                self.assertAlmostEqual(new_units*100/(new_cash+new_units*100),target)
                self.assertAlmostEqual(new_units,units+delta)
                if delta:
                    self.assertAlmostEqual(new_cash,cash-delta*price-fee)
                    self.assertEqual(price,101 if delta>0 else 99)
                    self.assertAlmostEqual(fee,abs(delta)*price*.01)
                else:self.assertEqual(fee,0)

    def test_state_targets_and_financial_exit(self):
        policy=ExposurePolicy('trend_defense')
        self.assertEqual(policy(self.row())[0],1)
        self.assertEqual(policy(self.row(Close=94))[0],.5)
        self.assertEqual(policy(self.row(Close=89))[0],.25)
        self.assertEqual(policy(self.row())[0],1)
        bad=self.row(RevenueAcceleration=-.05,GrossMarginYoYAcceleration=-.02)
        self.assertEqual(policy(bad)[0],0)
        self.assertEqual(policy(self.row(),fill='SELL')[0],0)
        self.assertEqual(policy(self.row())[0],1)
        relative=ExposurePolicy('relative_defense');relative(self.row())
        self.assertEqual(relative(self.row(RelativeReturn20=float('nan')))[0],.5)

    def test_tactical_recovery_waits_past_reduction_fill_day(self):
        policy=ExposurePolicy('partial_break');policy(self.row())
        self.assertEqual(policy(self.row(Close=107,PriorOverheat=True))[0],.5)
        self.assertEqual(policy(self.row(Close=99),fill='SELL')[0],.5)
        self.assertEqual(policy(self.row(Close=99))[0],1)

    def test_target_changes_fill_next_open_no_daily_rebalance_and_last_signal_pending(self):
        dates=pd.bdate_range('2024-01-01',periods=4)
        data=pd.DataFrame(dict(Open=[100,120,100,80],Close=[100,100,120,90],Ready=True),index=dates)
        targets=iter([.5,.5,1,0])
        curve,fills=dynamic_simulate(data,dates[0],'fixture',Config(initial_cash=1000,fee_bps=0,slippage_bps=0),
                                     policy=lambda row,fill:(next(targets),'test'))
        self.assertEqual(curve.Fill.tolist(),['','BUY','','BUY'])
        self.assertEqual(curve.Signal.tolist(),['TARGET','','TARGET','TARGET'])
        self.assertAlmostEqual(curve.Units.iloc[1],500/120)
        self.assertAlmostEqual(curve.Units.iloc[2],500/120)
        self.assertAlmostEqual(curve.Units.iloc[3],500/120+500/80)
        self.assertAlmostEqual(curve.Cash.iloc[-1],0)
        self.assertEqual(fills.signal_date.tolist(),[str(dates[0].date()),str(dates[2].date())])

    def test_multiple_reductions_group_until_next_increase_and_terminal_remains_open(self):
        curve=pd.DataFrame(dict(Fill=['BUY','SELL','SELL','','BUY','SELL']),index=pd.bdate_range('2024-01-01',periods=6))
        intervals=reduction_intervals(curve)
        self.assertEqual(len(intervals),2)
        self.assertEqual(intervals.status.tolist(),['减仓后再加仓','期末尚未加仓'])
        self.assertEqual(intervals.sessions.iloc[0],3)
        self.assertIsNone(intervals.increase_date.iloc[-1])

    def test_prefix_causality_costs_and_position_bounds(self):
        data,_=enriched(demo_bars(),financial_fixture())
        data['RevenueAcceleration']=.05;data['GrossMarginYoYAcceleration']=.02
        data['FinAgeDays']=60;data['RelativeReturn20']=.05
        data=features(data)
        for rule in ['partial_break','trend_defense','relative_defense']:
            whole,fills=dynamic_simulate(data,'2023-01-01',rule)
            short,_=dynamic_simulate(data.loc[:'2024-08-01'],'2023-01-01',rule)
            pd.testing.assert_frame_equal(short,whole.loc[short.index])
            self.assertGreater((whole.Fill=='SELL').sum(),0)
            self.assertGreaterEqual(whole.Cash.min(),0)
            self.assertLessEqual(whole.Exposure.max(),1+1e-10)
            self.assertGreater(fills.fee.sum(),0)
            for i in range(1,len(whole)):
                if whole.Fill.iloc[i]:
                    self.assertEqual(whole.Signal.iloc[i-1],'TARGET')
                    self.assertEqual(whole.FillTarget.iloc[i],whole.Target.iloc[i-1])


if __name__=='__main__':unittest.main()
