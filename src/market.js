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
const CACHE_VERSION = 5;
const CONCEPT_TTL_MS = 7 * 24 * 3600 * 1000; // 个股行业/概念变化很慢，缓存 7 天
const GAINER_SAMPLE = 60; // 用涨幅榜前 N 只聚合领涨行业/主题
const FUND_SAMPLE = 40;   // 额外取主力资金榜前 N 只的题材，让「明日看点」的板块样本更宽
const THEME_MIN = 5;      // 板块至少这么多只成分股才参与动能排名
const PICK_MAX = 12;      // 明日看点个股数量上限
const PICK_PER_THEME = 3; // 同一题材最多入选几只，避免整张名单押注单一板块
const LIMIT_MAX = 4;      // 涨停股在名单里的上限（收盘价买不到，只作情绪参考）
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

/**
 * 明日看点：完全由「今日全市场快照 + 个股题材资料」推导，属于动量观察名单，不是预测。
 *   板块动能分 = 平均涨幅(满分40) + 上涨占比(25) + 强势股(涨幅≥5%)占比(20) + 主力净流入(15)
 *   个股打分   = 涨幅(≤10% 计 2 分/1%) + 主力净流入(≤10 亿计 1.5 分/亿) + 属于热门板块 +15
 * 题材来自财联社公司资料；coverage 会写明本轮有多少只个股有题材资料，方便判断样本边界。
 */
function buildOutlook(snap, concepts) {
  const round2 = function (v) { return Math.round(v * 100) / 100; };
  const agg = new Map();
  const add = function (name, x) {
    if (!name) return;
    if (!agg.has(name)) agg.set(name, { name: name, n: 0, sum: 0, up: 0, strong: 0, limitUp: 0, fund: 0, members: [] });
    const a = agg.get(name);
    a.n++;
    a.sum += x.pct;
    if (x.pct > 0) a.up++;
    if (x.pct >= 5) a.strong++;
    if (x.pct >= 9.8) a.limitUp++;
    a.fund += x.fund;
    a.members.push({ code: x.code, name: x.name, pct: x.pct, fund: x.fund });
  };
  let coverage = 0;
  let coveredUp = 0;
  for (const x of snap) {
    const c = concepts[x.code];
    if (!c) continue;
    coverage++;
    if (x.pct > 0) coveredUp++;
    const list = (c.concepts || []).concat(c.industry ? [c.industry] : []);
    for (const t of list) add(t, x);
  }
  const sectors = Array.from(agg.values()).filter(function (a) { return a.n >= THEME_MIN; }).map(function (a) {
    const avgPct = a.sum / a.n;
    const upRatio = a.up / a.n;
    const strongRatio = a.strong / a.n;
    const fundYi = a.fund / 1e8;
    const score = Math.min(Math.max(avgPct, 0), 10) / 10 * 40 + upRatio * 25 +
      Math.min(strongRatio / 0.3, 1) * 20 + Math.min(Math.max(fundYi, 0), 5) / 5 * 15;
    const stocks = a.members.slice().sort(function (u, v) { return v.pct - u.pct; }).slice(0, 12).map(function (u) {
      return { code: u.code, name: u.name, pct: round2(u.pct), fundYi: round2(u.fund / 1e8) };
    });
    return { name: a.name, n: a.n, avgPct: round2(avgPct), upPct: Math.round(upRatio * 100), strong: a.strong, limitUp: a.limitUp, fundYi: round2(fundYi), score: Math.round(score), stocks: stocks };
  }).sort(function (a, b) { return b.score - a.score; });

  const topNames = new Set(sectors.slice(0, 6).map(function (s) { return s.name; }));
  const themeOf = function (code) {
    const c = concepts[code];
    if (!c) return '';
    const list = (c.concepts || []).concat(c.industry ? [c.industry] : []);
    for (const t of list) if (topNames.has(t)) return t;
    return '';
  };
  const eligible = snap.filter(function (x) {
    if (!/^(sh|sz)\d{6}$/.test(x.code)) return false;
    if (/^[NC]/.test(x.name) || /ST|退/.test(x.name)) return false;
    if (!(x.pct > 0) || x.pct >= 20.5) return false;
    if (!(x.cap >= 5e9)) return false; // 总市值 ≥ 50 亿，避开微盘
    if (!(x.tr >= 2 && x.tr <= 30)) return false; // 有量但不要换手过度
    if (x.status && /SUSP|STOPT|DELIST/.test(x.status)) return false;
    return true;
  }).map(function (x) {
    const th = themeOf(x.code);
    return {
      code: x.code,
      name: x.name,
      pct: round2(x.pct),
      tr: round2(x.tr),
      fundYi: round2(x.fund / 1e8),
      theme: th,
      limitUp: x.pct >= 9.8,
      score: Math.min(x.pct, 10) * 2 + Math.min(Math.max(x.fund / 1e8, 0), 10) * 1.5 + (th ? 15 : 0),
    };
  }).sort(function (a, b) { return b.score - a.score; });

  // 选股分三步：① 未涨停的按分数取（明日可正常跟踪）② 涨停股最多 LIMIT_MAX 只作为情绪龙头
  // ③ 仍不足 PICK_MAX 只时放宽「同题材最多 3 只」的限制补满。
  // 涨停股收盘价买不到，所以不让它占满整张名单。
  const picked = [];
  const seen = new Set();
  const perTheme = {};
  const push = function (p) {
    seen.add(p.code);
    const key = p.theme || '__other';
    perTheme[key] = (perTheme[key] || 0) + 1;
    picked.push(p);
  };
  for (const p of eligible) {
    if (picked.length >= PICK_MAX - LIMIT_MAX) break;
    if (p.limitUp || seen.has(p.code)) continue;
    if ((perTheme[p.theme || '__other'] || 0) >= PICK_PER_THEME) continue;
    push(p);
  }
  let limitTaken = 0;
  for (const p of eligible) {
    if (limitTaken >= LIMIT_MAX || picked.length >= PICK_MAX) break;
    if (!p.limitUp || seen.has(p.code)) continue;
    if ((perTheme[p.theme || '__other'] || 0) >= PICK_PER_THEME) continue;
    push(p);
    limitTaken++;
  }
  for (const p of eligible) {
    if (picked.length >= PICK_MAX) break;
    if (seen.has(p.code)) continue;
    push(p);
  }
  picked.sort(function (a, b) { return b.score - a.score; });

  const up = snap.filter(function (x) { return x.pct > 0; }).length;
  const down = snap.filter(function (x) { return x.pct < 0; }).length;
  const ratio = up / Math.max(1, up + down);
  const tone = ratio >= 0.55 ? '偏强' : ratio >= 0.45 ? '中性偏强' : ratio >= 0.3 ? '中性偏弱' : '偏弱';
  return {
    tone: tone,
    upRatio: Math.round(ratio * 100),
    coverage: coverage,
    coveredUpPct: Math.round(coveredUp / Math.max(1, coverage) * 100),
    minN: THEME_MIN,
    sectors: sectors.slice(0, 6),
    picks: picked,
  };
}
function rankThemes(gainers, concepts) {
  const byConcept = new Map();
  const byIndustry = new Map();
  const push = function (map, key, item) {
    if (!key) return;
    if (!map.has(key)) map.set(key, { name: key, pctSum: 0, n: 0, best: null, members: [] });
    const agg = map.get(key);
    agg.pctSum += item.pct;
    agg.n++;
    if (!agg.best || item.pct > agg.best.pct) agg.best = item;
    agg.members.push({ code: item.code, name: item.name, pct: item.pct });
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
        // 成分股明细用于页面上「点击板块展开」的列表
        const stocks = x.members.slice().sort(function (a, b) { return b.pct - a.pct; }).slice(0, 12).map(function (m) {
          return { code: m.code, name: m.name, pct: Math.round(m.pct * 100) / 100 };
        });
        return {
          name: x.name,
          n: x.n,
          avgPct: Math.round((x.pctSum / x.n) * 100) / 100,
          best: x.best ? { name: x.best.name, pct: Math.round(x.best.pct * 100) / 100 } : null,
          stocks: stocks,
        };
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
    const conceptCodes = gainers.map(function (x) { return x.code; });
    const seenCodes = new Set(conceptCodes);
    for (const x of snap.slice().sort(function (a, b) { return b.fund - a.fund; }).slice(0, FUND_SAMPLE)) {
      if (!seenCodes.has(x.code)) { seenCodes.add(x.code); conceptCodes.push(x.code); }
    }
    // 调研缓存里已有的个股资料是现成的（命中缓存，不新增请求），一并纳入题材样本。
    // 否则板块统计只覆盖「今日涨幅/资金榜前列」，上涨占比会恒等于 100%，没有参考价值。
    const studied = research.loadCache().stocks || {};
    for (const code of Object.keys(studied)) {
      const rec = studied[code];
      if (!rec || rec.errorOnly) continue;
      if (!seenCodes.has(code)) { seenCodes.add(code); conceptCodes.push(code); }
    }
    const concepts = await fetchConcepts(conceptCodes, cache);
    const ranked = rankThemes(gainers, concepts);
    const outlook = buildOutlook(snap, concepts);

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
      outlook: outlook,
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
