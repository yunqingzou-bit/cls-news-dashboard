'use strict';

// 多来源市场新闻聚合：财联社看板 + 新浪7x24 + 新华网财经RSS + GDELT跨站检索。
// 仅保存标题/摘要/来源链接，不镜像全文；来源异常时保留缓存，不能阻塞行情发布。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.MARKET_NEWS_OUT_DIR || path.join(ROOT, 'out');
const FILE = path.join(OUT, 'market-news.json');
const CLS_FILE = path.join(OUT, 'cls-news-latest.json');
const MAX_AGE_MS = 72 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; MarketReviewDashboard/1.0; +https://yunqingzou-bit.github.io/cls-news-dashboard/)';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function decode(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(Number(n)); })
    .replace(/&#x([\da-f]+);/gi, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); })
    .replace(/&(amp|lt|gt|quot|apos);/g, function (_, n) { return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n]; });
}
function plain(s) { return decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function parseTime(value) {
  const raw = String(value || '').trim();
  const gdelt = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (gdelt) return Date.parse(gdelt[1] + '-' + gdelt[2] + '-' + gdelt[3] + 'T' + gdelt[4] + ':' + gdelt[5] + ':' + gdelt[6] + 'Z');
  return typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(raw);
}
function localTime(value) {
  const ms = parseTime(value);
  if (!Number.isFinite(ms)) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}
function item(source, publisher, title, url, time, extra) {
  title = plain(title).replace(/^\s*[〖【\[][^〗】\]]{1,20}[〗】\]]\s*/, '').trim();
  if (!title || !url || !/^https?:\/\//i.test(url)) return null;
  extra = extra || {};
  if (extra.summary) extra.summary = plain(extra.summary).slice(0, 280);
  return Object.assign({ id: source + ':' + url, source: source, publisher: publisher, prefix: '', title: title.slice(0, 220), url: url, time: localTime(time) }, extra || {});
}
async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 10000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json, application/rss+xml, application/xml, text/xml, */*' }, signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(timer); }
}
async function fetchSina() {
  const url = 'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=50&zhibo_id=152';
  const data = JSON.parse(await get(url));
  const feed = (((data || {}).result || {}).data || {}).feed;
  return (feed && Array.isArray(feed.list) ? feed.list : []).map(function (x) {
    const content = plain(x.rich_text || '');
    return item('sina', '新浪财经7×24', content.slice(0, 180), 'https://finance.sina.com.cn/7x24/notification.shtml?docid=' + encodeURIComponent(x.id || ''), x.create_time, { id: 'sina:' + String(x.id || x.create_time), summary: content });
  }).filter(Boolean);
}
async function fetchXinhua() {
  const xml = await get('https://www.xinhuanet.com/finance/news_finance.xml');
  const rows = [], re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const field = function (name) { const found = block.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i')); return found ? decode(found[1]).trim() : ''; };
    rows.push(item('xinhuanet', '新华网财经', field('title'), field('link'), field('pubDate'), { summary: plain(field('description')) }));
  }
  return rows.filter(Boolean);
}
async function fetchGdelt() {
  const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  url.searchParams.set('query', '(China stock market OR China A-share OR Chinese equities OR Chinese stocks) sourcelang:chinese');
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('format', 'json');
  url.searchParams.set('timespan', '1d');
  url.searchParams.set('sort', 'datedesc');
  url.searchParams.set('maxrecords', '50');
  const data = JSON.parse(await get(url.toString()));
  return (Array.isArray(data.articles) ? data.articles : []).map(function (x) {
    return item('gdelt', x.domain || '全球媒体（GDELT）', x.title, x.url, x.seendate, { language: x.language || '' });
  }).filter(Boolean);
}
function clsRows() {
  const data = readJson(CLS_FILE, {});
  return (Array.isArray(data.rows) ? data.rows : []).map(function (x) {
    return item('cls', '财联社', x.title, x.url, x.time, { id: String(x.articleId || x.id || x.url), prefix: x.prefix || '' });
  }).filter(Boolean);
}
function key(x) { return x.source === 'sina' && x.id ? x.id : String(x.url || '').replace(/[?#].*$/, '').toLowerCase() || String(x.title || '').toLowerCase(); }
async function update() {
  fs.mkdirSync(OUT, { recursive: true });
  const old = readJson(FILE, { rows: [] });
  const sourceResults = await Promise.all([
    ['新浪财经7×24', fetchSina], ['新华网财经RSS', fetchXinhua], ['GDELT跨站检索', fetchGdelt]
  ].map(async function (pair) {
    try { const rows = await pair[1](); return { name: pair[0], ok: true, rows: rows, count: rows.length }; }
    catch (e) { console.warn(pair[0] + '采集失败：' + String(e && e.message || e)); return { name: pair[0], ok: false, rows: [], count: 0, error: String(e && e.message || e).slice(0, 180) }; }
  }));
  const now = Date.now();
  const cls = clsRows();
  const all = [].concat(Array.isArray(old.rows) ? old.rows : [], cls, ...sourceResults.map(function (x) { return x.rows; }));
  const seen = new Set(), rows = all.filter(function (x) {
    if (!x || !x.title || !x.url || !x.time) return false;
    const ms = parseTime(x.time.replace(' ', 'T') + '+08:00');
    if (!Number.isFinite(ms) || ms < now - MAX_AGE_MS || ms > now + 5 * 60 * 1000) return false;
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort(function (a, b) { return String(b.time).localeCompare(String(a.time)); }).slice(0, 500);
  const output = { updatedAt: localTime(now), sources: [{ name: '财联社看板', ok: true, count: cls.length }].concat(sourceResults.map(function (x) { return { name: x.name, ok: x.ok, count: x.count, error: x.error || '' }; })), rows: rows };
  fs.writeFileSync(FILE, JSON.stringify(output), 'utf8');
  console.log('多来源新闻更新 ' + output.updatedAt + ' ｜ ' + output.sources.map(function (x) { return x.name + ':' + x.count + (x.ok ? '' : '(沿用缓存)'); }).join(' ｜ ') + ' ｜ 合并留存 ' + rows.length + ' 条');
}
if (require.main === module) update().catch(function (e) { console.error('多来源新闻聚合失败：' + (e && e.stack || e)); process.exitCode = 1; });
module.exports = { update: update, localTime: localTime };
