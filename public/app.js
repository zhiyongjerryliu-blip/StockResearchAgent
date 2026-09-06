const state = {
  watchlist: [], portfolio: null, portfolioRisk: null, transactions: [], notifications: [], reviews: [], config: null,
  eventFeed: { events: [], counts: {}, total: 0 },
  newsArticles: [], newsSentiment: null, externalDrivers: null, investmentAdvice: null,
  capitalFlow: null, intradayFlow: null, capitalBehavior: null, capitalLoadedTicker: null,
  predictionOverview: null, predictionLoadedTicker: null,
  capitalChartVisible: new Set(['volume', 'averageVolume5d', 'averageVolume20d', 'netActiveTurnover']),
  editingWatchlistTicker: null, secOverview: null, secLoadedTicker: null,
  valuationOverview: null, valuationLoadedTicker: null,
  valuationPeerSelection: null,
  currentMonthPerformance: null, monthlyDetail: null, monthlyTickerFilter: null,
  transactionImportToken: null, systemStatus: null, dailyOperations: null
};

const THEME_STORAGE_KEY = 'stockresearchagent.theme';
const THEME_VALUES = new Set(['system', 'light', 'dark']);

function applyTheme(theme, persist = false) {
  const selected = THEME_VALUES.has(theme) ? theme : 'system';
  document.documentElement.dataset.theme = selected;
  const selector = document.querySelector('#theme-select');
  if (selector) selector.value = selected;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, selected);
    } catch {
      // 隐私模式或浏览器禁用本地存储时，当前会话内仍可正常切换主题。
    }
  }
  return selected;
}

const titles = {
  dashboard: '投资组合总览', watchlist: '股票池管理', transactions: '交易与持仓',
  financials: '财报分析', valuation: '估值与竞争对手', predictions: '多周期预测与历史验证',
  capital: '资金与成交量', events: '事件与风险',
  reviews: '收盘复盘', settings: '系统状态'
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function money(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function percent(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

function pnlClass(value) {
  if (value == null || value === 0) return '';
  return value > 0 ? 'positive' : 'negative';
}

function currentEtMonth() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

function currentEtDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

let toastTimer;
function showToast(message, error = false) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

function showView(view) {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${view}`));
  document.querySelector('#page-title').textContent = titles[view];
  if (view === 'financials') loadSelectedSecOverview().catch((error) => showToast(error.message, true));
  if (view === 'valuation') loadSelectedValuation().catch((error) => showToast(error.message, true));
  if (view === 'predictions') loadPredictionOverview().catch((error) => showToast(error.message, true));
  if (view === 'capital') loadCapitalFlow().catch((error) => showToast(error.message, true));
  if (view === 'events') loadEventCenter().catch((error) => showToast(error.message, true));
  if (view === 'settings') loadSystemStatus().catch((error) => showToast(error.message, true));
}

function renderWatchlist() {
  const body = document.querySelector('#watchlist-body');
  body.innerHTML = state.watchlist.map((item) => `
    <tr>
      <td class="ticker">${escapeHtml(item.ticker)}</td>
      <td>${escapeHtml(item.name || '—')}</td>
      <td>${escapeHtml(item.sector || '—')}</td>
      <td>${escapeHtml(item.industry || '—')}</td>
      <td>${escapeHtml(item.benchmark)}</td>
      <td>${escapeHtml(item.industry_etf || '—')}</td>
      <td>${escapeHtml(item.note || '—')}</td>
      <td><button class="badge ${item.enabled ? 'buy' : ''}" data-toggle-ticker="${item.ticker}" data-enabled="${item.enabled}">${item.enabled ? '监控中' : '已暂停'}</button></td>
      <td><div class="row-actions">
        <button class="edit-link" data-edit-watchlist="${item.ticker}">修改</button>
        <button class="danger-link" data-delete-watchlist="${item.ticker}">删除</button>
      </div></td>
    </tr>`).join('');
  document.querySelector('#watchlist-empty').classList.toggle('hidden', state.watchlist.length > 0);

  const options = state.watchlist.filter((item) => item.enabled).map((item) => `<option value="${item.ticker}">${item.ticker}${item.name ? ` · ${escapeHtml(item.name)}` : ''}</option>`).join('');
  for (const id of ['#trade-ticker', '#price-ticker']) document.querySelector(id).innerHTML = options || '<option value="">请先添加股票</option>';

  const secSelect = document.querySelector('#sec-ticker');
  const selectedTicker = secSelect.value || state.secLoadedTicker;
  const secOptions = state.watchlist.map((item) => `<option value="${item.ticker}">${item.ticker}${item.name ? ` · ${escapeHtml(item.name)}` : ''}</option>`).join('');
  secSelect.innerHTML = secOptions || '<option value="">请先添加股票</option>';
  if (selectedTicker && state.watchlist.some((item) => item.ticker === selectedTicker)) secSelect.value = selectedTicker;

  const valuationSelect = document.querySelector('#valuation-ticker');
  const selectedValuationTicker = valuationSelect.value || state.valuationLoadedTicker;
  valuationSelect.innerHTML = secOptions || '<option value="">请先添加股票</option>';
  if (selectedValuationTicker && state.watchlist.some((item) => item.ticker === selectedValuationTicker)) {
    valuationSelect.value = selectedValuationTicker;
  }

  const eventSelect = document.querySelector('#event-ticker');
  const selectedEventTicker = eventSelect.value;
  eventSelect.innerHTML = `<option value="">全部股票</option>${secOptions}`;
  if (selectedEventTicker && state.watchlist.some((item) => item.ticker === selectedEventTicker)) {
    eventSelect.value = selectedEventTicker;
  }

  const capitalSelect = document.querySelector('#capital-ticker');
  const selectedCapitalTicker = capitalSelect.value || state.capitalLoadedTicker || state.watchlist.find((item) => item.enabled)?.ticker;
  capitalSelect.innerHTML = `<option value="">请选择股票</option>${options}`;
  if (selectedCapitalTicker && state.watchlist.some((item) => item.ticker === selectedCapitalTicker && item.enabled)) {
    capitalSelect.value = selectedCapitalTicker;
  }

  const predictionSelect = document.querySelector('#prediction-ticker');
  const selectedPredictionTicker = predictionSelect.value || state.predictionLoadedTicker || state.watchlist.find((item) => item.enabled)?.ticker;
  predictionSelect.innerHTML = `<option value="">请选择股票</option>${options}`;
  if (selectedPredictionTicker && state.watchlist.some((item) => item.ticker === selectedPredictionTicker && item.enabled)) {
    predictionSelect.value = selectedPredictionTicker;
  }
}

function secValue(fact) {
  if (!fact || !Number.isFinite(Number(fact.value))) return '—';
  const value = Number(fact.value);
  if (fact.unit === 'USD/shares') {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 3 }).format(value);
  }
  if (fact.unit === 'USD') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2
    }).format(value);
  }
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function secPeriodLabel(fact) {
  if (!fact) return '尚无数据';
  const period = [fact.form, fact.periodEnd].filter(Boolean).join(' · ');
  return period || '报告期未知';
}

function secMetricCell(period, metricKey) {
  return secValue(period.metrics?.[metricKey]);
}

function renderSecOverview(overview) {
  state.secOverview = overview;
  state.secLoadedTicker = overview?.company?.ticker || null;
  const latestMap = [
    ['revenue', '#sec-revenue', '#sec-revenue-period'],
    ['grossProfit', '#sec-gross-profit', '#sec-gross-profit-period'],
    ['operatingIncome', '#sec-operating-income', '#sec-operating-income-period'],
    ['netIncome', '#sec-net-income', '#sec-net-income-period'],
    ['epsDiluted', '#sec-eps-diluted', '#sec-eps-diluted-period'],
    ['cash', '#sec-cash', '#sec-cash-period']
  ];
  for (const [key, valueSelector, periodSelector] of latestMap) {
    const fact = overview?.latest?.[key] || null;
    document.querySelector(valueSelector).textContent = secValue(fact);
    document.querySelector(periodSelector).textContent = secPeriodLabel(fact);
  }

  const status = overview?.status;
  const statusParts = [];
  if (overview?.company?.cik) statusParts.push(`CIK ${overview.company.cik}`);
  if (status?.last_synced_at) statusParts.push(`同步于 ${new Date(status.last_synced_at).toLocaleString('zh-CN')}`);
  if (status) statusParts.push(`${status.filings_count}份文件 · ${status.facts_count}条核心事实`);
  if (status?.last_error) statusParts.push(`最近错误：${status.last_error}`);
  document.querySelector('#sec-sync-status').textContent = statusParts.join(' · ') || '尚未同步 SEC 数据。';

  const annual = overview?.annual || [];
  const quarterly = overview?.quarterly || [];
  const filings = overview?.filings || [];
  document.querySelector('#sec-annual-body').innerHTML = annual.map((period) => `
    <tr>
      <td><strong>${escapeHtml(period.periodEnd)}</strong><br><small class="muted">${escapeHtml(period.form || '')}</small></td>
      <td>${secMetricCell(period, 'revenue')}</td><td>${secMetricCell(period, 'grossProfit')}</td>
      <td>${secMetricCell(period, 'operatingIncome')}</td><td>${secMetricCell(period, 'netIncome')}</td>
      <td>${secMetricCell(period, 'epsDiluted')}</td><td>${secMetricCell(period, 'operatingCashFlow')}</td>
      <td>${secMetricCell(period, 'assets')}</td><td>${secMetricCell(period, 'liabilities')}</td>
      <td>${secMetricCell(period, 'equity')}</td>
    </tr>`).join('');
  document.querySelector('#sec-quarterly-body').innerHTML = quarterly.map((period) => `
    <tr>
      <td><strong>${escapeHtml(period.periodEnd)}</strong><br><small class="muted">${escapeHtml(period.form || '')}</small></td>
      <td>${secMetricCell(period, 'revenue')}</td><td>${secMetricCell(period, 'grossProfit')}</td>
      <td>${secMetricCell(period, 'operatingIncome')}</td><td>${secMetricCell(period, 'netIncome')}</td>
      <td>${secMetricCell(period, 'epsDiluted')}</td>
    </tr>`).join('');
  document.querySelector('#sec-filings-body').innerHTML = filings.map((filing) => `
    <tr>
      <td><span class="badge ${filing.form.startsWith('8-K') ? 'P2' : 'buy'}">${escapeHtml(filing.form)}</span></td>
      <td>${escapeHtml(filing.report_date || '—')}</td>
      <td>${escapeHtml(filing.filed_at)}</td>
      <td>${escapeHtml(filing.items || filing.primary_doc_description || '—')}</td>
      <td><a class="sec-link" href="${escapeHtml(filing.filing_url)}" target="_blank" rel="noreferrer">查看原文 ↗</a></td>
    </tr>`).join('');

  const hasData = annual.length > 0 || quarterly.length > 0 || filings.length > 0;
  document.querySelector('#sec-empty').classList.toggle('hidden', hasData);
  document.querySelector('#sec-content').classList.toggle('hidden', !hasData);
}

async function loadSelectedSecOverview(force = false) {
  const ticker = document.querySelector('#sec-ticker').value;
  if (!ticker) {
    renderSecOverview(null);
    return;
  }
  if (!force && state.secLoadedTicker === ticker && state.secOverview) return;
  const overview = await api(`/api/sec/overview?ticker=${encodeURIComponent(ticker)}`);
  renderSecOverview(overview);
}

function multiple(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(2)}×`;
}

function decimal(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits);
}

function ratioPercent(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${value >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(2)}%`;
}

function estimateRevisionCell(revision) {
  if (!revision) return '—';
  const activity = revision.revisionsUp || revision.revisionsDown
    ? `<br><small class="muted">上调${revision.revisionsUp} / 下调${revision.revisionsDown}</small>`
    : '';
  return `<span class="${pnlClass(revision.change)}">${ratioPercent(revision.changePct)}</span>${activity}`;
}

function valuationCompanyRow(company, isTarget = false) {
  const issues = company.issues.length ? company.issues.join('；') : '数据完整';
  return `<tr class="${isTarget ? 'valuation-target-row' : ''}">
    <td><span class="ticker">${escapeHtml(company.ticker)}</span>${isTarget ? '<span class="badge target-badge">目标</span>' : ''}<br><small class="muted">${escapeHtml(company.name || '')}</small></td>
    <td>${money(company.price)}<br><small class="muted">${escapeHtml(company.priceDate || '')}</small></td>
    <td>${decimal(company.ttmEps, 4)}</td><td>${multiple(company.staticPe)}</td>
    <td>${decimal(company.forwardEps, 4)}</td><td>${multiple(company.forwardPe)}</td>
    <td>${ratioPercent(company.revenueGrowth)}</td><td>${ratioPercent(company.grossMargin)}</td>
    <td class="valuation-issue-cell ${company.issues.length ? 'has-issues' : ''}">${escapeHtml(issues)}</td>
  </tr>`;
}

function valuationHistoryStatus(distribution) {
  if (distribution?.qualityStatus === 'complete') return '样本充足';
  if (distribution?.qualityStatus === 'limited_history') return '历史较短';
  return `样本不足（至少${distribution?.minimumSamples || '—'}）`;
}

function valuationHistoryRow(label, distribution) {
  return `<tr>
    <td><strong>${escapeHtml(label)}</strong></td>
    <td>${multiple(distribution?.current)}</td>
    <td>${multiple(distribution?.p10)}</td>
    <td>${multiple(distribution?.median)}</td>
    <td>${multiple(distribution?.p90)}</td>
    <td>${distribution?.sampleCount || 0}</td>
    <td>${distribution?.from && distribution?.to ? `${escapeHtml(distribution.from)} 至 ${escapeHtml(distribution.to)}` : '—'}</td>
    <td><span class="badge ${distribution?.qualityStatus === 'complete' ? 'buy' : 'P2'}">${escapeHtml(valuationHistoryStatus(distribution))}</span></td>
  </tr>`;
}

function renderValuationHistory(history) {
  const staticPe = history?.staticPe;
  const forwardPe = history?.forwardPe;
  const staticElement = document.querySelector('#valuation-static-percentile');
  const forwardElement = document.querySelector('#valuation-forward-percentile');
  staticElement.textContent = staticPe?.percentile == null ? '—' : `${staticPe.percentile.toFixed(2)}%`;
  forwardElement.textContent = forwardPe?.percentile == null ? '—' : `${forwardPe.percentile.toFixed(2)}%`;
  document.querySelector('#valuation-static-percentile-note').textContent = staticPe?.percentile != null
    ? `${staticPe.label} · ${staticPe.sampleCount}个日线样本`
    : staticPe?.current == null && staticPe?.sampleCount >= staticPe?.minimumSamples
      ? '当前静态PE不可计算，暂不发布分位'
      : `仅${staticPe?.sampleCount || 0}个样本，至少需要${staticPe?.minimumSamples || 60}个`;
  document.querySelector('#valuation-forward-percentile-note').textContent = forwardPe?.percentile != null
    ? `${forwardPe.label} · ${forwardPe.sampleCount}个历史快照`
    : `仅${forwardPe?.sampleCount || 0}个预期快照，至少需要${forwardPe?.minimumSamples || 20}个`;
  document.querySelector('#valuation-history-range').textContent = history?.startDate
    ? `观察窗口：近${history.lookbackYears}年，自 ${history.startDate}`
    : '等待历史行情';
  document.querySelector('#valuation-history-body').innerHTML = [
    valuationHistoryRow('静态 PE', staticPe),
    valuationHistoryRow('动态 PE', forwardPe)
  ].join('');
  document.querySelector('#valuation-history-methodology').textContent = history?.methodology || '';
}

function renderValuation(overview) {
  state.valuationOverview = overview;
  state.valuationLoadedTicker = overview?.target?.ticker || null;
  const target = overview?.target;
  const median = overview?.peerMedian;
  const relative = overview?.relativeToPeers;
  const revision30 = target?.estimate?.revision?.thirtyDay;
  document.querySelector('#valuation-price').textContent = money(target?.price);
  document.querySelector('#valuation-price-note').textContent = target?.priceDate
    ? `${target.priceDate} · ${target.priceProvider}` : '尚无行情';
  document.querySelector('#valuation-ttm-eps').textContent = decimal(target?.ttmEps, 4);
  document.querySelector('#valuation-ttm-note').textContent = target?.ttmLabel || '等待完整SEC财务数据';
  document.querySelector('#valuation-static-pe').textContent = multiple(target?.staticPe);
  document.querySelector('#valuation-forward-eps').textContent = decimal(target?.forwardEps, 4);
  document.querySelector('#valuation-forward-note').textContent = target?.estimate
    ? `${target.estimate.asOf} · ${target.estimate.source}${target.estimate.analystCount ? ` · 至少${target.estimate.analystCount}位分析师` : ''}`
    : '尚未取得可靠预期';
  document.querySelector('#valuation-forward-pe').textContent = multiple(target?.forwardPe);
  document.querySelector('#valuation-peer-pe').textContent = multiple(median?.staticPe);
  document.querySelector('#valuation-peer-note').textContent = median?.staticPeSamples
    ? `${median.staticPeSamples}个有效同业样本` : '尚无有效同业样本';
  document.querySelector('#valuation-peer-forward-pe').textContent = multiple(median?.forwardPe);
  document.querySelector('#valuation-peer-forward-note').textContent = median?.forwardPeSamples
    ? `${median.forwardPeSamples}个有效同业样本` : '尚无有效同业样本';
  document.querySelector('#valuation-forward-premium').textContent = ratioPercent(relative?.forwardPePremium);
  document.querySelector('#valuation-forward-premium-note').textContent = relative?.forwardPeLabel
    ? `${relative.forwardPeLabel}${relative.forwardQualityStatus === 'limited_samples' ? ' · 样本不足2家' : ''}`
    : '等待目标公司与同业动态PE';
  const revisionElement = document.querySelector('#valuation-eps-revision');
  revisionElement.textContent = ratioPercent(revision30?.changePct);
  revisionElement.className = pnlClass(revision30?.change);
  document.querySelector('#valuation-eps-revision-note').textContent = revision30?.previousEps != null
    ? `前值 ${decimal(revision30.previousEps, 4)} → ${decimal(target?.forwardEps, 4)} · 上调${revision30.revisionsUp}/下调${revision30.revisionsDown}`
    : '当前数据源未提供完整30日可比值';
  renderValuationHistory(overview?.historicalValuation);
  document.querySelector('#valuation-status').textContent = target
    ? `${target.ticker}${target.industry ? ` · ${target.industry}` : ''}；所有缺失值均不参与PE和同业中位数计算。`
    : '请选择股票。';

  const issuesPanel = document.querySelector('#valuation-issues');
  issuesPanel.innerHTML = target?.issues?.length
    ? `<strong>当前估值暂缺项目</strong><ul>${target.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`
    : '';
  issuesPanel.classList.toggle('hidden', !target?.issues?.length);

  const peers = overview?.peers || [];
  document.querySelector('#valuation-peer-body').innerHTML = target
    ? [valuationCompanyRow(target, true), ...peers.map((peer) => valuationCompanyRow(peer))].join('') : '';
  document.querySelector('#valuation-peer-empty').classList.toggle('hidden', peers.length > 0);

  const selection = state.valuationPeerSelection;
  const selectionElement = document.querySelector('#valuation-peer-selection');
  if (selection?.matched) {
    const peerNames = selection.peers.map((peer) => `${peer.ticker}（${peer.name}）`).join('、');
    selectionElement.innerHTML = `<strong>${escapeHtml(selection.industry)}</strong><p>自动选取：${escapeHtml(peerNames)}</p><p>匹配方式：${escapeHtml(selection.method)} · 规则版本：${escapeHtml(selection.source)}</p>${selection.sourceUrl ? `<a class="sec-link" href="${escapeHtml(selection.sourceUrl)}" target="_blank" rel="noreferrer">查看行业依据 ↗</a>` : ''}`;
  } else {
    selectionElement.innerHTML = `<p>${escapeHtml(selection?.reason || '尚未完成行业匹配')}</p>`;
  }

  const estimates = overview?.estimates || [];
  document.querySelector('#valuation-estimate-body').innerHTML = estimates.map((estimate) => `<tr>
    <td>${escapeHtml(estimate.as_of)}</td><td>${escapeHtml(estimate.period_end || '—')}</td>
    <td>${decimal(estimate.eps_value, 4)}</td>
    <td>${estimateRevisionCell(estimate.revision?.sevenDay)}</td>
    <td>${estimateRevisionCell(estimate.revision?.thirtyDay)}</td>
    <td>${estimate.source_url ? `<a class="sec-link" href="${escapeHtml(estimate.source_url)}" target="_blank" rel="noreferrer">${escapeHtml(estimate.source)} ↗</a>` : escapeHtml(estimate.source)}${estimate.analyst_count ? `<br><small class="muted">至少${estimate.analyst_count}位分析师</small>` : ''}</td>
    <td>${escapeHtml(estimate.note || estimate.calculation_method || '—')}</td>
    <td><button class="danger-link" data-delete-estimate="${estimate.id}">删除</button></td>
  </tr>`).join('');
  document.querySelector('#valuation-estimate-empty').classList.toggle('hidden', estimates.length > 0);
  const methodology = overview?.methodology || {};
  document.querySelector('#valuation-methodology').innerHTML = Object.values(methodology)
    .map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

async function loadSelectedValuation(force = false) {
  const ticker = document.querySelector('#valuation-ticker').value;
  if (!ticker) {
    state.valuationOverview = null;
    state.valuationLoadedTicker = null;
    return;
  }
  if (!force && state.valuationLoadedTicker === ticker && state.valuationOverview) return;
  state.valuationPeerSelection = await api('/api/valuation/peers/auto', {
    method: 'POST', body: JSON.stringify({ ticker })
  });
  const years = document.querySelector('#valuation-history-years').value || '5';
  renderValuation(await api(`/api/valuation/overview?ticker=${encodeURIComponent(ticker)}&years=${encodeURIComponent(years)}`));
}

function renderPortfolio() {
  const portfolio = state.portfolio || { positions: [], totals: {} };
  const monthly = state.currentMonthPerformance;
  const metricMap = [
    ['#metric-value', portfolio.totals.marketValue, false],
    ['#metric-daily', portfolio.totals.dailyPnl, true],
    ['#metric-monthly', monthly?.totalPnl, true],
    ['#metric-unrealized', portfolio.totals.unrealizedPnl, true],
    ['#metric-total', portfolio.totals.totalPnl, true]
  ];
  for (const [selector, value, isPnl] of metricMap) {
    const element = document.querySelector(selector);
    element.textContent = money(value);
    element.className = isPnl ? pnlClass(value) : '';
  }
  const monthlyNote = document.querySelector('#metric-monthly-note');
  monthlyNote.textContent = monthly?.incompleteDays
    ? `${monthly.incompleteDays}个交易日数据不完整 · 点击查看`
    : '点击查看每日明细 →';
  const held = portfolio.positions.filter((position) => position.quantity > 0);
  document.querySelector('#positions-body').innerHTML = held.map((position) => `
    <tr>
      <td><span class="ticker">${position.ticker}</span><br><small class="muted">${escapeHtml(position.name || '')}</small></td>
      <td>${position.quantity}</td><td>${money(position.averageCost)}</td><td>${money(position.currentPrice)}</td>
      <td class="${pnlClass(position.dailyPnl)}">${money(position.dailyPnl)}</td>
      <td>${monthlyPnlButton(position.ticker)}</td>
      <td class="${pnlClass(position.totalPnl)}">${money(position.totalPnl)}</td>
      <td class="${pnlClass(position.totalReturn)}">${percent(position.totalReturn)}</td>
    </tr>`).join('');
  document.querySelector('#positions-empty').classList.toggle('hidden', held.length > 0);
  document.querySelector('#last-updated').textContent = `更新于 ${new Date(portfolio.asOf || Date.now()).toLocaleString('zh-CN')}`;
}

function renderPortfolioRisk() {
  const risk = state.portfolioRisk;
  const content = document.querySelector('#portfolio-risk-content');
  const empty = document.querySelector('#portfolio-risk-empty');
  if (!risk?.positionCount) {
    content.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const levelLabel = { HIGH: '高风险', MEDIUM: '中风险', LOW: '低风险' }[risk.riskLevel] || risk.riskLevel;
  const sectors = (risk.sectors || []).map((item) => `
    <span>${escapeHtml(item.sector)} <strong>${percent(item.weight)}</strong></span>`).join('');
  const positions = (risk.positions || []).map((position) => `
    <tr>
      <td><span class="ticker">${escapeHtml(position.ticker)}</span><br><small class="muted">${escapeHtml(position.sector)}</small></td>
      <td>${percent(position.weight)}</td><td>${money(position.marketValue)}</td>
      <td class="${pnlClass(position.totalReturn)}">${percent(position.totalReturn)}</td>
      <td><span class="badge ${position.recommendation.severity}">${escapeHtml(position.recommendation.label)}</span></td>
      <td class="portfolio-risk-reason">${escapeHtml(position.recommendation.reason)}</td>
    </tr>`).join('');
  content.innerHTML = `
    <div class="portfolio-risk-summary ${escapeHtml(risk.riskLevel)}">
      <article><span>组合风险评分</span><strong>${decimal(risk.riskScore, 1)}分</strong><small>${escapeHtml(levelLabel)}</small></article>
      <article><span>最大单股权重</span><strong>${percent(risk.largestPositionWeight)}</strong><small>35%以上触发集中度复核</small></article>
      <article><span>最大行业权重</span><strong>${percent(risk.largestSectorWeight)}</strong><small>${sectors || '行业尚未分类'}</small></article>
      <article><span>年化波动率</span><strong>${percent(risk.annualizedVolatility)}</strong><small>最近约90个交易日</small></article>
      <article><span>平均持仓相关性</span><strong>${decimal(risk.averageCorrelation, 2)}</strong><small>${(risk.correlations || []).length}组可比持仓</small></article>
      <article><span>已记录最大回撤</span><strong class="${pnlClass(risk.drawdown?.maximumDrawdown)}">${percent(risk.drawdown?.maximumDrawdown)}</strong><small>${risk.drawdown?.sampleDays || 0}个持仓快照日</small></article>
    </div>
    <div class="table-wrap portfolio-risk-table-wrap">
      <table class="portfolio-risk-table"><thead><tr><th>股票</th><th>组合权重</th><th>市值</th><th>累计收益</th><th>复核建议</th><th>触发原因</th></tr></thead><tbody>${positions}</tbody></table>
    </div>
    <p class="driver-disclaimer">${escapeHtml((risk.boundaries || []).join(' '))}</p>`;
}

function summarizeMonthlyPerformance(performance, ticker = null) {
  if (!performance) return null;
  if (!ticker) return performance;
  const days = performance.days.map((day) => {
    const positions = day.positions.filter((position) => position.ticker === ticker);
    if (!positions.length) return null;
    const complete = positions.every((position) => position.status === 'COMPLETE');
    const knownPnl = positions.reduce((sum, position) => sum + (position.pnl ?? 0), 0);
    return {
      date: day.date,
      positions,
      pnl: complete ? knownPnl : null,
      knownPnl,
      status: complete ? 'COMPLETE' : 'INCOMPLETE'
    };
  }).filter(Boolean);
  const incompleteDays = days.filter((day) => day.status !== 'COMPLETE').length;
  const knownPnl = days.reduce((sum, day) => sum + day.knownPnl, 0);
  return {
    ...performance,
    firstDisplayedDate: days[0]?.date || null,
    lastDisplayedDate: days.at(-1)?.date || null,
    totalPnl: incompleteDays ? null : knownPnl,
    knownPnl,
    incompleteDays,
    days
  };
}

function monthlyPnlButton(ticker) {
  const performance = summarizeMonthlyPerformance(state.currentMonthPerformance, ticker);
  const value = performance?.totalPnl;
  return `<button type="button" class="pnl-detail-button ${pnlClass(value)}" data-monthly-ticker="${escapeHtml(ticker)}" title="查看${escapeHtml(ticker)}月度盈亏明细">${money(value)}</button>`;
}

function renderMonthlyDetail() {
  const ticker = state.monthlyTickerFilter;
  const performance = summarizeMonthlyPerformance(state.monthlyDetail, ticker);
  if (!performance) return;
  document.querySelector('#monthly-modal-title').textContent = ticker ? `${ticker} 月度盈亏明细` : '月度盈亏明细';
  document.querySelector('#monthly-picker').value = performance.month;
  const total = document.querySelector('#monthly-detail-total');
  total.textContent = money(performance.totalPnl);
  total.className = pnlClass(performance.totalPnl);
  document.querySelector('#monthly-detail-note').textContent = performance.incompleteDays
    ? `有 ${performance.incompleteDays} 个持仓交易日缺少必要行情，当月合计暂不发布；表中仍展示可确认的数据。`
    : performance.days.length
      ? `仅展示持仓有效区间：${performance.firstDisplayedDate} 至 ${performance.lastDisplayedDate}。建仓前及完全清仓后的日期不会展示。`
      : '本月没有处于持仓区间的交易日。';

  document.querySelector('#monthly-detail-body').innerHTML = [...performance.days].reverse().map((day) => {
    const tickers = day.positions.map((position) => `<span class="monthly-ticker">${escapeHtml(position.ticker)}</span>`).join('');
    const quantities = day.positions.map((position) =>
      `<span>${escapeHtml(position.ticker)} ${position.beginningQuantity} → ${position.endingQuantity}</span>`
    ).join('');
    return `<tr>
      <td><strong>${escapeHtml(day.date)}</strong></td>
      <td><div class="monthly-tickers">${tickers}</div></td>
      <td><div class="monthly-quantities">${quantities}</div></td>
      <td class="${pnlClass(day.pnl)}">${money(day.pnl)}</td>
      <td><span class="badge ${day.status === 'COMPLETE' ? 'buy' : 'P2'}">${day.status === 'COMPLETE' ? '完整' : '缺少行情'}</span></td>
    </tr>`;
  }).join('');
  document.querySelector('#monthly-detail-empty').classList.toggle('hidden', performance.days.length > 0);
}

async function loadMonthlyDetail(month) {
  state.monthlyDetail = await api(`/api/performance/monthly?month=${encodeURIComponent(month)}`);
  renderMonthlyDetail();
}

function openMonthlyDetail(ticker = null) {
  state.monthlyTickerFilter = ticker;
  state.monthlyDetail = state.currentMonthPerformance;
  renderMonthlyDetail();
  document.querySelector('#monthly-modal').classList.remove('hidden');
  document.querySelector('#monthly-picker').focus();
}

function closeMonthlyDetail() {
  document.querySelector('#monthly-modal').classList.add('hidden');
  state.monthlyTickerFilter = null;
}

function renderTransactions() {
  document.querySelector('#transactions-body').innerHTML = state.transactions.map((tx) => `
    <tr>
      <td>${escapeHtml(String(tx.trade_time).slice(0, 10))}</td><td class="ticker">${tx.ticker}</td>
      <td><span class="badge ${tx.side === 'BUY' ? 'buy' : 'sell'}">${tx.side === 'BUY' ? '买入' : '卖出'}</span></td>
      <td>${tx.quantity}</td><td>${money(tx.price)}</td><td>${money(tx.fee)}</td>
      <td><button class="danger-link" data-delete-transaction="${tx.id}">删除</button></td>
    </tr>`).join('');
  document.querySelector('#transactions-empty').classList.toggle('hidden', state.transactions.length > 0);
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取交易文件'));
    reader.readAsDataURL(file);
  });
}

function renderTransactionImportResult(result, fileName) {
  state.transactionImportToken = result.valid ? result.token : null;
  const panel = document.querySelector('#transaction-import-result');
  panel.classList.remove('hidden');
  const summary = document.querySelector('#transaction-import-summary');
  summary.className = result.valid ? 'import-valid' : 'import-invalid';
  summary.textContent = result.valid
    ? `${fileName} 预检通过，共 ${result.rowCount} 笔交易。`
    : `${fileName} 未通过预检，共发现 ${result.errors.length} 个问题。`;
  document.querySelector('#transaction-import-added').textContent = result.addedStocks.length
    ? `确认导入时将自动加入股票池：${result.addedStocks.map((stock) => `${stock.ticker}（${stock.name}）`).join('、')}`
    : '文件中的股票均已在股票池中。';
  document.querySelector('#transaction-import-errors').innerHTML = result.errors.map((error) =>
    `<li>${error.rowNumber ? `第${error.rowNumber}行：` : ''}${escapeHtml(error.message)}</li>`
  ).join('');
  const previewRows = result.rows.slice(0, 100);
  document.querySelector('#transaction-import-preview-body').innerHTML = previewRows.map((row) => `
    <tr>
      <td>${row.rowNumber}</td><td>${escapeHtml(row.tradeDate)}</td><td class="ticker">${escapeHtml(row.ticker)}</td>
      <td><span class="badge ${row.side === 'BUY' ? 'buy' : 'sell'}">${row.side === 'BUY' ? '买入' : '卖出'}</span></td>
      <td>${row.quantity}</td><td>${money(row.price)}</td><td>${money(row.fee)}</td>
    </tr>`).join('');
  document.querySelector('#transaction-import-preview-wrap').classList.toggle('hidden', previewRows.length === 0);
  document.querySelector('#commit-transaction-import').classList.toggle('hidden', !result.valid);
}

function resetTransactionImport() {
  state.transactionImportToken = null;
  document.querySelector('#transaction-import-form').reset();
  document.querySelector('#transaction-import-result').classList.add('hidden');
}

function renderNotifications() {
  const recent = state.notifications.slice(0, 8);
  document.querySelector('#notification-list').innerHTML = recent.map((notice) => `
    <article class="notification ${notice.severity}">
      <div class="notification-head"><strong>${escapeHtml(notice.title)}</strong><time>${new Date(notice.created_at).toLocaleString('zh-CN')}</time></div>
      <p>${escapeHtml(notice.body)}</p>
    </article>`).join('');
  document.querySelector('#notifications-empty').classList.toggle('hidden', recent.length > 0);
}

function renderEvents() {
  const feed = state.eventFeed || { events: [], counts: {}, total: 0 };
  for (const severity of ['P0', 'P1', 'P2', 'P3']) {
    document.querySelector(`#event-count-${severity.toLowerCase()}`).textContent = feed.counts?.[severity] || 0;
  }
  document.querySelector('#event-list').innerHTML = feed.events.map((event) => {
    const evidence = event.evidence?.[0] || {};
    const isNewsRisk = event.source_type === 'NEWS_RISK';
    const isNewsImpact = event.source_type === 'NEWS_IMPACT';
    const isNews = isNewsRisk || isNewsImpact;
    const items = isNews
      ? `待核实新闻 · ${escapeHtml(evidence.source || '未知来源')}`
      : ((evidence.items || []).map((item) => `Item ${item.item}`).join('、') || '未标注Item');
    const sourceDetail = isNews
      ? `相关性 ${evidence.relevanceScore == null ? '—' : Number(evidence.relevanceScore).toFixed(2)} · 情绪 ${evidence.sentimentScore == null ? '—' : Number(evidence.sentimentScore).toFixed(2)}`
      : `Accession ${escapeHtml(event.source_id)}`;
    return `<article class="event-card ${escapeHtml(event.severity)}">
      <div class="event-card-head">
        <div class="event-title-line"><span class="badge ${escapeHtml(event.severity)}">${escapeHtml(event.severity)}</span>${isNewsImpact ? '<span class="badge impact">外部驱动</span>' : (isNewsRisk ? '<span class="badge source-news">待核实新闻</span>' : '<span class="badge source-sec">SEC官方</span>')}<strong>${escapeHtml(event.title)}</strong></div>
        <time>${escapeHtml(event.event_date)}</time>
      </div>
      <p>${escapeHtml(event.summary)}</p>
      <div class="event-meta">
        <span>${escapeHtml(event.ticker)}${event.name ? ` · ${escapeHtml(event.name)}` : ''}</span>
        <span>${items}</span>
        <span>${sourceDetail}</span>
        ${event.source_url ? `<a class="sec-link" href="${escapeHtml(event.source_url)}" target="_blank" rel="noreferrer">${isNews ? '查看新闻原文' : '查看 SEC 原文'} ↗</a>` : ''}
      </div>
    </article>`;
  }).join('');
  document.querySelector('#events-empty').classList.toggle('hidden', feed.events.length > 0);
  const ticker = document.querySelector('#event-ticker').value;
  const severity = document.querySelector('#event-severity').value;
  document.querySelector('#event-status').textContent = `${ticker || '全部股票'} · ${severity === 'ALL' ? '全部等级' : severity} · 共${feed.total}条；SEC为官方事实来源，新闻为待核实规则信号，均不构成买卖建议。`;
}

function renderNews() {
  const summary = state.newsSentiment || {};
  document.querySelector('#sentiment-total').textContent = summary.total || 0;
  document.querySelector('#sentiment-content-mix').textContent = `新闻${summary.newsCount || 0} · 讨论${summary.discussionCount || 0} · 风险${summary.riskSignals || 0}`;
  document.querySelector('#sentiment-sources').textContent = summary.uniqueSources || 0;
  document.querySelector('#sentiment-trend').textContent = summary.trend || '数据不足';
  document.querySelector('#sentiment-score').textContent = summary.averageSentiment == null
    ? '至少3条且2个来源才判断'
    : `平均情绪 ${Number(summary.averageSentiment).toFixed(2)} · 负面占比 ${Math.round((summary.negativeRatio || 0) * 100)}%`;
  document.querySelector('#sentiment-engagement').textContent = summary.engagementScore || 0;
  document.querySelector('#sentiment-buzz').textContent = summary.buzzChange == null
    ? `近24小时${summary.current24hCount || 0}条，历史不足`
    : `近24小时较前24小时 ${summary.buzzChange >= 0 ? '+' : ''}${Math.round(summary.buzzChange * 100)}%`;
  const providerLabels = {
    alpha_vantage: 'Alpha Vantage', google_news: 'Google News',
    yahoo_finance: 'Yahoo Finance', hacker_news: 'Hacker News'
  };
  document.querySelector('#news-list').innerHTML = state.newsArticles.map((article) => {
    const published = new Date(article.published_at).toLocaleString('zh-CN', { hour12: false });
    const sentiment = article.sentiment_score == null ? '—' : Number(article.sentiment_score).toFixed(2);
    const relevance = article.relevance_score == null ? '—' : Number(article.relevance_score).toFixed(2);
    return `<article class="news-card">
      <div class="news-card-head">
        <div class="event-title-line">${article.has_risk_event ? '<span class="badge P2">风险规则</span>' : ''}${article.has_impact_event ? '<span class="badge impact">外部驱动</span>' : ''}<span class="badge ${article.content_kind === 'DISCUSSION' ? 'source-social' : 'source-media'}">${article.content_kind === 'DISCUSSION' ? '公开讨论' : '媒体新闻'}</span><strong>${escapeHtml(article.title)}</strong></div>
        <time>${escapeHtml(published)}</time>
      </div>
      ${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ''}
      <div class="event-meta">
        <span>${escapeHtml(article.ticker)}${article.name ? ` · ${escapeHtml(article.name)}` : ''}</span>
        <span>${escapeHtml(article.source_name || article.source_domain || '未知来源')}</span>
        <span>${escapeHtml(article.source_tier === 'TIER_1' ? '一线媒体' : article.source_tier === 'SOCIAL' ? '社区来源' : '一般媒体')}</span>
        ${article.relation_type !== 'DIRECT' ? `<span>${escapeHtml(article.relation_label || '行业关联')} · 关联代理</span>` : '<span>公司直接相关新闻</span>'}
        <span>${(article.providers || []).map((provider) => escapeHtml(providerLabels[provider] || provider)).join(' · ') || '未知采集通道'}${article.source_count > 1 ? ` · ${article.source_count}个独立来源佐证` : ''}</span>
        <span>相关性 ${relevance} · 情绪 ${sentiment}${article.sentiment_label ? ` · ${escapeHtml(article.sentiment_label)}` : ''}</span>
        <a class="sec-link" href="${escapeHtml(article.url)}" target="_blank" rel="noreferrer">查看新闻原文 ↗</a>
      </div>
    </article>`;
  }).join('');
  document.querySelector('#news-empty').classList.toggle('hidden', state.newsArticles.length > 0);
}

function compactUsd(value) {
  if (!Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2
  }).format(Number(value));
}

function renderExternalDrivers() {
  const overview = state.externalDrivers;
  const content = document.querySelector('#drivers-content');
  const empty = document.querySelector('#drivers-empty');
  if (!overview) {
    content.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const repurchase = overview.corporateActions?.shareRepurchases || {};
  const capex = overview.corporateActions?.capitalExpenditure || {};
  const tenYear = overview.macro?.metrics?.US10Y_YIELD || {};
  const fedFunds = overview.macro?.metrics?.FED_FUNDS_FUTURES || {};
  const treasuryFuture = overview.macro?.metrics?.US10Y_FUTURES || {};
  const treasuryEtf = overview.macro?.metrics?.LONG_TREASURY_ETF || {};
  const relationEntities = (concept) => (concept.related_entities || []).map((entity) => {
    const relationClass = entity.verifiedDirectRelationship ? 'verified-relation' : 'proxy-relation';
    const relationText = entity.verifiedDirectRelationship ? '已核实关系' : entity.role || '行业代理';
    return `<span class="badge ${relationClass}" title="${escapeHtml(relationText)}">${escapeHtml(entity.ticker || entity.name)} · ${escapeHtml(relationText)}</span>`;
  }).join('') || '<span class="muted">尚无关联实体</span>';
  const concepts = (overview.concepts || []).map((concept) => `
    <article class="concept-card">
      <h3>${escapeHtml(concept.concept_name)} <span class="badge proxy-relation">${escapeHtml(concept.concept_type)}</span></h3>
      <div class="entity-list">${relationEntities(concept)}</div>
      <p>相关度 ${Math.round(Number(concept.confidence || 0) * 100)}% · 用于检索行业和产业链信息；关系状态以每个实体标签为准。</p>
    </article>`).join('');
  const events = (overview.events || []).slice(0, 8).map((event) => `
    <article class="driver-event"><div><strong><span class="badge ${escapeHtml(event.severity)}">${escapeHtml(event.severity)}</span> ${escapeHtml(event.title)}</strong><p>${escapeHtml(event.summary)}</p></div><time>${escapeHtml(event.event_date)}</time></article>
  `).join('');
  const macroLabel = {
    RATE_HEADWIND: '利率逆风', RATE_TAILWIND: '利率顺风', MIXED: '信号分化', NEUTRAL: '中性'
  }[overview.macro?.regime] || '数据不足';
  content.innerHTML = `
    <div class="drivers-grid">
      <article class="driver-card"><span>回购执行（SEC现金支出）</span><strong>${repurchase.available ? compactUsd(repurchase.value) : '—'}</strong><small>${repurchase.available ? `${escapeHtml(repurchase.periodType)} · 截至${escapeHtml(repurchase.periodEnd)}` : '尚无可用XBRL事实'}</small></article>
      <article class="driver-card"><span>资本开支（投资代理）</span><strong>${capex.available ? compactUsd(capex.value) : '—'}</strong><small>${capex.available ? `${escapeHtml(capex.periodType)} · 截至${escapeHtml(capex.periodEnd)}` : '尚无可用XBRL事实'}</small></article>
      <article class="driver-card"><span>美债价格与收益率代理</span><strong>${tenYear.available ? `${Number(tenYear.value).toFixed(3)}%` : '—'}</strong><small>${Number.isFinite(tenYear.changeBps) ? `10Y收益率${tenYear.changeBps >= 0 ? '+' : ''}${Number(tenYear.changeBps).toFixed(1)}bp` : '10Y收益率待积累'}${Number.isFinite(treasuryFuture.changePct) ? ` · ZN期货${percent(treasuryFuture.changePct)}` : ''}${Number.isFinite(treasuryEtf.changePct) ? ` · TLT${percent(treasuryEtf.changePct)}` : ''}</small></article>
      <article class="driver-card"><span>利率预期环境</span><strong>${escapeHtml(macroLabel)}</strong><small>${Number.isFinite(fedFunds.changeBps) ? `期货隐含利率${fedFunds.changeBps >= 0 ? '+' : ''}${Number(fedFunds.changeBps).toFixed(1)}bp` : 'ZQ=F免费代理待积累'}</small></article>
    </div>
    <div class="concept-grid">${concepts || '<div class="empty">尚未配置个股概念。</div>'}</div>
    ${events ? `<div class="driver-events">${events}</div>` : ''}
    <p class="driver-disclaimer">回购现金支出不等于剩余授权额度；资本开支不自动等于扩产；代理公司不等于已确认客户或供应商。美债及联邦基金期货来自免费行情代理，不构成个股涨跌因果或交易建议。</p>`;
}

function renderInvestmentAdvice() {
  const overview = state.investmentAdvice;
  const content = document.querySelector('#advice-content');
  const empty = document.querySelector('#advice-empty');
  if (!overview) {
    content.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const componentLabels = {
    price: '价格趋势', capitalFlow: '日线资金行为', intradayFlow: '分钟主动成交',
    capitalBehavior: '连续资金阶段',
    events: '事件影响', macro: '美债/利率',
    valuation: '估值', earnings: 'EPS修订', fundamentals: '基本面'
  };
  content.innerHTML = `<div class="advice-grid">${(overview.advice || []).map((item) => {
    const factors = Object.entries(item.components || {}).map(([key, value]) => {
      const suffix = key === 'capitalBehavior'
        ? value.usedInImpact ? '（已验证纳入）' : value.available ? '（研究，未过85分）' : '（缺失）'
        : value.available ? '' : '（缺失）';
      const reliability = key === 'capitalBehavior' && Number.isFinite(value.reliability?.reliabilityScore)
        ? ` title="20日验证可靠度 ${Number(value.reliability.reliabilityScore).toFixed(1)}分"` : '';
      return `<div class="factor-row"><span${reliability}>${escapeHtml(componentLabels[key] || key)}${suffix}</span><strong class="${pnlClass(value.score)}">${Number.isFinite(value.score) ? `${value.score >= 0 ? '+' : ''}${Number(value.score).toFixed(1)}` : '—'}</strong></div>`;
    }).join('');
    const statusLabel = item.publicationStatus === 'PUBLISHED'
      ? '正式候选' : item.publicationStatus === 'RISK_OVERRIDE' ? '风险优先' : '观察输出';
    return `<article class="advice-card ${escapeHtml(item.stance)}">
      <div class="advice-card-head"><strong>${escapeHtml(item.horizonLabel)}</strong><span class="badge ${item.publicationStatus === 'PUBLISHED' ? 'PUBLISHED' : item.publicationStatus === 'RISK_OVERRIDE' ? 'P1' : 'P2'}">${escapeHtml(statusLabel)}</span></div>
      <h3>${escapeHtml(item.actionLabel)}</h3>
      <div class="advice-score">影响分 <strong class="${pnlClass(item.impactScore)}">${item.impactScore >= 0 ? '+' : ''}${Number(item.impactScore).toFixed(1)}</strong> · 证据置信 ${Number(item.confidenceScore).toFixed(1)} · 因子覆盖 ${Number(item.factorCoverage).toFixed(0)}%</div>
      <p>${escapeHtml(item.advice)}</p>
      <div class="factor-list">${factors}</div>
      <div class="advice-levels">现价 ${money(item.currentPrice)}${item.targetPrice != null ? ` · 模型中位目标 ${money(item.targetPrice)}` : ' · 目标位未获准发布'}${item.stopPrice != null ? ` · 模型失效参考 ${money(item.stopPrice)}` : ''}</div>
    </article>`;
  }).join('')}</div>
  <div class="advice-policy"><strong>发布纪律：</strong>${escapeHtml(overview.policy?.formalGate || '')} ${escapeHtml(overview.policy?.riskOverride || '')} ${escapeHtml(overview.policy?.personalization || '')}</div>`;
}

const CAPITAL_CHART_SERIES = [
  { key: 'volume', label: '成交量', color: '#6fb1ff', kind: 'line', format: (value) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value) },
  { key: 'averageVolume5d', label: '5日均量', color: '#54d6c5', kind: 'line', format: (value) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value) },
  { key: 'averageVolume20d', label: '20日均量', color: '#8a7dff', kind: 'line', format: (value) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value) },
  { key: 'netActiveTurnover', label: '净主动流入/流出', color: '#ff6b78', kind: 'bar' }
];

function compactUsdAmount(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(Math.abs(value))
    : '—';
}

function renderCapitalFlowChart(history) {
  const rows = [...(history || [])].sort((left, right) =>
    String(left.priceDate || left.asOf).localeCompare(String(right.priceDate || right.asOf))
  );
  const controls = CAPITAL_CHART_SERIES.map((series) => `
    <label class="capital-chart-toggle" style="--series-color:${series.color}">
      <input type="checkbox" data-capital-chart-series="${series.key}" ${state.capitalChartVisible.has(series.key) ? 'checked' : ''}>
      <span class="${series.kind === 'bar' ? 'capital-chart-bar-key' : ''}"></span>${escapeHtml(series.label)}
    </label>`).join('');
  const selectedLines = CAPITAL_CHART_SERIES.filter((series) => (
    series.kind === 'line' && state.capitalChartVisible.has(series.key)
  ));
  const showFlowBars = state.capitalChartVisible.has('netActiveTurnover');
  if (!rows.length || (!selectedLines.length && !showFlowBars)) {
    return `<section id="capital-flow-chart" class="capital-chart">
      <div class="capital-chart-head"><div><strong>10日成交量与主动资金流</strong><span>左轴为成交股数，右轴为净主动成交额。</span></div><div class="capital-chart-controls">${controls}</div></div>
      <div class="capital-chart-empty">${rows.length ? '请至少选择一个指标。' : '暂无可绘制的交易日数据。'}</div>
    </section>`;
  }

  const width = 1080;
  const height = 360;
  const margin = { top: 22, right: 72, bottom: 48, left: 54 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const xAt = (index) => margin.left + (rows.length === 1 ? plotWidth / 2 : (index / (rows.length - 1)) * plotWidth);
  const selectedValues = selectedLines.flatMap((series) => rows.map((row) =>
    row[series.key] == null ? Number.NaN : Number(row[series.key])
  )).filter(Number.isFinite);
  const axisMaximum = Math.max(...selectedValues, 1) * 1.08;
  const yAt = (value) => margin.top + ((1 - (value / axisMaximum)) * plotHeight);
  const formatAxisVolume = (value) => new Intl.NumberFormat('zh-CN', {
    notation: 'compact', maximumFractionDigits: 1
  }).format(value);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = margin.top + (ratio * plotHeight);
    return `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" class="capital-chart-grid" />
      ${selectedLines.length ? `<text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" class="capital-chart-axis-label">${formatAxisVolume(axisMaximum * (1 - ratio))}</text>` : ''}`;
  }).join('');
  const dates = rows.map((row, index) => {
    const date = String(row.priceDate || row.asOf || '');
    return `<text x="${xAt(index)}" y="${height - 17}" text-anchor="middle" class="capital-chart-date">${escapeHtml(date.slice(5))}</text>`;
  }).join('');
  const lines = selectedLines.map((series) => {
    const observations = rows.map((row, index) => ({
      index,
      value: row[series.key] == null ? Number.NaN : Number(row[series.key]),
      date: row.priceDate || row.asOf
    }))
      .filter((item) => Number.isFinite(item.value));
    if (!observations.length) return '';
    const points = observations.map((item) => `${xAt(item.index)},${yAt(item.value)}`).join(' ');
    const circles = observations.map((item) => `<circle cx="${xAt(item.index)}" cy="${yAt(item.value)}" r="4" fill="${series.color}" class="capital-chart-point"><title>${escapeHtml(item.date)} · ${escapeHtml(series.label)}：${escapeHtml(series.format(item.value))}</title></circle>`).join('');
    return `<polyline points="${points}" fill="none" stroke="${series.color}" class="capital-chart-line" />${circles}`;
  }).join('');
  const flowValues = rows.map((row) => row.netActiveTurnover == null
    ? Number.NaN : Number(row.netActiveTurnover));
  const maximumAbsoluteFlow = Math.max(...flowValues.filter(Number.isFinite).map(Math.abs), 0);
  const flowZeroY = margin.top + (plotHeight / 2);
  const flowBarWidth = Math.min(42, (plotWidth / Math.max(rows.length, 1)) * 0.48);
  const flowBars = showFlowBars && maximumAbsoluteFlow > 0 ? rows.map((row, index) => {
    const value = row.netActiveTurnover == null ? Number.NaN : Number(row.netActiveTurnover);
    if (!Number.isFinite(value)) return '';
    const barHeight = Math.max(1, (Math.abs(value) / maximumAbsoluteFlow) * (plotHeight / 2));
    const y = value >= 0 ? flowZeroY - barHeight : flowZeroY;
    const direction = value >= 0 ? '流入' : '流出';
    return `<rect x="${xAt(index) - (flowBarWidth / 2)}" y="${y}" width="${flowBarWidth}" height="${barHeight}" class="capital-chart-flow-bar ${value >= 0 ? 'inflow' : 'outflow'}"><title>${escapeHtml(row.priceDate || row.asOf)} · 净主动${direction}：${value >= 0 ? '+' : '-'}${escapeHtml(compactUsdAmount(value))}</title></rect>`;
  }).join('') : '';
  const flowAxis = showFlowBars && maximumAbsoluteFlow > 0 ? `
    <line x1="${margin.left}" y1="${flowZeroY}" x2="${width - margin.right}" y2="${flowZeroY}" class="capital-chart-flow-zero" />
    <text x="${width - margin.right + 9}" y="${margin.top + 4}" class="capital-chart-axis-label capital-chart-flow-positive">+${escapeHtml(compactUsdAmount(maximumAbsoluteFlow))}</text>
    <text x="${width - margin.right + 9}" y="${flowZeroY + 4}" class="capital-chart-axis-label">$0</text>
    <text x="${width - margin.right + 9}" y="${margin.top + plotHeight}" class="capital-chart-axis-label capital-chart-flow-negative">-${escapeHtml(compactUsdAmount(maximumAbsoluteFlow))}</text>
    <text x="${width - 13}" y="${margin.top + (plotHeight / 2)}" transform="rotate(90 ${width - 13} ${margin.top + (plotHeight / 2)})" text-anchor="middle" class="capital-chart-axis-title">净主动成交额（美元）</text>` : '';

  return `<section id="capital-flow-chart" class="capital-chart">
    <div class="capital-chart-head"><div><strong>10日成交量与主动资金流</strong><span>折线使用左侧成交量轴；净流入为红色向上柱，净流出为绿色向下柱，使用右侧美元轴。</span></div><div class="capital-chart-controls">${controls}</div></div>
    <div class="capital-chart-canvas">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="最近10个交易日成交量折线和净主动资金流柱状图">
        ${grid}${selectedLines.length ? `<text x="17" y="${margin.top + (plotHeight / 2)}" transform="rotate(-90 17 ${margin.top + (plotHeight / 2)})" text-anchor="middle" class="capital-chart-axis-title">成交量（股）</text>` : ''}
        ${flowAxis}${flowBars}${dates}${lines}
      </svg>
    </div>
  </section>`;
}

const capitalBehaviorStageLabels = {
  ACCELERATED_ACCUMULATION: '加速吸筹迹象', ACCUMULATION: '持续吸筹迹象',
  ABSORPTION: '下跌承接迹象', NEUTRAL: '方向暂不明确',
  DISTRIBUTION_INTO_STRENGTH: '上涨派发迹象', DISTRIBUTION: '持续派发迹象',
  ACCELERATED_DISTRIBUTION: '加速派发迹象', INSUFFICIENT: '数据不足'
};

function renderCapitalBehavior() {
  const overview = state.capitalBehavior;
  const content = document.querySelector('#capital-behavior-content');
  const empty = document.querySelector('#capital-behavior-empty');
  if (!overview?.latest) {
    content.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const latest = overview.latest;
  const compactRatio = (value) => Number.isFinite(value)
    ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%` : '—';
  const scoreText = (value) => Number.isFinite(value)
    ? `${value >= 0 ? '+' : ''}${Number(value).toFixed(1)}` : '—';
  const behaviorHistory = (overview.history || []).map((row) => `
    <tr>
      <td>${escapeHtml(row.priceDate || row.asOf)}</td>
      <td><span class="badge capital-stage ${escapeHtml(row.direction)}">${escapeHtml(row.stageLabel || capitalBehaviorStageLabels[row.stage] || row.stage)}</span></td>
      <td class="${pnlClass(row.score)}">${scoreText(row.score)}</td>
      <td>${decimal(row.confidence, 1)}分</td>
      <td class="${pnlClass(row.dailyFlowScore)}">${scoreText(row.dailyFlowScore)}</td>
      <td class="${pnlClass(row.intradayFlowScore)}">${scoreText(row.intradayFlowScore)}</td>
      <td class="${pnlClass(row.activeTurnoverRatio)}">${compactRatio(row.activeTurnoverRatio)}</td>
      <td class="${pnlClass(row.priceVsVwap)}">${compactRatio(row.priceVsVwap)}</td>
      <td>${decimal(row.persistenceScore, 0)}%</td>
    </tr>`).join('');
  const reliability = (overview.reliability || []).map((row) => {
    const enoughForRate = Number(row.effectiveSamples) >= 5;
    const accuracy = enoughForRate && Number.isFinite(row.directionAccuracy)
      ? `${(row.directionAccuracy * 100).toFixed(1)}%（${row.hits}/${row.effectiveSamples}）`
      : `${row.hits || 0}/${row.effectiveSamples || 0}`;
    const statusLabel = row.status === 'PUBLISHED' ? '通过85分门槛'
      : row.status === 'OBSERVE' ? '继续观察' : '样本不足';
    return `<tr>
      <td><strong>${row.horizonDays}日</strong></td>
      <td>${row.matured || 0}<br><small class="muted">待验证 ${row.pending || 0} · 排除 ${row.excluded || 0}</small></td>
      <td>${row.effectiveSamples || 0} / ${row.requiredSamples}</td>
      <td>${accuracy}</td>
      <td class="${pnlClass(row.averageForwardReturn)}">${percent(row.averageForwardReturn)}</td>
      <td class="${pnlClass(row.averageMfe)}">${percent(row.averageMfe)}</td>
      <td class="${pnlClass(row.averageMae)}">${percent(row.averageMae)}</td>
      <td>${decimal(row.reliabilityScore, 1)}分</td>
      <td><span class="badge ${escapeHtml(row.status)}">${statusLabel}</span></td>
    </tr>`;
  }).join('');
  const validationDetails = (overview.validationDetails || []).map((row) => {
    const statusLabel = row.status === 'MATURED' ? '已到期' : '待验证';
    const hitLabel = row.directionHit === true ? '命中'
      : row.directionHit === false ? '未命中' : '—';
    const hitClass = row.directionHit === true ? 'positive'
      : row.directionHit === false ? 'negative' : '';
    return `<tr>
      <td>${escapeHtml(row.signalAsOf)}</td>
      <td><span class="badge capital-stage ${escapeHtml(row.direction)}">${escapeHtml(row.stageLabel || capitalBehaviorStageLabels[row.stage] || row.stage)}</span></td>
      <td>${row.horizonDays}日</td>
      <td><span class="badge ${row.status === 'MATURED' ? 'PUBLISHED' : 'INSUFFICIENT'}">${statusLabel}</span></td>
      <td>${escapeHtml(row.actualDate || '—')}</td>
      <td class="${pnlClass(row.actualReturn)}">${percent(row.actualReturn)}</td>
      <td class="${pnlClass(row.maximumFavorableExcursion)}">${percent(row.maximumFavorableExcursion)}</td>
      <td class="${pnlClass(row.maximumAdverseExcursion)}">${percent(row.maximumAdverseExcursion)}</td>
      <td class="${hitClass}">${hitLabel}</td>
    </tr>`;
  }).join('');
  const latestDirection = latest.direction || 'NEUTRAL';
  content.innerHTML = `
    <div class="capital-behavior-summary ${escapeHtml(latestDirection)}">
      <article class="capital-behavior-primary">
        <span>${escapeHtml(latest.priceDate || latest.asOf)} · ${escapeHtml(latest.dataLevel)}</span>
        <strong class="${pnlClass(latest.score)}">${escapeHtml(latest.stageLabel || capitalBehaviorStageLabels[latest.stage] || latest.stage)}</strong>
        <div>连续行为评分 <b class="${pnlClass(latest.score)}">${scoreText(latest.score)}</b> · 证据置信 ${decimal(latest.confidence, 1)}分</div>
      </article>
      <div class="capital-behavior-metrics">
        <article><span>近5日正向/负向</span><strong>${latest.positiveDays5 || 0} / ${latest.negativeDays5 || 0}</strong></article>
        <article><span>方向连续天数</span><strong>${latest.directionalStreak || 0}日</strong></article>
        <article><span>持续性</span><strong>${decimal(latest.persistenceScore, 0)}%</strong></article>
        <article><span>日线量价分</span><strong class="${pnlClass(latest.dailyFlowScore)}">${scoreText(latest.dailyFlowScore)}</strong></article>
        <article><span>主动成交分</span><strong class="${pnlClass(latest.intradayFlowScore)}">${scoreText(latest.intradayFlowScore)}</strong></article>
        <article><span>收盘价相对VWAP</span><strong class="${pnlClass(latest.priceVsVwap)}">${compactRatio(latest.priceVsVwap)}</strong></article>
      </div>
    </div>
    ${latest.explanation ? `<p class="flow-explanation">${escapeHtml(latest.explanation)}</p>` : ''}
    <div class="volume-history-head"><strong>最近20个交易日的连续阶段</strong><span>主动成交和VWAP缺失时明确降级为日线代理</span></div>
    <div class="table-wrap capital-behavior-history-wrap">
      <table class="capital-behavior-table">
        <thead><tr><th>交易日</th><th>阶段</th><th>综合分</th><th>置信度</th><th>日线分</th><th>主动成交分</th><th>主动成交差</th><th>相对VWAP</th><th>持续性</th></tr></thead>
        <tbody>${behaviorHistory}</tbody>
      </table>
      ${behaviorHistory ? '' : '<div class="empty">运行一次识别后开始积累连续阶段。</div>'}
    </div>
    <div class="volume-history-head"><strong>前向验证与可靠度</strong><span>只用非重叠样本计算；不足5个样本时仅显示原始命中数</span></div>
    <div class="table-wrap capital-behavior-validation-wrap">
      <table class="capital-behavior-validation-table">
        <thead><tr><th>期限</th><th>已到期样本</th><th>有效/最低</th><th>方向命中</th><th>方向调整收益</th><th>平均MFE</th><th>平均MAE</th><th>可靠度</th><th>状态</th></tr></thead>
        <tbody>${reliability}</tbody>
      </table>
    </div>
    <div class="volume-history-head"><strong>最近验证明细</strong><span>尚未到期的期限只显示“待验证”，不提前判定命中</span></div>
    <div class="table-wrap capital-behavior-detail-wrap">
      <table class="capital-behavior-detail-table">
        <thead><tr><th>信号日</th><th>阶段</th><th>期限</th><th>状态</th><th>结果日</th><th>实际收益</th><th>MFE</th><th>MAE</th><th>方向结果</th></tr></thead>
        <tbody>${validationDetails}</tbody>
      </table>
      ${validationDetails ? '' : '<div class="empty">尚无可验证的方向信号。</div>'}
    </div>
    <p class="driver-disclaimer">${escapeHtml(overview.methodology?.directionHit || '')} ${escapeHtml(overview.methodology?.overlap || '')} ${escapeHtml(overview.methodology?.boundary || '')}</p>`;
}

function renderCapitalFlow() {
  const analysis = state.capitalFlow;
  const content = document.querySelector('#capital-flow-content');
  const empty = document.querySelector('#capital-flow-empty');
  if (!analysis) {
    content.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const metrics = analysis.metrics || {};
  const flowPercent = (value) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%` : '—';
  const compactVolume = (value) => Number.isFinite(value)
    ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
    : '—';
  const signedFlow = (value) => Number.isFinite(value)
    ? `${value >= 0 ? '+' : '-'}${compactUsdAmount(value)}` : '—';
  const evidence = (analysis.evidence || []).map((item) => {
    const directionClass = item.direction === 'INFLOW' ? 'positive' : item.direction === 'OUTFLOW' ? 'negative' : '';
    const value = item.key === 'relativeVolume'
      ? `${Number(item.value).toFixed(2)}倍`
      : Number.isFinite(item.value) ? Number(item.value).toFixed(3) : '—';
    return `<div class="flow-evidence-row"><span>${escapeHtml(item.label)}</span><strong class="${directionClass}">${escapeHtml(value)}</strong></div>`;
  }).join('');
  const anomalies = (analysis.anomalies || []).map((item) =>
    `<span class="badge ${item.direction === 'OUTFLOW' ? 'P1' : 'impact'}">${escapeHtml(item.label)}</span>`
  ).join('');
  const volumeHistory = (analysis.history || []).map((row) => `
    <tr>
      <td>${escapeHtml(row.priceDate || row.asOf)}</td>
      <td>${money(row.close)}</td>
      <td class="${pnlClass(row.dailyReturn)}">${flowPercent(row.dailyReturn)}</td>
      <td>${compactVolume(row.volume)}</td>
      <td>${Number.isFinite(row.averageVolume5d) ? compactVolume(row.averageVolume5d) : '—'}</td>
      <td>${Number.isFinite(row.averageVolume20d) ? compactVolume(row.averageVolume20d) : '—'}</td>
      <td>${Number.isFinite(row.relativeVolume) ? `${Number(row.relativeVolume).toFixed(2)}倍` : '—'}</td>
      <td class="positive">${Number.isFinite(row.activeBuyTurnover) ? signedFlow(row.activeBuyTurnover) : '—'}</td>
      <td class="negative">${Number.isFinite(row.activeSellTurnover) ? signedFlow(-row.activeSellTurnover) : '—'}</td>
      <td class="${pnlClass(row.netActiveTurnover)}">${signedFlow(row.netActiveTurnover)}</td>
      <td>${escapeHtml(row.volumeTrendLabel || '—')}</td>
      <td class="${pnlClass(row.score)}">${escapeHtml(row.signalLabel || '—')}</td>
      <td class="${pnlClass(row.score)}">${Number.isFinite(row.score) ? `${row.score >= 0 ? '+' : ''}${Number(row.score).toFixed(1)}` : '—'}</td>
    </tr>`).join('');
  content.innerHTML = `
    <div class="capital-flow-summary ${escapeHtml(analysis.signal)}">
      <article class="flow-primary">
        <span>${escapeHtml(analysis.priceDate || analysis.asOf)} · ${escapeHtml(analysis.dataLevel === 'DAILY_PROXY' ? '日线代理' : analysis.dataLevel)}</span>
        <strong class="${pnlClass(analysis.score)}">${escapeHtml(analysis.signalLabel)}</strong>
        <div>行为评分 <b class="${pnlClass(analysis.score)}">${analysis.score >= 0 ? '+' : ''}${Number(analysis.score).toFixed(1)}</b> · 证据置信 ${Number(analysis.confidence).toFixed(1)}分</div>
      </article>
      <div class="flow-metrics">
        <article><span>当日成交量</span><strong>${compactVolume(metrics.volume)}</strong></article>
        <article><span>5日均量</span><strong>${compactVolume(metrics.averageVolume5d)}</strong></article>
        <article><span>20日均量</span><strong>${compactVolume(metrics.averageVolume20d)}</strong></article>
        <article><span>成交量趋势</span><strong class="${pnlClass(metrics.volumeTrendPct)}">${escapeHtml(metrics.volumeTrendLabel || '数据不足')} ${flowPercent(metrics.volumeTrendPct)}</strong></article>
        <article><span>方向性成交额代理</span><strong class="${pnlClass(metrics.directionalNotionalRatio20d)}">${flowPercent(metrics.directionalNotionalRatio20d)}</strong></article>
        <article><span>相对20日均量</span><strong>${Number.isFinite(metrics.relativeVolume) ? `${Number(metrics.relativeVolume).toFixed(2)}倍` : '—'}</strong></article>
        <article><span>CMF 20日</span><strong class="${pnlClass(metrics.cmf20)}">${Number.isFinite(metrics.cmf20) ? Number(metrics.cmf20).toFixed(3) : '—'}</strong></article>
        <article><span>MFI 14日</span><strong>${Number.isFinite(metrics.mfi14) ? Number(metrics.mfi14).toFixed(1) : '—'}</strong></article>
      </div>
    </div>
    <p class="flow-explanation">${escapeHtml(analysis.explanation)}</p>
    ${anomalies ? `<div class="flow-anomalies"><strong>异常信号</strong>${anomalies}</div>` : ''}
    <div class="flow-evidence">${evidence}</div>
    <div class="volume-history-head"><strong>最近10个交易日</strong><span>日线指标按当时数据回算；主动流向仅展示已采集的富途逐笔方向</span></div>
    <div class="table-wrap volume-history-wrap">
      <table class="volume-history-table">
        <thead><tr><th>交易日</th><th>收盘价</th><th>涨跌</th><th>成交量</th><th>5日均量</th><th>20日均量</th><th>量比</th><th>主动流入</th><th>主动流出</th><th>净流入/流出</th><th>成交量趋势</th><th>资金行为</th><th>评分</th></tr></thead>
        <tbody>${volumeHistory}</tbody>
      </table>
      ${volumeHistory ? '' : '<div class="empty">尚无可展示的日线成交数据。</div>'}
    </div>
    ${renderCapitalFlowChart(analysis.history || [])}
    <p class="driver-disclaimer">上方资金行为评分仍是日线量价代理；表格和柱体中的主动流入/流出仅来自已采集的富途逐笔方向。两者都不能确认机构或最终账户身份，需通过后续价格表现持续验证。</p>`;
}

function renderIntradayFlow() {
  const overview = state.intradayFlow;
  const content = document.querySelector('#intraday-flow-content');
  const empty = document.querySelector('#intraday-flow-empty');
  const status = document.querySelector('#intraday-flow-status');
  if (!overview) {
    content.innerHTML = '';
    empty.classList.remove('hidden');
    status.textContent = '等待富途行情';
    return;
  }
  const analysis = overview.analysis || {};
  const collector = overview.collector || {};
  const metrics = analysis.metrics || {};
  status.textContent = collector.status === 'connected'
    ? `富途已连接 · ${collector.session || 'RTH'} · ${collector.symbols?.length || 0}只股票`
    : `富途状态：${collector.status || '未知'}${collector.lastError ? ` · ${collector.lastError}` : ''}`;
  if (!analysis.asOf) {
    content.innerHTML = '';
    empty.textContent = analysis.explanation || '尚未收到分钟行情。';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const compactUsd = (value) => Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(value)
    : '—';
  const ratio = (value) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%` : '—';
  const rows = (overview.minutes || []).slice(0, 10).map((row) => `
    <tr>
      <td>${escapeHtml(row.minute)}</td>
      <td class="positive">${compactUsd(row.buyTurnover)}</td>
      <td class="negative">${compactUsd(row.sellTurnover)}</td>
      <td class="${pnlClass(row.netActiveTurnover)}">${compactUsd(row.netActiveTurnover)}</td>
      <td>${Number(row.tickCount).toLocaleString('zh-CN')}</td>
    </tr>`).join('');
  const anomalies = (analysis.anomalies || []).map((item) =>
    `<span class="badge ${item.direction === 'OUTFLOW' ? 'P1' : 'impact'}">${escapeHtml(item.label)}</span>`
  ).join('');
  content.innerHTML = `
    <div class="intraday-flow-summary ${escapeHtml(analysis.signal)}">
      <article class="intraday-flow-primary">
        <span>${escapeHtml(analysis.tradeDate)} · 截至 ${escapeHtml(analysis.asOf.slice(11, 19))} ET</span>
        <strong class="${pnlClass(analysis.score)}">${escapeHtml(analysis.signalLabel)}</strong>
        <div>方向评分 <b class="${pnlClass(analysis.score)}">${analysis.score >= 0 ? '+' : ''}${Number(analysis.score).toFixed(1)}</b> · 证据置信 ${Number(analysis.confidence).toFixed(1)}分 · ${escapeHtml(analysis.dataLevel)}</div>
      </article>
      <div class="intraday-flow-metrics">
        <article><span>主动买入成交额</span><strong class="positive">${compactUsd(metrics.buyTurnover)}</strong></article>
        <article><span>主动卖出成交额</span><strong class="negative">${compactUsd(metrics.sellTurnover)}</strong></article>
        <article><span>净主动成交额</span><strong class="${pnlClass(metrics.netActiveTurnover)}">${compactUsd(metrics.netActiveTurnover)}</strong></article>
        <article><span>主动成交差比例</span><strong class="${pnlClass(metrics.activeTurnoverRatio)}">${ratio(metrics.activeTurnoverRatio)}</strong></article>
        <article><span>大额主动买入</span><strong class="positive">${compactUsd(metrics.largeBuyTurnover)}</strong></article>
        <article><span>大额主动卖出</span><strong class="negative">${compactUsd(metrics.largeSellTurnover)}</strong></article>
        <article><span>VWAP / 最新价</span><strong>${money(metrics.vwap)} / ${money(metrics.latestPrice)}</strong></article>
        <article><span>逐笔数 / 分钟数</span><strong>${Number(metrics.tickCount || 0).toLocaleString('zh-CN')} / ${Number(metrics.barCount || 0).toLocaleString('zh-CN')}</strong></article>
        <article><span>逐笔分钟覆盖率</span><strong>${ratio(metrics.tickMinuteCoverage)}</strong></article>
        <article><span>方向笔数覆盖率</span><strong>${ratio(metrics.directionCountCoverage)}</strong></article>
      </div>
    </div>
    <p class="flow-explanation">${escapeHtml(analysis.explanation)}</p>
    ${anomalies ? `<div class="flow-anomalies"><strong>盘中异常</strong>${anomalies}</div>` : ''}
    <div class="volume-history-head"><strong>最近10分钟主动成交</strong><span>BUY/SELL 来自富途逐笔成交方向；红色为主动买入，绿色为主动卖出</span></div>
    <div class="table-wrap volume-history-wrap">
      <table class="intraday-flow-table">
        <thead><tr><th>美东时间</th><th>主动买入</th><th>主动卖出</th><th>净主动成交</th><th>逐笔数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${rows ? '' : '<div class="empty">分钟线已收到，但逐笔方向仍在积累。</div>'}
    </div>
    <p class="driver-disclaimer">净主动成交额是成交发生在买卖盘两侧的方向代理，不代表资金进入或离开公司，也不能确认机构或最终账户身份。</p>`;
}

async function loadExternalDrivers() {
  const ticker = document.querySelector('#event-ticker').value;
  state.externalDrivers = ticker ? await api(`/api/drivers?ticker=${encodeURIComponent(ticker)}`) : null;
  renderExternalDrivers();
}

async function loadInvestmentAdvice() {
  const ticker = document.querySelector('#event-ticker').value;
  state.investmentAdvice = ticker ? await api(`/api/advice?ticker=${encodeURIComponent(ticker)}`) : null;
  renderInvestmentAdvice();
}

async function loadCapitalFlow() {
  const ticker = document.querySelector('#capital-ticker').value;
  if (!ticker) {
    state.capitalFlow = null;
    state.intradayFlow = null;
    state.capitalBehavior = null;
    state.capitalLoadedTicker = null;
  }
  else {
    const [analysis, history, intradayFlow, capitalBehavior] = await Promise.all([
      api(`/api/capital-flow?ticker=${encodeURIComponent(ticker)}`),
      api(`/api/capital-flow/history?ticker=${encodeURIComponent(ticker)}&limit=10`),
      api(`/api/intraday-flow?ticker=${encodeURIComponent(ticker)}&limit=30`),
      api(`/api/capital-behavior?ticker=${encodeURIComponent(ticker)}`)
    ]);
    state.capitalFlow = { ...analysis, history };
    state.intradayFlow = intradayFlow;
    state.capitalBehavior = capitalBehavior;
    state.capitalLoadedTicker = ticker;
  }
  renderCapitalBehavior();
  renderCapitalFlow();
  renderIntradayFlow();
}

async function loadEvents() {
  const ticker = document.querySelector('#event-ticker').value;
  const severity = document.querySelector('#event-severity').value || 'ALL';
  const query = new URLSearchParams({ severity, limit: '200' });
  if (ticker) query.set('ticker', ticker);
  state.eventFeed = await api(`/api/events?${query.toString()}`);
  renderEvents();
}

async function loadNews() {
  const ticker = document.querySelector('#event-ticker').value;
  const query = new URLSearchParams({ limit: '100' });
  if (ticker) query.set('ticker', ticker);
  const sentimentQuery = new URLSearchParams();
  if (ticker) sentimentQuery.set('ticker', ticker);
  const [newsArticles, newsSentiment] = await Promise.all([
    api(`/api/news?${query.toString()}`),
    api(`/api/news/sentiment?${sentimentQuery.toString()}`)
  ]);
  Object.assign(state, { newsArticles, newsSentiment });
  renderNews();
}

async function loadEventCenter() {
  await Promise.all([loadEvents(), loadNews(), loadExternalDrivers(), loadInvestmentAdvice()]);
}

const predictionHorizonLabels = { 21: '1个月', 63: '3个月', 126: '6个月' };
const predictionDirectionLabels = { BULLISH: '看多', BEARISH: '看空', NEUTRAL: '震荡' };
const predictionStatusLabels = {
  PUBLISHED: '已发布', OBSERVE: '观察', REJECTED: '未通过', INSUFFICIENT: '样本不足'
};
const predictionChangeLabels = {
  DIRECTION_CHANGE: '方向改变', MATERIAL_CHANGE: '重大变化',
  MODERATE_CHANGE: '明显变化', STABLE: '变化较小'
};

function metricPercent(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(2)}%`;
}

function predictionInputValue(value, unit) {
  if (value == null) return '—';
  if (unit === 'TEXT') return String(value);
  if (!Number.isFinite(Number(value))) return '—';
  if (unit === 'USD') return money(value);
  if (unit === 'PERCENT') return percent(value);
  if (unit === 'BPS') return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}bp`;
  if (unit === 'MULTIPLE') return `${Number(value).toFixed(2)}x`;
  if (unit === 'COUNT') return String(Number(value));
  return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(3)}`;
}

function renderPredictionOverview() {
  const overview = state.predictionOverview;
  const feature = overview?.feature;
  const availability = feature?.availability || {};
  const availableFactors = Object.entries(availability).filter(([, available]) => available).map(([key]) => key);
  const allFactorLabels = {
    price: '价格', longPriceHistory: '长周期价格', benchmark: '基准', capitalFlow: '资金行为',
    industryBenchmark: '行业ETF', continuousCapital: '连续资金', valuation: '估值',
    peerValuation: '同业估值', earnings: 'EPS预期', fundamentals: '基本面',
    cashFlowFundamentals: '现金流', macro: '宏观', events: '事件'
  };
  document.querySelector('#prediction-feature-date').textContent = feature?.priceDate || '—';
  document.querySelector('#prediction-feature-version').textContent = feature?.featureVersion || '尚未生成';
  document.querySelector('#prediction-data-quality').textContent = feature ? `${decimal(feature.dataQualityScore, 1)}分` : '—';
  const factorTotal = feature ? Object.keys(feature.availability || {}).length : 0;
  document.querySelector('#prediction-factor-count').textContent = feature ? `${availableFactors.length}/${factorTotal}` : '—';
  document.querySelector('#prediction-factor-note').textContent = availableFactors.length
    ? availableFactors.map((key) => allFactorLabels[key]).join(' · ') : '等待特征快照';
  document.querySelector('#prediction-gate').textContent = `${overview?.reliabilityGate || 85}分`;

  const reliabilityByHorizon = new Map((overview?.reliability || []).map((item) => [Number(item.horizon_days), item]));
  const predictions = overview?.predictions || [];
  document.querySelector('#prediction-body').innerHTML = predictions.map((item) => {
    const horizon = Number(item.horizon_days);
    const rationale = item.rationale || {};
    const direction = rationale.predictedDirection || 'NEUTRAL';
    const status = item.publication_status;
    return `<tr>
      <td><strong>${predictionHorizonLabels[horizon] || `${horizon}日`}</strong><br><small class="muted">${horizon}个交易日</small></td>
      <td><span class="badge prediction-direction ${direction}">${predictionDirectionLabels[direction] || direction}</span></td>
      <td>${escapeHtml(item.target_date || '—')}</td>
      <td class="${pnlClass(item.return_p50)}">${percent(item.return_p50)}</td>
      <td>${money(item.price_p10)} – ${money(item.price_p90)}<br><small class="muted">中位 ${money(item.price_p50)}</small></td>
      <td>${percent(item.probability_up)}</td>
      <td>${decimal(item.reliability_score, 2)}分</td>
      <td><span class="badge ${status}">${predictionStatusLabels[status] || status}</span></td>
    </tr>`;
  }).join('');
  document.querySelector('#prediction-empty').classList.toggle('hidden', predictions.length > 0);

  const latestChanges = [];
  const seenChangeHorizons = new Set();
  for (const change of overview?.changes || []) {
    const horizon = Number(change.horizon_days);
    if (seenChangeHorizons.has(horizon)) continue;
    seenChangeHorizons.add(horizon);
    latestChanges.push(change);
  }
  document.querySelector('#prediction-change-content').innerHTML = latestChanges.map((change) => {
    const factorRows = (change.contributions || []).map((factor) => `
      <div class="prediction-factor-change">
        <span>${escapeHtml(factor.label)}</span>
        <small>${percent(factor.previous)} → ${percent(factor.current)}</small>
        <strong class="${pnlClass(factor.delta)}">${percent(factor.delta)}</strong>
      </div>`).join('');
    const qualityChange = change.summary?.dataQuality;
    const inputRows = (change.summary?.featureChanges || []).slice(0, 8).map((input) => `
      <div class="prediction-input-change">
        <span>${escapeHtml(input.label)}</span>
        <small>${escapeHtml(predictionInputValue(input.previous, input.unit))} → ${escapeHtml(predictionInputValue(input.current, input.unit))}</small>
        <strong class="${pnlClass(input.contributionDelta)}">因子贡献 ${percent(input.contributionDelta)}</strong>
      </div>`).join('');
    const currentEvidence = change.summary?.evidence?.current || {};
    const evidenceNote = [
      currentEvidence.price?.date ? `行情 ${currentEvidence.price.date} · ${currentEvidence.price.provider || '未知来源'}` : null,
      currentEvidence.earnings?.asOf ? `EPS ${currentEvidence.earnings.asOf} · ${currentEvidence.earnings.provider || '未知来源'}` : null,
      currentEvidence.fundamentals?.filedAt ? `财报提交 ${currentEvidence.fundamentals.filedAt}` : null,
      currentEvidence.continuousCapital?.asOf ? `资金阶段 ${currentEvidence.continuousCapital.asOf} · ${currentEvidence.continuousCapital.dataLevel || '未知层级'}` : null
    ].filter(Boolean).join('；');
    return `<article class="prediction-change-card ${escapeHtml(change.change_type)}">
      <div class="prediction-change-head">
        <div><span>${predictionHorizonLabels[change.horizon_days] || `${change.horizon_days}日`}</span><strong>${predictionChangeLabels[change.change_type] || change.change_type}</strong></div>
        <small>${escapeHtml(change.previous_as_of)} → ${escapeHtml(change.as_of)}</small>
      </div>
      <p>${escapeHtml(change.summary?.headline || '预测变化已记录。')}</p>
      <div class="prediction-change-metrics">
        <div><span>预期收益变化</span><strong class="${pnlClass(change.return_change)}">${percent(change.return_change)}</strong></div>
        <div><span>上涨概率变化</span><strong class="${pnlClass(change.probability_change)}">${percent(change.probability_change)}</strong></div>
        <div><span>目标中位价变化</span><strong class="${pnlClass(change.price_target_change)}">${money(change.price_target_change)}</strong></div>
        <div><span>市场价格效应</span><strong class="${pnlClass(change.market_price_effect)}">${money(change.market_price_effect)}</strong></div>
        <div><span>收益预期效应</span><strong class="${pnlClass(change.return_outlook_effect)}">${money(change.return_outlook_effect)}</strong></div>
        <div><span>数据质量变化</span><strong class="${pnlClass(qualityChange?.delta)}">${qualityChange?.delta == null ? '—' : `${qualityChange.delta >= 0 ? '+' : ''}${decimal(qualityChange.delta, 2)}分`}</strong></div>
      </div>
      <div class="prediction-factor-changes">${factorRows}</div>
      ${inputRows ? `<div class="prediction-input-section"><strong>原始输入变化</strong><small>${escapeHtml(change.summary?.rootCause || '')}</small><div>${inputRows}</div></div>` : ''}
      ${evidenceNote ? `<small class="prediction-evidence-note">数据时点：${escapeHtml(evidenceNote)}</small>` : ''}
      <small class="prediction-change-boundary">${escapeHtml(change.summary?.boundary || '')}</small>
    </article>`;
  }).join('');
  document.querySelector('#prediction-change-empty').classList.toggle('hidden', latestChanges.length > 0);

  const fixedTargetComparisons = overview?.fixedTargetComparisons || [];
  document.querySelector('#fixed-target-comparison-content').innerHTML = fixedTargetComparisons.map((comparison) => {
    const summary = comparison.summary || {};
    const points = comparison.points || [];
    const timeline = points.map((point, index) => {
      const offset = Number(point.targetDateOffsetDays) || 0;
      const targetNote = offset === 0 ? '目标日完全一致' : `目标日相差 ${offset} 天`;
      const stageChange = index > 0 && Number.isFinite(points[index - 1]?.targetPriceP50)
        ? point.targetPriceP50 - points[index - 1].targetPriceP50 : null;
      return `<div class="fixed-target-point">
        <div class="fixed-target-marker"><span>${index + 1}</span></div>
        <div class="fixed-target-stage">
          <div class="fixed-target-stage-head">
            <div><strong>${escapeHtml(point.horizonLabel)}</strong><small>基准日 ${escapeHtml(point.asOf)}</small></div>
            <span class="badge prediction-direction ${escapeHtml(point.predictedDirection)}">${predictionDirectionLabels[point.predictedDirection] || point.predictedDirection}</span>
          </div>
          <div class="fixed-target-values">
            <div><span>当时股价</span><strong>${money(point.currentPrice)}</strong></div>
            <div><span>目标中位价</span><strong>${money(point.targetPriceP50)}</strong></div>
            <div><span>目标区间</span><strong>${money(point.targetPriceP10)} – ${money(point.targetPriceP90)}</strong></div>
            <div><span>剩余期限收益</span><strong class="${pnlClass(point.returnP50)}">${percent(point.returnP50)}</strong></div>
          </div>
          <small class="fixed-target-note">${escapeHtml(targetNote)} · 数据质量 ${decimal(point.dataQualityScore, 1)}分${stageChange == null ? '' : ` · 目标价较上一阶段 <span class="${pnlClass(stageChange)}">${money(stageChange)}</span>`}</small>
        </div>
      </div>`;
    }).join('');
    const commonInterval = summary.commonInterval
      ? `${money(summary.commonInterval.low)} – ${money(summary.commonInterval.high)}` : '无共同重叠区间';
    return `<article class="fixed-target-card ${escapeHtml(summary.revision || 'STABLE')}">
      <div class="fixed-target-card-head">
        <div><span>锚定目标日</span><strong>${escapeHtml(comparison.anchorTargetDate)}</strong></div>
        <span class="badge ${escapeHtml(summary.revision || 'STABLE')}">${summary.revision === 'UPGRADED' ? '目标上调' : summary.revision === 'DOWNGRADED' ? '目标下调' : '目标稳定'}</span>
      </div>
      <p>${escapeHtml(summary.headline || '')}</p>
      <div class="fixed-target-summary">
        <div><span>首尾目标价变化</span><strong class="${pnlClass(summary.targetPriceChange)}">${money(summary.targetPriceChange)}</strong></div>
        <div><span>跨阶段目标分歧</span><strong>${percent(summary.targetSpreadPct)}</strong></div>
        <div><span>共同预测区间</span><strong>${commonInterval}</strong></div>
      </div>
      <div class="fixed-target-timeline">${timeline}</div>
      <p class="fixed-target-interpretation">${escapeHtml(summary.interpretation || '')}</p>
      <small class="prediction-change-boundary">${escapeHtml(summary.boundary || '')}</small>
    </article>`;
  }).join('');
  document.querySelector('#fixed-target-comparison-empty').classList.toggle('hidden', fixedTargetComparisons.length > 0);

  const backtest = overview?.backtest || [];
  document.querySelector('#prediction-backtest-body').innerHTML = backtest.map((counts) => {
    const reliability = reliabilityByHorizon.get(Number(counts.horizonDays));
    const details = reliability?.details || {};
    const baselineMae = Number.isFinite(details.benchmarkMae) ? details.benchmarkMae : details.zeroReturnMae;
    const status = reliability?.status || 'INSUFFICIENT';
    return `<tr>
      <td><strong>${predictionHorizonLabels[counts.horizonDays] || `${counts.horizonDays}日`}</strong></td>
      <td>${counts.matured || 0}<br><small class="muted">待到期 ${counts.pending || 0} · 排除 ${counts.excluded || 0}</small></td>
      <td>${reliability?.effective_samples ?? 0}</td>
      <td>${details.requiredSamples ?? '—'}</td>
      <td>${metricPercent(reliability?.direction_accuracy)}</td>
      <td>${metricPercent(details.empiricalIntervalCoverage)}</td>
      <td>${percent(details.modelMae)}</td>
      <td>${percent(baselineMae)}</td>
      <td><span class="badge ${status}">${predictionStatusLabels[status] || status}</span></td>
    </tr>`;
  }).join('');
  document.querySelector('#prediction-backtest-empty').classList.toggle('hidden', backtest.length > 0);

  const modelComparisons = overview?.modelComparisons || [];
  document.querySelector('#prediction-model-comparison-body').innerHTML = modelComparisons.map((item) => {
    const promoted = item.decision === 'PROMOTE_CANDIDATE';
    return `<tr>
      <td><strong>${predictionHorizonLabels[item.horizonDays] || `${item.horizonDays}日`}</strong></td>
      <td>${decimal(item.baseline?.compositeScore, 2)}分<br><small class="muted">${predictionStatusLabels[item.baseline?.status] || item.baseline?.status || '—'}</small></td>
      <td>${decimal(item.candidate?.compositeScore, 2)}分<br><small class="muted">${predictionStatusLabels[item.candidate?.status] || item.candidate?.status || '—'}</small></td>
      <td>${percent(item.baseline?.modelMae)}</td>
      <td>${percent(item.candidate?.modelMae)}</td>
      <td>${item.trainingSamples || 0}</td>
      <td><span class="badge ${promoted ? 'PUBLISHED' : 'INSUFFICIENT'}">${promoted ? '候选晋级' : '保留基线'}</span></td>
      <td>${escapeHtml(item.reason || '')}</td>
    </tr>`;
  }).join('');
  document.querySelector('#prediction-model-comparison-empty').classList.toggle('hidden', modelComparisons.length > 0);

  const modelShortName = (version) => version?.startsWith('ridge-') ? 'V2候选' : 'V1基线';
  const regimeLabels = { RISK_ON: '风险偏好', RISK_OFF: '风险规避', HIGH_VOLATILITY: '高波动', BALANCED: '均衡', UNKNOWN: '未知' };
  const breakdownRows = (overview?.reliabilityCenter?.breakdowns || []).flatMap((item) => [
    ...(item.byDirection || []).map((group) => ({ ...group, item, dimension: '预测方向', label: predictionDirectionLabels[group.key] || group.key })),
    ...(item.byRegime || []).map((group) => ({ ...group, item, dimension: '市场状态', label: regimeLabels[group.key] || group.key }))
  ]).filter((row) => row.samples > 0);
  document.querySelector('#prediction-breakdown-body').innerHTML = breakdownRows.map((row) => {
    const accuracy = row.samples >= 5 ? metricPercent(row.directionAccuracy) : `${row.hits}/${row.samples}`;
    return `<tr>
      <td>${modelShortName(row.item.modelVersion)}</td>
      <td>${predictionHorizonLabels[row.item.horizonDays] || `${row.item.horizonDays}日`}</td>
      <td>${row.dimension}</td><td>${escapeHtml(row.label)}</td>
      <td>${row.samples}</td><td>${row.hits}</td><td>${accuracy}</td><td>${percent(row.modelMae)}</td>
    </tr>`;
  }).join('');
  document.querySelector('#prediction-breakdown-empty').classList.toggle('hidden', breakdownRows.length > 0);

  const validationDetails = overview?.reliabilityCenter?.validationDetails || [];
  document.querySelector('#prediction-validation-detail-body').innerHTML = validationDetails.map((row) => {
    const directionResult = row.directionHit == null ? '—' : row.directionHit ? '命中' : '未命中';
    const intervalResult = row.intervalHit == null ? '—' : row.intervalHit ? '覆盖' : '未覆盖';
    return `<tr>
      <td>${escapeHtml(row.asOf)}</td><td>${modelShortName(row.modelVersion)}</td>
      <td>${predictionHorizonLabels[row.horizonDays] || `${row.horizonDays}日`}</td>
      <td>${predictionDirectionLabels[row.predictedDirection] || row.predictedDirection}</td>
      <td class="${pnlClass(row.predictedReturn)}">${percent(row.predictedReturn)}</td>
      <td>${escapeHtml(row.actualDate || '—')}</td>
      <td class="${pnlClass(row.actualReturn)}">${percent(row.actualReturn)}</td>
      <td>${directionResult}</td><td>${intervalResult}</td>
      <td><span class="badge ${row.status === 'MATURED' ? 'PUBLISHED' : 'INSUFFICIENT'}">${row.status === 'MATURED' ? '已到期' : '待到期'}</span></td>
    </tr>`;
  }).join('');
  document.querySelector('#prediction-validation-detail-empty').classList.toggle('hidden', validationDetails.length > 0);
}

async function loadPredictionOverview(force = false) {
  const ticker = document.querySelector('#prediction-ticker').value;
  if (!ticker) {
    state.predictionOverview = null;
    state.predictionLoadedTicker = null;
    renderPredictionOverview();
    return;
  }
  if (!force && state.predictionLoadedTicker === ticker && state.predictionOverview) return;
  state.predictionOverview = await api(`/api/predictions?ticker=${encodeURIComponent(ticker)}`);
  state.predictionLoadedTicker = ticker;
  renderPredictionOverview();
}

function renderReviews() {
  document.querySelector('#reviews-list').innerHTML = state.reviews.map((review) => `
    <article class="review">
      <div class="review-head"><strong>${review.review_type === 'PORTFOLIO' ? '股票池总复盘' : escapeHtml(review.ticker)}</strong><time>${escapeHtml(review.review_date)}</time></div>
      <p>${escapeHtml(review.narrative)}</p>
    </article>`).join('');
  document.querySelector('#reviews-empty').classList.toggle('hidden', state.reviews.length > 0);
}

function renderConfig() {
  const config = state.config;
  if (!config) return;
  const values = [
    ['监听地址', `${config.host}:${config.port}`], ['时区', config.timezone],
    ['行情数据源', config.marketDataProvider], ['可靠度门槛', `${config.reliabilityGate}分`],
    ['SEC EDGAR', config.sec.configured ? `已配置（限速 ${config.sec.requestsPerSecond}/秒）` : '尚未配置联系邮箱'],
    ['Alpha Vantage预期', config.alphaVantage?.configured ? '已配置，日终自动更新' : '尚未配置API Key'],
    ['富途分钟行情', config.futu?.enabled ? `${config.futu.collector?.status || '等待连接'} · ${config.futu.host}:${config.futu.port}${config.futu.autoLaunchOpenD ? ' · OpenD自动拉起' : ''}` : '未启用'],
    ['自动维护', `每${config.system?.maintenanceCheckMinutes || '—'}分钟检查 · 保留${config.system?.backupRetentionCount || '—'}份备份`],
    ['日终重试', `网络步骤最多${config.system?.dailyCycleRetryAttempts || '—'}次 · 间隔${config.system?.dailyCycleRetryDelayMs ?? '—'}毫秒`],
    ['无人值守日终', `独立线程 · 最多补跑${config.system?.dailyCycleCatchupLimit || '—'}日 · 整体最多尝试${config.system?.dailyCycleAutomationMaxAttempts || '—'}次 · ${config.system?.dailyCycleAutomationRetryMinutes || '—'}分钟后重试 · ${config.system?.dailyCycleWorkerTimeoutMinutes || '—'}分钟超时`],
    ['macOS通知', config.notifications.macosEnabled ? '已启用' : '未启用'],
    ['邮件通知', config.notifications.emailEnabled ? (config.notifications.emailConfigured ? '已配置' : '缺少配置') : '未启用'],
    ['云端LLM', config.llm.enabled ? (config.llm.configured ? config.llm.model : '缺少配置') : '未启用']
  ];
  document.querySelector('#runtime-config').innerHTML = values.map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`).join('');
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(secondsValue) {
  const seconds = Math.max(0, Number(secondsValue || 0));
  if (seconds < 60) return `${Math.round(seconds)}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}小时${minutes ? `${minutes}分钟` : ''}`;
}

function systemBadge(status) {
  if (['HEALTHY', 'CURRENT', 'SUCCESS', 'connected'].includes(status)) return 'buy';
  if (['WARNING', 'RUNNING', 'starting', 'DEGRADED', 'STALE', 'SKIPPED'].includes(status)) return 'P2';
  return 'P1';
}

function renderSystemStatus() {
  const status = state.systemStatus;
  if (!status) return;
  const statusLabels = { HEALTHY: '正常', WARNING: '需关注', ATTENTION: '异常' };
  const futu = status.futu?.collector || {};
  const backups = status.backup?.files || [];
  const currentRows = (status.watchlist || []).filter((item) => item.dailyStatus === 'CURRENT').length;
  const totalRows = (status.watchlist || []).length;
  const latestBackup = backups[0];
  document.querySelector('#system-overall-status').textContent = statusLabels[status.status] || status.status;
  document.querySelector('#system-overall-status').className = status.status === 'HEALTHY' ? 'positive' : 'negative';
  document.querySelector('#system-uptime').textContent = `PID ${status.process.pid} · 已运行 ${formatDuration(status.uptimeSeconds)}`;
  document.querySelector('#system-futu-status').textContent = futu.status === 'connected' ? '已连接' : (futu.status || '未启用');
  document.querySelector('#system-futu-status').className = futu.status === 'connected' ? 'positive' : 'negative';
  document.querySelector('#system-futu-heartbeat').textContent = futu.lastHeartbeatAt
    ? `心跳 ${new Date(futu.lastHeartbeatAt).toLocaleString('zh-CN')} · 自动重连 ${status.futuRecovery?.totalAttempts || 0}次 · OpenD拉起 ${futu.openD?.attempts || 0}次`
    : `尚无采集器心跳 · OpenD拉起 ${futu.openD?.attempts || 0}次`;
  document.querySelector('#system-database-size').textContent = formatBytes(status.database.totalBytes);
  document.querySelector('#system-database-size').className = status.database.totalBytes >= status.database.warningBytes ? 'negative' : '';
  document.querySelector('#system-database-limit').textContent = `预警线 ${formatBytes(status.database.warningBytes)} · 原始逐笔 ${Number(status.database.rowCounts.ticks_intraday || 0).toLocaleString('zh-CN')}条`;
  document.querySelector('#system-backup-status').textContent = latestBackup ? '已备份' : '待备份';
  document.querySelector('#system-backup-status').className = latestBackup ? 'positive' : 'negative';
  document.querySelector('#system-backup-detail').textContent = latestBackup
    ? `${latestBackup.name} · ${formatBytes(latestBackup.sizeBytes)}`
    : `保留最近 ${status.backup.retentionCount} 份`;
  document.querySelector('#system-data-status').textContent = `${currentRows}/${totalRows || 0}`;
  document.querySelector('#system-data-status').className = currentRows === totalRows && totalRows ? 'positive' : 'negative';
  document.querySelector('#system-data-detail').textContent = `预期完整交易日 ${status.expectedMarketDate || '—'}`;
  const automation = status.automation || {};
  const automationLabels = {
    CURRENT: '已完成', RUNNING: '运行中', FAILED: '失败', MISSING: '待补跑'
  };
  document.querySelector('#system-automation-status').textContent = automationLabels[automation.status] || '未启用';
  document.querySelector('#system-automation-status').className = automation.status === 'CURRENT'
    ? 'positive' : ['FAILED', 'MISSING'].includes(automation.status) ? 'negative' : '';
  document.querySelector('#system-automation-detail').textContent = automation.expectedDate
    ? `交易日 ${automation.expectedDate} · 待补 ${automation.missingDates?.length || 0}日${automation.latest?.attempts ? ` · 已尝试${automation.latest.attempts}次` : ''}${automation.worker?.running ? ' · 独立线程运行' : ''}`
    : '尚无自动调度状态';
  const maintenance = status.maintenance?.value;
  document.querySelector('#system-health-summary').textContent = maintenance
    ? `最近维护 ${new Date(maintenance.completedAt).toLocaleString('zh-CN')} · 数据库检查 ${maintenance.integrity} · 清理过期逐笔 ${maintenance.prunedTicks || 0} 条 · 近24小时异常中断 ${status.runtime?.recentInterruptions || 0}次`
    : '尚未完成首次维护检查。';
  document.querySelector('#system-issue-list').innerHTML = status.issues.length
    ? status.issues.map((issue) => `<div class="system-issue ${escapeHtml(issue.severity)}"><span class="badge ${escapeHtml(issue.severity)}">${escapeHtml(issue.severity)}</span><strong>${escapeHtml(issue.ticker || issue.code)}</strong><p>${escapeHtml(issue.message)}</p></div>`).join('')
    : '<div class="system-ok">当前没有发现需要处理的运行或数据异常。</div>';
  document.querySelector('#system-data-body').innerHTML = (status.watchlist || []).map((item) => `
    <tr>
      <td class="ticker">${escapeHtml(item.ticker)}</td>
      <td>${escapeHtml(item.latest_daily_date || '—')}<br><small class="muted">${Number(item.daily_rows || 0).toLocaleString('zh-CN')}条</small></td>
      <td><span class="badge ${systemBadge(item.dailyStatus)}">${item.dailyStatus === 'CURRENT' ? '完整' : item.dailyStatus === 'STALE' ? '滞后' : '缺失'}</span></td>
      <td>${escapeHtml(item.latest_intraday_at || '—')}</td>
      <td>${escapeHtml(item.latest_tick_at || '—')}</td>
    </tr>`).join('');
  document.querySelector('#system-data-empty').classList.toggle('hidden', totalRows > 0);
  document.querySelector('#system-jobs-body').innerHTML = (status.jobs || []).map((job) => {
    const elapsed = job.finished_at
      ? (new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000
      : (Date.now() - new Date(job.started_at).getTime()) / 1000;
    return `<tr>
      <td>${escapeHtml(job.job_name)}</td>
      <td>${new Date(job.started_at).toLocaleString('zh-CN')}</td>
      <td>${formatDuration(elapsed)}</td>
      <td><span class="badge ${systemBadge(job.status)}">${escapeHtml(job.status)}</span></td>
    </tr>`;
  }).join('');
}

function renderDailyOperations() {
  const center = state.dailyOperations;
  const latest = center?.latest;
  const dateInput = document.querySelector('#operation-rerun-date');
  const tickerSelect = document.querySelector('#operation-rerun-ticker');
  if (!dateInput.value && state.systemStatus?.expectedMarketDate) {
    dateInput.value = state.systemStatus.expectedMarketDate;
  }
  const selectedTicker = tickerSelect.value;
  tickerSelect.innerHTML = '<option value="">全部股票</option>' + state.watchlist
    .filter((item) => item.enabled)
    .map((item) => `<option value="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)} · ${escapeHtml(item.name || '未填写名称')}</option>`)
    .join('');
  if ([...tickerSelect.options].some((option) => option.value === selectedTicker)) {
    tickerSelect.value = selectedTicker;
  }
  const statusLabels = {
    SUCCESS: '成功', DEGRADED: '降级', FAILED: '失败', RUNNING: '运行中', SKIPPED: '跳过'
  };
  if (!latest) {
    document.querySelector('#operation-summary').textContent = '尚无日终运行记录。';
    document.querySelector('#operation-steps-body').innerHTML = '';
    document.querySelector('#operation-quality-body').innerHTML = '';
    document.querySelector('#operation-steps-empty').classList.remove('hidden');
    document.querySelector('#operation-quality-empty').classList.remove('hidden');
    return;
  }
  const details = latest.details || {};
  const duration = latest.finished_at
    ? (new Date(latest.finished_at) - new Date(latest.started_at)) / 1000
    : (Date.now() - new Date(latest.started_at)) / 1000;
  document.querySelector('#operation-summary').innerHTML = `最近任务 <strong>#${latest.id}</strong> · ${escapeHtml(details.reviewDate || '—')} · ${escapeHtml(details.ticker || '全部股票')} · ${escapeHtml(statusLabels[latest.status] || latest.status)} · ${formatDuration(duration)}；数据质量 ${escapeHtml(details.qualityStatus || '待检查')}。`;
  const steps = latest.steps || [];
  document.querySelector('#operation-steps-body').innerHTML = steps.map((step) => `
    <tr>
      <td><strong>${escapeHtml(step.step_label)}</strong><br><small class="muted">${escapeHtml(step.step_key)}</small></td>
      <td>第${Number(step.attempt)}次</td>
      <td>${Number(step.item_succeeded)}/${Number(step.item_total)}<br>${step.item_failed ? `<small class="negative">失败${Number(step.item_failed)}项</small>` : ''}</td>
      <td>${step.durationMs == null ? '运行中' : formatDuration(step.durationMs / 1000)}</td>
      <td><span class="badge ${systemBadge(step.status)}">${escapeHtml(statusLabels[step.status] || step.status)}</span>${step.error_message ? `<br><small class="negative">${escapeHtml(step.error_message)}</small>` : ''}</td>
    </tr>`).join('');
  document.querySelector('#operation-steps-empty').classList.toggle('hidden', steps.length > 0);
  const quality = [...(latest.quality || [])].sort((left, right) => {
    const rank = { INCONSISTENT: 0, MISSING: 1, STALE: 2, DEGRADED: 3, CURRENT: 4 };
    return (rank[left.status] ?? 9) - (rank[right.status] ?? 9) || String(left.ticker || '').localeCompare(String(right.ticker || ''));
  });
  const qualityLabels = {
    CURRENT: '正常', STALE: '滞后', MISSING: '缺失', INCONSISTENT: '口径异常', DEGRADED: '降级'
  };
  document.querySelector('#operation-quality-body').innerHTML = quality.map((item) => `
    <tr>
      <td class="ticker">${escapeHtml(item.ticker || '全局')}</td>
      <td>${escapeHtml(item.source_key)}<br><small class="muted">${escapeHtml(item.check_key)}</small></td>
      <td>${escapeHtml(item.actual_date || '—')}<br><small class="muted">预期 ${escapeHtml(item.expected_date || '—')}</small></td>
      <td><span class="badge ${systemBadge(item.status)}">${escapeHtml(qualityLabels[item.status] || item.status)}</span></td>
      <td>${escapeHtml(item.message)}</td>
    </tr>`).join('');
  document.querySelector('#operation-quality-empty').classList.toggle('hidden', quality.length > 0);
}

async function loadSystemStatus() {
  [state.systemStatus, state.dailyOperations] = await Promise.all([
    api('/api/system/status'), api('/api/operations/daily?limit=20')
  ]);
  renderSystemStatus();
  renderDailyOperations();
}

async function loadAll() {
  const [watchlist, portfolio, portfolioRisk, transactions, notifications, reviews, config, currentMonthPerformance, eventFeed, newsArticles, newsSentiment] = await Promise.all([
    api('/api/watchlist'), api('/api/portfolio'), api('/api/portfolio/risk'), api('/api/transactions'),
    api('/api/notifications'), api('/api/reviews'), api('/api/config'),
    api(`/api/performance/monthly?month=${currentEtMonth()}`), api('/api/events?severity=ALL&limit=200'),
    api('/api/news?limit=100'), api('/api/news/sentiment')
  ]);
  Object.assign(state, { watchlist, portfolio, portfolioRisk, transactions, notifications, reviews, config, currentMonthPerformance, eventFeed, newsArticles, newsSentiment });
  renderWatchlist(); renderPortfolio(); renderPortfolioRisk(); renderTransactions(); renderNotifications(); renderEvents(); renderNews(); renderExternalDrivers(); renderCapitalFlow(); renderIntradayFlow(); renderInvestmentAdvice(); renderPredictionOverview(); renderReviews(); renderConfig(); renderDailyOperations();
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function resetWatchlistForm() {
  const form = document.querySelector('#watchlist-form');
  form.reset();
  form.elements.ticker.readOnly = false;
  form.elements.benchmark.value = 'SPY';
  state.editingWatchlistTicker = null;
  document.querySelector('#watchlist-form-eyebrow').textContent = 'ADD SECURITY';
  document.querySelector('#watchlist-form-title').textContent = '添加股票';
  document.querySelector('#watchlist-submit').textContent = '加入股票池';
  document.querySelector('#watchlist-cancel-edit').classList.add('hidden');
}

function editWatchlistItem(ticker) {
  const item = state.watchlist.find((entry) => entry.ticker === ticker);
  if (!item) return;
  const form = document.querySelector('#watchlist-form');
  state.editingWatchlistTicker = ticker;
  form.elements.ticker.value = item.ticker;
  form.elements.ticker.readOnly = true;
  form.elements.name.value = item.name || '';
  form.elements.sector.value = item.sector || '';
  form.elements.industry.value = item.industry || '';
  form.elements.benchmark.value = item.benchmark || 'SPY';
  form.elements.industryEtf.value = item.industry_etf || '';
  form.elements.note.value = item.note || '';
  document.querySelector('#watchlist-form-eyebrow').textContent = 'EDIT SECURITY';
  document.querySelector('#watchlist-form-title').textContent = `修改 ${item.ticker}`;
  document.querySelector('#watchlist-submit').textContent = '保存修改';
  document.querySelector('#watchlist-cancel-edit').classList.remove('hidden');
  form.elements.name.focus();
}

document.querySelector('#nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) showView(button.dataset.view);
});
document.querySelector('#metric-monthly-card').addEventListener('click', () => openMonthlyDetail());
document.querySelector('#monthly-modal').addEventListener('click', (event) => {
  if (event.target.closest('[data-close-monthly]')) closeMonthlyDetail();
});
document.querySelector('#monthly-picker').addEventListener('change', (event) => {
  if (!event.target.value) return;
  loadMonthlyDetail(event.target.value).catch((error) => showToast(error.message, true));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.querySelector('#monthly-modal').classList.contains('hidden')) {
    closeMonthlyDetail();
  }
});
document.body.addEventListener('click', async (event) => {
  const go = event.target.closest('[data-go]');
  if (go) showView(go.dataset.go);
  const monthlyTicker = event.target.closest('[data-monthly-ticker]');
  if (monthlyTicker) openMonthlyDetail(monthlyTicker.dataset.monthlyTicker);
  const toggle = event.target.closest('[data-toggle-ticker]');
  if (toggle) {
    try {
      await api(`/api/watchlist/${encodeURIComponent(toggle.dataset.toggleTicker)}`, { method: 'PATCH', body: JSON.stringify({ enabled: toggle.dataset.enabled !== 'true' }) });
      await loadAll();
    } catch (error) { showToast(error.message, true); }
  }
  const edit = event.target.closest('[data-edit-watchlist]');
  if (edit) editWatchlistItem(edit.dataset.editWatchlist);

  const removeWatchlist = event.target.closest('[data-delete-watchlist]');
  if (removeWatchlist && confirm(`确定将 ${removeWatchlist.dataset.deleteWatchlist} 移出股票池吗？\n\n历史交易和研究数据会保留；如果仍有未清仓持仓，系统会拒绝删除。`)) {
    try {
      const ticker = removeWatchlist.dataset.deleteWatchlist;
      await api(`/api/watchlist/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
      if (state.editingWatchlistTicker === ticker) resetWatchlistForm();
      await loadAll(); showToast(`${ticker} 已移出股票池`);
    } catch (error) { showToast(error.message, true); }
  }
  const remove = event.target.closest('[data-delete-transaction]');
  if (remove && confirm('确定删除这笔交易吗？后续持仓将重新计算。')) {
    try {
      await api(`/api/transactions/${remove.dataset.deleteTransaction}`, { method: 'DELETE' });
      await loadAll(); showToast('交易已删除并重新计算持仓');
    } catch (error) { showToast(error.message, true); }
  }
  const removeEstimateButton = event.target.closest('[data-delete-estimate]');
  if (removeEstimateButton && confirm('确定删除这条预期EPS快照吗？')) {
    try {
      await api(`/api/valuation/estimates/${removeEstimateButton.dataset.deleteEstimate}`, { method: 'DELETE' });
      await loadSelectedValuation(true); showToast('预期EPS快照已删除');
    } catch (error) { showToast(error.message, true); }
  }
});

document.querySelector('#watchlist-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = formData(event.target);
    const editingTicker = state.editingWatchlistTicker;
    const path = editingTicker ? `/api/watchlist/${encodeURIComponent(editingTicker)}` : '/api/watchlist';
    await api(path, { method: editingTicker ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    resetWatchlistForm();
    await loadAll(); showToast(editingTicker ? `${editingTicker} 已更新` : '股票已加入股票池');
  } catch (error) { showToast(error.message, true); }
});

document.querySelector('#watchlist-cancel-edit').addEventListener('click', resetWatchlistForm);

document.querySelector('#sec-ticker').addEventListener('change', () => {
  state.secLoadedTicker = null;
  loadSelectedSecOverview(true).catch((error) => showToast(error.message, true));
});

document.querySelector('#valuation-ticker').addEventListener('change', () => {
  state.valuationLoadedTicker = null;
  loadSelectedValuation(true).catch((error) => showToast(error.message, true));
});

document.querySelector('#valuation-history-years').addEventListener('change', () => {
  state.valuationLoadedTicker = null;
  loadSelectedValuation(true).catch((error) => showToast(error.message, true));
});

document.querySelector('#event-ticker').addEventListener('change', () => {
  loadEventCenter().catch((error) => showToast(error.message, true));
});

document.querySelector('#capital-ticker').addEventListener('change', () => {
  loadCapitalFlow().catch((error) => showToast(error.message, true));
});

document.querySelector('#prediction-ticker').addEventListener('change', () => {
  state.predictionLoadedTicker = null;
  loadPredictionOverview(true).catch((error) => showToast(error.message, true));
});

document.querySelector('#event-severity').addEventListener('change', () => {
  loadEvents().catch((error) => showToast(error.message, true));
});

document.querySelector('#sync-event-sec').addEventListener('click', async (event) => {
  const ticker = document.querySelector('#event-ticker').value;
  if (!ticker) return showToast('请先选择一只股票再同步 SEC', true);
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在同步…';
  try {
    const result = await api('/api/sec/sync', { method: 'POST', body: JSON.stringify({ ticker }) });
    await loadAll();
    document.querySelector('#event-ticker').value = ticker;
    await loadEvents();
    showToast(`${ticker} SEC事件同步完成，新增${result.events?.created || 0}条事件`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '同步所选 SEC';
  }
});

document.querySelector('#sync-event-news').addEventListener('click', async (event) => {
  const ticker = document.querySelector('#event-ticker').value;
  if (!ticker) return showToast('请先选择一只股票再同步新闻', true);
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在同步…';
  try {
    const result = await api('/api/news/sync', {
      method: 'POST', body: JSON.stringify({ ticker, force: true })
    });
    await loadAll();
    document.querySelector('#event-ticker').value = ticker;
    await loadEventCenter();
    showToast(`${ticker} 新闻同步完成，新增${result.newLinks || 0}篇，识别${result.riskEvents || 0}个风险及${result.impactEvents || 0}个驱动信号`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '同步所选新闻';
  }
});

document.querySelector('#sync-market-context').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在同步…';
  try {
    const result = await api('/api/market/context/sync', { method: 'POST', body: '{}' });
    await loadExternalDrivers();
    const failed = (result.results || []).filter((item) => !item.ok).length;
    showToast(failed ? `美债/利率代理已更新，${failed}项失败` : '美债/利率代理已更新', failed > 0);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '同步美债/利率';
  }
});

document.querySelector('#run-capital-flow').addEventListener('click', async (event) => {
  const ticker = document.querySelector('#capital-ticker').value;
  if (!ticker) return showToast('请先选择一只股票', true);
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在识别并回测…';
  try {
    state.capitalFlow = await api('/api/capital-flow/run', {
      method: 'POST', body: JSON.stringify({ ticker })
    });
    state.capitalBehavior = await api('/api/capital-behavior/backtest', {
      method: 'POST', body: JSON.stringify({ ticker })
    });
    state.capitalFlow.history = await api(`/api/capital-flow/history?ticker=${encodeURIComponent(ticker)}&limit=10`);
    state.intradayFlow = await api(`/api/intraday-flow?ticker=${encodeURIComponent(ticker)}&limit=30`);
    renderCapitalBehavior();
    renderCapitalFlow();
    renderIntradayFlow();
    await loadInvestmentAdvice();
    const notified = state.capitalFlow.volumeNotifications?.length || 0;
    showToast(`${ticker} 连续资金行为已更新并验证${state.capitalBehavior.datesProcessed}个交易日${notified ? `，已发送${notified}条放量提醒` : ''}`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '识别并验证资金行为';
  }
});

document.querySelector('#run-prediction-backtest').addEventListener('click', async (event) => {
  const ticker = document.querySelector('#prediction-ticker').value;
  if (!ticker) return showToast('请先选择一只股票', true);
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在回测…';
  try {
    const result = await api('/api/predictions/backtest', {
      method: 'POST', body: JSON.stringify({ ticker })
    });
    state.predictionLoadedTicker = null;
    await loadPredictionOverview(true);
    showToast(`${ticker} 已处理${result.datesProcessed}个历史交易日，更新${result.resultsUpdated}个期限样本`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '生成特征并运行回测';
  }
});

document.querySelector('#restart-futu').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在连接…';
  try {
    const result = await api('/api/futu/restart', { method: 'POST', body: '{}' });
    showToast(result.status === 'missing_sdk' ? result.lastError : '富途分钟行情采集器已启动', result.status === 'missing_sdk');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await loadCapitalFlow();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '连接富途分钟行情';
  }
});

document.querySelector('#capital-flow-content').addEventListener('change', (event) => {
  const key = event.target.dataset.capitalChartSeries;
  if (!key) return;
  if (event.target.checked) state.capitalChartVisible.add(key);
  else state.capitalChartVisible.delete(key);
  renderCapitalFlow();
});

document.querySelector('#run-investment-advice').addEventListener('click', async (event) => {
  const ticker = document.querySelector('#event-ticker').value;
  if (!ticker) return showToast('请先选择一只股票', true);
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在计算…';
  try {
    state.investmentAdvice = await api('/api/advice/run', {
      method: 'POST', body: JSON.stringify({ ticker })
    });
    renderInvestmentAdvice();
    showToast(`${ticker} 的1、3、6个月条件式建议已更新`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '计算投资建议';
  }
});

document.querySelector('#sync-valuation').addEventListener('click', async (event) => {
  const ticker = document.querySelector('#valuation-ticker').value;
  if (!ticker) return showToast('请先选择股票', true);
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在同步…';
  try {
    const result = await api('/api/valuation/sync', { method: 'POST', body: JSON.stringify({ ticker }) });
    state.valuationPeerSelection = result.selection;
    await loadSelectedValuation(true);
    const failures = result.results.reduce((count, item) => (
      count + (item.market?.ok ? 0 : 1) + (item.sec?.ok ? 0 : 1) + (item.earnings?.ok ? 0 : 1)
    ), 0);
    showToast(failures ? `数据同步完成，${failures}项失败或跳过` : `已同步${result.tickers.length}家公司`, failures > 0);
  } catch (error) { showToast(error.message, true); }
  finally {
    button.disabled = false;
    button.textContent = '自动匹配并同步同业';
  }
});

document.querySelector('#valuation-estimate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const ticker = document.querySelector('#valuation-ticker').value;
  if (!ticker) return showToast('请先选择股票', true);
  try {
    await api('/api/valuation/estimates', {
      method: 'POST', body: JSON.stringify({ ...formData(event.target), ticker })
    });
    event.target.reset();
    event.target.elements.asOf.value = currentEtDate();
    await loadSelectedValuation(true); showToast('NTM预期EPS快照已保存');
  } catch (error) { showToast(error.message, true); }
});

document.querySelector('#sync-sec').addEventListener('click', async (event) => {
  const ticker = document.querySelector('#sec-ticker').value;
  if (!ticker) return showToast('请先选择股票', true);
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在同步…';
  try {
    await api('/api/sec/sync', { method: 'POST', body: JSON.stringify({ ticker }) });
    await loadSelectedSecOverview(true);
    showToast(`${ticker} SEC数据同步完成`);
  } catch (error) {
    showToast(error.message, true);
    await loadSelectedSecOverview(true).catch(() => {});
  } finally {
    button.disabled = false;
    button.textContent = '同步 SEC 数据';
  }
});

document.querySelector('#transaction-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/transactions', { method: 'POST', body: JSON.stringify(formData(event.target)) });
    event.target.reset(); event.target.elements.fee.value = '0';
    await loadAll(); showToast('交易已保存，持仓已重新计算');
  } catch (error) { showToast(error.message, true); }
});

document.querySelector('#transaction-import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = document.querySelector('#transaction-import-file').files[0];
  if (!file) return showToast('请选择交易文件', true);
  if (file.size > 5 * 1024 * 1024) return showToast('交易文件不能超过5MB', true);
  const button = document.querySelector('#validate-transaction-import');
  button.disabled = true;
  button.textContent = '正在预检…';
  try {
    const dataBase64 = await fileAsDataUrl(file);
    const result = await api('/api/transactions/import/validate', {
      method: 'POST', body: JSON.stringify({ fileName: file.name, dataBase64 })
    });
    renderTransactionImportResult(result, file.name);
    showToast(result.valid ? '交易文件预检通过' : '交易文件存在问题，请检查', !result.valid);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '预检文件';
  }
});

document.querySelector('#commit-transaction-import').addEventListener('click', async (event) => {
  if (!state.transactionImportToken) return showToast('请先重新预检交易文件', true);
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在导入…';
  try {
    const result = await api('/api/transactions/import/commit', {
      method: 'POST', body: JSON.stringify({ token: state.transactionImportToken })
    });
    resetTransactionImport();
    await loadAll();
    const added = result.addedStocks.length ? `，新增${result.addedStocks.length}只股票到股票池` : '';
    showToast(`已导入${result.imported}笔交易${added}`);
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
    button.textContent = '确认批量导入';
  }
});

document.querySelector('#price-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/prices/manual', { method: 'POST', body: JSON.stringify(formData(event.target)) });
    await loadAll(); showToast('收盘价已保存');
  } catch (error) { showToast(error.message, true); }
});

document.querySelector('#refresh-market').addEventListener('click', async () => {
  try {
    showToast('正在更新行情…');
    const result = await api('/api/market/refresh', { method: 'POST' });
    await loadAll();
    const failed = result.results.filter((item) => !item.ok).length;
    showToast(failed ? `行情更新完成，${failed}只股票失败` : '行情更新完成', failed > 0);
  } catch (error) { showToast(error.message, true); }
});

document.querySelector('#run-daily').addEventListener('click', async () => {
  try {
    showToast('正在执行日终任务…');
    const result = await api('/api/daily-cycle', { method: 'POST' });
    await loadAll();
    showToast(result.status === 'SUCCESS' ? '日终收益与复盘已完成' : '日终任务完成，但存在降级或失败项', result.status !== 'SUCCESS');
  } catch (error) { showToast(error.message, true); }
});

document.querySelector('#generate-reviews').addEventListener('click', async () => {
  try {
    await api('/api/reviews/run', { method: 'POST' });
    await loadAll(); showToast('复盘已生成');
  } catch (error) { showToast(error.message, true); }
});

document.querySelector('#test-notification').addEventListener('click', async () => {
  try {
    await api('/api/notifications/test', { method: 'POST' });
    await loadAll(); showToast('测试通知已发送');
  } catch (error) { showToast(error.message, true); }
});

document.querySelector('#operation-rerun').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const analysisDate = document.querySelector('#operation-rerun-date').value;
  const ticker = document.querySelector('#operation-rerun-ticker').value;
  button.disabled = true;
  button.textContent = '正在重新运行…';
  try {
    const result = await api('/api/operations/daily/rerun', {
      method: 'POST', body: JSON.stringify({ analysisDate, ticker: ticker || null })
    });
    await Promise.all([loadAll(), loadSystemStatus()]);
    showToast(
      result.status === 'SUCCESS'
        ? `${analysisDate} ${ticker || '全部股票'}重新运行完成`
        : `重新运行完成，但状态为${result.status}`,
      result.status !== 'SUCCESS'
    );
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '重新运行';
  }
});

document.querySelector('#run-system-maintenance').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在检查与备份…';
  try {
    const result = await api('/api/system/maintenance', { method: 'POST', body: '{}' });
    await loadSystemStatus();
    state.notifications = await api('/api/notifications');
    renderNotifications();
    const backupText = result.backup?.skipped ? '今日备份已存在' : '数据库备份已生成';
    showToast(`维护完成：数据库${result.integrity === 'ok' ? '正常' : '异常'}，${backupText}`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '立即检查并备份';
  }
});

applyTheme(document.documentElement.dataset.theme || 'system');
document.querySelector('#theme-select').addEventListener('change', (event) => {
  const selected = applyTheme(event.target.value, true);
  const labels = { system: '跟随系统', light: '浅色', dark: '深色' };
  showToast(`桌面主题已切换为${labels[selected]}`);
});

document.querySelector('#valuation-estimate-form').elements.asOf.value = currentEtDate();
loadAll().catch((error) => showToast(`加载失败：${error.message}`, true));

setInterval(async () => {
  if (document.hidden || !document.querySelector('#view-capital').classList.contains('active')) return;
  const ticker = document.querySelector('#capital-ticker').value;
  if (!ticker) return;
  try {
    state.intradayFlow = await api(`/api/intraday-flow?ticker=${encodeURIComponent(ticker)}&limit=30`);
    renderIntradayFlow();
  } catch {
    // 后台轮询失败时保留最后一次可用结果，手动操作仍会显示明确错误。
  }
}, 15_000);

setInterval(() => {
  if (document.hidden || !document.querySelector('#view-settings').classList.contains('active')) return;
  loadSystemStatus().catch(() => {
    // 状态页轮询失败时保留最后一次结果，顶部提示仍可反映后续手动操作错误。
  });
}, 30_000);
