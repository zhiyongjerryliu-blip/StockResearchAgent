import copy
import json
import unittest

import pandas as pd

from foreign_financials import FORMS, asml, inline, taiwan, amd_liabilities
from industry18_research import select
from quality_momentum import financial_features, run_account, weights
from strategy import HERE, Config
import test_quality_momentum as fixtures


class IndustryTests(unittest.TestCase):
    def test_native_currency_and_form_filter_preserve_ratios(self):
        sample=fixtures.QualityMomentumTests().financial_sample()
        dates=pd.bdate_range('2024-02-14','2024-02-20')
        reference=financial_features(sample,dates)
        native=copy.deepcopy(sample)
        for f in native['facts']:
            f.update(unit='TWD',form='6-K',value=f['value']*32)
        # Wrong-currency observations must never contaminate the ratios.
        native['facts']+=sample['facts']
        actual=financial_features(native,dates,currency='TWD',forms=FORMS)
        pd.testing.assert_frame_equal(reference,actual)

    def test_caps_ties_and_missing_group_cash(self):
        groups={'a':['A','B','C'],'b':['D','E'],'c':['F'],'d':['G'],'e':['H']}
        rank=pd.DataFrame({'Combined':[8,7,6,5,4,3,2,1]},index=list('ABCDEFGH'))
        self.assertEqual(list(select(rank,groups,'capped5')),list('ABDEF'))
        self.assertEqual(list(select(rank,groups,'unrestricted5')),list('ABCDE'))
        self.assertEqual(list(select(rank,groups,'one_per_group')),list('ADFGH'))
        self.assertAlmostEqual(sum(select(rank.drop('H'),groups,'one_per_group').values()),.8)
        rank['Combined']=1
        self.assertEqual(list(select(rank.iloc[::-1],groups,'capped5')),list('ABDEF'))

    def test_selection_callback_preserves_default_execution(self):
        prices,frames=fixtures.QualityMomentumTests().market_sample()
        args=(prices,frames,'2024-01-29','2024-02-06','quality_momentum',Config())
        old=run_account(*args)
        new=run_account(*args,selection_controller=lambda r:weights(r,'quality_momentum'))
        self.assertEqual(old[0],new[0])
        for a,b in zip(old[1:],new[1:]):pd.testing.assert_frame_equal(a,b)


class FilingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder=HERE/'reports/industry18/raw/foreign_filings'
        if not (cls.folder/'manifest.json').exists():raise unittest.SkipTest('Cached SEC fixtures unavailable')
        cls.manifest=json.loads((cls.folder/'manifest.json').read_text())

    def parse(self,ticker,date):
        rec=next(r for r in self.manifest if r['ticker']==ticker and r['filed_at']==date)
        fn={'TSM':taiwan,'UMC':taiwan,'ASML':asml,'GFS':inline}[ticker]
        facts=fn(rec,(self.folder/rec['file']).read_text())
        self.assertTrue(facts)
        self.assertTrue(all(f['filed_at']==date for f in facts))
        self.assertTrue(all(f['source_url']==rec['source_url'] for f in facts))
        return facts

    def value(self,facts,metric,end,start=None):
        hits=[f['value'] for f in facts if f['metric_key']==metric and f['period_end']==end and f['period_start']==start]
        self.assertEqual(len(set(hits)),1)
        return hits[0]

    def test_asml_full_month_name_and_fiscal_quarter(self):
        f=self.parse('ASML','2023-07-19')
        self.assertEqual(self.value(f,'revenue','2023-07-02','2023-04-03'),6902.3e6)
        self.assertTrue(all(x['unit']=='EUR' for x in f))

    def test_gfs_plain_html_current_prior_ytd_columns(self):
        f=self.parse('GFS','2024-08-06')
        self.assertEqual(self.value(f,'revenue','2024-06-30','2024-04-01'),1632e6)
        self.assertEqual(self.value(f,'revenue','2024-06-30','2024-01-01'),3181e6)
        self.assertEqual(self.value(f,'operatingCashFlow','2024-06-30','2024-01-01'),890e6)
        self.assertEqual(self.value(f,'liabilities','2024-06-30'),6628e6)

    def test_gfs_inline_total_not_segment(self):
        f=self.parse('GFS','2026-05-05')
        self.assertEqual(self.value(f,'revenue','2026-03-31','2026-01-01'),1634e6)
        self.assertEqual(self.value(f,'operatingCashFlow','2026-03-31','2026-01-01'),542e6)

    def test_taiwan_balance_dates_units_and_comparatives(self):
        for ticker,date,assets,revenue in [
            ('TSM','2026-02-26',7933023878000,3809054272000),
            ('UMC','2026-02-25',578996009000,237553199000)]:
            f=self.parse(ticker,date)
            self.assertEqual(self.value(f,'assets','2025-12-31'),assets)
            self.assertEqual(self.value(f,'revenue','2025-12-31','2025-01-01'),revenue)
            self.assertTrue(all(x['unit']=='TWD' for x in f))
            self.assertTrue(all(x['filed_at']==date for x in f if x['period_end']=='2024-12-31'))

    def test_amd_liabilities_same_filing_identity(self):
        base=HERE/'reports/industry18'
        s=json.loads((base/'snapshot.json').read_text())
        liabilities=amd_liabilities(s,base/'raw')
        self.assertTrue(liabilities)
        raw=json.loads((base/'raw/AMD_sec.json').read_text())['companyFacts']['facts']['us-gaap']
        for l in liabilities:
            equities=[v['val'] for v in raw['StockholdersEquity']['units']['USD']
                      if v['accn']==l['accession_number'] and v['end']==l['period_end'] and v['filed']==l['filed_at']]
            assets=[v['value'] for v in s['facts'] if v['ticker']=='AMD' and v['metric_key']=='assets'
                    and v['accession_number']==l['accession_number'] and v['period_end']==l['period_end']]
            self.assertEqual(assets[0]-equities[0],l['value'])


if __name__=='__main__':unittest.main()
