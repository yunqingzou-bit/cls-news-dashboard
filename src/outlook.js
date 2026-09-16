'use strict';
/**
 * 明日关注个股 · 明细表（「明日看点 → 关注个股」的历史留档）
 *
 * 数据流：
 *   1) src/market.js 生成的 card.outlook.picks（当日全市场快照推导出的关注名单）
 *   2) 每次生成卡片时把当天的名单并入 out/outlook.json：一个添加日期一段，只记首次纳入，跨轮次累积
 *      （云端靠 workflow 先 curl 线上 outlook.json 续接历史，和 stockbee.json 同一套路）
 *   3) 用 technical.js 的日线窗口算「当日 / T+1 ~ T+5」，用 research.js + technical.js 生成两份结论
 *   4) 输出 out/outlook.json（数据）与 out/outlook/index.html（Pages 上的 /outlook/ 页面）
 *
 * 只给最近 N 个交易日刷新日线与调研：T+5 最多 6 个交易日就能补满，更早的行用已算好的值直接渲染，
 * 避免历史行无限重拉。
 */
const fs = require('node:fs');
const path = require('node:path');
const collectMod = require('./collect.js');
const report = require('./report.js');
const technical = require('./technical.js');
const research = require('./research.js');
const quotes = require('./quotes.js');

const Q = String.fromCharCode(34);
const OUT_DIR = report.OUT_DIR;
const PAGE_DIR = path.join(OUT_DIR, 'outlook');
const PAGE_FILE = path.join(PAGE_DIR, 'index.html');
const DATA_FILE = path.join(OUT_DIR, 'outlook.json');

const LOG_VERSION = 1;
const MAX_DAYS = 120;            // 日志最多保留多少个添加日期
const DEFAULT_RECENT_DAYS = 8;   // 默认给最近多少个交易日刷新日线/调研
// 09:30 之前的全市场快照还是上一交易日的收盘价，这时候记录会把昨天算成今天
const OPEN_MINUTE = 9 * 60 + 30;
const INDEX_CODES = ['sh000001', 'sz399001', 'sh600000'];
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const CN_NUM = { 3: '三', 5: '五', 10: '十' };
const HEADERS = ['添加时间', '股票名称', '前十日日均涨幅', '前五日日均涨幅', '前三日日均涨幅', '前一日涨幅',
  '当日涨幅', 'T+1涨幅', 'T+2涨幅', 'T+3涨幅', 'T+4涨幅', 'T+5涨幅', '五日平均涨幅', '调研结论', '技术面结论'];
// 手机端整页按 1080px 渲染：前 4 列之后有 11 个纯数值列，列宽要保证「+20.00%」「-10.04%」这类最长的涨跌幅整行放下
const COL_WIDTHS = [8, 6.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 12.5, 12.5];
const PRE_WINDOWS = [{ key: 'a10', n: 'n10', len: 10 }, { key: 'a5', n: 'n5', len: 5 }, { key: 'a3', n: 'n3', len: 3 }];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** 统一按东八区换算，不依赖 runner 的本地时区。 */
function shanghai(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  const iso = d.toISOString();
  return {
    day: iso.slice(0, 10),
    hm: iso.slice(11, 16),
    text: iso.slice(0, 16).replace('T', ' '),
    weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function secOf(text) {
  // 'YYYY-MM-DD HH:mm'（东八区）-> 秒级时间戳
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(text || ''));
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]) / 1000);
}

function dayLabel(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return String(day || '');
  const w = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return day + '（' + WEEKDAY[w] + '）';
}

function pct(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mean(list) {
  let sum = 0;
  let n = 0;
  for (const v of list) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
    sum += Number(v);
    n++;
  }
  return n ? { value: Math.round(sum / n * 100) / 100, n: n } : { value: null, n: 0 };
}

/**
 * 纳入当日前 N 个交易日的日均涨幅（不含纳入当日）：
 * 用 technical.js 缓存里 recent（最近 30 个交易日的 [日期, 收盘, 当日涨幅]）取纳入日之前的窗口。
 * 纳入日晚于最后一根日线时（盘中抓取、当日 K 线还没生成）退化成「用全部可用日线」，结果一致。
 */
function preStats(rec, dayKey) {
  const out = { d1: null, a3: null, a5: null, a10: null, n3: 0, n5: 0, n10: 0 };
  const recent = rec && rec.metrics && rec.metrics.recent;
  if (!recent || !recent.length || !dayKey) return out;
  let i = -1;
  for (let k = 0; k < recent.length; k++) {
    if (String(recent[k][0]) >= dayKey) { i = k; break; }
  }
  if (i < 0) i = recent.length;
  const vals = [];
  for (let k = Math.max(0, i - 10); k < i; k++) {
    const v = Number(recent[k][2]);
    if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return out;
  out.d1 = Math.round(vals[vals.length - 1] * 100) / 100;
  const avg = function (len) {
    const seg = vals.slice(Math.max(0, vals.length - len));
    return { v: Math.round(seg.reduce(function (a, b) { return a + b; }, 0) / seg.length * 100) / 100, n: seg.length };
  };
  const a3 = avg(3);
  const a5 = avg(5);
  const a10 = avg(10);
  out.a3 = a3.v; out.n3 = a3.n;
  out.a5 = a5.v; out.n5 = a5.n;
  out.a10 = a10.v; out.n10 = a10.n;
  return out;
}

function emptyLog() {
  return { version: LOG_VERSION, updatedAt: new Date().toISOString(), days: [] };
}

function loadLog() {
  const log = readJson(DATA_FILE);
  if (!log || !Array.isArray(log.days)) return emptyLog();
  log.days = log.days.filter(function (d) { return d && d.day; });
  for (const d of log.days) {
    if (!Array.isArray(d.picks)) d.picks = [];
    for (const p of d.picks) if (!Array.isArray(p.t)) p.t = [null, null, null, null, null];
  }
  return log;
}

function saveLog(log) {
  log.version = LOG_VERSION;
  log.updatedAt = new Date().toISOString();
  log.days.sort(function (a, b) { return a.day < b.day ? 1 : a.day > b.day ? -1 : 0; });
  if (log.days.length > MAX_DAYS) log.days = log.days.slice(0, MAX_DAYS);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(log, null, 1), 'utf8');
}

/** 交易日历：优先用指数日线，指数取不到时退到一只大盘股。 */
async function tradingDays(limit) {
  for (const code of INDEX_CODES) {
    try {
      const bars = await quotes.dailyBars(code, limit || 60);
      const days = Array.from(bars.keys()).sort();
      if (days.length >= 5) return days;
    } catch (_) { /* 换下一个代码 */ }
  }
  return [];
}

/** 卡片生成日对应的交易日（当天是交易日就是当天，周末/节假日顺延到之前最近的交易日）。 */
function resolveEntryDay(calDays, cardDay) {
  let best = null;
  for (const ymd of calDays) {
    const day = ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8);
    if (day <= cardDay) best = day; else break;
  }
  return best;
}

/** 把当天的关注名单并入日志；同一个添加日期只记首次纳入的个股。 */
function recordDay(log, card, stamp, entryDay, backfilled) {
  const o = (card && card.outlook) || {};
  const picks = (o.picks || []).filter(function (p) { return p && p.code; });
  if (!picks.length) return 0;
  let entry = null;
  for (const d of log.days) if (d.day === entryDay) entry = d;
  if (!entry) {
    entry = { day: entryDay, firstAt: stamp.text, lastAt: stamp.text, tone: o.tone || '', upRatio: o.upRatio, picks: [] };
    log.days.push(entry);
  }
  entry.lastAt = stamp.text;
  entry.tone = o.tone || entry.tone;
  if (o.upRatio !== undefined && o.upRatio !== null) entry.upRatio = o.upRatio;
  if (backfilled) entry.backfilled = true;
  let added = 0;
  for (const p of picks) {
    let known = false;
    for (const x of entry.picks) if (x.code === p.code) known = true;
    if (known) continue;
    entry.picks.push({
      code: p.code,
      name: p.name || '',
      theme: p.theme || '',
      addedAt: stamp.text,
      entryPct: p.pct === undefined ? null : p.pct,
      entryTr: p.tr === undefined ? null : p.tr,
      entryFundYi: p.fundYi === undefined ? null : p.fundYi,
      score: p.score === undefined ? null : p.score,
      limitUp: !!p.limitUp,
      close0: null,
      d0: p.pct === undefined ? null : p.pct,
      t: [null, null, null, null, null],
    });
    added++;
  }
  entry.picks.sort(function (a, b) { return (Number(b.score) || 0) - (Number(a.score) || 0); });
  return added;
}

/** 用日线窗口补齐当日 / T+1 ~ T+5，并把结论拼到每一行上。 */
async function attach(log, cfg, opts) {
  opts = opts || {};
  const recentDays = Number((cfg.outlook && cfg.outlook.recentTradingDays) || DEFAULT_RECENT_DAYS);
  const newsRows = opts.newsRows || [];
  const groupedNews = {};
  for (const r of newsRows) {
    if (!r.stockCode) continue;
    if (!groupedNews[r.stockCode]) groupedNews[r.stockCode] = [];
    groupedNews[r.stockCode].push(r);
  }

  const rows = [];
  for (let i = 0; i < log.days.length; i++) {
    if (i >= recentDays) break;
    for (const p of log.days[i].picks) {
      const ctime = secOf(p.addedAt);
      if (ctime === null) continue;
      rows.push({ stockCode: p.code, stockName: p.name, ctime: ctime });
    }
  }

  const out = [];
  let refreshed = 0;
  if (rows.length && !opts.noFetch) {
    try {
      const tr = await technical.refresh(rows, { config: cfg });
      refreshed += tr.refreshed || 0;
    } catch (e) { out.push('技术面刷新失败：' + String((e && e.message) || e)); }
    try {
      await research.enrichRows(rows, { config: cfg });
    } catch (e) { out.push('调研刷新失败：' + String((e && e.message) || e)); }
  } else if (rows.length) {
    technical.attachRows(rows);
    research.attachRows(rows);
  }

  const byCode = new Map();
  for (const r of rows) byCode.set(r.stockCode, r);
  const techStocks = technical.loadCache().stocks || {};
  const researchStocks = research.loadCache().stocks || {};
  let t1 = 0;
  let t5 = 0;
  const lines = [];
  for (const d of log.days) {
    for (const p of d.picks) {
      const r = byCode.get(p.code);
      if (r && r.forward) {
        const f = r.forward;
        if (p.d0 === null || p.d0 === undefined) p.d0 = f.d0;
        if (f.close0 !== null && f.close0 !== undefined) p.close0 = f.close0;
        for (let i = 0; i < 5; i++) {
          if ((p.t[i] === null || p.t[i] === undefined) && f.t[i] !== null && f.t[i] !== undefined) p.t[i] = f.t[i];
        }
        if (f.day0) p.entryDay = f.day0;
      }
      const t = p.t || [];
      const has = t.filter(function (v) { return v !== null && v !== undefined; }).length;
      if (has >= 1) t1++;
      if (has >= 5) t5++;
      // 前置动能：纳入当日前 N 个交易日的日均涨幅
      const pre = preStats(techStocks[p.code], String(p.addedAt || '').slice(0, 10));
      if (pre.d1 !== null || pre.a10 !== null) p.pre = pre;
      else if (!p.pre) p.pre = pre;
      lines.push({
        day: d.day,
        dayText: dayLabel(d.day),
        tone: d.tone || '',
        upRatio: d.upRatio,
        backfilled: !!d.backfilled,
        pick: p,
        avg: mean(t),
        researchConclusion: research.conclusionFor(researchStocks[p.code], groupedNews[p.code] || [], techStocks[p.code]),
        technicalConclusion: technical.conclusionFor(techStocks[p.code]),
      });
    }
  }
  return { lines: lines, refreshed: refreshed, t1: t1, t5: t5, refreshedCodes: rows.length, notes: out };
}

const CSS = [
  "body{font-family:'Microsoft YaHei',system-ui,sans-serif;margin:24px;color:#1c1c1e;background:#fafafa}",
  'h1{font-size:20px;margin:0 0 6px}',
  '.lede{color:#666;font-size:13px;margin:0 0 10px}',
  '.meta{color:#666;font-size:13px;margin-bottom:12px}.meta a{white-space:nowrap}',
  '.tip{background:#fff;border:1px solid #e5e5e5;border-left:3px solid #c2410c;border-radius:6px;padding:9px 12px;font-size:12.5px;line-height:1.7;color:#555;margin-bottom:14px}',
  '.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:9px 10px;margin-bottom:12px}',
  '.bar input,.bar select{font:inherit;font-size:13px;min-height:32px;border:1px solid #dcdcdc;border-radius:6px;padding:4px 8px;color:#1c1c1e;background:#fff}',
  '.bar input{flex:1 1 240px}.bar select{flex:0 1 190px}.bar .cnt{color:#888;font-size:12px;margin-left:auto;white-space:nowrap}',
  '.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;background:#fff;border-radius:8px}',
  'table{border-collapse:collapse;width:100%;background:#fff;font-size:13px;table-layout:fixed}',
  'th,td{border:1px solid #e5e5e5;padding:6px 6px;vertical-align:top;text-align:left;overflow-wrap:anywhere;word-break:break-word}',
  'th{background:#f2f3f5;position:sticky;top:0;z-index:2;font-weight:600}',
  // 日期列允许换行：整页在手机上按 1080px 渲染，一行放不下「日期 + 时间」时折成两行，不会顶出格子
  'td.t{white-space:normal;color:#555;font-variant-numeric:tabular-nums}',
  'td.t .d{display:block;white-space:nowrap}',
  'td.pct{font-variant-numeric:tabular-nums;font-size:12.5px;font-weight:600;white-space:nowrap}',
  'td.research,td.tech{font-size:12.5px;line-height:1.7;color:#3b4149}',
  '.f-up{color:#d93025;font-weight:600}.f-down{color:#0f9d58;font-weight:600}',
  '.up-strong{color:#d93025;font-weight:700}.up-limit{color:#8b0000;font-weight:700}',
  '.v-green{color:#0f9d58}.v-blue{color:#1a73e8}.v-red{color:#d93025}',
  '.research-item{display:block;margin:0 0 5px}.research-item:last-child{margin-bottom:0}',
  '.research-key{font-weight:700;color:#20252b}.research-impact{color:#c62828;font-weight:700}',
  '.sub{display:block;color:#888;font-size:11.5px;margin-top:2px;white-space:normal;line-height:1.45}',
  '.muted{color:#aaa;font-weight:400}',
  'tr.grp td{background:#fff7ed;color:#9a3412;font-weight:700;font-size:12.5px;border-color:#f5d7bd}',
  'tr.grp .gsub{color:#a16207;font-weight:400}',
  '.empty{padding:40px 16px;text-align:center;color:#888;background:#fff;border:1px dashed #e5e5e5;border-radius:8px}',
  '@media (max-width:760px){html,body{max-width:100%}body{margin:10px}h1{font-size:16px}.lede,.meta{font-size:12px}'
    + '.bar{padding:8px}.bar input,.bar select{flex:1 1 100%;width:100%}.bar .cnt{margin-left:0}'
    + '.tw{overflow-x:auto;border:1px solid #e5e5e5;border-radius:8px}table{width:1080px;min-width:1080px}'
    + 'th,td{font-size:12px;padding:5px 5px}th{position:static}.research-item{margin-bottom:6px}}',
].join('');

const SCRIPT = '<script>' + "(function(){\n"
  + "  var rows = [].slice.call(document.querySelectorAll('tbody tr[data-day]'));\n"
  + "  var groups = [].slice.call(document.querySelectorAll('tbody tr.grp'));\n"
  + "  var q = document.getElementById('q');\n"
  + "  var fd = document.getElementById('fday');\n"
  + "  var cnt = document.getElementById('cnt');\n"
  + "  if (!rows.length || !q || !fd) return;\n"
  + "  var cache = rows.map(function(r){ return (r.textContent || '').toLowerCase(); });\n"
  + "  var counts = {};\n"
  + "  rows.forEach(function(r){ var d = r.getAttribute('data-day') || ''; if (!d) return; counts[d] = (counts[d] || 0) + 1; });\n"
  + "  Object.keys(counts).sort().reverse().forEach(function(d){\n"
  + "    var o = document.createElement('option'); o.value = d; o.textContent = d + '（' + counts[d] + ' 只）'; fd.appendChild(o);\n"
  + "  });\n"
  + "  function apply(){\n"
  + "    var kw = q.value.trim().toLowerCase();\n"
  + "    var day = fd.value;\n"
  + "    var n = 0;\n"
  + "    for (var i = 0; i < rows.length; i++){\n"
  + "      var ok = (!day || rows[i].getAttribute('data-day') === day) && (!kw || cache[i].indexOf(kw) > -1);\n"
  + "      rows[i].style.display = ok ? '' : 'none';\n"
  + "      if (ok) n++;\n"
  + "    }\n"
  + "    for (var g = 0; g < groups.length; g++){\n"
  + "      var d = groups[g].getAttribute('data-day');\n"
  + "      var show = (!day || day === d) && !kw;\n"
  + "      if (!day && kw) show = true;\n"
  + "      groups[g].style.display = show ? '' : 'none';\n"
  + "    }\n"
  + "    cnt.textContent = '显示 ' + n + ' / ' + rows.length + ' 只';\n"
  + "  }\n"
  + "  q.addEventListener('input', apply);\n"
  + "  fd.addEventListener('change', apply);\n"
  + "  apply();\n"
  + "})();" + '<' + '/script>';

function cellPct(v, extraClass) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '<span class=' + Q + 'muted' + Q + '>待更新</span>';
  const n = Number(v);
  const cls = extraClass ? extraClass : (n > 0 ? 'f-up' : n < 0 ? 'f-down' : '');
  return n >= 9.8 ? '<span class=' + Q + 'up-limit' + Q + '>' + pct(n) + '</span>'
    : n > 5 ? '<span class=' + Q + 'up-strong' + Q + '>' + pct(n) + '</span>'
      : '<span class=' + Q + cls + Q + '>' + pct(n) + '</span>';
}

/** 前置动能单元格：数值 + 「已发生 n/N」（上市不足 N 个交易日时提示窗口不完整）。 */
function preCell(value, count, want) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '<span class=' + Q + 'muted' + Q + '>—</span>';
  const base = cellPct(value);
  return count && want && count < want ? base + '<span class=' + Q + 'sub' + Q + '>已发生 ' + count + '/' + want + '</span>' : base;
}

/** 渲染明细页；没有数据时也给一张空状态页，保证链接不会 404。 */
function render(result, opts) {
  opts = opts || {};
  const lines = result.lines || [];
  const days = [];
  const seen = {};
  for (const ln of lines) {
    if (seen[ln.day]) { seen[ln.day].n++; continue; }
    seen[ln.day] = { day: ln.day, n: 1, dayText: ln.dayText, tone: ln.tone, upRatio: ln.upRatio, backfilled: ln.backfilled, sum: 0, cnt: 0 };
    days.push(seen[ln.day]);
  }
  for (const ln of lines) {
    const d = seen[ln.day];
    const v = Number(ln.pick.d0);
    if (Number.isFinite(v)) { d.sum += v; d.cnt++; }
  }

  const body = [];
  if (!lines.length) {
    body.push('<tr><td colspan=' + Q + HEADERS.length + Q + ' class=' + Q + 'muted' + Q + '>还没有记录：明日看点生成后会自动留档。</td></tr>');
  }
  for (const d of days) {
    const dayAvg = d.cnt ? '当日均涨 ' + pct(d.sum / d.cnt) : '当日涨幅待更新';
    body.push('<tr class=' + Q + 'grp' + Q + ' data-day=' + Q + esc(d.day) + Q + '><td colspan=' + Q + HEADERS.length + Q + '>' +
      esc(d.dayText) + ' · 关注 ' + d.n + ' 只 · ' + esc(dayAvg) +
      (d.tone ? ' · 动能定调 ' + esc(d.tone) : '') +
      (d.backfilled ? ' <span class=' + Q + 'gsub' + Q + '>（补录）</span>' : '') + '</td></tr>');
    for (const ln of lines) {
      if (ln.day !== d.day) continue;
      const p = ln.pick;
      const t = p.t || [];
      const pre = p.pre || {};
      // 日期与时间拆开：窄列里整行放不下时按空格折行，避免顶出格子
      const parts = String(p.addedAt || '').split(' ');
      const avgText = ln.avg.value === null ? '<span class=' + Q + 'muted' + Q + '>待更新</span>'
        : '<span class=' + Q + (ln.avg.value > 0 ? 'f-up' : ln.avg.value < 0 ? 'f-down' : '') + Q + '>' + pct(ln.avg.value) + '</span>' +
          (ln.avg.n < 5 ? '<span class=' + Q + 'sub' + Q + '>已发生 ' + ln.avg.n + '/5</span>' : '');
      body.push('<tr data-day=' + Q + esc(d.day) + Q + '>' +
        '<td class=' + Q + 't' + Q + ' data-label=' + Q + '添加时间' + Q + '><span class=' + Q + 'd' + Q + '>' + esc(parts[0]) + '</span>' +
          (parts[1] ? ' <span class=' + Q + 'sub' + Q + '>' + esc(parts[1]) + '</span>' : '') + '</td>' +
        '<td data-label=' + Q + '股票名称' + Q + '><a href=' + Q + 'https://quote.eastmoney.com/' + encodeURIComponent(p.code) + '.html' + Q +
          ' target=' + Q + '_blank' + Q + ' rel=' + Q + 'noopener noreferrer' + Q + ' title=' + Q + '在东方财富查看行情与K线' + Q + '>' + esc(p.name) + '</a>' +
          (p.theme ? '<span class=' + Q + 'sub' + Q + '>' + esc(report.outlookShort(p.theme)) + '</span>' : '') +
          (p.limitUp ? '<span class=' + Q + 'sub' + Q + '><span class=' + Q + 'up-limit' + Q + '>纳入日涨停</span></span>' : '') + '</td>' +
        PRE_WINDOWS.map(function (w) {
          return '<td class=' + Q + 'pct' + Q + ' data-label=' + Q + '前' + CN_NUM[w.len] + '日日均涨幅' + Q + '>' +
            preCell(pre[w.key], pre[w.n], w.len) + '</td>';
        }).join('') +
        '<td class=' + Q + 'pct' + Q + ' data-label=' + Q + '前一日涨幅' + Q + '>' + cellPct(pre.d1) + '</td>' +
        '<td class=' + Q + 'pct' + Q + ' data-label=' + Q + '当日涨幅' + Q + '>' + cellPct(p.d0) + '</td>' +
        [0, 1, 2, 3, 4].map(function (i) {
          return '<td class=' + Q + 'pct' + Q + ' data-label=' + Q + 'T+' + (i + 1) + '涨幅' + Q + '>' + cellPct(t[i]) + '</td>';
        }).join('') +
        '<td class=' + Q + 'pct' + Q + ' data-label=' + Q + '五日平均涨幅' + Q + '>' + avgText + '</td>' +
        '<td class=' + Q + 'research' + Q + ' data-label=' + Q + '调研结论' + Q + '>' + report.researchHtml(ln.researchConclusion) + '</td>' +
        '<td class=' + Q + 'tech' + Q + ' data-label=' + Q + '技术面结论' + Q + '>' + report.technicalHtml(ln.technicalConclusion) + '</td>' +
        '</tr>');
    }
  }

  const th = HEADERS.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('');
  const colgroup = '<colgroup>' + COL_WIDTHS.map(function (w) { return '<col style=' + Q + 'width:' + w + '%' + Q + '>'; }).join('') + '</colgroup>';
  const back = opts.backHref ? '<a href=' + Q + esc(opts.backHref) + Q + '>← 返回新闻表格</a>' : '';
  const stamp = shanghai(Date.now()).text;
  const tip = '<div class=' + Q + 'tip' + Q + '><b>口径</b>：添加时间 = 该股进入「明日看点 · 关注个股」名单的时刻（同一添加日期内只记首次纳入）；'
    + '前十日 / 前五日 / 前三日日均涨幅 = 纳入当日前 10 / 5 / 3 个交易日的收盘涨跌幅算术平均（不含纳入当日，用于看纳入前的动能）；'
    + '前一日涨幅 = 纳入当日前一个交易日的收盘涨跌幅；'
    + '当日涨幅 = 纳入当日该股的收盘涨跌幅；T+N 涨幅 = 之后第 N 个交易日的收盘涨跌幅，尚未发生的档位显示「待更新」；'
    + '五日平均涨幅 = 已发生的 T+1~T+5 的算术平均。窗口不足（如次新股）会标出「已发生 n/N」，数据取不到显示「—」。'
    + '名单由当日全市场行情推导，属于动量观察名单，不是预测，也不构成投资建议。</div>';

  return [
    '<!doctype html>',
    '<html lang=' + Q + 'zh-CN' + Q + '>',
    '<head>',
    '<meta charset=' + Q + 'utf-8' + Q + '>',
    '<meta name=' + Q + 'viewport' + Q + ' content=' + Q + 'width=1080' + Q + '>',
    '<title>明日关注个股明细</title>',
    '<style>' + CSS + '</style>',
    '</head><body>',
    '<h1>明日关注个股 · 明细表</h1>',
    '<p class=' + Q + 'lede' + Q + '>按添加日期留档，跟踪每只个股的当日与 T+1~T+5 表现。</p>',
    '<div class=' + Q + 'meta' + Q + '>共 ' + lines.length + ' 只明细 ｜ ' + days.length + ' 个添加日期 ｜ T+1 已到位 ' + (result.t1 || 0) + ' 只 ｜ T+5 已到位 ' + (result.t5 || 0) + ' 只 ｜ 生成 ' + esc(stamp) + ' ' + back + '</div>',
    tip,
    (result.notes && result.notes.length ? '<div class=' + Q + 'tip' + Q + '>' + esc(result.notes.join('；')) + '</div>' : ''),
    '<div class=' + Q + 'bar' + Q + '><input id=' + Q + 'q' + Q + ' type=' + Q + 'search' + Q + ' placeholder=' + Q + '搜索股票 / 题材 / 结论…' + Q + ' autocomplete=' + Q + 'off' + Q + '>'
      + '<select id=' + Q + 'fday' + Q + '><option value=' + Q + Q + '>全部添加日期</option></select>'
      + '<span class=' + Q + 'cnt' + Q + ' id=' + Q + 'cnt' + Q + '></span></div>',
    '<div class=' + Q + 'tw' + Q + '><table>' + colgroup + '<thead><tr>' + th + '</tr></thead><tbody>' + body.join('') + '</tbody></table></div>',
    SCRIPT,
    '</body></html>',
  ].join('\n');
}

function writePage(html) {
  fs.mkdirSync(PAGE_DIR, { recursive: true });
  fs.writeFileSync(PAGE_FILE, html, 'utf8');
  return PAGE_FILE;
}

async function publish(log, cfg, opts) {
  const result = await attach(log, cfg, opts);
  const html = render(result, opts);
  writePage(html);
  return result;
}

/**
 * 主流程：留档 → 补齐行情与结论 → 写 out/outlook.json 与 out/outlook/index.html
 * opts: { config, newsRows, siteLinks, card, backfill, noFetch }
 */
async function run(card, opts) {
  opts = opts || {};
  const cfg = opts.config || collectMod.loadConfig();
  if (cfg.outlook && cfg.outlook.enabled === false) return { skipped: '已按配置关闭（config.outlook.enabled=false）' };
  const log = loadLog();
  const stamp = shanghai(new Date((card && card.updatedAt) || Date.now()).getTime());
  const calDays = opts.calendar || await tradingDays(60);
  const entryDay = calDays.length ? resolveEntryDay(calDays, stamp.day) : stamp.day;
  const hasPicks = !!(card && card.outlook && (card.outlook.picks || []).length);
  let skipped = null;
  let added = 0;
  if (!hasPicks) {
    skipped = '本轮行情卡片没有关注名单（沿用已留档数据）';
  } else if (!entryDay || entryDay !== stamp.day) {
    skipped = '非交易日（最近交易日 ' + (entryDay || '未知') + '）';
  } else if (!calDays.length && (stamp.weekday === 0 || stamp.weekday === 6)) {
    skipped = '周末且交易日历不可用';
  } else if (calDays.length && stamp.minutes < OPEN_MINUTE) {
    skipped = '开盘前快照（' + stamp.hm + '，快照仍是上一交易日收盘）';
  } else {
    added = recordDay(log, card, stamp, entryDay, !!opts.backfill);
    if (!added) skipped = '当天名单无新增（已留档）';
  }
  const result = await publish(log, cfg, Object.assign({}, opts, { config: cfg }));
  saveLog(log);
  return Object.assign(result, {
    skipped: skipped,
    added: added,
    days: log.days.length,
    rows: result.lines.length,
    entryDay: entryDay,
  });
}

module.exports = {
  run: run,
  loadLog: loadLog,
  saveLog: saveLog,
  render: render,
  attach: attach,
  recordDay: recordDay,
  tradingDays: tradingDays,
  shanghai: shanghai,
  DATA_FILE: DATA_FILE,
  PAGE_FILE: PAGE_FILE,
};

// 本地手动跑（云端由 src/cli.js 调用）：
//   node src/outlook.js                      取最新全市场快照留档今天
//   node src/outlook.js --card data/market.json 用本地缓存的卡片留档（不重新抓快照）
//   node src/outlook.js --backfill           标记为补录
//   node src/outlook.js --no-fetch           不刷新日线/调研（离线渲染）
if (require.main === module) {
  (async function () {
    const market = require('./market.js');
    const has = function (f) { return process.argv.includes('--' + f); };
    const argOf = function (name) {
      const i = process.argv.indexOf('--' + name);
      return i === -1 ? null : process.argv[i + 1];
    };
    const cardFile = argOf('card');
    let card = null;
    if (cardFile) {
      const file = readJson(cardFile);
      card = file && file.card ? file.card : file;
      if (!card || !card.outlook) throw new Error('卡片文件里没有 outlook：' + cardFile);
    } else {
      card = await market.summary({ force: true });
    }
    const res = await run(card, {
      backfill: has('backfill'),
      noFetch: has('no-fetch'),
      config: collectMod.loadConfig(),
      backHref: '../',
    });
    console.log('添加日期 ' + res.entryDay + ' ｜ 本轮新增 ' + res.added + ' 只 ｜ 明细 ' + res.rows + ' 行 ｜ T+1 已到位 ' + res.t1 + ' 只 ｜ T+5 已到位 ' + res.t5 + ' 只'
      + (res.skipped ? ' ｜ 未新增：' + res.skipped : '')
      + (res.notes && res.notes.length ? ' ｜ ' + res.notes.join('；') : ''));
    console.log('数据：' + DATA_FILE);
    console.log('页面：' + PAGE_FILE);
  })().catch(function (e) { console.error('运行失败:', e); process.exit(1); });
}
