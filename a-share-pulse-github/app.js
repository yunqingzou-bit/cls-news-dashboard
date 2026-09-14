(() => {
  'use strict';

  const EM = 'https://push2.eastmoney.com/api/qt';
  const EM_HIS = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
  const UT = 'fa5fd1943c7b386f172d6893dbfba10b';
  const MARKET_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
  const INDEX_IDS = '1.000001,0.399001,0.399006,1.000300,1.000688';
  const state = { indices: [], stocks: [], sectors: [], breadth: null, rank: 'rise', filter: 'all', query: '', loading: false, error: '', favorites: new Set(JSON.parse(localStorage.getItem('a-share-pulse-favorites') || '[]')) };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const text = (value) => value == null || value === '-' || value === '' ? '—' : String(value);
  const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : null; };
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
  const pct = (value) => { const n = num(value); return n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`; };
  const price = (value) => { const n = num(value); return n == null ? '—' : n.toFixed(n >= 100 ? 2 : 2); };
  const amount = (value) => { const n = num(value); if (n == null) return '—'; if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`; if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}万`; return `${Math.round(n)}`; };
  const tone = (value) => { const n = num(value); return n == null || n === 0 ? 'neutral' : n > 0 ? 'up' : 'down'; };
  const rows = (diff) => Array.isArray(diff) ? diff : diff && typeof diff === 'object' ? Object.values(diff) : [];
  const url = (path, params) => `${EM}/${path}?${new URLSearchParams({ ut: UT, ...params })}`;

  async function getJson(requestUrl, timeout = 14000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(requestUrl, { cache: 'no-store', signal: controller.signal, mode: 'cors' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!body || body.rc !== 0 || !body.data) throw new Error(body?.message || '东方财富返回空数据');
      return body.data;
    } finally { clearTimeout(timer); }
  }

  function setConnection(mode, label) {
    const el = $('#liveState');
    el.className = `live-state ${mode}`;
    $('span:last-child', el).textContent = label;
    $('#footerStatus').textContent = label;
  }

  function renderIndices() {
    $('#indexGrid').innerHTML = state.indices.length ? state.indices.map((item) => `<div class="index-card"><span class="name">${esc(item.name)}</span><strong class="value">${price(item.price)}</strong><span class="change ${tone(item.changePct)}">${pct(item.changePct)}</span></div>`).join('') : '<div class="empty-inline">未取得实时指数</div>';
  }

  function renderMood() {
    const b = state.breadth;
    if (!b) return;
    const total = b.up + b.down + b.flat || 1;
    const score = Math.round((b.up / total) * 100);
    const strength = Math.round(((b.up - b.down) / total) * 100);
    const label = strength >= 24 ? '偏强' : strength >= 6 ? '温和偏强' : strength <= -24 ? '偏弱' : strength <= -6 ? '温和偏弱' : '震荡';
    $('#moodScore').textContent = score;
    $('#moodLabel').textContent = label;
    $('#moodHint').textContent = `${b.total.toLocaleString()} 只股票的涨跌分布`;
    $('#upCount').textContent = b.up.toLocaleString(); $('#downCount').textContent = b.down.toLocaleString(); $('#flatCount').textContent = b.flat.toLocaleString();
    $('#upBar').style.width = `${b.up / total * 100}%`; $('#downBar').style.width = `${b.down / total * 100}%`; $('#flatBar').style.width = `${b.flat / total * 100}%`;
    $('#moodRing').style.background = `radial-gradient(circle at center,#101d32 57%,transparent 58%),conic-gradient(var(--accent) ${score * 3.6}deg,rgba(255,255,255,.13) 0deg)`;
  }

  function sortStocks() {
    const copy = [...state.stocks];
    if (state.rank === 'turnover') return copy.sort((a,b) => (b.turnover || -Infinity) - (a.turnover || -Infinity));
    if (state.rank === 'amount') return copy.sort((a,b) => (b.amount || -Infinity) - (a.amount || -Infinity));
    return copy.sort((a,b) => (b.changePct || -Infinity) - (a.changePct || -Infinity));
  }

  function renderPulse() {
    const list = sortStocks().slice(0, 8);
    $('#pulseList').innerHTML = list.length ? list.map((s, i) => `<div class="pulse-row" data-code="${esc(s.code)}"><span class="rank">${String(i + 1).padStart(2,'0')}</span><div class="stock-name"><strong>${esc(s.name)}</strong><small>${esc(s.code)}</small></div><strong class="pulse-value ${tone(s.changePct)}">${pct(s.changePct)}</strong><span class="pulse-metric"><span>换手</span>${s.turnover == null ? '—' : `${s.turnover.toFixed(2)}%`}</span><span class="pulse-metric"><span>成交额</span>${amount(s.amount)}</span></div>`).join('') : '<div class="empty-state"><b>没有取得可展示的实时个股</b><small>请确认当前网络允许访问东方财富</small></div>';
    $('#pulseMeta').textContent = state.stocks.length ? `实时拉取 ${state.stocks.length} 只活跃股票` : '等待真实数据';
  }

  function renderSectors() {
    const list = state.sectors.slice(0, 8);
    $('#sectorList').innerHTML = list.length ? list.map((s, i) => `<div class="sector-row"><span class="sector-rank">${String(i + 1).padStart(2,'0')}</span><span class="sector-name" title="${esc(s.name)}">${esc(s.name)}</span><span class="sector-bar"><i style="width:${Math.min(100, Math.max(4, Math.abs(s.changePct || 0) * 12))}%"></i></span><strong class="sector-value ${tone(s.changePct)}">${pct(s.changePct)}</strong></div>`).join('') : '<div class="empty-state compact"><b>没有取得行业实时数据</b><small>等待下一次刷新</small></div>';
  }

  function filteredStocks() {
    let list = sortStocks();
    if (state.filter === 'favorite') list = list.filter((s) => state.favorites.has(s.code));
    const q = state.query.trim().toLowerCase();
    return q ? list.filter((s) => `${s.code} ${s.name}`.toLowerCase().includes(q)) : list;
  }

  function renderTable() {
    const list = filteredStocks().slice(0, 60);
    $('#favoriteCount').textContent = state.favorites.size;
    $('#tapeMeta').textContent = state.stocks.length ? `展示 ${list.length} / ${state.stocks.length} 只实时股票` : '等待真实数据';
    $('#marketBody').innerHTML = list.length ? list.map((s) => `<tr data-code="${esc(s.code)}"><td><div class="table-stock"><button class="star ${state.favorites.has(s.code) ? 'on' : ''}" data-action="favorite" data-code="${esc(s.code)}" aria-label="${state.favorites.has(s.code) ? '取消关注' : '加入关注'}" type="button">★</button><div><strong>${esc(s.name)}</strong><small>${esc(s.code)}</small></div></div></td><td><strong>${price(s.price)}</strong></td><td class="${tone(s.changePct)}"><strong>${pct(s.changePct)}</strong></td><td>${amount(s.amount)}</td><td>${s.turnover == null ? '—' : `${s.turnover.toFixed(2)}%`}</td><td><span class="status-label">${s.changePct >= 9.5 ? '涨停附近' : s.changePct <= -9.5 ? '跌停附近' : s.changePct > 3 ? '脉冲上行' : s.changePct < -3 ? '快速回落' : '盘中波动'}</span></td><td><button class="link-button" data-action="detail" data-code="${esc(s.code)}" aria-label="查看详情" type="button">↗</button></td></tr>`).join('') : '<tr><td colspan="7"><div class="empty-state table-empty"><b>没有可展示的实时数据</b><small>没有用静态样例填充，请刷新或检查网络</small></div></td></tr>';
  }

  function normalizeStock(row) { return { code: text(row.f12), name: text(row.f14), price: num(row.f2), changePct: num(row.f3), change: num(row.f4), amount: num(row.f6), turnover: num(row.f8), amplitude: num(row.f7), volumeRatio: num(row.f10), high: num(row.f15), low: num(row.f16), prev: num(row.f18) }; }
  function normalizeIndex(row) { return { code: text(row.f12), name: text(row.f14), price: num(row.f2), changePct: num(row.f3), change: num(row.f4) }; }
  function normalizeSector(row) { return { code: text(row.f12), name: text(row.f14), changePct: num(row.f3), amount: num(row.f6) }; }

  async function loadMarket() {
    if (state.loading) return;
    state.loading = true; state.error = ''; setConnection('busy', '正在拉取行情');
    try {
      const fields = 'f2,f3,f4,f6,f7,f8,f10,f12,f14,f15,f16,f18';
      const [indexData, stockData, sectorData, breadthData] = await Promise.all([
        getJson(url('ulist.np/get', { fltt: 2, invt: 2, fields, secids: INDEX_IDS })),
        getJson(url('clist/get', { fltt: 2, invt: 2, fid: 'f3', po: 1, pn: 1, pz: 80, fs: MARKET_FS, fields })),
        getJson(url('clist/get', { fltt: 2, invt: 2, fid: 'f3', po: 1, pn: 1, pz: 40, fs: 'm:90+t:2', fields: 'f2,f3,f4,f6,f12,f14' })),
        getJson(url('clist/get', { fltt: 2, invt: 2, fid: 'f3', po: 1, pn: 1, pz: 6000, fs: MARKET_FS, fields: 'f3,f12' }))
      ]);
      state.indices = rows(indexData.diff).map(normalizeIndex).filter((x) => x.code !== '—');
      state.stocks = rows(stockData.diff).map(normalizeStock).filter((x) => x.code !== '—' && x.name !== '—' && x.price != null);
      state.sectors = rows(sectorData.diff).map(normalizeSector).filter((x) => x.name !== '—' && x.changePct != null);
      const breadthRows = rows(breadthData.diff); const changes = breadthRows.map((x) => num(x.f3)).filter((x) => x != null); const up = changes.filter((x) => x > 0).length; const down = changes.filter((x) => x < 0).length;
      state.breadth = { up, down, flat: changes.length - up - down, total: changes.length };
      renderAll(); const now = new Date(); $('#updatedAt').textContent = `更新 ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`; setConnection('ok', '实时已连接');
    } catch (error) {
      state.error = error?.name === 'AbortError' ? '东方财富接口请求超时' : error?.message || '实时行情请求失败';
      setConnection('error', '连接失败'); showToast(`${state.error}，请稍后重试`); renderAll();
    } finally { state.loading = false; }
  }

  function renderAll() { renderIndices(); renderMood(); renderPulse(); renderSectors(); renderTable(); }
  function saveFavorites() { localStorage.setItem('a-share-pulse-favorites', JSON.stringify([...state.favorites])); }
  function showToast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => el.classList.remove('show'), 2800); }

  async function showDetail(code) {
    const stock = state.stocks.find((item) => item.code === code); if (!stock) return;
    $('#dialogTitle').textContent = stock.name; $('#dialogSub').textContent = `${stock.code} · 东方财富实时行情`; $('#eastmoneyLink').href = `https://quote.eastmoney.com/${/^6/.test(code) ? 'sh' : 'sz'}${encodeURIComponent(code)}.html`;
    const q = $('#dialogQuote'); q.innerHTML = `<div><span>现价</span><strong>${price(stock.price)}</strong></div><div><span>涨跌幅</span><strong class="${tone(stock.changePct)}">${pct(stock.changePct)}</strong></div><div><span>成交额</span><strong>${amount(stock.amount)}</strong></div><div><span>换手率</span><strong>${stock.turnover == null ? '—' : `${stock.turnover.toFixed(2)}%`}</strong></div>`;
    $('#chartStatus').textContent = '正在加载真实K线'; $('#chartLine').setAttribute('d',''); $('#chartFill').setAttribute('d',''); $('#detailDialog').showModal();
    try {
      const secid = `${/^6/.test(code) ? 1 : 0}.${code}`;
      const data = await getJson(`${EM_HIS}?${new URLSearchParams({ secid, klt: 101, fqt: 1, beg: '0', end: '20500101', fields1: 'f1,f2,f3,f4', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61', ut: UT })}`);
      const candles = (data.klines || []).slice(-30).map((line) => line.split(',')).filter((x) => num(x[2]) != null); drawChart(candles); $('#chartStatus').textContent = candles.length ? `最新 ${candles[candles.length - 1][0]}` : '无可用K线';
    } catch { $('#chartStatus').textContent = 'K线暂时不可用'; }
  }

  function drawChart(candles) {
    if (!candles.length) return; const values = candles.map((x) => num(x[2])).filter((x) => x != null); const min = Math.min(...values); const max = Math.max(...values); const spread = max - min || 1; const points = values.map((value, i) => `${(i / Math.max(1, values.length - 1)) * 720},${198 - ((value - min) / spread) * 170}`).join(' '); $('#chartLine').setAttribute('d', `M${points.replaceAll(' ', ' L')}`); $('#chartFill').setAttribute('d', `M${points.replaceAll(' ', ' L')} L720 210 L0 210 Z`);
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action], [data-rank], [data-filter], .pulse-row, tbody tr'); if (!target) return;
    if (target.dataset.action === 'refresh') loadMarket();
    if (target.dataset.action === 'close-dialog') $('#detailDialog').close();
    if (target.dataset.action === 'favorite') { const code = target.dataset.code; state.favorites.has(code) ? state.favorites.delete(code) : state.favorites.add(code); saveFavorites(); renderTable(); }
    if (target.dataset.action === 'detail') showDetail(target.dataset.code);
    if (target.dataset.rank) { state.rank = target.dataset.rank; $$('.segmented button').forEach((button) => button.classList.toggle('active', button.dataset.rank === state.rank)); renderPulse(); renderTable(); }
    if (target.dataset.filter) { state.filter = target.dataset.filter; $$('.filter-button').forEach((button) => button.classList.toggle('active', button.dataset.filter === state.filter)); renderTable(); }
    if (target.classList.contains('pulse-row')) showDetail(target.dataset.code);
    if (target.tagName === 'TR' && target.dataset.code && !event.target.closest('button')) showDetail(target.dataset.code);
  });
  $('#searchInput').addEventListener('input', (event) => { state.query = event.target.value; renderTable(); });
  $('#detailDialog').addEventListener('click', (event) => { if (event.target === $('#detailDialog')) $('#detailDialog').close(); });
  renderAll(); loadMarket(); setInterval(() => { if (document.visibilityState === 'visible') loadMarket(); }, 90000);
})();
