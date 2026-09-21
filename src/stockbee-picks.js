'use strict';
/**
 * Stockbee 精选：把「某一天全部 4% 突破信号」压缩成 ≤N 只的多因子名单。
 *
 * 为什么要做这一层：原始信号一天几百条（2026-09-21 有 468 条），没有排序维度和
 * 分散约束，实际上不可用。这里按用户要求从四个方面打分后再取前 N：
 *
 *   突破形态 20 = 触发强度45% + 前期基底35% + 收盘位置10% + 失败过滤10%（来自 stockbee 自身打分分量）
 *   走势技术形态 25 = 均线排列8 + 趋势阶段5 + MACD状态4 + RSI14位置4 + 高位结构4
 *   动量大小 25 = 当日涨幅7 + 量能6 + 20日动量6 + 5日动量3 + 距60日高点3
 *   题材热度 20 = 所属板块当日涨幅12（取该股所属板块里最强的一个）+ 该板块近5日涨幅8
 *   市场环境 5 = 上证对 MA20/MA50 的闸门3 + 全市场上涨家数占比2
 *   风险可执行 5 = 止损距离3 + 成交额2 + 收盘涨停扣分
 *
 * 「走势技术形态」衡量的是突破发生之前的趋势结构（均线是否多头排列、MA20/MA60 是否上行、
 * MACD 是否在多方、RSI 是否处在强势但不过热的位置、近期是否还在高位），
 * 与「突破形态」互补：后者看突破当天与基底，前者看中期趋势是否站在同一边。
 *
 * 约束：成交额下限、剔除一字板、同日最大涨停股数、同板块最多 N 只、同行业最多 M 只。
 *
 * 分两段执行：先只用「形态+动量+风险+市场」粗排取前 PRE 只（题材数据缺失也能跑），
 * 再去补这批股票的所属板块/板块日线，加进题材分做最终排序。这样题材取数只针对
 * 几十只候选，而不是全市场 5000 只，成本和失败面都可控。
 */

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function norm(v, lo, hi) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return 0;
  return clamp01((Number(v) - lo) / (hi - lo));
}
function round(x, n) {
  const p = Math.pow(10, n === undefined ? 2 : n);
  return Math.round(x * p) / p;
}

const DEFAULTS = {
  maxPicks: 20,        // 每天最多选出多少只
  preRank: 60,         // 粗排保留多少只进入题材打分
  minAmountYi: 1.5,    // 成交额下限（亿元），避开没有承载力的微盘
  maxRiskPct: 8,       // 止损距离上限（收盘到当日最低）
  maxLimitUp: 3,       // 收盘涨停股最多入几只（收盘价买不到，只作情绪参考）
  perTheme: 3,         // 同一板块最多几只
  perIndustry: 5,      // 同一行业最多几只
  minScore: 70,        // 沿用原信号门槛
};

/** 突破形态分（0-20）：直接用 stockbee 自己的打分分量，避免和总分重复计分。 */
function formScore(row) {
  const p = row.parts || {};
  const trig = norm(p.trigger, 0, 20);
  const setup = norm(p.setup, 0, 25);
  const loc = norm(row.closeLoc, 40, 100);
  const fail = norm(p.fail, 0, 10);
  return 20 * (0.45 * trig + 0.35 * setup + 0.10 * loc + 0.10 * fail);
}

/**
 * 走势技术形态分（0-25）：不看突破当天，看触发之前的趋势结构。
 *   均线排列 8（价格>MA5>MA10>MA20>MA60 满足几条）
 *   趋势阶段 5（站上 MA20、MA20 上行、MA60 上行）
 *   MACD 状态 4（DIF>DEA 且柱体为正）
 *   RSI14 位置 4（55-75 强势区给满分，过热 >85 或走弱 <45 扣分）
 *   高位结构 4（近 20 日从最高收盘回撤越小越好）
 */
function trendScore(row) {
  const stack = row.maStack === null || row.maStack === undefined ? 4 : norm(row.maStack, 0, 4) * 8;
  const stage = ((row.aboveMa20 ? 0.5 : 0) + (row.ma20Up ? 0.25 : 0) + (row.ma60Up ? 0.25 : 0)) * 5;
  const macd = (row.macdOk ? 3 : 0) + norm(row.macdHist, -0.2, 0.3);
  const r = row.rsi14;
  const rsi = r === null || r === undefined ? 1.5
    : r >= 55 && r <= 75 ? 4
      : r >= 45 && r < 55 ? 2.5
        : r > 75 && r <= 85 ? 2.5
          : 1;
  const dd = row.dd20 === null || row.dd20 === undefined ? 0 : clamp01(1 - row.dd20 / 12) * 4;
  return stack + stage + macd + rsi + dd;
}

/** 动量大小分（0-25）：当日涨幅 + 量能 + 20/5 日动量 + 距 60 日高点的位置。 */
function momentumScore(row) {
  const gain = norm(row.dayGain, 4, 11) * 7;
  const vol = norm(Math.max(row.vr1 || 0, row.vr20 || 0), 1, 4) * 6;
  const m20 = norm(row.mom20, -5, 40) * 6;
  const m5 = norm(row.mom5, -5, 20) * 3;
  const near = row.dist60 === null || row.dist60 === undefined ? 0 : clamp01(1 - row.dist60 / 15) * 3;
  return gain + vol + m20 + m5 + near;
}

/** 风险与可执行性分（0-5）。 */
function riskScore(row, o) {
  const r = row.riskPct;
  const risk = r <= 2 ? 3 : r <= 3 ? 2.5 : r <= 4 ? 2 : r <= 6 ? 1.2 : r <= o.maxRiskPct ? 0.6 : 0;
  const amt = row.amountYi >= 5 ? 2 : row.amountYi >= 2 ? 1.5 : row.amountYi >= 1.5 ? 1 : 0.5;
  let s = risk + amt;
  if (row.limitUp) s -= 1; // 收盘涨停：当日收盘价买不到，扣分
  return Math.max(0, Math.min(5, s));
}

/** 市场环境分（0-5）：上证闸门 + 全市场上涨占比。 */
function marketScore(panel, gateScore) {
  const g = norm(gateScore, 0, 5) * 3;
  const ratio = panel && panel.n ? panel.up / Math.max(1, panel.up + panel.down) : null;
  const b = ratio === null ? 1 : norm(ratio, 0.35, 0.8) * 2;
  return g + b;
}

/** 粗排（不含题材）：形态 + 动量 + 市场 + 风险。 */
function preRank(rows, panel, gateScore, o) {
  const out = [];
  for (const row of rows) {
    if (row.score < o.minScore) continue;
    if (row.pattern.indexOf('4%突破') < 0) continue;
    if (row.riskPct > o.maxRiskPct) continue;
    if (row.amountYi < o.minAmountYi) continue;
    if (row.flatBoard) continue;
    const form = formScore(row);
    const trend = trendScore(row);
    const mom = momentumScore(row);
    const risk = riskScore(row, o);
    const mkt = marketScore(panel, gateScore);
    // 题材缺省时按中性给分，等第二阶段拿到板块数据再替换
    const themePart = 20 * 0.5;
    out.push({
      row: row,
      form: form, trend: trend, mom: mom, risk: risk, mkt: mkt, theme: themePart,
      themeKnown: false, bestBoard: null, boardPct: null, board5: null, industry: null,
      pre: form + trend + mom + risk + mkt + themePart,
    });
  }
  out.sort(function (a, b) { return b.pre - a.pre; });
  return out.slice(0, o.preRank);
}

/**
 * 用题材数据补全第二阶段打分。theme 为 null 时保持中性分并标注「题材未知」。
 * themeApi: { boardPct(theme, bk, day), boardPctRange(theme, bk, day, n) }
 */
function applyTheme(cands, theme, themeApi) {
  for (const c of cands) {
    if (!theme || !theme.ok) continue;
    const members = theme.members.get(c.row.code) || [];
    let best = null;
    let first = null;
    for (const b of members) {
      if (!first) first = { code: b.code, name: b.name, pct: null };
      const pct = themeApi.boardPct(theme, b.code, c.row.date);
      if (pct === null || pct === undefined) continue;
      if (!best || pct > best.pct) best = { code: b.code, name: b.name, pct: pct };
    }
    if (!best && first) best = first;
    if (!best) continue;
    const b5 = themeApi.boardPctRange(theme, best.code, c.row.date, 5);
    // 财联社领涨主题回退只有「当日平均涨幅」，没有历史板块K线，
    // 这部分不冒充近5日动量，只按中性半分计，并在 theme.source 中披露。
    const s1 = best.pct === null ? 6 : norm(best.pct, -2, 8) * 12;
    const s2 = b5 === null ? 6 * 0.5 : norm(b5, -5, 15) * 8;
    c.theme = s1 + s2;
    c.themeKnown = true;
    c.bestBoard = best.name;
    c.boardPct = best.pct === null ? null : round(best.pct);
    c.board5 = b5 === null ? null : round(b5, 1);
    const ind = members.filter(function (b) { return !!(theme.boards.get(b.code) && theme.boards.get(b.code).kind === 'industry'); });
    c.industry = ind.length ? ind[0].name : null;
  }
  for (const c of cands) c.total = c.form + c.trend + c.mom + c.theme + c.mkt + c.risk;
  return cands;
}

/** 分散约束下取前 N：同板块 ≤ perTheme、同行业 ≤ perIndustry、涨停股 ≤ maxLimitUp。 */
function selectTop(cands, o) {
  const sorted = cands.slice().sort(function (a, b) { return b.total - a.total; });
  const picked = [];
  const byTheme = {};
  const byIndustry = {};
  let limitUpN = 0;
  const bump = function (c) {
    const tk = c.bestBoard || '__unknown';
    byTheme[tk] = (byTheme[tk] || 0) + 1;
    if (c.industry) byIndustry[c.industry] = (byIndustry[c.industry] || 0) + 1;
    if (c.row.limitUp) limitUpN++;
    picked.push(c);
  };
  const blocked = function (c) {
    const tk = c.bestBoard || '__unknown';
    if ((byTheme[tk] || 0) >= o.perTheme) return true;
    if (c.industry && (byIndustry[c.industry] || 0) >= o.perIndustry) return true;
    if (c.row.limitUp && limitUpN >= o.maxLimitUp) return true;
    return false;
  };
  // 第一轮：按分数取，未涨停优先（收盘可买）；第二轮：涨停股补位；第三轮：放宽分散补满
  for (const c of sorted) {
    if (picked.length >= o.maxPicks) break;
    if (c.row.limitUp) continue;
    if (blocked(c)) continue;
    bump(c);
  }
  for (const c of sorted) {
    if (picked.length >= o.maxPicks) break;
    if (!c.row.limitUp || picked.indexOf(c) >= 0) continue;
    if (blocked(c)) continue;
    bump(c);
  }
  for (const c of sorted) {
    if (picked.length >= o.maxPicks) break;
    if (picked.indexOf(c) >= 0) continue;
    bump(c);
  }
  return picked;
}

/** 组装一行的对外字段。 */
function toPick(c, i) {
  const r = c.row;
  return {
    rank: i + 1,
    date: r.date,
    code: r.code,
    name: r.name,
    total: round(c.total, 1),
    form: round(c.form, 1),
    trend: round(c.trend, 1),
    mom: round(c.mom, 1),
    theme: round(c.theme, 1),
    mkt: round(c.mkt, 1),
    risk: round(c.risk, 1),
    themeKnown: c.themeKnown,
    board: c.bestBoard,
    boardPct: c.boardPct,
    board5: c.board5,
    industry: c.industry,
    pattern: r.pattern,
    dayGain: r.dayGain,
    score: r.score,
    close: r.close,
    low: r.low,
    riskPct: r.riskPct,
    vr20: r.vr20,
    closeLoc: r.closeLoc,
    amountYi: r.amountYi,
    mom20: r.mom20,
    mom5: r.mom5,
    dist60: r.dist60,
    dd20: r.dd20,
    rs20: r.rs20,
    rsi14: r.rsi14,
    maStack: r.maStack,
    aboveMa20: r.aboveMa20,
    macdOk: r.macdOk,
    limitUp: !!r.limitUp,
    cum5: r.cum5 === undefined ? null : r.cum5,
    winRate: r.winRate,
    complete: !!r.complete,
  };
}

module.exports = {
  DEFAULTS: DEFAULTS,
  preRank: preRank,
  applyTheme: applyTheme,
  selectTop: selectTop,
  toPick: toPick,
  formScore: formScore,
  momentumScore: momentumScore,
  riskScore: riskScore,
  marketScore: marketScore,
  trendScore: trendScore,
};
