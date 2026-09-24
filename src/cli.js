'use strict';

const fs = require('node:fs');
const path = require('node:path');
const collectMod = require('./collect.js');
const report = require('./report.js');
const cls = require('./cls.js');
const research = require('./research.js');
const technical = require('./technical.js');
const top20 = require('./top20.js');
const market = require('./market.js');
const outlook = require('./outlook.js');
const star = require('./star.js');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function withPoolNames(rows, names) {
  return rows.map(function (r) {
    r.poolNames = (r.pools || []).map(function (k) { return names[k] || k; });
    return r;
  });
}

function rangeLabel(days) {
  const nowSec = Math.floor(Date.now() / 1000);
  return cls.fmtTime(nowSec - days * 86400).slice(0, 10) + ' ~ ' + cls.fmtTime(nowSec).slice(0, 10);
}

// 发布到 Pages 时两个版本互跳；本地导出保持无链接
function siteLinks() { return process.argv.includes('--site-links'); }

(async () => {
  const cfg = collectMod.loadConfig();
  const days = parseInt(arg('days', cfg.days || 7), 10);
  const limit = parseInt(arg('limit', 0), 10) || 0;
  const wantExportOnly = process.argv.includes('--export');
  const siteNews = process.argv.includes('--site-news');

  if (!wantExportOnly && cfg.syncPoolsOnStart !== false && !process.argv.includes('--no-sync')) {
    const synced = await collectMod.syncPools({});
    synced.forEach(function (s) {
      console.log('  股票池 ' + s.name + '：' + (s.ok ? s.count + ' 只' : '同步失败 ' + s.error));
    });
  }

  const pools = collectMod.loadPools();
  if (!pools.length) {
    console.error('没有可用股票池：请检查 config.json 的 marketPool / indexPools，或 data/watchlist.json');
    process.exit(1);
  }
  const only = arg('pool', null);
  const selected = only && only !== true ? pools.filter(function (p) { return p.key === String(only); }) : pools;
  const names = {};
  pools.forEach(function (p) { names[p.key] = p.name; });
  console.log('股票池：' + selected.map(function (p) { return p.name + '(' + p.count + ')'; }).join('、'));
  console.log(siteNews ? '回溯 ' + days + ' 天 ｜ 来源：财联社深度全分类' : '回溯 ' + days + ' 天 ｜ 目标栏目: ' + cfg.prefixes.join('、'));

  if (!wantExportOnly) {
    const t0 = Date.now();
    let lastLog = 0;
    const res = siteNews
      ? await collectMod.collectSiteNews({ days: days, siteConcurrency: 4 })
      : await collectMod.collect({
        days: days,
        limit: limit,
        pools: selected.map(function (p) { return p.key; }),
        fetchText: !process.argv.includes('--no-text'),
        onProgress: function (stats) {
          const now = Date.now();
          if (now - lastLog < 2000 && stats.scanned < stats.stocks) return;
          lastLog = now;
          process.stdout.write('\r进度 ' + stats.scanned + '/' + stats.stocks + ' ｜ 新闻 ' + stats.listed + ' ｜ 带栏目前缀 ' + stats.prefixed + ' ｜ 命中目标 ' + stats.matched + ' ｜ 正文 ' + stats.newText + ' ｜ 失败 ' + stats.errors + '   ');
        },
      });
    const st = res.stats;
    console.log('');
    console.log(siteNews
      ? '完成：全分类读取 ' + st.categories + ' 个 ｜ 读取新闻 ' + st.listed + ' 条 ｜ 近窗口新闻 ' + st.matched + ' 条 ｜ 失败 ' + st.errors + ' 个分类 ｜ 用时 ' + Math.round((Date.now() - t0) / 1000) + 's'
      : '完成：去重后 ' + st.stocks + ' 只股票 ｜ 读取新闻 ' + st.listed + ' 条 ｜ 带栏目前缀 ' + st.prefixed + ' 条 ｜ 命中目标栏目 ' + st.matched + ' 条 ｜ 抓到正文 ' + st.newText + ' 条 ｜ 失败 ' + st.errors + ' 只 ｜ 用时 ' + Math.round((Date.now() - t0) / 1000) + 's');
    if (res.errors.length) {
      console.log('失败明细（前 10）:');
      res.errors.slice(0, 10).forEach(function (e) { console.log('  ' + (e.code || e.category) + ' ' + e.name + ' -> ' + e.error); });
    }
    console.log('');
  }

  const store = collectMod.loadStore();
  const rows = withPoolNames(collectMod.rows(store, {
    days: days,
    pool: (only && only !== true) ? String(only) : 'all',
    siteOnly: siteNews,
  }), names);
  // 先刷技术面：调研结论里的「短线博弈」要引用当轮的日线指标
  if (!process.argv.includes('--no-technical')) {
    let lastTechLog = 0;
    const tr = await technical.refresh(rows, {
      config: cfg,
      onProgress: function (s) {
        const now = Date.now();
        if (now - lastTechLog < 1500 && s.done < s.total) return;
        lastTechLog = now;
        process.stdout.write('\r技术面 ' + s.done + '/' + s.total + ' ｜ 缓存 ' + s.cached + ' ｜ 失败 ' + s.errors + '   ');
      },
    });
    if (tr.refreshed) console.log('');
    console.log('技术面结论：股票 ' + tr.total + ' 只 ｜ 本轮更新 ' + tr.refreshed + ' ｜ 使用缓存 ' + tr.cached + ' ｜ 失败 ' + tr.errors + (tr.deferred ? ' ｜ 顺延下轮 ' + tr.deferred + ' 只' : ''));
  } else {
    technical.attachRows(rows);
  }
  if (!process.argv.includes('--no-research')) {
    let lastResearchLog = 0;
    const rr = await research.enrichRows(rows, {
      config: cfg,
      onProgress: function (s) {
        const now = Date.now();
        if (now - lastResearchLog < 1500 && s.done < s.total) return;
        lastResearchLog = now;
        process.stdout.write('\r调研 ' + s.done + '/' + s.total + ' ｜ 缓存 ' + s.cached + ' ｜ 失败 ' + s.errors + '   ');
      },
    });
    if (rr.refreshed) console.log('');
    console.log('调研结论：股票 ' + rr.total + ' 只 ｜ 本轮更新 ' + rr.refreshed + ' ｜ 使用缓存 ' + rr.cached + ' ｜ 失败 ' + rr.errors);
  } else {
    research.attachRows(rows);
  }
  const meta = {
    title: siteNews ? '财联社全站深度新闻' : '财联社 沪深A股 · 目标栏目新闻',
    range: rangeLabel(days),
    poolLabel: siteNews ? '财联社深度全分类' : selected.map(function (p) { return p.name + '（' + p.count + ' 只）'; }).join(' / '),
    generatedAt: new Date().toLocaleString('zh-CN'),
  };
  // 当天行情卡片：全市场快照汇总（涨幅榜/主力净流入/领涨题材），失败不影响表格导出
  if (!process.argv.includes('--no-market')) {
    try {
      meta.card = await market.summary({});
      const b = meta.card.breadth;
      console.log('当天行情卡片：沪深两市 ' + meta.card.total + ' 只 ｜ 涨 ' + b.up + ' / 跌 ' + b.down +
        ' ｜ 领涨主题 ' + (meta.card.themes[0] ? meta.card.themes[0].name : '—') +
        ' ｜ 主力净流入 ' + b.fundYi + ' 亿');
    } catch (e) {
      console.log('当天行情卡片：本轮抓取失败（' + String((e && e.message) || e) + '），页面沿用上一版');
    }
  }
  // 明日关注个股明细：把 card.outlook.picks 按添加日期留档，并补齐 T+1~T+5 与两份结论
  if (!process.argv.includes('--no-outlook')) {
    try {
      const oo = await outlook.run(meta.card, { config: cfg, newsRows: rows, siteLinks: siteLinks(), backHref: siteLinks() ? '../' : '' });
      console.log('明日关注个股：留档 ' + oo.days + ' 个添加日 ｜ 明细 ' + oo.rows + ' 行 ｜ T+1 已到位 ' + oo.t1 + ' 只 ｜ T+5 已到位 ' + oo.t5 + ' 只 ｜ ' +
        (oo.skipped ? '本轮未新增（' + oo.skipped + '）' : '本轮新增 ' + oo.added + ' 只'));
    } catch (e) {
      console.log('明日关注个股：本轮生成失败（' + String((e && e.message) || e) + '），页面沿用上一版');
    }
  }
  // 明星看点：每天 20:00（上海）重算一次，从当日看板涉及的股票里挑 3 只，渲染在「明日看点」里的超链接
  if (meta.card) {
    try {
      const st = star.run(rows, {
        technical: technical.loadCache().stocks || {},
        research: research.loadCache().stocks || {},
        hotSectors: ((meta.card.outlook && meta.card.outlook.sectors) || []).map(function (s) { return s.name; }),
      });
      meta.card.stars = st;
      console.log('明星看点：' + (st.picks.length
        ? st.picks.map(function (p) { return p.name + '(' + p.code + ' 分' + p.score + ')'; }).join('、')
        : '本轮无') +
        ' ｜ ' + (st.refreshed ? '本轮重算' : '沿用 ' + (st.date || '—') + ' ' + (st.hm || '')) +
        ' ｜ 档位 ' + (st.tier || '-') + ' ｜ 留档 ' + st.historyDays + ' 天');
    } catch (e) {
      console.log('明星看点：本轮生成失败（' + String((e && e.message) || e) + '），本轮不显示');
    }
  }
  // 新闻看板「个股表现」：按 5 日动能排序（看板模块与明细页用同一份顺序）
  let boardStocks = [];
  let boardNewStocks = [];
  let boardNewMeta = { day: '', count: 0, updatedAt: '' };
  if (!process.argv.includes('--no-outlook')) {
    try {
      const techCache = technical.loadCache().stocks || {};
      const resCache = research.loadCache().stocks || {};
      const pool = report.boardStocks(rows).map(function (s) {
        s.mom = technical.momentumScore(techCache[s.code] && techCache[s.code].metrics);
        const rec = resCache[s.code];
        if (rec && rec.industry) s.theme = rec.industry;
        return s;
      });
      boardStocks = pool
        // 三个指标齐全的才参与排序：只有 RSI 的记录（旧缓存 / 新上市）和三项齐全的分值不可比
        .filter(function (s) { return s.mom && s.mom.macd && s.mom.kdj && s.mom.score !== null && s.mom.score !== undefined; })
        .sort(function (a, b) {
          const av = a.nn ? a.sum / a.nn : -999;
          const bv = b.nn ? b.sum / b.nn : -999;
          return (b.mom.score - a.mom.score) || (bv - av) || (b.n - a.n);
        })
        .slice(0, Math.max(1, Number((cfg.outlook && cfg.outlook.boardStocks) || 8)));
      // 本轮新更新股票：取当前表格中最新新闻日，排除所有前缀/标题含“龙虎榜”的记录。
      // 仍沿用同一批股票的 RSI/KDJ/MACD 动能分，避免“新更新”栏目与个股表现排序口径不一致。
      const newsDay = function (r) {
        const t = String((r && r.time) || '');
        if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
        if (r && r.ctime) return cls.fmtTime(r.ctime).slice(0, 10);
        return '';
      };
      const freshRows = rows.filter(function (r) {
        return r && !/龙虎榜/.test(String(r.prefix || '') + ' ' + String(r.title || ''));
      });
      const freshDay = freshRows.reduce(function (max, r) {
        const d = newsDay(r);
        return d > max ? d : max;
      }, '');
      const freshMap = new Map();
      freshRows.filter(function (r) { return newsDay(r) === freshDay; }).forEach(function (r) {
        const code = r.stockCode || '';
        const name = r.stockName || r.stock || '';
        const key = code || name;
        if (!key) return;
        if (!freshMap.has(key)) freshMap.set(key, { code: code, name: name, n: 0, nn: 0, sum: 0, latestTime: r.time || '', mom: null });
        const a = freshMap.get(key);
        a.n++;
        if (r.time && r.time > a.latestTime) a.latestTime = r.time;
        const v = Number(r.changePct);
        if (r.changePct !== null && r.changePct !== undefined && Number.isFinite(v)) { a.nn++; a.sum += v; }
        const full = pool.find(function (s) { return s.code === code; });
        if (full && full.mom) a.mom = full.mom;
      });
      boardNewStocks = Array.from(freshMap.values())
        .filter(function (s) { return s.mom && s.mom.macd && s.mom.kdj && s.mom.score !== null && s.mom.score !== undefined; })
        .map(function (s) { s.avgPct = s.nn ? s.sum / s.nn : null; return s; })
        .sort(function (a, b) { return (b.mom.score - a.mom.score) || ((b.avgPct === null ? -999 : b.avgPct) - (a.avgPct === null ? -999 : a.avgPct)) || (b.n - a.n); })
        .slice(0, Math.max(1, Number((cfg.outlook && cfg.outlook.boardNewStocks) || 12)));
      boardNewMeta = {
        day: freshDay,
        count: boardNewStocks.length,
        sourceRows: freshRows.filter(function (r) { return newsDay(r) === freshDay; }).length,
        updatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
      };
      const bo = await outlook.runBoard(boardStocks, { config: cfg, newsRows: rows, siteLinks: siteLinks(), backHref: siteLinks() ? '../' : '' });
      console.log('新闻看板个股：动能排序 ' + boardStocks.length + ' 只（池 ' + pool.length + ' 只，指标齐全 ' +
        pool.filter(function (s) { return s.mom && s.mom.macd && s.mom.kdj; }).length + ' 只，首位 ' +
        (boardStocks[0] ? boardStocks[0].name + ' 动能 ' + boardStocks[0].mom.score + '（RSI ' + boardStocks[0].mom.rsi + ' / KDJ ' + (boardStocks[0].mom.kdj ? boardStocks[0].mom.kdj.cross : '—') + ' / MACD ' + (boardStocks[0].mom.macd ? boardStocks[0].mom.macd.cross : '—') + '）' : '—') + '）｜ 留档 ' + bo.days +
        ' 个添加日 ｜ 明细 ' + bo.rows + ' 行 ｜ T+1 已到位 ' + bo.t1 + ' 只 ｜ ' + (bo.skipped ? '本轮未新增（' + bo.skipped + '）' : '本轮新增 ' + bo.added + ' 只'));
    } catch (e) {
      console.log('新闻看板个股：本轮生成失败（' + String((e && e.message) || e) + '），页面沿用上一版');
    }
  }
  const out = report.exportAll(rows, meta, {
    fileBase: 'cls-news',
    layout: 'table',
    // Pages 上主页面是表格版，附带一个「卡片版」子页面；本地导出不加互跳链接，避免 file:// 打开时链接失效
    links: siteLinks() ? [{ href: 'cards/', label: '卡片版' }] : [],
    marketReviewHref: siteLinks() ? 'https://yunqingzou-bit.github.io/cls-news-dashboard/market-review/' : '',
    alsoCards: true,
    cardsLinks: siteLinks() ? [{ href: '../', label: '表格版' }] : [],
    outlookHref: siteLinks() ? 'outlook/' : '',
    boardHref: siteLinks() ? 'stocks/' : '',
    boardStocks: boardStocks,
    boardNewStocks: boardNewStocks,
    boardNewMeta: boardNewMeta,
  });
  const selected20 = top20.write(rows, meta, {
    days: Math.min(days, 3),
    limit: 20,
    stockUniverse: siteNews && collectMod.loadPool('all-a') ? collectMod.loadPool('all-a').stocks : [],
    sourceMode: siteNews ? 'site-depth' : 'stock-prefix',
  });
  console.log('表格共 ' + rows.length + ' 条，已导出：');
  console.log('  ' + out.csvPath);
  console.log('  ' + out.htmlPath);
  console.log('  ' + out.jsonPath);
  if (out.cardsPath) console.log('  ' + out.cardsPath + '  （卡片版）');
  console.log('  ' + selected20.file + '  （精选20条）');

  // 发布状态：定时任务据此判断“距上次刷新多久了”，决定本轮是否真的重新抓取
  const nowMs = Date.now();
  const statusPath = path.join(report.OUT_DIR, 'status.json');
  fs.writeFileSync(statusPath, JSON.stringify({
    publishedAt: nowMs,
    publishedAtShanghai: cls.fmtTime(Math.floor(nowMs / 1000)),
    range: meta.range,
    poolLabel: meta.poolLabel,
    days: days,
    rows: rows.length,
  }, null, 2), 'utf8');
  console.log('  ' + statusPath + '  （发布状态）');
})().catch(function (e) { console.error('运行失败:', e); process.exit(1); });
