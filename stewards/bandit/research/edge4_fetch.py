"""READ-ONLY data fetch for the edge4 meme_grad_pullback backtest (edge4_prereg.md, sha256 f88d7e42...).
Run from /workspace/bandit/research. For each mint in the edge2 dataset (raw/ohlcv5_*_usd.json, median close <= $1):
GeckoTerminal token pools (HTTPS) -> pumpswap pools -> G = earliest pool_created_at -> 5m USD bars of that migration pool
covering [G, G+28h] via before_timestamp paging. Caches under raw/edge4/ (outside the edge2 glob). No trades, no DB."""
import json, glob, re, os, time, statistics as st, datetime as dt, requests
GT = 'https://api.geckoterminal.com/api/v2'; H = {'accept': 'application/json;version=20230302'}
OUT = 'raw/edge4'; os.makedirs(OUT, exist_ok=True)
def get(path, params=None):
    wait = 4
    for i in range(8):
        try: r = requests.get(f'{GT}/{path}', params=params or {}, headers=H, timeout=30)
        except Exception: time.sleep(wait); wait = min(wait*2, 90); continue
        if r.status_code == 429 or r.status_code >= 500: time.sleep(wait); wait = min(wait*2, 90); continue
        time.sleep(2.5); return r.json() if r.ok else {'_http': r.status_code}
    return {'_http': 'giveup'}
# coin -> mint from the raw files' own meta (the non-SOL side), same pool choice as edge2
files = {}
for f in sorted(glob.glob('raw/ohlcv5_*_usd.json')):
    coin = re.match(r'raw/ohlcv5_(.+)_[^_]+_usd.json', f).group(1)
    d = json.load(open(f)); l = d['data']['attributes']['ohlcv_list']
    if coin not in files or len(l) > len(files[coin][1]): files[coin] = (f, l, d.get('meta') or {})
SOL = 'So11111111111111111111111111111111111111112'
mints = {}
for coin, (f, l, meta) in sorted(files.items()):
    if st.median(r[4] for r in l) > 1: continue
    # the coin's own mint = the side whose symbol is the coin name (FEELSGOOD's chosen file is PEPE/FEELSGOOD)
    side = [meta.get(k, {}) for k in ('base', 'quote')]
    side = [x.get('address') for x in side if (x.get('symbol') or '').upper() == coin.upper() and x.get('address') != SOL]
    mints[coin] = side[0] if side else None
log = {}
for coin, mint in mints.items():
    if not mint: log[coin] = dict(mint=None, status='no_mint'); continue
    pf = f'{OUT}/pools_{coin}.json'
    pools = json.load(open(pf)) if os.path.exists(pf) else get(f'networks/solana/tokens/{mint}/pools', {'page': 1})
    json.dump(pools, open(pf, 'w'))
    ps = []
    for p in pools.get('data') or []:
        dex = (((p.get('relationships') or {}).get('dex') or {}).get('data') or {}).get('id')
        a = p['attributes']; ps.append(dict(address=a['address'], dex=dex, created=a.get('pool_created_at'), name=a.get('name')))
    sw = sorted([p for p in ps if p['dex'] == 'pumpswap' and p['created']], key=lambda p: p['created'])
    if not sw: log[coin] = dict(mint=mint, status='no_pumpswap_pool', dexes=sorted({p['dex'] for p in ps if p['dex']})); continue
    mig = sw[0]; G = int(dt.datetime.fromisoformat(mig['created'].replace('Z', '+00:00')).timestamp())
    bf = f'{OUT}/ohlcv5_{coin}_{mig["address"][:8]}_mig_usd.json'
    if os.path.exists(bf): bars = json.load(open(bf))
    else:
        bars = {}; before = G + 28 * 3600 + 300
        for page in range(4):
            d = get(f'networks/solana/pools/{mig["address"]}/ohlcv/minute', {'aggregate': 5, 'before_timestamp': before, 'limit': 1000, 'currency': 'usd', 'token': mint})
            lst = ((d.get('data') or {}).get('attributes') or {}).get('ohlcv_list') or []
            for r in lst: bars[r[0]] = r
            if not lst or min(r[0] for r in lst) <= G: break
            before = min(r[0] for r in lst)
        bars = sorted(bars.values(), key=lambda r: r[0])
        json.dump(bars, open(bf, 'w'))
    inwin = [r for r in bars if G <= r[0] <= G + 28 * 3600]
    log[coin] = dict(mint=mint, status='ok' if inwin else 'no_bars_in_window', mig_pool=mig['address'], G=G,
                     G_utc=mig['created'], n_pumpswap_pools=len(sw), bars_file=bf, bars_in_window=len(inwin),
                     first_bar_after_G_min=round((inwin[0][0] - G) / 60, 1) if inwin else None)
json.dump(log, open(f'{OUT}/_fetch_log.json', 'w'), indent=1)
print(json.dumps(log, indent=1))
