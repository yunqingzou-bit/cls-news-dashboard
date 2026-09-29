'use strict';

// 按沪深全市场快照生成盘前、10点、午盘和盘后复盘，并保留近30日记录。
const fs = require('node:fs');
const path = require('node:path');
const quotes = require('../src/quotes.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const HISTORY = path.join(OUT, 'market-review.json');
const MARKET = path.join(ROOT, 'data', 'market.json');
const NEWS = path.join(OUT, 'market-news.json');
const CLS_NEWS = path.join(OUT, 'cls-news-latest.json');
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
  if (m >= 8 * 60 && m < 9 * 60 + 30) return 'premarket';
  if (m >= 10 * 60 && m < 11 * 60 + 30) return 'morning';
  if (m >= 12 * 60 && m < 14 * 60) return 'noon';
  if (m >= 15 * 60 && m < 20 * 60) return 'close';
  return '';
}
function compact(card) {
  return { updatedAt: card.updatedAt, updatedText: card.updatedText, total: card.total, indexes: card.indexes || [], breadth: card.breadth || {}, themes: card.themes || [], industries: card.industries || [], hotGain: card.hotGain || [], hotFund: card.hotFund || [], outlook: card.outlook || {} };
}
function signed(v, digits) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? (n > 0 ? '+' : '') + n.toFixed(digits == null ? 2 : digits) : '—';
}
function numeric(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function tone(card) {
  const b = card.breadth || {}, ix = card.indexes || [];
  const up = numeric(b.up), down = numeric(b.down);
  if (!ix.length || up === null || down === null) return '数据不足';
  const positive = ix.filter(function (x) { return Number(x.pct) > 0; }).length;
  if (up > down * 1.3 && positive >= Math.ceil(ix.length * .75)) return '偏强';
  if (up > down && positive >= Math.ceil(ix.length / 2)) return '震荡偏强';
  if (down > up * 1.3 && positive <= Math.floor(ix.length / 4)) return '偏弱';
  if (down > up) return '震荡偏弱';
  return '多空分化';
}
function headlines(rows, date, hm) {
  const seen = new Set();
  const cutoff = date + ' ' + (hm || '23:59') + ':59';
  return (Array.isArray(rows) ? rows : []).filter(function (r) {
    if (!r || !r.title || !r.url || !r.time || String(r.time) > cutoff) return false;
    const id = String(r.id || r.articleId || r.url);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).sort(function (a, b) { return String(b.time || '').localeCompare(String(a.time || '')); }).slice(0, 10)
    .map(function (r) { return { time: r.time, source: r.publisher || (r.source === 'cls' ? '财联社' : r.source || '公开资讯'), prefix: r.prefix || '', title: r.title, url: r.url, summary: r.summary || '' }; });
}
function comparison(card, prior, label) {
  if (!prior || !prior.snapshot) return null;
  const old = prior.snapshot, oldIndex = {};
  (old.indexes || []).forEach(function (x) { oldIndex[x.code] = numeric(x.pct); });
  const b = card.breadth || {}, ob = old.breadth || {};
  const change = function (current, previous) {
    const a = numeric(current), z = numeric(previous);
    return a === null || z === null ? null : a - z;
  };
  return {
    label: label,
    indexes: (card.indexes || []).map(function (x) { return { name: x.name, delta: change(x.pct, oldIndex[x.code]) }; }),
    up: change(b.up, ob.up), down: change(b.down, ob.down),
    fundYi: change(b.fundYi, ob.fundYi),
    limitUp: change(b.limitUp, ob.limitUp), limitDown: change(b.limitDown, ob.limitDown),
  };
}
function crossChecks(card) {
  const b = card.breadth || {}, ix = card.indexes || [];
  const up = numeric(b.up), down = numeric(b.down), fund = numeric(b.fundYi);
  const risingIndexes = ix.filter(function (x) { return Number(x.pct) > 0; }).length;
  const result = [];
  if (ix.length && up !== null && down !== null) {
    const broadUp = up > down, indexUp = risingIndexes > ix.length / 2;
    if (broadUp !== indexUp) result.push('指数方向与个股涨跌家数背离：' + (indexUp ? '多数指数上涨，但下跌家数更多，注意权重指数与个股赚钱效应分化。' : '多数指数下跌，但上涨家数更多，留意指数弱势下的结构性行情。'));
    else result.push('指数方向与涨跌家数暂未出现明显背离；这只是当前行情截点的横截面观察。');
    if (fund !== null && broadUp && fund < 0) result.push('上涨家数占优但主力净流入为负，广度与资金方向不一致，需观察后续资金承接。');
    else if (fund !== null && !broadUp && fund > 0) result.push('下跌家数占优但主力净流入为正，可能存在低位承接或口径分化，不能仅凭净流入判断反转。');
    else if (fund !== null) result.push('主力净流入与涨跌家数方向暂时一致；资金净流入属于行情接口口径，宜与价格和广度合看。');
  } else result.push('指数或涨跌家数数据不完整，暂不判断指数与市场广度是否背离。');
  if (numeric(b.limitDown) !== null && numeric(b.limitUp) !== null && Number(b.limitDown) > Number(b.limitUp)) result.push('跌停家数多于涨停家数，短线情绪压力偏高。');
  else if (numeric(b.limitUp) !== null) result.push('涨停数量可用于观察情绪，但不代表封板质量；当前数据未包含炸板率及连板结构。');
  if (fund === null) result.push('主力净流入数据缺失，资金方向不作推断。');
  return result;
}
function scenarioPlan() {
  return [
    { name: '强势情景', condition: '多数指数上涨、上涨家数多于下跌家数，且涨停不少于跌停。', response: '记录主线是否扩散；不以单一指数上涨作为确认。' },
    { name: '中性情景', condition: '指数与涨跌家数信号混合，或上涨/下跌家数接近。', response: '等待方向确认，重点观察广度、主线样本与资金是否同向。' },
    { name: '弱势情景', condition: '多数指数下跌、下跌家数占优，或跌停多于涨停。', response: '优先观察风险是否扩散及核心方向能否抗跌。' },
  ];
}
function validateScenarios(card) {
  const b = card.breadth || {}, ix = card.indexes || [];
  const up = numeric(b.up), down = numeric(b.down), lu = numeric(b.limitUp), ld = numeric(b.limitDown);
  if (!ix.length || up === null || down === null) return [{ name: '三种情景', status: '数据不足', evidence: '指数或市场涨跌家数未完整获取，不能验证盘前假设。' }];
  const positive = ix.filter(function (x) { return Number(x.pct) > 0; }).length;
  const indexUp = positive > ix.length / 2, broadUp = up > down;
  const limitKnown = lu !== null && ld !== null;
  const strongBase = indexUp && broadUp, weakBase = !indexUp && !broadUp;
  const strong = strongBase && limitKnown && lu >= ld;
  const weak = weakBase || (limitKnown && ld > lu);
  const mixed = indexUp !== broadUp || (!strongBase && !weakBase);
  return [
    { name: '强势情景', status: strong ? '已验证' : strongBase ? '部分验证（情绪字段缺失）' : weak ? '被证伪' : '部分验证', evidence: '上涨指数 ' + positive + '/' + ix.length + '；上涨/下跌家数 ' + up + '/' + down + '；涨停/跌停 ' + (lu === null ? '—' : lu) + '/' + (ld === null ? '—' : ld) + '。' },
    { name: '中性情景', status: mixed ? '已验证' : strongBase && !limitKnown ? '部分验证（情绪字段缺失）' : '尚未验证', evidence: mixed ? '指数方向与市场广度不完全一致，或多空条件处于中间状态。' : '当前指数、广度及涨跌停条件更接近单边情景。' },
    { name: '弱势情景', status: weak ? '已验证' : strongBase ? '被证伪' : '部分验证', evidence: '以指数多数方向、上涨/下跌家数及可用的涨跌停对比作规则化核验；这不是主观预测准确率。' },
  ];
}
function comparisonText(c) {
  if (!c) return '暂无前一时点快照可比。';
  const parts = (c.indexes || []).filter(function (x) { return x.delta !== null; }).slice(0, 3)
    .map(function (x) { return x.name + '涨跌幅变化 ' + signed(x.delta, 2) + ' 个百分点'; });
  [['上涨家数', c.up, '家'], ['下跌家数', c.down, '家'], ['涨停', c.limitUp, '家'], ['跌停', c.limitDown, '家'], ['主力净流入', c.fundYi, '亿元']].forEach(function (x) {
    if (x[1] !== null && x[1] !== undefined) parts.push(x[0] + '变化 ' + signed(x[1], 1) + x[2]);
  });
  return parts.length ? c.label + '：' + parts.join('；') + '。' : c.label + '：可比字段不足。';
}
function reportObservation(r) {
  const b = r.snapshot && r.snapshot.breadth || {}, indexes = r.indexes || [];
  const rising = indexes.filter(function (x) { return Number(x.pct) > 0; }).length;
  const parts = ['状态：' + (r.tone || '数据不足')];
  if (indexes.length) parts.push('上涨指数 ' + rising + '/' + indexes.length);
  if (numeric(b.up) !== null && numeric(b.down) !== null) parts.push('涨/跌家数 ' + b.up + '/' + b.down);
  if (numeric(b.limitUp) !== null && numeric(b.limitDown) !== null) parts.push('涨停/跌停 ' + b.limitUp + '/' + b.limitDown);
  if (r.sectors && r.sectors.length) parts.push('方向 ' + r.sectors.slice(0, 3).map(function (x) { return x.name; }).join('、'));
  return parts.join('；') + '。';
}
function makeReport(stage, card, date, hm, news, prior, referenceDate, newsSources) {
  const b = card.breadth || {}, ix = card.indexes || [], mood = tone(card);
  const sectors = ((card.outlook && card.outlook.sectors && card.outlook.sectors.length) ? card.outlook.sectors : card.themes || []).slice(0, 6);
  const delta = stage === 'morning' ? comparison(card, prior.premarket, '对比盘前基准')
    : stage === 'noon' ? comparison(card, prior.morning, '对比10点')
    : stage === 'close' ? comparison(card, prior.noon || prior.morning, prior.noon ? '对比午盘' : '对比早盘') : null;
  const up = Number(b.up) || 0, down = Number(b.down) || 0;
  let conclusion;
  if (stage === 'premarket') {
    conclusion = '盘前先建立可验证的“今日剧本”，而非预测指数涨跌。基准行情取自最近一次可用的全市场快照（' + (card.updatedText || card.updatedAt || '时间未知') + '）；开盘后按同一组指数、涨跌家数、涨跌停、板块与资金指标逐项核验。';
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
    follow.unshift(comparisonText(delta) + '用于判断盘中动能扩散或收敛；涨跌幅变化是百分点差，不等于指数点位变化。');
    if (delta.up !== null && delta.down !== null && delta.up < 0 && delta.down > 0) follow.push('较前一时段上涨家数减少、下跌家数增加，盘中广度转弱，谨慎解读指数反弹。');
  }
  const indexByName = function (name) { const x = ix.find(function (v) { return v.name === name; }); return x ? signed(x.pct, 2) + '%' : '—'; };
  const metrics = [
    { label: '上证指数', value: indexByName('上证指数') }, { label: '深证成指', value: indexByName('深证成指') },
    { label: '上涨 / 下跌', value: numeric(b.up) === null || numeric(b.down) === null ? '—' : up + ' / ' + down },
    { label: '涨停 / 跌停', value: numeric(b.limitUp) === null || numeric(b.limitDown) === null ? '—' : b.limitUp + ' / ' + b.limitDown },
    { label: '主力净流入', value: numeric(b.fundYi) === null ? '未获取' : signed(b.fundYi, 1) + '亿元' },
  ];
  return {
    stage: stage, capturedAt: date + ' ' + hm, marketTime: card.updatedText || '—', referenceDate: referenceDate || '', tone: mood, conclusion: conclusion,
    metrics: metrics, indexes: ix.map(function (x) { return { name: x.name, code: x.code, px: Number(x.px), pct: Number(x.pct) }; }),
    sectors: sectors, leaders: (card.hotGain || []).slice(0, 5), funds: (card.hotFund || []).slice(0, 5),
    comparison: delta, comparisonSummary: comparisonText(delta),
    scenarios: stage === 'premarket' ? scenarioPlan() : [],
    scenarioValidation: stage === 'premarket' ? [] : validateScenarios(card),
    crossChecks: crossChecks(card), follow: follow, headlines: stage === 'premarket' ? news : [],
    newsUpdatedAt: stage === 'premarket' ? date + ' ' + hm : '', newsSources: stage === 'premarket' ? (newsSources || []) : [], snapshot: compact(card),
  };
}
function pageHtml(data) {
  const day = data.days[data.today] || { reports: {} }, reports = day.reports || {};
  const labels = [['premarket', '8:00 盘前分析'], ['morning', '10:00 早盘复盘'], ['noon', '12:00 午盘复盘'], ['close', '盘后今日复盘']];
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
      const deltaCell = r.comparison ? (d && d.delta !== null && d.delta !== undefined ? '<td class="' + signClass(d.delta) + '">' + signed(d.delta, 2) + '个百分点</td>' : '<td>—</td>') : '';
      return '<tr><td>' + esc(x.name) + '</td><td>' + (Number.isFinite(x.px) ? x.px.toFixed(2) : '—') + '</td><td class="' + signClass(x.pct) + '">' + signed(x.pct, 2) + '%</td>' + deltaCell + '</tr>';
    }).join('');
    const sectorRows = (r.sectors || []).map(function (s) { return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.n) + '</td><td class="' + signClass(s.avgPct) + '">' + signed(s.avgPct, 2) + '%</td><td>' + esc(s.upPct == null ? '—' : s.upPct + '%') + '</td><td>' + esc(s.fundYi == null ? '—' : signed(s.fundYi, 2) + '亿') + '</td></tr>'; }).join('');
    const metrics = (r.metrics || []).map(function (m) { return '<div class="metric"><span>' + esc(m.label) + '</span><b>' + esc(m.value) + '</b></div>'; }).join('');
    const compare = '<h3>与上一时点相比</h3><p class="compare">' + esc(r.comparisonSummary || comparisonText(r.comparison)) + (r.comparison ? ' 涨跌幅变化按百分点差计算，不等于点位变化。' : '') + '</p>';
    const checks = '<h3>市场解释：信号互证与分歧</h3><ul class="checks">' + (r.crossChecks || []).map(function (v) { return '<li>' + esc(v) + '</li>'; }).join('') + '</ul>';
    const scenarioPlanHtml = r.scenarios && r.scenarios.length ? '<h3>盘前三种情景与验证条件</h3><div style="display:flex;flex-wrap:wrap;gap:10px">' + r.scenarios.map(function (s) { return '<article style="flex:1 1 240px;border:1px solid #e5e9ef;border-radius:10px;background:#fbfcfe;padding:12px"><b>' + esc(s.name) + '</b><p><strong>观察条件：</strong>' + esc(s.condition) + '</p><p><strong>观察重点：</strong>' + esc(s.response) + '</p></article>'; }).join('') + '</div>' : '';
    const validationHtml = r.scenarioValidation && r.scenarioValidation.length ? '<h3>盘前假设验证</h3><div class="scroll"><table><thead><tr><th>情景</th><th>验证状态</th><th>当前证据</th></tr></thead><tbody>' + r.scenarioValidation.map(function (s) { return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.status) + '</td><td style="white-space:normal;min-width:180px;max-width:340px">' + esc(s.evidence) + '</td></tr>'; }).join('') + '</tbody></table></div><p class="meta">验证仅按当前已接入的指数、涨跌家数和涨跌停字段执行，不代表统计意义上的预测准确率。</p>' : '';
    const sourceStatus = r.newsSources && r.newsSources.length ? '<p class="meta">新闻采集状态（' + esc(r.newsUpdatedAt || '—') + '）：' + r.newsSources.map(function (s) { return esc(s.name) + ' ' + (s.ok ? '可用' : '暂不可用，沿用缓存') + '（' + esc(s.count || 0) + '条）'; }).join(' · ') + '</p>' : '';
    const news = '<h3>盘前多来源新闻线索</h3>' + sourceStatus + (r.headlines && r.headlines.length ? '<ul class="news">' + r.headlines.map(function (n) { return '<li><time>' + esc(n.time) + '</time><span class="source-tag">' + esc(n.source) + '</span>' + (n.prefix ? '<span class="tag">' + esc(n.prefix) + '</span>' : '') + '<a href="' + esc(n.url) + '" target="_blank" rel="noopener noreferrer">' + esc(n.title) + '</a></li>'; }).join('') + '</ul>' : '<p class="notice">当前没有匹配时段的可用新闻标题；行情复盘仍按已获取的市场数据生成。</p>');
    return '<section id="' + key + '"><div class="head"><div><h2>' + esc(label) + '</h2><div class="meta">生成于 ' + esc(r.capturedAt) + ' · 行情截点 ' + esc(r.marketTime) + (r.referenceDate ? ' · 盘前行情日 ' + esc(r.referenceDate) : '') + '</div></div><span class="state ' + ((r.tone === '偏强' || r.tone === '震荡偏强') ? 'positive' : (r.tone === '偏弱' || r.tone === '震荡偏弱') ? 'negative' : '') + '">' + esc(r.tone) + '</span></div><p class="lead"><b>当前市场状态：</b>' + esc(r.conclusion) + '</p>' + scenarioPlanHtml + validationHtml + '<h3>当时看到了什么：固定指标快照</h3><div class="metrics">' + metrics + '</div><h3>指数表现</h3><div class="scroll"><table><thead><tr><th>指数</th><th>点位</th><th>涨跌幅</th>' + (r.comparison ? '<th>较前一时段涨跌幅变化</th>' : '') + '</tr></thead><tbody>' + indexRows + '</tbody></table></div><h3>强势题材 / 板块</h3><div class="scroll"><table><thead><tr><th>方向</th><th>样本数</th><th>平均涨幅</th><th>上涨占比</th><th>主力净流入</th></tr></thead><tbody>' + (sectorRows || '<tr><td colspan="5">暂无足够的板块数据</td></tr>') + '</tbody></table></div><div class="twocol"><div><h3>涨幅靠前</h3><div class="scroll"><table><thead><tr><th>股票</th><th>涨幅</th></tr></thead><tbody>' + rows(r.leaders, 'gain') + '</tbody></table></div></div><div><h3>主力净流入靠前</h3><div class="scroll"><table><thead><tr><th>股票</th><th>涨幅</th><th>净流入</th></tr></thead><tbody>' + rows(r.funds, 'fund') + '</tbody></table></div></div></div>' + compare + checks + news + '<h3>后续观察：下一阶段验证什么</h3><ul>' + (r.follow || []).map(function (v) { return '<li>' + esc(v) + '</li>'; }).join('') + '</ul></section>';
  };
  const timelineRows = labels.map(function (x, i) {
    const r = reports[x[0]];
    if (!r) return '<tr><th>' + esc(x[1]) + '</th><td colspan="4">等待该时点生成，后续将接续盘前主线。</td></tr>';
    const validation = x[0] === 'premarket' ? '提出强势 / 中性 / 弱势三种情景；条件见盘前分析。' : (r.scenarioValidation || []).map(function (s) { return s.name + '：' + s.status; }).join('；') || '等待盘前假设以同口径核验';
    const next = (r.follow || []).slice(0, 2).join('；') || '—';
    const cell = function (v) { return '<td style="white-space:normal;min-width:180px;max-width:320px">' + esc(v) + '</td>'; };
    return '<tr><th>' + esc(x[1]) + '<br><small>' + esc(r.capturedAt || '—') + '</small></th>' + cell(reportObservation(r)) + cell(r.comparisonSummary || '盘前基准，无日内前序时点。') + cell(validation) + cell(next) + '</tr>';
  }).join('');
  const timeline = '<section id="timeline"><h2>日内跟踪主线</h2><p class="lead">盘前提出假设 → 早盘观察验证 → 午盘判断强弱变化 → 收盘总结结果与经验。各时点使用同一套已接入指标，重点记录“当时看到什么、变化了什么、意味着什么、下一步验证什么”。</p><div class="scroll"><table><thead><tr><th>时点</th><th>当时观察</th><th>与前一时点相比</th><th>假设验证 / 判断变化</th><th>下一阶段观察</th></tr></thead><tbody>' + timelineRows + '</tbody></table></div>' + (reports.close ? '<p class="compare"><b>收盘复核：</b>结合盘前假设、10点和午盘变化，检查哪些判断得到数据支持、哪些被证伪；明日观察条件列于盘后复盘。</p>' : '') + '</section>';
  const holiday = day.isTradingDay === false ? '<p class="notice">' + esc(data.today) + ' 经行情日历校验为非交易日，因此今天没有盘中复盘。</p>' : '';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(data.today) + ' A股市场复盘</title><style>' + css() + '</style></head><body><main><header><div><h1>' + esc(data.today) + ' A股市场复盘</h1><p class="meta">沪深全市场行情与多来源公开资讯 · 页面最近更新 ' + esc(data.updatedAt || '—') + '（上海时间）</p></div><a href="../" class="back">← 返回新闻看板</a></header><nav><a href="#timeline">日内跟踪主线</a>' + labels.map(function (x) { return '<a href="#' + x[0] + '">' + x[1] + '</a>'; }).join('') + '</nav><p class="notice">盘前、10点、12点及收盘后逐次生成并留档。行情截点与页面生成时间分开显示，GitHub 定时调度可能造成数分钟延迟。当前使用已接入的指数、全市场涨跌家数、涨跌停、板块样本及主力净流入等字段。成交额变化、炸板率、连板晋级率、涨停质量、市场温度、风格轮动、海外资产及个股中位数等尚未完整接入，页面会留空或标明未获取，不用零值代替。方向标签按已获取指数与涨跌家数规则计算，不构成投资建议。</p>' + holiday + timeline + labels.map(function (x) { return section(x[0], x[1]); }).join('') + '<footer>最新沪深市场快照覆盖 ' + esc(data.latest && data.latest.total || '—') + ' 只证券 · 行情时间 ' + esc(data.latest && data.latest.updatedText || '—') + ' · <a href="../market-review.json">下载复盘数据 JSON</a></footer></main><script>(function(){var seen=' + JSON.stringify(String(data.updatedAt || '')) + ';async function refreshIfChanged(){try{var r=await fetch("../market-review.json?t="+Date.now(),{cache:"no-store"});if(!r.ok)return;var d=await r.json();if(d.updatedAt&&d.updatedAt!==seen)location.reload()}catch(e){}}setInterval(refreshIfChanged,60000)})();</script></body></html>';
}
function css() {
  return ':root{color-scheme:light;--ink:#20252b;--muted:#687386;--line:#e5e9ef;--blue:#1257a8;--red:#c62828;--green:#16834a;--bg:#f4f7fb}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 "Microsoft YaHei",system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:24px 18px 50px}header,.head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;flex-wrap:wrap}h1{font-size:27px;line-height:1.3;margin:0 0 5px}h2{font-size:20px;margin:0;border-left:4px solid #d97706;padding-left:11px}h3{font-size:16px;margin:22px 0 9px}.meta,footer{font-size:12px;color:var(--muted)}.back{color:var(--blue);font-weight:700;text-decoration:none;white-space:nowrap}nav{position:sticky;top:0;z-index:2;display:flex;gap:8px;overflow:auto;padding:10px 0;background:#f4f7fbf5}nav a{flex:none;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--blue);font-weight:700;text-decoration:none}.notice{margin:10px 0 16px;padding:12px 14px;border:1px solid #f3d19b;border-radius:10px;background:#fffaf0;color:#6b4f1d;font-size:13px}section{scroll-margin-top:60px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:19px 20px;margin:15px 0;box-shadow:0 4px 16px #0f172a0a}section.pending{background:#fbfcfe;color:var(--muted)}.state{border-radius:999px;padding:3px 10px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-weight:700;white-space:nowrap}.state.positive{color:#166534;background:#f0fdf4;border-color:#bbf7d0}.state.negative{color:#991b1b;background:#fef2f2;border-color:#fecaca}.lead{margin:14px 0;font-size:15px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:9px;margin:14px 0}.metric{border:1px solid #edf0f4;border-radius:9px;padding:9px 11px;background:#fbfcfe}.metric span{display:block;color:var(--muted);font-size:12px}.metric b{font-size:17px;font-variant-numeric:tabular-nums}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:8px 9px;border:1px solid var(--line);text-align:left;white-space:nowrap}th{background:#f3f5f8}td a{color:var(--blue);text-decoration:none}.up{color:var(--red);font-weight:700}.down{color:var(--green);font-weight:700}.compare{padding:10px 12px;border-left:3px solid #93c5fd;background:#eff6ff}.twocol{display:grid;grid-template-columns:1fr 1fr;gap:20px}ul{padding-left:22px}.news,.checks{padding-left:20px}.news{list-style:none;padding-left:0}.news li{display:grid;grid-template-columns:145px auto auto 1fr;gap:8px;padding:7px 0;border-bottom:1px solid #edf0f4}.news time{color:var(--muted);font-size:12px}.source-tag{font-size:11px;color:#36536b;background:#f1f5f9;border-radius:4px;padding:1px 6px;white-space:nowrap}.tag{font-size:11px;color:#155e75;background:#eef4fb;border-radius:4px;padding:1px 6px;white-space:nowrap}.news a{color:var(--blue);text-decoration:none}footer{padding:20px 4px}footer a{color:var(--blue)}@media(max-width:650px){main{padding:16px 10px 34px}h1{font-size:22px}section{padding:15px 12px;border-radius:11px}.twocol{grid-template-columns:1fr;gap:0}.news li{grid-template-columns:1fr;gap:2px}.news time{font-size:11px}table{font-size:12px}th,td{padding:7px}}';
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
  const newsDoc = readJson(NEWS, { rows: [], sources: [] });
  const fallbackNews = readJson(CLS_NEWS, { rows: [] });
  const newsRows = newsDoc.rows && newsDoc.rows.length ? newsDoc.rows : fallbackNews.rows;
  const newsSources = (newsDoc.sources || []).map(function (s) { return { name: s.name, ok: !!s.ok, count: Number(s.count) || 0 }; });
  if (stage && !day.reports[stage]) {
    const bars = await quotes.dailyBars('sh000001', 5);
    const keys = Array.from(bars.keys()).sort();
    const todayHasBar = keys.length > 0 && keys[keys.length - 1] === p.date.replace(/-/g, '');
    const isTrading = stage === 'premarket' || todayHasBar;
    if (isTrading) {
      const referenceDate = !todayHasBar && keys.length ? keys[keys.length - 1].slice(0, 4) + '-' + keys[keys.length - 1].slice(4, 6) + '-' + keys[keys.length - 1].slice(6, 8) : '';
      day.reports[stage] = makeReport(stage, compact(card), p.date, p.hm, headlines(newsRows, p.date, p.hm), day.reports, stage === 'premarket' ? referenceDate : '', newsSources);
      day.isTradingDay = true;
    } else {
      day.isTradingDay = false;
      day.reports = {};
    }
    day.updatedAt = p.date + ' ' + p.hm;
  }
  // 同一日盘前时段允许刷新新闻列表和来源状态，但冻结已记录的市场快照，避免把盘前变成另一时点行情。
  if (stage === 'premarket' && day.reports.premarket) {
    day.reports.premarket.headlines = headlines(newsRows, p.date, p.hm);
    day.reports.premarket.newsUpdatedAt = p.date + ' ' + p.hm;
    day.reports.premarket.newsSources = newsSources;
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
module.exports = { update: update, stageAt: stageAt, pageHtml: pageHtml, makeReport: makeReport, comparison: comparison, scenarioPlan: scenarioPlan, validateScenarios: validateScenarios, crossChecks: crossChecks, tone: tone };
