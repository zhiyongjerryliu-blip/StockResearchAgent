import json
from types import SimpleNamespace
import unittest

import pandas as pd

from fundamentals import build_daily, prepare_facts, quarterly_points, select_vintages
from fundamental_strategy import enriched, policy
from research import simulate
from strategy import Config, backtest, demo_bars


def fact(metric,start,end,value,filed=None,key=None,tag='TestTag'):
    filed=filed or str((pd.Timestamp(end)+pd.Timedelta(days=45)).date())
    duration=(pd.Timestamp(end)-pd.Timestamp(start)).days+1
    kind='quarter' if duration<120 else 'annual' if duration>320 else 'ytd'
    return dict(source_key=key or f'{metric}:{start}:{end}:{filed}:{tag}',metric_key=metric,tag_priority=0,
                taxonomy='us-gaap',tag=tag,unit='USD',period_start=start,period_end=end,period_type=kind,
                form='10-K' if kind=='annual' else '10-Q',filed_at=filed,accession_number=f'filing-{filed}',
                value=value,source_url='https://www.sec.gov/test',ingested_at='2026-09-20T00:00:00Z')


def snapshot(facts,filings=None):
    return dict(ticker='TEST',facts=facts,filings=filings or [],version='test')


def financial_fixture():
    rows=[]
    for year in range(2021,2026):
        ends=[f'{year}-03-31',f'{year}-06-30',f'{year}-09-30',f'{year}-12-31']
        starts=[f'{year}-01-01',f'{year}-04-01',f'{year}-07-01',f'{year}-10-01']
        revenues=[v*1.2**(year-2021) for v in (100,110,120,130)]
        for i,(start,end,rev) in enumerate(zip(starts,ends,revenues)):
            # Last quarter only reported as full year: test Q4 derivation.
            for metric,ratio in [('revenue',1),('grossProfit',.4),('operatingIncome',.15)]:
                rows.append(fact(metric,start if i<3 else starts[0],end,
                                 rev*ratio if i<3 else sum(revenues)*ratio))
                if i==2:
                    rows.append(fact(metric,starts[0],end,sum(revenues[:3])*ratio))
            for metric,ratio in [('operatingCashFlow',.2),('capitalExpenditure',.05)]:
                rows.append(fact(metric,starts[0],end,sum(revenues[:i+1])*ratio))
    return snapshot(rows)


class FundamentalTests(unittest.TestCase):
    def test_filed_day_excluded_and_acceptance_date_respected(self):
        f=fact('revenue','2024-01-01','2024-03-31',100,'2024-05-03')
        snap=snapshot([f],[dict(accession_number=f['accession_number'],accepted_at='2024-05-06T22:00:00Z')])
        dates=pd.bdate_range('2024-05-03','2024-05-08')
        daily,_=build_daily(snap,dates)
        self.assertIsNone(daily.FinPeriod.iloc[0])
        self.assertIsNone(daily.FinPeriod.iloc[1])
        self.assertEqual(daily.FinPeriod.iloc[2],'2024-03-31')
        delayed,_=build_daily(snap,dates,1)
        self.assertIsNone(delayed.FinPeriod.iloc[2])
        self.assertEqual(delayed.FinPeriod.iloc[3],'2024-03-31')

    def test_q4_and_ytd_are_subtracted_not_averaged(self):
        rows=[fact('operatingCashFlow','2023-01-01','2023-03-31',10),
              fact('operatingCashFlow','2023-01-01','2023-06-30',35),
              fact('operatingCashFlow','2023-01-01','2023-09-30',75),
              fact('operatingCashFlow','2023-01-01','2023-12-31',130)]
        clean,_=prepare_facts(snapshot(rows))
        quarters=quarterly_points(select_vintages(clean))
        self.assertEqual([p['value'] for _,p in sorted(quarters.items())],[10,25,40,55])
        last=quarters[('operatingCashFlow',pd.Timestamp('2023-12-31'))]
        self.assertEqual(last['start'],pd.Timestamp('2023-10-01'))
        self.assertEqual(len(last['sources']),2)

    def test_direct_quarter_takes_precedence(self):
        rows=[fact('revenue','2023-01-01','2023-09-30',600),
              fact('revenue','2023-01-01','2023-12-31',1000),
              fact('revenue','2023-10-01','2023-12-31',410)]
        clean,_=prepare_facts(snapshot(rows))
        quarter=quarterly_points(select_vintages(clean))[('revenue',pd.Timestamp('2023-12-31'))]
        self.assertEqual(quarter['value'],410)
        self.assertFalse(quarter['derived'])

    def test_conflicting_equal_priority_values_remain_unknown(self):
        rows=[fact('revenue','2023-01-01','2023-03-31',100,tag='A'),
              fact('revenue','2023-01-01','2023-03-31',150,tag='B')]
        clean,_=prepare_facts(snapshot(rows))
        selected=select_vintages(clean)
        self.assertIsNone(next(iter(selected.values()))['value'])
        daily,_=build_daily(snapshot(rows),pd.bdate_range('2023-05-16','2023-05-19'))
        self.assertTrue((daily.FinState=='UNKNOWN').all())

    def test_future_restatement_does_not_rewrite_the_past(self):
        base=financial_fixture()
        revised=json.loads(json.dumps(base))
        revised['facts'].append(fact('revenue','2023-01-01','2023-03-31',999,'2024-08-01'))
        dates=pd.bdate_range('2023-01-01','2024-08-15')
        before,_=build_daily(base,dates)
        after,_=build_daily(revised,dates)
        pd.testing.assert_frame_equal(before.loc[:'2024-08-01'],after.loc[:'2024-08-01'])
        self.assertNotEqual(before.loc['2024-08-02','FinSources'],after.loc['2024-08-02','FinSources'])

    def test_known_growth_margin_and_fcf(self):
        dates=pd.bdate_range('2024-02-15','2024-02-20')
        daily,_=build_daily(financial_fixture(),dates)
        row=daily.iloc[-1]
        self.assertAlmostEqual(row.RevenueYoY,.2)
        self.assertAlmostEqual(row.GrossMargin,.4)
        self.assertAlmostEqual(row.GrossMarginYoY,0)
        self.assertAlmostEqual(row.FCFTTM,460*1.2**2*.15)
        self.assertEqual(row.FinState,'EXPANSION')
        self.assertTrue(row.FinDerived)

    def test_missing_cash_flow_and_stale_data_are_not_positive(self):
        snap=financial_fixture()
        snap['facts']=[f for f in snap['facts'] if f['metric_key']!='capitalExpenditure']
        daily,_=build_daily(snap,pd.bdate_range('2024-02-15','2024-02-20'))
        self.assertTrue((daily.FinState=='UNKNOWN').all())
        snap['facts']=[f for f in snap['facts'] if f['period_end']<'2024-01-01']
        daily,_=build_daily(snap,pd.bdate_range('2024-09-01','2024-09-05'))
        self.assertTrue((daily.FinState=='STALE').all())

    def test_adding_later_prices_and_filings_preserves_daily_features(self):
        snap=financial_fixture()
        full,_=build_daily(snap,pd.bdate_range('2023-01-01','2025-09-01'))
        short,_=build_daily(snap,pd.bdate_range('2023-01-01','2024-09-02'))
        pd.testing.assert_frame_equal(short,full.loc[short.index])
        for day,row in full.iterrows():
            if row.FinKnownDay:
                self.assertLess(pd.Timestamp(row.FinKnownDay),day)

    def test_financial_policies_and_next_open_execution(self):
        bars=demo_bars()
        data,_=enriched(bars,financial_fixture())
        whole,trades=simulate(data,'2023-01-01','fund_regime',policy=policy)
        short,_=simulate(data.loc[:'2024-08-01'],'2023-01-01','fund_regime',policy=policy)
        pd.testing.assert_frame_equal(short,whole.loc[short.index])
        for i in range(1,len(whole)):
            if whole.Fill.iloc[i]:
                self.assertEqual(whole.Fill.iloc[i],whole.Signal.iloc[i-1])
        row=SimpleNamespace(FinState='EXPANSION',Close=100,SMA=90,SMA120=80,EMA=110,EntryCondition=True)
        self.assertEqual(policy(row,'fund_extend',True,105),('',''))
        row.FinState='DETERIORATION'
        self.assertEqual(policy(row,'fund_regime',True,105)[0],'SELL')
        row.FinState='UNKNOWN'
        self.assertEqual(policy(row,'fund_regime',False,None),('',''))

    def test_policy_adapter_keeps_original_accounting_identical(self):
        bars=demo_bars()
        original,_,_=backtest(bars,Config(),'2023-01-01')
        data,_=enriched(bars,financial_fixture())
        adapted,_=simulate(data,'2023-01-01','original',policy=policy)
        for name in ['Equity','Fill','FillPrice','Signal','Units']:
            pd.testing.assert_series_equal(original[name],adapted[name],check_freq=False)

    def test_main_and_control_cannot_buy_below_their_exit_line(self):
        row=SimpleNamespace(FinState='EXPANSION',Close=100,SMA=90,SMA120=105)
        for rule in ['fund_regime','trend60_120']:
            self.assertEqual(policy(row,rule,False,None),('',''))
            self.assertEqual(policy(row,rule,True,90)[0],'SELL')


if __name__=='__main__':
    unittest.main()
