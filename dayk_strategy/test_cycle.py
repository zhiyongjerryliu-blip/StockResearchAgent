import unittest

import pandas as pd

from cycle_research import NEW_RULES, SECTIONS, acceptance, add_peers, cycle_policy
from fundamental_strategy import enriched
from research import simulate
from strategy import demo_bars
from test_fundamentals import financial_fixture


class CycleTests(unittest.TestCase):
    def row(self,**changes):
        return pd.Series({**dict(RevenueYoY=-.2,GrossMarginYoY=-.1,RevenueAcceleration=.05,
                                 GrossMarginYoYAcceleration=.02,FinAgeDays=60,Close=90,
                                 SMA=100,EMA=95,RelativeReturn20=.01),**changes})

    def test_cycle_entry_and_exit_do_not_use_price_breaks(self):
        self.assertEqual(cycle_policy(self.row(),'cycle_turn',False,None)[0],'BUY')
        self.assertEqual(cycle_policy(self.row(),'cycle_turn',True,99),('',''))
        row=self.row(RevenueAcceleration=-.05,GrossMarginYoYAcceleration=-.02)
        self.assertEqual(cycle_policy(row,'cycle_turn',True,99)[0],'SELL')
        row.GrossMarginYoYAcceleration=.02
        self.assertEqual(cycle_policy(row,'cycle_turn',True,99),('',''))

    def test_price_and_peer_gates_change_entry_only(self):
        self.assertEqual(cycle_policy(self.row(),'cycle_price',False,None),('',''))
        self.assertEqual(cycle_policy(self.row(Close=96),'cycle_price',False,None)[0],'BUY')
        for relative in [0,-.1,float('nan')]:
            self.assertEqual(cycle_policy(self.row(RelativeReturn20=relative),'cycle_relative',False,None),('',''))
        self.assertEqual(cycle_policy(self.row(),'cycle_relative',False,None)[0],'BUY')
        self.assertEqual(cycle_policy(self.row(RelativeReturn20=-.2),'cycle_relative',True,99),('',''))

    def test_stale_missing_and_future_known_features_not_usable(self):
        for row in [self.row(FinAgeDays=181),self.row(RevenueAcceleration=float('nan')),
                    self.row(GrossMarginYoYAcceleration=float('inf'))]:
            for rule in NEW_RULES:
                self.assertEqual(cycle_policy(row,rule,False,None),('',''))
                self.assertEqual(cycle_policy(row,rule,True,99)[0],'SELL')

    def peer_fixture(self):
        dates=pd.bdate_range('2024-01-01',periods=45)
        data=pd.DataFrame(dict(Close=[100+i for i in range(len(dates))]),index=dates)
        rows=[dict(ticker=t,trade_date=str(day.date()),adjusted_close=base+i)
              for i,day in enumerate(dates) for t,base in [('CIEN',50),('COHR',100)]]
        return data,dict(rows=rows)

    def test_peer_returns_equal_weight_and_missing_sessions_not_filled(self):
        data,snapshot=self.peer_fixture()
        got=add_peers(data,snapshot)
        self.assertTrue(got.PeerReturn20.iloc[:20].isna().all())
        self.assertAlmostEqual(got.PeerReturn20.iloc[20],(.4+.2)/2)
        self.assertAlmostEqual(got.RelativeReturn20.iloc[20],.2-.3)
        missing=dict(rows=[r for r in snapshot['rows'] if not (r['ticker']=='CIEN' and r['trade_date']==str(data.index[10].date()))])
        self.assertTrue(add_peers(data,missing).PeerReturn20.iloc[20:31].isna().all())
        self.assertTrue(pd.notna(add_peers(data,missing).PeerReturn20.iloc[31]))
        short=add_peers(data.iloc[:30],snapshot)
        pd.testing.assert_frame_equal(short,got.iloc[:30])

    def test_bad_peer_prices_and_duplicates_rejected(self):
        data,snapshot=self.peer_fixture()
        with self.assertRaises(ValueError):
            add_peers(data,dict(rows=snapshot['rows']+[snapshot['rows'][0]]))
        snapshot['rows'][0]['adjusted_close']=float('inf')
        with self.assertRaises(ValueError):add_peers(data,snapshot)

    def test_acceptance_requires_every_section_and_never_claims_future_edge(self):
        result={s:{n:dict(beats_hold=True) for n in NEW_RULES} for s in SECTIONS}
        self.assertTrue(acceptance(result)['cycle_turn']['all_historical_checks_pass'])
        self.assertFalse(acceptance(result)['cycle_turn']['future_edge_verified'])
        result['late']['cycle_turn']['beats_hold']=False
        self.assertFalse(acceptance(result)['cycle_turn']['all_historical_checks_pass'])

    def test_execution_and_prefix_causality_with_multiple_financial_cycles(self):
        data,_=enriched(demo_bars(),financial_fixture())
        data['RelativeReturn20']=.1
        data['FinAgeDays']=60
        for i,day in enumerate(data.index):
            data.loc[day,['RevenueAcceleration','GrossMarginYoYAcceleration']]=.05 if (i//60)%2==0 else -.05
        for rule in NEW_RULES:
            whole,trades=simulate(data,'2023-01-01',rule,policy=cycle_policy)
            short,_=simulate(data.loc[:'2024-08-01'],'2023-01-01',rule,policy=cycle_policy)
            pd.testing.assert_frame_equal(short,whole.loc[short.index])
            self.assertGreater(len(trades),1)
            for i in range(1,len(whole)):
                if whole.Fill.iloc[i]:self.assertEqual(whole.Fill.iloc[i],whole.Signal.iloc[i-1])


if __name__=='__main__':unittest.main()
