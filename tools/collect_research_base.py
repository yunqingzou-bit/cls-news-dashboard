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
        try: out[key]=norm(getattr(lk,name)()) if lk else []
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
        return norm(data)
    except Exception as e:
        errors.append("ashare: "+str(e))
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

if __name__=="__main__": main()
