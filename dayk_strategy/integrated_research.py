"""Incremental tests of StockResearchAgent flow, market and operating inputs."""
import argparse
from hashlib import sha256
from html import escape
import json
from pathlib import Path

import pandas as pd

from cycle_research import add_peers
from dynamic_research import ExposurePolicy,dynamic_simulate,reduction_intervals,report
from fundamental_strategy import enriched
from position_research import features,target_check
from research import metrics,simulate
from stockresearch_adapter import adjusted_prices,add_market_flow,export_flow,extra_financial_daily,freeze_database,source_hashes
from strategy import Config,HERE,validate_bars
from swing_research import matched_hold

NAMES={'baseline':'原动态半仓规则','flow':'加入日线资金','flow_market':'再加入SPY市场状态','flow_market_cash':'再加入现金流与经营质量（主假设）'}


class IntegratedPolicy(ExposurePolicy):
    def __init__(self,rule):
        if rule not in NAMES:raise ValueError('未知综合规则')
        super().__init__('partial_break');self.integrated_rule=rule

    def tactical_trigger(self,row):
        original=super().tactical_trigger(row)
        if self.integrated_rule=='baseline':return original
        eligible=bool(row.FlowAvailable)
        sustained=eligible and row.FlowScore<=-20 and row.PriorFlowScore<=-20 and row.Close<row.EMA
        return bool((original and eligible and row.FlowScore<0) or sustained)

    def __call__(self,row,fill=''):
        target,reason=super().__call__(row,fill)
        if self.integrated_rule!='baseline' and '过热后破低' in reason:reason=reason.replace('过热后破低','量价资金确认减仓')
        if self.integrated_rule in ('flow_market','flow_market_cash') and row.MarketRiskOff and row.Close<row.EMA:
            target=min(target,.5);reason+='；SPY弱势且个股低于EMA20'
        if self.integrated_rule=='flow_market_cash' and row.OCFMarginYoY<0 and row.OperatingMarginYoY<0 and row.Close<row.SMA:
            target=min(target,.5);reason+='；现金流率与营业利润率同比下降'
        return target,reason


def build_data(snapshot,flow,delay=0):
    bars=adjusted_prices(snapshot,'LITE')
    base,_=enriched(bars,snapshot,delay)
    peers={'rows':[r for r in snapshot['prices'] if r['ticker'] in ('CIEN','COHR')]}
    data=features(add_peers(base,peers))
    return add_market_flow(data,snapshot,flow).join(extra_financial_daily(snapshot,data.index,delay))


def compare(data,start,config):
    hold,ht=simulate(data,start,'hold',config);hold_stats=metrics(hold,ht,config.initial_cash)
    stats={};curves={'hold':hold};trades={};intervals={}
    for rule in NAMES:
        c,t=dynamic_simulate(data,start,rule,config,policy=IntegratedPolicy(rule))
        aligned=matched_hold(data,c,config);s=metrics(c,pd.DataFrame(),config.initial_cash);s.pop('closed_trades')
        a=metrics(aligned,pd.DataFrame(),config.initial_cash)['return_pct'];ints=reduction_intervals(c)
        completed=ints[ints.status=='减仓后再加仓']
        s.update(target_check(s['return_pct'],hold_stats['return_pct']))
        s.update(aligned_return_pct=a,excess_aligned_pp=s['return_pct']-a,reduction_increase_cycles=len(completed),
                 fills=len(t),fees=float(c.Fee.sum()),mean_exposure_pct=float(c.Exposure.mean()*100),
                 min_cash=float(c.Cash.min()),max_exposure_pct=float(c.Exposure.max()*100))
        s['section_pass']=bool(s['target_pass'] and s['excess_aligned_pp']>1e-8 and len(completed)>=3)
        stats[rule]=s;curves[rule]=c;curves[rule+'_aligned']=aligned;trades[rule]=t;intervals[rule]=ints
    previous=None
    for rule in NAMES:
        stats[rule]['incremental_return_pp']=None if previous is None else stats[rule]['return_pct']-stats[previous]['return_pct']
        previous=rule
    return dict(hold=hold_stats,candidates=stats),curves,trades,intervals


def run(output,snapshot_path=None,flow_path=None):
    output.mkdir(parents=True,exist_ok=True)
    protocol=json.loads((HERE/'integrated_protocol.json').read_text())
    snapshot=json.loads(snapshot_path.read_text()) if snapshot_path else freeze_database(HERE.parent/'data/research.sqlite',output,'2026-09-18')
    if snapshot_path:(output/'stockresearch_snapshot.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf-8')
    flow=json.loads(flow_path.read_text()) if flow_path else export_flow(adjusted_prices(snapshot,'LITE'),output)
    if flow_path:(output/'stockresearch_flow.json').write_text(json.dumps(flow,ensure_ascii=False,indent=2),encoding='utf-8')
    data=build_data(snapshot,flow);delayed=build_data(snapshot,flow,1)
    old=validate_bars(pd.read_csv(HERE/'reports/fundamental/price_snapshot.csv',index_col='Date'))
    common=data.index.intersection(old.index)
    price_diff=float((data.loc[common,['Open','High','Low','Close']]-old.loc[common,['Open','High','Low','Close']]).abs().max().max())
    cases=[('full',data,protocol['full_start'],Config()),('late',data,protocol['late_start'],Config()),
           ('cost_stress',data,protocol['full_start'],Config(fee_bps=10,slippage_bps=20)),
           ('delay_stress',delayed,protocol['full_start'],Config())]
    result={};full_curves=None
    for section,frame,start,config in cases:
        stats,curves,trades,intervals=compare(frame,start,config);result[section]=stats
        if section=='full':full_curves=curves
        folder=output/section;folder.mkdir(exist_ok=True)
        for name,c in curves.items():c.to_csv(folder/f'{name}_daily.csv',encoding='utf-8-sig')
        for name,t in trades.items():t.to_csv(folder/f'{name}_fills.csv',index=False,encoding='utf-8-sig')
        for name,t in intervals.items():t.to_csv(folder/f'{name}_reductions.csv',index=False,encoding='utf-8-sig')
    sample=data.loc[protocol['full_start']:];coverage={col:dict(available_days=int(sample[col].notna().sum()),total_days=len(sample)) for col in ['FlowScore','SPYSMA200','OCFMarginYoY','OperatingMarginYoY','NetMargin','CashConversion']}
    result.update(start=str(sample.index[0].date()),end=str(sample.index[-1].date()),feature_coverage=coverage,
                  excluded_coverage=snapshot['excluded_coverage'],previous_price_max_absolute_difference=price_diff,
                  historical_pass=all(result[s]['candidates'][protocol['primary_rule']]['section_pass'] for s,_,_,_ in cases),future_edge_verified=False,
                  code_hashes=source_hashes(),flow_model_version=flow['model_version'])
    data.to_csv(output/'integrated_features.csv',encoding='utf-8-sig')
    result['input_hashes']={p.name:sha256(p.read_bytes()).hexdigest() for p in [HERE/'integrated_protocol.json',output/'stockresearch_snapshot.json',output/'stockresearch_flow.json']}
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
    display={**protocol,'levels':'0%、50%、100%','risk':protocol['missing'],
             'reentry':'减仓成交日不回补；此后回到EMA20、RSI2低于30、突破减仓信号价或达到第5个减仓交易日时解除波段限制，其他仓位限制仍有效。'}
    labels={'FlowScore':'日线资金评分','SPYSMA200':'SPY长期趋势','OCFMarginYoY':'经营现金流率同比','OperatingMarginYoY':'营业利润率同比','NetMargin':'净利率','CashConversion':'经营现金流/正净利润'}
    table=pd.DataFrame([{'特征':labels[c],'可用交易日':v['available_days'],'总交易日':v['total_days']} for c,v in coverage.items()]).to_html(index=False,border=0)
    incremental=pd.DataFrame([{'规则':NAMES[k],'相对上一层收益变化（百分点）':v['incremental_return_pp']} for k,v in result['full']['candidates'].items()]).to_html(index=False,border=0,na_rep='—',float_format=lambda v:f'{v:,.2f}')
    extra=f'<section><h2>stockResearchAgent 数据接入</h2><p>直接复用日线资金模块，在冻结复权行情上重算；SPY趋势来自同一数据库。财务按披露版本和生效日期生成。资金评分为量价代理，不代表真实机构流入。</p>{table}<h2>逐层增加数据的收益变化</h2>{incremental}<p>经营现金流/正净利润仅在净利润为正时有值；缺失不填零。宏观、预期与逐笔历史不足，本轮未用于信号；完整覆盖范围保存在统计文件。没有直接使用当前研报结论或预测分数。</p><p>与此前冻结行情的共同日期OHLC最大绝对差：{price_diff:.10f}。当前历史已观察，不是独立样本外检验。</p></section>'
    path=report(data,result,full_curves,display,output,names=NAMES,round_label='第八轮 · stockResearchAgent综合数据',extra_html=extra,filename='LITE_integrated_report.html')
    print('报告：',path)
    for section,_,_,_ in cases:print(section,pd.DataFrame(result[section]['candidates']).T[['return_pct','profit_multiple','max_drawdown_pct','reduction_increase_cycles','incremental_return_pp','section_pass']].to_string())
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=HERE/'reports/integrated')
    parser.add_argument('--snapshot',type=Path);parser.add_argument('--flow',type=Path)
    args=parser.parse_args();run(args.output,args.snapshot,args.flow)
