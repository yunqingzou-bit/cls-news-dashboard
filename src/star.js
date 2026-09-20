'use strict';
/**
 * 明星看点：每天晚上 20:00（上海时间）重算一次，从「当天看板涉及的股票」里挑 3 只，供次日关注。
 *
 * 与 card.outlook（全市场动量名单）的区别：
 *   - outlook 只看当天全市场快照（涨幅 / 资金 / 题材），不需要新闻；
 *   - 明星看点要求「有栏目新闻催化」+「技术面站得住」+「基本面不拖后腿」，
 *     输入是新闻行（已带股票关联）、技术面缓存与调研缓存三者取交集。
 *
 * 打分分五块：趋势结构 / 位置与动能 / 量能 / 基本面 / 题材与催化；
 * 另有追高惩罚：当日涨停、5 日涨幅过大、一年区间位置过高、KDJ 极超买、量比过大都会扣分。
 *
 * 关键位口径（页面上「低吸 / 止损 / 目标」就是这几个数）：
 *   低吸位 = MA5
 *   止损位 = 技术面结论里的「失效位」，取不到则用 MA20
 *   第一目标 = 现价 x 1.08
 *   第二目标 = max(现价 x 1.15, 现价 1.15 倍之上最近的 MA120 / MA250 / 52 周高点)，上限现价 x 1.35
 * 这些是规则推导的参考位，不是预测，也不构成投资建议。
 */
const fs = require('node:fs');
const path = require('node:path');
const collectMod = require('./collect.js');

const FILE = path.join(collectMod.DATA_DIR, 'stars.json');
const VERSION = 1;
const LIMIT = 3;          // 明星看点只出 3 只
const STAR_HOUR = 20;     // 每天 20:00 之后重算
const HISTORY_DAYS = 60;  // 留档最近 60 天
const TZ_OFFSET_MINUTES = 8 * 60;

const HOT_KEYWORDS = ['机器人', 'AI算力', '算力', '光通信', '光模块', '半导体', '芯片', 'PCB', 'MLCC', '液冷', '存储器', '先进封装', 'CPO', '数据中心', '人工智能'];
const BAD_ANN = ['减持', '立案', '问询', '异常波动', '风险提示', '质押', '违规', '处罚', '退市', '终止', '商誉减值', '预亏'];

function pad(n) { return String(n).padStart(2, '0'); }

/** 上海时间的日期键 YYYY-MM-DD。 */
function shanghaiDateKey(epochMs) {
  const d = new Date((epochMs === undefined ? Date.now() : Number(epochMs)) + TZ_OFFSET_MINUTES * 60000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

/** 上海时间 HH:mm。 */
function shanghaiHm(epochMs) {
  const d = new Date((epochMs === undefined ? Date.now() : Number(epochMs)) + TZ_OFFSET_MINUTES * 60000);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

/** 今天（上海）20:00 对应的时间戳。 */
function starMoment(epochMs) {
  const t = epochMs === undefined ? Date.now() : Number(epochMs);
  const d = new Date(t + TZ_OFFSET_MINUTES * 60000);
  d.setUTCHours(STAR_HOUR, 0, 0, 0);
  return d.getTime() - TZ_OFFSET_MINUTES * 60000;
}

function round2(v) { return Math.round(Number(v) * 100) / 100; }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function load() {
  const j = readJson(FILE);
  if (!j || j.version !== VERSION) return { version: VERSION, updatedAt: null, date: null, computedAtMs: null, picks: [], history: {} };
  j.history = j.history || {};
  j.picks = j.picks || [];
  return j;
}

function save(store) {
  const keys = Object.keys(store.history || {}).sort();
  while (keys.length > HISTORY_DAYS) delete store.history[keys.shift()];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 1), 'utf8');
}

/** 技术面结论里的「失效位」，例如「倾向：偏多（日线，主导情景 50%）｜ 失效位 37.38」。 */
function failLevel(conclusion) {
  const m = /失效位\s*([0-9]+(\.[0-9]+)?)/.exec(String(conclusion || ''));
  return m ? Number(m[1]) : null;
}

/** 单只打分：返回 { score, plus, minus, hot, theme, bias20, j }。 */
function scoreOne(metrics, research, hotSectors) {
  const plus = [];
  const minus = [];
  let s = 0;
  const close = Number(metrics.close);
  const ma5 = Number(metrics.ma5);
  const ma10 = Number(metrics.ma10);
  const ma20 = Number(metrics.ma20);
  const slope20 = Number(metrics.slope20);
  const rsi = Number(metrics.rsi14);
  const vol = Number(metrics.volRatio);
  const pos = Number(metrics.rangePos);
  const j = metrics.kdj ? Number(metrics.kdj.j) : null;
  const hist = metrics.macd ? Number(metrics.macd.hist) : null;
  const bias20 = ma20 ? ((close - ma20) / ma20) * 100 : 0;

  if (metrics.structure === 'up') { s += 12; plus.push('日线结构为上升'); }
  const stack = close > ma5 && ma5 > ma10 && ma10 > ma20;
  if (stack) { s += 15; plus.push('5>10>20 日均线多头排列'); }
  if (slope20 > 0) { s += 8; if (slope20 > 2) s += 4; } else { minus.push('20 日均线仍向下'); }

  if (bias20 >= 0 && bias20 <= 8) { s += 10; plus.push('距 20 日线 ' + round2(bias20) + '%，位置健康'); }
  else if (bias20 > 8 && bias20 <= 15) { s += 3; minus.push('距 20 日线 ' + round2(bias20) + '%，偏离偏大'); }
  else if (bias20 > 15) { s -= 8; minus.push('距 20 日线 ' + round2(bias20) + '%，短线过热'); }
  else { s -= 4; minus.push('仍在 20 日均线下方'); }

  if (rsi >= 55 && rsi <= 70) { s += 10; plus.push('RSI14 ' + rsi + '，强势但未超买'); }
  else if (rsi > 70 && rsi <= 75) { s += 4; minus.push('RSI14 ' + rsi + ' 偏高'); }
  else if (rsi > 75) { s -= 8; minus.push('RSI14 ' + rsi + ' 超买'); }
  else if (rsi >= 48) { s += 3; }

  if (j !== null) {
    if (j < 90) s += 6;
    else if (j <= 100) { s += 2; minus.push('KDJ-J ' + j + ' 偏高'); }
    else { s -= 6; minus.push('KDJ-J ' + j + ' 极超买'); }
  }

  if (vol >= 1 && vol <= 2) { s += 8; plus.push('量比 ' + round2(vol) + '，温和放量'); }
  else if ((vol >= 0.8 && vol < 1) || (vol > 2 && vol <= 3)) { s += 3; }
  else if (vol > 3.5) { s -= 5; minus.push('量比 ' + round2(vol) + '，成交过激'); }
  else { s -= 2; }

  if (hist !== null && hist > 0) {
    s += 6;
    if (metrics.macd.turning === '走强') { s += 4; plus.push('MACD 零轴上方走强'); }
  }
  if (metrics.macd && metrics.macd.cross === '金叉') s += 2;

  if (pos < 0.8) s += 6;
  else if (pos >= 0.9) { s -= 6; minus.push('处于近一年高位（位置 ' + pos + '）'); }

  if (Number(metrics.chgPct) >= 9.5) { s -= 6; minus.push('当日涨停或接近涨停，收盘价难买到'); }
  const chg5 = research && research.momentum ? Number(research.momentum.change5d) : null;
  if (chg5 !== null && Number.isFinite(chg5)) {
    if (chg5 > 25) { s -= 6; minus.push('近 5 日已涨 ' + chg5 + '%，追高风险大'); }
    else if (chg5 > 15) s -= 2;
    else if (chg5 > 0 && chg5 <= 12) s += 4;
  }

  const profitYoy = research && research.financial ? Number(research.financial.profitYoy) : null;
  const revYoy = research && research.financial ? Number(research.financial.revenueYoy) : null;
  if (profitYoy !== null && Number.isFinite(profitYoy)) {
    if (profitYoy > 0) { s += 4; plus.push('利润同比 ' + profitYoy + '%'); }
    else { s -= 3; minus.push('利润同比 ' + profitYoy + '%'); }
  }
  if (revYoy !== null && Number.isFinite(revYoy) && revYoy > 0) s += 2;

  const concepts = (research && research.concepts) || [];
  const industry = (research && research.industry) || '';
  let theme = '';
  for (const t of hotSectors) {
    if (concepts.indexOf(t) >= 0 || industry.indexOf(t) >= 0) { theme = t; break; }
  }
  const hotHit = HOT_KEYWORDS.some(function (k) {
    return concepts.some(function (c) { return c.indexOf(k) >= 0; }) || industry.indexOf(k) >= 0;
  });
  if (hotHit) { s += 8; plus.push('属于 AI / 半导体 / 机器人等主线'); }

  const anns = (research && research.announcements) || [];
  const bad = anns.filter(function (a) {
    return BAD_ANN.some(function (w) { return String(a.title).indexOf(w) >= 0; });
  });
  if (bad.length) { s -= 10; minus.push('近期公告含风险事项：' + String(bad[0].title).slice(0, 24)); }

  return { score: s, plus: plus, minus: minus, hot: hotHit, theme: theme, bias20: bias20, j: j };
}

/** 从新闻行里挑候选（必须有技术面数据）。 */
function candidates(rows, opts) {
  opts = opts || {};
  const tech = opts.technical || {};
  const research = opts.research || {};
  const hotSectors = opts.hotSectors || [];
  const byStock = new Map();
  for (const r of rows || []) {
    const code = r && r.stockCode;
    if (!code) continue;
    if (!byStock.has(code)) byStock.set(code, []);
    byStock.get(code).push(r);
  }
  const out = [];
  byStock.forEach(function (list, code) {
    const t = tech[code];
    if (!t || !t.metrics) return;
    const m = t.metrics;
    if (m.kind !== 'daily' || !m.close || !m.ma20 || !m.ma5) return;
    const rs = research[code] || null;
    const sorted = list.slice().sort(function (a, b) { return b.ctime - a.ctime; });
    const latest = sorted[0];
    const sc = scoreOne(m, rs, hotSectors);
    const stack = Number(m.close) > Number(m.ma5) && Number(m.ma5) > Number(m.ma10) && Number(m.ma10) > Number(m.ma20);
    const val = rs && rs.valuation ? rs.valuation : {};
    const pe = val.ttmPe === undefined || val.ttmPe === null ? null : Number(val.ttmPe);
    const pb = val.pb === undefined || val.pb === null ? null : Number(val.pb);
    const cap = val.marketCapYi === undefined || val.marketCapYi === null ? null : Number(val.marketCapYi);
    const anns = (rs && rs.announcements) || [];
    const bad = anns.some(function (a) {
      return BAD_ANN.some(function (w) { return String(a.title).indexOf(w) >= 0; });
    });
    out.push({
      code: code,
      name: t.name || latest.stockName || '',
      score: sc.score + Math.min(sorted.length, 4),
      metrics: m,
      research: rs,
      newsCount: sorted.length,
      theme: sc.theme || (rs && rs.concepts && rs.concepts.length ? rs.concepts.slice(0, 2).join('/') : ((rs && rs.industry) || '')),
      plus: sc.plus,
      minus: sc.minus,
      bias20: sc.bias20,
      latestTime: latest.time,
      catalogs: Array.from(new Set(sorted.map(function (r) { return r.prefix; }).filter(Boolean))).slice(0, 5),
      catalysts: sorted.slice(0, 2).map(function (r) {
        return { prefix: r.prefix || '', time: r.time || '', title: String(r.title || '').slice(0, 60) };
      }),
      fail: failLevel(latest.technicalConclusion),
      flags: {
        hot: sc.hot === true,
        bull: stack,
        above20: Number(m.close) > Number(m.ma20),
        notLimit: Number(m.chgPct) < 9.5,
        noBad: !bad,
        valOk: pe === null || (pe > 0 && pe <= 120 && (pb === null || pb <= 15)),
        capOk: cap === null || cap >= 100,
        capOk50: cap === null || cap >= 50,
      },
    });
  });
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}

/** 把候选整理成页面要用的 3 条（含低吸 / 止损 / 目标位与风险收益比）。 */
function toPicks(cands, limit) {
  const picks = [];
  for (const c of cands.slice(0, limit || LIMIT)) {
    const m = c.metrics;
    const close = Number(m.close);
    const ma5 = Number(m.ma5);
    const ma20 = Number(m.ma20);
    let entry = round2(ma5);
    let stop = c.fail !== null && c.fail !== undefined ? round2(c.fail) : round2(ma20);
    if (!(entry > stop)) { entry = round2(close); stop = round2(Math.min(ma20, close * 0.97)); }
    const t1 = round2(close * 1.08);
    const overhead = [Number(m.ma120), Number(m.ma250), Number(m.high52)].filter(function (v) {
      return Number.isFinite(v) && v > close * 1.15;
    });
    const t2base = Math.max(close * 1.15, overhead.length ? Math.min.apply(null, overhead) : close * 1.15);
    const t2 = round2(Math.min(t2base, close * 1.35));
    const riskPct = round2((entry - stop) / entry * 100);
    const rr = stop < entry ? round2((t1 - entry) / (entry - stop)) : null;
    const val = c.research && c.research.valuation ? c.research.valuation : {};
    const fin = c.research && c.research.financial ? c.research.financial : {};
    picks.push({
      code: c.code,
      name: c.name,
      price: round2(close),
      chgPct: round2(m.chgPct),
      day: m.day || '',
      score: c.score,
      theme: c.theme,
      entry: entry,
      stop: stop,
      target1: t1,
      target2: t2,
      riskPct: riskPct,
      rr: rr,
      ma5: round2(ma5),
      ma10: round2(Number(m.ma10)),
      ma20: round2(ma20),
      bias20: round2(c.bias20),
      rsi14: Number(m.rsi14),
      volRatio: round2(Number(m.volRatio)),
      rangePos: Number(m.rangePos),
      pe: val.ttmPe === undefined ? null : val.ttmPe,
      pb: val.pb === undefined ? null : val.pb,
      mcapYi: val.marketCapYi === undefined ? null : val.marketCapYi,
      profitYoy: fin.profitYoy === undefined ? null : fin.profitYoy,
      revYoy: fin.revenueYoy === undefined ? null : fin.revenueYoy,
      newsCount: c.newsCount,
      catalogs: c.catalogs,
      catalysts: c.catalysts,
      plus: c.plus.slice(0, 4),
      minus: c.minus.slice(0, 3),
      url: 'https://gu.qq.com/' + c.code,
    });
  }
  return picks;
}

/**
 * 分层挑选：先严后宽，尽量都落在「主线 + 多头排列 + 市值≥100亿 + 估值不过分 + 无风险公告」的第一档。
 * 强市里第一档通常就够 3 只；弱市/特殊行情下逐档放宽，保证页面始终有 3 只可看。
 */
const TIERS = [
  { label: '主线+多头排列+市值≥100亿+估值合理+无风险公告', test: function (c) {
    return c.flags.hot && c.flags.bull && c.flags.above20 && c.flags.notLimit && c.flags.noBad && c.flags.capOk && c.flags.valOk; } },
  { label: '放宽：不要求 5>10>20 排列（仍需站上 20 日线）', test: function (c) {
    return c.flags.hot && c.flags.above20 && c.flags.notLimit && c.flags.noBad && c.flags.capOk && c.flags.valOk; } },
  { label: '放宽：市值门槛降到 50 亿', test: function (c) {
    return c.flags.hot && c.flags.above20 && c.flags.notLimit && c.flags.noBad && c.flags.capOk50 && c.flags.valOk; } },
  { label: '放宽：不再要求处于当日主线', test: function (c) {
    return c.flags.above20 && c.flags.notLimit && c.flags.noBad && c.flags.capOk50; } },
  { label: '兜底：只要求站上 20 日线且非涨停、无风险公告', test: function (c) {
    return c.flags.above20 && c.flags.notLimit && c.flags.noBad; } },
];

function choose(cands, limit) {
  const n = limit || LIMIT;
  const picked = [];
  const seen = new Set();
  for (let t = 0; t < TIERS.length; t++) {
    for (const c of cands) {
      if (seen.has(c.code)) continue;
      if (!TIERS[t].test(c)) continue;
      seen.add(c.code);
      picked.push(c);
      if (picked.length >= n) return { picks: picked, tier: t + 1, tierLabel: TIERS[t].label };
    }
  }
  return { picks: picked, tier: TIERS.length, tierLabel: TIERS[TIERS.length - 1].label };
}

/**
 * 重算（或复用）明星看点。
 * opts: { rows, technical, research, hotSectors, force, now }
 * 每天 20:00 之后第一次调用会重算并写 data/stars.json；20:00 之前或当天已算过则沿用上一版。
 */
function run(rows, opts) {
  opts = opts || {};
  const now = opts.now === undefined ? Date.now() : Number(opts.now);
  const today = shanghaiDateKey(now);
  const moment = starMoment(now);
  const store = load();
  // 20:00 之后重算；另外「一份都没有」时（刚部署、换了机器）也先算一次，避免页面空着
  const due = opts.force === true || (now >= moment && store.date !== today) || !(store.picks && store.picks.length);
  const hasInput = Array.isArray(rows) && rows.length > 0 && opts.technical && Object.keys(opts.technical).length > 0;
  if (due && hasInput) {
    const chosen = choose(candidates(rows, opts), LIMIT);
    const picks = toPicks(chosen.picks, LIMIT);
    if (picks.length) {
      store.version = VERSION;
      store.date = today;
      store.computedAtMs = now;
      store.updatedAt = new Date(now).toISOString();
      store.picks = picks;
      store.tier = chosen.tier;
      store.tierLabel = chosen.tierLabel;
      store.history[today] = {
        at: store.updatedAt,
        hm: shanghaiHm(now),
        picks: picks.map(function (p) {
          return { code: p.code, name: p.name, price: p.price, score: p.score, entry: p.entry, stop: p.stop, target1: p.target1 };
        }),
      };
      save(store);
      return { date: store.date, updatedAt: store.updatedAt, hm: shanghaiHm(now), picks: picks, tier: chosen.tier, tierLabel: chosen.tierLabel, refreshed: true, historyDays: Object.keys(store.history).length };
    }
  }
  return {
    date: store.date,
    updatedAt: store.updatedAt,
    hm: store.computedAtMs ? shanghaiHm(store.computedAtMs) : '',
    picks: store.picks || [],
    tier: store.tier || null,
    tierLabel: store.tierLabel || '',
    refreshed: false,
    historyDays: Object.keys(store.history || {}).length,
  };
}

module.exports = {
  run: run,
  candidates: candidates,
  toPicks: toPicks,
  shanghaiDateKey: shanghaiDateKey,
  shanghaiHm: shanghaiHm,
  starMoment: starMoment,
  FILE: FILE,
  LIMIT: LIMIT,
};
