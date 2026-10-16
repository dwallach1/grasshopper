"""READ-ONLY backtest of edge4 meme_grad_pullback, exactly per edge4_prereg.md (sha256 f88d7e42...).
Run from /workspace/bandit/research after edge4_fetch.py (reads raw/edge4/_fetch_log.json + cached migration-pool bars).
Writes edge4_results.csv and _edge4_summary.json. Modeled on edge2_fullexit_run.py. No trades, no network, no DB."""
import json, statistics as st, csv, datetime as dt, hashlib, os, sys
from zoneinfo import ZoneInfo
PT = ZoneInfo('America/Los_Angeles')
PREREG = os.environ.get('EDGE4_PREREG', '/workspace/grasshopper/stewards/bandit/research/edge4_prereg.md')
WANT = 'f88d7e42876ccf6e02ddeb2af2295bb34114aeeff28cd329007803e3d20bde30'
got = hashlib.sha256(open(PREREG, 'rb').read()).hexdigest()
if got != WANT: sys.exit(f'ABORT: prereg sha256 {got} != {WANT}')
OUT = os.environ.get('EDGE4_OUT', '.')
COST, TP, KILL, HOLD, STAKE = 0.02, 1.5, 0.6, 48, 0.45
log = json.load(open('raw/edge4/_fetch_log.json'))

def edge2_trig(b, t):
    """meme_pullback_reclaim on the same pool's bar series (edge2_fullexit_run.py logic)."""
    if t < 71: return False
    w = b[t-71:t+1]; cl = [r[4] for r in w]; P = max(cl); pi = cl.index(P)
    if not (pi > 0 and len(w) - 1 - pi >= 6): return False
    L = min(cl[:pi]); c = b[t][4]
    return P / L - 1 >= 0.40 and 0.6 * P <= c <= 0.8 * P and c > b[t-1][2] and sum(r[5] for r in w) >= 50000

def cond_2_5(b, t):
    if t < 3: return None                      # need p <= t-3 with p >= 0
    cl = [r[4] for r in b[:t]]; P = max(cl); p = cl.index(P)
    if p > t - 3: return None
    o, h, lo, c = b[t][1:5]
    if not (0.65 * P <= c <= 0.80 * P): return None
    if not (c > b[t-1][2] and c > o): return None
    vol = sum(r[5] for r in b[:t])
    if vol < 50000: return None
    return dict(post_grad_high=P, peak_bar=p, pullback_pct=round((1 - c / P) * 100, 2), vol_since_G_usd=round(vol))

trades = []; coins = {}
for coin, L in sorted(log.items()):
    if L['status'] != 'ok': coins[coin] = dict(status=L['status'], mint=L.get('mint')); continue
    G = L['G']; allb = sorted(json.load(open(L['bars_file'])), key=lambda r: r[0])
    b = [r for r in allb if r[0] >= G]          # post-graduation bars only (pool is created at G)
    first = None
    for t in range(len(b)):
        if b[t][0] - G >= 86400: break          # past the 24h window: no later bar can be a signal
        info = cond_2_5(b, t)
        if info: first = (t, info); break
    if not first: coins[coin] = dict(status='no_trigger_in_24h', G_utc=L['G_utc'], post_bars=len(b)); continue
    t, info = first
    sig_pt = dt.datetime.fromtimestamp(b[t][0], PT).strftime('%F %H:%M')
    if t < 12: coins[coin] = dict(status='first_pullback_before_12_bars (consumed, no signal)', signal_bar=t, signal_pt=sig_pt); continue
    if edge2_trig(b, t): coins[coin] = dict(status='edge2_precedence (consumed)', signal_bar=t, signal_pt=sig_pt); continue
    if t + 1 >= len(b): coins[coin] = dict(status='data_gap_no_entry_bar', signal_bar=t); continue
    e = b[t+1][1]; ret = None; last = min(t + HOLD, len(b) - 1); j = last
    for j in range(t+1, last+1):
        h, lo = b[j][2], b[j][3]
        if lo <= e * KILL: ret = KILL - 1; trig = 'kill'; break
        if h >= e * TP: ret = TP - 1; trig = 'tp_full'; break
    if ret is None: j = last; ret = b[last][4] / e - 1; trig = '4h_stop' if last == t + HOLD else 'data_end'
    net = ret - COST
    trades.append(dict(coin=coin, mint=L['mint'], mig_pool=L['mig_pool'], G_utc=L['G_utc'], signal_bar_since_G=t,
        hours_since_G=round((b[t][0] - G) / 3600, 2), entry_ts=b[t+1][0],
        entry_pt=dt.datetime.fromtimestamp(b[t+1][0], PT).strftime('%F %H:%M'), entry_px=e, exit_trigger=trig,
        exit_bar_offset=j - t, gross_pct=round(ret*100, 2), net_pct=round(net*100, 2), net_sol=round(net*STAKE, 5),
        pullback_pct=info['pullback_pct'], vol_since_G_usd=info['vol_since_G_usd']))
    coins[coin] = dict(status='trade', signal_pt=sig_pt)

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
summ = dict(prereg_sha256=got, older=O, newer=N, all=A, gate=dict(c1_sample=c1, c2_newer_positive=c2, c3_overall_sol_positive=c3),
            verdict=verdict, coins=coins)
json.dump(summ, open(os.path.join(OUT, '_edge4_summary.json'), 'w'), indent=1)
with open(os.path.join(OUT, 'edge4_results.csv'), 'w', newline='') as fh:
    cols = ['half','coin','mint','mig_pool','G_utc','signal_bar_since_G','hours_since_G','entry_ts','entry_pt','entry_px','exit_trigger','exit_bar_offset','gross_pct','net_pct','net_sol','pullback_pct','vol_since_G_usd']
    w = csv.DictWriter(fh, cols); w.writeheader(); w.writerows(trades)
print(json.dumps(summ, indent=1))
for x in trades: print(x['half'], x['coin'], x['entry_pt'], x['hours_since_G'], x['exit_trigger'], x['net_pct'])
