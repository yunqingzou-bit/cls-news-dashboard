const fs = require('node:fs');
const path = require('node:path');
const report = require('../src/report.js');

const source = 'out/previous-news.json';
if (!fs.existsSync(source)) throw new Error('线上上一版 news.json 不存在，无法兜底渲染');
const payload = JSON.parse(fs.readFileSync(source, 'utf8'));
if (!payload || !Array.isArray(payload.rows) || !payload.meta) {
  throw new Error('线上上一版 news.json 不是看板行数据格式');
}

const out = report.exportAll(payload.rows, payload.meta, {
  fileBase: 'cls-news',
  stamp: false,
  layout: 'table',
  links: [{ href: 'cards/', label: '卡片版' }],
  marketReviewHref: 'https://yunqingzou-bit.github.io/cls-news-dashboard/market-review/',
  alsoCards: true,
  cardsLinks: [{ href: '../', label: '表格版' }],
  outlookHref: 'outlook/',
  boardHref: 'stocks/',
  starsHref: 'stars.json',
});
const publishedAt = Date.now();
fs.writeFileSync(path.join(report.OUT_DIR, 'status.json'), JSON.stringify({
  publishedAt,
  publishedAtShanghai: new Date(publishedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
  range: payload.meta.range,
  poolLabel: payload.meta.poolLabel,
  days: 7,
  rows: payload.rows.length,
  source: 'cached-news',
}, null, 2), 'utf8');
console.log('兜底渲染完成：' + out.htmlPath + ' ｜ ' + out.cardsPath);
