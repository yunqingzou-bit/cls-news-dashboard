'use strict';
/**
 * 技术面结论（日线）——把 technical-analyst skill 的判定框架做成可批量执行的版本。
 *
 * 与 skill 的对应关系：
 *   趋势分析      -> 日线摆动高低点结构（HH/HL vs LH/LL）+ 均线排列
 *   支撑阻力      -> 11 日枢轴摆动点 + 250 日高低
 *   均线分析      -> 5 / 10 / 20 / 50 / 120 / 250 日均线（位置、斜率、是否测试）
 *   成交量        -> 当日量比（对 20 日均量）与当日涨跌方向
 *   形态与价格行为 -> 收盘位置、连续阴阳、偏离 20 日均线幅度
 *   情景与概率    -> 按规则打分映射为倾向 + 主导情景概率 + 失效位
 *
 * 数据源：新浪长历史日线（最多 1023 根，约 4 年，不复权），直接用日线计算。
 * 不复权相对前复权在最近一年的价位上差距约 1%，250 日均线约 3%，趋势与量能判定不受影响。
 * 结果按股票缓存到 data/technical.json（默认 24 小时刷新一次）。
 */
const fs = require('node:fs');
const path = require('node:path');
const collectMod = require('./collect.js');
const cls = require('./cls.js');

const CACHE_FILE = path.join(collectMod.DATA_DIR, 'technical.json');
const SINA = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
// 指标口径版本：周线→日线、均线组合变更等，都必须递增，旧缓存整体作废重算
const CACHE_VER = 3;

/* ------------------------------------------------------------ 取数 */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function loadCache() {
  const x = readJson(CACHE_FILE);
  if (x && x.stocks && x.version === CACHE_VER) return x;
  return { version: CACHE_VER, source: 'sina-unadjusted', updatedAt: null, stocks: {} };
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  cache.version = CACHE_VER;
  cache.updatedAt = new Date().toISOString();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
}

async function fetchDaily(code, retries) {
  const url = SINA + '?symbol=' + encodeURIComponent(code) + '&scale=240&ma=no&datalen=1023';
  let last;
  const maxTry = retries === undefined ? 3 : retries;
  for (let i = 0; i <= maxTry; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 20000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' } });
      clearTimeout(timer);
      // 456 是新浪的限流码，退避后重试
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (!Array.isArray(body) || !body.length) throw new Error('空数据');
      return body.map(function (x) {
        return { day: String(x.day), o: Number(x.open), h: Number(x.high), l: Number(x.low), c: Number(x.close), v: Number(x.volume) };
      }).filter(function (x) { return Number.isFinite(x.c) && x.c > 0; });
    } catch (e) {
      last = e;
      if (i < maxTry) {
        const throttled = /456/.test(String(e && e.message || e));
        const wait = throttled ? 1500 * (i + 1) : 400 * (i + 1);
        await new Promise(function (r) { setTimeout(r, wait); });
      }
    }
  }
  throw last;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/** 兜底数据源：财联社日线（约 200 根），用于新浪没有数据的次新股。 */
async function fetchDailyCls(code) {
  const body = await cls.xquote('/v2/quote/a/kline', { code: code, period: 'd', limit: 300 });
  const list = (body && body.data) || [];
  if (!list.length) throw new Error('财联社无数据');
  return list.map(function (x) {
    const d = String(x.trade_date);
    return {
      day: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8),
      o: Number(x.open_px), h: Number(x.high_px), l: Number(x.low_px), c: Number(x.close_px),
      v: Number(x.business_amount) || 0,
    };
  }).filter(function (x) { return Number.isFinite(x.c) && x.c > 0; });
}

// 新浪限流（HTTP 456）时的熔断：连续失败若干次后本轮直接走兜底源，避免被退避重试拖慢整轮
let sinaBlockedUntil = 0;
let sinaFails = 0;
const SINA_COOLDOWN_MS = 10 * 60 * 1000;

/** 先新浪（长历史），限流或次新股时退回财联社（约 200 根，缺 250 日均线）。 */
async function fetchDailyAny(code) {
  if (Date.now() < sinaBlockedUntil) {
    return { rows: await fetchDailyCls(code), source: 'cls', note: '新浪限流冷却中' };
  }
  try {
    const rows = await fetchDaily(code);
    sinaFails = 0;
    return { rows: rows, source: 'sina' };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/456/.test(msg)) {
      sinaFails++;
      if (sinaFails >= 3) {
        sinaBlockedUntil = Date.now() + SINA_COOLDOWN_MS;
        sinaFails = 0;
      }
    }
    return { rows: await fetchDailyCls(code), source: 'cls', note: msg };
  }
}

/* ------------------------------------------------------ 周线聚合 */

/** 周一为一周开始，返回该周最后一个交易日（周五）的日期键。 */
function weekKey(day) {
  const dt = new Date(day + 'T00:00:00Z');
  const dow = (dt.getUTCDay() + 6) % 7; // 周一=0
  dt.setUTCDate(dt.getUTCDate() - dow + 4); // 该周周五
  return dt.toISOString().slice(0, 10);
}

function toWeekly(daily) {
  const out = [];
  let cur = null;
  for (const x of daily) {
    const k = weekKey(x.day);
    if (!cur || cur.week !== k) {
      cur = { week: k, o: x.o, h: x.h, l: x.l, c: x.c, v: 0, days: 0 };
      out.push(cur);
    }
    cur.h = Math.max(cur.h, x.h);
    cur.l = Math.min(cur.l, x.l);
    cur.c = x.c;
    cur.v += x.v;
    cur.days++;
  }
  // 去掉本周未走完的那根（最后一个键在未来或不完整时保留，因为盘中也有参考价值）
  return out;
}

function round(v, d) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const p = Math.pow(10, d === undefined ? 2 : d);
  return Math.round(v * p) / p;
}

/* -------------------------------------------------- 指标与摆动点 */

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
}

function swings(w, span) {
  const half = Math.floor((span || 5) / 2);
  const highs = [];
  const lows = [];
  for (let i = half; i < w.length - half; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - half; j <= i + half; j++) {
      if (w[j].h > w[i].h) isHigh = false;
      if (w[j].l < w[i].l) isLow = false;
    }
    if (isHigh) highs.push({ day: w[i].day, price: w[i].h });
    if (isLow) lows.push({ day: w[i].day, price: w[i].l });
  }
  return { highs: highs, lows: lows };
}

function compute(daily) {
  const w = Array.isArray(daily) ? daily.filter(function (x) { return Number.isFinite(x.c) && x.c > 0; }) : [];
  if (!w.length) return null;
  // 次新股：日线样本太少，不做方向判断，只标注上市交易日数
  if (w.length < 130) {
    const last0 = w[w.length - 1];
    return { kind: 'daily', young: true, bars: w.length, day: last0.day, close: round(last0.c, 2) };
  }
  const closes = w.map(function (x) { return x.c; });
  const last = w[w.length - 1];
  const prev = w[w.length - 2];
  const maBack = function (n, back) {
    const end = closes.length - back;
    return end >= n ? mean(closes.slice(end - n, end)) : null;
  };
  const ma20 = maBack(20, 0);
  const ma5 = maBack(5, 0);
  const ma10 = maBack(10, 0);
  const ma50 = maBack(50, 0);
  const ma120 = maBack(120, 0);
  const ma250 = maBack(250, 0);
  const slopeOf = function (n, back) {
    const now = maBack(n, 0);
    const then = maBack(n, back);
    return now === null || then === null ? null : now - then;
  };
  const vma20 = w.length >= 20 ? mean(w.slice(-20).map(function (x) { return x.v; })) : null;
  const volRatio = vma20 ? last.v / vma20 : null;

  let up = 0;
  let dn = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const a = 1 / 14;
    up = up * (1 - a) + Math.max(ch, 0) * a;
    dn = dn * (1 - a) + Math.max(-ch, 0) * a;
  }
  const rsi = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);

  // 用最近 250 个交易日近似一年，作为高低点与位置参考
  const win52 = w.slice(-250);
  const win104 = w.slice(-500);
  const high52 = Math.max.apply(null, win52.map(function (x) { return x.h; }));
  const low52 = Math.min.apply(null, win52.map(function (x) { return x.l; }));
  const high52w = win52[win52.reduce(function (bi, x, i, a) { return x.h > a[bi].h ? i : bi; }, 0)].day;
  const low52w = win52[win52.reduce(function (bi, x, i, a) { return x.l < a[bi].l ? i : bi; }, 0)].day;
  const rangePos = high52 > low52 ? (last.c - low52) / (high52 - low52) : null;

  const sw = swings(w, 11);
  const recentHighs = sw.highs.slice(-6);
  const recentLows = sw.lows.slice(-6);

  // 日线结构：比较最近两个摆动高/低
  let structure = 'mixed';
  const hh = recentHighs.length >= 2 ? recentHighs[recentHighs.length - 1].price > recentHighs[recentHighs.length - 2].price : null;
  const hl = recentLows.length >= 2 ? recentLows[recentLows.length - 1].price > recentLows[recentLows.length - 2].price : null;
  if (hh === true && hl === true) structure = 'up';
  else if (hh === false && hl === false) structure = 'down';

  const slope20 = slopeOf(20, 5);
  const slope50 = slopeOf(50, 5);
  const chgPct = prev && prev.c ? (last.c / prev.c - 1) * 100 : null;

  // 保留最近 30 个交易日的收盘与当日涨幅，用于按新闻日期算 T+0 ~ T+5
  const recent = [];
  for (let i = Math.max(1, w.length - 30); i < w.length; i++) {
    const pc = w[i - 1].c;
    recent.push([w[i].day, round(w[i].c, 2), pc ? round((w[i].c / pc - 1) * 100, 2) : null]);
  }

  return {
    kind: 'daily',
    ver: 3,
    day: last.day,
    bars: w.length,
    close: round(last.c, 2),
    prevClose: round(prev.c, 2),
    open: round(last.o, 2),
    high: round(last.h, 2),
    low: round(last.l, 2),
    chgPct: round(chgPct, 2),
    ma5: round(ma5, 2),
    ma10: round(ma10, 2),
    ma20: round(ma20, 2),
    ma50: round(ma50, 2),
    ma120: round(ma120, 2),
    ma250: round(ma250, 2),
    slope20: round(slope20, 3),
    slope50: round(slope50, 3),
    volRatio: round(volRatio, 2),
    rsi14: round(rsi, 1),
    high52: round(high52, 2),
    low52: round(low52, 2),
    high52Day: high52w,
    low52Day: low52w,
    rangePos: round(rangePos, 3),
    structure: structure,
    swingHighs: recentHighs.map(function (x) { return { day: x.day, price: round(x.price, 2) }; }),
    swingLows: recentLows.map(function (x) { return { day: x.day, price: round(x.price, 2) }; }),
    high500: round(Math.max.apply(null, win104.map(function (x) { return x.h; })), 2),
    low500: round(Math.min.apply(null, win104.map(function (x) { return x.l; })), 2),
    recent: recent,
  };
}

/* ---------------------------------------------------- 结论（倾向） */

function pct(v) { return v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
function num(v) { return v === null || v === undefined ? '—' : Number(v).toFixed(2); }

function analyse(m) {
  const c = m.close;
  let score = 0;

  // 结构
  if (m.structure === 'up') score += 1.5;
  else if (m.structure === 'down') score -= 1.5;

  const mA = function (k) { return m['ma' + k] === undefined ? null : m['ma' + k]; };
  const above = function (k) { const v = mA(k); return v !== null && c > v; };
  const above5 = above(5);
  const above10 = above(10);
  const above20 = above(20);
  const above50 = above(50);
  const above120 = above(120);
  const above250 = above(250);
  const MA_KEYS = [5, 10, 20, 50, 120, 250];
  // 20/50/120/250 中离现价 ±1% 以内的那条，视为“正在测试”
  const testKey = [20, 50, 120, 250].filter(function (k) {
    const v = mA(k);
    return v !== null && Math.abs(c / v - 1) <= 0.01;
  })[0] || null;
  const bullAlign = above5 && above10 && above20 && above50 && (mA(120) === null || above120) &&
    mA(5) >= mA(10) && mA(10) >= mA(20) && mA(20) >= mA(50) && (m.slope20 || 0) >= 0;
  const bearAlign = mA(5) !== null && mA(20) !== null && mA(50) !== null && c < mA(5) && mA(5) < mA(20) && mA(20) < mA(50);
  if (bullAlign) score += 2;
  else if (above20 && (mA(120) === null || above120)) score += 1;
  else if (bearAlign) score -= 1.5;

  // 中期（50 日）上下、短期（5/10 日）动能
  if (testKey === 50) score += 0;
  else if (above50) score += 0.5;
  else score -= 0.5;
  if (above5 && above10) score += 0.5;
  else if (!above5 && !above10) score -= 0.5;

  const up = (m.chgPct || 0) > 0;
  if (m.volRatio !== null && m.volRatio >= 1.8) score += up ? 1 : -1;

  if (m.rsi14 !== null && m.rsi14 >= 75) score -= 1;
  else if (m.rsi14 !== null && m.rsi14 <= 30) score += 1;

  if (m.ma20 !== null && c > m.ma20 * 1.25) score -= 0.75;
  else if (m.ma20 !== null && c < m.ma20 * 0.8) score += 0.5;

  if (m.rangePos !== null && m.rangePos >= 0.75) score += 1;
  else if (m.rangePos !== null && m.rangePos <= 0.25) score -= 1;

  // 趋势标签
  let trend;
  if (bullAlign && m.structure === 'up') trend = '上升趋势';
  else if (score >= 2 && m.structure === 'up') trend = '上升趋势（形成中）';
  else if (above20 && (mA(120) === null || above120) && mA(20) !== null && mA(50) !== null && mA(20) < mA(50)) {
    trend = '下跌后的反弹（趋势待确认）';
  } else if (score <= -1.5 || m.structure === 'down') trend = '下降趋势';
  else trend = '区间震荡';

  // 位置：按站上 / 受压分组列出六条均线及其数值
  const upKeys = MA_KEYS.filter(function (k) { return above(k); });
  const dnKeys = MA_KEYS.filter(function (k) { return mA(k) !== null && !above(k); });
  const fmtGroup = function (keys) {
    return keys.join('/') + ' 日（' + keys.map(function (k) { return num(mA(k)); }).join('/') + '）';
  };
  const posBits = [];
  if (upKeys.length) posBits.push('站上 ' + fmtGroup(upKeys));
  if (dnKeys.length) posBits.push('受压 ' + fmtGroup(dnKeys));
  if (testKey) posBits.push('正在测试 ' + testKey + ' 日均线');
  const position = posBits.join('；');

  // 量能
  let volume;
  if (m.volRatio === null) volume = '量能数据不足';
  else volume = '当日量比 ' + num(m.volRatio) + ' 倍（' + (m.volRatio >= 1.8 ? (up ? '放量上攻' : '放量下跌') : m.volRatio <= 0.7 ? '明显缩量' : '量能平稳') + '）';

  // 关键位：离现价最近的摆动支撑 / 阻力（并纳入 250 日均线与近一年高低）
  const uniq = function (list) {
    const seen = {};
    return list.filter(function (p) { return Number.isFinite(p) && !seen[p] && (seen[p] = 1); });
  };
  const maLevels = [20, 50, 120, 250].map(mA).filter(function (v) { return v !== null; });
  const supCand = uniq(m.swingLows.map(function (x) { return x.price; })
    .concat(maLevels.filter(function (p) { return p < c; }))
    .concat(m.low52 < c ? [m.low52] : [])
    .filter(function (p) { return p < c * 0.995; })).sort(function (a, b) { return b - a; });
  const resCand = uniq(m.swingHighs.map(function (x) { return x.price; })
    .concat([m.high52])
    .concat(maLevels.filter(function (p) { return p > c; }))
    .filter(function (p) { return p > c * 1.005; })).sort(function (a, b) { return a - b; });
  const supText = supCand.length ? supCand.slice(0, 2).map(num).join(' / ') : num(m.low52);
  const resText = resCand.length ? resCand.slice(0, 2).map(num).join(' / ') : num(m.high52);
  const keyLevels = '支撑 ' + supText + ' ｜ 阻力 ' + resText;

  // 倾向与概率
  let tilt;
  let prob;
  // 日线信号比周线噪音大，概率整体下调
  if (score >= 3) { tilt = '偏多'; prob = 50; }
  else if (score >= 1.75) { tilt = '偏多'; prob = 45; }
  else if (score >= 0.6) { tilt = '中性偏多'; prob = 40; }
  else if (score > -0.6) { tilt = '中性（区间为主）'; prob = 40; }
  else if (score > -1.75) { tilt = '中性偏空'; prob = 40; }
  else { tilt = '偏空'; prob = 45; }

  const invalidation = tilt.indexOf('多') >= 0 ? (supCand[0] || m.low52) : (resCand[0] || m.high52);
  const text = [
    '趋势：' + trend + '（日线）',
    '位置：' + position,
    '量能：' + volume + '，当日 ' + pct(m.chgPct) + ' 收 ' + num(m.close),
    '关键位：' + keyLevels,
    '倾向：' + tilt + '（日线，主导情景 ' + prob + '%）｜' + (tilt.indexOf('多') >= 0 ? ' 失效位 ' : ' 转强位 ') + num(invalidation),
  ].join('\n');
  return { score: round(score, 2), trend: trend, tilt: tilt, prob: prob, invalidation: round(invalidation, 2), text: text };
}

function conclusionFor(record) {
  if (!record || !record.metrics) return '技术面数据暂未取到（下一轮自动补齐）';
  const m = record.metrics;
  if (m.young) {
    return ['趋势：上市不足 ' + m.bars + ' 个交易日，日线样本不足',
      '位置：—',
      '量能：—',
      '关键位：—',
      '倾向：新股暂不做日线技术面判断'].join('\n');
  }
  return analyse(m).text;
}

/* -------------------------------------------------------- 缓存刷新 */

function isFresh(record, hours) {
  if (!record || !record.at) return false;
  const age = Date.now() - new Date(record.at).getTime();
  // 失败记录 1 小时后重试，避免偶尔的接口抖动把某只股票长期钉在“取不到”
  if (record.error) return age < 3600000;
  // 旧版本按周线/旧均线组合计算，指标口径变更后自动作废重算
  if (!record.metrics || record.metrics.kind !== 'daily' || record.metrics.ver !== 3) return false;
  // 走了兜底数据源（约 200 根，缺 250 日均线）的记录 2 小时后重试，新浪恢复后自动升级
  if (record.partial) return age < 2 * 3600000;
  return age < hours * 3600000;
}

/**
 * 按新闻时间算「当天 / T+1 ~ T+5」的日涨跌幅。
 * 当天 = 新闻时间之后（含）的第一个交易日，所以周末或节假日发的新闻，当天算下一个交易日。
 * 返回 { day0, close0, d0, t: [t1..t5] }，尚未发生的档位为 null。
 */
function forwardReturns(record, newsSec) {
  const bars = record && record.metrics && record.metrics.recent;
  if (!bars || !bars.length || !newsSec) return null;
  const key = new Date((Number(newsSec) + 8 * 3600) * 1000).toISOString().slice(0, 10);
  let i = -1;
  for (let k = 0; k < bars.length; k++) {
    if (String(bars[k][0]) >= key) { i = k; break; }
  }
  if (i === -1) return null;
  const t = [];
  for (let n = 1; n <= 5; n++) t.push(i + n < bars.length ? bars[i + n][2] : null);
  return { day0: bars[i][0], close0: bars[i][1], d0: bars[i][2], t: t };
}

function attachRows(rows, cache) {
  const c = cache || loadCache();
  for (const r of rows) {
    const rec = c.stocks[r.stockCode];
    r.technicalConclusion = conclusionFor(rec);
    r.technicalAt = rec && rec.at || null;
    r.technicalDay = rec && rec.metrics && rec.metrics.day || null;
    r.forward = forwardReturns(rec, r.ctime);
  }
  return rows;
}

function runPool(items, worker, concurrency) {
  return collectMod.runPool(items, worker, concurrency);
}

async function refresh(rows, opts) {
  opts = opts || {};
  const cfg = opts.config || collectMod.loadConfig();
  const tcfg = cfg.technical || {};
  if (tcfg.enabled === false) return attachRows(rows);
  const hours = Number(tcfg.refreshHours || 24);
  const concurrency = Number(tcfg.concurrency || 3);
  const delayMs = Number(tcfg.requestDelayMs === undefined ? 120 : tcfg.requestDelayMs);
  const cache = loadCache();
  const codes = new Map();
  for (const r of rows) if (r.stockCode && !codes.has(r.stockCode)) codes.set(r.stockCode, r.stockName || '');
  let stale = Array.from(codes.keys()).filter(function (code) { return !isFresh(cache.stocks[code], hours); });
  // 每轮最多刷新多少只：云端用它可以避免一次抓几百只被数据源限流（0 = 不限）
  const maxPerRun = Number(tcfg.maxPerRun || 0);
  const deferred = maxPerRun > 0 && stale.length > maxPerRun ? stale.length - maxPerRun : 0;
  if (deferred) {
    stale = stale.slice().sort(function (a, b) {
      const ta = cache.stocks[a] && cache.stocks[a].at ? new Date(cache.stocks[a].at).getTime() : 0;
      const tb = cache.stocks[b] && cache.stocks[b].at ? new Date(cache.stocks[b].at).getTime() : 0;
      return ta - tb;
    }).slice(0, maxPerRun);
  }
  let done = 0;
  let errors = 0;
  await runPool(stale, async function (code) {
    try {
      if (delayMs > 0) await sleep(delayMs);
      const got = await fetchDailyAny(code);
      const metrics = compute(got.rows);
      if (!metrics) throw new Error('日线数据不足');
      cache.stocks[code] = {
        code: code,
        name: codes.get(code) || '',
        at: new Date().toISOString(),
        source: got.source,
        // 兜底源只有约 200 根日线，算不出 250 日均线，标记为降级记录稍后重试
        partial: got.source !== 'sina' || metrics.ma250 === null,
        metrics: metrics,
      };
    } catch (e) {
      errors++;
      if (!cache.stocks[code]) cache.stocks[code] = { code: code, name: codes.get(code) || '', at: new Date().toISOString(), error: String((e && e.message) || e) };
    }
    done++;
    if (opts.onProgress) opts.onProgress({ done: done, total: stale.length, errors: errors, cached: codes.size - stale.length });
    if (done % 25 === 0) saveCache(cache);
  }, Math.max(1, concurrency));
  saveCache(cache);
  attachRows(rows, cache);
  return { rows: rows, total: codes.size, refreshed: stale.length, cached: codes.size - stale.length - deferred, errors: errors, deferred: deferred };
}

module.exports = {
  CACHE_FILE: CACHE_FILE,
  loadCache: loadCache,
  saveCache: saveCache,
  fetchDaily: fetchDaily,
  fetchDailyCls: fetchDailyCls,
  fetchDailyAny: fetchDailyAny,
  toWeekly: toWeekly,
  compute: compute,
  analyse: analyse,
  conclusionFor: conclusionFor,
  forwardReturns: forwardReturns,
  attachRows: attachRows,
  refresh: refresh,
};
