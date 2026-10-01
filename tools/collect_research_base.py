"""Collect public A-share research summaries through levistock."""
import datetime as dt, json, os
OUT="data/research-base.json"
def norm(v):
    if hasattr(v,"to_dict"): v=v.to_dict(orient="records")
    if isinstance(v,dict): return {str(k):norm(x) for k,x in v.items()}
    if isinstance(v,(list,tuple)): return [norm(x) for x in v]
    return v if isinstance(v,(str,int,float,bool)) or v is None else str(v)
def main():
    errors=[]; out={}
    try: import levistock as lk
    except Exception as e: errors.append("levistock import: "+str(e)); lk=None
    for key,name in {"market_emotion":"market_emotion_cls","market_wind":"market_wind_cls","mainline":"market_mainline_cls","sector_industry":"sector_industry_cls","limit_up":"stock_zt_pool_cls","telegraph":"news_telegraph_cls"}.items():
        try:
            out[key]=norm(getattr(lk,name)()) if lk else []
            if key in ("mainline", "telegraph"): out[key]=flatten_items(out[key])
            if key in ("market_wind", "sector_industry", "limit_up"): out[key]=normalize_percent_fields(out[key])
        except Exception as e: out[key]=[]; errors.append(key+": "+str(e))
    out["ashare"] = collect_ashare(errors)
    out["hithink"] = collect_hithink(errors)
    out.update(generated_at=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds"),trade_date=dt.date.today().isoformat(),errors=errors)
    os.makedirs("data",exist_ok=True)
    with open(OUT,"w",encoding="utf-8") as f: json.dump(out,f,ensure_ascii=False,separators=(",",":"))
def collect_ashare(errors):
    try:
        import Ashare
        data = Ashare.get_price(code="sh.000001", frequency="1d", count=30)
        if hasattr(data, "tail"): data = data.tail(10).reset_index().to_dict(orient="records")
        rows = norm(data)
        if rows:
            return rows
        raise RuntimeError("Ashare 返回空数据")
    except Exception as e:
        errors.append("ashare: "+str(e))
        # Ashare 历史接口偶尔被上游限流；用本轮已采集的指数快照兜底，避免页面空白。
        try:
            with open("data/market.json", encoding="utf-8") as f: market = json.load(f)
            index = next((x for x in market.get("indexes", []) if x.get("code") == "sh000001"), None)
            if index and index.get("px") is not None:
                return [{"date": market.get("updatedAt", "")[:10], "open": None,
                         "close": index.get("px"), "high": None, "low": None,
                         "pct": index.get("pct"), "source": "market.json 实时快照兜底"}]
        except Exception as fallback_error:
            errors.append("ashare fallback: "+str(fallback_error))
        return []

def collect_hithink(errors):
    key = os.environ.get("HITHINK_FINANCE_API_KEY")
    if not key:
        return {"configured": False, "message": "等待 HITHINK_FINANCE_API_KEY"}
    try:
        import urllib.parse, urllib.request
        base = os.environ.get("HITHINK_API_URL", "https://fuyao.aicubes.cn/api/a-share/prices/snapshot")
        url = base + ("&" if "?" in base else "?") + urllib.parse.urlencode({"thscodes": "600519.SH"})
        req = urllib.request.Request(url, headers={"X-api-key": key, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as res:
            payload = json.loads(res.read().decode("utf-8"))
        return {"configured": True, "message": "API 调用成功", "sample": norm(payload)}
    except Exception as e:
        errors.append("hithink: "+str(e))
        return {"configured": True, "message": "API 调用失败", "sample": {}}

def flatten_items(value):
    if isinstance(value,list):
        out=[]
        for x in value:
            if isinstance(x,dict): out.extend(flatten_items(x))
            elif str(x).strip(): out.append(x)
        return out
    if isinstance(value,dict):
        # 接口返回的单条记录本身就是字典；不要把字段名误当成新闻标题。
        record_keys={"title","headline","content","text","name","stock_name","secu_name","mainLine_desc","chance_desc","style_desc","url","link"}
        if record_keys.intersection(value): return [value]
        out=[]
        for k,v in value.items():
            if isinstance(v,list): out.extend(flatten_items(v))
            elif isinstance(v,dict): out.extend(flatten_items(v))
            elif str(v).strip(): out.append({"title":str(k),"content":str(v)})
        return out
    return []

def normalize_percent_fields(value):
    if not isinstance(value,list): return value
    out=[]
    for item in value:
        if not isinstance(item,dict): out.append(item); continue
        row=dict(item)
        for key in ("change_pct","changePercent","pct","change"):
            if isinstance(row.get(key),(int,float)) and abs(row[key]) <= 1: row[key]=row[key]*100
        out.append(row)
    return out

if __name__=="__main__": main()
