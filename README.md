# 美股投研工作台

个人自用的本地美股投研、持仓收益与每日复盘软件。当前版本是第一阶段可运行基础版，重点建立可信的数据、交易和历史版本底座。

## 当前已实现

- 本地单用户 Web 界面；
- SQLite 数据库，无需安装数据库服务；
- 股票池添加、修改、删除、暂停和恢复；
- 买入、加仓、部分卖出及清仓交易流水；
- FIFO 批次和移动平均成本；
- 已实现、未实现、今日及累计盈亏；
- 免费优先的 Yahoo 日行情 Provider；
- 手动收盘价补录；
- 每日持仓快照；
- 综合可靠度评分和 85 分发布闸门；
- 应用内、macOS 桌面和 SMTP 邮件通知框架；
- OpenAI-compatible 云端 LLM 接口；
- 收盘后单股和股票池基础复盘；
- 定时行情更新和日终任务；
- SEC 股票代码/CIK 映射、10-K/10-Q/8-K 文件同步；
- SEC Company Facts 核心 US-GAAP 指标标准化；
- 年度、季度财务趋势和 SEC 原文追溯；
- 所有预测、可靠度、通知和复盘的版本化数据表。

## 尚未实现

以下模块已在数据结构和接口层预留，但还需要后续迭代：

- 行业 PE、动态 PE 和分析师一致预期；
- 竞争对手和国际风险暴露矩阵；
- 新闻、8-K 和实时风险事件流；
- 1、3、6 个月正式预测模型及历史回测；
- 预测新旧差异归因；
- 逐笔成交、期权、FINRA 卖空和 ATS 数据；
- 吸筹、派发和异常波动模型；
- 完整财报和事件复盘。

系统不会在这些模块完成严格历史验证前生成虚假的正式预测或机构资金结论。

## 系统要求

- macOS；
- Node.js 22.5 或更高版本；
- 当前开发机已安装 Node.js 25，可直接运行；
- 不需要 `npm install`，第一版只使用 Node 内置模块。

## 启动

```bash
cd /Users/claw/Documents/投研分析
cp .env.example .env
npm start
```

浏览器打开：

```text
http://127.0.0.1:3789
```

数据库默认保存在：

```text
data/research.sqlite
```

## 开发模式

```bash
npm run dev
```

修改服务端或前端文件后，Node 会自动重启服务。浏览器页面需要手动刷新。

## 停止和重启

```bash
npm stop
npm restart
```

服务启动成功后会在 `data/server.pid` 记录进程号。`npm stop` 只会停止由本项目记录的服务，不会按名称批量终止其他 Node 程序。

如果启动时提示端口 `3789` 已被其他程序占用，先运行 `npm stop`。如果仍然占用，可以在 `.env` 中修改：

```dotenv
APP_PORT=3790
```

## 测试

```bash
npm test
```

## 云端 LLM

复制 `.env.example` 为 `.env` 后配置：

```dotenv
LLM_ENABLED=true
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=你的密钥
LLM_MODEL=你选择的模型名称
```

软件使用 OpenAI-compatible `/chat/completions` 接口。密钥不会通过界面返回，也不应提交到版本管理。

## SEC EDGAR 联系信息

SEC 要求自动访问者通过 HTTP `User-Agent` 标识身份并提供真实联系邮箱。在项目根目录的 `.env` 中配置：

```dotenv
SEC_USER_AGENT=你的姓名 your-email@example.com
SEC_REQUESTS_PER_SECOND=5
```

例如：

```dotenv
SEC_USER_AGENT=Zhang San zhangsan@example.com
```

`SEC_USER_AGENT` 不是 SEC 账户或 API Key，只是请求身份标识。软件界面只显示是否已配置，不会回显姓名和邮箱。SEC Provider 会拒绝缺少有效联系邮箱的自动请求，并将请求速率限制在每秒 1–10 次范围内。

配置完成并重启软件后：

1. 将股票加入股票池；
2. 打开“财报分析”；
3. 选择股票并点击“同步 SEC 数据”；
4. 查看最新核心指标、年度/季度趋势以及 10-K、10-Q、8-K 原文。

当前标准化范围以 `us-gaap` 核心概念为主，包括营业收入、毛利润、营业利润、净利润、摊薄 EPS、经营现金流、资本开支、总资产、总负债、股东权益、现金及摊薄加权股数。公司自定义 XBRL 扩展标签和 IFRS 指标将在后续版本补充。

## macOS 桌面通知

默认启用：

```dotenv
MACOS_NOTIFICATIONS_ENABLED=true
```

第一次触发时，macOS 可能要求允许终端或 Node 发送通知。

## 邮件通知

当前内置 SMTP 客户端支持 TLS 直连，通常使用 465 端口：

```dotenv
EMAIL_NOTIFICATIONS_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USERNAME=用户名
SMTP_PASSWORD=应用专用密码
EMAIL_FROM=发件地址
EMAIL_TO=收件地址
```

建议使用邮件服务提供的应用专用密码，不要使用账户主密码。

## 行情数据说明

默认 Provider 使用无需 API Key 的 Yahoo Chart 接口，适合作为个人测试和早期日终数据源，但不保证长期稳定、完整或实时。系统同时支持手动补录，并已将业务逻辑与 Provider 解耦，后续可以更换为正式行情供应商。

## 日终任务

默认按美东时间 18:15 检查并执行日终任务，包含：

1. 更新启用股票行情；
2. 同步启用股票的 SEC 申报与核心财务事实；
3. 计算并保存每日持仓收益；
4. 生成基础单股复盘；
5. 生成股票池总复盘；
6. 发送完成通知。

如果 `SEC_USER_AGENT` 尚未配置，日终任务会跳过 SEC 同步而不会阻断行情、收益和复盘流程。单只股票同步失败也只记录该股票错误，不会终止整个股票池任务。

也可以在界面点击“执行日终任务”手动运行。

## 产品需求

完整需求见 [美股投研分析软件产品需求文档.md](./美股投研分析软件产品需求文档.md)。
