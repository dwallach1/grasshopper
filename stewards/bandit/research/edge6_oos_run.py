"""READ-ONLY out-of-sample check of edge6 meme_flush_rebound, exactly per edge6_prereg.md (sha256 d4770a56...).
Run from /workspace/bandit/research (needs raw/ohlcv5_*_usd.json = set A and raw/edge6/ = set B from
edge6_oos_fetch.py). Writes edge6_oos_results.csv and _edge6_oos_summary.json. No trades, no network, no DB."""
import json, glob, re, statistics as st, csv, datetime as dt, hashlib, os, sys
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import edge6_rule as R
PT = ZoneInfo('America/Los_Angeles')
PREREG = os.environ.get('EDGE6_PREREG', os.path.join(HERE, 'edge6_prereg.md'))
WANT = 'd4770a56b42bf33a1d1f7dcfd114c896ae3bbaec1c2d76f99fee8e8c12b893ca'
got = hashlib.sha256(open(PREREG, 'rb').read()).hexdigest()
if got != WANT: sys.exit(f'ABORT: prereg sha256 {got} != {WANT}')
OUT = os.environ.get('EDGE6_OUT', '.'); STAKE = 0.45
insample = set(open(os.path.join(HERE, 'edge6_insample_mints.txt')).read().split())
SOL = 'So11111111111111111111111111111111111111112'

# set A: edge2 dataset, one pool per coin (most bars, ties alphabetical), median close <= $1, minus in-sample mints
files = {}
for f in sorted(glob.glob('raw/ohlcv5_*_usd.json')):
    coin = re.match(r'raw/ohlcv5_(.+)_[^_]+_usd.json', f).group(1)
    d = json.load(open(f)); l = sorted(d['data']['attributes']['ohlcv_list'], key=lambda r: r[0])
    m = d.get('meta') or {}; mints = {(m.get(k) or {}).get('address') for k in ('base', 'quote')} - {None, SOL}
    if coin not in files or len(l) > len(files[coin][1]): files[coin] = (f, l, mints)
datasets = []
for coin, (f, l, mints) in sorted(files.items()):
    if st.median(r[4] for r in l) > 1: datasets.append(('A', coin, f, None, 'excluded: median close > $1')); continue
    if mints & insample: datasets.append(('A', coin, f, None, 'excluded: in-sample mint')); continue
    datasets.append(('A', coin, f, l, 'ok'))
# set B: fresh coins from edge6_oos_fetch.py
log = json.load(open('raw/edge6/_fetch_log.json'))
for c in log['chosen']:
    l = sorted(json.load(open(c['bars_file'])), key=lambda r: r[0])
    datasets.append(('B', c['name'], c['bars_file'], l, 'ok' if len(l) > 73 else 'excluded: < 74 bars'))

rows = []
for s, coin, f, l, status in datasets:
    if l is None or status != 'ok': continue
    for t in R.trades(l):
        if t['incomplete']: continue                       # data ended before the 4h stop: excluded (prereg)
        rows.append(dict(set=s, coin=coin, file=f, **t))
rows.sort(key=lambda r: r['entry_ts'])
def stats(rs):
    n = len(rs); r = [x['net'] * 100 for x in rs]
    if not n: return dict(n=0)
    se = st.stdev(r) / n ** 0.5 if n >= 2 else None
    return dict(n=n, wins=sum(v > 0 for v in r), mean=round(st.mean(r), 3), median=round(st.median(r), 3),
                se=None if se is None else round(se, 3), mean_minus_se=None if se is None else round(st.mean(r) - se, 3),
                mean_ex_top2=round(st.mean(sorted(r)[:-2]), 3) if n > 2 else None,
                net_sol=round(sum(x['net'] for x in rs) * STAKE, 4),
                triggers={k: sum(x['trigger'] == k for x in rs) for k in ('tp_full', 'kill', '4h_stop')})
h = len(rows) // 2
summ = dict(prereg_sha256=got, run_pt=dt.datetime.now(PT).isoformat(), fetch_ts_B=log['fetch_ts'],
            datasets=[dict(set=s, coin=c, file=f, status=st_, bars=None if l is None else len(l)) for s, c, f, l, st_ in datasets],
            pooled=stats(rows), older=stats(rows[:h]), newer=stats(rows[h:]),
            set_A=stats([r for r in rows if r['set'] == 'A']), set_B=stats([r for r in rows if r['set'] == 'B']),
            first_entry_pt=dt.datetime.fromtimestamp(rows[0]['entry_ts'], PT).isoformat() if rows else None,
            last_entry_pt=dt.datetime.fromtimestamp(rows[-1]['entry_ts'], PT).isoformat() if rows else None)
P, O, N = summ['pooled'], summ['older'], summ['newer']
g1 = P['n'] >= 20 and O['n'] >= 10 and N['n'] >= 10
g2 = bool(P['n'] and P['mean'] > 0 and N.get('n') and N['mean'] > 0)
g3 = bool(P.get('mean_ex_top2') is not None and P['mean_ex_top2'] > 0)
summ['gate'] = dict(g1_sample=g1, g2_mean_and_newer=g2, g3_ex_top2=g3,
                    verdict='INSUFFICIENT SAMPLE' if not g1 else ('PASS' if g2 and g3 else 'FAIL'))
with open(os.path.join(OUT, 'edge6_oos_results.csv'), 'w', newline='') as fh:
    w = csv.writer(fh); w.writerow(['set', 'coin', 'signal_pt', 'entry_pt', 'entry_usd', 'flush_pct', 'vol6h_usd', 'trigger', 'gross_pct', 'net_pct'])
    for r in rows:
        w.writerow([r['set'], r['coin'], dt.datetime.fromtimestamp(r['signal_ts'], PT).isoformat(), dt.datetime.fromtimestamp(r['entry_ts'], PT).isoformat(),
                    r['entry'], r['flush_pct'], r['vol6h_usd'], r['trigger'], round(r['gross'] * 100, 3), round(r['net'] * 100, 3)])
json.dump(summ, open(os.path.join(OUT, '_edge6_oos_summary.json'), 'w'), indent=1)
print(json.dumps({k: summ[k] for k in ('pooled', 'older', 'newer', 'set_A', 'set_B', 'gate', 'first_entry_pt', 'last_entry_pt')}, indent=1))
