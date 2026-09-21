'use strict';
/**
 * Stockbee Momentum Burst —— A股近 N 个月信号 + 前瞻收益研究
 *
 * 与 skill (stockbee-momentum-burst-screener) 的对应关系：
 *   4% 突破       close/prevClose >= 4%，且成交量大于前一日并高于流动性下限
 *   绝对涨幅突破   close-open >= 阈值（默认 0.90 元）且量能达标
 *   区间扩张       当日振幅大于前 3 日振幅最大值，且前一日未被拉爆、量能确认
 *   评分结构       触发强度 / 量能扩张 / 前期收缩基底 / 收盘位置 / 风险距离 / 失败过滤 / 市场闸门
 *
 * A 股适配：
 *   - 价格为人民币，腾讯前复权日线（qfq），成交量统一换算成「股」；
 *   - 市场闸门用上证指数（sh000001）收盘对 20/50 日均线的位置逐日判定；
 *   - 默认剔除 ST / *ST / 退市整理股（涨跌幅限制不同，4% 突破含义失真）。
 *
 * 输出：
 *   out/stockbee.json         结构化结果（含逐条信号、前瞻收益与汇总统计）
 *   out/stockbee.csv          可直接用 Excel 打开的表格
 *   out/stockbee/index.html   移动端可看的表格页（GitHub Pages 发布 stockbee/）
 *
 * 用法：
 *   node src/stockbee.js                              # 扫描近 3 个月
 *   node src/stockbee.js --limit 80                   # 只跑前 80 只（试跑）
 *   node src/stockbee.js --skip-if-fresh              # 已发布数据覆盖最新交易日的，跳过抓取
 *   node src/stockbee.js --months 3 --concurrency 16
 */
const fs = require('node:fs');
const path = require('node:path');
const collect = require('./collect.js');
const picksMod = require('./stockbee-picks.js');
const themeApi = require('./theme.js');
const pageMod = require('./stockbee-page.js');

const OUT_DIR = path.join(collect.ROOT, 'out');
const JSON_FILE = path.join(OUT_DIR, 'stockbee.json');
const CSV_FILE = path.join(OUT_DIR, 'stockbee.csv');
const HTML_FILE = path.join(OUT_DIR, 'stockbee', 'index.html');
const BARS_CACHE = path.join(OUT_DIR, 'stockbee-bars.json');
const PICKS_FILE = path.join(OUT_DIR, 'stockbee-picks.json');
const PICKS_CSV = path.join(OUT_DIR, 'stockbee-picks.csv');

const TX_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const SINA_URL = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const INDEX_CODE = 'sh000001';

/** A 股涨跌幅上限：创业板（300/301）与科创板（688）是 20%，其余主板 10%。 */
function limitOf(code) {
  return /^(sz30[01]|sh688)/.test(code) ? 20 : 10;
}

const DEFAULTS = {
  months: 3,
  pool: 'all-a',
  concurrency: 12,
  datalen: 150,
  minPrice: 3,
  minVolume: 1000000,
  nineMillion: 9000000,
  fourPct: 4,
  dollar: 0.9,
  maxPrevDayGainForRange: 2,
  minBaseDays: 3,
  maxBaseDays: 20,
  maxBaseWidth: 15,
  maxPriorAvgRange: 5,
  narrowPriorRange: 3,
  maxRiskPct: 10,
  breakdownLookback: 5,
  breakdownPct: 4,
  minScore: 70,
  require4pct: true,
  maxRows: 12000,
  maxScanMinutes: 25,
  // 精选（多因子名单）
  pickMax: 20,
  preRank: 60,
  minAmountYi: 1.5,
  maxPickRisk: 8,
  useTheme: true,
};

/* ------------------------------------------------------------ 工具 */

function parseArgs(argv) {
  const o = Object.assign({}, DEFAULTS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = function () { return argv[++i]; };
    if (a === '--months') o.months = Number(next());
    else if (a === '--pool') o.pool = next();
    else if (a === '--concurrency') o.concurrency = Number(next());
    else if (a === '--datalen') o.datalen = Number(next());
    else if (a === '--limit') o.limit = Number(next());
    else if (a === '--min-score') o.minScore = Number(next());
    else if (a === '--max-rows') o.maxRows = Number(next());
    else if (a === '--picks') o.pickMax = Number(next());
    else if (a === '--pre-rank') o.preRank = Number(next());
    else if (a === '--no-theme') o.useTheme = false;
    else if (a === '--any-trigger') o.require4pct = false;
    else if (a === '--max-scan-minutes') o.maxScanMinutes = Number(next());
    else if (a === '--include-st') o.includeSt = true;
    else if (a === '--skip-if-fresh') o.skipIfFresh = true;
    else if (a === '--force') o.force = true;
    else if (a === '--no-cache') o.noCache = true;
    else if (a === '--quiet') o.quiet = true;
  }
  return o;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

function shanghaiParts(d) {
  const t = d || new Date();
  const s = t.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });
  const m = /(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/.exec(s);
  if (!m) return { day: '1970-01-01', hhmm: 0 };
  const pad = function (x) { return String(x).padStart(2, '0'); };
  return {
    day: m[3] + '-' + pad(m[1]) + '-' + pad(m[2]),
    hhmm: Number(m[4]) * 100 + Number(m[5]),
  };
}

function monthsBefore(day, months) {
  const p = day.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1 - months, p[2]));
  const pad = function (x) { return String(x).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

async function fetchJson(url, tries) {
  const maxTry = tries === undefined ? 3 : tries;
  let last;
  for (let i = 0; i <= maxTry; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 20000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' } });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < maxTry) await new Promise(function (r) { setTimeout(r, 400 * (i + 1)); });
    }
  }
  throw last || new Error('fetch failed');
}

/* ------------------------------------------------------------ 取数 */

/** 腾讯前复权日线；返回 {day,o,c,h,l,v}，v 已换算成股。 */
async function fetchTencent(code, n) {
  const url = TX_URL + '?param=' + encodeURIComponent(code + ',day,,,' + n + ',qfq');
  const j = await fetchJson(url, 2);
  const d = j && j.data && j.data[code];
  const arr = (d && (d.qfqday || d.day)) || [];
  return arr.map(function (x) {
    return { day: String(x[0]), o: Number(x[1]), c: Number(x[2]), h: Number(x[3]), l: Number(x[4]), v: Number(x[5]) * 100 };
  }).filter(function (x) { return x.day && x.c > 0 && x.h >= x.l; });
}

/** 兜底：新浪日线（不复权，成交量单位本身是股）。 */
async function fetchSina(code, n) {
  const url = SINA_URL + '?symbol=' + encodeURIComponent(code) + '&scale=240&ma=no&datalen=' + n;
  const j = await fetchJson(url, 2);
  if (!Array.isArray(j)) return [];
  return j.map(function (x) {
    return { day: String(x.day), o: Number(x.open), c: Number(x.close), h: Number(x.high), l: Number(x.low), v: Number(x.volume) };
  }).filter(function (x) { return x.day && x.c > 0 && x.h >= x.l; });
}

async function fetchBars(code, n) {
  if (!fetchBars.sinaOnly) {
    try {
      const b = await fetchTencent(code, n);
      if (b.length >= 30) return { bars: b, src: 'tencent-qfq' };
    } catch (_) { /* 落到新浪 */ }
  }
  const s = await fetchSina(code, n);
  return { bars: s, src: 'sina-raw' };
}

/** 先用指数探一次腾讯：连不上（例如云端网络到不了 ifzq）就整轮改用新浪，避免每只股票都白等超时。 */
async function probeSource(log) {
  const t0 = Date.now();
  try {
    const b = await fetchTencent(INDEX_CODE, 5);
    if (b.length) {
      log('  数据源探测：腾讯前复权可用（' + (Date.now() - t0) + 'ms）');
      return;
    }
  } catch (_) { /* 下面统一处理 */ }
  fetchBars.sinaOnly = true;
  log('  数据源探测：腾讯不可用（' + (Date.now() - t0) + 'ms），本轮改用新浪日线（不复权）');
}

/* ------------------------------------------------------------ 指标 */

function avg(list) {
  if (!list.length) return 0;
  let s = 0;
  for (const x of list) s += x;
  return s / list.length;
}

function closeLocation(bar) {
  const r = bar.h - bar.l;
  if (r <= 0) return 50;
  return ((bar.c - bar.l) / r) * 100;
}

/* 走势技术形态用到的指标序列：一次算好整条序列，再按触发日索引取值，避免逐行重复计算。 */

/** 简单均线序列：ma[i] = 最近 n 根（含 i）收盘均值，长度不足为 null。 */
function smaSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function emaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = prev === null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** MACD(12,26,9)：dif = EMA12-EMA26，dea = EMA9(dif)，hist = (dif-dea)*2。 */
function macdSeries(closes) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const dif = closes.map(function (_, i) { return e12[i] - e26[i]; });
  const dea = emaSeries(dif, 9);
  const hist = dif.map(function (v, i) { return (v - dea[i]) * 2; });
  return { dif: dif, dea: dea, hist: hist };
}

/** RSI(n)，Wilder 平滑。 */
function rsiSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    if (i <= n) {
      ag += g / n; al += l / n;
      if (i === n) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      continue;
    }
    ag = (ag * (n - 1) + g) / n;
    al = (al * (n - 1) + l) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** 与 skill 一致的基底识别：在触发日之前找宽度 <= maxWidth 且平均振幅 <= maxAvgRange 的最长窗口。 */
function detectBase(bars, i, o) {
  const longest = Math.min(o.maxBaseDays, i);
  let best = null;
  for (let w = o.minBaseDays; w <= longest; w++) {
    const prior = bars.slice(i - w, i);
    const ref = prior[0].c;
    if (!(ref > 0)) continue;
    let hi = -Infinity, lo = Infinity, sum = 0;
    for (const b of prior) {
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
      if (b.c > 0) sum += ((b.h - b.l) / b.c) * 100;
    }
    const width = ((hi - lo) / ref) * 100;
    const avgRange = sum / prior.length;
    if (width > o.maxBaseWidth || avgRange > o.maxPriorAvgRange) continue;
    const older = bars.slice(Math.max(0, i - w * 2), i - w);
    const baseVol = avg(prior.map(function (b) { return b.v; }));
    const olderVol = older.length ? avg(older.map(function (b) { return b.v; })) : 0;
    const dry = !!(olderVol && baseVol <= olderVol * 0.85);
    if (!best || w > best.days || (w === best.days && width < best.width)) {
      best = { days: w, width: width, avgRange: avgRange, dry: dry };
    }
  }
  if (best) return best;
  const w = Math.min(longest, Math.max(o.minBaseDays, 1), i);
  const prior = bars.slice(i - w, i);
  const ref = prior.length ? prior[0].c : 1;
  let hi = -Infinity, lo = Infinity, sum = 0;
  for (const b of prior) {
    if (b.h > hi) hi = b.h;
    if (b.l < lo) lo = b.l;
    if (b.c > 0) sum += ((b.h - b.l) / b.c) * 100;
  }
  return {
    days: 0,
    width: prior.length ? ((hi - lo) / ref) * 100 : 0,
    avgRange: prior.length ? sum / prior.length : 0,
    dry: false,
  };
}

function detectTrigger(bars, i, o) {
  const cur = bars[i], prev = bars[i - 1], prev2 = bars[i - 2];
  const gain = (cur.c / prev.c - 1) * 100;
  const dollar = cur.c - cur.o;
  const range = cur.h - cur.l;
  const rangePct = (range / cur.c) * 100;
  const priorMax = Math.max(bars[i - 1].h - bars[i - 1].l, bars[i - 2].h - bars[i - 2].l, bars[i - 3].h - bars[i - 3].l);
  const prevGain = (prev.c / prev2.c - 1) * 100;
  const vr1 = prev.v > 0 ? cur.v / prev.v : 0;
  const avg20 = avg(bars.slice(Math.max(0, i - 20), i).map(function (b) { return b.v; }));
  const vr20 = avg20 > 0 ? cur.v / avg20 : 0;

  const volOk = cur.v >= o.minVolume;
  const expanded = cur.v > prev.v;
  const tags = [];
  if (gain >= o.fourPct && expanded && volOk) tags.push('4pct_breakout');
  if (dollar >= o.dollar && volOk) tags.push('dollar_breakout');
  if (range > priorMax && prevGain <= o.maxPrevDayGainForRange && expanded && volOk) tags.push('range_expansion');
  if (cur.v >= o.nineMillion) tags.push('9m_volume');

  return {
    tags: tags,
    gain: gain,
    dollar: dollar,
    rangePct: rangePct,
    vr1: vr1,
    vr20: vr20,
    closeLoc: closeLocation(cur),
    prevGain: prevGain,
  };
}

function scoreCandidate(trigger, base, bars, i, o, gateScore) {
  const cur = bars[i], prev = bars[i - 1];
  let triggerScore = 0;
  if (trigger.tags.indexOf('4pct_breakout') >= 0) {
    triggerScore += 14;
    if (trigger.gain >= 7) triggerScore += 3;
  }
  if (trigger.tags.indexOf('range_expansion') >= 0) triggerScore += 10;
  if (trigger.tags.indexOf('dollar_breakout') >= 0) triggerScore += 8;
  if (trigger.tags.indexOf('9m_volume') >= 0) triggerScore += 2;
  triggerScore = Math.min(20, triggerScore);

  const best = Math.max(trigger.vr1, trigger.vr20);
  const volumeScore = best >= 3 ? 15 : best >= 2 ? 12 : best >= 1.5 ? 9 : best >= 1 ? 6 : 0;

  let setup = 0;
  if (base.days >= 10) setup += 10;
  else if (base.days >= 5) setup += 8;
  else if (base.days >= 3) setup += 6;
  else if (base.days > 0) setup += 3;
  if (base.width && base.width <= 8) setup += 7;
  else if (base.width <= 12) setup += 5;
  else if (base.width <= o.maxBaseWidth) setup += 3;
  const prevRangePct = prev.c > 0 ? ((prev.h - prev.l) / prev.c) * 100 : 0;
  if (prevRangePct <= o.narrowPriorRange) setup += 5;
  else if (prev.c < prev.o) setup += 4;
  if (base.dry) setup += 3;
  setup = Math.min(25, setup);

  const loc = trigger.closeLoc;
  const closeScore = loc >= 90 ? 10 : loc >= 80 ? 9 : loc >= 70 ? 7 : loc >= 60 ? 5 : loc >= 50 ? 3 : 0;

  const riskPct = ((cur.c - cur.l) / cur.c) * 100;
  const riskScore = riskPct <= 2.5 ? 15 : riskPct <= 4 ? 12 : riskPct <= 6 ? 8 : riskPct <= 8 ? 5 : riskPct <= 10 ? 2 : 0;

  let streak = 0;
  for (let k = 1; k <= 5 && i - k - 1 >= 0; k++) {
    if (bars[i - k].c > bars[i - k - 1].c) streak++;
    else break;
  }
  let breakdown = false;
  for (let k = 1; k <= o.breakdownLookback && i - k - 1 >= 0; k++) {
    if (((bars[i - k].c / bars[i - k - 1].c) - 1) * 100 <= -Math.abs(o.breakdownPct)) { breakdown = true; break; }
  }
  let fail = 10;
  const soft = [];
  if (streak >= 3) { fail -= 4; soft.push('prior_3day_runup'); }
  if (breakdown) { fail -= 4; soft.push('recent_4pct_breakdown'); }
  if (base.width > o.maxBaseWidth) { fail -= 3; soft.push('wide_prior_base'); }
  if (loc < 50) { fail -= 2; soft.push('weak_close_location'); }
  fail = Math.max(0, fail);

  const score = triggerScore + volumeScore + setup + closeScore + riskScore + fail + gateScore;
  return {
    score: score,
    riskPct: riskPct,
    streak: streak,
    breakdown: breakdown,
    soft: soft,
    parts: { trigger: triggerScore, volume: volumeScore, setup: setup, close: closeScore, risk: riskScore, fail: fail, gate: gateScore },
  };
}

function ratingOf(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'A-';
  if (score >= 70) return 'B';
  if (score >= 55) return 'Watch';
  return 'Reject';
}

const TAG_LABEL = {
  '4pct_breakout': '4%突破',
  dollar_breakout: '绝对涨幅突破',
  range_expansion: '区间扩张',
  '9m_volume': '巨量',
};

function patternOf(tags) {
  const order = ['4pct_breakout', 'range_expansion', 'dollar_breakout', '9m_volume'];
  return order.filter(function (t) { return tags.indexOf(t) >= 0; })
    .map(function (t) { return TAG_LABEL[t]; }).join(' + ');
}

function round(x, n) {
  const p = Math.pow(10, n === undefined ? 2 : n);
  return Math.round(x * p) / p;
}

/* ------------------------------------------------------------ 市场闸门 */

function buildGate(indexBars, lastCompleteDay) {
  const map = new Map();
  const closes = [];
  for (let i = 0; i < indexBars.length; i++) {
    const b = indexBars[i];
    if (b.day > lastCompleteDay) continue;
    closes.push(b.c);
    const ma20 = closes.length >= 20 ? avg(closes.slice(-20)) : null;
    const ma50 = closes.length >= 50 ? avg(closes.slice(-50)) : null;
    let gate = 3, label = '中性';
    if (ma20 && b.c > ma20) { gate = 5; label = '允许'; }
    else if (ma50 && b.c > ma50) { gate = 3; label = '中性'; }
    else { gate = 0; label = '收紧'; }
    map.set(b.day, { score: gate, label: label });
  }
  return map;
}

/* ------------------------------------------------------------ 主流程 */

async function loadBarsMap(codes, o, log) {
  const cache = o.noCache ? {} : (readJson(BARS_CACHE) || {});
  const out = new Map();
  const started = Date.now();
  const deadline = started + o.maxScanMinutes * 60 * 1000;
  let done = 0, failed = 0;

  /** 跑一轮：并发抓取 list 里的代码（缓存命中的直接返回）。 */
  async function runPool(list, concurrency, delayMs) {
    const queue = list.slice();
    async function worker() {
      for (;;) {
        if (Date.now() > deadline) return;
        const code = queue.shift();
        if (!code) return;
        if (out.has(code)) continue;
        const hit = cache[code];
        if (hit && Array.isArray(hit.bars) && hit.bars.length >= 30) {
          out.set(code, hit.bars);
          continue;
        }
        try {
          const r = await fetchBars(code, o.datalen);
          if (r.bars.length >= 30) { out.set(code, r.bars); cache[code] = { src: r.src, bars: r.bars }; }
        } catch (_) { /* 记到下一轮补抓 */ }
        done++;
        if (delayMs) await new Promise(function (r2) { setTimeout(r2, delayMs); });
        if (!o.quiet && done % 500 === 0) log('  已处理 ' + done + '/' + codes.length + '（成功 ' + out.size + '）');
        if (Date.now() > deadline) return;
      }
    }
    const workers = [];
    for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
    await Promise.all(workers);
  }

  await runPool(codes, o.concurrency, 0);

  // 云端对行情接口有突发限流：失败的多半是瞬时限流，降并发 + 小间隔再补两轮
  for (let round = 1; round <= 2; round++) {
    const remaining = codes.filter(function (c) { return !out.has(c); });
    if (!remaining.length || Date.now() > deadline) break;
    log('  第 ' + round + ' 轮补抓：' + remaining.length + ' 只');
    await runPool(remaining, Math.max(3, Math.round(o.concurrency / 4)), 80);
  }

  failed = codes.length - out.size;

  if (!o.noCache) {
    try { writeJson(BARS_CACHE, cache); } catch (_) { /* 缓存写失败不影响结果 */ }
  }
  log('  取数完成：成功 ' + out.size + '/' + codes.length + '（缺 ' + failed + '），用时 ' + Math.round((Date.now() - started) / 1000) + 's');
  return { bars: out, failed: failed };
}

function analyzeStock(stock, bars, o, gateMap, windowStart, ctx) {
  const found = [];
  const lastIdx = bars.length - 1;
  // 走势技术形态：整条序列一次算好（同一根 K 线内所有指标同口径，不存在未来数据）
  const closes = bars.map(function (b) { return b.c; });
  const ma5 = smaSeries(closes, 5);
  const ma10 = smaSeries(closes, 10);
  const ma20s = smaSeries(closes, 20);
  const ma60s = smaSeries(closes, 60);
  const macd = macdSeries(closes);
  const rsi14 = rsiSeries(closes, 14);
  const idxMom = (ctx && ctx.idxMom20) || null;
  for (let i = 40; i <= lastIdx; i++) {
    const day = bars[i].day;
    if (day < windowStart) continue;
    if (i + 5 > lastIdx) { /* 前瞻不足 5 天，仍记录但不完整 */ }
    const trigger = detectTrigger(bars, i, o);
    if (!trigger.tags.length) continue;
    const executable = trigger.tags.filter(function (t) { return t !== '9m_volume'; });
    if (!executable.length) continue;
    const cur = bars[i];
    if (cur.c < o.minPrice || cur.v < o.minVolume) continue;
    const base = detectBase(bars, i, o);
    const gate = gateMap.get(day) || { score: 3, label: '中性' };
    const sc = scoreCandidate(trigger, base, bars, i, o, gate.score);
    if (sc.riskPct > o.maxRiskPct) continue;

    const fwd = [];
    for (let k = 1; k <= 5; k++) {
      if (i + k > lastIdx) { fwd.push(null); continue; }
      fwd.push(((bars[i + k].c / bars[i + k - 1].c) - 1) * 100);
    }
    const have = fwd.filter(function (x) { return x !== null; });
    const cum5 = i + 5 <= lastIdx ? ((bars[i + 5].c / cur.c) - 1) * 100 : null;
    const winDays = have.filter(function (x) { return x > 0; }).length;
    const winRate = have.length ? (winDays / have.length) * 100 : null;

    // 精选（多因子排序）需要的动量与可执行性字段：都在同一根 K 线上算，口径一致
    const ref20 = bars[i - 20] ? bars[i - 20].c : null;
    const ref5 = bars[i - 5] ? bars[i - 5].c : null;
    let hi60 = 0;
    for (let k = Math.max(0, i - 59); k <= i; k++) if (bars[k].c > hi60) hi60 = bars[k].c;
    const limit = limitOf(stock.code);
    // 走势技术形态：均线排列、趋势阶段、MACD/RSI 状态、高位结构
    const ma20v = ma20s[i], ma60v = ma60s[i];
    const stack = ma20v !== null && ma60v !== null
      ? [cur.c > ma5[i], ma5[i] > ma10[i], ma10[i] > ma20v, ma20v > ma60v].filter(Boolean).length
      : null;
    let hi20 = 0;
    for (let k = Math.max(0, i - 19); k <= i; k++) if (bars[k].c > hi20) hi20 = bars[k].c;
    const mom20v = ref20 ? (cur.c / ref20 - 1) * 100 : null;

    found.push({
      date: day,
      code: stock.code,
      name: stock.name,
      pattern: patternOf(trigger.tags),
      dayGain: round(trigger.gain),
      t1: fwd[0] === null ? null : round(fwd[0]),
      t2: fwd[1] === null ? null : round(fwd[1]),
      t3: fwd[2] === null ? null : round(fwd[2]),
      t4: fwd[3] === null ? null : round(fwd[3]),
      t5: fwd[4] === null ? null : round(fwd[4]),
      cum5: cum5 === null ? null : round(cum5),
      winDays: winDays,
      haveDays: have.length,
      winRate: winRate === null ? null : round(winRate, 1),
      complete: i + 5 <= lastIdx,
      score: sc.score,
      rating: ratingOf(sc.score),
      close: round(cur.c),
      low: round(cur.l),
      riskPct: round(sc.riskPct),
      vr1: round(trigger.vr1),
      vr20: round(trigger.vr20),
      closeLoc: round(trigger.closeLoc, 1),
      baseDays: base.days,
      baseWidth: round(base.width, 1),
      volume: Math.round(cur.v / 100),
      soft: sc.soft,
      gate: gate.label,
      parts: sc.parts,
      amountYi: round((cur.c * cur.v) / 1e8, 2),
      mom20: ref20 ? round((cur.c / ref20 - 1) * 100, 1) : null,
      mom5: ref5 ? round((cur.c / ref5 - 1) * 100, 1) : null,
      dist60: hi60 > 0 ? round((hi60 - cur.c) / hi60 * 100, 1) : null,
      limitUp: trigger.gain >= limit - 0.3,
      flatBoard: cur.h === cur.l,
      maStack: stack,
      aboveMa20: cur.c > ma20v,
      ma20Up: i >= 5 && ma20s[i - 5] !== null && ma20v > ma20s[i - 5],
      ma60Up: i >= 10 && ma60s[i - 10] !== null && ma60v > ma60s[i - 10],
      macdOk: macd.dif[i] > macd.dea[i],
      macdHist: round(macd.hist[i], 3),
      rsi14: rsi14[i] === null ? null : round(rsi14[i], 1),
      dd20: hi20 > 0 ? round((hi20 - cur.c) / hi20 * 100, 1) : null,
      rs20: mom20v !== null && idxMom ? round(mom20v - (idxMom.get(day) || 0), 1) : null,
    });
  }
  return found;
}

function buildStats(rows) {
  const complete = rows.filter(function (r) { return r.complete; });
  const cums = complete.map(function (r) { return r.cum5; }).sort(function (a, b) { return a - b; });
  const median = cums.length ? (cums.length % 2 ? cums[(cums.length - 1) / 2] : (cums[cums.length / 2 - 1] + cums[cums.length / 2]) / 2) : null;
  const byPattern = {};
  for (const r of rows) {
    const k = r.pattern || '其他';
    if (!byPattern[k]) byPattern[k] = { n: 0, complete: 0, wins: 0, sum5: 0 };
    byPattern[k].n++;
    if (r.complete) { byPattern[k].complete++; byPattern[k].sum5 += r.cum5; if (r.cum5 > 0) byPattern[k].wins++; }
  }
  const patterns = Object.keys(byPattern).map(function (k) {
    const v = byPattern[k];
    return {
      pattern: k, n: v.n, complete: v.complete,
      winRate: v.complete ? round((v.wins / v.complete) * 100, 1) : null,
      avg5: v.complete ? round(v.sum5 / v.complete, 2) : null,
    };
  }).sort(function (a, b) { return b.n - a.n; });

  const byRating = {};
  for (const r of rows) {
    if (!byRating[r.rating]) byRating[r.rating] = { n: 0, complete: 0, wins: 0, sum5: 0 };
    byRating[r.rating].n++;
    if (r.complete) { byRating[r.rating].complete++; byRating[r.rating].sum5 += r.cum5; if (r.cum5 > 0) byRating[r.rating].wins++; }
  }
  const ratings = ['A', 'A-', 'B', 'Watch'].filter(function (k) { return byRating[k]; }).map(function (k) {
    const v = byRating[k];
    return {
      rating: k, n: v.n, complete: v.complete,
      winRate: v.complete ? round((v.wins / v.complete) * 100, 1) : null,
      avg5: v.complete ? round(v.sum5 / v.complete, 2) : null,
    };
  });

  const wins = complete.filter(function (r) { return r.cum5 > 0; }).length;
  const dayWins = rows.reduce(function (s, r) { return s + r.winDays; }, 0);
  const dayTotal = rows.reduce(function (s, r) { return s + r.haveDays; }, 0);
  return {
    signals: rows.length,
    stocks: new Set(rows.map(function (r) { return r.code; })).size,
    complete: complete.length,
    winRate5d: complete.length ? round((wins / complete.length) * 100, 1) : null,
    avg5: complete.length ? round(complete.reduce(function (s, r) { return s + r.cum5; }, 0) / complete.length, 2) : null,
    median5: median === null ? null : round(median, 2),
    best5: complete.length ? round(Math.max.apply(null, complete.map(function (r) { return r.cum5; })), 2) : null,
    worst5: complete.length ? round(Math.min.apply(null, complete.map(function (r) { return r.cum5; })), 2) : null,
    dayWinRate: dayTotal ? round((dayWins / dayTotal) * 100, 1) : null,
    patterns: patterns,
    ratings: ratings,
  };
}

/* ------------------------------------------------------------ 精选：多因子 + 题材 */

/** 全市场逐日面板：上涨/下跌家数、涨幅≥4% 家数，用于市场环境分与页面展示。 */
function buildPanels(barsMap, windowStart, lastDay) {
  const panels = new Map();
  for (const bars of barsMap.values()) {
    for (let i = 1; i < bars.length; i++) {
      const day = bars[i].day;
      if (day < windowStart || day > lastDay) continue;
      const prev = bars[i - 1];
      if (!(prev.c > 0)) continue;
      const pct = (bars[i].c / prev.c - 1) * 100;
      if (!panels.has(day)) panels.set(day, { n: 0, up: 0, down: 0, brk4: 0, strong: 0 });
      const p = panels.get(day);
      p.n++;
      if (pct > 0) p.up++; else if (pct < 0) p.down++;
      if (pct >= 4) p.brk4++;
      if (pct >= 9.7) p.strong++;
    }
  }
  return panels;
}

/** 第一步：逐日粗排（形态 + 动量 + 市场 + 风险），并收集需要补题材数据的股票。 */
function pickStage1(rows, panels, gateMap, o) {
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.date)) byDay.set(r.date, []);
    byDay.get(r.date).push(r);
  }
  const days = Array.from(byDay.keys()).sort().reverse();
  const stage = new Map();
  const codes = new Set();
  for (const day of days) {
    const panel = panels.get(day) || null;
    const gate = gateMap.get(day) || { score: 3, label: '中性' };
    const list = picksMod.preRank(byDay.get(day), panel, gate.score, o);
    for (const c of list) {
      c.day = day;
      c.gateLabel = gate.label;
      c.upRatio = panel && (panel.up + panel.down) ? Math.round((panel.up / (panel.up + panel.down)) * 100) : null;
      codes.add(c.row.code);
    }
    stage.set(day, list);
  }
  return { days: days, stage: stage, codes: Array.from(codes), byDay: byDay };
}

/** 第二步：补上题材分后按分散约束取 ≤N 只。 */
function pickStage2(stage, theme, o) {
  const out = new Map();
  for (const day of stage.days) {
    const cands = picksMod.applyTheme(stage.stage.get(day), theme, themeApi);
    const picked = picksMod.selectTop(cands, o);
    out.set(day, picked.map(function (c, i) {
      const p = picksMod.toPick(c, i);
      p.gate = c.gateLabel;
      p.upRatio = c.upRatio;
      return p;
    }));
  }
  return out;
}

/** 精选回溯：同一套规则套在过去每个交易日上，和「全部信号」基准对比。 */
function picksBacktest(days, picksByDay, baseByDay) {
  const agg = function (list) {
    const done = list.filter(function (p) { return p.complete && p.cum5 !== null && p.cum5 !== undefined; });
    if (!done.length) return null;
    const sums = done.map(function (p) { return p.cum5; });
    const sorted = sums.slice().sort(function (a, b) { return a - b; });
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return {
      n: done.length,
      avg5: round(sums.reduce(function (s, x) { return s + x; }, 0) / done.length, 2),
      median5: round(median, 2),
      winRate5d: round((sums.filter(function (x) { return x > 0; }).length / done.length) * 100, 1),
      best5: round(Math.max.apply(null, sums), 2),
      worst5: round(Math.min.apply(null, sums), 2),
    };
  };
  const allPicks = [];
  const allBase = [];
  const rows = [];
  for (const day of days) {
    const p = picksByDay.get(day) || [];
    const b = baseByDay.get(day) || [];
    for (const x of p) allPicks.push(x);
    for (const x of b) allBase.push(x);
    const pa = agg(p);
    const ba = agg(b);
    rows.push({
      date: day,
      n: p.length,
      avg5: pa ? pa.avg5 : null,
      winRate5d: pa ? pa.winRate5d : null,
      baseN: b.length,
      baseAvg5: ba ? ba.avg5 : null,
      baseWinRate5d: ba ? ba.winRate5d : null,
      edge: pa && ba ? round(pa.avg5 - ba.avg5, 2) : null,
    });
  }
  const pa = agg(allPicks);
  const ba = agg(allBase);
  return {
    picks: pa,
    baseline: ba,
    edgeAvg5: pa && ba ? round(pa.avg5 - ba.avg5, 2) : null,
    edgeWinRate: pa && ba ? round(pa.winRate5d - ba.winRate5d, 1) : null,
    days: rows,
  };
}

function payloadTime() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/** 精选名单的口径说明（会写进 JSON 和页面页脚，避免脱离上下文引用）。 */
function pickNote(o, picks) {
  const bt = picks.backtest || {};
  const pa = bt.picks || null;
  const ba = bt.baseline || null;
  const cmp = (pa && ba)
    ? '同窗口回溯：精选 ' + pa.n + ' 个样本，5 日累计均值 ' + pa.avg5 + '%、正收益率 ' + pa.winRate5d + '%；全部信号基准 ' + ba.n + ' 个样本，均值 ' + ba.avg5 + '%、正收益率 ' + ba.winRate5d + '%，超额 ' + bt.edgeAvg5 + ' 个百分点。'
    : '';
  return '精选口径：每个交易日从全部 4% 突破信号里，按「突破形态20 + 走势技术形态25 + 动量大小25 + 题材热度20 + 市场环境5 + 风险可执行5」排序，' +
    '再做分散约束（同板块≤' + picks.params.perTheme + ' 只、同行业≤' + picks.params.perIndustry + ' 只、涨停股≤' + picks.params.maxLimitUp + ' 只），最多取 ' + picks.params.maxPicks + ' 只；' +
    '硬性条件：成交额≥' + picks.params.minAmountYi + ' 亿、止损距离≤' + picks.params.maxRiskPct + '%、剔除一字板。' +
    '走势技术形态衡量的是触发前的趋势结构（均线排列、MA20/MA60 方向、MACD、RSI14、近 20 日高位结构），不是突破当天的形态。' +
    '题材热度来自东方财富板块行情与板块日线，取该股所属板块中当日最强的一个板块及其近 5 日涨幅；' +
    '板块成分关系用的是抓取当日快照回溯历史，存在轻微前视，且覆盖不到全部个股（本轮 ' + picks.coverage.candidates + ' 只候选）。' +
    'T+N 与 5 日累计是事后统计，用于评估规则而不是预测。' + cmp;
}

/* ------------------------------------------------------------ 输出 */

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCsv(rows) {
  const head = ['日期', '代码', '名称', '形态', '当日涨幅%', 'T+1%', 'T+2%', 'T+3%', 'T+4%', 'T+5%', '5日累计%', '五日胜率%', '上涨天数', '已实现天数', '评分', '评级', '收盘', '止损参考', '风险%', '量比(昨)', '量比(20日)', '收盘位置%', '基底天数', '基底宽度%', '成交量(手)', '市场闸门'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.date, r.code, r.name, r.pattern, r.dayGain, r.t1, r.t2, r.t3, r.t4, r.t5, r.cum5,
      r.winRate, r.winDays, r.haveDays, r.score, r.rating, r.close, r.low, r.riskPct,
      r.vr1, r.vr20, r.closeLoc, r.baseDays, r.baseWidth, r.volume, r.gate,
    ].map(csvCell).join(','));
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CSV_FILE, '\ufeff' + lines.join('\n'), 'utf8');
}

function writePicksCsv(history) {
  const head = ['日期', '排名', '代码', '名称', '所属板块', '综合分', '走势技术形态', '动量', '题材', '当日涨幅%', '5日累计%', '收盘涨停', '样本完整'];
  const lines = [head.join(',')];
  for (const r of history || []) {
    lines.push([
      r.date, r.rank, r.code, r.name, r.board, r.total, r.trend, r.mom, r.theme,
      r.dayGain, r.cum5, r.limitUp ? '是' : '', r.complete ? '是' : '待更新',
    ].map(csvCell).join(','));
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(PICKS_CSV, '\ufeff' + lines.join('\n'), 'utf8');
}

/* ------------------------------------------------------------ main */

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const log = function (s) { if (!o.quiet) console.log(s); };
  const t0 = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  log('=== Stockbee Momentum Burst · A股 ===');
  await probeSource(log);
  const indexBars = (await fetchBars(INDEX_CODE, 400)).bars;
  if (!indexBars.length) throw new Error('无法获取上证指数日线，无法判定交易日与市场闸门');
  const bj = shanghaiParts();
  let lastIdxDay = indexBars[indexBars.length - 1].day;
  if (lastIdxDay === bj.day && bj.hhmm < 1505) lastIdxDay = indexBars[indexBars.length - 2].day;
  const windowStart = monthsBefore(lastIdxDay, o.months);

  if (o.skipIfFresh && !o.force) {
    const published = readJson(JSON_FILE);
    // 除了「已覆盖最新交易日」，还要求上一轮抓取覆盖率足够（云端偶发限流会让覆盖率掉下来）
    const cov = (published && published.coverage) || {};
    const coverageOk = !cov.universe || (cov.barsOk || 0) >= cov.universe * 0.95;
    const picksReady = published && published.picks && Array.isArray(published.picks.rows) &&
      published.picks.params && published.picks.params.maxPicks <= o.pickMax &&
      published.picks.params.themeMode === (o.useTheme ? 'enabled' : 'disabled');
    if (published && published.lastCompleteDay === lastIdxDay && Array.isArray(published.rows) && picksReady && coverageOk) {
      log('  已发布数据已覆盖最新交易日 ' + lastIdxDay + ' 且精选结构完整，跳过抓取，仅重新生成页面');
      fs.mkdirSync(path.dirname(HTML_FILE), { recursive: true });
      fs.writeFileSync(HTML_FILE, pageMod.renderHtml(), 'utf8');
      writeCsv(published.rows);
      return;
    }
    if (published && published.lastCompleteDay === lastIdxDay && (!coverageOk || !picksReady)) {
      log('  上一轮覆盖率偏低（' + (cov.barsOk || 0) + '/' + (cov.universe || 0) + '），本轮重新抓取补齐');
    }
  }

  const pool = collect.loadPool(o.pool);
  if (!pool || !Array.isArray(pool.stocks) || !pool.stocks.length) {
    throw new Error('股票池为空：先运行 node src/cli.js 或 node src/collect.js 同步 ' + o.pool);
  }
  let universe = pool.stocks.filter(function (s) { return s && s.code && s.name; })
    .map(function (s) { return { code: s.code, name: String(s.name).trim() }; });
  if (!o.includeSt) universe = universe.filter(function (s) { return !/ST|退/.test(s.name); });
  if (o.limit) universe = universe.slice(0, o.limit);
  log('  股票池 ' + pool.key + '：' + universe.length + ' 只；窗口 ' + windowStart + ' ~ ' + lastIdxDay);

  const gateMap = buildGate(indexBars, lastIdxDay);
  // 上证 20 日动量：算个股相对强度用（个股 20 日涨幅 - 指数 20 日涨幅）
  const idxMom20 = new Map();
  for (let i = 20; i < indexBars.length; i++) {
    const prev = indexBars[i - 20].c;
    if (prev > 0) idxMom20.set(indexBars[i].day, (indexBars[i].c / prev - 1) * 100);
  }
  const fetched = await loadBarsMap(universe.map(function (s) { return s.code; }), o, log);

  const rows = [];
  let scanned = 0;
  for (const s of universe) {
    const bars = fetched.bars.get(s.code);
    if (!bars || bars.length < 45) continue;
    scanned++;
    for (const r of analyzeStock(s, bars, o, gateMap, windowStart, { idxMom20: idxMom20 })) {
      if (r.score < o.minScore) continue;
      if (o.require4pct && r.pattern.indexOf('4%突破') < 0) continue;
      rows.push(r);
    }
  }
  rows.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.score - a.score;
  });

  const truncated = rows.length > o.maxRows;
  if (truncated) rows.length = o.maxRows;

  const stats = buildStats(rows);

  /* ---- 精选：多因子（突破形态 / 走势技术形态 / 动量 / 题材热度 / 市场环境 / 风险）---- */
  const pickOpts = Object.assign({}, picksMod.DEFAULTS, {
    maxPicks: o.pickMax, preRank: o.preRank, minAmountYi: o.minAmountYi,
    maxRiskPct: o.maxPickRisk, minScore: o.minScore,
    themeMode: o.useTheme ? 'enabled' : 'disabled',
  });
  const panels = buildPanels(fetched.bars, windowStart, lastIdxDay);
  const stage = pickStage1(rows, panels, gateMap, pickOpts);
  let theme = null;
  let themeNote = '';
  if (o.useTheme) {
    try {
      // 题材热度是给「今日精选」服务的；历史回溯保留技术/动量筛选，但不为每个历史候选
      // 重新请求所属板块，避免把 60 个交易日扩大成数千次外部请求。
      const themeDay = stage.days[0] || lastIdxDay;
      const latestCodes = (stage.stage.get(themeDay) || []).map(function (c) { return c.row.code; });
      theme = await themeApi.loadTheme(latestCodes, { log: log, concurrency: 6 });
      // 只有题材快照与精选日一致时才计入题材分；缓存落后/跨日时降级为中性，
      // 防止把当日主题热度回填给旧交易日。
      const snapDay = theme && theme.source === 'eastmoney' && theme.boards.size ? String((theme.at || '').slice(0, 10)) : '';
      if (theme && snapDay && snapDay !== themeDay) {
        theme.ok = false;
        theme.error = '题材快照日期 ' + snapDay + ' 与候选日 ' + themeDay + ' 不一致';
      }
      if (!theme.ok) themeNote = theme.error ? ('题材数据不可用：' + theme.error) : '题材数据不足，本轮题材分按中性计';
      else if (theme.fallback) themeNote = '东方财富板块接口不可用，题材归属/热度使用财联社快照回退；历史板块涨幅未补齐';
    } catch (e) {
      themeNote = '题材数据取数异常：' + String((e && e.message) || e);
    }
  } else {
    themeNote = '本轮以 --no-theme 运行，题材分按中性计';
  }
  if (themeNote) log('  精选：' + themeNote);
  const picksByDay = pickStage2(stage, theme, pickOpts);

  // 基准 = 改造前口径：当天全部「4% 突破 + 评分≥70」信号，用于对比精选是否真的更好
  const baseByDay = new Map();
  for (const r of rows) {
    if (r.score < o.minScore || r.pattern.indexOf('4%突破') < 0) continue;
    if (!baseByDay.has(r.date)) baseByDay.set(r.date, []);
    baseByDay.get(r.date).push(r);
  }
  const bt = picksBacktest(stage.days, picksByDay, baseByDay);
  // 行情缓存可能暂时落后于指数最新交易日；精选页面跟随最近一个有完整候选的信号日，
  // 同时保留 payload.lastCompleteDay 作为指数/扫描边界，避免页面无故显示 0 只。
  const pickDay = stage.days[0] || lastIdxDay;
  const latestPanel = panels.get(pickDay) || null;
  const latestGate = gateMap.get(pickDay) || { score: 3, label: '中性' };
  const latestPicks = picksByDay.get(pickDay) || [];
  const pickHistory = [];
  for (const day of stage.days) {
    for (const p of (picksByDay.get(day) || [])) {
      pickHistory.push({
        date: p.date, rank: p.rank, code: p.code, name: p.name, board: p.board,
        total: p.total, trend: p.trend, mom: p.mom, theme: p.theme, dayGain: p.dayGain,
        cum5: p.cum5, complete: p.complete, limitUp: p.limitUp,
      });
    }
  }
  const picks = {
    day: pickDay,
    generatedAt: payloadTime(),
    params: pickOpts,
    market: latestPanel ? {
      gate: latestGate.label, up: latestPanel.up, down: latestPanel.down, brk4: latestPanel.brk4,
      upRatio: (latestPanel.up + latestPanel.down) ? Math.round((latestPanel.up / (latestPanel.up + latestPanel.down)) * 100) : null,
    } : null,
    theme: {
      ok: !!(theme && theme.ok), source: theme ? theme.source : 'none', fallback: !!(theme && theme.fallback), boards: theme ? theme.boards.size : 0,
      memberOk: theme ? theme.memberOk : 0, memberMiss: theme ? theme.memberMiss : 0,
      boardHist: theme ? theme.histOk : 0, note: themeNote,
    },
    coverage: { days: stage.days.length, candidates: stage.codes.length },
    factors: [
      { name: '突破形态', max: 20, desc: '触发强度 / 前期基底 / 收盘位置 / 失败过滤' },
      { name: '走势技术形态', max: 25, desc: '均线排列 / 趋势阶段 / MACD / RSI / 高位结构' },
      { name: '动量大小', max: 25, desc: '当日涨幅 / 量能 / 20日与5日动量 / 距60日高点' },
      { name: '题材热度', max: 20, desc: '所属板块当日涨幅（取最强板块）/ 板块近5日涨幅' },
      { name: '市场环境', max: 5, desc: '上证 MA20/MA50 闸门 / 全市场上涨家数占比' },
      { name: '风险可执行', max: 5, desc: '止损距离 / 成交额 / 收盘涨停扣分' },
    ],
    rows: latestPicks,
    history: pickHistory,
    backtest: bt,
  };

  const payload = {
    version: 1,
    skill: 'stockbee-momentum-burst-screener',
    generatedAt: payloadTime(),
    source: '腾讯前复权日线(qfq) + 新浪兜底；市场闸门用上证指数；题材热度用东方财富板块行情与板块日线',
    window: { start: windowStart, end: lastIdxDay, months: o.months },
    lastCompleteDay: lastIdxDay,
    thresholds: {
      minPrice: o.minPrice, minVolumeShares: o.minVolume, fourPct: o.fourPct, dollar: o.dollar,
      maxRiskPct: o.maxRiskPct, minScore: o.minScore, maxBaseWidth: o.maxBaseWidth,
      pickMax: o.pickMax, pickMinAmountYi: o.minAmountYi, pickMaxRiskPct: o.maxPickRisk,
    },
    coverage: { pool: pool.key, universe: universe.length, scanned: scanned, barsOk: fetched.bars.size, failed: fetched.failed },
    truncated: truncated,
    stats: stats,
    picks: picks,
    pickNote: pickNote(o, picks),
    note: '原始信号口径：触发日含 4% 突破，且评分 ≥ ' + o.minScore + '（B 及以上）；已剔除 ST / *ST / 退市整理股，不含北交所。口径：以触发日收盘价为基准（T0 收盘 = 入场参考），T+N 为之后第 N 个交易日的单日涨幅，5日累计 = T+5 收盘 / T0 收盘 - 1；五日胜率 = 已实现交易日中收涨天数占比，标「待更新」的信号其后交易日尚未走完。价格为前复权，成交量按股计算、表中显示为手。仅为人工复核候选，不构成投资建议。',
    rows: rows,
  };

  writeJson(JSON_FILE, payload);
  writeJson(path.join(path.dirname(HTML_FILE), 'stockbee.json'), payload);
  writeJson(PICKS_FILE, { version: 1, generatedAt: payload.generatedAt, day: pickDay, params: pickOpts, market: picks.market, theme: picks.theme, coverage: picks.coverage, rows: latestPicks, history: pickHistory, backtest: bt });
  writeCsv(rows);
  writePicksCsv(pickHistory);
  fs.mkdirSync(path.dirname(HTML_FILE), { recursive: true });
  fs.writeFileSync(HTML_FILE, pageMod.renderHtml(), 'utf8');

  log('  信号 ' + stats.signals + ' 条，涉及 ' + stats.stocks + ' 只；完整 5 日样本 ' + stats.complete);
  log('  5 日累计：均值 ' + stats.avg5 + '%，中位数 ' + stats.median5 + '%，正收益率 ' + stats.winRate5d + '%，单日胜率 ' + stats.dayWinRate + '%');
  log('  精选 ' + lastIdxDay + '：' + latestPicks.length + ' 只（候选粗排 ' + stage.codes.length + ' 只 / ' + stage.days.length + ' 个交易日）');
  log('  精选回溯（全体交易日）：' + (bt.picks ? bt.picks.n + ' 个样本，5日均值 ' + bt.picks.avg5 + '%，正收益 ' + bt.picks.winRate5d + '%' : '样本不足'));
  log('  同窗口基准（全部信号）：' + (bt.baseline ? bt.baseline.n + ' 个样本，5日均值 ' + bt.baseline.avg5 + '%，正收益 ' + bt.baseline.winRate5d + '%' : '样本不足'));
  log('  输出：' + JSON_FILE);
  log('        ' + CSV_FILE);
  log('        ' + PICKS_FILE);
  log('        ' + HTML_FILE);
  log('  总用时 ' + Math.round((Date.now() - t0) / 1000) + 's');
}
if (require.main === module) {
  main().catch(function (e) { console.error('ERROR: ' + ((e && e.stack) || e)); process.exit(1); });
}

module.exports = { main: main, detectTrigger: detectTrigger, detectBase: detectBase, analyzeStock: analyzeStock };
