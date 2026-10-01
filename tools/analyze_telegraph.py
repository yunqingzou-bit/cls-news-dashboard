"""Analyze levistock telegraph data for the dashboard."""
import json, os, re
from collections import Counter, defaultdict

IN="data/research-base.json"; OUT="data/telegraph-analysis.json"
SECTORS={
 'A股市场':['上证','深证','创业板','科创板','A股','涨停','跌停','成交'],
 '科技/互联网':['人工智能','AI','芯片','半导体','通信','云计算','软件','机器人'],
 '能源':['原油','石油','天然气','煤炭','光伏','风电','氢能','锂电','储能','核电'],
 '金融':['银行','保险','券商','证券','期货','利率','LPR','央行'],
 '消费':['消费','零售','汽车','房地产','食品','旅游','酒店'],
 '医药健康':['医药','医疗','创新药','疫苗','医院'],
 '政策法规':['政策','监管','处罚','调查','法规','审计']}
POS=['上涨','增长','提升','改善','利好','超预期','合作','并购','突破','创新','中标']
NEG=['下跌','下滑','恶化','不及预期','利空','暴跌','处罚','调查','限制','风险','亏损']
def text(x): return ' '.join(str(x.get(k,'')) for k in ('headline','title','content','text','category','tags') if x.get(k) is not None)
def main():
    try:
        src=json.load(open(IN,encoding='utf-8')); items=src.get('telegraph',[])
    except Exception: items=[]
    hours=defaultdict(list); sector=Counter(); sentiment=Counter(); stocks=Counter()
    for x in items:
        s=text(x); hour=str(x.get('time') or x.get('timestamp') or '未知')[:13]
        hours[hour].append(x)
        matched=[k for k,v in SECTORS.items() if any(w.lower() in s.lower() for w in v)] or ['其他']
        for k in matched: sector[k]+=1
        p=sum(w.lower() in s.lower() for w in POS); n=sum(w.lower() in s.lower() for w in NEG)
        sentiment['positive' if p>n else 'negative' if n>p else 'neutral']+=1
        for code in re.findall(r'\b\d{6}\.(?:SH|SZ|BJ|HK)\b|\b[036]\d{5}\b',s): stocks[code]+=1
    top_sector=sector.most_common(1)[0] if sector else ('其他',0)
    level='重大' if len(items)>10 and top_sector[1]>10 else '重要' if len(items)>=5 or top_sector[1]>=5 else '一般'
    out={'generated_at':src.get('generated_at'),'trade_date':src.get('trade_date'),'total':len(items),'hourly':[{'hour':k,'count':len(v)} for k,v in sorted(hours.items())], 'sectors':dict(sector.most_common()),'sentiment':dict(sentiment),'top_stocks':[{'code':k,'mentions':v} for k,v in stocks.most_common(20)],'impact_level':level,'note':'基于关键词分类与情绪规则，仅供研究参考'}
    os.makedirs('data',exist_ok=True); json.dump(out,open(OUT,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
if __name__=='__main__': main()
