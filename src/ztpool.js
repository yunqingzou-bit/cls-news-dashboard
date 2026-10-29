'use strict';
/**
 * 封板监测：东方财富涨停池（沪深 A 股），供「封板监测」栏目使用。
 *
 * 数据口径：
 *   池内 = 此刻股价封在涨停价上的股票（盘中实时进出；收盘后为当日最终封板名单）。
 *   lbc  = 连板数，即「第几个板」（1 表示今日首板）；
 *   zttj = { days, ct }：N 天 M 板（统计区间口径，反包等特殊形态与连板数不同）；
 *   fbt / lbt = 首次 / 最后封板时间（HHMMSS）；fund = 封单金额（元）；
 *   zbc = 开板（炸板）次数；hybk = 东财行业板块；hs = 换手率%；amount = 成交额（元）。
 *
 * 接口必须带 date 参数（不带日期返回空），因此固定请求今天；
 * 盘前 / 非交易日当日为空时，依次回退最近 4 个自然日，拿到的是上一交易日的收盘名单。
 * 结果在进程内缓存 5 分钟（长驻的 server.js 复用；cli 每轮新进程天然只抓一次）。
 */
const TTL_MS = 5 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const API = 'https://push2ex.eastmoney.com/getTopicZTPool' +
  '?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=10000&sort=fbt%3Aasc&date=';

let mem = { at: 0, data: null };

function ymd(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

/** 单次请求：返回原始 pool 数组（可能为空），HTTP/解析失败抛错。 */
async function fetchOnce(dateStr) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 15000);
  let txt;
  try {
    const res = await fetch(API + dateStr, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    });
    if (!res.ok) throw new Error('涨停池接口 HTTP ' + res.status);
    txt = await res.text();
  } finally {
    clearTimeout(timer);
  }
  const j = JSON.parse(txt);
  return (j && j.data && j.data.pool) || [];
}

function round2(v) { return Math.round(Number(v) * 100) / 100; }

function fmtHms(v) {
  const s = String(v || '').padStart(6, '0');
  return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
}

/** m：0 = 深圳，1 = 上海（北交所不在沪深涨停池内）。 */
function normalize(x) {
  const code = (Number(x.m) === 1 ? 'sh' : 'sz') + String(x.c || '');
  const tj = x.zttj || {};
  return {
    code: code,
    name: String(x.n || ''),
    px: round2((Number(x.p) || 0) / 1000),
    pct: round2(x.zdp),
    board: Math.max(1, Number(x.lbc) || 1),
    daysCt: (tj.days && tj.ct && tj.days !== tj.ct) ? (tj.days + '天' + tj.ct + '板') : '',
    fbt: fmtHms(x.fbt),
    lbt: fmtHms(x.lbt),
    fundYi: Math.round((Number(x.fund) || 0) / 1e8 * 100) / 100,
    zbc: Number(x.zbc) || 0,
    hs: round2(x.hs),
    hybk: String(x.hybk || ''),
    amountYi: Math.round((Number(x.amount) || 0) / 1e8 * 10) / 10,
  };
}

/** 抓取涨停池并汇总为 { date, count, maxBoard, ladder, list }；连续失败向上抛错。 */
async function fetchPool() {
  if (mem.data && Date.now() - mem.at < TTL_MS) return mem.data;
  let raw = null;
  let poolDate = '';
  for (let i = 0; i < 4; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const ds = ymd(d);
    const list = await fetchOnce(ds); // 抛错则整轮失败，由调用方兜底
    if (list && list.length) { raw = list; poolDate = ds; break; }
  }
  if (!raw) {
    // 近几日都为空（长假等）：给出空结果而不是报错，页面显示「暂无封板数据」
    mem = { at: Date.now(), data: { date: ymd(new Date()), count: 0, maxBoard: 0, ladder: [], list: [] } };
    return mem.data;
  }
  const list = raw.map(normalize).sort(function (a, b) {
    return (b.board - a.board) || (b.fundYi - a.fundYi);
  });
  const dist = {};
  for (const x of list) dist[x.board] = (dist[x.board] || 0) + 1;
  const ladder = Object.keys(dist).map(Number).sort(function (a, b) { return b - a; })
    .map(function (n) { return { board: n, count: dist[n] }; });
  mem = {
    at: Date.now(),
    data: {
      date: poolDate,
      count: list.length,
      maxBoard: list.length ? list[0].board : 0,
      ladder: ladder,
      list: list,
    },
  };
  return mem.data;
}

module.exports = { fetchPool: fetchPool };
