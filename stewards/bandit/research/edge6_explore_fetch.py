"""READ-ONLY: 5m USD bars around each scored ledger pass (in-sample exploration for edge6). GeckoTerminal HTTPS."""
import json, os, time, requests
GT='https://api.geckoterminal.com/api/v2'; H={'accept':'application/json;version=20230302'}
os.makedirs('bars',exist_ok=True)
def get(path, params=None):
    wait=4
    for i in range(8):
        try: r=requests.get(f'{GT}/{path}',params=params or {},headers=H,timeout=30)
        except Exception: time.sleep(wait); wait=min(wait*2,90); continue
        if r.status_code==429 or r.status_code>=500: time.sleep(wait); wait=min(wait*2,90); continue
        time.sleep(2.2); return r.json() if r.ok else {'_http':r.status_code}
    return {'_http':'giveup'}
rows=json.load(open('ledger_dedup.json'))
bym={}
for r in rows: bym.setdefault(r['mint'],[]).append(r['ts'])
for mint,tss in bym.items():
    out=f'bars/{mint}.json'
    if os.path.exists(out): continue
    pools=get(f'networks/solana/tokens/{mint}/pools',{'page':1})
    ps=sorted([(float(p['attributes'].get('reserve_in_usd') or 0),p['attributes']['address']) for p in pools.get('data') or []],reverse=True)
    if not ps: json.dump({'pool':None,'bars':[]},open(out,'w')); continue
    pool=ps[0][1]; bars={}
    before=int(max(tss))+4*3600+600
    lo=int(min(tss))-7*3600
    for page in range(6):
        d=get(f'networks/solana/pools/{pool}/ohlcv/minute',{'aggregate':5,'before_timestamp':before,'limit':1000,'currency':'usd','token':mint})
        lst=((d.get('data') or {}).get('attributes') or {}).get('ohlcv_list') or []
        for b in lst: bars[b[0]]=b
        if not lst or min(b[0] for b in lst)<=lo: break
        before=min(b[0] for b in lst)
    json.dump({'pool':pool,'bars':sorted(bars.values())},open(out,'w'))
    print(mint[:8],pool[:8],len(bars),flush=True)
print('done')
