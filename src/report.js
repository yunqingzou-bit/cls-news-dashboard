'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./collect.js');

const OUT_DIR = path.join(ROOT, 'out');
const Q = String.fromCharCode(34);

const HEADERS = ['新闻发布时间', '涉及股票', '同篇其他股票', '前缀类型', '新闻标题',
  '发布时价格', '发布后5min涨幅', '发布后30min涨幅', '发布后2h涨幅',
  '当天开盘价', '当天收盘价', '当天涨幅', 'T+1涨幅', 'T+2涨幅', 'T+3涨幅', 'T+4涨幅', 'T+5涨幅',
  '成交量较前日', '换手率', '交易日',
  '股票代码', '文章链接', '调研结论'];

// 网页表格用的列（把 9 个指标并成两列，便于阅读）
const HTML_HEADERS = ['新闻发布时间', '涉及股票', '前缀类型', '新闻标题', '发布后表现', '当日行情', '后续走势', '换手率', '量较前日', '调研结论', '技术面结论'];
// 发布时间列要能放下一整行日期（否则会在“2026-09-12”中间断开），所以在窄屏适配下也有足够宽度
const HTML_COL_WIDTHS = [11, 8, 7, 8, 6, 7, 9, 5, 5, 17, 17];
// 可点击排序的列：表头名称 -> 行上的 data-* 属性
const SORTABLE_COLS = { '换手率': 'data-turn', '量较前日': 'data-vol' };

function pct(v) { return v === null || v === undefined ? '' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
function num(v, d) { return v === null || v === undefined ? '' : Number(v).toFixed(d === undefined ? 2 : d); }
function afterText(r) {
  const p = [];
  if (r.m5 !== null && r.m5 !== undefined) p.push('+5m ' + pct(r.m5));
  if (r.m30 !== null && r.m30 !== undefined) p.push('+30m ' + pct(r.m30));
  if (r.m120 !== null && r.m120 !== undefined) p.push('+2h ' + pct(r.m120));
  if (p.length) return p.join('  ');
  return r.refPx === null || r.refPx === undefined ? '—' : '—（已收盘/数据不足）';
}
/**
 * 该股适用的涨跌幅限制：
 *   创业板(sz30) / 科创板(sh688) -> 20%
 *   主板：名称含 ST 且近 20 日最大单日涨跌幅不超过 5.6% -> 5%，其余 10%
 * 名称可能过期（已摘帽但仍显示 *ST），所以用实际行情校验。
 */
function inferLimit(code, name, maxAbs) {
  const c = String(code || '');
  if (/^sz30/.test(c) || /^sh688/.test(c)) return 20;
  if (/ST/i.test(String(name || '')) && maxAbs !== null && maxAbs !== undefined && maxAbs <= 5.6) return 5;
  return 10;
}
/** 涨停 = 收盘价达到该股涨停价，且涨跌幅与该档限额偏离不超过 1.2 个百分点 */
function isLimitUp(r) {
  if (r.close === null || r.close === undefined) return false;
  if (r.prevClose === null || r.prevClose === undefined || !r.prevClose) return false;
  if (r.changePct === null || r.changePct === undefined) return false;
  const nm = String(r.stockName || '');
  if (/^[NC]/.test(nm)) return false; // 新股上市初期无涨跌幅限制
  const lim = inferLimit(r.stockCode, nm, r.maxAbsChange);
  if (Math.abs(r.changePct - lim) > 1.2) return false;
  const target = Math.round(r.prevClose * (1 + lim / 100) * 100) / 100;
  return r.close >= target - 0.005;
}
function dayHtml(r) {
  const p = [];
  if (r.open !== null && r.open !== undefined) p.push('开 ' + num(r.open));
  if (r.close !== null && r.close !== undefined) p.push('收 ' + num(r.close));
  if (r.changePct !== null && r.changePct !== undefined) {
    const txt = '日 ' + pct(r.changePct);
    if (isLimitUp(r)) p.push('<span class="up-limit">' + txt + ' 涨停</span>');
    else if (r.changePct > 5) p.push('<span class="up-strong">' + txt + '</span>');
    else p.push(txt);
  }
  return p.length ? p.join('  ') : '—';
}

// 当天 + T+1 ~ T+5 的日涨跌幅（红涨绿跌；尚未发生的档位显示“待更新”）
const FORWARD_LABELS = ['当天', 'T+1', 'T+2', 'T+3', 'T+4', 'T+5'];
function forwardHtml(r) {
  const f = r.forward;
  if (!f) return '—';
  const item = function (label, v, extra) {
    const key = '<strong class=' + Q + 'research-key' + Q + '>' + label + '</strong>';
    if (v === null || v === undefined) return '<div class=' + Q + 'research-item' + Q + '>' + key + '待更新</div>';
    const cls = v > 0 ? 'f-up' : v < 0 ? 'f-down' : '';
    const txt = pct(v) + (extra || '');
    // 只有需要上色（涨红 / 跌绿）时才包 span，平盘和不带上色的值直接写文本
    return '<div class=' + Q + 'research-item' + Q + '>' + key + (cls ? '<span class=' + Q + cls + Q + '>' + txt + '</span>' : txt) + '</div>';
  };
  const out = [item('当天', f.d0, f.close0 ? '（收 ' + num(f.close0) + '）' : '')];
  for (let i = 0; i < 5; i++) out.push(item(FORWARD_LABELS[i + 1], f.t[i]));
  return out.join('');
}

// 换手率配色：10~15 绿、15~20 蓝、>20 红
function turnLevel(v) {
  if (v === null || v === undefined) return '';
  if (v > 20) return 'v-red';
  if (v >= 15) return 'v-blue';
  if (v >= 10) return 'v-green';
  return '';
}
// 量较前日配色：20~30 绿、30~40 蓝、>40 红
function volLevel(v) {
  if (v === null || v === undefined) return '';
  if (v > 40) return 'v-red';
  if (v >= 30) return 'v-blue';
  if (v >= 20) return 'v-green';
  return '';
}
function turnText(r) { return r.turnover === null || r.turnover === undefined ? '—' : num(r.turnover) + '%'; }
function volText(r) { return r.volRatioPct === null || r.volRatioPct === undefined ? '—' : pct(r.volRatioPct); }
const TEXT_SOURCE_LABEL = { share: '财联社正文（公开页）', detail: '财联社正文（接口）', brief: '栏目摘要', gated: '需订阅登录（点击标题查看全文）', none: '未取到' };

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return Q + s.split(Q).join(Q + Q).replace(/\r?\n/g, '\n') + Q;
}

function toCsv(rows) {
  const out = [HEADERS.map(csvCell).join(',')];
  for (const r of rows) {
    const fw = r.forward || {};
    const tArr = fw.t || [];
    out.push([r.time, r.stock || r.stocks, r.others || '', r.prefix, r.title,
      r.refPx === null || r.refPx === undefined ? '' : num(r.refPx),
      r.m5, r.m30, r.m120,
      r.open, r.close, fw.d0 === undefined ? r.changePct : fw.d0,
      tArr[0], tArr[1], tArr[2], tArr[3], tArr[4],
      r.volRatioPct, r.turnover,
      r.tradeDate || '',
      r.stockCodes.join(' '), r.url, r.researchConclusion || ''].map(csvCell).join(','));
  }
  return '\ufeff' + out.join('\r\n');
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const RESEARCH_LABEL_RE = /(题材|估值(?:（截至[^）]+）)?|未来三个月潜力|目前大事|未来三个月|股东动向|短线博弈)：/g;
const RESEARCH_PLAY_RISK_RE = /(追高风险|超买|缩量|走弱|不适合|空头排列)/g;
const RESEARCH_RISK_RE = /(利润同比下滑|营收承压|盈利为负\/PE失真|估值较高|负面公告事项|退市风险)/g;
const RESEARCH_EVENT_RE = /(重大资产重组|重大合同|控制权变更|发行股份|收购|重组|中标|立案|行政处罚|诉讼|股权质押|股份质押|解除限售|限售股|增减持|增持|减持|回购)/g;
// 技术面结论的标签与风险词（下降/破位/偏空类内容标红）
const TECH_LABEL_RE = /(趋势|位置|量能|关键位|倾向)：/g;
const TECH_RISK_RE = /(下降趋势|下降末段|破位|跌破|假突破|偏空|超买|放量下跌|放量滞涨|失守|转弱|受制于|区间震荡)/g;

function splitHighlight(value, re) {
  if (!re) return esc(value);
  re.lastIndex = 0;
  return String(value).split(re).map(function (part, i) {
    return i % 2 ? '<span class="research-impact">' + esc(part) + '</span>' : esc(part);
  }).join('');
}

/** 把「标签：内容」多行文本按标签切成分项，标签加粗，内容可自定义高亮。 */
function labelledHtml(value, labelRe, render) {
  const source = String(value || '—').replace(/\r?\n/g, ' ').trim();
  const fields = [];
  labelRe.lastIndex = 0;
  let match;
  while ((match = labelRe.exec(source)) !== null) fields.push({ label: match[1], index: match.index, start: labelRe.lastIndex });
  if (!fields.length) return esc(source);
  return fields.map(function (field, i) {
    const end = i + 1 < fields.length ? fields[i + 1].index : source.length;
    const text = source.slice(field.start, end).replace(/^[\s。]+|[\s。]+$/g, '');
    // 没有需要高亮的片段时直接输出文本，省掉一层多余的 span（几百行 × 十几个字段，节点数差很多）
    const body = render(field.label, text);
    return '<div class="research-item"><strong class="research-key">' + esc(field.label) + '：</strong>' +
      (body.indexOf('<') >= 0 ? '<span>' + body + '</span>' : body) + '</div>';
  }).join('');
}

function highlightedResearchValue(label, value) {
  if (label === '短线博弈') {
    if (/^不适合/.test(value)) return '<span class="research-impact">' + esc(value) + '</span>';
    return splitHighlight(value, RESEARCH_PLAY_RISK_RE);
  }
  const majorLine = label === '目前大事' && RESEARCH_EVENT_RE.test(value) ||
    label === '股东动向' && !/未检索到|待下一轮/.test(value) && RESEARCH_EVENT_RE.test(value);
  RESEARCH_EVENT_RE.lastIndex = 0;
  if (majorLine) return '<span class="research-impact">' + esc(value) + '</span>';
  const re = label === '未来三个月潜力' ? RESEARCH_RISK_RE : label === '未来三个月' ? RESEARCH_EVENT_RE : null;
  return splitHighlight(value, re);
}

function researchHtml(value) {
  return labelledHtml(value, RESEARCH_LABEL_RE, highlightedResearchValue);
}

function technicalHtml(value) {
  return labelledHtml(value, TECH_LABEL_RE, function (label, text) {
    if (label === '倾向' && /偏空/.test(text)) return '<span class="research-impact">' + esc(text) + '</span>';
    return splitHighlight(text, label === '趋势' || label === '量能' ? TECH_RISK_RE : null);
  });
}

// ---------------- 当天行情卡片（表格之前） ----------------
// 数据来自 src/market.js：沪深两市 5000+ 只快照汇总，不是抽样。
function mkPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
function mkYi(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '亿';
}
function mkCls(v) {
  const n = Number(v);
  return n > 0 ? 'f-up' : n < 0 ? 'f-down' : 'f-flat';
}
// 卡片内的色块底色只有涨/跌/中性三态，和文字颜色类分开
function mkTone(v) {
  const n = Number(v);
  return n > 0 ? 'up' : n < 0 ? 'down' : '';
}
function mkInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '0';
}

/** 板块名太长时只显示最后一段（完整名字放在 title 里）。 */
function outlookShort(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('-');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 明日看点：由今日全市场动量推导的观察名单（板块 + 个股），不是预测。
 * 数据来自 src/market.js 的 card.outlook。
 */
function outlookHtml(card, opts) {
  opts = opts || {};
  const o = card && card.outlook;
  if (!o || !o.sectors || !o.sectors.length) return '';
  const b = card.breadth || {};
  const sectorRows = o.sectors.map(function (s, i) {
    return groupRow(s, i, {
      meta: mkInt(s.n) + '只 · 涨停' + mkInt(s.limitUp) + ' · ' + mkYi(s.fundYi),
      tail: '<span class="mk-p ' + mkCls(s.avgPct) + '">' + mkPct(s.avgPct) + '</span>' +
        '<span class="mk-fund">动能 ' + mkInt(s.score) + '</span>',
    });
  }).join('');
  const picks = o.picks || [];
  const pickRows = picks.map(function (p, i) {
    return '<div class="mk-row"><span class="mk-rank' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</span>' +
      '<a class="mk-link" href=' + Q + 'https://quote.eastmoney.com/' + encodeURIComponent(p.code) + '.html' + Q +
      ' target=' + Q + '_blank' + Q + ' rel=' + Q + 'noopener noreferrer' + Q + '>' + esc(p.name) + '</a>' +
      '<span class="mk-meta">' + (p.theme ? esc(outlookShort(p.theme)) : '—') + '</span>' +
      '<span class="mk-p ' + mkCls(p.pct) + '">' + mkPct(p.pct) + (p.limitUp ? ' 涨停' : '') + '</span>' +
      '<span class="mk-fund">换手 ' + num(p.tr) + '% · ' + mkYi(p.fundYi) + '</span></div>';
  }).join('');
  const limitCnt = picks.filter(function (p) { return p.limitUp; }).length;
  const note = '动能定调：' + esc(o.tone) + '（上涨 ' + mkInt(b.up) + ' / 下跌 ' + mkInt(b.down) + '，涨停 ' +
    mkInt(b.limitUp) + ' / 跌停 ' + mkInt(b.limitDown) + '，主力净流入 ' + mkYi(b.fundYi) + '）｜ 题材样本 ' +
    mkInt(o.coverage) + ' 只，其中上涨 ' + mkInt(o.coveredUpPct) + '%';
  return [
    '<div class="mkt-box mkt-wide"><div class="mkt-h">明日看点</div>',
    '<div class="mkt-note" style=' + Q + 'margin:0 0 .7em' + Q + '>' + note + '</div>',
    '<div class="mkt-hot">',
    '<div class="mkt-hot-col"><div class="mkt-hot-h">关注板块（动能排序，成分 ≥ ' + mkInt(o.minN) + ' 只）</div>' + sectorRows + '</div>',
    '<div class="mkt-hot-col"><div class="mkt-hot-h">关注个股（' + mkInt(picks.length) + ' 只，其中涨停 ' + mkInt(limitCnt) + ' 只）' +
      (opts.outlookHref
        ? ' <a href=' + Q + esc(opts.outlookHref) + Q + ' title=' + Q + '按添加日期查看每只个股的当日与 T+1~T+5 表现' + Q +
          ' style=' + Q + 'margin-left:auto;color:#1257a8;font-weight:600;white-space:nowrap' + Q + '>历史明细表 →</a>'
        : '') +
      '</div>' + pickRows + '</div>',
    '</div>',
    '<div class="mkt-note">口径：由今日全市场行情推导的动量观察名单，非预测。板块动能 = 均涨 + 上涨占比 + 强势股占比 + 主力净流入；个股分 = 涨幅 + 主力净流入 + 热门板块加成。涨停股收盘价买不到，名单最多 4 只涨停、每板块最多 3 只。样本为新闻与资金榜涉及的个股，不等于全市场板块广度。</div>',
    '</div>',
  ].join('\n');
}

let mkSeq = 0;
function mkNextId() { mkSeq++; return "mk-sub-" + mkSeq; }

/** 展开后的成分股列表（名称可点进东方财富看 K 线）。 */
function subList(stocks, id) {
  if (!stocks || !stocks.length) return "";
  const rows = stocks.map(function (s) {
    return '<div class="mk-row mk-subrow">' +
      '<a class="mk-link" href=' + Q + 'https://quote.eastmoney.com/' + encodeURIComponent(s.code) + '.html' + Q +
      ' target=' + Q + '_blank' + Q + ' rel=' + Q + 'noopener noreferrer' + Q + '>' + esc(s.name) + '</a>' +
      '<span class="mk-p ' + mkCls(s.pct) + '">' + mkPct(s.pct) + '</span>' +
      (s.fundYi === undefined ? '' : '<span class="mk-fund">' + mkYi(s.fundYi) + '</span>') +
      '</div>';
  }).join("");
  return '<div class="mk-sub" id=' + Q + id + Q + ' hidden>' + rows + '</div>';
}

/** 一条可点击展开的板块行：点击后显示该板块下的成分股。 */
function groupRow(item, i, opts) {
  opts = opts || {};
  const stocks = item.stocks || [];
  const id = mkNextId();
  const clickable = stocks.length > 0;
  const rank = i >= 0 ? '<span class="mk-rank' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</span>' : '';
  return '<div class="mk-row' + (clickable ? ' mk-click' : '') + '"' +
    (clickable ? ' data-mk=' + Q + id + Q + ' role=' + Q + 'button' + Q + ' tabindex=' + Q + '0' + Q : '') + '>' +
    rank +
    (clickable ? '<span class="mk-caret">▸</span>' : '') +
    '<span class="mk-k" title=' + Q + esc(item.name) + Q + '>' + esc(outlookShort(item.name)) + '</span>' +
    '<span class="mk-meta">' + (opts.meta || '') + '</span>' +
    (opts.tail || '') +
    '</div>' + subList(stocks, id);
}

/** 当天行情小卡片：主要指数 + 市场涨跌 + 领涨主题/板块 + 最热门股票 + 明日看点。 */
/** 取「短线博弈」结论（适合 / 可关注 / 中性 / 不适合 等），用于表格筛选。 */
function playFrom(conclusion) {
  const m = /短线博弈：\s*([^｜\n]+)/.exec(String(conclusion || ''));
  if (!m) return '';
  const t = m[1].trim();
  // 下拉里不需要「（下一轮自动评估）」这种说明性尾注
  if (/技术面数据待补齐/.test(t)) return '技术面待补齐';
  return t;
}
/** 取技术面「趋势」值（上升趋势 / 下降趋势 / 区间震荡 等），用于表格筛选。 */
function trendFrom(conclusion) {
  const m = /趋势：\s*([^（\n]+)/.exec(String(conclusion || ''));
  if (!m) return '';
  const t = m[1].trim();
  // 次新股的文案是「上市不足 N 个交易日，日线样本不足」，逐只都不同，统一成一个选项
  if (/上市不足/.test(t)) return '上市不足（新股）';
  return t;
}
/** 数值列转成 data 属性（缺失写空串，排序时排最后）。 */
function numAttr(v) {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? '' : String(n);
}

function marketCardHtml(card, opts) {
  opts = opts || {};
  if (!card || !card.breadth) return '';
  const b = card.breadth;

  const idxRows = (card.indexes || []).map(function (x) {
    const pct = Number(x.pct);
    return '<div class="idx-item ' + mkTone(pct) + '"><span class="idx-n">' + esc(x.name) + '</span>' +
      '<span class="idx-v">' + (Number.isFinite(Number(x.px)) ? Number(x.px).toFixed(2) : '—') + '</span>' +
      '<span class="idx-p ' + mkCls(pct) + '">' + mkPct(pct) + '</span></div>';
  }).join('');

  // 涨 / 平 / 跌 家数占比条：一眼看出多空结构
  const sum = Math.max(1, (Number(b.up) || 0) + (Number(b.down) || 0) + (Number(b.flat) || 0));
  const wPct = function (v) { return ((Number(v) || 0) / sum * 100).toFixed(2) + '%'; };
  const brBar = '<div class="br-bar"><i class="up" style=' + Q + 'width:' + wPct(b.up) + Q + '></i>' +
    '<i class="flat" style=' + Q + 'width:' + wPct(b.flat) + Q + '></i>' +
    '<i class="down" style=' + Q + 'width:' + wPct(b.down) + Q + '></i></div>';

  const stats = [
    ['up', 'f-up', mkInt(b.up), '上涨'],
    ['down', 'f-down', mkInt(b.down), '下跌'],
    ['', '', mkInt(b.flat), '平盘'],
    ['up', 'f-up', mkInt(b.limitUp), '涨停'],
    ['down', 'f-down', mkInt(b.limitDown), '跌停'],
    [mkTone(b.fundYi), mkCls(b.fundYi), mkYi(b.fundYi), '主力净流入'],
  ].map(function (t) {
    return '<div class="mk-stat ' + t[0] + '"><span class="mk-stat-n ' + t[1] + '">' + t[2] + '</span>' +
      '<span class="mk-stat-l">' + t[3] + '</span></div>';
  }).join('');

  const themeRows = (card.themes || []).map(function (t, i) {
    return groupRow(t, i, {
      meta: mkInt(t.n) + ' 只 · 均涨 ' + mkPct(t.avgPct),
      tail: t.best ? '<span class="mk-best">' + esc(t.best.name) + ' <b class="' + mkCls(t.best.pct) + '">' + mkPct(t.best.pct) + '</b></span>' : '',
    });
  }).join('');
  const industryRows = (card.industries || []).map(function (t, i) {
    return groupRow(t, i, { meta: mkInt(t.n) + ' 只 · 均涨 ' + mkPct(t.avgPct) });
  }).join('');

  const hotRow = function (x, i) {
    return '<div class="mk-row"><span class="mk-rank' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</span>' +
      '<a class="mk-link" href=' + Q + 'https://quote.eastmoney.com/' + encodeURIComponent(x.code) + '.html' + Q +
      ' target=' + Q + '_blank' + Q + ' rel=' + Q + 'noopener noreferrer' + Q + '>' + esc(x.name) + '</a>' +
      '<span class="mk-p ' + mkCls(x.pct) + '">' + mkPct(x.pct) + '</span>' +
      '<span class="mk-fund">' + mkYi(x.fundYi) + '</span></div>';
  };

  return [
    '<section class="mkt">',
    '<div class="mkt-hd"><strong>当天行情</strong><span class="mkt-sub">沪深两市 ' + mkInt(card.total) +
      ' 只 ｜ 截止 ' + esc(card.updatedText || '') + '（点名称看行情）</span></div>',
    '<div class="mkt-grid">',
    '<div class="mkt-box"><div class="mkt-h">主要指数</div><div class="mkt-list">' + idxRows + '</div></div>',
    '<div class="mkt-box"><div class="mkt-h">市场涨跌</div>' + brBar + '<div class="mkt-stats">' + stats + '</div>' +
      '<div class="mkt-note">涨超5% ' + mkInt(b.up5) + ' 只 ｜ 跌超5% ' + mkInt(b.down5) + ' 只</div></div>',
    '<div class="mkt-box"><div class="mkt-h">领涨主题 / 板块</div><div class="mkt-list">' + themeRows + '</div>' +
      (industryRows ? '<div class="mkt-note" style=' + Q + 'margin:.55em 0 .3em' + Q + '>行业（细分）</div>' +
        '<div class="mkt-list">' + industryRows + '</div>' : '') + '</div>',
    '<div class="mkt-box mkt-wide"><div class="mkt-h">最热门股票</div><div class="mkt-hot">' +
      '<div class="mkt-hot-col"><div class="mkt-hot-h">涨幅榜</div>' + (card.hotGain || []).map(hotRow).join('') + '</div>' +
      '<div class="mkt-hot-col"><div class="mkt-hot-h">主力净流入榜</div>' + (card.hotFund || []).map(hotRow).join('') + '</div>' +
      '</div></div>',
    outlookHtml(card, opts),
    '</div>',
    '</section>',
  ].join('\n');
}


// ---------------- 财联社新闻股票看板（当天行情卡片之后、表格之前） ----------------
// 全部指标都由表格自身的行数据算出，不额外请求网络。
// 口径：一条记录 = 一条新闻 × 一只涉及股票；涨幅 = 该股在新闻当日的涨跌幅；胜率 = 当日上涨的记录占比。
function boardThemes(conclusion) {
  const m = /题材：([^\n]+)/.exec(String(conclusion || ''));
  if (!m) return [];
  return m[1].split(/[、,，]/).map(function (x) { return x.trim(); })
    .filter(function (x) { return x && !/数据暂未取到|资料暂缺|暂未取到/.test(x); });
}

function boardPct(item) { return item.nn ? mkPct(item.sum / item.nn) : '—'; }
function boardWin(item) { return item.nn ? Math.round(item.wins / item.nn * 100) + '%' : '—'; }

/**
 * 新闻看板「个股表现」的候选池：把「新闻 × 股票」的记录聚合成每只股票的条数、平均涨幅、胜率。
 * 只做聚合不做排序——排序（按 5 日动能）在 src/cli.js 里用日线缓存算，看板与明细页共用同一份顺序。
 */
function boardStocks(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const name = r && (r.stockName || r.stock);
    if (!name) continue;
    if (!map.has(name)) map.set(name, { name: name, code: r.stockCode || '', n: 0, nn: 0, sum: 0, wins: 0 });
    const a = map.get(name);
    if (!a.code && r.stockCode) a.code = r.stockCode;
    a.n++;
    const v = Number(r.changePct);
    if (r.changePct !== null && r.changePct !== undefined && Number.isFinite(v)) {
      a.nn++;
      a.sum += v;
      if (v > 0) a.wins++;
    }
  }
  return Array.from(map.values());
}

/** 把新闻×股票的行聚合成题材 / 栏目 / 个股三个维度，并渲染成看板。 */
function newsBoardHtml(rows, opts) {
  opts = opts || {};
  const list = (rows || []).filter(function (r) { return r && (r.stockCode || r.stockName); });
  if (list.length < 5) return '';
  const pctOf = function (r) {
    const v = Number(r.changePct);
    return r.changePct === null || r.changePct === undefined || !Number.isFinite(v) ? null : v;
  };
  const bump = function (map, key, pct, code) {
    if (!key) return;
    if (!map.has(key)) map.set(key, { name: key, n: 0, nn: 0, sum: 0, wins: 0, stocks: new Set() });
    const a = map.get(key);
    a.n++;
    if (pct !== null) { a.nn++; a.sum += pct; if (pct > 0) a.wins++; }
    if (code) a.stocks.add(code);
  };
  const topic = new Map();
  const column = new Map();
  const stock = new Map();
  const codes = new Set();
  let nnAll = 0;
  let sumAll = 0;
  let winsAll = 0;
  for (const r of list) {
    const p = pctOf(r);
    if (p !== null) { nnAll++; sumAll += p; if (p > 0) winsAll++; }
    if (r.stockCode) codes.add(r.stockCode);
    for (const t of boardThemes(r.researchConclusion)) bump(topic, t, p, r.stockCode);
    bump(column, r.prefix, p, r.stockCode);
    bump(stock, r.stockName || r.stock, p, r.stockCode);
  }
  const byAvg = function (map, limit) {
    return Array.from(map.values())
      .sort(function (a, b) {
        const av = a.nn ? a.sum / a.nn : -999;
        const bv = b.nn ? b.sum / b.nn : -999;
        return (bv - av) || (b.n - a.n);
      })
      .slice(0, limit);
  };
  const byCount = function (map, limit) {
    return Array.from(map.values())
      .sort(function (a, b) { return (b.n - a.n) || ((b.nn ? b.sum / b.nn : -999) - (a.nn ? a.sum / a.nn : -999)); })
      .slice(0, limit);
  };
  // 胜率排序：样本 < 2 条的一律排除，否则「1 条 +20%」会霸榜成 100%
  const byWin = function (map, limit) {
    return Array.from(map.values())
      .filter(function (x) { return x.nn >= 2; })
      .sort(function (a, b) { return (b.wins / b.nn - a.wins / a.nn) || (b.nn - a.nn); })
      .slice(0, limit);
  };
  const cells = function (item, i, nameHtml, meta) {
    return '<div class="mk-row"><span class="mk-rank' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</span>' +
      nameHtml +
      '<span class="mk-meta">' + meta + '</span>' +
      '<span class="mk-p ' + mkCls(item.nn ? item.sum / item.nn : 0) + '">' + boardPct(item) + '</span>' +
      '<span class="mk-fund">胜率 ' + boardWin(item) + '</span></div>';
  };
  const stockLink = function (name) {
    return esc(name);
  };
  const topicRows = byCount(topic, 8).map(function (t, i) {
    return cells(t, i, '<span class="mk-k">' + esc(t.name) + '</span>', t.n + ' 次 · ' + t.stocks.size + ' 只');
  }).join('');
  const columnRows = byAvg(column, 8).map(function (t, i) {
    return cells(t, i, '<span class="mk-k">' + esc(t.name) + '</span>', t.n + ' 条');
  }).join('');
  const winRows = byWin(column, 8).map(function (t, i) {
    const rate = t.wins / t.nn;
    return '<div class="mk-row"><span class="mk-rank' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</span>' +
      '<span class="mk-k">' + esc(t.name) + '</span>' +
      '<span class="mk-meta">' + t.n + ' 条</span>' +
      '<span class="mk-p ' + mkCls(rate - 0.5) + '">胜率 ' + boardWin(t) + '</span>' +
      '<span class="mk-fund">' + boardPct(t) + '</span></div>';
  }).join('');
  // 看板与明细页共用 cli.js 传来的同一份「按动能排序」名单；没有传（如本地只导表）时退回按平均涨幅
  const useMomentum = !!(opts.boardStocks && opts.boardStocks.length);
  const stockRows = (useMomentum ? opts.boardStocks.slice(0, 8) : byAvg(stock, 8)).map(function (t, i) {
    const code = t.code || Array.from(t.stocks || [])[0] || '';
    const nameHtml = code
      ? '<a class="mk-link" href=' + Q + 'https://quote.eastmoney.com/' + encodeURIComponent(code) + '.html' + Q +
        ' target=' + Q + '_blank' + Q + ' rel=' + Q + 'noopener noreferrer' + Q + '>' + esc(t.name) + '</a>'
      : '<span class="mk-k">' + esc(t.name) + '</span>';
    if (!useMomentum) return cells(t, i, nameHtml, t.n + ' 条');
    const mom = t.mom;
    const score = mom && mom.score !== undefined && mom.score !== null ? mom.score : null;
    const momHtml = score === null
      ? '<span class="mk-p" title="RSI / KDJ / MACD 数据不足">动能 —</span>'
      : '<span class="mk-p ' + mkCls(score - 50) + '" title=' + Q + esc(momentumText(mom)) + Q + '>动能 ' + score + '</span>';
    return '<div class="mk-row"><span class="mk-rank' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</span>' +
      nameHtml +
      '<span class="mk-meta">' + t.n + ' 条 · 胜率 ' + boardWin(t) + '</span>' +
      momHtml +
      '<span class="mk-fund">' + boardPct(t) + '</span></div>';
  }).join('');
  const avgAll = nnAll ? sumAll / nnAll : null;
  const summary = '<div class="bd-stats">' +
    '<span><b>' + list.length + '</b> 条记录</span>' +
    '<span><b>' + codes.size + '</b> 只股票</span>' +
    '<span><b>' + column.size + '</b> 个栏目</span>' +
    '<span><b>' + topic.size + '</b> 个题材</span>' +
    '<span>样本平均涨幅 <b class="' + mkCls(avgAll === null ? 0 : avgAll) + '">' + (avgAll === null ? '—' : mkPct(avgAll)) + '</b></span>' +
    '<span>上涨占比 <b>' + (nnAll ? Math.round(winsAll / nnAll * 100) + '%' : '—') + '</b></span>' +
    '</div>';
  return [
    '<section class="mkt">',
    '<div class="mkt-hd"><strong>财联社新闻股票看板</strong><span class="mkt-sub">' +
      '涨幅 = 该股在新闻当日的涨跌幅 ｜ 胜率 = 当日上涨记录占比 ｜ 一行为一条「新闻 × 股票」 ｜ ' +
      '动能 = RSI(14)×30% + KDJ(9,3,3)×30% + MACD(12,26,9)×40%（各指标先折算成 0-100：RSI 70 以上按超买回落，KDJ 按 K/D 金叉强度与 J 超买超卖，MACD 按柱状强度与零轴位置；鼠标悬停看分解）</span></div>',
    summary,
    '<div class="mkt-grid">',
    '<div class="mkt-box"><div class="mkt-h">最热题材 / 板块（按提及次数）</div><div class="mkt-list">' + topicRows + '</div></div>',
    '<div class="mkt-box"><div class="mkt-h">各栏目表现（按平均涨幅）</div><div class="mkt-list">' + columnRows + '</div></div>',
    '<div class="mkt-box"><div class="mkt-h">各栏目胜率（样本 ≥ 2 条）</div><div class="mkt-list">' + winRows + '</div></div>',
    '<div class="mkt-box"><div class="mkt-h">个股表现（' + (useMomentum ? '按动能排序' : '按平均涨幅') + '）' +
      (opts.boardHref
        ? ' <a href=' + Q + esc(opts.boardHref) + Q + ' title=' + Q + '按添加日期查看这些个股的当日与 T+1~T+5 表现' + Q +
          ' style=' + Q + 'margin-left:auto;color:#1257a8;font-weight:600;white-space:nowrap' + Q + '>明细表 →</a>'
        : '') +
      '</div><div class="mkt-list">' + stockRows + '</div></div>',
    '</div>',
    '</section>',
  ].join('\n');
}

const BOARD_CSS = ".bd-stats{display:flex;flex-wrap:wrap;gap:.4em 1.5em;margin:0 0 .9em;padding:.6em .8em;background:#f7f9fc;border:1px solid #eef2f7;border-radius:.56em;color:#5b6472;font-size:.95em}.bd-stats b{font-size:1.08em;color:#1f252c;font-variant-numeric:tabular-nums}";
const MKT_TOGGLE_CSS = ".mk-click{cursor:pointer}.mk-click:hover{background:#f5f8fc}.mk-caret{flex:0 0 .9em;color:#aab2bd;font-size:.9em}.mk-click.open .mk-caret{transform:rotate(90deg)}.mk-sub{margin:.05em 0 .5em;padding:.1em 0 .1em .85em;border-left:2px solid #e3e8ef}.mk-sub[hidden]{display:none}.mk-subrow{border-bottom:0;padding:.04em 0;font-size:.96em}@media (max-width:760px){.mkt-grid,.mkt-hot{grid-template-columns:1fr}}";
const SORT_CSS = "th.sortable{cursor:pointer;-webkit-user-select:none;user-select:none;white-space:nowrap}th.sortable:hover{background:#e9edf3}th.sortable::after{content:' ⇅';color:#b6bcc6}th.sortable.sorted::after{content:' ↓';color:#1257a8}th.sortable.sorted-asc::after{content:' ↑';color:#1257a8}";

// 性能：页面实测 504 行 / 37,732 个节点 / 文档高 195,911px（新闻窗口满时按 800+ 行还会更多），
// 桌面端的主要开销来自「文本排版」而不是网络。两处调整：
//   · CSS_BASE 用的是 overflow-wrap:anywhere + word-break:break-word，等于允许在任意字符处断行，
//     浏览器算可断点最费；这里覆盖成只在「整词放不下」时才断（中文本来就能逐字换行，视觉不变），排版更快。
//   · 实测 Chrome 会忽略用在 <tr> 上的 content-visibility（对照实验：加与不加总高度都是 120667px），
//     用在 <td> 上则会把行高压扁到内边距（18227px），所以这里不做 content-visibility，避免既有开销又没效果。
const PERF_CSS = 'th,td{overflow-wrap:break-word;word-break:normal}';

// 多选筛选下拉：外观贴近原来的原生 select，展开是可勾多个值的浮层（原生 select multiple 在手机上是列表盒，不好用）
const MSEL_CSS = '.msel{position:relative;display:inline-block;max-width:240px}'
  + '.msel-btn{font:inherit;font-size:13px;min-height:34px;padding:7px 26px 7px 10px;border:1px solid #e5e5e5;border-radius:7px;background:#fff;color:#1c1c1e;cursor:pointer;text-align:left;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;position:relative}'
  + '.msel-btn:hover{border-color:#c9d8e0}.msel-btn:focus-visible{outline:2px solid #9fd3dd;outline-offset:1px}'
  + '.msel-btn::after{content:"▾";position:absolute;right:8px;top:50%;transform:translateY(-50%);color:#8a929e;font-size:11px}'
  + '.msel-pop{position:absolute;z-index:30;top:calc(100% + 4px);left:0;min-width:100%;max-width:24em;max-height:17em;overflow:auto;background:#fff;border:1px solid #e3e8ef;border-radius:8px;box-shadow:0 10px 26px rgba(16,24,40,.14);padding:6px}'
  + '.msel-pop[hidden]{display:none}'
  + '.msel-item{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap}'
  + '.msel-item:hover{background:#f2f7fa}.msel-item input{margin:0;flex:0 0 auto}'
  + '.msel-foot{display:flex;gap:8px;border-bottom:1px solid #eef1f5;margin:0 0 4px;padding:0 0 6px;position:sticky;top:0;background:#fff}'
  + '.msel-foot button{font:inherit;font-size:12px;padding:2px 8px;border:1px solid #d6e4ea;border-radius:6px;background:#f8fbfc;color:#155e75;cursor:pointer}'
  + '.msel-foot button:hover{background:#e6f6f8}'
  + '@media (max-width:760px){.msel{flex:1 1 100%;display:block;max-width:none}.msel-pop{max-width:none}}';
const CARD_SCRIPT = '<script>' + "(function(){\n  var els = document.querySelectorAll('[data-mk]');\n  function toggle(el){\n    var sub = document.getElementById(el.getAttribute('data-mk'));\n    if(!sub) return;\n    sub.hidden = !sub.hidden;\n    if(sub.hidden){ el.classList.remove('open'); } else { el.classList.add('open'); }\n  }\n  for (var i = 0; i < els.length; i++) {\n    (function(el){\n      el.addEventListener('click', function(){ toggle(el); });\n      el.addEventListener('keydown', function(e){ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggle(el); } });\n    })(els[i]);\n  }\n})();" + '<' + '/script>';


const MARKET_CSS = ".mkt{position:relative;background:linear-gradient(180deg,#fff 0%,#f7f9fc 100%);border:1px solid #e3e8ef;border-radius:1em;padding:1.16em 1.2em 1.2em;margin:0 0 1.3em;box-shadow:0 1px 2px rgba(16,24,40,.04),0 10px 26px -16px rgba(16,24,40,.28);font-size:12.5px}.mkt::before{content:'';position:absolute;left:0;right:0;top:0;height:.26em;border-radius:1em 1em 0 0;background:linear-gradient(90deg,#d93025 0%,#e8873a 46%,#2f9e5f 100%);opacity:.9}.mkt-hd{display:flex;align-items:baseline;gap:.6em;flex-wrap:wrap;margin-bottom:.92em}.mkt-hd strong{font-size:1.26em;letter-spacing:.01em}.mkt-sub{color:#8a929e;font-size:.95em}.mkt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(19.8em,1fr));gap:.9em}.mkt-box{border:1px solid #eaeef4;border-radius:.72em;padding:.82em .92em .9em;background:#fff;min-width:0}.mkt-wide{grid-column:1/-1}.mkt-h{display:flex;align-items:center;gap:.44em;color:#5b6472;font-size:.95em;font-weight:700;margin-bottom:.62em}.mkt-h::before{content:'';width:.28em;height:.95em;border-radius:.14em;background:#c9d3e0}.mkt-list{display:block}.idx-item{display:flex;align-items:baseline;gap:.5em;padding:.3em .52em;border-radius:.46em;margin-bottom:.26em;background:#f7f9fc}.idx-item:last-child{margin-bottom:0}.idx-item.up{background:linear-gradient(90deg,#fdf1f0,#fff)}.idx-item.down{background:linear-gradient(90deg,#eef8f2,#fff)}.idx-n{color:#414a56;font-weight:600}.idx-v{margin-left:auto;color:#2a3038;font-variant-numeric:tabular-nums}.idx-p{flex:0 0 auto;min-width:4.6em;text-align:center;border-radius:.4em;padding:.08em .3em;font-weight:700;font-variant-numeric:tabular-nums}.idx-item.up .idx-p{background:#fdecea}.idx-item.down .idx-p{background:#e7f6ec}.br-bar{display:flex;height:.52em;border-radius:.26em;overflow:hidden;background:#eef1f5;margin:0 0 .62em}.br-bar i{display:block;height:100%}.br-bar i.up{background:#e05a52}.br-bar i.flat{background:#c8ced8}.br-bar i.down{background:#3aa06a}.mkt-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:.44em}.mk-stat{display:flex;flex-direction:column;align-items:center;gap:.08em;background:#f7f9fc;border:1px solid #eef2f7;border-radius:.5em;padding:.44em .3em}.mk-stat.up{background:#fdf3f2;border-color:#f8dcd9}.mk-stat.down{background:#eef8f2;border-color:#d8ecdf}.mk-stat-n{font-size:1.24em;font-weight:800;line-height:1.24;font-variant-numeric:tabular-nums}.mk-stat-l{color:#8a929e;font-size:.85em}.mkt-note{color:#8a929e;font-size:.9em;margin-top:.62em;line-height:1.6}.mk-row{display:flex;align-items:center;gap:.5em;flex-wrap:wrap;font-size:1em;line-height:1.8;padding:.14em 0;border-bottom:1px dashed #eef1f5}.mk-row:last-child{border-bottom:0}.mk-rank{flex:0 0 auto;min-width:1.5em;height:1.5em;line-height:1.5em;text-align:center;border-radius:.34em;background:#eef2f8;color:#69737f;font-size:.84em;font-weight:700;font-variant-numeric:tabular-nums}.mk-rank.top{background:linear-gradient(135deg,#f0b23c,#e2662f);color:#fff}.mk-k{color:#1f252c;font-weight:700}.mk-meta{color:#8a929e;font-size:.93em}.mk-best{margin-left:auto;color:#4a525c;font-size:.93em}.mk-link{color:#1257a8;text-decoration:none;font-weight:600;max-width:8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mk-p{flex:0 0 auto;margin-left:auto;min-width:4.4em;text-align:center;border-radius:.4em;padding:.08em .3em;font-weight:700;font-variant-numeric:tabular-nums}.mk-p.f-up{background:#fdecea}.mk-p.f-down{background:#e7f6ec}.mk-p.f-flat{background:#f1f3f6}.mk-fund{margin-left:.66em;min-width:5em;text-align:right;color:#6b737e;font-size:.93em;font-variant-numeric:tabular-nums}.mkt-hot{display:grid;grid-template-columns:repeat(auto-fit,minmax(16.8em,1fr));gap:.2em 1.5em}.mkt-hot-col{min-width:0}.mkt-hot-h{display:flex;align-items:center;gap:.4em;color:#5b6472;font-size:.9em;font-weight:700;margin:.2em 0 .32em}.mkt-hot-h::before{content:'';width:.34em;height:.34em;border-radius:50%;background:#c9d3e0}.f-flat{color:#6b7280}body.mk-phone .mkt{font-size:28px}";


const CSS_BASE = "body{font-family:'Microsoft YaHei',system-ui,sans-serif;margin:24px;color:#1c1c1e;background:#fafafa}h1{font-size:20px;margin:0 0 6px}.meta{color:#666;font-size:13px;margin-bottom:16px}.meta a{white-space:nowrap}.hint{color:#888;font-size:12.5px}table{border-collapse:collapse;width:100%;background:#fff;font-size:13px;table-layout:fixed}th,td{border:1px solid #e5e5e5;padding:8px 10px;vertical-align:top;text-align:left;overflow-wrap:anywhere;word-break:break-word}th{background:#f2f3f5;position:sticky;top:0;z-index:2}td.t{white-space:normal;color:#555;font-variant-numeric:tabular-nums}td.txt{line-height:1.6;white-space:pre-wrap}td.src{white-space:nowrap;color:#888;font-size:12px}.pf{display:inline-block;background:#fff1e6;color:#c2410c;border:1px solid #ffd7bd;border-radius:3px;padding:1px 6px;white-space:normal;overflow-wrap:anywhere;word-break:break-word;line-height:1.45;text-align:center}.pl{display:inline-block;background:#eef4fb;color:#1257a8;border:1px solid #cfe0f2;border-radius:3px;padding:1px 6px;white-space:nowrap;font-size:12px;margin:0 3px 2px 0}a{color:#1257a8;text-decoration:none}a:hover{text-decoration:underline}.tw{background:#fff}" ;

// ---------------- 页面最前边的直达入口 ----------------
// 本看板各版本 + 数据文件 + 同账号下其他看板。全部用绝对地址，任何页面、本地打开都能直接点。
const SITE_BASE = 'https://yunqingzou-bit.github.io/';
const NAV_GROUPS = [
  { label: '本看板', items: [
    { label: '明日关注个股明细', href: SITE_BASE + 'cls-news-dashboard/outlook/', title: '明日看点关注个股的历史明细表' },
    { label: '新闻看板个股明细', href: SITE_BASE + 'cls-news-dashboard/stocks/', title: '财联社新闻股票看板 · 个股表现的历史明细表' },
    { label: 'Stockbee 动量爆发', href: SITE_BASE + 'cls-news-dashboard/stockbee/', title: 'A股近三个月信号与前瞻收益' },
  ] },
  { label: '其他看板', items: [
    { label: '财联社新闻精选20', href: SITE_BASE + 'cls-news-impact-dashboard/' },
    { label: 'A股脉冲 · 实时行情雷达', href: SITE_BASE + 'cls-news-impact-dashboard/a-share-pulse/' },
    { label: '选股策略回测看板', href: SITE_BASE + 'ashare-strategy-dashboard/', title: '回测区间 2026-07-13 ~ 09-11' },
  ] },
];

const NAV_CSS = '.nav{display:flex;flex-wrap:wrap;gap:.5em 1.1em;align-items:center;background:#fff;border:1px solid #e3e8ef;border-radius:.8em;padding:.6em .8em;margin:0 0 1.1em;font-size:12.5px;box-shadow:0 1px 2px rgba(16,24,40,.04)}.nav-g{display:flex;flex-wrap:wrap;align-items:center;gap:.4em}.nav-g i{color:#8a929e;font-style:normal;font-weight:700}.nav-g a{display:inline-block;padding:.2em .62em;border:1px solid #d6e4ea;border-radius:999px;background:#f8fbfc;color:#155e75;text-decoration:none;white-space:nowrap}.nav-g a:hover{background:#e6f6f8;border-color:#9fd3dd}body.mk-phone .nav{font-size:26px}@media (max-width:760px){.nav{gap:.45em .8em;padding:.55em .6em}.nav-g{gap:.3em}}';

/** 动能分的可读分解：用于看板行内提示（悬停）与明细页小字。 */
function momentumText(mom) {
  if (!mom || mom.score === undefined || mom.score === null) return '动能分：RSI / KDJ / MACD 数据不足';
  const p = ['动能 ' + mom.score + '（0-100）'];
  if (mom.rsi !== null && mom.rsi !== undefined) {
    p.push('RSI(14) ' + mom.rsi + '（' + (mom.rsiState || '') + '）×30% = ' + mom.rsiScore);
  }
  if (mom.kdj) {
    p.push('KDJ(9,3,3) K' + mom.kdj.k + '/D' + mom.kdj.d + '/J' + mom.kdj.j + '（' + mom.kdj.cross +
      (mom.kdj.state && mom.kdj.state !== '中性' ? '·' + mom.kdj.state : '') + '）×30% = ' + mom.kdj.score);
  }
  if (mom.macd) {
    p.push('MACD(12,26,9) DIF' + mom.macd.dif + '/DEA' + mom.macd.dea + '（' + mom.macd.cross + '·' +
      mom.macd.turning + '·' + mom.macd.state + '）×40% = ' + mom.macd.score);
  }
  return p.join(' ｜ ');
}

/** 明细页小字：动能 84 · RSI 93.2（超买）· KDJ 金叉 · MACD 金叉 */
function momentumBrief(mom) {
  if (!mom || mom.score === undefined || mom.score === null) return '';
  const p = ['动能 ' + mom.score];
  if (mom.rsi !== null && mom.rsi !== undefined) {
    p.push('RSI ' + mom.rsi + (mom.rsiState && mom.rsiState !== '中性' ? '（' + mom.rsiState + '）' : ''));
  }
  if (mom.kdj) p.push('KDJ ' + mom.kdj.cross);
  if (mom.macd) p.push('MACD ' + mom.macd.cross);
  return p.join(' · ');
}

function navHtml(opts) {
  if (opts && opts.nav === false) return '';
  const html = NAV_GROUPS.map(function (g) {
    const items = g.items.map(function (it) {
      // 看板之间同标签页切换（和标题栏的互跳一致）；数据文件另开标签页，点完不丢当前看板
      return '<a href=' + Q + esc(it.href) + Q + (it.newTab ? ' target=' + Q + '_blank' + Q + ' rel=' + Q + 'noopener noreferrer' + Q : '') +
        (it.title ? ' title=' + Q + esc(it.title) + Q : '') + '>' + esc(it.label) + '</a>';
    }).join('');
    return '<span class="nav-g"><i>' + esc(g.label) + '</i>' + items + '</span>';
  }).join('');
  return '<nav class="nav" aria-label="直达入口">' + html + '</nav>';
}

// 表格版：手机上仍然是表格，靠横向滚动保证列宽，避免挤压与文字重叠
// 表格版：手机上不生成窄屏布局，而是把页面宽度声明为表格设计宽度（1080），
// 由浏览器整页适配并按原生方式自由缩放（双指/双击），页面内部不再需要横向滚动。
// 下面这段样式只在浏览器忽略该宽度声明时兜底（例如个别旧内核），保证仍可左右查看。
const CSS_MOBILE_TABLE = "@media (max-width:760px){html,body{max-width:100%}body{margin:10px}h1{font-size:16px}.meta{font-size:12px;margin-bottom:10px}.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid #e5e5e5;border-radius:8px}table{width:1080px;min-width:1080px}th,td{font-size:12.5px;padding:6px 8px}th{position:static}td.t{font-size:12px}.research-item{margin-bottom:6px}}";

// 卡片版：窄屏把每行折叠成一张卡片（手机上更好读，作为独立链接保留）
const CSS_MOBILE_CARDS = "@media (max-width:760px){html,body{max-width:100%;overflow-x:hidden}body{margin:10px}h1{font-size:16px}.meta{font-size:12px;margin-bottom:10px}.tw{overflow:visible;border:0;border-radius:0}table,tbody{display:block;width:100%;min-width:0}table{border:0;background:transparent;table-layout:auto}colgroup{display:none}thead{display:none}tbody tr{display:flex;width:100%;box-sizing:border-box;min-width:0;flex-direction:column;background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:10px 12px;margin-bottom:10px}tbody td{display:block;width:100%;min-width:0;max-width:100%;border:0;padding:2px 0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}tbody td::before{content:attr(data-label);display:block;color:#888;font-size:11.5px;line-height:1.5}td[data-label=\"新闻标题\"]{order:1;font-size:15px;font-weight:600;padding-bottom:6px}td[data-label=\"新闻标题\"]::before{display:none}td[data-label=\"涉及股票\"]{order:2}td.txt{order:3;padding-top:6px;white-space:pre-wrap}td[data-label=\"新闻发布时间\"]{order:4;padding-top:6px}td[data-label=\"前缀类型\"]{order:5}td.src{order:6}td[data-label=\"所属股票池\"]{order:7}.research-item{margin-bottom:7px}}";

const BAR_CSS = ".bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px}.bar input[type=search]{flex:1 1 240px;min-width:0;font:inherit;font-size:13px;padding:7px 10px;border:1px solid #e5e5e5;border-radius:7px;background:#fff;color:#1c1c1e}.bar select{font:inherit;font-size:13px;padding:7px 10px;border:1px solid #e5e5e5;border-radius:7px;background:#fff;color:#1c1c1e;max-width:220px}.cnt{color:#888;font-size:12px;white-space:nowrap}@media (max-width:760px){.bar input[type=search]{flex:1 1 100%}.bar select{flex:1 1 40%}}";

const EXTRA_CSS = "td.perf,td.day,td.fwd{font-variant-numeric:tabular-nums;font-size:12.5px;line-height:1.7;color:#3b4149}td.turn,td.vol{font-variant-numeric:tabular-nums;font-size:12.5px;font-weight:600}td.research,td.tech{font-size:12.5px;line-height:1.7;color:#3b4149}.f-up{color:#d93025;font-weight:600}.f-down{color:#0f9d58;font-weight:600}.research-item{display:block;margin:0 0 5px}.research-item:last-child{margin-bottom:0}.research-key{font-weight:700;color:#20252b}.research-impact{color:#c62828;font-weight:700}.v-green{color:#0f9d58}.v-blue{color:#1a73e8}.v-red{color:#d93025}.up-strong{color:#d93025;font-weight:600}.up-limit{color:#8b0000;font-weight:700}@media (max-width:760px){td[data-label=\"发布后表现\"]{order:3}td[data-label=\"当日行情\"]{order:4}td[data-label=\"后续走势\"]{order:5}td[data-label=\"换手率\"]{order:6}td[data-label=\"量较前日\"]{order:7}td[data-label=\"调研结论\"]{order:8;padding-top:7px}td[data-label=\"技术面结论\"]{order:9;padding-top:7px}td[data-label=\"新闻发布时间\"]{order:10}td[data-label=\"前缀类型\"]{order:11}.research-item{margin-bottom:7px}}";

/**
 * opts.layout: 'table'（默认，任何屏幕都保持表格，窄屏横向滚动）| 'cards'（窄屏折叠成卡片）
 * opts.links: 附加在标题栏的互跳链接，形如 [{href,label}]
 */
function toHtml(rows, meta, opts) {
  opts = opts || {};
  const layout = opts.layout === 'cards' ? 'cards' : 'table';
  const mobileCss = layout === 'cards' ? CSS_MOBILE_CARDS : CSS_MOBILE_TABLE;
  // 只有表格版需要「按屏幕放大卡片字号」：卡片版本身就是设备宽度，放大反而会溢出被裁切
  const phoneHook = layout === 'table'
    ? "  if (screen && screen.width && screen.width <= 760) document.body.classList.add('mk-phone');"
    : '';
  const links = (opts.links || []).map(function (l) {
    return ' <a href=' + Q + esc(l.href) + Q + '>' + esc(l.label) + '</a>';
  }).join('');
  // 表格版把页面宽度声明为表格设计宽度：手机浏览器会整页缩放到屏幕并允许自由缩放（双指/双击），
  // 桌面浏览器会忽略 viewport 声明，因此桌面依旧是满宽表格。
  const viewportContent = layout === 'cards' ? 'width=device-width, initial-scale=1' : 'width=1080';
  const hintHtml = layout === 'cards' ? '' : '<div class=' + Q + 'hint' + Q + ' id=' + Q + 'hint' + Q + ' style=' + Q + 'display:none' + Q + '></div>';
  // 只渲染数据行实际存在的列，避免表头多出两列空列
  const th = HTML_HEADERS.map(function (h) {
    const key = SORTABLE_COLS[h];
    return key
      ? '<th class=' + Q + 'sortable' + Q + ' data-sort=' + Q + key + Q + ' title=' + Q + '点击排序' + Q + '>' + esc(h) + '</th>'
      : '<th>' + esc(h) + '</th>';
  }).join('');
  const colgroup = '<colgroup>' + HTML_COL_WIDTHS.map(function (w) { return '<col style=' + Q + 'width:' + w + '%' + Q + '>'; }).join('') + '</colgroup>';
  const body = rows.map(function (r) {
    const stockText = esc(r.stock || r.stocks);
    const stockHtml = r.stockCode
      ? '<a href=' + Q + 'https://quote.eastmoney.com/' + encodeURIComponent(r.stockCode) + '.html' + Q +
        ' target=' + Q + '_blank' + Q + ' rel=' + Q + 'noopener noreferrer' + Q +
        ' title=' + Q + '在东方财富查看行情与K线' + Q + '>' + stockText + '</a>'
      : stockText;
    return '<tr data-prefix=' + Q + esc(r.prefix) + Q +
      ' data-date=' + Q + esc(String(r.time || '').slice(0, 10)) + Q +
      ' data-turn=' + Q + numAttr(r.turnover) + Q +
      ' data-vol=' + Q + numAttr(r.volRatioPct) + Q +
      ' data-play=' + Q + esc(playFrom(r.researchConclusion)) + Q +
      ' data-trend=' + Q + esc(trendFrom(r.technicalConclusion)) + Q + '>' +
      '<td class=' + Q + 't' + Q + ' data-label=' + Q + '新闻发布时间' + Q + '>' + esc(r.time) + '</td>' +
      '<td data-label=' + Q + '涉及股票' + Q + '>' + stockHtml + '</td>' +
      '<td data-label=' + Q + '前缀类型' + Q + '><span class=' + Q + 'pf' + Q + '>' + esc(r.prefix) + '</span></td>' +
      '<td data-label=' + Q + '新闻标题' + Q + '><a href=' + Q + esc(r.url) + Q + ' target=' + Q + '_blank' + Q + '>' + esc(r.title) + '</a></td>' +
      '<td class=' + Q + 'perf' + Q + ' data-label=' + Q + '发布后表现' + Q + '>' + esc(afterText(r)) + '</td>' +
      '<td class=' + Q + 'day' + Q + ' data-label=' + Q + '当日行情' + Q + '>' + dayHtml(r) + '</td>' +
      '<td class=' + Q + 'fwd' + Q + ' data-label=' + Q + '后续走势' + Q + '>' + forwardHtml(r) + '</td>' +
      '<td class=' + Q + 'turn ' + turnLevel(r.turnover) + Q + ' data-label=' + Q + '换手率' + Q + '>' + esc(turnText(r)) + '</td>' +
      '<td class=' + Q + 'vol ' + volLevel(r.volRatioPct) + Q + ' data-label=' + Q + '量较前日' + Q + '>' + esc(volText(r)) + '</td>' +
      '<td class=' + Q + 'research' + Q + ' data-label=' + Q + '调研结论' + Q + '>' + researchHtml(r.researchConclusion) + '</td>' +
      '<td class=' + Q + 'tech' + Q + ' data-label=' + Q + '技术面结论' + Q + '>' + technicalHtml(r.technicalConclusion) + '</td>' +
      '</tr>';
  }).join('\n');
  const toolbar = [
    '<div class=' + Q + 'bar' + Q + '>',
    '<input id=' + Q + 'q' + Q + ' type=' + Q + 'search' + Q + ' placeholder=' + Q + '搜索股票、标题或正文…' + Q + '>',
    // 四个筛选器都改成可多选的复选下拉，data-* 让脚本自己认领
    '<div class=' + Q + 'msel' + Q + ' data-msel=' + Q + 'data-prefix' + Q + ' data-label=' + Q + '全部栏目' + Q + '></div>',
    '<div class=' + Q + 'msel' + Q + ' data-msel=' + Q + 'data-date' + Q + ' data-label=' + Q + '全部日期' + Q + '></div>',
    '<div class=' + Q + 'msel' + Q + ' data-msel=' + Q + 'data-play' + Q + ' data-label=' + Q + '全部短线博弈' + Q + ' data-prefer=' + Q + '适合,可关注,中性,不适合' + Q + '></div>',
    '<div class=' + Q + 'msel' + Q + ' data-msel=' + Q + 'data-trend' + Q + ' data-label=' + Q + '全部趋势' + Q + '></div>',
    '<span class=' + Q + 'cnt' + Q + ' id=' + Q + 'cnt' + Q + '></span>',
    '</div>',
  ].join('');
  const script = '<script>' + `
(function(){
  var rows = [].slice.call(document.querySelectorAll('tbody tr'));
  var q = document.getElementById('q');
  var cnt = document.getElementById('cnt');
  var hint = document.getElementById('hint');
  if (hint && screen && screen.width && screen.width <= 760) {
    hint.textContent = '已按屏幕整页适配：双指缩放或双击可放大查看细节';
    hint.style.display = 'block';
  }
  ${phoneHook}
  if (!rows.length || !q) return;
  var initialQuery = new URLSearchParams(location.search).get('q');
  if (initialQuery) q.value = initialQuery;
  // 行内可搜索文本：排序会改 DOM 顺序，所以用 Map 与行一一对应；改成第一次搜索时才建，
  // 省掉加载时对几百行长文本的一整趟扫描
  var searchText = null;
  function textCache() {
    if (searchText) return searchText;
    searchText = new Map();
    rows.forEach(function (r) { searchText.set(r, (r.textContent || '').toLowerCase()); });
    return searchText;
  }
  // 多选筛选：每个筛选器是一个复选下拉，可以同时勾多个值；不勾 = 该项不过滤
  function closeAll() {
    filters.forEach(function (f) { f.pop.hidden = true; f.btn.setAttribute('aria-expanded', 'false'); });
  }
  function buildFilter(box) {
    var attr = box.getAttribute('data-msel');
    var label = box.getAttribute('data-label') || '全部';
    var prefer = (box.getAttribute('data-prefer') || '').split(',').filter(Boolean);
    var counts = {};
    var list = [];
    rows.forEach(function (r) {
      var v = r.getAttribute(attr) || '';
      if (!v) return;
      if (counts[v] === undefined) { counts[v] = 0; list.push(v); }
      counts[v]++;
    });
    if (prefer.length) {
      list.sort(function (a, b) {
        var ia = prefer.indexOf(a);
        var ib = prefer.indexOf(b);
        if (ia < 0) ia = 99;
        if (ib < 0) ib = 99;
        return ia - ib;
      });
    } else {
      list.sort(function (a, b) { return (counts[b] - counts[a]) || a.localeCompare(b); });
    }
    var state = { attr: attr, label: label, sel: {}, active: 0 };
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msel-btn';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    var pop = document.createElement('div');
    pop.className = 'msel-pop';
    pop.hidden = true;
    var foot = document.createElement('div');
    foot.className = 'msel-foot';
    var allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.textContent = '全选';
    var noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.textContent = '清空';
    foot.appendChild(allBtn);
    foot.appendChild(noneBtn);
    pop.appendChild(foot);
    var boxes = {};
    function refreshLabel() {
      var picked = Object.keys(state.sel);
      if (!picked.length) btn.textContent = label;
      else if (picked.length === 1) btn.textContent = picked[0];
      else if (picked.length === 2) btn.textContent = picked[0] + '、' + picked[1];
      else btn.textContent = picked[0] + '、' + picked[1] + ' 等 ' + picked.length + ' 项';
    }
    function setAll(on) {
      Object.keys(boxes).forEach(function (v) {
        boxes[v].checked = on;
        if (on) state.sel[v] = 1; else delete state.sel[v];
      });
      state.active = on ? Object.keys(boxes).length : 0;
      refreshLabel();
      apply();
    }
    list.forEach(function (v) {
      var item = document.createElement('label');
      item.className = 'msel-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = v;
      var sp = document.createElement('span');
      sp.textContent = v + '（' + counts[v] + '）';
      item.appendChild(cb);
      item.appendChild(sp);
      pop.appendChild(item);
      boxes[v] = cb;
      cb.addEventListener('change', function () {
        if (cb.checked) state.sel[v] = 1; else delete state.sel[v];
        state.active = Object.keys(state.sel).length;
        refreshLabel();
        apply();
      });
    });
    allBtn.addEventListener('click', function (e) { e.stopPropagation(); setAll(true); });
    noneBtn.addEventListener('click', function (e) { e.stopPropagation(); setAll(false); });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = pop.hidden;
      closeAll();
      pop.hidden = !open;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
    });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    box.appendChild(btn);
    box.appendChild(pop);
    state.btn = btn;
    state.pop = pop;
    refreshLabel();
    return state;
  }
  var filters = [].slice.call(document.querySelectorAll('.msel')).map(buildFilter);
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
  function apply() {
    var kw = q.value.trim().toLowerCase();
    var cache = kw ? textCache() : null;
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i];
      var ok = true;
      for (var f = 0; f < filters.length; f++) {
        var obj = filters[f];
        if (!obj.active) continue;
        if (obj.sel[el.getAttribute(obj.attr) || ''] !== 1) { ok = false; break; }
      }
      if (ok && kw) ok = (cache.get(el) || '').indexOf(kw) > -1;
      // 只在显示状态真的要变时才写 style：初次渲染和反复筛选时能省掉几百次无意义的样式写入与重排
      var want = ok ? '' : 'none';
      if (el.style.display !== want) el.style.display = want;
      if (ok) n++;
    }
    cnt.textContent = '显示 ' + n + ' / ' + rows.length + ' 条';
  }
  // 输入时别每敲一个字就全表扫描（几百行 × 长结论文字）：停 140ms 再过滤
  var searchTimer = null;
  q.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(apply, 140);
  });
  // 表头点击排序：换手率 / 量较前日；空值恒排最后
  var sortKey = null;
  var sortDir = -1;
  var tbody = rows[0].parentNode;
  var ths = document.querySelectorAll('th[data-sort]');
  function sortRows(key, dir) {
    rows.sort(function (a, b) {
      var av = parseFloat(a.getAttribute(key));
      var bv = parseFloat(b.getAttribute(key));
      var an = isFinite(av);
      var bn = isFinite(bv);
      if (!an && !bn) return 0;
      if (!an) return 1;
      if (!bn) return -1;
      return (av - bv) * dir;
    });
    rows.forEach(function (r) { tbody.appendChild(r); });
    apply();
  }
  for (var t = 0; t < ths.length; t++) {
    (function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        sortDir = (sortKey === key && sortDir === -1) ? 1 : -1;
        sortKey = key;
        for (var j = 0; j < ths.length; j++) ths[j].classList.remove('sorted', 'sorted-asc');
        th.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted');
        sortRows(key, sortDir);
      });
    })(ths[t]);
  }
  apply();
})();
` + '<' + '/script>';
  return [
    '<!doctype html>',
    '<html lang=' + Q + 'zh-CN' + Q + '><head><meta charset=' + Q + 'utf-8' + Q + '><meta name=' + Q + 'viewport' + Q + ' content=' + Q + viewportContent + Q + '>',
    '<title>财联社栏目新闻 ' + esc(meta.title || '') + '</title>',
    '<style>' + CSS_BASE + mobileCss + BAR_CSS + EXTRA_CSS + MARKET_CSS + BOARD_CSS + MKT_TOGGLE_CSS + SORT_CSS + NAV_CSS + PERF_CSS + MSEL_CSS + '</style></head><body>',
    navHtml(opts),
    '<h1>' + esc(meta.title || '财联社自选股 · 目标栏目新闻') + '</h1>',
    '<div class=' + Q + 'meta' + Q + '>区间 ' + esc(meta.range) + ' ｜ 共 ' + rows.length + ' 条 ｜ 股票池 ' + esc(meta.poolLabel) + ' ｜ 生成于 ' + esc(meta.generatedAt) + links + '</div>',
    hintHtml,
    marketCardHtml(meta.card, opts),
    newsBoardHtml(rows, opts),
    toolbar,
    '<div class=' + Q + 'tw' + Q + '><table>' + colgroup + '<thead><tr>' + th + '</tr></thead><tbody>',
    body,
    '</tbody></table></div>',
    script,
    CARD_SCRIPT,
    '</body></html>',
  ].join('\n');
}

function stamp(d) {
  d = d || new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

/**
 * 导出表格。opts.fileBase 决定文件名前缀，例如 "cls-news" 或 "cls-news-sz399006"。
 * 同时写一份 <fileBase>-latest.* 便于固定路径引用，并只保留最近 5 组带时间戳的导出。
 */
function exportAll(rows, meta, opts) {
  opts = opts || {};
  const base = opts.fileBase || 'cls-news';
  if (opts.stamp === false) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const fix = {
      csv: path.join(OUT_DIR, base + '-latest.csv'),
      html: path.join(OUT_DIR, base + '-latest.html'),
      json: path.join(OUT_DIR, base + '-latest.json'),
    };
    fs.writeFileSync(fix.csv, toCsv(rows), 'utf8');
    fs.writeFileSync(fix.html, toHtml(rows, meta, opts), 'utf8');
    fs.writeFileSync(fix.json, JSON.stringify({ meta: meta, rows: rows }, null, 1), 'utf8');
    pruneExports(base, 5);
    return { csvPath: fix.csv, htmlPath: fix.html, jsonPath: fix.json, cardsPath: writeCardsVariant(rows, meta, opts, base) };
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tag = stamp();
  const csvPath = path.join(OUT_DIR, base + '-' + tag + '.csv');
  const htmlPath = path.join(OUT_DIR, base + '-' + tag + '.html');
  const jsonPath = path.join(OUT_DIR, base + '-' + tag + '.json');
  fs.writeFileSync(csvPath, toCsv(rows), 'utf8');
  fs.writeFileSync(htmlPath, toHtml(rows, meta, opts), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ meta: meta, rows: rows }, null, 1), 'utf8');
  fs.copyFileSync(csvPath, path.join(OUT_DIR, base + '-latest.csv'));
  fs.copyFileSync(htmlPath, path.join(OUT_DIR, base + '-latest.html'));
  fs.copyFileSync(jsonPath, path.join(OUT_DIR, base + '-latest.json'));
  pruneExports(base, 5);
  return { csvPath: csvPath, htmlPath: htmlPath, jsonPath: jsonPath, cardsPath: writeCardsVariant(rows, meta, opts, base) };
}

/**
 * 另存一份「卡片版」页面（窄屏折叠成卡片）。
 * 主页面保持表格形式，卡片版作为独立链接保留同一套数据。
 */
function writeCardsVariant(rows, meta, opts, base) {
  if (!opts.alsoCards) return null;
  const p = path.join(OUT_DIR, base + '-cards.html');
  // 卡片版挂在 /cards/ 下，链接要退回上一级才能指到 /outlook/
  const outlookHref = opts.outlookHref ? '../' + opts.outlookHref : '';
  const boardHref = opts.boardHref ? '../' + opts.boardHref : '';
  fs.writeFileSync(p, toHtml(rows, meta, {
    layout: 'cards', links: opts.cardsLinks || [], outlookHref: outlookHref,
    boardHref: boardHref, boardStocks: opts.boardStocks,
  }), 'utf8');
  return p;
}

/** 只保留最近 keepSets 组带时间戳的导出，避免定期刷新把 out/ 撑爆。 */
function pruneExports(base, keepSets) {
  if (!fs.existsSync(OUT_DIR)) return;
  const re = new RegExp('^' + base.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&') + '-(\\d{8}-\\d{4})\\.(csv|html|json)$');
  const tags = {};
  for (const f of fs.readdirSync(OUT_DIR)) {
    const m = re.exec(f);
    if (m) tags[m[1]] = true;
  }
  const keep = new Set(Object.keys(tags).sort().slice(-keepSets));
  for (const f of fs.readdirSync(OUT_DIR)) {
    const m = re.exec(f);
    if (m && !keep.has(m[1])) fs.unlinkSync(path.join(OUT_DIR, f));
  }
}

module.exports = { exportAll: exportAll, toCsv: toCsv, toHtml: toHtml, HEADERS: HEADERS, TEXT_SOURCE_LABEL: TEXT_SOURCE_LABEL, OUT_DIR: OUT_DIR,
  researchHtml: researchHtml, technicalHtml: technicalHtml, outlookShort: outlookShort, boardStocks: boardStocks,
  momentumText: momentumText, momentumBrief: momentumBrief };
