# 美股日K与多股票策略研究 · Python

第一版以 **LITE 日线波段**为默认示例。输出离线可打开的交互式 HTML：K线、买卖信号、模拟成交点、均线、ATR 跟踪止损线、成交量和收益曲线。策略规则透明，可通过命令行改参数。

## 多股票质量＋动量第一版

### 光通信、存储、半导体18股试验

`industry18_protocol.json` 固定18只股票、五个分组以及原质量/动量评分。主方案每月选5只、每组最多2只、各20%，同时比较不限制分组、每组各1只、期初等权持有及动态合格池每月等权。报告为 `reports/industry18/report.html`。

```bash
# 复用StockResearchAgent数据接口；已有缓存不会重复下载
/opt/homebrew/bin/node --env-file=.env dayk_strategy/fetch_quality_universe.mjs --industry18 --foreign-filings
# 以下两步可完全离线复现
dayk_strategy/.venv/bin/python dayk_strategy/foreign_financials.py
dayk_strategy/.venv/bin/python dayk_strategy/industry18_research.py
```

外资公司使用原币种SEC季度6-K和20-F，比例计算不混币；原始附件、披露时点、来源哈希和解析记录保留。ASML读取五季度表，台积电/联电读取合并报表，GFS兼容inline XBRL和普通HTML。AMD总负债由同份财报的资产减权益补齐，并验证资产负债表恒等式。GFS在2023/2024年春季合计32个交易日因最新披露财报超过180天而暂时不入选，没有使用未来年报补历史。

2023-01-03至2026-09-18：主方案净收益1035.69%、最大回撤37.98%；期初17只等权持有824.64%、回撤37.90%，利润只多25.59%，未达到多50%且回撤减半。最近一年主方案209.94%、回撤37.63%；18只持有279.16%、回撤40.05%。SNDK从2025-02-24正常交易起算，主动选股直到2026-02-25才有253日行情历史，最近一年基准则可在期初买入；收益归因另存 `passive_contributions.csv`。指定股票池含事后选择偏差，不称为未见样本验证。WDC分拆在复权序列中近似处理，未重建SNDK实物分派持仓。

### 每日仓位控制检验

保留月末选股，增加每日收盘判断、次日开盘执行的仓位控制。四个固定候选：SPY低于200日均线减半、全池20日涨幅为负时空仓、站上60日均线比例决定0%/50%/100%仓位、股票池与SPY联合条件。目标变化才交易，原策略默认行为保持一致。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/portfolio_risk.py
```

结果在 `reports/portfolio_risk/portfolio_risk_report.html`。全池20日下跌空仓规则在最近一年将收益693.87%提高到816.03%，回撤43.08%降到26.85%；提高成本后这一年仍同时改善。但完整区间收益由2786.90%降至1985.59%，回撤仅由46.86%降至46.04%，因此没有跨区间稳定优势。四个新候选均未通过完整区间“收益提高且回撤降低”，也未达到相对等权持有利润1.5倍且回撤减半的综合目标。减仓区间收益差是各段归一化条件比较，不可直接相加。95项测试通过，覆盖原账户一致性、每日风控次日成交、月内恢复和新股不提前进入整体走势分母。

`quality_momentum.py` 从 StockResearchAgent 数据库只读冻结 CIEN、COHR、LITE、MU、SNDK、WDC 与 SPY 的行情和财务版本。质量为TTM净利率、经营现金流率及负债/资产的反向百分位；与跳过最近21个交易日的12个月价格动量各占50%。起始收盘及月末收盘选最高3只，次日开盘等权换仓，单账户扣除全组合费用，无杠杆。并非文献原版QMJ复刻。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/quality_momentum.py
dayk_strategy/.venv/bin/python dayk_strategy/quality_momentum.py --snapshot dayk_strategy/reports/quality_momentum/snapshot.json --output dayk_strategy/reports/quality_momentum_replay
```

报告为 `reports/quality_momentum/quality_momentum_report.html`，包括全期、2025年起、最近一年、成本及财务延迟对照；逐日组合、逐笔换仓、持仓权重、决策日排名与来源、数据覆盖、逐股剔除敏感性均可复核。期末统一计入清仓成本，和早期未清仓统计不同。

全期2023-01-03至2026-09-18：质量＋动量收益2786.90%、最大回撤46.86%；仅动量2558.61%、回撤49.44%；期初等权持有1340.99%、回撤46.35%。最近一年组合693.87%、回撤43.08%，等权持有331.50%、回撤37.19%。收益门槛通过，回撤减半门槛未通过。91项测试通过，新增涵盖跨股扣费后目标仓位、逐日损益守恒、财务披露/修订时序、月末次日成交及未来数据不改变历史。

本版本是现有六股试验池，不是跨行业结果。名单事后确定，存在幸存者和选股偏差；新上市SNDK直到2026-02-17具备足够历史，首次组合成交为2026-03-02。逐股剔除后，质量增量并非全部保持正值；不能把漂亮收益当作稳健优势。GAAP净利润也有一次性项目污染：LITE债务清偿损失、WDC持有Sandisk权益收益已与官方公告核对，未事后修改规则来提高结果。需要更广股票池和未见样本验证。

## 新增：财务信息＋日线交易

**最新：按退出原因区分回补（第十轮）**。新增20日通道低点退出、4ATR跟踪退出、以及“过热短期退出快速回补＋趋势退出等待重新走强”的组合。`reports/structural/LITE_structural_report.html` 保留四组对照。三条新规则全期分别1017.00%、1019.11%、1122.52%，低于原全仓破低2048.25%；主规则最大回撤55.18%，同样更差。本轮没有可晋级方案。80项测试通过，包含跟踪线只上移、按前日线判断、退出类型优先级、回补条件及策略因果性。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/structural_research.py
```

逐日账本的 `SignalATRStop` 才是新规则实际使用的4ATR线；`EngineReferenceStop` 是公共引擎的参考线，未用于新规则止损。全期、后期、成本、财务延迟的完整交易与回补均保存；输入和规则冻结，不搜索ATR倍数或通道长度。原候选也尚未达到2518.78%目标。

**卖出与回补分离检验（第九轮）**。`reports/recovery/LITE_recovery_report.html` 新增上轮收益损失的隔夜/日内/成本归因、局部减仓对照，以及六套规则的日K与完整回补账本。第一阶段固定卖出×回补的2×2对照和资金改善回补扩展；观察结果后，第二阶段单独检验允许卖出成交日收盘发信号、次日开盘回补。没有同日卖出买回，也没有修改此前默认执行方式。

原全仓破低规则2048.25%，只延长过热记忆1454.54%，只改止跌回补1735.24%，两者组合1189.59%，再加资金改善回补1220.48%，允许次日立即回补1718.60%。新增五种方案均不如原候选，仍未达到2518.78%目标。76项测试通过，包含全期美元损益归因守恒、过热记忆到期、实际次日成交、原规则一致性及六条策略因果性。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/recovery_research.py
```

**复用 stockResearchAgent 综合数据（第八轮）**。新增只读数据适配器，直接调用现有 `src/capital-flow.js` 重算日线量价资金指标，接入数据库中的SPY和财务历史版本。资金评分、SPY长期趋势、经营现金流率同比、营业利润率同比及净利率均覆盖931个回测交易日；现金流/正净利润覆盖249日，其余保持未知。宏观、预期、逐笔历史不足，本轮没有用于历史交易信号。

`reports/integrated/LITE_integrated_report.html` 提供四套可切换的日K加减仓点、仓位、净值、数据覆盖与逐层对照。原规则1967.57%，加入资金1630.24%，再加市场1456.78%，再加经营质量1391.03%；持有1679.18%，目标2518.78%。数据接入已完成，但本次组合规则降低收益，未通过验收，不据此宣称综合数据无价值。70项测试通过，离线复现的四个区间统计一致。

```bash
# 从当前本地数据库读取并冻结；本轮历史截止固定为2026-09-18
dayk_strategy/.venv/bin/python dayk_strategy/integrated_research.py
# 使用全部冻结输入，不访问数据库，也不重新调用资金模块
dayk_strategy/.venv/bin/python dayk_strategy/integrated_research.py --snapshot dayk_strategy/reports/integrated/stockresearch_snapshot.json --flow dayk_strategy/reports/integrated/stockresearch_flow.json --output dayk_strategy/reports/integrated-replay
```

读取数据库使用SQLite只读连接和同一事务；原投研程序及业务表不修改。Node桥接器仅将冻结行情放入内存数据库，调用原资金模块，不调用其保存、通知或回测入口。首次生成资金特征需要Node.js 22.5+；使用已冻结资金文件的离线回放只需Python环境。记录输入和源代码哈希；`integrated_features.csv` 保存逐日指标、财务生效日期及来源键。

**动态仓位（第七轮）**。`reports/dynamic/LITE_dynamic_report.html` 新增单账户目标仓位0%、25%、50%、100%，仅状态改变时下单，次日开盘按扣费后的净资产比例执行。三套固定规则均未达到利润为持有1.5倍的标准：动态半仓波段1967.57%，趋势分级969.25%，再加同业限制460.27%；同期持有1679.18%，目标2518.78%。主规则回撤降至37.85%，但收益也显著下降，不能算收益优先的改进。63项测试通过。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/dynamic_research.py
```

报告支持切换三套规则的日K加减仓点及实际仓位。各区间的现金、持股、目标、费用、每日净值、逐笔成交和减仓后再加仓间隔保存在 `reports/dynamic/`。部分减仓不计为全部平仓。

**分仓及50%利润增幅门槛（第六轮）**。目标是相同本金、区间与成本口径下，净利润至少达到买入持有的1.5倍。本样本持有收益1679.18%，所以目标为2518.78%。`reports/position/LITE_position_report.html` 可切换3条退出规则×5种初始分仓比例，显示日K加减仓点、实际仓位及收益门槛。新增底仓与波段账户，总仓位0—100%，不融资、不追加资金；两个账户之间不再平衡，实际占比会漂移。

全部15组均未达标。预设主假设“破低＋量能确认、初始50%波段仓”收益1787.58%；本轮事后最高为“跌破前日低点、100%波段仓”2048.25%，仅为持有利润的1.22倍，完成9组卖出回补。后者2025年起仍落后于持有，最大回撤仍50.63%。不能把最高历史收益当作已验证策略。57项测试通过，包括分仓现金与费用守恒、0%/100%边界及新规则因果性。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/position_research.py
```

输入沿用冻结快照，协议为 `position_protocol.json`，全期逐日账本和回补明细保存在 `reports/position/`。当前固定初始分仓模型的收益只是底仓与波段账户收益的加权平均，调整配比不能超出二者最高收益；该结论不涵盖其他动态仓位模型。

**完整波段验证（第五轮）**。`reports/swing/LITE_swing_report.html` 加入真实卖出和回补、逐笔持股数量归因，以及“同首次买点一直持有”对照，排除仅因初次买得便宜产生的优势。主规则完成31组卖出回补、持仓中位数6个交易日，全期净收益1844.35%，高于期初持有1679.18%，但低于同买点持有1866.55%。波段本身使最终财富降低1.13%，成本压力下也失败，仍未通过验收。50项测试通过。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/swing_research.py
```

报告可切换两个候选的买卖点；`*_rebuys.csv` 记录卖出到回补的持股变化，区别于买入到卖出的单笔交易盈亏。两组规则和失败结果完整保留，协议为 `swing_protocol.json`。

**探索结果（第四轮）**：`reports/cycle/LITE_cycle_report.html` 的三个固定新候选在2023-01-03至2026-09-18全期历史上首次超过持有。主假设“财务拐点”收益1738.63%，同业确认候选1866.55%，持有1679.18%。三条候选均只有一次买入、没有完整卖出，超额来自较低的首次入场价格；2025年起独立账户又均未胜过持有，因此跨区间验收仍未通过，不能称为已经验证的波段策略。43项测试通过。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/cycle_research.py
```

本轮将营收和毛利率改善速度作为双向买卖条件，另用本地CIEN、COHR历史复权行情作同业确认。只读数据库，保存同业快照；不新增资金、不加杠杆、不改变基准。协议 `cycle_protocol.json`、逐项验收、买卖点及滚动窗口保存在 `reports/cycle/`。历史指引数据尚未完成接入。

完全离线复现（不访问数据库）：

```bash
dayk_strategy/.venv/bin/python dayk_strategy/cycle_research.py --peer-snapshot dayk_strategy/reports/cycle/peer_snapshot.json --output dayk_strategy/reports/cycle-replay
```

**第三轮**：`reports/conviction/LITE_conviction_report.html` 加入空仓收益归因，以及“经营向好时延长持有”和“扩大入场”两个固定假设。新主规则全期收益从787.18%提高至1242.60%，仍低于持有的1679.18%；最大回撤扩大至50.63%。33个滚动12个月窗口仅6个胜过持有；2024年8月后的仓位一直持有至样本末日，已偏离数日至数周波段目标，不能视为成功策略。全部候选和失败结果保留。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/conviction_research.py
```

第三轮使用同一份冻结数据，协议为 `conviction_protocol.json`，结果、空仓区间、买卖账本及滚动窗口保存在 `reports/conviction/`。36项测试通过，包含空仓归因守恒和新规则因果性。

第二轮报告 `reports/inflection/LITE_inflection_report.html` 已加入“去掉现金流正值门槛”和“经营改善速度”两个新假设。全期收益分别约735.08%和787.18%，仍未超过同期持有的1679.18%。它们是在查看上一轮失败原因后提出的探索规则，不能作为样本外成功。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/inflection_research.py
```

该命令使用第一轮已冻结的财务和行情快照，不读取实时数据库。协议为 `inflection_protocol.json`，完整结果和买卖点保存在 `reports/inflection/`。

已经接入现有工作台的SEC财务事实，以只读方式访问SQLite，不修改工作台的数据或投资建议。具体数据规则、对照设计和本轮结果见 `FUNDAMENTAL_REVIEW.md`。

```bash
dayk_strategy/.venv/bin/python dayk_strategy/fundamental_strategy.py
```

打开 `dayk_strategy/reports/fundamental/LITE_fundamental_report.html` 查看主规则日K线买卖点、财务状态变化、原始披露依据、全期/早期/后期收益对照、季度收益、费用及信息延迟压力测试。

第一轮财务主规则也未通过收益优先标准。判断“经营改善”时同时要求营收增长、毛利率同比未下降和TTM自由现金流为正，导致LITE在2026年5月才满足入场条件；这是一条尚未成功的待检验假设，不是已经有效的交易建议。

财务快照、行情快照、逐日特征及各条规则的交易账本都保存在该报告目录。可完全离线复现：

```bash
dayk_strategy/.venv/bin/python dayk_strategy/fundamental_strategy.py --snapshot dayk_strategy/reports/fundamental/financial_snapshot.json --input dayk_strategy/reports/fundamental/price_snapshot.csv --output dayk_strategy/reports/fundamental-replay
```

本轮读取895条财务事实，覆盖营收、毛利、营业利润、经营现金流、资本支出。按历史披露版本计算单季度和TTM指标；未将近期盈利预期、当前综合研报评分或后来的新闻评分回填到历史。固定策略协议为 `financial_protocol.json`；不自动搜索参数或按全期收益挑选主规则。

## 原版纯技术基线

**验证状态：未通过用户指定的“扣费后收益跑赢买入持有”标准。** 原版及本次5组固定替代规则均未在2023-01-03至2026-09-18的LITE样本超过持有收益；季度滚动选择同样未达标。此目录提供可复现的研究工具，不把图上的买卖点作为已证实有效的交易建议。

查看 `reports/research/LITE_research.html` 可比较全部规则、季度选择账本及成本压力测试。研究结论和失败原因见 `REVIEW.md`。重跑：

```bash
dayk_strategy/.venv/bin/python dayk_strategy/research.py
```

滚动选择将2023年作为首个训练期，2024年起每季仅用此前行情按扣费总收益选规则，持仓跨季延续，季度首日收盘采用新规则。候选仅6组交易规则及持有，共7个，不做参数网格搜索。选规则不读取未来收益，但规则设计已经受观察过的LITE历史影响，因此这属于时间隔离的历史回放，不能称为完全未见样本验证。

## 运行

在当前项目根目录运行（Python 3.9+）：

```bash
python3 -m venv dayk_strategy/.venv
dayk_strategy/.venv/bin/python -m pip install -r dayk_strategy/requirements.txt
dayk_strategy/.venv/bin/python dayk_strategy/strategy.py --ticker LITE --start 2023-01-01
```

双击 `dayk_strategy/reports/LITE_report.html` 即可查看，报告内嵌图表脚本，查看时无需联网。拉取新行情需要联网。将 `LITE` 换成 `AAPL`、`NVDA` 等代码可以分析其他美股。

当前机器已安装独立环境。日常只需执行第三条命令。测试环境为 Python 3.9、pandas 2.3.3、plotly 6.9.0、yfinance 1.2.0。

自定义例子（参数只是研究起点，未优化）：

```bash
dayk_strategy/.venv/bin/python dayk_strategy/strategy.py --ticker LITE --start 2023-01-01 --fast 20 --slow 60 --breakout 20 --volume-multiple 1.2 --atr-multiple 3 --fee-bps 5 --slippage-bps 5
```

## 规则与成交时序

- **买入信号**：空仓时，收盘价 > EMA20 > SMA60；收盘价高于此前20根日线最高价；当日成交量 ≥ 此前20根日线平均成交量的1.2倍。前期高点、均量均排除当日。
- **卖出信号**：持仓时，收盘低于EMA20，或收盘价不高于已确定的ATR跟踪止损线。
- **止损线**：买入时为成交价−3×上一日ATR14（最低为0）；持仓中在没有卖出信号的收盘，以当日收盘−3×ATR14上调，次日生效，从不上移后再下调。ATR采用最近14根真实波幅的简单平均，而非 Wilder 平滑。
- **执行**：信号日收盘确认，下一根可用日线开盘加不利滑点成交。空心圆显示信号，三角形显示成交。跳空按开盘成交，不假设能成交在信号价或止损线。
- **限制**：只做多、全仓、可使用分数复权单位；持仓不重复买入；卖出成交当日不发新买入信号；没有固定持有天数或固定止盈，实际持有期由行情决定。
- **止损类型**：这是收盘确认型止损；日内跌破又收回不会止损，也不能把止损线理解为保证成交价。
- **期末**：未平仓按期末收盘计净值，不强行卖出；末日信号显示待执行。胜率只统计已完成买卖，零交易时胜率为空。

## 行情、复权与回测口径

使用 [yfinance 官方下载接口](https://ranaroussi.github.io/yfinance/reference/api/yfinance.download.html)，显式设置 `interval="1d"`、`auto_adjust=True`、`prepost=False`。图表采用 [Plotly Candlestick](https://plotly.com/python/candlestick-charts/)。

开始日前自动加载至少365个日历日作为指标预热，但收益只从指定开始日后的首个实际交易日起算。`--end YYYY-MM-DD` 不包含该日。无论盘中或盘后，都保守排除美东当天的日线，避免未完成日K参与信号；节假日以供应商实际返回的日期为准。

复权OHLC同时考虑拆股与现金分红，报告的价格和持仓数量是复权等价单位，不是历史实际成交报价或实际股数；收益为复权序列近似总回报，不另加股息。成交量使用供应商返回值。供应商历史数据修订或新增复权事件可能导致重跑结果变化；程序保存本次输入快照，便于复现。固定输入序列的历史信号不依赖后续K线。

费用默认买、卖各5 bps，滑点默认各5 bps；1 bps = 0.01%。按成交金额扣费，净收益含双边费用与滑点。实际券商收费需自行调整。买入持有基准从回测首日开盘买入，同样扣除买入费用与滑点；两条净值都在末日按收盘估值，不预扣未来平仓费用。最大回撤使用每日收盘净值，并将初始现金纳入高水位，不是盘中最大回撤。少于一年不报告年化收益。

未建模税费、现金利息、市场冲击、流动性、停牌或退市的成交限制。数据缺失或OHLC错误会报错；缺失交易日未自动补齐，需由数据使用者确认完整性。此版是规则研究工具，尚未做样本外验证，不等于已证明能盈利的策略。

## 一年期限与回撤减半诊断

沿用冻结输入及原全仓破低波段，不重新选择买卖参数：

```bash
dayk_strategy/.venv/bin/python dayk_strategy/one_year_analysis.py
dayk_strategy/.venv/bin/python dayk_strategy/drawdown_research.py
```

报告分别保存到 `reports/one_year/LITE_one_year_report.html` 和 `reports/drawdown/LITE_drawdown_report.html`。这两项诊断与早期报告不同，统一扣除期末剩余股票的卖出手续费及滑点。回撤仍是每日收盘账户净值的最大跌幅。

回撤诊断包含初始半仓保留现金、每日恢复50%/25%股票比例，以及以账户历史高点80%为参考线的动态风险缓冲仓位。同期持有最终回撤的一半只用于事后验收，不输入信号；回撤不做人工截断。最近一年（2025-09-18至2026-09-18）持有收益455.12%、最大回撤42.80%；动态风险缓冲乘数4收益117.53%、最大回撤19.49%，达到本段回撤减半但未达到利润1.5倍。全期、三个一年区间及两个成本压力案例中，没有测试方案同时达到两个目标。每日25%仓位与风险缓冲乘数2在这些案例均达到回撤门槛，收益明显下降；其他配置并非每段都通过。

初始半仓不等于持续半仓；盈利留在股票子账户会提高实际股票占比。每日调仓会增加成交和费用，小额再平衡不是完整波段。风险缓冲耗尽后可能长期持有现金，隔夜跳空也可能使20%预算失守。新增测试覆盖会计守恒、前缀因果性、初始分仓与回撤关系，以及跳空超预算不被隐藏。

## 输出

默认输出目录为 `dayk_strategy/reports/`，同代码重跑会覆盖该代码的报告；需保留多个版本时用 `--output` 指定不同目录。

| 文件 | 内容 |
| --- | --- |
| `LITE_report.html` | 可缩放、悬停查看的完整报告 |
| `LITE_input.csv` | 含预热期的复权行情快照 |
| `LITE_daily.csv` | 指标、信号、成交、持仓和每日净值 |
| `LITE_trades.csv` | 已完成交易、费用、盈亏与退出原因 |
| `LITE_summary.json` | 参数、指标、未平仓仓位、待执行信号、来源和生成时间 |

使用快照离线重跑（CSV中的OHLC必须均已完成分红与拆股复权，不能混用原始OHLC和Adjusted Close）：

```bash
dayk_strategy/.venv/bin/python dayk_strategy/strategy.py --ticker LITE --csv dayk_strategy/reports/LITE_input.csv --start 2023-01-01 --output dayk_strategy/reports/replay
```

CSV列为 `Date,Open,High,Low,Close,Volume`；需要包含首个回测日前足够的预热数据。工具不会自行猜测CSV的复权口径。

离线合成演示与测试：

```bash
dayk_strategy/.venv/bin/python dayk_strategy/strategy.py --demo --start 2023-01-01
dayk_strategy/.venv/bin/python -m unittest discover -s dayk_strategy -p 'test_*.py' -v
```

合成演示明确标注为 `DEMO`，不代表LITE或任何真实股票。测试覆盖下一日成交、跳空、双边费用、因果性、止损上移、待执行订单、未平仓计价及异常数据。
