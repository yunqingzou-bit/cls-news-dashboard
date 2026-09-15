'use strict';
/**
 * 当天行情卡片：市场涨跌统计 + 主要指数 + 领涨行业/主题 + 最热门股票。
 *
 * 数据来源（都基于全市场，不是抽样）：
 *   1) 财联社股票列表接口一次拉全市场 5000+ 只快照（现价 / 涨跌幅 / 换手率 / 主力净流入 / 市值）
 *   2) 腾讯行情接口取主要指数（上证 / 深证 / 创业板 / 科创50）
 *   3) 涨幅榜前列个股的行业与概念（优先用调研缓存，缺失的再向财联社公司资料取）聚合出领涨行业与主题
 *
 * 结果缓存到 data/market.json，默认 15 分钟内不重复抓取。
 */
const fs = require('node:fs');
const path = require('node:path');
const cls = require('./cls.js');
const collectMod = require('./collect.js');
const research = require('./research.js');

const CACHE_FILE = path.join(collectMod.DATA_DIR, 'market.json');
const TTL_MS = 15 * 60 * 1000;
// 卡片字段结构变化时递增：版本不一致就重新抓取，避免旧结构缓存渲染出缺字段的卡片
const CACHE_VERSION = 2;
const CONCEPT_TTL_MS = 7 * 24 * 3600 * 1000; // 个股行业/概念变化很慢，缓存 7 天
const GAINER_SAMPLE = 60; // 用涨幅榜前 N 只聚合领涨行业/主题
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

const INDEXES = [
  { code: 'sh000001', name: '上证指数' },
  { code: 'sz399001', name: '深证成指' },
  { code: 'sz399006', name: '创业板指' },
  { code: 'sh000688', name: '科创50' },
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function loadCache() {
  return readJson(CACHE_FILE) || { version: CACHE_VERSION, updatedAt: null, concepts: {} };
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
}

/** 全市场快照：一次请求拿到 5000+ 只的行情字段。 */
async function fetchSnapshot() {
  const body = await cls.xquote('/web_quote/web_stock/stock_list', {
    types: 'last_px,change,tr,main_fund_diff,cmc,trade_status',
    market: 'all',
    way: 'change',
    page: 200,
    rever: 1,
  });
  const list = (body && body.data && body.data.data) || [];
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const code = String(x.secu_code || '');
    if (!/^(sh|sz)\d{6}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    const px = Number(x.last_px);
    if (!Number.isFinite(px) || px <= 0) continue;
    out.push({
      code: code,
      name: String(x.secu_name || ''),
      px: px,
      pct: Number(x.change) * 100,
      tr: Number(x.tr) * 100,
      fund: Number(x.main_fund_diff) || 0,
      cap: Number(x.cmc) || 0,
      status: String(x.trade_status || ''),
    });
  }
  return out;
}

/** 主要指数行情（腾讯接口，字段 3=现价 4=昨收 31=涨跌 32=涨跌幅%）。 */
async function fetchIndexes() {
  const url = 'https://qt.gtimg.cn/q=' + INDEXES.map(function (x) { return x.code; }).join(',');
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 15000);
  const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' } });
  clearTimeout(timer);
  if (!res.ok) throw new Error('指数接口 HTTP ' + res.status);
  const txt = Buffer.from(await res.arrayBuffer()).toString('latin1');
  const map = {};
  for (const ln of txt.split(';')) {
    const i = ln.indexOf('=');
    if (i < 0) continue;
    const code = ln.slice(0, i).replace('v_', '').trim();
    const p = ln.slice(i + 1).split('~');
    if (p.length < 40) continue;
    map[code] = { px: Number(p[3]), prev: Number(p[4]), chg: Number(p[31]), pct: Number(p[32]) };
  }
  return INDEXES.map(function (x) {
    const q = map[x.code] || {};
    return { code: x.code, name: x.name, px: q.px, pct: q.pct, chg: q.chg };
  }).filter(function (x) { return Number.isFinite(x.px); });
}

/** 个股行业/概念：先用调研缓存，再查公司资料（结果按 7 天缓存）。 */
async function fetchConcepts(codes, cache) {
  const out = {};
  const researchCache = research.loadCache();
  const missing = [];
  const now = Date.now();
  for (const code of codes) {
    const hit = cache.concepts[code];
    if (hit && now - new Date(hit.at).getTime() < CONCEPT_TTL_MS) { out[code] = hit; continue; }
    const rec = researchCache.stocks[code];
    if (rec && !rec.errorOnly) {
      const entry = { at: new Date().toISOString(), industry: rec.industry || '', concepts: rec.concepts || [] };
      cache.concepts[code] = entry;
      out[code] = entry;
      continue;
    }
    missing.push(code);
  }
  const concurrency = 6;
  let idx = 0;
  const worker = async function () {
    while (idx < missing.length) {
      const code = missing[idx++];
      try {
        const body = await research.fetchCompanyInfo(code);
        const bi = (body && body.basic_info) || {};
        const entry = {
          at: new Date().toISOString(),
          industry: bi.IndustryName || '',
          concepts: String(bi.plate_names || '').split(/[，,、]/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 6),
        };
        cache.concepts[code] = entry;
        out[code] = entry;
      } catch (_) { /* 取不到就不参与统计 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, missing.length)) }, worker));
  return out;
}

/** 按概念/行业聚合涨幅榜前列的个股。 */
function rankThemes(gainers, concepts) {
  const byConcept = new Map();
  const byIndustry = new Map();
  const push = function (map, key, item) {
    if (!key) return;
    if (!map.has(key)) map.set(key, { name: key, pctSum: 0, n: 0, best: null });
    const agg = map.get(key);
    agg.pctSum += item.pct;
    agg.n++;
    if (!agg.best || item.pct > agg.best.pct) agg.best = item;
  };
  for (const g of gainers) {
    const c = concepts[g.code];
    if (!c) continue;
    for (const name of c.concepts || []) push(byConcept, name, g);
    push(byIndustry, c.industry, g);
  }
  const toList = function (map, limit) {
    return Array.from(map.values())
      .filter(function (x) { return x.n >= 1; })
      .sort(function (a, b) { return (b.n - a.n) || (b.pctSum / b.n - a.pctSum / a.n); })
      .slice(0, limit)
      .map(function (x) {
        return { name: x.name, n: x.n, avgPct: Math.round((x.pctSum / x.n) * 100) / 100, best: x.best ? { name: x.best.name, pct: Math.round(x.best.pct * 100) / 100 } : null };
      });
  };
  return { themes: toList(byConcept, 6), industries: toList(byIndustry, 4) };
}

function shanghaiText(d) {
  const t = new Date(d);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
}

/** 生成（或复用缓存）当天行情卡片数据。 */
async function summary(opts) {
  opts = opts || {};
  const cache = loadCache();
  if (!opts.force && cache.version === CACHE_VERSION && cache.updatedAt && Date.now() - new Date(cache.updatedAt).getTime() < TTL_MS && cache.card) {
    return cache.card;
  }
  try {
    const snap = await fetchSnapshot();
    if (!snap.length) throw new Error('全市场快照为空');
    let indexes = [];
    try { indexes = await fetchIndexes(); } catch (_) { indexes = (cache.card && cache.card.indexes) || []; }

    const up = snap.filter(function (x) { return x.pct > 0; }).length;
    const down = snap.filter(function (x) { return x.pct < 0; }).length;
    const flat = snap.filter(function (x) { return x.pct === 0; }).length;
    const limitUp = snap.filter(function (x) { return x.pct >= 9.8; }).length;
    const limitDown = snap.filter(function (x) { return x.pct <= -9.8; }).length;
    const up5 = snap.filter(function (x) { return x.pct >= 5; }).length;
    const down5 = snap.filter(function (x) { return x.pct <= -5; }).length;
    const fundYi = Math.round(snap.reduce(function (a, x) { return a + x.fund; }, 0) / 1e8 * 10) / 10;

    // 可交易个股：剔除新股/次新首日（名称 N/C 开头）、ST 与退市股，以及涨幅超过 20.5% 的异常值（多为新股或口径差异）
    const tradable = snap.filter(function (x) { return !/^[NC]/.test(x.name) && !/ST|退/.test(x.name) && x.pct < 20.5; });
    const brief = function (x) {
      return { code: x.code, name: x.name, pct: Math.round(x.pct * 100) / 100, tr: Math.round(x.tr * 100) / 100, fundYi: Math.round(x.fund / 1e8 * 100) / 100 };
    };
    // 「最热门」用两个精确字段：涨幅榜 + 主力资金净流入榜（不用 市值×换手率 估算成交额，总市值口径会严重高估）
    const byPctDesc = tradable.slice().sort(function (a, b) { return b.pct - a.pct; });
    const hotGain = byPctDesc.slice(0, 6).map(brief);
    const hotFund = snap.slice().sort(function (a, b) { return b.fund - a.fund; }).slice(0, 6).map(brief);

    const gainers = byPctDesc.slice(0, GAINER_SAMPLE);
    const concepts = await fetchConcepts(gainers.map(function (x) { return x.code; }), cache);
    const ranked = rankThemes(gainers, concepts);

    const card = {
      updatedAt: new Date().toISOString(),
      updatedText: shanghaiText(Date.now()),
      total: snap.length,
      indexes: indexes,
      breadth: { up: up, down: down, flat: flat, limitUp: limitUp, limitDown: limitDown, up5: up5, down5: down5, fundYi: fundYi },
      themes: ranked.themes,
      industries: ranked.industries,
      hotGain: hotGain,
      hotFund: hotFund,
      sample: gainers.length,
    };
    cache.updatedAt = card.updatedAt;
    cache.version = CACHE_VERSION;
    cache.card = card;
    saveCache(cache);
    return card;
  } catch (e) {
    // 抓取失败时退回上一张卡片，保证页面还有数据
    if (cache.card) return cache.card;
    throw e;
  }
}

module.exports = { summary: summary, fetchSnapshot: fetchSnapshot, fetchIndexes: fetchIndexes, CACHE_FILE: CACHE_FILE, loadCache: loadCache };
