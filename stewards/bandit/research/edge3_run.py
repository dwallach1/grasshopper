"""READ-ONLY backtest of edge3 meme_range_breakout, exactly per edge3_prereg.md (sha256 599acd6d...).
Run from /workspace/bandit/research (needs raw/ohlcv5_*_usd.json). Writes edge3_results.csv and _edge3_summary.json.
Modeled on edge2_fullexit_run.py. No trades, no network, no DB."""
import json, glob, re, statistics as st, csv, datetime as dt, hashlib, os, sys
from zoneinfo import ZoneInfo
PT = ZoneInfo('America/Los_Angeles')
PREREG = os.environ.get('EDGE3_PREREG', '/workspace/grasshopper/stewards/bandit/research/edge3_prereg.md')
WANT = '599acd6d6a50e4bacc6eeaca000dddee5ae6ef5c7816de86e796e8fa093bba04'
got = hashlib.sha256(open(PREREG, 'rb').read()).hexdigest()
if got != WANT: sys.exit(f'ABORT: prereg sha256 {got} != {WANT}')
OUT = os.environ.get('EDGE3_OUT', '.')
COST, TP, KILL, HOLD, STAKE = 0.02, 1.5, 0.6, 48, 0.45

files = {}
for f in sorted(glob.glob('raw/ohlcv5_*_usd.json')):
    coin = re.match(r'raw/ohlcv5_(.+)_[^_]+_usd.json', f).group(1)
    d = json.load(open(f)); l = d['data']['attributes']['ohlcv_list'] if 'data' in d else d
    l = sorted(l, key=lambda r: r[0])
    if coin not in files or len(l) > len(files[coin][1]): files[coin] = (f, l)

def signal(b, t):
    w = b[t-72:t]                                   # bars t-72 .. t-1
    H = max(r[2] for r in w); L = min(r[3] for r in w)
    if not L > 0 or H / L - 1 > 0.25: return None
    o, h, lo, c, v = b[t][1:6]
    M = st.median(r[5] for r in w)
    if not (c > H and c > o and M > 0 and v >= 3.0 * M and sum(r[5] for r in w) >= 50000): return None
    return dict(range_pct=round((H/L-1)*100, 2), vol_mult=round(v/M, 2), vol6h_usd=round(sum(r[5] for r in w)),
                window_span_h=round((b[t-1][0] - b[t-72][0]) / 3600 + 5/60, 2))

trades = []; excluded = []
for coin, (f, b) in sorted(files.items()):
    if st.median(r[4] for r in b) > 1: excluded.append(coin); continue
    n = len(b); t = 72; earliest = 72
    while t < n - 1:                               # need bar t+1 for entry
        if t < earliest: t += 1; continue
        info = signal(b, t)
        if not info: t += 1; continue
        e = b[t+1][1]; ret = None; trig = ''; last = min(t + HOLD, n - 1); j = last
        for j in range(t+1, last+1):
            h, lo = b[j][2], b[j][3]
            if lo <= e * KILL: ret = KILL - 1; trig = 'kill'; break      # kill counts first
            if h >= e * TP: ret = TP - 1; trig = 'tp_full'; break
        if ret is None:
            j = last; ret = b[last][4] / e - 1; trig = '4h_stop' if last == t + HOLD else 'data_end'
        net = ret - COST
        trades.append(dict(coin=coin, pool_file=f, signal_ts=b[t][0], entry_ts=b[t+1][0],
            entry_pt=dt.datetime.fromtimestamp(b[t+1][0], PT).strftime('%F %H:%M'), entry_px=e, exit_trigger=trig,
            exit_bar_offset=j - t, gross_pct=round(ret*100, 2), net_pct=round(net*100, 2), net_sol=round(net*STAKE, 5), **info))
        earliest = max(j, t + HOLD)                # dedupe: >= prior exit bar and >= t+48 (4h)
        t = earliest

trades.sort(key=lambda x: x['entry_ts']); k = len(trades) // 2
for i, x in enumerate(trades): x['half'] = 'older' if i < k else 'newer'
def s(xs):
    r = [x['net_pct'] for x in xs]; n = len(r)
    mean = st.mean(r) if r else None
    se = st.stdev(r) / n ** 0.5 if n >= 2 else None
    top2 = st.mean(sorted(r)[:-2]) if n >= 3 else None
    return dict(n=n, wins=sum(v > 0 for v in r), mean_net_pct=None if mean is None else round(mean, 2),
                se_pct=None if se is None else round(se, 2), mean_minus_se_pct=None if se is None else round(mean - se, 2),
                mean_ex_top2_pct=None if top2 is None else round(top2, 2), net_sol=round(sum(x['net_sol'] for x in xs), 4))
O, N, A = s(trades[:k]), s(trades[k:]), s(trades)
c1 = A['n'] >= 20 and O['n'] >= 10 and N['n'] >= 10
c2 = (N['mean_net_pct'] or 0) > 0 and N['net_sol'] > 0
c3 = A['net_sol'] > 0
verdict = 'PASS' if (c1 and c2 and c3) else ('FAIL: insufficient sample' if not c1 else 'FAIL')
trig = {}
for x in trades: trig[x['exit_trigger']] = trig.get(x['exit_trigger'], 0) + 1
per_coin = {}
for x in trades: per_coin[x['coin']] = per_coin.get(x['coin'], 0) + 1
summ = dict(prereg_sha256=got, older=O, newer=N, all=A, gate=dict(c1_sample=c1, c2_newer_positive=c2, c3_overall_sol_positive=c3),
            verdict=verdict, exit_triggers=trig, trades_per_coin=per_coin, excluded_median_gt_1=excluded,
            pools={c: v[0] for c, v in files.items()}, bars={c: len(v[1]) for c, v in files.items()},
            date_range_pt={c: [dt.datetime.fromtimestamp(v[1][0][0], PT).strftime('%F %H:%M'), dt.datetime.fromtimestamp(v[1][-1][0], PT).strftime('%F %H:%M')] for c, v in files.items()})
json.dump(summ, open(os.path.join(OUT, '_edge3_summary.json'), 'w'), indent=1)
with open(os.path.join(OUT, 'edge3_results.csv'), 'w', newline='') as fh:
    cols = ['half','coin','pool_file','signal_ts','entry_ts','entry_pt','entry_px','exit_trigger','exit_bar_offset','gross_pct','net_pct','net_sol','range_pct','vol_mult','vol6h_usd','window_span_h']
    w = csv.DictWriter(fh, cols); w.writeheader(); w.writerows(trades)
print(json.dumps({k2: summ[k2] for k2 in ('older','newer','all','gate','verdict','exit_triggers','trades_per_coin','excluded_median_gt_1')}, indent=1))
