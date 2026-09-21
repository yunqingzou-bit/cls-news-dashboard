'use strict';
/**
 * 题材热度数据层：东方财富「板块行情 + 板块日线 + 个股所属板块」。
 *
 * 为什么单独抽一个模块：
 *   - 板块当日涨幅能回答「今天钱在哪个题材里」，但要做历史验证就必须能取到
 *     过去 N 个交易日的板块涨幅，所以同时抓板块日线（push2his）。
 *   - 个股属于哪些板块是「慢变量」，按 7 天缓存；板块日线按 6 小时缓存；
 *     实时榜单按 10 分钟缓存。缓存写在 data/theme.json（与 data/market.json 同级、同样不进版本库）。
 *   - 云端网络不一定到得了东财，所有方法失败时都不抛给主流程，由调用方降级。
 *
 * 返回结构：
 *   { ok, at, boards: Map(BK -> {code,name,kind,pct,fund,up,down,leader}),
 *     hist: Map(BK -> {day: pct}), members: Map(code -> [{code,name}]),
 *     boardHistOk, boardHistMiss, memberOk, memberMiss }
 */
const fs = require('node:fs');
const path = require('node:path');
const collect = require('./collect.js');

const CACHE_FILE = path.join(collect.DATA_DIR, 'theme.json');
const CACHE_VERSION = 1;
const TTL_LIST = 10 * 60 * 1000;
const TTL_HIST = 6 * 3600 * 1000;
const TTL_MEMBER = 7 * 24 * 3600 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' };
const LIST_URL = 'https://push2.eastmoney.com/api/qt/clist/get';
const KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const MEMBER_URL = 'https://push2.eastmoney.com/api/qt/slist/get';
// m:90 t:3 = 概念板块，m:90 t:2 = 行业板块
const MARKET_KINDS = [
  { kind: 'concept', fs: 'm:90+t:3' },
  { kind: 'industry', fs: 'm:90+t:2' },
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function loadCache() {
  const c = readJson(CACHE_FILE) || {};
  if (c.version !== CACHE_VERSION) return { version: CACHE_VERSION, boardsAt: null, boards: [], hist: {}, members: {} };
  c.hist = c.hist || {};
  c.members = c.members || {};
  c.boards = c.boards || [];
  return c;
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch (_) { /* 缓存写失败不影响主流程 */ }
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: HEADERS });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** 全量板块榜（概念 + 行业）：一次问一页，拿到 total 后按需翻页。 */
async function fetchBoardList() {
  const out = [];
  const PAGE = 100; // 东财单页上限 100，超过会被截断
  for (const mk of MARKET_KINDS) {
    let got = 0;
    for (let pn = 1; pn <= 12; pn++) {
      const url = LIST_URL + '?pn=' + pn + '&pz=' + PAGE + '&po=1&np=1&fltt=2&invt=2&fid=f3&fs=' +
        encodeURIComponent(mk.fs) + '&fields=f12,f14,f3,f62,f104,f105,f128,f136';
      const j = await fetchJson(url, 15000);
      const diff = (j && j.data && j.data.diff) || [];
      const total = (j && j.data && j.data.total) || 0;
      for (const x of diff) {
        const code = String(x.f12 || '');
        if (!/^BK\d+$/.test(code)) continue;
        out.push({
          code: code,
          name: String(x.f14 || ''),
          kind: mk.kind,
          pct: num(x.f3),
          fund: num(x.f62),
          up: num(x.f104),
          down: num(x.f105),
          leader: String(x.f128 || ''),
        });
        got++;
      }
      if (!diff.length || diff.length < PAGE || got >= total) break;
    }
  }
  return out;
}

/** 板块日线（收盘涨幅%），用于历史回算题材热度。 */
async function fetchBoardHist(bk, lmt) {
  const url = KLINE_URL + '?secid=90.' + encodeURIComponent(bk) +
    '&fields1=f1,f2,f3&fields2=f51,f53,f59&klt=101&fqt=1&lmt=' + (lmt || 90) + '&end=20500101';
  const j = await fetchJson(url, 15000);
  const lines = (j && j.data && j.data.klines) || [];
  const days = {};
  for (const ln of lines) {
    const p = String(ln).split(',');
    const d = p[0];
    const pct = num(p[2]);
    if (d && pct !== null) days[d] = pct;
  }
  return days;
}

/** 个股所属板块（东财 slist，spt=3）。 */
async function fetchStockBoards(code) {
  const mkt = /^sh/.test(code) ? 1 : 0;
  const url = MEMBER_URL + '?spt=3&fltt=2&invt=2&fields=f12,f14&secid=' + mkt + '.' + code.slice(2) +
    '&pn=1&pz=30&po=1&fid=f3';
  const j = await fetchJson(url, 12000);
  const diff = (j && j.data && j.data.diff) || [];
  const list = Array.isArray(diff) ? diff : Object.keys(diff).map(function (k) { return diff[k]; });
  const out = [];
  for (const x of list) {
    const bc = String(x.f12 || '');
    if (!/^BK\d+$/.test(bc)) continue;
    out.push({ code: bc, name: String(x.f14 || '') });
  }
  return out;
}

async function runPool(items, concurrency, delayMs, fn) {
  const queue = items.slice();
  async function worker() {
    for (;;) {
      const it = queue.shift();
      if (it === undefined) return;
      try { await fn(it); } catch (_) { /* 单条失败不中断 */ }
      if (delayMs) await new Promise(function (r) { setTimeout(r, delayMs); });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
}

/**
 * 取题材数据。codes = 需要「所属板块」的股票；histDays = 需要回算的交易日数。
 * opts: { refresh, quiet, concurrency, log }
 */
async function loadTheme(codes, opts) {
  const o = opts || {};
  const log = o.log || function () {};
  const now = Date.now();
  const cache = o.noCache ? { version: CACHE_VERSION, boards: [], hist: {}, members: {} } : loadCache();
  const result = {
    ok: false, at: new Date().toISOString(),
    boards: new Map(), hist: new Map(), members: new Map(),
    boardOk: 0, boardMiss: 0, histOk: 0, histMiss: 0, memberOk: 0, memberMiss: 0,
    error: '', source: 'eastmoney', fallback: false,
  };

  // 1) 实时板块榜
  const listFresh = cache.boardsAt && cache.boards.length && (now - new Date(cache.boardsAt).getTime() < TTL_LIST);
  if (!listFresh) {
    try {
      const boards = await fetchBoardList();
      if (boards.length) { cache.boards = boards; cache.boardsAt = new Date().toISOString(); saveCache(cache); }
    } catch (e) {
      result.error = '板块榜：' + String((e && e.message) || e);
      log('  题材：板块榜取数失败（' + result.error + '），本轮题材维度降级');
    }
  }
  for (const b of cache.boards || []) result.boards.set(b.code, b);

  // 2) 个股所属板块（只问需要的那批）
  const needMember = [];
  for (const code of codes || []) {
    const hit = cache.members[code];
    if (hit && now - new Date(hit.at).getTime() < TTL_MEMBER) { result.members.set(code, hit.boards || []); continue; }
    needMember.push(code);
  }
  if (needMember.length) {
    log('  题材：补抓 ' + needMember.length + ' 只个股所属板块（缓存命中 ' + result.members.size + '）');
    await runPool(needMember, o.concurrency || 6, 60, async function (code) {
      const boards = await fetchStockBoards(code);
      cache.members[code] = { at: new Date().toISOString(), boards: boards };
      result.members.set(code, boards);
    });
    saveCache(cache);
  }
  result.memberOk = result.members.size;
  result.memberMiss = (codes || []).length - result.memberOk;

  // 板块实时榜失败时，仍可由「个股所属板块」拼出板块目录；当日热度优先使用
  // 板块日线中对应交易日的涨幅，历史数据链路仍然成立。kind 未知时不参与行业
  // 分散统计，但不影响题材热度排序。
  if (!result.boards.size) {
    for (const boards of result.members.values()) {
      for (const b of boards) {
        if (!result.boards.has(b.code)) result.boards.set(b.code, {
          code: b.code, name: b.name, kind: 'unknown', pct: null, fund: null,
          up: null, down: null, leader: '',
        });
      }
    }
  }

  // 3) 命中板块的日线（决定能不能做历史回算）
  const needBk = new Set();
  for (const boards of result.members.values()) for (const b of boards) needBk.add(b.code);
  const stale = [];
  for (const bk of needBk) {
    const h = cache.hist[bk];
    if (!h || !h.at || now - new Date(h.at).getTime() > TTL_HIST) stale.push(bk);
  }
  if (stale.length) {
    log('  题材：补抓 ' + stale.length + ' 个板块日线（缓存已有 ' + Object.keys(cache.hist).length + '）');
    await runPool(stale, o.concurrency || 6, 60, async function (bk) {
      const days = await fetchBoardHist(bk, o.histLen || 90);
      if (Object.keys(days).length) cache.hist[bk] = { at: new Date().toISOString(), days: days };
    });
    saveCache(cache);
  }
  for (const bk of Object.keys(cache.hist || {})) result.hist.set(bk, cache.hist[bk].days || {});
  for (const b of result.boards.values()) { if (result.hist.has(b.code)) result.histOk++; else result.histMiss++; }

  // 本项目已有的财联社市场快照是可靠的本地/云端回退：它只覆盖领涨主题，
  // 因此只给能匹配到「领涨主题」的股票题材分，不把未知题材当作热门题材。
  if (result.histOk === 0 && ((result.members.size > 0) || (codes || []).length > 0)) {
    const market = readJson(path.join(collect.DATA_DIR, 'market.json'));
    const card = market && market.card;
    const research = readJson(path.join(collect.DATA_DIR, 'research.json')) || {};
    const researchStocks = research.stocks || {};
    const top = new Map();
    for (const t of (card && card.themes) || []) top.set(String(t.name), Number(t.avgPct));
    // market.json 的主题列表可能是上一轮缓存；缺失时用 research.json 中出现频率最高的
    // 概念作为「题材存在性」回退，但热度仍按中性，不把静态出现频率冒充实时涨幅。
    if (!top.size) {
      const freq = new Map();
      for (const rec of Object.values(researchStocks)) {
        for (const name of (rec && rec.concepts) || []) freq.set(name, (freq.get(name) || 0) + 1);
      }
      Array.from(freq.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 20).forEach(function (x) { top.set(x[0], null); });
    }
    const concepts = (market && market.concepts) || {};
    let fallbackCodes = 0;
    for (const code of codes || []) {
      const rec = concepts[code] || researchStocks[code];
      if (!rec) continue;
      const list = (rec.concepts || []).concat(rec.industry ? [rec.industry] : []);
      const boards = [];
      for (const name of list) {
        if (!top.has(name)) continue;
        const bc = 'CLS:' + encodeURIComponent(name);
        if (!result.boards.has(bc)) result.boards.set(bc, {
          code: bc, name: name, kind: 'unknown', pct: top.get(name), fund: null,
          up: null, down: null, leader: '',
        });
        boards.push({ code: bc, name: name });
      }
      if (boards.length) { result.members.set(code, boards); fallbackCodes++; }
    }
    if (fallbackCodes) {
      result.source = 'cls-market-fallback';
      result.fallback = true;
    }
  }

  result.ok = result.boards.size > 0 && (result.histOk > 0 || result.fallback);
  return result;
}

/** 取某一板块在某天的涨幅%（实时榜优先，缺失回落到日线）。 */
function boardPct(theme, bk, day) {
  if (!theme) return null;
  const h = theme.hist.get(bk);
  if (h && h[day] !== undefined && h[day] !== null) return h[day];
  const b = theme.boards.get(bk);
  if (b && b.pct !== null && b.pct !== undefined) return b.pct;
  return null;
}

/** 板块近 n 个交易日累计涨幅%（用日线序列，历史可用）。 */
function boardPctRange(theme, bk, day, n) {
  if (!theme) return null;
  const h = theme.hist.get(bk);
  if (!h) return null;
  const days = Object.keys(h).filter(function (d) { return d <= day; }).sort();
  if (!days.length) return null;
  const tail = days.slice(-n);
  let acc = 1;
  for (const d of tail) acc *= 1 + h[d] / 100;
  return (acc - 1) * 100;
}

module.exports = {
  loadTheme: loadTheme,
  fetchBoardList: fetchBoardList,
  fetchBoardHist: fetchBoardHist,
  fetchStockBoards: fetchStockBoards,
  boardPct: boardPct,
  boardPctRange: boardPctRange,
  CACHE_FILE: CACHE_FILE,
};
