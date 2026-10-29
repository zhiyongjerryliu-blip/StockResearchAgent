import copy
import unittest
import numpy as np
import pandas as pd

from three_factor_research import (disclosure_day, fx_series, local_market_cap, share_records,
                                  visible_share, split_product, split_events, ttm_flows, score, select)
from test_quality_momentum import QualityMomentumTests
from test_fundamentals import fact


class ThreeFactorTests(unittest.TestCase):
    def test_share_disclosure_revision_and_extra_session_delay(self):
        first=dict(end=pd.Timestamp('2025-02-27'),known=pd.Timestamp('2025-03-07'),value=115.,priority=0,source='original')
        revised={**first,'known':pd.Timestamp('2025-03-17'),'value':145.,'source':'revision'}
        records=[first,revised]
        self.assertIsNone(visible_share(records,pd.Timestamp('2025-03-07'),[]))
        self.assertEqual(visible_share(records,pd.Timestamp('2025-03-10'),[])['shares'],115.)
        self.assertEqual(visible_share(records,pd.Timestamp('2025-03-17'),[])['shares'],115.)
        self.assertEqual(visible_share(records,pd.Timestamp('2025-03-18'),[])['shares'],145.)
        days=pd.bdate_range('2025-03-01','2025-03-21')
        self.assertEqual(visible_share(records,pd.Timestamp('2025-03-18'),[],days,1)['shares'],115.)
        self.assertEqual(visible_share(records,pd.Timestamp('2025-03-19'),[],days,1)['shares'],145.)
        self.assertIsNone(visible_share(records,pd.Timestamp('2027-01-01'),[]))

    def test_split_price_share_cancellation_and_comparative_restatement(self):
        event=[(pd.Timestamp('2024-06-10'),10.,True)]
        record=dict(end=pd.Timestamp('2024-04-26'),known=pd.Timestamp('2024-05-22'),value=100.,priority=0,source='cover')
        pre=pd.Timestamp('2024-05-31');post=pd.Timestamp('2024-06-28')
        # Same enterprise value around a purely mechanical split.
        cap_before=10.*split_product(event,pre)*visible_share([record],pre,event)['shares']
        cap_after=10.*split_product(event,post)*visible_share([record],post,event)['shares']
        self.assertEqual(cap_before,cap_after)
        comparative=dict(end='2024-03-31',filed='2024-08-01',accn='x',val=1000.)
        raw={'companyFacts':{'facts':{'us-gaap':{'CommonStockSharesOutstanding':{'units':{'shares':[comparative]}}}}}}
        normalized=share_records(raw,[],event)
        self.assertEqual(normalized[0]['value'],100.)
        self.assertEqual(visible_share(normalized,pd.Timestamp('2024-08-02'),event)['shares'],1000.)

    def test_spinoff_is_price_adjustment_without_new_parent_shares(self):
        timestamp=int(pd.Timestamp('2025-02-24 14:30',tz='UTC').timestamp())
        chart={'chart':{'result':[{'events':{'splits':{'a':dict(date=timestamp,numerator=1323,denominator=1000)}}}]}}
        events=split_events(chart,'WDC')
        before=pd.Timestamp('2025-02-21');after=pd.Timestamp('2025-02-25')
        self.assertAlmostEqual(split_product(events,before),1.323)
        self.assertEqual(split_product(events,before,after,True),1.)

    def test_fx_completed_bar_calendar_and_adr_conversion(self):
        stamp=int(pd.Timestamp('2024-07-07 23:00',tz='UTC').timestamp())
        chart={'chart':{'result':[{'meta':{'exchangeTimezoneName':'Europe/London'},'timestamp':[stamp],
                                 'indicators':{'quote':[{'close':[32.]}]}}]}}
        fx=fx_series(chart)
        self.assertEqual(fx.index[0],pd.Timestamp('2024-07-08'))
        self.assertTrue(fx.loc[fx.index<pd.Timestamp('2024-07-08')].empty)
        self.assertEqual(local_market_cap(100.,5e9,5,'TWD',32.),3.2e12)
        self.assertAlmostEqual(local_market_cap(100.,1e9,1,'EUR',1.25),8e10)

    def test_ttm_future_revision_independence_and_publication_gate(self):
        sample=QualityMomentumTests().financial_sample();days=pd.bdate_range('2024-02-14','2024-03-01')
        base=ttm_flows(sample,days,{})
        changed=copy.deepcopy(sample)
        changed['facts'].append(fact('netIncome','2023-10-01','2023-12-31',999999,'2024-04-01'))
        pd.testing.assert_frame_equal(base,ttm_flows(changed,days,{}))
        self.assertEqual(base.ValueFinKnownDay.iloc[1],'2024-02-14')
        self.assertNotEqual(base.ValueFinKnownDay.iloc[0],'2024-02-14')

    def test_group_relative_value_negative_earnings_ties_and_caps(self):
        rank=pd.DataFrame(dict(QualityRank=[1.]*8,MomentumRank=[1.]*8,
                               EarningsYield=[-.1,0.,.1,.1,10.,20.,30.,40.],
                               OCFYield=[-.1,0.,.1,.1,10.,20.,30.,40.]),index=list('ABCDEFGH'))
        mapping={t:('a' if t in 'ABCD' else 'b' if t in 'EF' else 'c') for t in rank.index}
        scored=score(rank,mapping,[0.,0.,1.])
        self.assertLess(scored.loc['A','ValueRank'],scored.loc['B','ValueRank'])
        self.assertEqual(scored.loc['C','ValueRank'],scored.loc['D','ValueRank'])
        self.assertEqual(scored.loc['F','ValueRank'],scored.loc['H','ValueRank'])
        chosen=select(rank,mapping,[0.,0.,1.])
        self.assertEqual(len(chosen),5)
        self.assertLessEqual(sum(t in 'ABCD' for t in chosen),2)
        self.assertEqual(chosen,select(rank.iloc[::-1],mapping,[0.,0.,1.]))
        self.assertEqual(sum(select(rank.iloc[:2],mapping,[.4,.4,.2]).values()),.4)


if __name__=='__main__':unittest.main()
