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
    out.update(generated_at=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds"),trade_date=dt.date.today().isoformat(),errors=errors)
    os.makedirs("data",exist_ok=True)
    with open(OUT,"w",encoding="utf-8") as f: json.dump(out,f,ensure_ascii=False,separators=(",",":"))
if __name__=="__main__": main()
