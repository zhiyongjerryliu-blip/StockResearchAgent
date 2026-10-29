"""Four preregistered factor portfolios using frozen inputs; no live DB writes."""
from collections import Counter, defaultdict
from hashlib import sha256
from html import escape
import json
from pathlib import Path
import numpy as np
import pandas as pd

from fundamentals import prepare_facts, select_vintages, quarterly_points
from quality_momentum import build_panel, rank_on, run_account
from strategy import HERE, Config

OUT = HERE / 'reports/three_factor'
BASE = HERE / 'reports/industry18'
LABELS = {'QM': '质量＋动量 50/50', 'QV': '质量＋价值 50/50',
          'QVM_equal': '质量＋动量＋价值 等权', 'QVM_442': '质量＋动量＋价值 40/40/20',
          'equal_monthly': '合格池月度等权', 'basket_hold': '期初可交易股票等权持有', 'SPY': 'SPY持有'}
PERIODS = {'full':'完整区间', 'late':'2025年起', 'one_year':'最近一年', 'all18':'18股均具备历史后',
           'cost_stress':'全期成本压力', 'one_year_cost':'一年成本压力', 'delay_stress':'财务额外延迟一天'}


def split_events(chart, ticker):
    result = chart['chart']['result'][0]
    events = []
    for item in result.get('events', {}).get('splits', {}).values():
        day = pd.Timestamp(item['date'], unit='s', tz='UTC').tz_convert('America/New_York').tz_localize(None).normalize()
        ratio = float(item['numerator']) / float(item['denominator'])
        genuine = not (ticker == 'WDC' and day == pd.Timestamp('2025-02-24'))
        events.append((day, ratio, genuine))
    return sorted(events)


def split_product(events, after, through=None, genuine_only=False):
    return float(np.prod([ratio for day, ratio, genuine in events
                          if day > after and (through is None or day <= through)
                          and (genuine or not genuine_only)]))


def local_market_cap(price, ordinary_shares, adr_ratio, currency, fx=1.):
    usd = price * ordinary_shares / adr_ratio
    return usd * fx if currency == 'TWD' else usd / fx if currency == 'EUR' else usd


def fx_series(chart):
    result = chart['chart']['result'][0]
    # FX bars are London-day bars. NY conversion would mislabel midnight-London
    # as the preceding US day and could admit a not-yet-completed daily bar.
    zone = result['meta'].get('exchangeTimezoneName','Europe/London')
    days = pd.to_datetime(result['timestamp'], unit='s', utc=True).tz_convert(zone).tz_localize(None).normalize()
    values = result['indicators']['quote'][0]['close']
    return pd.Series(values, index=days, dtype=float).dropna().sort_index()


def disclosure_day(filed, accepted=None):
    known = pd.Timestamp(filed).normalize()
    if accepted:
        instant = pd.Timestamp(accepted)
        day = (instant.normalize() + pd.Timedelta(days=1) if instant.tzinfo is None else
               instant.tz_convert('America/New_York').tz_localize(None).normalize())
        known = max(known, day)
    return known


def share_records(raw, filings, events):
    accepted = {f['accession_number']: f.get('accepted_at') for f in filings}
    records = []
    for namespace, tag, priority in [('dei','EntityCommonStockSharesOutstanding',0),
                                     ('us-gaap','CommonStockSharesOutstanding',1),
                                     ('ifrs-full','NumberOfSharesOutstanding',1)]:
        data = raw['companyFacts']['facts'].get(namespace, {}).get(tag, {}).get('units', {}).get('shares', [])
        for fact in data:
            if fact.get('start') or fact.get('val',0) <= 0: continue
            end = pd.Timestamp(fact['end']); known = disclosure_day(fact['filed'], accepted.get(fact['accn']))
            if end > known: continue
            # Comparative GAAP/IFRS balance-sheet shares can be restated for a later split.
            # DEI cover-page shares describe the actual count on the observation date.
            divisor = split_product(events, end, pd.Timestamp(fact['filed']), True) if namespace != 'dei' else 1.
            records.append(dict(end=end, known=known, value=float(fact['val'])/divisor,
                                priority=priority, source=f"{namespace}:{tag}:{fact['accn']}:{fact['end']}",
                                filed=fact['filed']))
    return records


def visible_share(records, day, events, delay_dates=None, delay=0):
    visible = []
    for record in records:
        effective = record['known']
        if delay:
            pos = delay_dates.searchsorted(effective, side='right') + delay
            if pos >= len(delay_dates) or delay_dates[pos] > day: continue
        elif effective >= day: continue
        visible.append(record)
    if not visible: return None
    end = max(x['end'] for x in visible)
    if (day-end).days > 550: return None
    latest = [x for x in visible if x['end'] == end]
    priority = min(x['priority'] for x in latest)
    latest = [x for x in latest if x['priority'] == priority]
    known = max(x['known'] for x in latest)
    latest = [x for x in latest if x['known'] == known]
    if not all(np.isclose(latest[0]['value'], x['value'], rtol=1e-9) for x in latest): return None
    chosen = latest[0]
    return {**chosen, 'shares':chosen['value'] * split_product(events, end, day, True)}


def ttm_flows(sub, dates, metadata, delay=0):
    flows, _ = prepare_facts(sub, metrics=('revenue','netIncome','operatingCashFlow'), **metadata)
    incoming = defaultdict(list)
    for f in flows:
        pos = dates.searchsorted(f['_known'], side='right') + delay
        if pos < len(dates): incoming[pos].append(f)
    visible = []; quarters = {}; rows = []
    for i, day in enumerate(dates):
        if incoming[i]:
            visible.extend(incoming[i]); quarters = quarterly_points(select_vintages(visible))
        ends = sorted(e for m,e in quarters if m == 'revenue')[-4:]
        totals = defaultdict(float); dependencies = []; valid = len(ends)==4 and 0 <= (day-ends[-1]).days <= 180
        if valid:
            for j, end in enumerate(ends):
                rev = quarters[('revenue',end)]
                if j and abs((rev['start']-ends[j-1]).days-1) > 3: valid=False; break
                for metric in ('revenue','netIncome','operatingCashFlow'):
                    point = quarters.get((metric,end))
                    if not point or point['value'] is None or point['start']!=rev['start']: valid=False; break
                    totals[metric] += point['value']; dependencies.append(point)
                if not valid: break
        rows.append(dict(Date=day, RevenueTTM=totals['revenue'] if valid else np.nan,
                         IncomeTTM=totals['netIncome'] if valid else np.nan,
                         OCFTTM=totals['operatingCashFlow'] if valid else np.nan,
                         ValueFinKnownDay=str(max(x['known'] for x in dependencies).date()) if valid else None,
                         ValueFinSources=json.dumps(sorted({s for x in dependencies for s in x['sources']})) if valid else '[]'))
    return pd.DataFrame(rows).set_index('Date')


def build_value_panel(snapshot, protocol, delay=0, value_inputs=None):
    prices, frames, coverage = build_panel(snapshot, delay)
    dates = prices['SPY'].index
    load_chart = lambda symbol: value_inputs['charts'][symbol] if value_inputs is not None else json.loads((OUT/'inputs'/f'{symbol}_chart.json').read_text())
    fx = {currency:fx_series(load_chart(symbol))
          for currency,symbol in [('TWD','TWD=X'),('EUR','EURUSD=X')]}
    gaps = []; actions = {}; share_audit = []
    for ticker, frame in frames.items():
        chart = load_chart(ticker)
        events = split_events(chart, ticker); actions[ticker] = [{'date':str(d.date()),'ratio':r,'genuine_share_split':g} for d,r,g in events]
        sub = dict(facts=[x for x in snapshot['facts'] if x['ticker']==ticker],
                   filings=[x for x in snapshot['filings'] if x['ticker']==ticker])
        metadata = snapshot.get('financial_metadata',{}).get(ticker,{})
        currency = metadata.get('currency','USD')
        frame = frame.join(ttm_flows(sub, dates, metadata, delay))
        # Independent TTM reconstruction must agree with the inherited quality ratios.
        valid = frame.Eligible
        assert np.allclose(frame.loc[valid,'IncomeTTM']/frame.loc[valid,'RevenueTTM'], frame.loc[valid,'NetMarginTTM'])
        assert np.allclose(frame.loc[valid,'OCFTTM']/frame.loc[valid,'RevenueTTM'], frame.loc[valid,'OCFMarginTTM'])
        raw = value_inputs['sec'][ticker] if value_inputs is not None else json.loads((BASE/'raw'/f'{ticker}_sec.json').read_text())
        records = share_records(raw, sub['filings'], events)
        raw_close = pd.Series({pd.Timestamp(x['trade_date']):x['close'] for x in snapshot['prices'] if x['ticker']==ticker})
        rows=[]
        for day in dates:
            shares = visible_share(records, day, events, dates, delay)
            fx_value=1.; fx_day=None
            if currency in fx:
                known_fx = fx[currency].loc[fx[currency].index < day]
                fx_value=float(known_fx.iloc[-1]) if len(known_fx) and (day-known_fx.index[-1]).days<=7 else np.nan
                fx_day=str(known_fx.index[-1].date()) if len(known_fx) else None
            nominal = raw_close.get(day,np.nan) * split_product(events,day)
            count=shares['shares'] if shares else np.nan
            cap=local_market_cap(nominal,count,protocol['adr_ordinary_shares_per_unit'].get(ticker,1),currency,fx_value)
            rows.append(dict(Date=day,NominalClose=nominal,OrdinaryShares=count,MarketCapReportingCurrency=cap,
                             ReportingCurrency=currency,FX=fx_value,FXDate=fx_day,
                             ShareEnd=str(shares['end'].date()) if shares else None,
                             ShareKnownDay=str(shares['known'].date()) if shares else None,
                             ShareSource=shares['source'] if shares else None))
        frame=frame.join(pd.DataFrame(rows).set_index('Date'))
        frame['EarningsYield']=frame.IncomeTTM/frame.MarketCapReportingCurrency
        frame['OCFYield']=frame.OCFTTM/frame.MarketCapReportingCurrency
        frame['QMOriginalEligible']=frame.Eligible
        frame['Eligible']=frame.Eligible & frame[['EarningsYield','OCFYield']].notna().all(axis=1) & (frame.MarketCapReportingCurrency>0)
        excluded=frame.index[(frame.index>=protocol['start']) & frame.QMOriginalEligible & ~frame.Eligible]
        if len(excluded):gaps.append(dict(ticker=ticker,days=len(excluded),dates=[str(d.date()) for d in excluded]))
        valid=frame.Eligible
        assert all(pd.Timestamp(k)<d for d,k in frame.loc[valid,'ShareKnownDay'].items())
        assert all(pd.Timestamp(k)<d for d,k in frame.loc[valid,'ValueFinKnownDay'].items())
        assert all(pd.Timestamp(k)<d for d,k in frame.loc[valid,'FXDate'].dropna().items())
        frames[ticker]=frame
        coverage.loc[coverage.ticker==ticker,'common_eligible_days']=int(valid.sum())
        coverage.loc[coverage.ticker==ticker,'value_exclusions_in_window']=len(excluded)
    return prices,frames,coverage,gaps,actions


def score(rank, mapping, weights):
    if rank.empty:return rank.assign(ValueRank=[], Score=[])
    rank=rank.copy();rank['Group']=[mapping[t] for t in rank.index]
    rank['ValueRank']=rank.groupby('Group')[['EarningsYield','OCFYield']].rank(pct=True).mean(axis=1)
    rank['Score']=weights[0]*rank.QualityRank + weights[1]*rank.MomentumRank + weights[2]*rank.ValueRank
    return rank


def select(rank, mapping, weights):
    ranked=score(rank,mapping,weights)
    if ranked.empty:return {}
    ordered=ranked.assign(TickerKey=ranked.index).sort_values(['Score','TickerKey'],ascending=[False,True])
    counts=Counter();picked=[]
    for ticker in ordered.index:
        if counts[mapping[ticker]]>=2:continue
        picked.append(ticker);counts[mapping[ticker]]+=1
        if len(picked)==5:break
    return {t:.2 for t in picked}


def table(stats):
    return pd.DataFrame([{'方案':LABELS[k],'累计净收益%':v['return_pct'],'年化净收益%':v['annual_return_pct'],
                          '最大回撤%':v['max_drawdown_pct'],'年化双边换手倍数':v['annual_gross_turnover'],
                          '期末美元':v['terminal_equity']} for k,v in stats.items()])


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    protocol=json.loads((HERE/'three_factor_protocol.json').read_text())
    original=json.loads((HERE/'industry18_protocol.json').read_text())
    snapshot=json.loads((BASE/'enriched_snapshot.json').read_text())
    prices,frames,coverage,gaps,actions=build_value_panel(snapshot,protocol)
    print('Value exclusions:',json.dumps(gaps,ensure_ascii=False),flush=True)
    _,delayed,_,_,_=build_value_panel(snapshot,protocol,1)
    mapping={t:g for g,ts in original['groups'].items() for t in ts}
    passive={t:f.assign(PriceReady=prices[t].Close.reindex(f.index).notna()) for t,f in frames.items()}
    coverage.to_csv(OUT/'coverage.csv',index=False)
    for t,f in frames.items():f.to_csv(OUT/f'{t}_features.csv')
    results={};curves={};ranks=[];overlap=[];yearly=[]
    for period,start in protocol['windows'].items():
        folder=OUT/period;folder.mkdir(exist_ok=True)
        config=Config(fee_bps=10,slippage_bps=20) if period in ('cost_stress','one_year_cost') else Config()
        panel=delayed if period=='delay_stress' else frames
        stats={};curves[period]={};signals={}
        for variant in list(protocol['variants'])+['equal_monthly','basket_hold','SPY']:
            weights=protocol['variants'].get(variant)
            selector=(lambda rank,w=weights:select(rank,mapping,w)) if weights else None
            rule='quality_momentum' if weights else variant
            s,c,trades,targets,holdings=run_account(prices,passive if variant=='basket_hold' else panel,
               start,protocol['end'],rule,config,top_n=5,selection_controller=selector)
            s['annual_gross_turnover']=s['gross_turnover'] / ((c.index[-1]-c.index[0]).days/365.25)
            if weights:
                assert (pd.to_datetime(trades.date)>pd.to_datetime(trades.signal_date)).all()
                signals[variant]={row.signal_date:set(json.loads(row.target)) for row in targets.itertuples()}
                for row in targets.itertuples():
                    target=json.loads(row.target);counts=Counter(mapping[t] for t in target)
                    assert len(target)<=5 and max(counts.values(),default=0)<=2
                    assert all(v==.2 and bool(panel[t].loc[row.signal_date,'Eligible']) for t,v in target.items())
                    if period=='full':
                        r=score(rank_on(panel,pd.Timestamp(row.signal_date)),mapping,weights)
                        r['Variant']=variant;r['SignalDate']=row.signal_date;r['Selected']=[t in target for t in r.index]
                        ranks.append(r.reset_index())
            c.to_csv(folder/f'{variant}_daily.csv');trades.to_csv(folder/f'{variant}_trades.csv',index=False)
            targets.to_csv(folder/f'{variant}_targets.csv',index=False);holdings.to_csv(folder/f'{variant}_holdings.csv',index=False)
            stats[variant]=s;curves[period][variant]=c
            if period=='full':
                last=100000.
                for year,g in c.groupby(c.index.year):
                    terminal=float(g.SettledEquity.iloc[-1]);yearly.append(dict(year=int(year),variant=variant,return_pct=(terminal/last-1)*100))
                    last=terminal
        for variant in protocol['variants']:
            if variant=='QM':continue
            overlaps=[len(names & signals['QM'][day])/5 for day,names in signals[variant].items()]
            overlap.append(dict(period=period,variant=variant,mean_holdings_overlap_pct=float(np.mean(overlaps)*100)))
        results[period]=dict(start=start,end=protocol['end'],stats=stats)
        print(period+'\n'+table(stats).round(3).to_string(index=False),flush=True)
    # QM is a control: with no new coverage exclusion its account must reproduce the frozen original.
    old=json.loads((BASE/'summary.json').read_text())
    control={}
    for period in protocol['windows']:
        before=old['results'][period]['stats']['capped5'];after=results[period]['stats']['QM']
        control[period]={key:after[key]-before[key] for key in ('return_pct','max_drawdown_pct','terminal_equity')}
        if not gaps:assert all(abs(x)<1e-7 for x in control[period].values()),(period,control[period])
    pd.concat(ranks,ignore_index=True).to_csv(OUT/'decision_rankings.csv',index=False)
    pd.DataFrame(yearly).to_csv(OUT/'yearly_returns.csv',index=False)
    pd.DataFrame(overlap).to_csv(OUT/'holdings_overlap.csv',index=False)
    # Descriptive cross-sectional dependence, not a significance test.
    signalranks=pd.concat([r for r in ranks if r.Variant.iloc[0]=='QM'],ignore_index=True)
    factor_corr=signalranks[['QualityRank','MomentumRank','ValueRank']].astype(float).corr().round(4).to_dict()
    files=[HERE/'three_factor_protocol.json',BASE/'enriched_snapshot.json',OUT/'inputs/manifest.json']
    files+=list((BASE/'raw').glob('*_sec.json'))+list((OUT/'inputs').glob('*_chart.json'))
    code=[Path(__file__),HERE/'quality_momentum.py',HERE/'fundamentals.py',HERE/'stockresearch_adapter.py',HERE/'strategy.py']
    result=dict(protocol=protocol,coverage=coverage.to_dict('records'),value_exclusions=gaps,corporate_actions=actions,
                results=results,control_differences=control,yearly_returns=yearly,overlap=overlap,factor_correlation=factor_corr,
                input_hashes={str(p.relative_to(HERE)):sha256(p.read_bytes()).hexdigest() for p in files},
                code_hashes={p.name:sha256(p.read_bytes()).hexdigest() for p in code})
    (OUT/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False))
    render(result,curves)


def render(result,curves):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    tables=''.join(f'<h2>{PERIODS[k]}：{r["start"]}—{r["end"]}</h2>'+table(r['stats']).to_html(index=False,border=0,float_format=lambda x:f'{x:,.2f}') for k,r in result['results'].items())
    graphs=[]
    for period in ('full','one_year'):
        fig=make_subplots(rows=2,cols=1,shared_xaxes=True,subplot_titles=['账户净值（初始1，对数轴）','回撤%'])
        for k,c in curves[period].items():
            e=c.SettledEquity
            fig.add_trace(go.Scatter(x=c.index,y=e/100000,name=LABELS[k],legendgroup=k),row=1,col=1)
            fig.add_trace(go.Scatter(x=c.index,y=(e/e.cummax().clip(lower=100000)-1)*100,name=LABELS[k],legendgroup=k,showlegend=False),row=2,col=1)
        fig.update_yaxes(type='log',row=1,col=1)
        fig.update_layout(template='plotly_white',height=780,hovermode='x unified',legend=dict(orientation='h',y=1.2),margin=dict(t=150))
        graphs.append(f'<h2>{PERIODS[period]}：净值与回撤</h2>'+fig.to_html(full_html=False,include_plotlyjs=period=='full'))
    yearly=pd.DataFrame(result['yearly_returns']).pivot(index='year',columns='variant',values='return_pct').rename(columns=LABELS)
    yearly.index.name='年份';yearly.columns.name='方案'
    warnings=[
        '18只股票为事后选定的AI产业链名单，存在选股与幸存者偏差；高回测收益不能作为未来收益预期。',
        '近期区间嵌套在全期内，且采用相同历史数据，不属于未接触过的样本外验证。每个区间从现金独立启动。',
        '价值分只在各子行业3—4只股票中排名，属于相对便宜，不代表全市场低估；质量与价值有部分指标关联。',
        '市值采用当时已披露股数近似；境外公司的年度股数较稀疏，并非精确每日流通市值。',
        '经营现金流收益率没有扣资本开支；GAAP/IFRS利润未剔除一次性项目，分拆前后的业务口径也可能变化。',
        '所有主动版本共用动量历史门槛，SNDK直到2026-02-25才合格；纯质量＋价值也保留这个门槛以便公平比较。',
        'WDC分拆收益沿用调整价格近似，未模拟实际派发SNDK股份；因此组合收益并非完整公司行动账本。',
        '研究使用下一交易日开盘成交，现有自动化使用下一交易日收盘成交；尚未验证后者的三因子表现。',
        '每组40%为调仓目标上限，月内股价变化可使实际权重超过40%；未加入择时减仓、税费和现金利息。']
    notes=''.join(f'<li>{escape(note)}</li>' for note in warnings)
    full=result['results']['full']['stats'];recent=result['results']['one_year']['stats']
    takeaway=(f'三因子等权全期净收益{full["QVM_equal"]["return_pct"]:,.2f}%，最大回撤{abs(full["QVM_equal"]["max_drawdown_pct"]):.2f}%；'
              f'原质量＋动量分别为{full["QM"]["return_pct"]:,.2f}%和{abs(full["QM"]["max_drawdown_pct"]):.2f}%。'
              f'最近一年质量＋价值表现更优，净收益{recent["QV"]["return_pct"]:.2f}%，最大回撤{abs(recent["QV"]["max_drawdown_pct"]):.2f}%。'
              '40/40/20没有稳定优势。三因子等权适合作为后续模拟验证候选，尚不足以直接替换现有规则。')
    spec=escape(json.dumps(result['protocol'],ensure_ascii=False,indent=2))
    (OUT/'report.html').write_text(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>18股三因子比较</title>
<style>body{{max-width:1400px;margin:28px auto;padding:0 24px;font:16px/1.65 system-ui;color:#172b4d}}table{{border-collapse:collapse;width:100%;font-size:14px}}td,th{{padding:9px;border-bottom:1px solid #d9e2ef;text-align:right}}td:first-child,th:first-child{{text-align:left}}pre{{white-space:pre-wrap;background:#f3f6fa;padding:20px}}.note{{background:#edf4ff;padding:18px;border-radius:10px}}h2{{margin-top:40px}}</style>
<h1>质量、动量、价值：18只美股同口径比较</h1><p>冻结行情截止2026-09-18；事前固定四组权重，未按结果优化。每月选5只、各20%，每组最多2只；下一交易日开盘成交，含交易成本与期末清算。</p>
<div class="note"><b>阅读方式：</b>同时比较完整区间、最近一年、全部股票有历史后的短区间与成本压力。近期和短区间包含在全期内，并非独立样本。三因子权重顺序均为质量／动量／价值。所有方案采用相同合格池。</div>
<p><strong>{takeaway}</strong></p><p>收益均为历史回测净收益，不是未来收益预测。本次仅比较现有美股池，尚未回测A股。</p>
<p>Q：净利率、经营现金流率、负债安全分的全池排名均值。M：跳过最近21个交易日的12个月价格动量。V：盈利收益率与经营现金流收益率的子行业内排名均值。经营现金流未扣资本开支。</p>
<p><a href="summary.json">完整结果</a> · <a href="decision_rankings.csv">逐月评分与财报、股数、汇率来源</a> · <a href="yearly_returns.csv">分年表现</a> · <a href="holdings_overlap.csv">持仓重合度</a> · <a href="coverage.csv">数据覆盖</a></p>
{tables}{''.join(graphs)}<h2>分年净收益%（2023、2026为部分年度）</h2>{yearly.to_html(border=0,float_format=lambda x:f'{x:,.2f}')}<h2>数据覆盖</h2>{pd.DataFrame(result['coverage']).to_html(index=False,border=0)}
<h2>限制与口径</h2><p>质量＋动量控制账户已与原18股回测逐项核对。结果为本地研究计算；新价值模块额外核对了股数披露时间、拆股、ADR和外币转换。官方分拆说明：<a href="https://www.sec.gov/Archives/edgar/data/106040/000119312525033383/d847507d8k.htm">WDC</a>；官方拆股说明：<a href="https://ir.kla.com/sec-filings/all-sec-filings/content/0001193125-26-212093/d116682dex991.htm">KLA</a>。</p><ul>{notes}</ul><details><summary>固定研究协议</summary><pre>{spec}</pre></details></html>''',encoding='utf-8')


if __name__=='__main__':main()
