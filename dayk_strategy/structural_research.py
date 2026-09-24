"""Differentiate tactical pullbacks from structural trend exits."""
import argparse
from hashlib import sha256
import json
from pathlib import Path

from cycle_research import cycle_policy
from dynamic_research import report
from inflection_research import operating_signals
from integrated_research import build_data
from recovery_research import RecoveryPolicy,compare
from strategy import Config,HERE

NAMES={'baseline':'原全仓破低波段','channel':'20日通道趋势退出','atr4':'4ATR趋势退出','hybrid':'短期与趋势分开处理（主假设）'}


class StructuralPolicy:
    def __init__(self,rule):
        if rule not in NAMES:raise ValueError('未知结构退出规则')
        self.rule=rule;self.baseline=RecoveryPolicy('baseline')
        self.stop=None;self.peak=None;self.exit_mode=None;self.days=0;self.exit_close=None
        self.stop_history={}

    def seed(self,row):
        self.peak=float(row.Close);self.stop=max(0.,self.peak-4*row.ATR)

    def __call__(self,row,rule,holding,stop):
        self.stop_history[row.name]=self.stop if holding and self.rule in ('atr4','hybrid') else None
        return self.decide(row,rule,holding,stop)

    def decide(self,row,rule,holding,stop):
        if self.rule=='baseline':return self.baseline(row,rule,holding,stop)
        ready,_,worsening=operating_signals(row,'inflection')
        if holding:
            self.exit_mode=None;self.days=0
            signal,reason=cycle_policy(row,'cycle_relative',True,stop)
            if signal:self.stop=None;self.peak=None;return signal,reason
            if self.stop is None:raise ValueError('持仓缺少此前收盘确定的跟踪线')
            structure=(row.Close<row.PriorLow20) if self.rule=='channel' else row.Close<=self.stop
            tactical=self.rule=='hybrid' and row.PriorOverheat and row.Close<row.PriorClose and row.Close<row.PriorLow
            if structure or tactical:
                self.exit_mode='trend' if structure else 'tactical';self.exit_close=float(row.Close)
                return 'SELL',('趋势退出：破20日低点' if self.rule=='channel' else '趋势退出：破上一日4ATR跟踪线') if structure else '短期退出：过热后破低'
            self.peak=max(self.peak,float(row.Close));self.stop=max(self.stop,self.peak-4*row.ATR)
            return '',''
        if self.exit_mode:
            self.days+=1
            if not ready or worsening:
                self.exit_mode=None;self.stop=None;self.peak=None;return '',''
            if self.days==1:return '',''
            if self.exit_mode=='trend':
                buy=row.Close>row.EMA and row.Close>row.PriorHigh
                reason='趋势回补：站上EMA20且突破前日高点'
            else:
                buy=row.Close<=row.EMA or row.RSI2<30 or row.Close>self.exit_close or self.days>=5
                reason='短期回补：均线、RSI、突破卖出价或5日'
            if buy:self.seed(row);return 'BUY',reason
            return '',''
        signal,reason=cycle_policy(row,'cycle_relative',False,stop)
        if signal=='BUY':self.seed(row)
        return signal,reason


def structural_features(data):
    result=data.copy();result['PriorHigh']=result.High.shift(1)
    result['PriorLow20']=result.Low.shift(1).rolling(20).min()
    return result


def run(output):
    import pandas as pd
    output.mkdir(parents=True,exist_ok=True)
    files=[HERE/'structural_protocol.json',HERE/'reports/integrated/stockresearch_snapshot.json',HERE/'reports/integrated/stockresearch_flow.json']
    protocol,snapshot,flow=[json.loads(p.read_text()) for p in files]
    data=structural_features(build_data(snapshot,flow));delayed=structural_features(build_data(snapshot,flow,1))
    cases=[('full',data,protocol['full_start'],Config()),('late',data,protocol['late_start'],Config()),
           ('cost_stress',data,protocol['full_start'],Config(fee_bps=10,slippage_bps=20)),('delay_stress',delayed,protocol['full_start'],Config())]
    result={};full_curves=None
    for section,frame,start,config in cases:
        policies={}
        def factory(rule):
            policies[rule]=StructuralPolicy(rule);return policies[rule]
        stats,curves,trades,ledgers=compare(frame,start,config,names=NAMES,policy_factory=factory);result[section]=stats
        for rule in NAMES:
            curves[rule]['SignalATRStop']=pd.Series(policies[rule].stop_history,dtype=float).reindex(curves[rule].index)
            curves[rule]=curves[rule].rename(columns={'Stop':'EngineReferenceStop'})
        if section=='full':full_curves=curves
        folder=output/section;folder.mkdir(exist_ok=True)
        for name,c in curves.items():c.to_csv(folder/f'{name}_daily.csv',encoding='utf-8-sig')
        for name,t in trades.items():t.to_csv(folder/f'{name}_round_trips.csv',index=False,encoding='utf-8-sig')
        for name,t in ledgers.items():t.to_csv(folder/f'{name}_rebuys.csv',index=False,encoding='utf-8-sig')
    result.update(start=str(full_curves['hold'].index[0].date()),end=str(full_curves['hold'].index[-1].date()),
                  historical_pass=all(result[s]['candidates'][protocol['primary_rule']]['section_pass'] for s,_,_,_ in cases),
                  candidate_acceptance={r:all(result[s]['candidates'][r]['section_pass'] for s,_,_,_ in cases) for r in NAMES},future_edge_verified=False,
                  input_hashes={str(p.relative_to(HERE)):sha256(p.read_bytes()).hexdigest() for p in files},
                  code_hashes={str(p.relative_to(HERE)):sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),HERE/'recovery_research.py',HERE/'research.py']})
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
    extra='<section><h2>按退出原因决定回补</h2><p>趋势退出：等站上EMA20且突破前日最高价；短期退出：保留原来的快速回补。跟踪线只采用上一日收盘已确定的值，跳空仍按次日实际开盘加滑点执行。财务与同业决定首次入场，财务转差仍可退出。</p><p>四条规则固定后运行，未搜索通道长度和ATR倍数；是否有收益优势以全期、后期及成本结果为准。</p><p><a href="../recovery/LITE_recovery_report.html">上一轮：收益损失归因与回补对照</a></p></section>'
    path=report(data,result,full_curves,{**protocol,'levels':'0%、100%','full_position':True},output,names=NAMES,round_label='第十轮 · 按退出原因回补',extra_html=extra,filename='LITE_structural_report.html')
    print('报告：',path)
    for section,_,_,_ in cases:print(section,pd.DataFrame(result[section]['candidates']).T[['return_pct','profit_multiple','max_drawdown_pct','reduction_increase_cycles','median_closed_hold','section_pass']].to_string())
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=HERE/'reports/structural')
    run(parser.parse_args().output)
