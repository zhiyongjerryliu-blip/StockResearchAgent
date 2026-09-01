const state = {
  watchlist: [], portfolio: null, transactions: [], notifications: [], reviews: [], config: null,
  editingWatchlistTicker: null, secOverview: null, secLoadedTicker: null
};

const titles = {
  dashboard: '投资组合总览', watchlist: '股票池管理', transactions: '交易与持仓',
  financials: '财报分析', reviews: '收盘复盘', settings: '系统状态'
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
}

function renderWatchlist() {
  const body = document.querySelector('#watchlist-body');
  body.innerHTML = state.watchlist.map((item) => `
    <tr>
      <td class="ticker">${escapeHtml(item.ticker)}</td>
      <td>${escapeHtml(item.name || '—')}</td>
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

function renderPortfolio() {
  const portfolio = state.portfolio || { positions: [], totals: {} };
  const metricMap = [
    ['#metric-value', portfolio.totals.marketValue, false],
    ['#metric-daily', portfolio.totals.dailyPnl, true],
    ['#metric-unrealized', portfolio.totals.unrealizedPnl, true],
    ['#metric-total', portfolio.totals.totalPnl, true]
  ];
  for (const [selector, value, isPnl] of metricMap) {
    const element = document.querySelector(selector);
    element.textContent = money(value || 0);
    element.className = isPnl ? pnlClass(value) : '';
  }
  const held = portfolio.positions.filter((position) => position.quantity > 0);
  document.querySelector('#positions-body').innerHTML = held.map((position) => `
    <tr>
      <td><span class="ticker">${position.ticker}</span><br><small class="muted">${escapeHtml(position.name || '')}</small></td>
      <td>${position.quantity}</td><td>${money(position.averageCost)}</td><td>${money(position.currentPrice)}</td>
      <td class="${pnlClass(position.dailyPnl)}">${money(position.dailyPnl)}</td>
      <td class="${pnlClass(position.totalPnl)}">${money(position.totalPnl)}</td>
      <td class="${pnlClass(position.totalReturn)}">${percent(position.totalReturn)}</td>
    </tr>`).join('');
  document.querySelector('#positions-empty').classList.toggle('hidden', held.length > 0);
  document.querySelector('#last-updated').textContent = `更新于 ${new Date(portfolio.asOf || Date.now()).toLocaleString('zh-CN')}`;
}

function renderTransactions() {
  document.querySelector('#transactions-body').innerHTML = state.transactions.map((tx) => `
    <tr>
      <td>${new Date(tx.trade_time).toLocaleString('zh-CN')}</td><td class="ticker">${tx.ticker}</td>
      <td><span class="badge ${tx.side === 'BUY' ? 'buy' : 'sell'}">${tx.side === 'BUY' ? '买入' : '卖出'}</span></td>
      <td>${tx.quantity}</td><td>${money(tx.price)}</td><td>${money(tx.fee)}</td>
      <td><button class="danger-link" data-delete-transaction="${tx.id}">删除</button></td>
    </tr>`).join('');
  document.querySelector('#transactions-empty').classList.toggle('hidden', state.transactions.length > 0);
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
    ['macOS通知', config.notifications.macosEnabled ? '已启用' : '未启用'],
    ['邮件通知', config.notifications.emailEnabled ? (config.notifications.emailConfigured ? '已配置' : '缺少配置') : '未启用'],
    ['云端LLM', config.llm.enabled ? (config.llm.configured ? config.llm.model : '缺少配置') : '未启用']
  ];
  document.querySelector('#runtime-config').innerHTML = values.map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`).join('');
}

async function loadAll() {
  const [watchlist, portfolio, transactions, notifications, reviews, config] = await Promise.all([
    api('/api/watchlist'), api('/api/portfolio'), api('/api/transactions'),
    api('/api/notifications'), api('/api/reviews'), api('/api/config')
  ]);
  Object.assign(state, { watchlist, portfolio, transactions, notifications, reviews, config });
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
document.body.addEventListener('click', async (event) => {
  const go = event.target.closest('[data-go]');
  if (go) showView(go.dataset.go);
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

loadAll().catch((error) => showToast(`加载失败：${error.message}`, true));
