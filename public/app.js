const state = {
  watchlist: [], portfolio: null, transactions: [], notifications: [], reviews: [], config: null,
  editingWatchlistTicker: null, secOverview: null, secLoadedTicker: null,
  valuationOverview: null, valuationLoadedTicker: null,
  valuationPeerSelection: null,
  currentMonthPerformance: null, monthlyDetail: null, monthlyTickerFilter: null,
  transactionImportToken: null
};

const titles = {
  dashboard: '投资组合总览', watchlist: '股票池管理', transactions: '交易与持仓',
  financials: '财报分析', valuation: '估值与竞争对手', reviews: '收盘复盘', settings: '系统状态'
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

function renderValuation(overview) {
  state.valuationOverview = overview;
  state.valuationLoadedTicker = overview?.target?.ticker || null;
  const target = overview?.target;
  const median = overview?.peerMedian;
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
  renderValuation(await api(`/api/valuation/overview?ticker=${encodeURIComponent(ticker)}`));
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
    ['macOS通知', config.notifications.macosEnabled ? '已启用' : '未启用'],
    ['邮件通知', config.notifications.emailEnabled ? (config.notifications.emailConfigured ? '已配置' : '缺少配置') : '未启用'],
    ['云端LLM', config.llm.enabled ? (config.llm.configured ? config.llm.model : '缺少配置') : '未启用']
  ];
  document.querySelector('#runtime-config').innerHTML = values.map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`).join('');
}

async function loadAll() {
  const [watchlist, portfolio, transactions, notifications, reviews, config, currentMonthPerformance] = await Promise.all([
    api('/api/watchlist'), api('/api/portfolio'), api('/api/transactions'),
    api('/api/notifications'), api('/api/reviews'), api('/api/config'),
    api(`/api/performance/monthly?month=${currentEtMonth()}`)
  ]);
  Object.assign(state, { watchlist, portfolio, transactions, notifications, reviews, config, currentMonthPerformance });
  renderWatchlist(); renderPortfolio(); renderTransactions(); renderNotifications(); renderReviews(); renderConfig();
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
    await api('/api/daily-cycle', { method: 'POST' });
    await loadAll(); showToast('日终收益与复盘已完成');
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

document.querySelector('#valuation-estimate-form').elements.asOf.value = currentEtDate();
loadAll().catch((error) => showToast(`加载失败：${error.message}`, true));
