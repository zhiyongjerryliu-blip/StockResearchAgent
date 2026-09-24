import unittest

import numpy as np
import pandas as pd

from quality_momentum import QUALITY, financial_features, rank_on, rebalance, run_account, weights
from strategy import Config
from test_fundamentals import fact, financial_fixture


class QualityMomentumTests(unittest.TestCase):
    def financial_sample(self):
        snap=financial_fixture()
        revenue=[f for f in snap['facts'] if f['metric_key']=='revenue']
        snap['facts'] += [fact('netIncome',f['period_start'],f['period_end'],.1*f['value'],f['filed_at']) for f in revenue]
        for f in revenue:
            for metric,value in [('assets',1000.),('liabilities',400.)]:
                b=fact(metric,f['period_start'],f['period_end'],value,f['filed_at'])
                b.update(period_start=None,period_type='instant')
                snap['facts'].append(b)
        return snap

    def test_quality_ratios_and_publication_delay(self):
        snap=self.financial_sample();dates=pd.bdate_range('2024-02-14','2024-02-20')
        f=financial_features(snap,dates)
        self.assertEqual(f.FinPeriod.iloc[0],'2023-09-30')
        self.assertEqual(f.FinPeriod.iloc[1],'2023-12-31')
        self.assertAlmostEqual(f.NetMarginTTM.iloc[1],.1)
        self.assertAlmostEqual(f.OCFMarginTTM.iloc[1],.2)
        self.assertAlmostEqual(f.BalanceSafety.iloc[1],-.4)
        delayed=financial_features(snap,dates,1)
        self.assertNotEqual(delayed.FinPeriod.iloc[1],'2023-12-31')
        self.assertEqual(delayed.FinPeriod.iloc[2],'2023-12-31')

    def test_future_restatement_not_backfilled_and_stale_excluded(self):
        snap=self.financial_sample();dates=pd.bdate_range('2024-02-14','2024-03-01')
        before=financial_features(snap,dates)
        snap['facts'].append(fact('netIncome','2023-10-01','2023-12-31',999999,'2024-04-01'))
        pd.testing.assert_frame_equal(before,financial_features(snap,dates))
        stale=financial_features(snap,pd.DatetimeIndex(['2027-01-01']))
        self.assertTrue(stale[QUALITY].isna().all().all())

    def test_whole_portfolio_costs_and_self_financing(self):
        config=Config(fee_bps=10,slippage_bps=20)
        cash,units,trades=rebalance(100000,{},dict(A=100,B=50),dict(A=.5,B=.5),config)
        self.assertAlmostEqual(cash,0.,places=6)
        nav=cash+units['A']*100+units['B']*50
        self.assertAlmostEqual(nav,100000-sum(t['fee']+t['slippage_cost'] for t in trades))
        opens=dict(A=120,B=40,C=75);old_nav=cash+sum(units[t]*opens[t] for t in units)
        cash,units,trades=rebalance(cash,units,opens,dict(B=.25,C=.5),config)
        nav=cash+sum(units[t]*opens[t] for t in units)
        self.assertAlmostEqual(cash/nav,.25)
        self.assertAlmostEqual(nav,old_nav-sum(t['fee']+t['slippage_cost'] for t in trades))
        self.assertEqual(trades[0]['fill'],'SELL')

    def market_sample(self):
        dates=pd.bdate_range('2024-01-29',periods=7)
        prices={t:pd.DataFrame({'Open':100.,'Close':100.},index=dates) for t in ['A','B','C','D','SPY','LITE']}
        frames={t:pd.DataFrame(dict(NetMarginTTM=float(i),OCFMarginTTM=float(i),BalanceSafety=float(i),
                                    Momentum=float(i),Eligible=True,PriceReady=True),index=dates) for i,t in enumerate(['A','B','C','D'])}
        return prices,frames

    def test_rank_missing_and_equal_weights(self):
        _,frames=self.market_sample();day=next(iter(frames.values())).index[0]
        frames['A'].loc[day,'Eligible']=False
        ranked=rank_on(frames,day)
        self.assertNotIn('A',ranked.index)
        self.assertEqual(list(weights(ranked,'quality_momentum')),['D','C','B'])
        self.assertAlmostEqual(sum(weights(ranked,'qm_defensive',True).values()),.5)
        self.assertEqual(weights(ranked.iloc[:2],'quality_momentum'),{})

    def test_next_open_month_end_and_future_price_independence(self):
        prices,frames=self.market_sample();start='2024-01-29';end='2024-02-06'
        _,c,ledger,sel,_=run_account(prices,frames,start,end,'quality_momentum',Config())
        self.assertEqual(c.Exposure.iloc[0],0.)
        self.assertEqual(ledger.date.min(),'2024-01-30')
        self.assertEqual(sel.signal_date.tolist(),['2024-01-29','2024-01-31'])
        for p in prices.values():p.loc['2024-02-02':,['Open','Close']]=150.
        _,changed,_,_,_=run_account(prices,frames,start,end,'quality_momentum',Config())
        pd.testing.assert_frame_equal(c.loc[:'2024-02-01'],changed.loc[:'2024-02-01'])

    def test_two_holdings_next_open_and_known_portfolio_return(self):
        prices,frames=self.market_sample()
        # Two highest-ranked stocks start equally weighted; only D doubles.
        prices['D'].loc['2024-01-30','Close']=200.
        stats,curve,trades,_,hold=run_account(prices,frames,'2024-01-29','2024-01-30',
            'quality_momentum',Config(fee_bps=0,slippage_bps=0),top_n=2)
        self.assertEqual(set(trades.ticker),{'C','D'})
        self.assertEqual(set(trades.date),{'2024-01-30'})
        self.assertTrue((trades.target==.5).all())
        self.assertAlmostEqual(stats['return_pct'],50.)
        self.assertEqual(curve.Holdings.iloc[-1],2)
        ranked=rank_on(frames,prices['SPY'].index[0]);ranked['Combined']=1.
        self.assertEqual(weights(ranked,'quality_momentum',top_n=2),{'A':.5,'B':.5})

    def test_single_holding_no_churn_until_next_open_rank_change(self):
        prices,frames=self.market_sample()
        _,_,unchanged,_,_=run_account(prices,frames,'2024-01-29','2024-02-06',
            'quality_momentum',Config(),top_n=1)
        self.assertEqual(unchanged[['date','ticker','fill']].to_dict('records'),
            [{'date':'2024-01-30','ticker':'D','fill':'BUY'}])
        for col in QUALITY+['Momentum']:frames['A'].loc['2024-01-31':,col]=10.
        _,curve,trades,_,_=run_account(prices,frames,'2024-01-29','2024-02-06',
            'quality_momentum',Config(),top_n=1)
        self.assertEqual(trades[['date','ticker','fill']].to_dict('records'),[
            {'date':'2024-01-30','ticker':'D','fill':'BUY'},
            {'date':'2024-02-01','ticker':'D','fill':'SELL'},
            {'date':'2024-02-01','ticker':'A','fill':'BUY'}])
        self.assertEqual(curve.Holdings.max(),1)


if __name__=='__main__':unittest.main()
