"""READ-ONLY OOS data fetch for edge6 (edge6_prereg.md, set B: fresh coins). Run from /workspace/bandit/research.
GeckoTerminal HTTPS only; caches under raw/edge6/ (outside the edge2 glob). No trades, no DB."""
import json, glob, os, re, time, statistics as st, datetime as dt, requests
GT = 'https://api.geckoterminal.com/api/v2'; H = {'accept': 'application/json;version=20230302'}
OUT = 'raw/edge6'; os.makedirs(OUT, exist_ok=True)
SOL = 'So11111111111111111111111111111111111111112'
STABLE = {SOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'}
def get(path, params=None):
    wait = 4
    for i in range(8):
        try: r = requests.get(f'{GT}/{path}', params=params or {}, headers=H, timeout=30)
        except Exception: time.sleep(wait); wait = min(wait * 2, 90); continue
        if r.status_code == 429 or r.status_code >= 500: time.sleep(wait); wait = min(wait * 2, 90); continue
        time.sleep(2.2); return r.json() if r.ok else {'_http': r.status_code}
    return {'_http': 'giveup'}
here = os.path.dirname(os.path.abspath(__file__))
insample = set(open(os.path.join(here, 'edge6_insample_mints.txt')).read().split())
setA = set()
for f in glob.glob('raw/ohlcv5_*_usd.json'):
    m = json.load(open(f)).get('meta') or {}
    setA |= {(m.get(k) or {}).get('address') for k in ('base', 'quote')}
setA -= {None, SOL}
fetch_ts = int(time.time())
sel = {}
for page in range(1, 11):
    d = get('networks/solana/pools', {'sort': 'h24_volume_usd_desc', 'page': page})
    for p in d.get('data') or []:
        a = p['attributes']; rel = p.get('relationships') or {}
        base = (((rel.get('base_token') or {}).get('data') or {}).get('id') or '').replace('solana_', '')
        quote = (((rel.get('quote_token') or {}).get('data') or {}).get('id') or '').replace('solana_', '')
        tok = base if base not in STABLE else (quote if quote not in STABLE else None)
        if not tok or tok in insample or tok in setA: continue
        try: created = dt.datetime.fromisoformat(a['pool_created_at'].replace('Z', '+00:00')).timestamp()
        except Exception: continue
        res = float(a.get('reserve_in_usd') or 0)
        if fetch_ts - created > 14 * 86400 or res < 100_000: continue
        vol = float((a.get('volume_usd') or {}).get('h24') or 0)
        if tok not in sel or res > sel[tok]['reserve']:
            sel[tok] = dict(mint=tok, pool=a['address'], name=a.get('name'), reserve=res, vol24=vol, created=a['pool_created_at'])
chosen = sorted(sel.values(), key=lambda x: -x['vol24'])[:40]
for c in chosen:
    bf = f"{OUT}/ohlcv5_{c['mint'][:8]}_{c['pool'][:8]}_usd.json"
    if not os.path.exists(bf):
        bars = {}; before = fetch_ts
        for pg in range(2):
            d = get(f"networks/solana/pools/{c['pool']}/ohlcv/minute", {'aggregate': 5, 'before_timestamp': before, 'limit': 1000, 'currency': 'usd', 'token': c['mint']})
            lst = ((d.get('data') or {}).get('attributes') or {}).get('ohlcv_list') or []
            for r in lst: bars[r[0]] = r
            if not lst: break
            before = min(r[0] for r in lst)
        json.dump(sorted(bars.values()), open(bf, 'w'))
    c['bars_file'] = bf
    print(c['name'], c['mint'][:8], flush=True)
json.dump(dict(fetch_ts=fetch_ts, chosen=chosen), open(f'{OUT}/_fetch_log.json', 'w'), indent=1)
print('chosen', len(chosen))
