'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./collect.js');

const OUT_DIR = path.join(ROOT, 'out');

const PREFIX_WEIGHT = {
  '明日主题前瞻': 20,
  '财联社早知道': 19,
  '风口研报·洞察': 18,
  '风口研报·公司': 17,
  '机构调研': 16,
  '电报解读': 14,
  '盘中宝': 13,
  '公告全知道': 12,
  '金牌纪要库': 11,
  '研选': 10,
  '点金互动易': 9,
  '数据看盘': 8,
  '机构龙虎榜解读': 8,
  '狙击龙虎榜': 6,
  '狙击龙虎榜午盘': 6,
  'VIP日报': 6,
};

const POSITIVE_WORDS = [
  '规划', '政策', '标准', '发布', '停产', '涨价', '调价', '订单', '供不应求',
  '缺口', '量产', '投产', '商业化', '出货', '采购', '供给', '需求', '国产替代',
  '合作', '认证', '放量', '加码', '景气', '批量', '续签', '主流',
];

const NEGATIVE_WORDS = [
  '利空', '下滑', '承压', '混沌', '缺失', '缩容', '风险', '压制', '减持',
  '停牌', '不具备持续性', '不确定', '降温', '流出',
];

const TOPIC_RULES = [
  [['3D原生', '世界模型', '空间智能'], '空间智能'],
  [['词元', 'Token', '超节点', 'AI算力', '算力'], 'AI算力'],
  [['1.6T', '800G', '光模块', '光通信', '光纤', 'CPO'], '高速光通信'],
  [['PCB', '覆铜板', '电子布', '铜箔', '陶瓷基板', 'M10', '先进封装'], 'AI硬件材料'],
  [['MLCC', '模拟芯片', '村田', '被动元件'], 'MLCC与模拟芯片'],
  [['液冷', '氟化液', '温控液', '波纹管', '散热'], 'AI液冷'],
  [['脑机接口'], '脑机接口'],
  [['人工智能安全', 'AI安全', '模型安全', '安全治理', '网络安全'], 'AI安全'],
  [['人形机器人', '机器人', '电子皮肤', '具身智能'], '人形机器人'],
  [['稀散金属', '磷化铟', 'MFC', '压电陶瓷'], '半导体材料'],
  [['固态电池', '储能', '逆变器'], '新能源'],
  [['机床', '数控'], '工业自动化'],
  [['军工', '军贸', '武器'], '国防军工'],
];

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function countHits(text, words) {
  return words.reduce((n, word) => n + (text.includes(word) ? 1 : 0), 0);
}

function topicOf(text) {
  for (const [words, topic] of TOPIC_RULES) {
    if (words.some((word) => text.includes(word))) return topic;
  }
  return '其他产业与市场';
}

function normalizedTitle(title) {
  return clean(title)
    .replace(/^【[^】]+】\s*/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function impactOf(text, prefix) {
  const positive = countHits(text, POSITIVE_WORDS);
  const negative = countHits(text, NEGATIVE_WORDS);
  if (negative >= 2 && negative > positive) return { direction: '偏谨慎', level: '风险提示' };
  if (positive >= 3 && positive > negative + 1) return { direction: '偏利好', level: '强催化' };
  if (positive > negative) return { direction: '偏利好', level: '中催化' };
  if (negative > positive) return { direction: '偏谨慎', level: '风险提示' };
  if (prefix === '数据看盘' || prefix.indexOf('龙虎榜') >= 0) return { direction: '分化', level: '资金验证' };
  return { direction: '分化', level: '观察' };
}

function impactSummary(item) {
  const topic = item.topic;
  if (item.impactDirection === '偏利好') {
    return `${topic}出现${item.impactLevel === '强催化' ? '政策、供给或订单层面的强催化' : '产业趋势或公司进展催化'}，短线关注度提升；仍需跟踪订单、认证、产能和业绩兑现。`;
  }
  if (item.impactDirection === '偏谨慎') {
    return `${topic}出现分歧或风险提示，可能压制短线持续性；不宜只根据题材追高，重点观察成交量、资金承接和后续公告。`;
  }
  if (item.impactLevel === '资金验证') {
    return `${topic}有资金异动或板块表现，但这属于交易层面的验证，不等同于基本面改善；关注次日承接和扩散范围。`;
  }
  return `${topic}有一定催化，但信息强度或传导路径仍不完整；等待订单、客户认证、政策细则或业绩数据进一步确认。`;
}

function curate(rows, options = {}) {
  const days = Number(options.days || 3);
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const groups = new Map();

  for (const row of rows || []) {
    if (!row || !row.ctime || row.ctime < cutoff) continue;
    if (row.prefix === '龙虎榜') continue;
    const key = normalizedTitle(row.title) || String(row.articleId || row.id || '').replace(/#.*$/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const items = [];
  for (const group of groups.values()) {
    const first = group.slice().sort((a, b) => b.ctime - a.ctime)[0];
    const titleText = group.map((r) => r.title || '').join(' ');
    const allText = group.map((r) => `${r.title || ''} ${r.text || ''}`).join(' ');
    const stockRows = group.slice().sort((a, b) => Math.abs(Number(b.changePct || 0)) - Math.abs(Number(a.changePct || 0)));
    const stocks = unique(stockRows.map((r) => r.stockName || r.stock).map(clean));
    const stockCodes = unique(stockRows.map((r) => r.stockCode).map(clean));
    const maxChange = stockRows.reduce((max, r) => Math.max(max, Number(r.changePct || 0)), null);
    const prefixWeight = PREFIX_WEIGHT[first.prefix] || 5;
    const breadth = Math.min(stocks.length, 12) * 0.8;
    const positive = countHits(allText, POSITIVE_WORDS);
    const negative = countHits(allText, NEGATIVE_WORDS);
    const marketMove = Math.min(Math.abs(Number(maxChange || 0)), 20) / 4;
    const score = Number((prefixWeight + breadth + positive * 1.5 - negative * 0.8 + marketMove).toFixed(1));
    const impact = impactOf(allText, first.prefix || '');
    const item = {
      id: String(first.articleId || first.id || ''),
      time: first.time,
      ctime: first.ctime,
      prefix: first.prefix || '',
      title: clean(first.title),
      summary: clean(first.text || first.brief || first.title),
      stocks: stocks.slice(0, 12),
      stockCodes: stockCodes.slice(0, 12),
      stockCount: stocks.length,
      url: first.url || `https://www.cls.cn/detail/${first.articleId || first.id}`,
      topic: topicOf(titleText),
      score,
      impactDirection: impact.direction,
      impactLevel: impact.level,
      maxChange,
      source: '财联社 cls.cn',
    };
    item.impactSummary = impactSummary(item);
    items.push(item);
  }

  items.sort((a, b) => b.score - a.score || b.ctime - a.ctime);
  return items.slice(0, Number(options.limit || 20)).map((item, index) => ({ ...item, rank: index + 1 }));
}

function write(rows, meta, options = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const days = Number(options.days || 3);
  const items = curate(rows, { days, limit: options.limit || 20 });
  const from = new Date(Date.now() - days * 86400000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const to = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const payload = {
    meta: {
      title: '财联社新闻精选20',
      range: `${from} ~ ${to}`,
      generatedAt: new Date().toISOString(),
      generatedAtShanghai: new Date().toISOString(),
      source: '财联社 cls.cn',
      selection: `近${days}天去重后按政策、产业催化、供需变化、订单/认证、关联股票广度和市场验证综合排序`,
      count: items.length,
    },
    items,
  };
  const file = path.join(OUT_DIR, 'top20.json');
  fs.writeFileSync(file, JSON.stringify(payload, null, 1), 'utf8');
  return { file, items };
}

module.exports = { curate, write };
