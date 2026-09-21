'use strict';
/**
 * Stockbee 页面渲染：三个视图
 *   今日精选   当天多因子选出的 ≤N 只（默认 20）
 *   精选回溯   同一套规则套在过去每个交易日的结果，和「全部信号」基准对比
 *   全部信号   改造前的原始信号表（4% 突破 + 评分≥70），保留用于查证和人工翻看
 * 纯静态：只读同目录的 stockbee.json，不改动任何数据。
 */

function renderHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0f172a">
<title>Stockbee 动量爆发 · A股精选（每日≤20）与全部信号</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--line:#e5e7eb;--ink:#1b1f24;--dim:#7a8290;--up:#d92b2b;--down:#0f9d58;--brand:#0f172a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 "Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:var(--brand);color:#fff;padding:14px 16px 12px}
h1{font-size:17px;margin:0;font-weight:600}
.sub{font-size:12px;opacity:.82;margin-top:4px}
.wrap{padding:12px 10px 40px;max-width:1500px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
.card .k{font-size:11.5px;color:var(--dim)}
.card .v{font-size:19px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}
.panel{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:10px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
select,input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);max-width:100%}
input[type=search]{min-width:170px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.tab{border:1px solid var(--line);background:#fff;border-radius:999px;padding:4px 11px;font-size:12.5px;cursor:pointer}
.tab.on{background:var(--brand);color:#fff;border-color:var(--brand)}
.tabs-main{display:flex;gap:8px;margin-bottom:10px}
.tm{flex:1;border:1px solid var(--line);background:#fff;border-radius:8px;padding:9px 6px;font-size:14px;font-weight:600;cursor:pointer;color:var(--ink)}
.tm.on{background:var(--brand);color:#fff;border-color:var(--brand)}
.scroll{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:auto;max-height:76vh}
table{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px;white-space:nowrap}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}
th{position:sticky;top:0;background:#f0f2f5;z-index:3;font-weight:600;cursor:pointer;user-select:none}
th.c,td.c{text-align:center}
th.l,td.l{text-align:left}
td.name,th.name{position:sticky;left:0;background:#fff;z-index:2}
th.name{background:#f0f2f5;z-index:4}
tr:hover td{background:#fafbfc}
tr:hover td.name{background:#fafbfc}
.up{color:var(--up)}
.down{color:var(--down)}
.tag{display:inline-block;font-size:11.5px;border-radius:4px;padding:1px 6px;background:#eef2f7;color:#33415c}
.rA{background:#fde8e8;color:#b91c1c}
.rAm{background:#fdeede;color:#b45309}
.rB{background:#e8f2fd;color:#1d4ed8}
.rW{background:#eef0f3;color:#4b5563}
.rL{background:#fde8e8;color:#b91c1c}
.muted{color:var(--dim)}
.stock-link{color:#1d4ed8;text-decoration:none}
.stock-link:hover{text-decoration:underline}
.foot{font-size:12px;color:var(--dim);margin-top:10px;line-height:1.8}
.more{display:block;margin:10px auto 0;padding:9px 18px;border-radius:8px;border:1px solid var(--line);background:#fff;cursor:pointer}
.h2{font-size:14px;font-weight:600;margin:0 0 8px}
.bar{height:6px;border-radius:3px;background:#eef2f7;overflow:hidden;min-width:42px}
.bar i{display:block;height:100%;background:#2563eb}
@media (max-width:640px){h1{font-size:15.5px}.card .v{font-size:16.5px}th,td{padding:6px 7px}.tm{font-size:13px}}
</style>
</head>
<body>
<header>
  <h1>Stockbee 动量爆发 · A股精选与全部信号</h1>
  <div class="sub" id="meta">加载中…</div>
</header>
<div class="wrap">
  <div class="tabs-main" id="tabsMain">
    <button class="tm on" data-t="pick">今日精选</button>
    <button class="tm" data-t="hist">精选回溯</button>
    <button class="tm" data-t="all">全部信号</button>
  </div>
  <div class="cards" id="cards"></div>

  <section id="secPick">
    <div class="panel">
      <div class="row">
        <b id="pickTitle">—</b>
        <span class="muted" id="pickMarket"></span>
        <button class="tab" id="pickCompact">仅核心列</button>
        <span class="muted" id="pickCount"></span>
      </div>
    </div>
    <div class="scroll"><table id="pickTbl"><thead></thead><tbody></tbody></table></div>
    <div class="foot" id="pickNote"></div>
  </section>

  <section id="secHist" hidden>
    <div class="panel" id="btPanel"></div>
    <div class="foot" style="margin:0 0 10px">上表：精选 vs 全部信号，按交易日逐日对比（5 日累计收益，仅统计已走完 5 个交易日的样本）。下表：历史精选个股明细。</div>
    <div class="scroll"><table id="btTbl"><thead></thead><tbody></tbody></table></div>
    <div class="scroll" style="margin-top:10px"><table id="histTbl"><thead></thead><tbody></tbody></table></div>
    <button class="more" id="histMore">显示更多</button>
  </section>

  <section id="secAll" hidden>
    <div class="panel">
      <div class="row">
        <input type="search" id="q" placeholder="搜索代码 / 名称">
        <select id="from"></select>
        <select id="to"></select>
        <select id="rating">
          <option value="">全部评级</option>
          <option value="A">A（90+）</option>
          <option value="A-">A-（80-89）</option>
          <option value="B">B（70-79）</option>
        </select>
        <select id="minScore">
          <option value="0">评分不限</option>
          <option value="70">评分 ≥70</option>
          <option value="80">评分 ≥80</option>
          <option value="90">评分 ≥90</option>
        </select>
        <select id="complete">
          <option value="">样本不限</option>
          <option value="done">仅完整 5 日样本</option>
          <option value="pending">仅待更新</option>
        </select>
        <button class="tab" id="compact">仅核心列</button>
        <span class="muted" id="count"></span>
      </div>
      <div class="tabs" id="patterns"></div>
    </div>
    <div class="scroll"><table id="tbl"><thead></thead><tbody></tbody></table></div>
    <button class="more" id="more">显示更多</button>
    <div class="foot" id="foot"></div>
  </section>
</div>
<script>
(function(){
  var PAYLOAD=null, ROWS=[], PICKS=null, HISTORY=[], BT=null, TAB='pick';
  var PICK_COMPACT=true, HIST_SHOWN=200;
  var VIEW=[], PATTERN='', SHOWN=150, COMPACT=false;
  var SORT={k:'total',dir:-1};

  var PICK_COLS=[
    {k:'rank',t:'#',c:'c'},{k:'code',t:'代码',c:'c'},{k:'name',t:'名称',c:'l',sticky:1},
    {k:'board',t:'所属板块',c:'l'},{k:'total',t:'综合分',p:1,b:1},{k:'form',t:'突破形态',p:1},
    {k:'trend',t:'走势技术形态',p:1},{k:'mom',t:'动量',p:1},{k:'theme',t:'题材热度',p:1},
    {k:'mkt',t:'市场',p:1},{k:'risk',t:'风险',p:1},{k:'dayGain',t:'当日涨幅',p:2,suf:'%',b:1},
    {k:'vr20',t:'量比20日',p:2,suf:'x'},{k:'mom20',t:'20日动量',p:1,suf:'%',b:1},
    {k:'mom5',t:'5日动量',p:1,suf:'%',b:1},{k:'dist60',t:'距60日高',p:1,suf:'%'},
    {k:'rs20',t:'相对强度',p:1,suf:'%',b:1},{k:'rsi14',t:'RSI14',p:1},
    {k:'maStack',t:'均线条数',c:'c'},{k:'amountYi',t:'成交额(亿)',p:2},
    {k:'close',t:'收盘'},{k:'low',t:'止损参考'},{k:'riskPct',t:'风险',p:1,suf:'%'},
    {k:'score',t:'信号分',c:'c'},{k:'cum5',t:'5日累计',p:1,suf:'%',b:1}
  ];
  var PICK_CORE=['rank','code','name','board','total','trend','mom','theme','dayGain','cum5'];

  var COLS=[
    {k:'date',t:'日期',c:'c'},{k:'code',t:'代码',c:'c'},{k:'name',t:'名称',c:'l',sticky:1},
    {k:'pattern',t:'形态',c:'l'},{k:'dayGain',t:'当日涨幅',p:1},{k:'t1',t:'T+1',p:1},{k:'t2',t:'T+2',p:1},
    {k:'t3',t:'T+3',p:1},{k:'t4',t:'T+4',p:1},{k:'t5',t:'T+5',p:1},{k:'cum5',t:'5日累计',p:1,b:1},
    {k:'winRate',t:'五日胜率',suf:'%'},{k:'score',t:'评分',b:1},{k:'rating',t:'评级',c:'c'},
    {k:'close',t:'收盘价'},{k:'low',t:'止损参考'},{k:'riskPct',t:'风险',p:1,suf:'%'},
    {k:'vr1',t:'量比(昨)',suf:'x'},{k:'vr20',t:'量比(20日)',suf:'x'},{k:'closeLoc',t:'收盘位置',p:1,suf:'%'},
    {k:'maStack',t:'均线条数',c:'c'},{k:'rsi14',t:'RSI14',p:1},{k:'mom20',t:'20日动量',p:1,suf:'%'},
    {k:'baseDays',t:'基底天数'},{k:'baseWidth',t:'基底宽度',p:1,suf:'%'},{k:'volume',t:'成交量(手)'},{k:'gate',t:'市场闸门',c:'c'}
  ];
  var CORE=['date','code','name','pattern','dayGain','t1','cum5','score'];

  function fmt(v,c){
    if(v===null||v===undefined) return '<span class="muted">—</span>';
    if(typeof v==='number'){
      var s=c.p?v.toFixed(c.p):String(v);
      var cls=(c.b&&v>0)?'up':(c.b&&v<0)?'down':'';
      return '<span class="'+cls+'">'+s+(c.suf||'')+'</span>';
    }
    return String(v);
  }
  function txUrl(code){ return 'https://gu.qq.com/'+encodeURIComponent(code||''); }
  function stockLink(code,name,title){
    return '<a class="stock-link" href="'+txUrl(code)+'" target="_blank" rel="noopener noreferrer" title="'+(title||'在腾讯自选股查看行情与K线')+'">'+(name||code||'')+'</a>';
  }
  function rcls(r){ return r==='A'?'rA':r==='A-'?'rAm':r==='B'?'rB':'rW'; }
  function card(k,v){ return '<div class="card"><div class="k">'+k+'</div><div class="v">'+(v===null||v===undefined?'—':v)+'</div></div>'; }
  function bar(v,max){
    var pct=max>0?Math.max(0,Math.min(100,v/max*100)):0;
    return '<span class="bar"><i style="width:'+pct.toFixed(0)+'%"></i></span>';
  }
  function setTab(t){
    TAB=t;
    Array.prototype.forEach.call(document.querySelectorAll('#tabsMain .tm'),function(b){ b.classList.toggle('on',b.getAttribute('data-t')===t); });
    document.getElementById('secPick').hidden = t!=='pick';
    document.getElementById('secHist').hidden = t!=='hist';
    document.getElementById('secAll').hidden = t!=='all';
    renderCards();
    if(t==='pick') renderPick();
    else if(t==='hist') renderHist();
    else renderAll();
  }
  function renderCards(){
    var s=(PAYLOAD&&PAYLOAD.stats)||{}, P=(PICKS&&PICKS.rows)||[], t=PAYLOAD&&PAYLOAD.picks&&PAYLOAD.picks.theme?PAYLOAD.picks.theme:{};
    var html='';
    if(TAB==='pick'){
      var mk=(PICKS&&PICKS.market)||{};
      var known=P.filter(function(p){return p.themeKnown;}).length;
      html=[card('精选数量',P.length),card('当日信号数',(PAYLOAD&&PAYLOAD.stats?countOnDay(PICKS&&PICKS.day):null)),
        card('市场闸门',mk.gate||'—'),card('上涨家数',mk.up===undefined?'—':mk.up),
        card('下跌家数',mk.down===undefined?'—':mk.down),card('涨幅≥4%家数',mk.brk4===undefined?'—':mk.brk4),
        card('题材覆盖',P.length?known+'/'+P.length:'—')].join('');
    } else if(TAB==='hist'){
      var b=BTT(), p=b.picks||{}, bs=b.baseline||{};
      html=[card('精选样本',p.n),card('精选5日均值',p.avg5===undefined?'—':p.avg5+'%'),
        card('精选正收益率',p.winRate5d===undefined?'—':p.winRate5d+'%'),card('精选中位数',p.median5===undefined?'—':p.median5+'%'),
        card('基准5日均值',bs.avg5===undefined?'—':bs.avg5+'%'),card('基准正收益率',bs.winRate5d===undefined?'—':bs.winRate5d+'%'),
        card('超额均值',b.edgeAvg5===undefined?'—':b.edgeAvg5+'pp'),card('精选最差',p.worst5===undefined?'—':p.worst5+'%')].join('');
    } else {
      html=[card('信号数',s.signals),card('涉及股票',s.stocks),card('完整5日样本',s.complete),
        card('5日累计均值',s.avg5===null||s.avg5===undefined?'—':s.avg5+'%'),card('5日中位数',s.median5===null||s.median5===undefined?'—':s.median5+'%'),
        card('5日正收益率',s.winRate5d===null||s.winRate5d===undefined?'—':s.winRate5d+'%'),card('单日胜率',s.dayWinRate===null||s.dayWinRate===undefined?'—':s.dayWinRate+'%')].join('');
    }
    document.getElementById('cards').innerHTML=html;
  }
  function countOnDay(day){
    if(!day) return null;
    var n=0;
    for(var i=0;i<ROWS.length;i++) if(ROWS[i].date===day) n++;
    return n;
  }
  function BTT(){ return (PAYLOAD&&PAYLOAD.picks&&PAYLOAD.picks.backtest)||{}; }
  function renderPick(){
    var P=(PICKS&&PICKS.rows)||[];
    var cols=PICK_COLS.filter(function(c){ return !PICK_COMPACT||PICK_CORE.indexOf(c.k)>=0; });
    document.getElementById('pickTitle').textContent=(PICKS&&PICKS.day?PICKS.day+' 精选':'精选')+(P.length?'（'+P.length+' 只）':'');
    var mk=(PICKS&&PICKS.market)||{};
    document.getElementById('pickMarket').textContent=mk.gate?'市场闸门：'+mk.gate+(mk.upRatio!==null&&mk.upRatio!==undefined?'　上涨占比 '+mk.upRatio+'%':''):'';
    var pc=(PAYLOAD&&PAYLOAD.picks&&PAYLOAD.picks.coverage)||{};
    document.getElementById('pickCount').textContent='候选池 '+(pc.candidates===undefined?'—':pc.candidates)+' 只 / '+(pc.days===undefined?'—':pc.days)+' 个交易日';
    document.getElementById('pickTbl').querySelector('thead').innerHTML='<tr>'+cols.map(function(c){
      var cls=c.c==='l'?'l':c.c==='c'?'c':'';
      if(c.sticky) cls+=' name';
      return '<th class="'+cls+'" data-k="'+c.k+'">'+c.t+(SORT.k===c.k?(SORT.dir>0?' ▲':' ▼'):'')+'</th>';
    }).join('')+'</tr>';
    var rows=P.slice().sort(function(a,b){
      var x=a[SORT.k],y=b[SORT.k];
      if(x===null||x===undefined) return 1;
      if(y===null||y===undefined) return -1;
      if(typeof x==='string') return SORT.dir*x.localeCompare(y);
      return SORT.dir*(x-y);
    });
    document.getElementById('pickTbl').querySelector('tbody').innerHTML=rows.map(function(r){
      return '<tr>'+cols.map(function(c){
        var cls=c.c==='l'?'l':c.c==='c'?'c':'';
        if(c.sticky) cls+=' name';
        if(c.k==='name'){
          return '<td class="'+cls+'" title="'+r.pattern+'">'+stockLink(r.code,r.name,'在腾讯自选股查看行情与K线')+(r.limitUp?' <span class="tag rL">涨停</span>':'')+'</td>';
        }
        if(c.k==='board') return '<td class="'+cls+'" title="行业：'+(r.industry||'—')+'">'+(r.board||'<span class="muted">未知</span>')+(r.themeKnown?'':' <span class="tag rW">题材未知</span>')+'</td>';
        if(c.k==='total') return '<td class="'+cls+'"><b>'+r.total.toFixed(1)+'</b> <span class="muted">'+bar(r.total,100)+'</span></td>';
        if(c.k==='cum5'){
          if(!r.complete) return '<td class="'+cls+'"><span class="tag rW">待观察</span></td>';
          return '<td class="'+cls+'">'+fmt(r.cum5,{p:1,suf:'%',b:1})+'</td>';
        }
        if(c.k==='score') return '<td class="'+cls+'"><span class="tag '+rcls(r.score>=90?'A':r.score>=80?'A-':'B')+'">'+r.score+'</span></td>';
        return '<td class="'+cls+'">'+fmt(r[c.k],c)+'</td>';
      }).join('')+'</tr>';
    }).join('');
    document.getElementById('pickNote').innerHTML=((PAYLOAD&&PAYLOAD.pickNote)||'')+'<br>因子满分：突破形态20 + 走势技术形态25 + 动量大小25 + 题材热度20 + 市场环境5 + 风险可执行5 = 100。';
  }
  function renderHist(){
    var b=BTT(), days=b.days||[], p=b.picks||{}, bs=b.baseline||{};
    document.getElementById('btPanel').innerHTML='<div class="h2">精选 vs 全部信号（同一窗口、同一套 5 日口径）</div>'+
      '<div class="foot" style="margin:0">精选 '+((p.n===undefined)?'—':p.n)+' 个样本：5 日累计均值 <b>'+((p.avg5===undefined)?'—':p.avg5+'%')+'</b>，中位数 '+((p.median5===undefined)?'—':p.median5+'%')+'，正收益率 <b>'+((p.winRate5d===undefined)?'—':p.winRate5d+'%')+'</b>，最好 '+((p.best5===undefined)?'—':p.best5+'%')+'，最差 '+((p.worst5===undefined)?'—':p.worst5+'%')+'<br>'+
      '全部信号基准 '+((bs.n===undefined)?'—':bs.n)+' 个样本：均值 '+((bs.avg5===undefined)?'—':bs.avg5+'%')+'，正收益率 '+((bs.winRate5d===undefined)?'—':bs.winRate5d+'%')+'<br>'+
      '超额：均值 '+((b.edgeAvg5===undefined)?'—':b.edgeAvg5+' 个百分点')+'，正收益率 '+((b.edgeWinRate===undefined)?'—':b.edgeWinRate+' 个百分点')+'</div>';
    var bcols=[{k:'date',t:'日期',c:'c'},{k:'n',t:'精选数',c:'c'},{k:'avg5',t:'精选5日均值',p:2,suf:'%',b:1},{k:'winRate5d',t:'精选正收益率',p:1,suf:'%'},{k:'baseN',t:'基准样本数',c:'c'},{k:'baseAvg5',t:'基准5日均值',p:2,suf:'%',b:1},{k:'baseWinRate5d',t:'基准正收益率',p:1,suf:'%'},{k:'edge',t:'超额',p:2,suf:'pp',b:1}];
    document.getElementById('btTbl').querySelector('thead').innerHTML='<tr>'+bcols.map(function(c){ return '<th class="'+(c.b?'':c.c)+'">'+c.t+'</th>'; }).join('')+'</tr>';
    document.getElementById('btTbl').querySelector('tbody').innerHTML=days.map(function(d){
      return '<tr>'+bcols.map(function(c){ return '<td>'+fmt(d[c.k],c)+'</td>'; }).join('')+'</tr>';
    }).join('');
    var hcols=[{k:'date',t:'日期',c:'c'},{k:'rank',t:'#',c:'c'},{k:'code',t:'代码',c:'c'},{k:'name',t:'名称',c:'l'},{k:'board',t:'所属板块',c:'l'},{k:'total',t:'综合分',p:1},{k:'trend',t:'走势技术形态',p:1},{k:'mom',t:'动量',p:1},{k:'theme',t:'题材热度',p:1},{k:'dayGain',t:'当日涨幅',p:1,suf:'%',b:1},{k:'cum5',t:'5日累计',p:1,suf:'%',b:1}];
    document.getElementById('histTbl').querySelector('thead').innerHTML='<tr>'+hcols.map(function(c){ return '<th class="'+(c.c==='l'?'l':c.c||'')+'"'+(c.k==='name'?' style="position:sticky;left:0;background:#f0f2f5"':'')+'>'+c.t+'</th>'; }).join('')+'</tr>';
    document.getElementById('histTbl').querySelector('tbody').innerHTML=HISTORY.slice(0,HIST_SHOWN).map(function(r){
      return '<tr>'+hcols.map(function(c){
        if(c.k==='name') return '<td class="l" style="position:sticky;left:0;background:#fff">'+stockLink(r.code,r.name,'在腾讯自选股查看行情与K线')+(r.limitUp?' <span class="tag rL">涨停</span>':'')+'</td>';
        if(c.k==='cum5'&&!r.complete) return '<td><span class="tag rW">待更新</span></td>';
        return '<td class="'+(c.c==='l'?'l':c.c==='c'?'c':'')+'">'+fmt(r[c.k],c)+'</td>';
      }).join('')+'</tr>';
    }).join('');
    document.getElementById('histMore').style.display=HISTORY.length>HIST_SHOWN?'block':'none';
    document.getElementById('histMore').textContent='显示更多（还有 '+(HISTORY.length-HIST_SHOWN)+' 条）';
  }
  function renderAll(){
    var cols=COLS.filter(function(c){ return !COMPACT||CORE.indexOf(c.k)>=0; });
    var q=document.getElementById('q').value.trim().toLowerCase();
    var from=document.getElementById('from').value, to=document.getElementById('to').value;
    var rating=document.getElementById('rating').value, minScore=Number(document.getElementById('minScore').value)||0;
    var complete=document.getElementById('complete').value;
    VIEW=ROWS.filter(function(r){
      if(PATTERN&&r.pattern!==PATTERN) return false;
      if(complete==='done'&&!r.complete) return false;
      if(complete==='pending'&&r.complete) return false;
      if(from&&r.date<from) return false;
      if(to&&r.date>to) return false;
      if(rating&&r.rating!==rating) return false;
      if(r.score<minScore) return false;
      if(q&&(r.code+r.name).toLowerCase().indexOf(q)<0) return false;
      return true;
    });
    VIEW.sort(function(a,b){
      var x=a[SORT.k],y=b[SORT.k];
      if(x===null||x===undefined) return 1;
      if(y===null||y===undefined) return -1;
      if(typeof x==='string') return SORT.dir*x.localeCompare(y);
      return SORT.dir*(x-y);
    });
    document.querySelector('#tbl thead').innerHTML='<tr>'+cols.map(function(c){
      var cls=c.c==='l'?'l':c.c==='c'?'c':'';
      if(c.sticky) cls+=' name';
      return '<th class="'+cls+'" data-k="'+c.k+'">'+c.t+(SORT.k===c.k?(SORT.dir>0?' ▲':' ▼'):'')+'</th>';
    }).join('')+'</tr>';
    document.querySelector('#tbl tbody').innerHTML=VIEW.slice(0,SHOWN).map(function(r){
      return '<tr>'+cols.map(function(c){
        var cls=c.c==='l'?'l':c.c==='c'?'c':'';
        if(c.sticky) cls+=' name';
        if(c.k==='date') return '<td class="'+cls+'">'+r.date+(r.complete?'':' <span class="tag rW">待更新</span>')+'</td>';
        if(c.k==='name') return '<td class="'+cls+'" title="基底 '+r.baseDays+' 天 / 宽 '+r.baseWidth+'%">'+stockLink(r.code,r.name,'在腾讯自选股查看行情与K线')+'</td>';
        if(c.k==='pattern') return '<td class="'+cls+'"><span class="tag">'+r.pattern+'</span></td>';
        if(c.k==='rating') return '<td class="'+cls+'"><span class="tag '+rcls(r.rating)+'">'+r.rating+'</span></td>';
        if(c.k==='winRate') return '<td class="'+cls+'">'+(r.winRate===null?'—':r.winRate+'% <span class="muted">('+r.winDays+'/'+r.haveDays+')</span>')+'</td>';
        return '<td class="'+cls+'">'+fmt(r[c.k],c)+'</td>';
      }).join('')+'</tr>';
    }).join('');
    document.getElementById('count').textContent='命中 '+VIEW.length+' 条 / 共 '+ROWS.length+' 条';
    document.getElementById('more').style.display=VIEW.length>SHOWN?'block':'none';
    document.getElementById('more').textContent='显示更多（还有 '+(VIEW.length-SHOWN)+' 条）';
  }
  function initAll(){
    var s=PAYLOAD.stats||{};
    var dates=Array.from(new Set(ROWS.map(function(r){ return r.date; }))).sort();
    var fo=document.getElementById('from'), toSel=document.getElementById('to');
    toSel.innerHTML=fo.innerHTML='<option value="">全部日期</option>'+dates.map(function(d){ return '<option>'+d+'</option>'; }).join('');
    var pats=Array.from(new Set(ROWS.map(function(r){ return r.pattern; })));
    document.getElementById('patterns').innerHTML='<span class="tab on" data-p="">全部形态</span>'+pats.map(function(p){ return '<span class="tab" data-p="'+p+'">'+p+'</span>'; }).join('');
    document.getElementById('foot').innerHTML=(PAYLOAD.note||'')+
      '<br>按形态统计：'+(s.patterns||[]).map(function(p){ return p.pattern+' '+p.n+' 条，5日正收益 '+(p.winRate===null?'—':p.winRate+'%')+'，均值 '+(p.avg5===null?'—':p.avg5+'%'); }).join('；')+
      '<br>按评级统计：'+(s.ratings||[]).map(function(p){ return p.rating+' '+p.n+' 条，5日正收益 '+(p.winRate===null?'—':p.winRate+'%')+'，均值 '+(p.avg5===null?'—':p.avg5+'%'); }).join('；');
  }
  document.getElementById('tabsMain').addEventListener('click',function(e){
    var t=e.target.closest('.tm'); if(!t) return; setTab(t.getAttribute('data-t'));
  });
  document.getElementById('pickCompact').addEventListener('click',function(){ PICK_COMPACT=!PICK_COMPACT; this.classList.toggle('on',!PICK_COMPACT); this.textContent=PICK_COMPACT?'仅核心列':'展开全部列'; renderPick(); });
  document.getElementById('histMore').addEventListener('click',function(){ HIST_SHOWN+=400; renderHist(); });
  document.querySelector('#pickTbl thead').addEventListener('click',function(e){
    var th=e.target.closest('th'); if(!th) return;
    var k=th.getAttribute('data-k'); if(!k) return;
    if(SORT.k===k) SORT.dir=-SORT.dir; else { SORT.k=k; SORT.dir=-1; }
    renderPick();
  });
  document.querySelector('#tbl thead').addEventListener('click',function(e){
    var th=e.target.closest('th'); if(!th) return;
    var k=th.getAttribute('data-k');
    if(SORT.k===k) SORT.dir=-SORT.dir; else { SORT.k=k; SORT.dir=-1; }
    renderAll();
  });
  document.getElementById('q').addEventListener('input',function(){ SHOWN=150; renderAll(); });
  ['from','to','rating','minScore','complete'].forEach(function(id){ document.getElementById(id).addEventListener('change',function(){ SHOWN=150; renderAll(); }); });
  document.getElementById('patterns').addEventListener('click',function(e){
    var t=e.target.closest('.tab'); if(!t) return;
    PATTERN=t.getAttribute('data-p'); SHOWN=150;
    Array.prototype.forEach.call(this.querySelectorAll('.tab'),function(x){ x.classList.toggle('on',x===t); });
    renderAll();
  });
  document.getElementById('more').addEventListener('click',function(){ SHOWN+=300; renderAll(); });
  document.getElementById('compact').addEventListener('click',function(){ COMPACT=!COMPACT; this.classList.toggle('on',COMPACT); renderAll(); });
  function meta(j){
    var mt='数据更新：'+j.generatedAt+'　窗口：'+j.window.start+' 起　最新交易日：'+j.lastCompleteDay+'　来源：'+j.source;
    if(j.picks&&j.picks.theme&&j.picks.theme.note) mt+='　题材：'+j.picks.theme.note;
    document.getElementById('meta').textContent=mt;
  }
  function apply(j){
    PAYLOAD=j; ROWS=j.rows||[];
    PICKS=(j.picks&&j.picks.rows)?j.picks:null;
    HISTORY=(j.picks&&j.picks.history)||[];
    BT=(j.picks&&j.picks.backtest)||null;
    if(!document.getElementById('foot').innerHTML) initAll();
    meta(j);
    if(TAB==='pick') renderPick(); else if(TAB==='hist') renderHist(); else renderAll();
    renderCards();
  }
  function load(){
    fetch('stockbee.json').then(function(r){ return r.json(); }).then(apply).catch(function(){});
  }
  setTab('pick');
  load();
  setInterval(load,600000);
})();
</script>
</body>
</html>`;
}

module.exports = { renderHtml: renderHtml };
