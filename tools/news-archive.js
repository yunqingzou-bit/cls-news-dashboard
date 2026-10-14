"use strict";

/* ==========================================================================
 * 配置
 * ========================================================================== */

var DATA_URLS = [
  "../news.json",
  "https://yunqingzou-bit.github.io/cls-news-dashboard/news.json"
];
var STAMP_URLS = [
  "../updated.txt",
  "https://yunqingzou-bit.github.io/cls-news-dashboard/updated.txt"
];
var AUTO_MS = 60000;


var CATALOG_WEIGHT = {
  "盘中宝":10, "盘中宝·记者一线":10, "电报解读":9, "九点特供":9, "VIP日报":9,
  "明日主题前瞻":8, "金牌纪要库":7, "金牌纪要库·风口会议":7,
  "风口研报·公司":7, "风口研报·行业":7, "风口研报·洞察":7, "风口研报·业绩":7,
  "公告全知道":7, "掘金行业龙头":6, "机构调研":6,
  "研选·研报数据":6, "研选•研报数据":6, "研选":6, "数据看盘":6, "风口专家会议":6,
  "点金互动易":5, "大佬持仓跟踪":5,
  "财联社早知道":4,
  "狙击龙虎榜":3, "狙击龙虎榜午盘":3, "龙虎榜":1, "解读龙虎榜":1, "机构龙虎榜解读":1
};
var DEF_W = 3;

var BAD_TEXT = ["盈利为负/PE失真","利润同比下滑","营收承压","负面公告事项","退市风险","估值较高"];
var EXCLUDE_RE = /\*?ST|退$|退市/;

/* ==========================================================================
 * 工具
 * ========================================================================== */

function $(id) { return document.getElementById(id); }

function esc(v) {
  return String(v === null || v === undefined ? "" : v)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var x = Number(v);
  return isFinite(x) ? x : null;
}

function f2(v) {
  var x = num(v);
  return x === null ? "—" : (Math.round(x * 100) / 100).toFixed(2);
}

function pct(v) {
  var x = num(v);
  if (x === null) return "—";
  return (x > 0 ? "+" : "") + x.toFixed(2) + "%";
}

function clsPct(v) {
  var x = num(v);
  if (x === null) return "flat";
  return x > 0 ? "up" : (x < 0 ? "down" : "flat");
}

function firstMatch(re, s) {
  var m = re.exec(s || "");
  return m ? m[1] : null;
}

/** 解析 'A：x\nB：y' */
function kvParse(txt) {
  var out = {};
  String(txt || "").split("\n").forEach(function (line) {
    var i = line.indexOf("：");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return out;
}

/* ==========================================================================
 * 从 news.json 的扁平行 → 看板内部字段
 * ========================================================================== */

function inferLimit(code, name, maxAbs) {
  if (/^(sz30|sh688)/.test(code || "")) return 20;
  if (/ST/i.test(name || "") && maxAbs !== null && maxAbs <= 5.6) return 5;
  return 10;
}

function isLimitUp(r) {
  var close = num(r.close), chg = num(r.changePct), prev = num(r.prevClose);
  var maxAbs = num(r.maxAbsChange);
  if (close === null || chg === null || prev === null || prev === 0) return false;
  if (/^[NC]/.test(r.stockName || "")) return false;
  var lim = inferLimit(r.stockCode, r.stockName, maxAbs);
  if (Math.abs(chg - lim) > 1.2) return false;
  return close >= Math.round(prev * (1 + lim / 100) * 100) / 100 - 0.005;
}

/** 把一行 news.json 记录转成统一的内部结构 */
function toRow(r) {
  var tec = kvParse(r.technicalConclusion);
  var res = kvParse(r.researchConclusion);

  var playRaw = res["短线博弈"] || "";
  var playTier = (playRaw.split("｜")[0] || "").trim();
  if (playTier.indexOf("上市样本") === 0) playTier = "样本不足";

  var entry = num(firstMatch(/(?:参考|回踩)\s*([\d.]+)/, playRaw));
  var stop  = num(firstMatch(/跌破\s*([\d.]+)/, playRaw));

  var posRaw = tec["位置"] || "";
  var position = { above: {}, below: {}, testing: null };
  var mAbove = /站上\s*([\d/]+)\s*日\s*（([\d./]+)）/.exec(posRaw);
  if (mAbove) {
    var ps = mAbove[1].split("/"), vs = mAbove[2].split("/");
    for (var i = 0; i < ps.length; i++) position.above[ps[i]] = num(vs[i]);
  }
  var mBelow = /受压\s*([\d/]+)\s*日\s*（([\d./]+)）/.exec(posRaw);
  if (mBelow) {
    var ps2 = mBelow[1].split("/"), vs2 = mBelow[2].split("/");
    for (var j = 0; j < ps2.length; j++) position.below[ps2[j]] = num(vs2[j]);
  }
  position.testing = firstMatch(/正在测试\s*(\d+)\s*日均线/, posRaw);

  var kp = tec["关键位"] || "";
  var support = num(firstMatch(/支撑\s*([\d.]+)/, kp));
  var resist  = num(firstMatch(/阻力\s*([\d.]+)/, kp));

  var potTxt = res["未来三个月潜力"] || "";
  var potential = num(firstMatch(/模型(\d+)\s*\/\s*100/, potTxt));
  if (potential === null) potential = num(firstMatch(/模型\s*(\d+)/, potTxt));

  var valuation = "";
  Object.keys(res).forEach(function (k) {
    if (!valuation && k.indexOf("估值") === 0) valuation = res[k];
  });

  var close = num(r.close), chg = num(r.changePct);

  return {
    code: r.stockCode || "",
    name: r.stockName || r.stock || "",
    stock: r.stock || "",
    catalog: r.prefix || "",
    title: r.title || "",
    url: r.url || "",
    time: r.time || "",
    day: (r.time || "").slice(0, 10),
    tradeDate: r.tradeDate || "",

    close: close, chg: chg,
    open: num(r.open), prevClose: num(r.prevClose),
    turnover: num(r.turnover), volRatio: num(r.volRatioPct),
    m5: num(r.m5), m30: num(r.m30), m120: num(r.m120),
    forward: r.forward || null,

    playTier: playTier, playRaw: playRaw,
    entry: entry, stop: stop,
    support: support, resist: resist,
    potential: potential,
    valuation: valuation,
    theme: res["题材"] || "",
    holders: res["股东动向"] || "",
    event: res["目前大事"] || "",
    riskTxt: potTxt,

    trend: (tec["趋势"] || "").replace(/\s*（日线）\s*/, "").trim(),
    lean: tec["倾向"] || "",
    tecPos: posRaw, tecKp: kp, tecVol: tec["量能"] || "",
    position: position,

    limitUp: isLimitUp(r),
    newsCount: 1,
    catalogs: {}
  };
}

/* ==========================================================================
 * 聚合：一行 = 一条「新闻 × 股票」 → 每只股票一条
 * ========================================================================== */

var PLAY_ORDER = { "适合":4, "可关注":3, "中性":2, "不适合":1, "样本不足":0 };

function aggregate(rows) {
  var book = {};
  var order = [];

  rows.forEach(function (raw) {
    var row = toRow(raw);
    if (!row.code) return;

    var S = book[row.code];
    if (!S) {
      S = book[row.code] = {
        code: row.code, name: row.name, catalogs: {}, news: [],
        playTier: row.playTier, playRaw: row.playRaw,
        entry: row.entry, stop: row.stop,
        close: row.close, chg: row.chg, turnover: row.turnover, volRatio: row.volRatio,
        support: row.support, resist: row.resist, potential: row.potential,
        valuation: row.valuation, theme: row.theme, holders: row.holders, event: row.event,
        riskTxt: row.riskTxt, trend: row.trend, lean: row.lean,
        tecPos: row.tecPos, tecKp: row.tecKp, tecVol: row.tecVol,
        position: row.position, limitUp: row.limitUp,
        forward: row.forward, latestDay: row.day, days: {}
      };
      order.push(S);
    }

    S.catalogs[row.catalog] = (S.catalogs[row.catalog] || 0) + 1;
    S.days[row.day] = 1;
    S.news.push({
      time: row.time, catalog: row.catalog, title: row.title,
      url: row.url, chg: row.chg
    });

    // 更强的博弈档位优先，并同步其价位
    if ((PLAY_ORDER[row.playTier] || 0) > (PLAY_ORDER[S.playTier] || 0)) {
      S.playTier = row.playTier; S.playRaw = row.playRaw;
      S.entry = row.entry; S.stop = row.stop;
    }
    // 补齐任何缺失字段
    ["close","chg","turnover","volRatio","support","resist","potential","theme",
     "holders","event","valuation"].forEach(function (k) {
      if (S[k] === null || S[k] === "" || S[k] === undefined) {
        if (row[k] !== null && row[k] !== "" && row[k] !== undefined) S[k] = row[k];
      }
    });
    if (!S.trend && row.trend) S.trend = row.trend;
    if (!S.limitUp && row.limitUp) S.limitUp = true;
    if (!S.forward && row.forward) S.forward = row.forward;
  });

  order.forEach(function (S) {
    S.newsCount = S.news.length;
    S.news.sort(function (a, b) { return (b.time || "").localeCompare(a.time || ""); });
    S.catalogNames = Object.keys(S.catalogs).sort(function (a, b) {
      return S.catalogs[b] - S.catalogs[a];
    });
    S.topCatalog = S.catalogNames[0] || "";
    var w = DEF_W;
    S.catalogNames.forEach(function (c) {
      w = Math.max(w, CATALOG_WEIGHT[c] || DEF_W);
    });
    S.catalogWeight = w;
    S.days = Object.keys(S.days).sort();
    S.latestDay = S.days[S.days.length - 1] || S.latestDay;

    var rt = (S.riskTxt || "") + " " + (S.holders || "");
    S.riskTags = BAD_TEXT.filter(function (t) { return rt.indexOf(t) >= 0; });
    S.badNews = /减持|立案|问询|处罚/.test((S.holders || "").replace(/未检索到[^，。;；]*/g, ""));
    S.chg = num(S.chg);
  });

  return order;
}

/* ==========================================================================
 * 打分与分桶
 * ========================================================================== */

function riskReward(S) {
  if (S.entry && S.stop && S.close) {
    var risk = S.entry - S.stop;
    if (risk <= 0 || risk / S.entry < 0.015) return null;
    return Math.round(((S.close * 1.08 - S.entry) / risk) * 100) / 100;
  }
  return null;
}

function isTradable(S) {
  if (EXCLUDE_RE.test(S.name || "")) return false;
  if (S.entry === null || S.stop === null) return false;
  if (S.entry <= 0 || S.stop <= 0 || S.entry <= S.stop) return false;
  if ((S.entry - S.stop) / S.entry < 0.015) return false;
  return true;
}

function execScore(S) {
  var sc = 0;

  // ① 新闻催化 0–43（栏目权重×3 最高 30 + 条数最高 5 + 档位最高 8）
  sc += S.catalogWeight * 3;
  sc += Math.min(S.newsCount, 5) * 1;
  if (S.playTier === "适合") sc += 8;
  else if (S.playTier === "可关注") sc += 4;

  // ② 技术结构 −6–20
  var ab = S.position.above || {};
  if (ab["5"] !== undefined && ab["10"] !== undefined && ab["20"] !== undefined) sc += 12;
  else if (ab["20"] !== undefined) sc += 6;
  if (S.trend === "上升趋势") sc += 8;
  else if (S.trend.indexOf("上升") === 0) sc += 5;
  else if (S.trend.indexOf("区间") >= 0) sc += 3;
  else if (S.trend.indexOf("反弹") >= 0) sc += 2;
  else if (S.trend.indexOf("下降") === 0) sc -= 6;

  // ③ 潜力模型 0–15
  if (S.potential !== null) sc += (S.potential - 50) / 50 * 7.5 + 7.5;

  // ④ 风险惩罚
  sc -= S.riskTags.length * 3;
  if (S.badNews) sc -= 5;
  if (S.limitUp) sc -= 25;
  if (S.chg !== null && S.chg >= 9.5 && !S.limitUp) sc -= 8;
  if (S.volRatio !== null && S.volRatio >= 100) sc -= 3;
  if (!S.theme) sc -= 3;

  // ⑤ 数据完整性
  if (S.entry === null || S.stop === null) sc -= 5;

  return Math.round(sc * 10) / 10;
}

function classify(book, topN) {
  book.forEach(function (S) {
    S.execScore = execScore(S);
    S.rr = riskReward(S);
    S.tradable = isTradable(S);
  });

  function above20(S) { return S.position.above && S.position.above["20"] !== undefined; }

  var pool = book.filter(function (S) { return S.tradable; });

  // 可执行：可交易 + 非涨停/涨幅达标 + 站上20日 + 档位好
  //        + 不偏空 + 风险标签<2 + 无减持监管 + 盈亏比>=1.5 + 低吸位不高于现价
  var executable = pool.filter(function (S) {
    return !S.limitUp
      && (S.playTier === "适合" || S.playTier === "可关注")
      && above20(S)
      && S.chg !== null && S.chg < 9.5
      && S.trend.indexOf("下降") !== 0
      && S.riskTags.length < 2
      && !S.badNews
      && S.rr !== null && S.rr >= 1.5
      && S.close !== null && S.entry !== null && S.close >= S.entry;
  });

  // 「观察」改为三桶归类后的剩余集合（见下方 used 逻辑），不再单独判定。

  var avoid = book.filter(function (S) {
    if (EXCLUDE_RE.test(S.name || "")) return false;
    return (S.playTier === "不适合" || S.riskTags.length >= 2 || S.trend.indexOf("下降") === 0)
      && S.execScore < 20;
  });

  var review = pool.filter(function (S) { return S.potential !== null; });

  var SORTERS = {
    exec: function (a, b) { return b.execScore - a.execScore || (b.rr || 0) - (a.rr || 0); },
    potential: function (a, b) { return (b.potential || 0) - (a.potential || 0) || b.execScore - a.execScore; },
    rr: function (a, b) { return (b.rr || 0) - (a.rr || 0) || b.execScore - a.execScore; },
    chg: function (a, b) { return (b.chg || -999) - (a.chg || -999); },
    news: function (a, b) { return b.newsCount - a.newsCount || b.execScore - a.execScore; }
  };

  // 三个行动分桶互斥：优先级 可执行 > 回避 > 观察（观察为剩余集合）。
  // 复盘池是另一条维度（按潜力分排序的长期跟踪池），允许与上面三桶重叠。
  var used = {};
  function add(list, sorter) {
    var out = [];
    list.forEach(function (S) { if (!used[S.code]) { used[S.code] = 1; out.push(S); } });
    return out.sort(sorter);
  }
  var exFinal = add(executable, SORTERS.exec);
  var avFinal = add(avoid, function (a, b) { return a.execScore - b.execScore; });
  var waFinal = book.filter(function (S) {
    return !used[S.code] && !EXCLUDE_RE.test(S.name || "") && S.execScore > 0;
  }).sort(SORTERS.exec);

  return {
    executable: exFinal.slice(0, topN),
    watch: waFinal.slice(0, topN),
    avoid: avFinal.slice(0, topN),
    review: review.sort(SORTERS.potential).slice(0, topN),
    excluded: book.filter(function (S) { return !S.tradable; }).map(function (S) {
      var why;
      if (EXCLUDE_RE.test(S.name)) {
        why = "ST / 退市整理";
      } else if (S.playTier === "不适合" || S.playTier === "中性" || S.playTier === "样本不足") {
        why = "博弈档位「" + S.playTier + "」本身不提供参考价位";
      } else if (S.entry === null || S.stop === null) {
        why = "关键位缺失，无法设定止损";
      } else if (S.entry <= S.stop) {
        why = "止损位不低于低吸位，价位逻辑异常";
      } else {
        why = "止损空间 < 1.5%，风控无效";
      }
      return { name: S.name, code: S.code, why: why, tier: S.playTier };
    }).sort(function (a, b) { return a.why.localeCompare(b.why); }),
    counts: {
      executable: exFinal.length, watch: waFinal.length,
      avoid: avFinal.length, review: review.length,
      total: book.length
    }
  };
}

/* ==========================================================================
 * 财联社新闻筛选个股 · 每日存档
 *   输入：out/cls-news-latest.json（本轮快照，= 站点 news.json）
 *   输出：out/news-archive.json（按快照交易日留档，最多保留 MAX_DATES 天）
 * 每行除筛选结果外，另存「分析页」所需的紧凑因子（趋势/均线站位/支撑阻力/量能/题材/风险/催化）
 * ========================================================================== */
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
var SNAP = path.join(ROOT, 'out', 'cls-news-latest.json');
var ARCH = path.join(ROOT, 'out', 'news-archive.json');
var MAX_DATES = 45;
var COLS = ['code', 'name', 'bucket', 'tier', 'close', 'chg', 'score', 'rr', 'entry', 'stop',
            'pot', 'sealed', 't1', 't2', 't3', 't4', 't5',
            'trend', 'above', 'below', 'support', 'resist', 'vol', 'turn', 'theme', 'risk', 'bad', 'news'];
var N_FIXED = 17;   // t1..t5 结束位置（分析因子从第 17 个下标起）

function readJsonFile(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function deriveDay(snap) {
  var best = '';
  (snap.rows || []).forEach(function (r) { var d = String(r.tradeDate || ''); if (d > best) best = d; });
  if (/^\d{8}$/.test(best)) return best.slice(0, 4) + '-' + best.slice(4, 6) + '-' + best.slice(6, 8);
  var m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec((snap.meta && snap.meta.generatedAt) || '');
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return new Date().toISOString().slice(0, 10);
}
function maKeys(obj) {
  if (!obj) return '';
  return Object.keys(obj).map(function (k) { return parseInt(k, 10); })
    .filter(function (n) { return isFinite(n); }).sort(function (a, b) { return a - b; }).join('/');
}
function fwdT(S) {
  var f = S.forward;
  if (!f || !Array.isArray(f.t)) return [null, null, null, null, null];
  return f.t.slice(0, 5).map(function (v) {
    return (v === null || v === undefined || !isFinite(v)) ? null : Math.round(Number(v) * 100) / 100;
  });
}
function bkIdx(b) { return b === 'executable' ? 0 : (b === 'watch' ? 1 : (b === 'avoid' ? 2 : 3)); }
function nz(v) { return (v === null || v === undefined) ? -1e9 : v; }
function rnd(v, d) { return (v === null || v === undefined) ? null : Math.round(v * d) / d; }

function main() {
  var snap = readJsonFile(SNAP);
  if (!snap || !Array.isArray(snap.rows)) { console.log('WARN: \u65e0\u5feb\u7167 out/cls-news-latest.json\uff0c\u8df3\u8fc7\u5f52\u6863'); return; }
  var book = aggregate(snap.rows);
  var buckets = classify(book, 1e9);
  var day = deriveDay(snap);

  var bMap = {};
  ['executable', 'watch', 'avoid', 'review'].forEach(function (bk) {
    (buckets[bk] || []).forEach(function (S) { if (bMap[S.code] === undefined) bMap[S.code] = bk; });
  });

  var rowsMap = {};
  book.forEach(function (S) {
    if (!bMap[S.code]) return;
    var t = fwdT(S);
    rowsMap[S.code] = [S.code, S.name, bMap[S.code], S.playTier || '', S.close, S.chg,
      rnd(S.execScore, 10), rnd(S.rr, 100), S.entry, S.stop, S.potential, (S.limitUp ? 1 : 0),
      t[0], t[1], t[2], t[3], t[4],
      S.trend || '', maKeys(S.position && S.position.above), maKeys(S.position && S.position.below),
      S.support, S.resist, rnd(S.volRatio, 10), rnd(S.turnover, 100),
      (S.theme || '').slice(0, 28), (S.riskTags || []).join('|'), (S.badNews ? 1 : 0), S.newsCount];
  });

  var arch = readJsonFile(ARCH) || { version: 2 };
  if (!Array.isArray(arch.dates)) arch.dates = [];
  var cur = null;
  arch.dates.forEach(function (d) { if (d && d.day === day) cur = d; });
  var counts = {
    total: book.length, executable: buckets.counts.executable, watch: buckets.counts.watch,
    avoid: buckets.counts.avoid, review: buckets.counts.review
  };
  if (!cur) { cur = { day: day, rows: [] }; arch.dates.push(cur); }
  cur.counts = counts;

  var prev = {};
  (cur.rows || []).forEach(function (r) { if (Array.isArray(r) && r.length) prev[r[0]] = r; });
  var merged = [];
  Object.keys(rowsMap).forEach(function (c) {
    var n = rowsMap[c].slice(), p = prev[c];
    if (p) { for (var i = 12; i <= 16; i++) { if ((n[i] === null || n[i] === undefined) && p[i] !== null && p[i] !== undefined) n[i] = p[i]; } }
    merged.push(n);
  });
  Object.keys(prev).forEach(function (c) { if (!rowsMap[c]) merged.push(prev[c]); });
  merged.sort(function (a, b) { return bkIdx(a[2]) - bkIdx(b[2]) || nz(b[6]) - nz(a[6]) || String(a[0]).localeCompare(String(b[0])); });
  cur.rows = merged;

  arch.version = 2; arch.columns = COLS; arch.updatedAt = new Date().toISOString();
  arch.dates.sort(function (a, b) { return a.day < b.day ? 1 : (a.day > b.day ? -1 : 0); });
  if (arch.dates.length > MAX_DATES) arch.dates = arch.dates.slice(0, MAX_DATES);

  fs.mkdirSync(path.dirname(ARCH), { recursive: true });
  fs.writeFileSync(ARCH, JSON.stringify(arch), 'utf8');
  console.log('\u5f52\u6863 ' + day + ' | \u7bee\u5b50 ' + book.length + ' \u53ea | \u53ef\u6267\u884c ' + counts.executable
    + ' | \u5b58\u6863 ' + arch.dates.length + ' \u5929 | \u672c\u65e5\u884c ' + merged.length);
}
main();
