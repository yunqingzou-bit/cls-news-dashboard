'use strict';

// 按沪深全市场快照生成盘前、10点、午盘和盘后复盘，并保留近30日记录。
const fs = require('node:fs');
const path = require('node:path');
const quotes = require('../src/quotes.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const HISTORY = path.join(OUT, 'market-review.json');
const MARKET = path.join(ROOT, 'data', 'market.json');
const NEWS = path.join(OUT, 'cls-news-latest.json');
const PAGE = path.join(ROOT, 'market-review', 'index.html');
const MAX_DAYS = 30;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function shanghai(ms) {
  const o = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
  return { date: o.year + '-' + o.month + '-' + o.day, hm: o.hour + ':' + o.minute, hour: Number(o.hour), minute: Number(o.minute), weekday: o.weekday };
}
function stageAt(p) {
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return '';
  const m = p.hour * 60 + p.minute;
  if (m >= 7 * 60 && m < 9 * 60 + 30) return 'premarket';
  if (m >= 10 * 60 && m < 11 * 60 + 30) return 'morning';
  if (m >= 12 * 60 && m < 14 * 60) return 'noon';
  if (m >= 15 * 60 && m < 20 * 60) return 'close';
  return '';
}
function compact(card) {
  return { updatedAt: card.updatedAt, updatedText: card.updatedText, total: card.total, indexes: card.indexes || [], breadth: card.breadth || {}, themes: card.themes || [], industries: card.industries || [], hotGain: card.hotGain || [], hotFund: card.hotFund || [], outlook: card.outlook || {} };
}
function signed(v, digits) {
  const n = Number(v);
  return Number.isFinite(n) ? (n > 0 ? '+' : '') + n.toFixed(digits == null ? 2 : digits) : '—';
}
function tone(card) {
  const b = card.breadth || {}, ix = card.indexes || [];
  const up = Number(b.up) || 0, down = Number(b.down) || 0;
  const positive = ix.filter(function (x) { return Number(x.pct) > 0; }).length;
  if (up > down * 1.3 && positive >= Math.ceil(ix.length * .75)) return '偏强';
  if (up > down && positive >= Math.ceil(ix.length / 2)) return '震荡偏强';
  if (down > up * 1.3 && positive <= Math.floor(ix.length / 4)) return '偏弱';
  if (down > up) return '震荡偏弱';
  return '多空分化';
}
function headlines(rows, date) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter(function (r) {
    if (!r || !r.title || !r.url || String(r.time || '').slice(0, 10) >= date) return false;
    const id = String(r.articleId || r.url);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).sort(function (a, b) { return String(b.time || '').localeCompare(String(a.time || '')); }).slice(0, 10)
    .map(function (r) { return { time: r.time, prefix: r.prefix, title: r.title, url: r.url }; });
}
function comparison(card, prior, label) {
  if (!prior || !prior.snapshot) return null;
  const old = prior.snapshot, oldIndex = {};
  (old.indexes || []).forEach(function (x) { oldIndex[x.code] = Number(x.pct); });
  const b = card.breadth || {}, ob = old.breadth || {};
  return {
    label: label,
    indexes: (card.indexes || []).map(function (x) { return { name: x.name, delta: Number.isFinite(oldIndex[x.code]) ? Number(x.pct) - oldIndex[x.code] : null }; }),
    up: (Number(b.up) || 0) - (Number(ob.up) || 0), down: (Number(b.down) || 0) - (Number(ob.down) || 0),
    fundYi: (Number(b.fundYi) || 0) - (Number(ob.fundYi) || 0),
    limitUp: (Number(b.limitUp) || 0) - (Number(ob.limitUp) || 0), limitDown: (Number(b.limitDown) || 0) - (Number(ob.limitDown) || 0),
  };
}
function makeReport(stage, card, date, hm, news, prior, referenceDate) {
  const b = card.breadth || {}, ix = card.indexes || [], mood = tone(card);
  const sectors = ((card.outlook && card.outlook.sectors && card.outlook.sectors.length) ? card.outlook.sectors : card.themes || []).slice(0, 6);
  const delta = stage === 'noon' ? comparison(card, prior.morning, '对比10点')
    : stage === 'close' ? comparison(card, prior.noon || prior.morning, prior.noon ? '对比午盘' : '对比早盘') : null;
  const up = Number(b.up) || 0, down = Number(b.down) || 0;
  let conclusion;
  if (stage === 'premarket') {
    conclusion = '盘前基准取自最近一次可用的全市场行情（' + (card.updatedText || card.updatedAt || '时间未知') + '）。以下先复核前一交易日结构与隔夜新闻；开盘后的方向要由指数、涨跌家数和资金流共同确认。';
  } else {
    conclusion = '当前定性为“' + mood + '”：主要指数' + ix.length + '个中' + ix.filter(function (x) { return Number(x.pct) > 0; }).length + '个上涨；全市场上涨' + up + '家、下跌' + down + '家，涨跌家数差' + signed(up - down, 0) + '；主力净流入' + signed(b.fundYi, 1) + '亿元。';
  }
  let follow;
  if (stage === 'premarket') {
    follow = ['开盘确认指数是否同步，单一指数高开不能单独视作市场转强。', '观察上涨家数差、涨停与跌停数量及主力资金是否同向改善。', '跟踪下面的强势方向和隔夜新闻；若开盘后资金转弱，减少追高。'];
  } else if (mood === '偏强' || mood === '震荡偏强') {
    follow = ['看领涨题材能否扩散到多只成分股，回落时关注成交与资金承接。', '若指数仍涨而上涨家数收窄，注意权重拉指数、个股赚钱效应走弱的分化。', '涨停减少而跌停或炸板增加时，短线情绪转弱的信号优先级提高。'];
  } else {
    follow = ['观察指数止跌和上涨家数回升；广度改善前按震荡或防守情景跟踪。', '优先保留多股共振且有资金配合的题材，谨慎看待孤立冲高。', '持续比较涨跌停和净流入，等待指数、广度、资金给出一致信号。'];
  }
  if (delta) {
    follow.unshift(delta.label + '：已计算指数涨跌幅、涨跌家数、主力资金及涨跌停的变化，用来观察盘中动能扩散或收敛。');
    if (delta.up < 0 && delta.down > 0) follow.push('较前一时段上涨家数减少、下跌家数增加，盘中广度转弱，谨慎解读指数反弹。');
  }
  const indexByName = function (name) { const x = ix.find(function (v) { return v.name === name; }); return x ? signed(x.pct, 2) + '%' : '—'; };
  const metrics = [
    { label: '上证指数', value: indexByName('上证指数') }, { label: '深证成指', value: indexByName('深证成指') },
    { label: '上涨 / 下跌', value: up + ' / ' + down }, { label: '涨停 / 跌停', value: (b.limitUp || 0) + ' / ' + (b.limitDown || 0) },
    { label: '主力净流入', value: signed(b.fundYi, 1) + '亿元' },
  ];
  return {
    stage: stage, capturedAt: date + ' ' + hm, marketTime: card.updatedText || '—', referenceDate: referenceDate || '', tone: mood, conclusion: conclusion,
    metrics: metrics, indexes: ix.map(function (x) { return { name: x.name, code: x.code, px: Number(x.px), pct: Number(x.pct) }; }),
    sectors: sectors, leaders: (card.hotGain || []).slice(0, 5), funds: (card.hotFund || []).slice(0, 5),
    comparison: delta, follow: follow, headlines: stage === 'premarket' ? news : [], snapshot: compact(card),
  };
}
function pageHtml(data) {
  const day = data.days[data.today] || { reports: {} }, reports = day.reports || {};
  const labels = [['premarket', '盘前分析'], ['morning', '10:00 早盘复盘'], ['noon', '12:00 午盘复盘'], ['close', '盘后今日复盘']];
  const signClass = function (n) { return Number(n) > 0 ? 'up' : Number(n) < 0 ? 'down' : ''; };
  const rows = function (arr, type) {
    return (arr || []).map(function (x) {
      const link = 'https://gu.qq.com/' + encodeURIComponent(x.code || '');
      return '<tr><td><a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(x.name) + '</a></td><td class="' + signClass(x.pct) + '">' + signed(x.pct, 2) + '%</td>' + (type === 'fund' ? '<td>' + signed(x.fundYi, 2) + '亿</td>' : '') + '</tr>';
    }).join('');
  };
  const section = function (key, label) {
    const r = reports[key];
    if (!r) return '<section id="' + key + '" class="pending"><h2>' + esc(label) + '</h2><p>等待该时段行情快照后自动生成。页面会随看板定时发布更新。</p></section>';
    const indexRows = (r.indexes || []).map(function (x) {
      const d = r.comparison && r.comparison.indexes.find(function (v) { return v.name === x.name; });
      return '<tr><td>' + esc(x.name) + '</td><td>' + (Number.isFinite(x.px) ? x.px.toFixed(2) : '—') + '</td><td class="' + signClass(x.pct) + '">' + signed(x.pct, 2) + '%</td>' + (r.comparison ? '<td class="' + signClass(d && d.delta) + '">' + signed(d && d.delta, 2) + '个百分点</td>' : '') + '</tr>';
    }).join('');
    const sectorRows = (r.sectors || []).map(function (s) { return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.n) + '</td><td class="' + signClass(s.avgPct) + '">' + signed(s.avgPct, 2) + '%</td><td>' + esc(s.upPct == null ? '—' : s.upPct + '%') + '</td><td>' + esc(s.fundYi == null ? '—' : signed(s.fundYi, 2) + '亿') + '</td></tr>'; }).join('');
    const metrics = (r.metrics || []).map(function (m) { return '<div class="metric"><span>' + esc(m.label) + '</span><b>' + esc(m.value) + '</b></div>'; }).join('');
    const compare = r.comparison ? '<p class="compare"><b>' + esc(r.comparison.label) + '变化：</b>上涨家数 ' + signed(r.comparison.up, 0) + '、下跌家数 ' + signed(r.comparison.down, 0) + '、资金变化 ' + signed(r.comparison.fundYi, 1) + '亿元、涨停变化 ' + signed(r.comparison.limitUp, 0) + '、跌停变化 ' + signed(r.comparison.limitDown, 0) + '。</p>' : '';
    const news = r.headlines && r.headlines.length ? '<h3>隔夜及近期新闻线索</h3><ul class="news">' + r.headlines.map(function (n) { return '<li><time>' + esc(n.time) + '</time><span class="tag">' + esc(n.prefix) + '</span><a href="' + esc(n.url) + '" target="_blank" rel="noopener noreferrer">' + esc(n.title) + '</a></li>'; }).join('') + '</ul>' : '';
    return '<section id="' + key + '"><div class="head"><div><h2>' + esc(label) + '</h2><div class="meta">生成于 ' + esc(r.capturedAt) + ' · 行情截点 ' + esc(r.marketTime) + (r.referenceDate ? ' · 盘前行情日 ' + esc(r.referenceDate) : '') + '</div></div><span class="state ' + ((r.tone === '偏强' || r.tone === '震荡偏强') ? 'positive' : (r.tone === '偏弱' || r.tone === '震荡偏弱') ? 'negative' : '') + '">' + esc(r.tone) + '</span></div><p class="lead">' + esc(r.conclusion) + '</p><div class="metrics">' + metrics + '</div>' + compare + '<h3>指数表现</h3><div class="scroll"><table><thead><tr><th>指数</th><th>点位</th><th>涨跌幅</th>' + (r.comparison ? '<th>较前一时段</th>' : '') + '</tr></thead><tbody>' + indexRows + '</tbody></table></div><h3>强势题材 / 板块</h3><div class="scroll"><table><thead><tr><th>方向</th><th>样本数</th><th>平均涨幅</th><th>上涨占比</th><th>主力净流入</th></tr></thead><tbody>' + (sectorRows || '<tr><td colspan="5">暂无足够的板块数据</td></tr>') + '</tbody></table></div><div class="twocol"><div><h3>涨幅靠前</h3><div class="scroll"><table><thead><tr><th>股票</th><th>涨幅</th></tr></thead><tbody>' + rows(r.leaders, 'gain') + '</tbody></table></div></div><div><h3>主力净流入靠前</h3><div class="scroll"><table><thead><tr><th>股票</th><th>涨幅</th><th>净流入</th></tr></thead><tbody>' + rows(r.funds, 'fund') + '</tbody></table></div></div></div>' + news + '<h3>后续观察</h3><ul>' + (r.follow || []).map(function (v) { return '<li>' + esc(v) + '</li>'; }).join('') + '</ul></section>';
  };
  const holiday = day.isTradingDay === false ? '<p class="notice">' + esc(data.today) + ' 经行情日历校验为非交易日，因此今天没有盘中复盘。</p>' : '';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(data.today) + ' A股市场复盘</title><style>' + css() + '</style></head><body><main><header><div><h1>' + esc(data.today) + ' A股市场复盘</h1><p class="meta">沪深全市场行情与财联社相关新闻 · 页面最近更新 ' + esc(data.updatedAt || '—') + '（上海时间）</p></div><a href="../" class="back">← 返回新闻看板</a></header><nav>' + labels.map(function (x) { return '<a href="#' + x[0] + '">' + x[1] + '</a>'; }).join('') + '</nav><p class="notice">盘前、10点、12点及收盘后逐次生成并留档。行情截点与页面生成时间分开显示，GitHub 定时调度可能造成数分钟延迟。板块与资金指标为描述性观察，不构成投资建议。</p>' + holiday + labels.map(function (x) { return section(x[0], x[1]); }).join('') + '<footer>最新沪深市场快照覆盖 ' + esc(data.latest && data.latest.total || '—') + ' 只证券 · 行情时间 ' + esc(data.latest && data.latest.updatedText || '—') + ' · <a href="../market-review.json">下载复盘数据 JSON</a></footer></main><script>(function(){var seen=' + JSON.stringify(String(data.updatedAt || '')) + ';async function refreshIfChanged(){try{var r=await fetch("../market-review.json?t="+Date.now(),{cache:"no-store"});if(!r.ok)return;var d=await r.json();if(d.updatedAt&&d.updatedAt!==seen)location.reload()}catch(e){}}setInterval(refreshIfChanged,60000)})();</script></body></html>';
}
function css() {
  return ':root{color-scheme:light;--ink:#20252b;--muted:#687386;--line:#e5e9ef;--blue:#1257a8;--red:#c62828;--green:#16834a;--bg:#f4f7fb}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 "Microsoft YaHei",system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:24px 18px 50px}header,.head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;flex-wrap:wrap}h1{font-size:27px;line-height:1.3;margin:0 0 5px}h2{font-size:20px;margin:0;border-left:4px solid #d97706;padding-left:11px}h3{font-size:16px;margin:22px 0 9px}.meta,footer{font-size:12px;color:var(--muted)}.back{color:var(--blue);font-weight:700;text-decoration:none;white-space:nowrap}nav{position:sticky;top:0;z-index:2;display:flex;gap:8px;overflow:auto;padding:10px 0;background:#f4f7fbf5}nav a{flex:none;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--blue);font-weight:700;text-decoration:none}.notice{margin:10px 0 16px;padding:12px 14px;border:1px solid #f3d19b;border-radius:10px;background:#fffaf0;color:#6b4f1d;font-size:13px}section{scroll-margin-top:60px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:19px 20px;margin:15px 0;box-shadow:0 4px 16px #0f172a0a}section.pending{background:#fbfcfe;color:var(--muted)}.state{border-radius:999px;padding:3px 10px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-weight:700;white-space:nowrap}.state.positive{color:#166534;background:#f0fdf4;border-color:#bbf7d0}.state.negative{color:#991b1b;background:#fef2f2;border-color:#fecaca}.lead{margin:14px 0;font-size:15px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:9px;margin:14px 0}.metric{border:1px solid #edf0f4;border-radius:9px;padding:9px 11px;background:#fbfcfe}.metric span{display:block;color:var(--muted);font-size:12px}.metric b{font-size:17px;font-variant-numeric:tabular-nums}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:8px 9px;border:1px solid var(--line);text-align:left;white-space:nowrap}th{background:#f3f5f8}td a{color:var(--blue);text-decoration:none}.up{color:var(--red);font-weight:700}.down{color:var(--green);font-weight:700}.compare{padding:10px 12px;border-left:3px solid #93c5fd;background:#eff6ff}.twocol{display:grid;grid-template-columns:1fr 1fr;gap:20px}ul{padding-left:22px}.news{list-style:none;padding:0}.news li{display:grid;grid-template-columns:145px auto 1fr;gap:8px;padding:7px 0;border-bottom:1px solid #edf0f4}.news time{color:var(--muted);font-size:12px}.tag{font-size:11px;color:#155e75;background:#eef4fb;border-radius:4px;padding:1px 6px;white-space:nowrap}.news a{color:var(--blue);text-decoration:none}footer{padding:20px 4px}footer a{color:var(--blue)}@media(max-width:650px){main{padding:16px 10px 34px}h1{font-size:22px}section{padding:15px 12px;border-radius:11px}.twocol{grid-template-columns:1fr;gap:0}.news li{grid-template-columns:1fr;gap:2px}.news time{font-size:11px}table{font-size:12px}th,td{padding:7px}}';
}
async function update() {
  fs.mkdirSync(OUT, { recursive: true });
  const now = Date.now(), p = shanghai(now), market = readJson(MARKET, {}), card = market.card;
  if (!card || !card.breadth) throw new Error('缺少全市场行情卡片: ' + MARKET);
  const data = readJson(HISTORY, { days: {} });
  data.days = data.days || {};
  data.today = p.date;
  data.updatedAt = p.date + ' ' + p.hm;
  data.latest = compact(card);
  const day = data.days[p.date] || { date: p.date, reports: {} };
  day.reports = day.reports || {};
  const stage = stageAt(p);
  if (stage && !day.reports[stage]) {
    const bars = await quotes.dailyBars('sh000001', 5);
    const keys = Array.from(bars.keys()).sort();
    const todayHasBar = keys.length > 0 && keys[keys.length - 1] === p.date.replace(/-/g, '');
    const isTrading = stage === 'premarket' || todayHasBar;
    if (isTrading) {
      const n = readJson(NEWS, {});
      const referenceDate = !todayHasBar && keys.length ? keys[keys.length - 1].slice(0, 4) + '-' + keys[keys.length - 1].slice(4, 6) + '-' + keys[keys.length - 1].slice(6, 8) : '';
      day.reports[stage] = makeReport(stage, compact(card), p.date, p.hm, headlines(n.rows, p.date), day.reports, stage === 'premarket' ? referenceDate : '');
      day.isTradingDay = true;
    } else {
      day.isTradingDay = false;
      day.reports = {};
    }
    day.updatedAt = p.date + ' ' + p.hm;
  }
  data.days[p.date] = day;
  const keys = Object.keys(data.days).sort();
  keys.slice(0, Math.max(0, keys.length - MAX_DAYS)).forEach(function (d) { delete data.days[d]; });
  fs.writeFileSync(HISTORY, JSON.stringify(data), 'utf8');
  fs.mkdirSync(path.dirname(PAGE), { recursive: true });
  const html = pageHtml(data);
  fs.writeFileSync(PAGE, html, 'utf8');
  fs.writeFileSync(path.join(OUT, 'market-review.html'), html, 'utf8');
  console.log('复盘页刷新 ' + p.date + ' ' + p.hm + ' ｜ 本轮时段 ' + (stage || '行情刷新') + ' ｜ 今日已生成 ' + Object.keys(day.reports).length + ' 个时段 ｜ 行情截点 ' + (card.updatedText || card.updatedAt));
}

if (require.main === module) update().catch(function (e) { console.error('复盘页生成失败：' + (e && e.stack || e)); process.exitCode = 1; });
module.exports = { update: update, stageAt: stageAt, pageHtml: pageHtml };
