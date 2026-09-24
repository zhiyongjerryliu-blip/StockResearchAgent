"""Read-only financial facts adapter, reconstructed at each historical close.

No present-day research scores or earnings estimates are carried into the past.
Filed date (and acceptance date if later) gates every original or amended value.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
import json
import math
from pathlib import Path
import sqlite3
from zoneinfo import ZoneInfo

import pandas as pd

METRICS = ('revenue', 'grossProfit', 'operatingIncome', 'operatingCashFlow', 'capitalExpenditure')
VERSION = 'financial-pit-v1'


def read_snapshot(database: Path, ticker: str):
    """One read transaction gives a consistent view of the live WAL database."""
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        placeholders = ','.join('?' for _ in METRICS)
        facts = [dict(r) for r in db.execute(f'''
            SELECT source_key,metric_key,tag_priority,taxonomy,tag,unit,period_start,period_end,
                   period_type,form,filed_at,accession_number,value,source_url,ingested_at
            FROM financial_facts WHERE ticker=? AND metric_key IN ({placeholders})
            ORDER BY filed_at,source_key''', (ticker, *METRICS))]
        filings = [dict(r) for r in db.execute('''
            SELECT accession_number,filed_at,accepted_at,form,filing_url
            FROM sec_filings WHERE ticker=? ORDER BY filed_at,accession_number''', (ticker,))]
        estimates = dict(db.execute('''SELECT COUNT(*) AS count,MIN(as_of) AS first_as_of,
             MAX(as_of) AS last_as_of FROM earnings_estimates WHERE ticker=?''', (ticker,)).fetchone())
    return dict(version=VERSION, ticker=ticker, captured_at=datetime.now(ZoneInfo('UTC')).isoformat(),
                database=str(database.resolve()), facts=facts, filings=filings,
                excluded_earnings_estimate_coverage=estimates)


def prepare_facts(snapshot, metrics=METRICS, currency='USD', forms=('10-K','10-Q','10-K/A','10-Q/A')):
    accepted = {f['accession_number']: f.get('accepted_at') for f in snapshot['filings']}
    clean, rejected = [], []
    for fact in snapshot['facts']:
        try:
            if fact['metric_key'] not in metrics or fact['unit'] != currency:
                raise ValueError('不支持的指标或单位')
            if fact['form'] not in forms:
                raise ValueError('本版本仅支持10-K/10-Q及修订')
            start, end, filed = (pd.Timestamp(fact[k]).normalize() for k in ('period_start','period_end','filed_at'))
            if any(pd.isna(x) for x in (start,end,filed)) or end < start or end > filed:
                raise ValueError('期间或披露日期无效')
            duration = (end-start).days + 1
            if not 70 <= duration <= 380 or not math.isfinite(float(fact['value'])):
                raise ValueError('期间长度或数值无效')
            known = filed
            stamp = accepted.get(fact['accession_number'])
            if stamp:
                instant = pd.Timestamp(stamp)
                if instant.tzinfo is None:
                    # Ambiguous acceptance clock: require one extra calendar day.
                    acceptance_day = instant.normalize() + pd.Timedelta(days=1)
                else:
                    acceptance_day = instant.tz_convert('America/New_York').tz_localize(None).normalize()
                known = max(known, acceptance_day)
            clean.append({**fact, '_start':start, '_end':end, '_known':known})
        except (ValueError, TypeError, KeyError) as error:
            rejected.append(dict(source_key=fact.get('source_key'), reason=str(error)))
    return clean, rejected


def select_vintages(facts):
    """Select only from currently visible records; conflicts stay unavailable."""
    grouped = defaultdict(list)
    for fact in facts:
        grouped[(fact['metric_key'],fact['_start'],fact['_end'])].append(fact)
    result = {}
    for key, candidates in grouped.items():
        latest = max(f['_known'] for f in candidates)
        candidates = [f for f in candidates if f['_known'] == latest]
        priority = min(f['tag_priority'] for f in candidates)
        candidates = [f for f in candidates if f['tag_priority'] == priority]
        # Do not silently choose between inconsistent equal-priority tags.
        values = [float(f['value']) for f in candidates]
        conflict = not all(math.isclose(values[0], x, rel_tol=1e-9, abs_tol=.01) for x in values)
        result[key] = dict(value=None if conflict else values[0], start=key[1], end=key[2],
                           known=latest, sources=sorted(f['source_key'] for f in candidates),
                           derived=False, conflict=conflict)
    return result


def quarterly_points(selected):
    """Direct single-quarter facts take precedence. Derive Q2/Q3/Q4 by
    subtracting same-fiscal-year cumulative periods, never YTD / 3 or / 4.
    """
    quarters = {}
    for (metric,start,end), point in selected.items():
        if 70 <= (end-start).days+1 <= 110:
            quarters[(metric,end)] = point
    for (metric,start,end), point in selected.items():
        if (metric,end) in quarters or (end-start).days+1 <= 110:
            continue
        previous = [p for (m,s,e),p in selected.items()
                    if m==metric and s==start and 70 <= (end-e).days <= 110]
        if not previous:
            # Latest annual/YTD without a comparable earlier cumulative value
            # must not accidentally fall back to an older quarter as "latest".
            quarters[(metric,end)] = {**point,'value':None,'derived':True,'missing_previous':True}
            continue
        prev = max(previous,key=lambda p:p['end'])
        value = point['value']-prev['value'] if point['value'] is not None and prev['value'] is not None else None
        quarters[(metric,end)] = dict(value=value,start=prev['end']+pd.Timedelta(days=1),end=end,
                                      known=max(point['known'],prev['known']),
                                      sources=sorted(set(point['sources']+prev['sources'])),
                                      derived=True, conflict=point['conflict'] or prev['conflict'])
    return quarters


def financial_state(quarters, day):
    dependencies = {}
    def use(metric, end, same_start=None):
        point = quarters.get((metric,end))
        if point:
            dependencies[(metric,end)] = point
        if not point or point['value'] is None or (same_start is not None and point['start'] != same_start):
            return None
        return point
    revenue_ends = sorted(e for m,e in quarters if m=='revenue')
    out = dict(FinPeriod=None, FinKnownDay=None, FinAgeDays=None, RevenueYoY=None,
               RevenueAcceleration=None, GrossMargin=None, GrossMarginYoY=None,
               GrossMarginYoYAcceleration=None,
               OperatingMargin=None, FCFTTM=None, FinState='UNKNOWN',
               FinReason='缺少可用财务数据', FinSources='[]', FinDerived=False)
    if not revenue_ends:
        return out
    end = revenue_ends[-1]
    rev = use('revenue',end)
    out['FinPeriod'] = str(end.date())
    out['FinAgeDays'] = (day-end).days
    def last_year(e):
        options = [x for x in revenue_ends if 350 <= (e-x).days <= 380]
        return min(options, key=lambda x:abs((e-x).days-365)) if options else None
    def growth(e):
        now = use('revenue',e)
        old_end = last_year(e)
        old = use('revenue',old_end) if old_end is not None else None
        if now and old and old['value'] > 0 and abs((now['end']-now['start']).days-(old['end']-old['start']).days)<=14:
            return now['value']/old['value']-1
        return None
    out['RevenueYoY'] = growth(end)
    prior_options = [e for e in revenue_ends if 70 <= (end-e).days <= 110]
    prior_end = max(prior_options) if prior_options else None
    prev_growth = growth(prior_end) if prior_end is not None else None
    if out['RevenueYoY'] is not None and prev_growth is not None:
        out['RevenueAcceleration'] = out['RevenueYoY']-prev_growth
    if rev and rev['value'] > 0:
        gross = use('grossProfit',end,rev['start'])
        operating = use('operatingIncome',end,rev['start'])
        out['GrossMargin'] = gross['value']/rev['value'] if gross else None
        out['OperatingMargin'] = operating['value']/rev['value'] if operating else None
        year_end = last_year(end)
        yr = use('revenue',year_end) if year_end is not None else None
        yg = use('grossProfit',year_end,yr['start']) if yr else None
        if out['GrossMargin'] is not None and yg and yr['value']>0:
            out['GrossMarginYoY'] = out['GrossMargin']-yg['value']/yr['value']
    if prior_end is not None and out['GrossMarginYoY'] is not None:
        prev_rev=use('revenue',prior_end)
        prev_gross=use('grossProfit',prior_end,prev_rev['start']) if prev_rev else None
        prev_year=last_year(prior_end)
        old_rev=use('revenue',prev_year) if prev_year is not None else None
        old_gross=use('grossProfit',prev_year,old_rev['start']) if old_rev else None
        if prev_rev and prev_gross and old_rev and old_gross and prev_rev['value']>0 and old_rev['value']>0:
            prev_margin_yoy=prev_gross['value']/prev_rev['value']-old_gross['value']/old_rev['value']
            out['GrossMarginYoYAcceleration']=out['GrossMarginYoY']-prev_margin_yoy
    # Four contiguous fiscal quarters of OCF minus positive capital expenditure.
    ends = revenue_ends[-4:]
    if len(ends)==4:
        parts, continuous = [], True
        for i,e in enumerate(ends):
            r = use('revenue',e)
            if not r or (i and abs((r['start']-ends[i-1]).days-1)>3):
                continuous=False
                break
            ocf, capex = use('operatingCashFlow',e,r['start']), use('capitalExpenditure',e,r['start'])
            if not ocf or not capex or capex['value']<0:
                continuous=False
                break
            parts.append(ocf['value']-capex['value'])
        if continuous:
            out['FCFTTM']=sum(parts)
    sources = sorted({s for p in dependencies.values() for s in p['sources']})
    out['FinSources'] = json.dumps(sources,ensure_ascii=False)
    out['FinDerived'] = any(p['derived'] for p in dependencies.values())
    if dependencies:
        out['FinKnownDay'] = str(max(p['known'] for p in dependencies.values()).date())
    if out['FinAgeDays'] > 180:
        out.update(FinState='STALE',FinReason='最新季度期末距今超过180日')
    elif any(out[key] is None for key in ('RevenueYoY','GrossMarginYoY','FCFTTM')):
        out['FinReason']='同比、毛利率或连续四季度现金流不足/冲突'
    elif out['RevenueYoY']>0 and out['GrossMarginYoY']>=0 and out['FCFTTM']>0:
        out.update(FinState='EXPANSION',FinReason='营收增长、毛利率同比未下降、TTM自由现金流为正')
    elif out['RevenueYoY']<0 and out['GrossMarginYoY']<0:
        out.update(FinState='DETERIORATION',FinReason='营收与毛利率同比同时下降')
    else:
        out.update(FinState='NEUTRAL',FinReason='财务信号方向不一致')
    return out


def build_daily(snapshot, dates, extra_delay=0):
    if not isinstance(extra_delay,int) or extra_delay<0:
        raise ValueError('额外延迟必须为非负整数交易日')
    dates = pd.DatetimeIndex(dates).normalize()
    if dates.has_duplicates or not dates.is_monotonic_increasing:
        raise ValueError('交易日期必须唯一且升序')
    clean,rejected = prepare_facts(snapshot)
    incoming=defaultdict(list)
    for fact in clean:
        first = dates.searchsorted(fact['_known'],side='right')+extra_delay
        if first<len(dates):
            incoming[first].append(fact)
    visible, rows, quarters = [], [], {}
    for i,day in enumerate(dates):
        if incoming[i]:
            visible.extend(incoming[i])
            quarters=quarterly_points(select_vintages(visible))
        rows.append({'Date':day,**financial_state(quarters,day)})
    frame = pd.DataFrame(rows).set_index('Date')
    return frame,dict(version=VERSION,raw_facts=len(snapshot['facts']),accepted_facts=len(clean),
                       rejected_facts=rejected,extra_delay=extra_delay,
                       availability_policy='在filed_at与美东accepted_at日期的较晚者之后，首个交易日收盘才可使用；信号再于次日开盘成交。',
                       state_counts=frame.FinState.value_counts().to_dict())
