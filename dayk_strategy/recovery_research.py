"""Exit/reentry factorial study and reconciled attribution of previous overlays."""
import argparse
from hashlib import sha256
import json
from pathlib import Path

import numpy as np
import pandas as pd

from cycle_research import cycle_policy
from dynamic_research import report
from inflection_research import operating_signals
from integrated_research import build_data
from position_research import target_check
from research import metrics,simulate
from strategy import Config,HERE
from swing_research import matched_hold,rebuy_ledger

NAMES={'baseline':'原全仓破低波段','exit_memory':'只改卖出：10日过热记忆','reentry_confirmation':'只改回补：止跌确认',
       'memory_confirmation':'过热记忆＋止跌回补（主假设）','flow_recovery':'另加资金改善回补','fast_reentry':'第二阶段：允许次日立即回补'}


class RecoveryPolicy:
    def __init__(self,rule):
        if rule not in NAMES:raise ValueError('未知规则')
        self.rule=rule;self.memory=1 if rule in ('baseline','reentry_confirmation','fast_reentry') else 10
        self.arm=0;self.tactical=False;self.cash_days=0;self.exit_close=None

    def __call__(self,row,rule,holding,stop):
        ready,_,worsening=operating_signals(row,'inflection')
        if holding:
            self.tactical=False;self.cash_days=0
            signal,reason=cycle_policy(row,'cycle_relative',True,stop)
            if signal:
                self.arm=0;return signal,reason
            if row.PriorOverheat:self.arm=self.memory
            trigger=self.arm>0 and row.Close<row.PriorClose and row.Close<row.PriorLow
            self.arm=max(0,self.arm-1)
            if trigger:
                self.tactical=True;self.exit_close=float(row.Close);self.arm=0
                return 'SELL',f'此前{self.memory}日过热后破低'
            return '',''
        self.arm=0
        if self.tactical:
            self.cash_days+=1
            if not ready or worsening:
                self.tactical=False;return '',''
            if self.cash_days==1 and self.rule!='fast_reentry':return '',''
            if self.rule in ('baseline','exit_memory','fast_reentry'):
                buy=row.Close<=row.EMA or row.RSI2<30 or row.Close>self.exit_close or self.cash_days>=5
                reason='原回补：回均线、低RSI、突破卖出价或5日期限'
            else:
                buy=row.Close>row.PriorHigh or (row.Close<=row.EMA and row.Close>row.PriorClose) or row.Close>self.exit_close or (self.cash_days>=5 and row.Close>row.EMA)
                reason='止跌回补：破前高、均线下转涨、突破卖出价或5日后站上均线'
                if self.rule=='flow_recovery' and row.FlowScore>row.PriorFlowScore and row.Close>row.PriorClose:
                    buy=True;reason='回补：资金评分改善且收盘上涨'
            return ('BUY',reason) if buy else ('','')
        return cycle_policy(row,'cycle_relative',False,stop)


def decorate(data,curve,config):
    c=curve.copy();c['Cash']=c.Equity-c.Units*data.loc[c.index,'Close']
    c['Exposure']=c.Units*data.loc[c.index,'Close']/c.Equity
    c['DeltaUnits']=c.Units.diff().fillna(c.Units.iloc[0]);c['Fee']=(c.DeltaUnits.abs()*c.FillPrice*config.fee_bps/10000).fillna(0)
    return c


def compare(data,start,config,names=None,policy_factory=None):
    names=names or NAMES;policy_factory=policy_factory or RecoveryPolicy
    hold,ht=simulate(data,start,'hold',config);hs=metrics(hold,ht,config.initial_cash)
    curves={'hold':hold};stats={};trades={};ledgers={}
    for rule in names:
        c,t=simulate(data,start,rule,config,policy=policy_factory(rule),allow_sell_day_signal=rule=='fast_reentry');c=decorate(data,c,config)
        aligned=matched_hold(data,c,config);a=metrics(aligned,pd.DataFrame(),config.initial_cash)['return_pct']
        s=metrics(c,t,config.initial_cash);s.update(target_check(s['return_pct'],hs['return_pct']))
        ledger=rebuy_ledger(c,config);done=ledger[ledger.status=='完成回补']
        durations=[c.index.get_loc(pd.Timestamp(r.exit_date))-c.index.get_loc(pd.Timestamp(r.entry_date)) for _,r in t.iterrows()]
        s.update(aligned_return_pct=a,excess_aligned_pp=s['return_pct']-a,
                 reduction_increase_cycles=len(done),positive_rebuys=int((done.unit_multiplier>1).sum()),
                 median_closed_hold=float(np.median(durations)) if durations else None,
                 fees=float(c.Fee.sum()),mean_exposure_pct=float(c.Exposure.mean()*100))
        s['section_pass']=bool(s['target_pass'] and s['excess_aligned_pp']>1e-8 and len(done)>=3 and durations and np.median(durations)<=21)
        curves[rule]=c;curves[rule+'_aligned']=aligned;stats[rule]=s;trades[rule]=t;ledgers[rule]=ledger
    return dict(hold=hs,candidates=stats),curves,trades,ledgers


def local_reduction_audit(curve,prices):
    """Local shadow holds the pre-sale inventory through the next actual increase.

    Different windows start with different actual capital; do not add percentages
    or label these conditional comparisons whole-portfolio attribution.
    """
    rows=[];pending=None
    for i,(day,row) in enumerate(curve.iterrows()):
        if row.Fill=='SELL' and pending is None:
            previous=curve.iloc[i-1]
            pending=(day,float(previous.Units),float(previous.Cash),i,str(curve.Reason.iloc[i-1]))
        elif row.Fill=='BUY' and pending is not None:
            start,units,cash,j,reason=pending;shadow=cash+units*prices.loc[day,'Close']
            rows.append(dict(sell_date=str(start.date()),rebuy_date=str(day.date()),sessions=i-j,
                             local_effect_pct=(row.Equity/shadow-1)*100,actual_equity=float(row.Equity),
                             shadow_equity=float(shadow),reason=reason));pending=None
    return pd.DataFrame(rows)


def pnl_difference(data,curve,baseline):
    """Exact additive dollar attribution: overnight, intraday, slippage, fees."""
    if not curve.index.equals(baseline.index):raise ValueError('对照日期不同')
    price=data.loc[curve.index];prior_close=price.Close.shift(1).fillna(price.Open.iloc[0])
    def parts(c):
        prior=c.Units.shift(1).fillna(0);delta=c.Units-prior
        slip=(delta*(c.FillPrice-price.Open)).where(delta.abs()>1e-10,0.)
        return pd.DataFrame(dict(overnight=prior*(price.Open-prior_close),intraday=c.Units*(price.Close-price.Open),
                                 slippage=-slip,fees=-c.Fee),index=c.index)
    difference=parts(curve)-parts(baseline)
    residual=float(difference.to_numpy().sum()-(curve.Equity.iloc[-1]-baseline.Equity.iloc[-1]))
    if abs(residual)>1e-6:raise ValueError('收益差归因不守恒')
    return difference,dict(**{k:float(v) for k,v in difference.sum().items()},total=float(difference.to_numpy().sum()),residual=residual)


def previous_audit(data,output):
    folder=HERE/'reports/integrated/full'
    base=pd.read_csv(folder/'baseline_daily.csv',index_col='Date',parse_dates=True)
    effects={};locals={}
    for rule in ['baseline','flow','flow_market','flow_market_cash']:
        c=pd.read_csv(folder/f'{rule}_daily.csv',index_col='Date',parse_dates=True).fillna({'Fill':''})
        changes,totals=pnl_difference(data,c,base);effects[rule]=totals
        changes.to_csv(output/f'previous_{rule}_pnl_difference.csv',encoding='utf-8-sig')
        local=local_reduction_audit(c,data);local.to_csv(output/f'previous_{rule}_reduction_audit.csv',index=False,encoding='utf-8-sig');locals[rule]=local
    return effects,locals


def run(output):
    output.mkdir(parents=True,exist_ok=True)
    files=[HERE/'recovery_protocol.json',HERE/'reports/integrated/stockresearch_snapshot.json',HERE/'reports/integrated/stockresearch_flow.json']
    protocol,snapshot,flow=[json.loads(p.read_text()) for p in files]
    data=build_data(snapshot,flow);data['PriorHigh']=data.High.shift(1)
    delayed=build_data(snapshot,flow,1);delayed['PriorHigh']=delayed.High.shift(1)
    effects,locals=previous_audit(data,output)
    result={};full_curves=None;cases=[('full',data,protocol['full_start'],Config()),('late',data,protocol['late_start'],Config()),
       ('cost_stress',data,protocol['full_start'],Config(fee_bps=10,slippage_bps=20)),('delay_stress',delayed,protocol['full_start'],Config())]
    for section,frame,start,config in cases:
        stats,curves,trades,ledgers=compare(frame,start,config);result[section]=stats
        if section=='full':full_curves=curves
        folder=output/section;folder.mkdir(exist_ok=True)
        for name,c in curves.items():c.to_csv(folder/f'{name}_daily.csv',encoding='utf-8-sig')
        for name,t in trades.items():t.to_csv(folder/f'{name}_round_trips.csv',index=False,encoding='utf-8-sig')
        for name,t in ledgers.items():t.to_csv(folder/f'{name}_rebuys.csv',index=False,encoding='utf-8-sig')
    result.update(start=str(full_curves['hold'].index[0].date()),end=str(full_curves['hold'].index[-1].date()),
                  previous_attribution=effects,historical_pass=all(result[s]['candidates'][protocol['primary_rule']]['section_pass'] for s,_,_,_ in cases),
                  candidate_acceptance={r:all(result[s]['candidates'][r]['section_pass'] for s,_,_,_ in cases) for r in NAMES},future_edge_verified=False,
                  input_hashes={str(p.relative_to(HERE)):sha256(p.read_bytes()).hexdigest() for p in files},
                  code_hashes={str(p.relative_to(HERE)):sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),HERE/'research.py',HERE/'swing_research.py',HERE/'dynamic_research.py',HERE/'integrated_research.py']})
    (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    (output/'protocol.json').write_text(json.dumps(protocol,ensure_ascii=False,indent=2),encoding='utf-8')
    audit=pd.DataFrame(effects).T.drop(columns='residual').rename(columns={'overnight':'隔夜持股差','intraday':'日内持股差','slippage':'滑点损耗差','fees':'手续费损耗差','total':'期末净值差'})
    worst=locals['flow_market_cash'].sort_values('local_effect_pct').head(5)[['sell_date','rebuy_date','sessions','local_effect_pct']].rename(columns={'sell_date':'减仓日','rebuy_date':'再加仓日','sessions':'交易日间隔','local_effect_pct':'相对不减仓的局部影响%'})
    extra=f'<section><h2>上一轮收益为什么下降</h2><p>相对原动态半仓账户，按相同初始10万美元核算以下金额差（美元）。四项合计严格等于期末净值差；含持股数量变化的后续复利影响，不能把隔夜与日内差简单称为独立因果效应。</p>{audit.to_html(border=0,float_format=lambda v:f"{v:,.2f}")}<h2>上轮综合规则最差的减仓区间</h2>{worst.to_html(index=False,border=0,float_format=lambda v:f"{v:,.2f}")}<p>局部对照从实际减仓前的现金和持股出发，假设保持到下一次实际加仓收盘；各段本金不同，不能相加成全期收益，也不代表可以事先知道反弹。</p><p>本轮五个固定候选包含卖出和回补的2×2对照，另检验资金改善用于回补。没有按已知大涨大跌日期手动指定交易。</p></section>'
    extra=extra.replace('本轮五个固定候选','第一阶段五个固定候选')+'<section><h2>第二阶段：回补执行时序</h2><p>前五组结果观察后，增加允许卖出成交日收盘产生回补信号的独立假设；订单仍在下一交易日开盘执行。该候选并非与前五组同时预设，完整结果保留，主假设不变。</p></section>'
    path=report(data,result,full_curves,{**protocol,'levels':'0%、100%','full_position':True},output,names=NAMES,round_label='第九轮 · 卖出与回补分离检验',extra_html=extra,filename='LITE_recovery_report.html')
    print('报告：',path)
    for section,_,_,_ in cases:print(section,pd.DataFrame(result[section]['candidates']).T[['return_pct','profit_multiple','max_drawdown_pct','reduction_increase_cycles','median_closed_hold','section_pass']].to_string())
    print('归因：',effects['flow_market_cash']);return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=HERE/'reports/recovery')
    run(parser.parse_args().output)
