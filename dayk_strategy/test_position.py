import unittest

import pandas as pd

from fundamental_strategy import enriched
from position_research import ConfirmedPolicy,acceptance,blend,features,target_check
from research import simulate
from strategy import Config,demo_bars
from swing_research import matched_hold
from test_fundamentals import financial_fixture


class PositionTests(unittest.TestCase):
    def row(self,**changes):
        return pd.Series({**dict(RevenueAcceleration=.05,GrossMarginYoYAcceleration=.02,
                                 FinAgeDays=60,Close=109,PriorClose=110,PriorLow=108,Volume=120,
                                 PriorVolume20=100,EMA=100,SMA=95,RelativeReturn20=.05,
                                 Overheat=False,PriorOverheat=True,RSI2=50),**changes})

    def fixture(self):
        dates=pd.bdate_range('2024-01-01',periods=4)
        data=pd.DataFrame(dict(Open=[100.,120.,90.,110.],Close=[110.,115.,100.,105.]),index=dates)
        config=Config(initial_cash=1000,fee_bps=100,slippage_bps=100)
        units=1000/(101*1.01)
        cash=units*118.8*.99
        rebuy=cash/(90.9*1.01)
        tactical=pd.DataFrame(dict(Equity=[units*110,cash,rebuy*100,rebuy*105],
                                    Units=[units,0,rebuy,rebuy],Fill=['BUY','SELL','BUY',''],
                                    FillPrice=[101,118.8,90.9,float('nan')],
                                    Rule=['fixture']*4,Signal=['SELL','BUY','',''],Reason=['test']*4,
                                    Stop=[float('nan')]*4),index=dates)
        return data,matched_hold(data,tactical,config),tactical,config

    def test_profit_target_is_profit_times_1point5_not_wealth_or_percentage_points(self):
        self.assertTrue(target_check(300,200)['target_pass'])
        self.assertFalse(target_check(299.99,200)['target_pass'])
        self.assertEqual(target_check(300,200)['profit_multiple'],1.5)
        for hold in [0,-10]:
            self.assertFalse(target_check(10,hold)['target_pass'])
            self.assertIsNone(target_check(10,hold)['profit_multiple'])

    def test_exit_confirmations_and_financial_exit_priority(self):
        self.assertEqual(ConfirmedPolicy()(self.row(),'reversal',True,None)[0],'SELL')
        self.assertEqual(ConfirmedPolicy()(self.row(),'range_break',True,None)[0],'')
        self.assertEqual(ConfirmedPolicy()(self.row(Close=107),'range_break',True,None)[0],'SELL')
        self.assertEqual(ConfirmedPolicy()(self.row(Close=107,Volume=100),'range_volume',True,None)[0],'')
        self.assertEqual(ConfirmedPolicy()(self.row(Close=107),'range_volume',True,None)[0],'SELL')
        bad=self.row(PriorOverheat=False,RevenueAcceleration=-.05,GrossMarginYoYAcceleration=-.02)
        self.assertEqual(ConfirmedPolicy()(bad,'range_volume',True,None)[0],'SELL')
        with self.assertRaises(ValueError):ConfirmedPolicy()(self.row(),'typo',True,None)

    def test_funded_sleeves_reconcile_cash_and_proportional_fees(self):
        data,core,tactical,config=self.fixture()
        curve=blend(data,core,tactical,.5,config)
        units=tactical.Units.iloc[0]
        self.assertAlmostEqual(curve.Cash.iloc[1],units*.5*118.8*.99)
        self.assertAlmostEqual(curve.Fee.iloc[1],units*.5*118.8*.01)
        self.assertAlmostEqual(curve.Units.iloc[1],units*.5)
        self.assertGreater(curve.Exposure.iloc[1],0)
        self.assertLess(curve.Exposure.iloc[1],1)
        self.assertNotAlmostEqual(curve.Exposure.iloc[1],.5)
        self.assertAlmostEqual(curve.Cash.iloc[2],0)
        pd.testing.assert_series_equal(curve.Equity,(core.Equity+tactical.Equity)/2)
        self.assertEqual(curve.Action.tolist(),['加仓','减仓','加仓',''])

    def test_zero_and_full_tactical_boundaries_have_no_phantom_trades(self):
        data,core,tactical,config=self.fixture()
        zero=blend(data,core,tactical,0,config)
        one=blend(data,core,tactical,1,config)
        pd.testing.assert_series_equal(zero.Equity,core.Equity)
        pd.testing.assert_series_equal(zero.Fill,core.Fill)
        pd.testing.assert_series_equal(zero.FillPrice,core.FillPrice)
        self.assertEqual((zero.Action!='').sum(),1)
        self.assertEqual((zero.Fee>0).sum(),1)
        pd.testing.assert_series_equal(one.Equity,tactical.Equity)
        with self.assertRaises(ValueError):blend(data,core,tactical,1.01,config)
        with self.assertRaises(ValueError):blend(data,core,tactical.iloc[:-1],.5,config)

    def test_unfunded_equity_change_is_rejected(self):
        data,core,tactical,config=self.fixture()
        tactical.loc[tactical.index[1],'Equity']+=10
        with self.assertRaisesRegex(ValueError,'不守恒'):blend(data,core,tactical,.5,config)

    def test_full_period_target_alone_does_not_pass(self):
        row=dict(rule='range_break',tactical_weight=.5,target_pass=True,excess_aligned_pp=1,
                 completed_rebuys=3,median_tactical_hold_sessions=21)
        sections={s:dict(candidates=[row.copy()]) for s in ['full','late','cost_stress','delay_stress']}
        self.assertTrue(acceptance(sections,'range_break',.5)['historical_pass'])
        sections['late']['candidates'][0]['target_pass']=False
        self.assertFalse(acceptance(sections,'range_break',.5)['historical_pass'])

    def test_confirmed_rules_are_causal_and_fills_follow_previous_close(self):
        data,_=enriched(demo_bars(),financial_fixture())
        data['RevenueAcceleration']=.05;data['GrossMarginYoYAcceleration']=.02
        data['FinAgeDays']=60;data['RelativeReturn20']=.05
        data=features(data)
        for rule in ['range_break','range_volume']:
            whole,_=simulate(data,'2023-01-01',rule,policy=ConfirmedPolicy())
            short,_=simulate(data.loc[:'2024-08-01'],'2023-01-01',rule,policy=ConfirmedPolicy())
            pd.testing.assert_frame_equal(short,whole.loc[short.index])
            self.assertGreater((whole.Fill=='SELL').sum(),0)
            for i in range(1,len(whole)):
                if whole.Fill.iloc[i]:self.assertEqual(whole.Fill.iloc[i],whole.Signal.iloc[i-1])


if __name__=='__main__':unittest.main()
