"use strict";

/* ==========================================================================
 * 深度因子采集 v2（对齐《个股深度研报·分析流程说明》）
 *   覆盖因子（全部公开接口，无需密钥）：
 *     1. 主力资金流向   东财 push2his 日度资金流（主源）→ 新浪历史资金流（备用）
 *     2. 机构评级/目标价 东财研报库近 90 天：评级、机构家数、买入+增持占比、一致目标价（均值）
 *     3. 商誉 + 负债率   东财 F10 资产负债表（最新报告期，商誉占归母净资产比、资产负债率）
 *     4. 估值快照       腾讯 qt.gtimg.cn 批量（50/批）：PE(TTM)/PB/总市值/流通市值/换手/量比
 *     5. 技术面衍生     腾讯 proxy 日K 60 根（qfq）自行计算：RSI14、距60日高点回撤、
 *                      距60日低点涨幅、20日波动率、MA20 斜率、5日/20日量能比
 *     6. 业绩因子       东财业绩报表 + F10 主要指标：营收/归母/扣非同比、毛利率、ROE、报告期
 *     7. 限售解禁       东财数据中心：未来最近一次解禁日期/市值/占总股本比例
 *     8. 业绩验证日历   东财数据中心：未来最近一次预约披露日（RPT_PUBLIC_BS_APPOIN）
 *                      + 最新业绩预告类型与净利区间（RPT_PUBLIC_OP_NEWPREDICT）
 *   输入：out/cls-news-latest.json（本轮快照，与 news-archive 覆盖口径一致：
 *         剔除仅由龙虎榜相关栏目命中的个股）
 *   缓存：data/deep-factors.json（重因子 12 小时缓存，估值快照每轮全量刷新）
 *   输出：out/deep-factors.json（随看板发布为 deep-factors.json）
 * 任何一路失败只置空该因子，不阻断归档与发布。
 * ========================================================================== */

var fs = require('node:fs');
var path = require('node:path');
var https = require('node:https');

var ROOT = path.join(__dirname, '..');
var SNAP = path.join(ROOT, 'out', 'cls-news-latest.json');
var CACHE = path.join(ROOT, 'data', 'deep-factors.json');
var OUT = path.join(ROOT, 'out', 'deep-factors.json');
var LHB_RE = /龙虎榜/;
var MAX_AGE_MS = 12 * 3600 * 1000;   // 重因子缓存 12 小时
var CONCURRENCY = 4;
var REQUEST_DELAY_MS = 120;
var QUOTE_BATCH = 50;                // 腾讯快照每批代码数

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

function fetchText(url, timeoutMs, extraHeaders) {
  return new Promise(function (resolve, reject) {
    var req = https.get(url, {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Referer': 'https://quote.eastmoney.com/'
      }, extraHeaders || {}),
      timeout: timeoutMs || 15000
    }, function (res) {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}
function fetchJson(url, ms, extraHeaders) {
  return fetchText(url, ms, extraHeaders).then(function (t) { return JSON.parse(t); });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function r2(v) { return (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * 100) / 100; }
function r1(v) { return (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * 10) / 10; }

/* ---------- 股票清单（与 news-archive 覆盖口径一致：剔除仅龙虎榜命中） ---------- */
function pickStocks(snap) {
  var book = {};
  (snap.rows || []).forEach(function (r) {
    var code = String(r.stockCode || '').trim();
    if (!code) return;
    var cat = String(r.prefix || '').trim();
    var e = book[code] || (book[code] = { code: code, name: r.stockName || r.stock || '', cats: {} });
    if (cat) e.cats[cat] = 1;
  });
  return Object.keys(book).map(function (c) { return book[c]; })
    .filter(function (e) {
      var names = Object.keys(e.cats);
      if (!names.length) return false;
      return names.some(function (n) { return !LHB_RE.test(n); });
    });
}

/* ---------- 1. 主力资金流向（东财主源，新浪备用；主力 = 超大单+大单） ---------- */
function moneyFlowSina(code) {
  var m = /^(sh|sz)(\d{6})$/i.exec(code);
  if (!m) return Promise.resolve(null);
  var url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_lscjfb?page=1&num=22&sort=opendate&asc=0&daima='
    + m[1].toLowerCase() + m[2];
  return fetchJson(url, 15000, { 'Referer': 'https://finance.sina.com.cn' }).then(function (rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    var nets = rows.map(function (r) {
      var main = Number(r.r0_net) + Number(r.r1_net);
      return isFinite(main) ? main : null;
    }).filter(function (v) { return v !== null; });
    if (!nets.length) return null;
    function sumN(n) { return r2(nets.slice(0, n).reduce(function (a, b) { return a + b; }, 0) / 1e8); }
    return { mft: r2(nets[0] / 1e8), mf5: sumN(5), mf10: sumN(10), mf20: sumN(20) };
  });
}
function fetchMoneyFlow(code) {
  var m = /^(sh|sz|bj)(\d{6})$/i.exec(code);
  if (!m) return Promise.resolve(null);
  var market = /^sh$/i.test(m[1]) ? '1' : '0';
  var url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=25&klt=101&secid='
    + market + '.' + m[2] + '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65';
  function summarize(nets) {
    if (!nets.length) return null;
    function sumN(n) { return r2(nets.slice(0, n).reduce(function (a, b) { return a + b; }, 0) / 1e8); }
    return { mft: r2(nets[0] / 1e8), mf5: sumN(5), mf10: sumN(10), mf20: sumN(20) };
  }
  return fetchJson(url).then(function (d) {
    var kl = (d && d.data && d.data.klines) || [];
    var nets = kl.map(function (s) { return s.split(',')[1]; })
      .filter(function (v) { return v !== '-' && v !== '' && v !== undefined; })
      .map(Number).filter(isFinite);
    if (!nets.length) throw new Error('empty');
    return summarize(nets);
  }).catch(function () {
    return moneyFlowSina(code).then(function (r) {
      if (!r) return null;
      // 新浪路径只有 22 行且 mft/mf20 已算好，mf5/mf10 需原始数据 → 在 sina 函数里补
      return r;
    });
  });
}

/* ---------- 2. 机构评级与目标价（近 90 天；一致目标价 = 有目标价研报的均值） ---------- */
var BUY_WORDS = ['买入', '增持', '推荐', '强烈推荐', '跑赢行业', '优于大市', '推荐评级', '买入评级'];
function fetchRatings(code) {
  var m = /^[a-z]{2}(\d{6})$/i.exec(code);
  if (!m) return Promise.resolve(null);
  var end = new Date(Date.now() + 8 * 3600 * 1000);
  var begin = new Date(Date.now() + 8 * 3600 * 1000 - 90 * 24 * 3600 * 1000);
  function dstr(d) { return d.toISOString().slice(0, 10); }
  var url = 'https://reportapi.eastmoney.com/report/list?pageSize=100&pageNo=1&code=' + m[1]
    + '&industryCode=*&industryType=*&rating=*&ratingChange=*&beginTime=' + dstr(begin)
    + '&endTime=' + dstr(end) + '&qType=0';
  return fetchJson(url).then(function (d) {
    var items = (d && d.data) || [];
    if (!items.length) return null;
    items.sort(function (a, b) { return String(b.publishDate || '').localeCompare(String(a.publishDate || '')); });
    var latest = items[0];
    var orgs = {}, tps = [], buyCnt = 0, addCnt = 0, ratedCnt = 0, eps26 = [], eps27 = [];
    items.forEach(function (it) {
      if (it.orgSName) orgs[it.orgSName] = 1;
      var x = Number(it.indvAimPriceT);
      if (isFinite(x) && x > 0) tps.push(x);
      var rn = it.emRatingName || it.sRatingName || '';
      if (rn) {
        ratedCnt++;
        if (BUY_WORDS.indexOf(rn) >= 0) buyCnt++;
        else if (/增持|accumulate|跑赢/i.test(rn)) addCnt++;
      }
      var e1 = Number(it.predictThisYearEps); if (isFinite(e1) && e1 > 0) eps26.push(e1);
      var e2 = Number(it.predictNextYearEps); if (isFinite(e2) && e2 > 0) eps27.push(e2);
    });
    var avgTp = tps.length ? r2(tps.reduce(function (a, b) { return a + b; }, 0) / tps.length) : null;
    // 最近 5 篇研报观点（标题即核心逻辑原料，随 deep-factors.json 发布）
    var rpts = items.slice(0, 5).map(function (it) {
      return {
        o: it.orgSName || '',
        d: String(it.publishDate || '').slice(0, 10),
        t: it.title || '',
        r: it.emRatingName || it.sRatingName || '',
        tp: isFinite(Number(it.indvAimPriceT)) && Number(it.indvAimPriceT) > 0 ? Number(it.indvAimPriceT) : null,
        eps: isFinite(Number(it.predictThisYearEps)) && Number(it.predictThisYearEps) > 0 ? Number(it.predictThisYearEps) : null
      };
    });
    function avg(arr) { return arr.length ? r2(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length) : null; }
    return {
      rtg: latest.emRatingName || latest.sRatingName || null,
      orgs: Object.keys(orgs).length,
      buyRatio: ratedCnt ? r2(buyCnt / ratedCnt) : null,
      buyCnt: buyCnt || null, addCnt: addCnt || null, ratedCnt: ratedCnt || null,
      tp: avgTp,                                   // 一致目标价（均值）
      tpLow: tps.length ? r2(Math.min.apply(null, tps)) : null,
      tpHigh: tps.length ? r2(Math.max.apply(null, tps)) : null,
      tpN: tps.length || null,
      eps26: avg(eps26), eps27: avg(eps27),
      tpOrg: latest.orgSName || null,
      rdate: String(latest.publishDate || '').slice(0, 10),
      rpts: rpts
    };
  }).catch(function () { return null; });
}

/* ---------- 3. 商誉 + 负债率（东财 F10 资产负债表） ---------- */
function latestQuarterEnds() {
  // 财报报告期只有 03-31 / 06-30 / 09-30 / 12-31；从今天往前取最近 4 个季度末
  var now = new Date(Date.now() + 8 * 3600 * 1000);
  var y = now.getFullYear();
  var q = Math.floor(now.getMonth() / 3) - 1;   // 上一季度（0=Q1）
  var ends = [];
  for (var i = 0; i < 4; i++) {
    if (q < 0) { q = 3; y -= 1; }
    var mm = (q + 1) * 3;                        // 3/6/9/12
    ends.push(y + '-' + (mm < 10 ? '0' : '') + mm + '-' + (mm === 3 || mm === 12 ? '31' : '30'));
    q -= 1;
  }
  return ends;
}
function fetchBalanceSheet(code) {
  var m = /^(sh|sz|bj)(\d{6})$/i.exec(code);
  if (!m) return Promise.resolve(null);
  var sec = m[1].toUpperCase() + m[2];
  var dates = latestQuarterEnds().slice(0, 4).join(',');
  function tryType(ct) {
    var url = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/zcfzbAjaxNew?companyType='
      + ct + '&reportDateType=0&reportType=1&dates=' + encodeURIComponent(dates) + '&code=' + sec;
    return fetchJson(url).then(function (d) {
      var rows = (d && d.data) || [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.GOODWILL === null || row.GOODWILL === undefined) continue;
        var gw = Number(row.GOODWILL);
        var eq = Number(row.TOTAL_PARENT_EQUITY) || Number(row.TOTAL_EQUITY);
        var ta = Number(row.TOTAL_ASSETS), tl = Number(row.TOTAL_LIABILITIES);
        return {
          gw: r2(gw / 1e8),
          gwp: (isFinite(gw) && isFinite(eq) && eq > 0) ? r1(gw / eq * 100) : null,
          debt: (isFinite(ta) && isFinite(tl) && ta > 0) ? r1(tl / ta * 100) : null,
          gdate: String(row.REPORT_DATE || '').slice(0, 10)
        };
      }
      // 所有报告期商誉均为空 → 无商誉，明确记 0（负债率照算）
      if (rows.length) {
        var row0 = rows[0];
        var ta0 = Number(row0.TOTAL_ASSETS), tl0 = Number(row0.TOTAL_LIABILITIES);
        return {
          gw: 0, gwp: 0,
          debt: (isFinite(ta0) && isFinite(tl0) && ta0 > 0) ? r1(tl0 / ta0 * 100) : null,
          gdate: String(row0.REPORT_DATE || '').slice(0, 10)
        };
      }
      return null;
    });
  }
  return tryType(4).catch(function () { return tryType(3); }).catch(function () { return null; });
}

/* ---------- 4. 估值快照（腾讯批量，50/批，每轮全量刷新） ---------- */
function quoteBatch(codes) {
  var url = 'https://qt.gtimg.cn/q=' + codes.join(',');
  return fetchText(url, 15000, { 'Referer': 'https://gu.qq.com/' }).then(function (t) {
    var out = {};
    t.split(';').forEach(function (line) {
      line = line.trim();
      var lm = /^v_(\w+)=/.exec(line);
      if (!lm) return;
      var full = lm[1].toLowerCase();                      // sh603067
      var body = line.split('=', 2)[1].replace(/^"|"$/g, '');
      var f = body.split('~');
      if (f.length < 50 || !f[2]) return;
      function g(i) { var x = Number(f[i]); return isFinite(x) ? x : null; }
      out[full] = {
        close: g(3), chg: g(32), turn: g(38), pe: g(39),
        fcap: g(44), mcap: g(45), pb: g(46), vr: g(49)
      };
    });
    return out;
  });
}
function fetchQuotes(codes) {
  var out = {};
  var batches = [];
  for (var i = 0; i < codes.length; i += QUOTE_BATCH) batches.push(codes.slice(i, i + QUOTE_BATCH));
  return batches.reduce(function (p, b) {
    return p.then(function () {
      return quoteBatch(b).then(function (r) {
        Object.keys(r).forEach(function (k) { out[k] = r[k]; });
      }).catch(function () { }).then(function () { return sleep(200); });
    });
  }, Promise.resolve()).then(function () { return out; });
}

/* ---------- 5. 技术面衍生（腾讯 60 日日K 自行计算） ---------- */
function fetchKlineTech(code) {
  var m = /^(sh|sz|bj)(\d{6})$/i.exec(code);
  if (!m) return Promise.resolve(null);
  var url = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param='
    + m[1].toLowerCase() + m[2] + ',day,,,75,qfq';   // 75 根：MA60 需 61 根、MA20 斜率需 25 根
  return fetchJson(url, 15000, { 'Referer': 'https://gu.qq.com/' }).then(function (d) {
    var node = d && d.data && d.data[m[1].toLowerCase() + m[2]];
    if (!node) return null;
    var kl = node.qfqday || node.day;
    if (!Array.isArray(kl) || kl.length < 25) return null;
    var closes = kl.map(function (k) { return Number(k[2]); }).filter(isFinite);
    var highs = kl.map(function (k) { return Number(k[3]); }).filter(isFinite);
    var lows = kl.map(function (k) { return Number(k[4]); }).filter(isFinite);
    var vols = kl.map(function (k) { return Number(k[5]); }).filter(isFinite);
    if (closes.length < 25) return null;
    var last = closes[closes.length - 1];
    // RSI14（Wilder）
    var gains = 0, losses = 0;
    for (var i = closes.length - 14; i < closes.length; i++) {
      var diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    var ag = gains / 14, al = losses / 14;
    var rsi = (ag + al) === 0 ? 50 : 100 - 100 / (1 + ag / al);
    // 距 60 日高点回撤 / 距 60 日低点涨幅
    var h60 = Math.max.apply(null, highs.slice(-60));
    var l60 = Math.min.apply(null, lows.slice(-60));
    var dd60 = (last / h60 - 1) * 100;        // 负值=低于高点
    var up60 = (last / l60 - 1) * 100;
    // 20 日日收益率标准差（%）
    var rets = [];
    for (var j = closes.length - 20; j < closes.length; j++) {
      rets.push((closes[j] / closes[j - 1] - 1) * 100);
    }
    var mean = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
    var vol20 = Math.sqrt(rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / rets.length);
    // MA20 斜率（今 MA20 vs 5 日前 MA20，%）
    function maAt(n, fromEnd) {
      var start = closes.length - fromEnd;
      if (start < n) return null;
      var s = 0;
      for (var k2 = start - n; k2 < start; k2++) s += closes[k2];
      return s / n;
    }
    var ma20now = maAt(20, 1), ma20prev = maAt(20, 6);
    var ma20s = (ma20now !== null && ma20prev !== null && ma20prev > 0) ? (ma20now / ma20prev - 1) * 100 : null;
    // 5 日均量 / 20 日均量
    var v5 = vols.slice(-5).reduce(function (a, b) { return a + b; }, 0) / 5;
    var v20 = vols.slice(-20).reduce(function (a, b) { return a + b; }, 0) / 20;
    // 区间涨跌幅（相对 N 日前收盘）
    function chgN(n) {
      var i = closes.length - 1 - n;
      return (i >= 0 && closes[i] > 0) ? r1((last / closes[i] - 1) * 100) : null;
    }
    // KDJ（9 日，取 J 值）
    var kdjJ = null;
    if (closes.length >= 9) {
      var ln = closes.length;
      var hv = Math.max.apply(null, highs.slice(-9)), lv = Math.min.apply(null, lows.slice(-9));
      var rsv = (hv > lv) ? (last - lv) / (hv - lv) * 100 : 50;
      // 简化：单期 RSV 直推 K/D/J（初值 50）
      var K = 2 / 3 * 50 + 1 / 3 * rsv;
      var D = 2 / 3 * 50 + 1 / 3 * K;
      kdjJ = r1(3 * K - 2 * D);
    }
    return {
      chg5: chgN(5), chg10: chgN(10), chg20: chgN(20),
      ma20v: ma20now !== null ? r2(ma20now) : null,
      ma60v: maAt(60, 1) !== null ? r2(maAt(60, 1)) : null,
      rsi14: r1(rsi), dd60: r1(dd60), up60: r1(up60),
      vol20: r2(vol20), ma20s: r1(ma20s), vrq: (v20 > 0) ? r2(v5 / v20) : null,
      kdjJ: kdjJ
    };
  }).catch(function () { return null; });
}

/* ---------- 6. 业绩因子（东财业绩报表 + F10 主要指标） ---------- */
function fetchPerformance(code) {
  var m = /^[a-z]{2}(\d{6})$/i.exec(code);
  if (!m) return Promise.resolve(null);
  var cpdUrl = 'https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=REPORTDATE&sortTypes=-1&pageSize=1&pageNumber=1'
    + '&reportName=RPT_LICO_FN_CPD&columns=ALL&filter=(SECURITY_CODE%3D%22' + m[1] + '%22)';
  var f10Url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=REPORT_DATE&sortTypes=-1&pageSize=1&pageNumber=1'
    + '&reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(SECUCODE%3D%22' + m[1] + '.'
    + (/^sh/i.test(m[0]) ? 'SH' : (/^bj/i.test(m[0]) ? 'BJ' : 'SZ')) + '%22)';
  function one(u) {
    return fetchJson(u).then(function (d) {
      var data = (d.result || {}).data;
      return (data && data[0]) || null;
    }).catch(function () { return null; });
  }
  return Promise.all([one(cpdUrl), one(f10Url)]).then(function (rs) {
    var c = rs[0], f = rs[1];
    if (!c && !f) return null;
    function n(v) { var x = Number(v); return isFinite(x) ? r1(x) : null; }
    var npYoY = c ? n(c.SJLTZ) : (f ? n(f.PARENTNETPROFITTZ) : null), dkYoY = f ? n(f.KCFJCXSYJLRTZ) : null;
    var revAbs = c && isFinite(Number(c.TOTAL_OPERATE_INCOME)) ? r2(Number(c.TOTAL_OPERATE_INCOME) / 1e8)
      : (f && isFinite(Number(f.TOTALOPERATEREVE)) ? r2(Number(f.TOTALOPERATEREVE) / 1e8) : null);
    var npAbs = c && isFinite(Number(c.PARENT_NETPROFIT)) ? r2(Number(c.PARENT_NETPROFIT) / 1e8)
      : (f && isFinite(Number(f.PARENTNETPROFIT)) ? r2(Number(f.PARENTNETPROFIT) / 1e8) : null);
    return {
      rpt: c ? String(c.REPORTDATE || '').slice(0, 10) : (f ? String(f.REPORT_DATE || '').slice(0, 10) : null),
      rptName: f ? (f.REPORT_DATE_NAME || null) : (c ? (String(c.REPORTDATE || '').slice(0, 7) + ' 报告期') : null),
      rev: revAbs, np: npAbs,
      dk: f && isFinite(Number(f.KCFJCXSYJLR)) ? r2(Number(f.KCFJCXSYJLR) / 1e8) : null,
      revYoY: c ? n(c.YSTZ) : (f ? n(f.TOTALOPERATEREVETZ) : null),
      npYoY: npYoY,
      dkYoY: dkYoY,
      dkGap: (npYoY !== null && dkYoY !== null) ? r1(Math.abs(npYoY - dkYoY)) : null,
      gm: c ? n(c.XSMLL) : null,
      roe: c ? n(c.WEIGHTAVG_ROE) : (f ? n(f.ROEJQ) : null)
    };
  });
}

/* ---------- 7. 限售解禁（东财数据中心，未来最近一次） ---------- */
function fetchLift(code) {
  var m = /^[a-z]{2}(\d{6})$/i.exec(code);
  if (!m) return Promise.resolve(null);
  var today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  var url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=FREE_DATE&sortTypes=1&pageSize=8&pageNumber=1'
    + '&reportName=RPT_LIFT_STAGE&columns=SECURITY_CODE,FREE_DATE,LIFT_MARKET_CAP,TOTAL_RATIO'
    + '&filter=(SECURITY_CODE%3D%22' + m[1] + '%22)(FREE_DATE%3E%3D%27' + today + '%27)';
  return fetchJson(url).then(function (d) {
    var rows = ((d.result || {}).data) || [];
    if (!rows.length) return { liftDate: null, liftCap: null, liftPct: null };  // 未来无解禁
    var row = rows[0];                                                          // 最近一次
    var cap = Number(row.LIFT_MARKET_CAP);        // 万元
    var ratio = Number(row.TOTAL_RATIO);          // 占总股本（小数或百分数）
    return {
      liftDate: String(row.FREE_DATE || '').slice(0, 10),
      liftCap: isFinite(cap) ? r2(cap / 1e4) : null,   // 亿
      liftPct: isFinite(ratio) ? (ratio <= 1 ? r2(ratio * 100) : r2(ratio)) : null
    };
  }).catch(function () { return null; });
}

/* ---------- 8. 业绩验证日历（预约披露日 + 业绩预告；披露日作为证伪/证实节点） ---------- */
function fetchEarningsCal(code) {
  var m = /^[a-z]{2}(\d{6})$/i.exec(code);
  if (!m) return Promise.resolve(null);
  var today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  var appointUrl = 'https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=APPOINT_PUBLISH_DATE&sortTypes=1&pageSize=4&pageNumber=1'
    + '&reportName=RPT_PUBLIC_BS_APPOIN&columns=SECURITY_CODE,APPOINT_PUBLISH_DATE,REPORT_DATE'
    + '&filter=(SECURITY_CODE%3D%22' + m[1] + '%22)(APPOINT_PUBLISH_DATE%3E%3D%27' + today + '%27)';
  var fcastUrl = 'https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=NOTICE_DATE&sortTypes=-1&pageSize=1&pageNumber=1'
    + '&reportName=RPT_PUBLIC_OP_NEWPREDICT&columns=ALL&filter=(SECURITY_CODE%3D%22' + m[1] + '%22)';
  return fetchJson(appointUrl).then(function (d) {
    var rows = ((d.result || {}).data) || [];
    var appoint = rows.length ? String(rows[0].APPOINT_PUBLISH_DATE || '').slice(0, 10) : null;
    return fetchJson(fcastUrl).then(function (d2) {
      var frows = ((d2.result || {}).data) || [];
      var f = frows.length ? frows[0] : null;
      var fcast = null;
      if (f) {
        var ftype = f.PREDICT_TYPE || null;
        var lo = Number(f.ADD_AMP_LOWER), hi = Number(f.ADD_AMP_UPPER);            // 预告净利同比幅度 %
        var loA = Number(f.PREDICT_AMT_LOWER), hiA = Number(f.PREDICT_AMT_UPPER);  // 预告净利金额（元）
        var range = null;
        if (isFinite(lo) && isFinite(hi)) range = '净利同比 ' + r1(lo) + '%~' + r1(hi) + '%';
        else if (isFinite(loA) && isFinite(hiA)) range = '净利 ' + r2(loA / 1e8) + '~' + r2(hiA / 1e8) + ' 亿';
        else if (f.PREDICT_CONTENT) range = String(f.PREDICT_CONTENT).slice(0, 40);
        if (ftype && range) fcast = ftype + '：' + range;
        else if (ftype) fcast = ftype;
      }
      return { rptDate: appoint, fcast: fcast };
    });
  }).catch(function () { return null; });
}

/* ---------- 主流程 ---------- */
function fetchOne(e) {
  return Promise.all([
    fetchMoneyFlow(e.code), fetchRatings(e.code), fetchBalanceSheet(e.code),
    fetchKlineTech(e.code), fetchPerformance(e.code), fetchLift(e.code), fetchEarningsCal(e.code)
  ]).then(function (rs) {
    var mf = rs[0] || {}, rt = rs[1] || {}, bs = rs[2] || {}, tech = rs[3] || {}, pf = rs[4] || {}, lf = rs[5] || {}, ec = rs[6] || {};
    return {
      code: e.code, name: e.name,
      mft: mf.mft || null, mf5: mf.mf5 === undefined ? null : mf.mf5,
      mf10: mf.mf10 === undefined ? null : mf.mf10, mf20: mf.mf20 || null,
      rtg: rt.rtg || null, orgs: rt.orgs || null, buyRatio: rt.buyRatio || null,
      buyCnt: rt.buyCnt === undefined ? null : rt.buyCnt, addCnt: rt.addCnt === undefined ? null : rt.addCnt,
      ratedCnt: rt.ratedCnt === undefined ? null : rt.ratedCnt,
      tp: rt.tp || null, tpLow: rt.tpLow === undefined ? null : rt.tpLow,
      tpHigh: rt.tpHigh === undefined ? null : rt.tpHigh,
      tpN: rt.tpN || null, eps26: rt.eps26 === undefined ? null : rt.eps26,
      eps27: rt.eps27 === undefined ? null : rt.eps27,
      tpOrg: rt.tpOrg || null, rdate: rt.rdate || null,
      rpts: rt.rpts || [],
      gw: bs.gw === undefined ? null : bs.gw, gwp: bs.gwp === undefined ? null : bs.gwp,
      debt: bs.debt === undefined ? null : bs.debt, gdate: bs.gdate || null,
      chg5: tech.chg5 === undefined ? null : tech.chg5,
      chg10: tech.chg10 === undefined ? null : tech.chg10,
      chg20: tech.chg20 === undefined ? null : tech.chg20,
      ma20v: tech.ma20v === undefined ? null : tech.ma20v,
      ma60v: tech.ma60v === undefined ? null : tech.ma60v,
      rsi14: tech.rsi14 === undefined ? null : tech.rsi14,
      dd60: tech.dd60 === undefined ? null : tech.dd60,
      up60: tech.up60 === undefined ? null : tech.up60,
      vol20: tech.vol20 === undefined ? null : tech.vol20,
      ma20s: tech.ma20s === undefined ? null : tech.ma20s,
      vrq: tech.vrq === undefined ? null : tech.vrq,
      kdjJ: tech.kdjJ === undefined ? null : tech.kdjJ,
      rpt: pf.rpt || null, rptName: pf.rptName || null,
      rev: pf.rev === undefined ? null : pf.rev, np: pf.np === undefined ? null : pf.np,
      dk: pf.dk === undefined ? null : pf.dk,
      revYoY: pf.revYoY === undefined ? null : pf.revYoY, npYoY: pf.npYoY === undefined ? null : pf.npYoY,
      dkYoY: pf.dkYoY === undefined ? null : pf.dkYoY, dkGap: pf.dkGap === undefined ? null : pf.dkGap,
      gm: pf.gm === undefined ? null : pf.gm, roe: pf.roe === undefined ? null : pf.roe,
      liftDate: lf.liftDate || null, liftCap: lf.liftCap === undefined ? null : lf.liftCap,
      liftPct: lf.liftPct === undefined ? null : lf.liftPct,
      rptDate: ec.rptDate || null, fcast: ec.fcast === undefined ? null : ec.fcast,
      t: new Date().toISOString()
    };
  });
}

function runPool(items, worker, n) {
  var i = 0, out = [];
  function next() {
    if (i >= items.length) return Promise.resolve(out);
    var idx = i++;
    return worker(items[idx]).then(function (r) { out[idx] = r; return sleep(REQUEST_DELAY_MS); }).then(next);
  }
  var starters = [];
  for (var k = 0; k < Math.min(n, items.length); k++) starters.push(next());
  return Promise.all(starters).then(function () { return out; });
}

function main() {
  var snap = readJson(SNAP);
  if (!snap || !Array.isArray(snap.rows)) { console.log('WARN: 无快照 out/cls-news-latest.json，跳过深度因子'); return; }
  var stocks = pickStocks(snap);
  var codes = stocks.map(function (e) { return e.code; });
  var cache = readJson(CACHE) || { factors: {} };
  if (!cache.factors) cache.factors = {};

  var need = stocks.filter(function (e) {
    var c = cache.factors[e.code];
    return !c || !c.t || (Date.now() - Date.parse(c.t)) > MAX_AGE_MS;
  });
  console.log('深度因子：覆盖 ' + stocks.length + ' 只，本轮需抓取 ' + need.length + ' 只（缓存 ' + (stocks.length - need.length) + ' 只）');

  // 估值快照：每轮全量刷新（每 50 只一个请求，代价低）
  fetchQuotes(codes).then(function (quotes) {
    return runPool(need, fetchOne, CONCURRENCY).then(function (fresh) {
      fresh.forEach(function (f) { if (f) cache.factors[f.code] = f; });
      var outFactors = {};
      stocks.forEach(function (e) {
        var f = cache.factors[e.code];
        if (!f) return;
        var q = quotes[e.code];
        if (q) {
          f.pe = q.pe; f.pb = q.pb; f.mcap = q.mcap; f.fcap = q.fcap;
          f.turn = q.turn; f.vr = q.vr; f.qClose = q.close; f.qChg = q.chg;
        }
        outFactors[e.code] = f;
      });
      var out = { version: 2, updatedAt: new Date().toISOString(), factors: outFactors };
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');
      var cnt = { mf: 0, tp: 0, gw: 0, perf: 0, tech: 0, lift: 0, val: 0, cal: 0 };
      Object.keys(outFactors).forEach(function (c) {
        var f = outFactors[c];
        if (f.mf20 !== null && f.mf20 !== undefined) cnt.mf++;
        if (f.tp) cnt.tp++;
        if (f.gw !== null && f.gw !== undefined) cnt.gw++;
        if (f.npYoY !== null && f.npYoY !== undefined) cnt.perf++;
        if (f.rsi14 !== null && f.rsi14 !== undefined) cnt.tech++;
        if (f.liftDate) cnt.lift++;
        if (f.pe !== null && f.pe !== undefined) cnt.val++;
        if (f.rptDate) cnt.cal++;
      });
      console.log('深度因子完成（共 ' + stocks.length + ' 只）：资金 ' + cnt.mf
        + ' | 目标价 ' + cnt.tp + ' | 商誉 ' + cnt.gw + ' | 业绩 ' + cnt.perf
        + ' | 技术面 ' + cnt.tech + ' | 估值 ' + cnt.val + ' | 解禁日 ' + cnt.lift
        + ' | 财报日历 ' + cnt.cal);
    });
  }).catch(function (e) {
    console.log('WARN: 深度因子采集失败：' + (e && e.message));
    // 失败时保留既有缓存输出，避免下游断档
    var old = readJson(OUT);
    if (!old) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), factors: {} }), 'utf8');
    }
  });
}
main();
