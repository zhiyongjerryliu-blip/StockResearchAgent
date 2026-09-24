import copy
import tempfile
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

from dynamic_research import ExposurePolicy,dynamic_simulate
from fundamental_strategy import enriched
from integrated_research import IntegratedPolicy
from position_research import features
from stockresearch_adapter import adjusted_prices,add_market_flow,export_flow,extra_financial_daily
from strategy import demo_bars
from test_fundamentals import fact,financial_fixture,snapshot


class IntegratedTests(unittest.TestCase):
    def row(self,**changes):
        return pd.Series({**dict(RevenueAcceleration=.05,GrossMarginYoYAcceleration=.02,FinAgeDays=60,
                                 Close=110,PriorClose=111,PriorLow=108,EMA=100,SMA=95,SMA120=90,
                                 RelativeReturn20=.05,PriorOverheat=False,RSI2=50,
                                 FlowAvailable=True,FlowScore=10,PriorFlowScore=10,MarketRiskOff=False,
                                 OCFMarginYoY=.1,OperatingMarginYoY=.1),**changes})

    def test_adjusts_entire_ohlc_and_rejects_missing_adjusted_close(self):
        raw=dict(ticker='SPY',trade_date='2024-01-02',open=100,high=110,low=90,close=105,adjusted_close=52.5,volume=1000)
        result=adjusted_prices({'prices':[raw]},'SPY')
        self.assertEqual(result.iloc[0].to_dict(),dict(Open=50,High=55,Low=45,Close=52.5,Volume=1000))
        with self.assertRaises(ValueError):adjusted_prices({'prices':[{**raw,'adjusted_close':None}]},'SPY')

    def test_actual_node_module_prefix_is_invariant(self):
        bars=demo_bars().iloc[:260]
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            whole=export_flow(bars,root);short=export_flow(bars.iloc[:220],root)
        self.assertEqual(short['rows'],whole['rows'][:220])
        self.assertEqual(whole['rows'][-1]['dataLevel'],'DAILY_PROXY')
        self.assertIsNone(whole['rows'][0]['score'])
        self.assertIsNotNone(whole['rows'][-1]['score'])
        self.assertAlmostEqual(whole['rows'][-1]['close'],bars.Close.iloc[-1])

    def test_market_gaps_are_not_filled_and_flow_price_mismatch_rejected(self):
        bars=demo_bars().iloc[:260]
        prices=[dict(ticker='SPY',trade_date=str(day.date()),open=r.Open,high=r.High,low=r.Low,close=r.Close,
                     adjusted_close=r.Close,volume=r.Volume) for day,r in bars.iterrows()]
        del prices[210]
        flow=dict(rows=[dict(Date=str(day.date()),priceDate=str(day.date()),close=r.Close,score=0,signal='NEUTRAL',metrics={}) for day,r in bars.iterrows()])
        result=add_market_flow(bars,{'prices':prices},flow)
        self.assertTrue(result.MarketAvailable.iloc[209])
        self.assertFalse(result.MarketAvailable.iloc[210])
        self.assertFalse(result.MarketAvailable.iloc[-1])
        self.assertTrue(pd.isna(result.SPYClose.iloc[210]))
        flow['rows'][0]['close']*=2
        with self.assertRaisesRegex(ValueError,'价格不一致'):add_market_flow(bars,{'prices':prices},flow)

    def financial(self):
        facts=[]
        for year,values in [(2023,[100,10,30,20]),(2024,[300,60,45,30])]:
            for metric,value in zip(['revenue','operatingCashFlow','operatingIncome','netIncome'],values):
                facts.append(fact(metric,f'{year}-01-01',f'{year}-03-31',value,f'{year}-05-06'))
        filings=[dict(accession_number='filing-2024-05-06',accepted_at='2024-05-07T22:00:00Z')]
        return snapshot(facts,filings)

    def test_additional_financial_metrics_follow_acceptance_and_restated_vintages(self):
        snap=self.financial();dates=pd.bdate_range('2024-05-06','2024-05-15')
        got=extra_financial_daily(snap,dates)
        self.assertTrue(pd.isna(got.OCFMargin.iloc[1]))
        self.assertAlmostEqual(got.OCFMargin.iloc[2],.2)
        self.assertAlmostEqual(got.OCFMarginYoY.iloc[2],.1)
        self.assertAlmostEqual(got.OperatingMarginYoY.iloc[2],-.15)
        self.assertAlmostEqual(got.CashConversion.iloc[2],2)
        later=copy.deepcopy(snap);later['facts'].append(fact('operatingCashFlow','2024-01-01','2024-03-31',90,'2024-05-10'))
        revised=extra_financial_daily(later,dates)
        pd.testing.assert_frame_equal(got.loc[:'2024-05-10'],revised.loc[:'2024-05-10'])
        self.assertAlmostEqual(revised.loc['2024-05-13','OCFMargin'],.3)
        delayed=extra_financial_daily(snap,dates,1)
        self.assertTrue(pd.isna(delayed.OCFMargin.iloc[2]));self.assertAlmostEqual(delayed.OCFMargin.iloc[3],.2)

    def test_loss_making_cash_conversion_stays_unknown(self):
        snap=self.financial()
        for f in snap['facts']:
            if f['metric_key']=='netIncome':f['value']=-30
        got=extra_financial_daily(snap,pd.bdate_range('2024-05-08','2024-05-10'))
        self.assertTrue(got.CashConversion.isna().all())
        self.assertAlmostEqual(got.NetMargin.iloc[-1],-.1)

    def test_incremental_rule_gates_and_financial_exit_remains_zero(self):
        flow=IntegratedPolicy('flow')
        self.assertFalse(flow.tactical_trigger(self.row(Close=107,PriorOverheat=True,FlowScore=20)))
        self.assertTrue(flow.tactical_trigger(self.row(Close=107,PriorOverheat=True,FlowScore=-1)))
        self.assertTrue(flow.tactical_trigger(self.row(Close=99,FlowScore=-20,PriorFlowScore=-20)))
        self.assertFalse(flow.tactical_trigger(self.row(Close=99,FlowScore=np.nan,FlowAvailable=False)))
        p=IntegratedPolicy('flow_market_cash');self.assertEqual(p(self.row())[0],1)
        self.assertEqual(p(self.row(Close=99,MarketRiskOff=True))[0],.5)
        self.assertEqual(p(self.row(Close=94,OCFMarginYoY=-.1,OperatingMarginYoY=-.1))[0],.5)
        self.assertEqual(p(self.row(Close=94,OCFMarginYoY=np.nan,OperatingMarginYoY=-.1))[0],1)
        self.assertEqual(p(self.row(RevenueAcceleration=-.1,GrossMarginYoYAcceleration=-.1,MarketRiskOff=True))[0],0)

    def test_integrated_baseline_equals_prior_engine_and_all_rules_are_causal(self):
        data,_=enriched(demo_bars(),financial_fixture());data=features(data)
        data['RevenueAcceleration']=.05;data['GrossMarginYoYAcceleration']=.02
        data['FinAgeDays']=60;data['RelativeReturn20']=.05
        data['FlowAvailable']=True;data['FlowScore']=np.where(data.Close<data.EMA,-30,20)
        data['PriorFlowScore']=data.FlowScore.shift(1)
        data['MarketRiskOff']=data.Close<data.SMA
        data['OCFMarginYoY']=-.1;data['OperatingMarginYoY']=-.1
        base,_=dynamic_simulate(data,'2023-01-01','fixture',policy=ExposurePolicy('partial_break'))
        for rule in ['baseline','flow','flow_market','flow_market_cash']:
            whole,_=dynamic_simulate(data,'2023-01-01','fixture',policy=IntegratedPolicy(rule))
            short,_=dynamic_simulate(data.loc[:'2024-08-01'],'2023-01-01','fixture',policy=IntegratedPolicy(rule))
            pd.testing.assert_frame_equal(short,whole.loc[short.index])
            if rule=='baseline':pd.testing.assert_frame_equal(base,whole)
            self.assertGreater((whole.Fill=='SELL').sum(),0)


if __name__=='__main__':unittest.main()
