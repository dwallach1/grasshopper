"""IN-SAMPLE exploration for edge6 (edge6_prereg.md, "Where it came from"). READ-ONLY, no trades, no DB writes.
Inputs (box scratch, not committed): ledger export of scored BANDIT meme passes (read-only SQL on decision_candidates:
steward bandit, venue meme, decision skip, counterfactual_pnl not null -> ledger_scored.json, parsed + deduped one per
coin per 4h -> ledger_dedup.json) and GeckoTerminal 5m bars per mint (edge6_explore_fetch.py -> bars/<mint>.json).
Prints: logged-feature terciles at pass time, bar-feature terciles, and the all-bars band/filter grid that led to the
30-50% flush band. Everything here is in-sample and subject to multiple comparisons."""
import json, os, statistics as st, collections
rows=json.load(open('ledger_dedup.json'))
BAR=300; TP,KILL,COST=1.5,0.6,0.02
def house(bars,i0):
    e=bars[i0][1]
    if not e or e<=0: return None
    end=bars[i0][0]+48*BAR
    for b in bars[i0:]:
        if b[0]>=end: break
        if b[3]<=e*KILL: return KILL-1-COST
        if b[2]>=e*TP: return TP-1-COST
        last=b
    return last[4]/e-1-COST
recs=[]
for r in rows:
    f=f"bars/{r['mint']}.json"
    if not os.path.exists(f): continue
    bars=json.load(open(f))['bars']
    if not bars: continue
    ts=r['ts']; prior=[b for b in bars if b[0]+BAR<=ts]; nxt=[i for i,b in enumerate(bars) if b[0]>=ts]
    if len(prior)<72 or not nxt: continue
    i0=nxt[0]
    if bars[i0][0]-ts>900: continue
    if bars[-1][0] < bars[i0][0]+47*BAR: continue
    p=prior; c=[b[4] for b in p]; v=[b[5] for b in p]
    h6=max(b[2] for b in p[-72:]); l6=min(b[3] for b in p[-72:])
    feat=dict(r1h=c[-1]/c[-13]-1, r6h=c[-1]/c[-73]-1 if len(c)>72 else None, r15=c[-1]/c[-4]-1, dist_h6=c[-1]/h6-1, range6=h6/l6-1,
              volr=(sum(v[-12:]))/(sum(v[-72:-12])/5+1e-9), vol6=sum(v[-72:]), green12=sum(b[4]>b[1] for b in p[-12:]),
              maxbar1h=max(b[2]/b[1]-1 for b in p[-12:]), wick=st.mean((b[2]-max(b[1],b[4]))/max(b[2]-b[3],1e-12) for b in p[-12:]),
              volr15=sum(v[-3:])/(sum(v[-15:-3])/4+1e-9))
    hx=house(bars,i0); e=bars[i0][1]
    win=[b for b in bars[i0:] if b[0]<bars[i0][0]+48*BAR]
    feat.update(ret=hx, ledger_ret=r['ret'], bb=r['bb'], sym=r['sym'], ts=ts, mint=r['mint'],
                mae1h=min(b[3] for b in win[:12])/e-1, mfe=max(b[2] for b in win)/e-1)
    recs.append(feat)
json.dump(recs,open('explore_recs.json','w'))
print('n with bars',len(recs),'of',len(rows))
R=[x['ret'] for x in recs]; print('house net mean %.2f med %.2f win %d'%(100*st.mean(R),100*st.median(R),sum(x>0 for x in R)))
for k in ['r1h','r6h','r15','dist_h6','range6','volr','vol6','green12','maxbar1h','wick','volr15']:
    v=sorted([x for x in recs if x[k] is not None],key=lambda x:x[k]); n=len(v); s=[]
    for q in range(3):
        part=v[q*n//3:(q+1)*n//3]; rr=[x['ret'] for x in part]
        s.append('[%s..%s] n%d mean %+.1f med %+.1f w%d'%(f"{part[0][k]:.3g}",f"{part[-1][k]:.3g}",len(part),100*st.mean(rr),100*st.median(rr),sum(y>0 for y in rr)))
    print(f'{k:9s}',' | '.join(s))


# ---- all-bars band / filter grid (same 29 coins, every bar; the edge6 band came from here) ----
import glob
from edge6_rule import exit_path, COST
B = [json.load(open(f))['bars'] for f in glob.glob('bars/*.json')]; B = [b for b in B if len(b) > 100]
def replay(cond):
    out = []
    for b in B:
        nxt = 0
        for t in range(72, len(b) - 1):
            if t < nxt: continue
            c, c72, c12 = b[t][4], b[t-72][4], b[t-12][4]
            if min(c, c72, c12) <= 0: continue
            H = max(x[2] for x in b[t-71:t+1]); vol = sum(x[5] for x in b[t-71:t+1])
            f = dict(r6=c / c72 - 1, r1=c / c12 - 1, d=c / H, green=b[t][4] > b[t][1])
            if vol < 50000 or not cond(f): continue
            g, trig, xts, inc = exit_path(b, t + 1)
            if inc: continue
            out.append((g - COST) * 100)
            xi = next((k for k in range(t + 1, len(b)) if b[k][0] >= xts), len(b)); nxt = max(xi, t + 48)
    return out
cells = [('any bar', lambda f: True)]
cells += [(f'd in [{lo},{hi})', (lambda lo, hi: lambda f: lo <= f['d'] < hi)(lo, hi)) for lo, hi in ((0.95, 1.01), (0.84, 0.95), (0.70, 0.84), (0.5, 0.7), (0.3, 0.5))]
cells += [(f'r6>=10% & d in [{lo},{hi})', (lambda lo, hi: lambda f: f['r6'] >= 0.1 and lo <= f['d'] < hi)(lo, hi)) for lo, hi in ((0.95, 1.01), (0.84, 0.95), (0.70, 0.84), (0.5, 0.7))]
cells += [('r1<=-15%', lambda f: f['r1'] <= -0.15), ('r6<=-30%', lambda f: f['r6'] <= -0.3),
          ('d in [0.5,0.7) & green', lambda f: 0.5 <= f['d'] < 0.7 and f['green']), ('d in [0.5,0.7) & red', lambda f: 0.5 <= f['d'] < 0.7 and not f['green'])]
for lab, cond in cells:
    r = replay(cond)
    if len(r) > 2: print(f"{lab:30s} n{len(r):4d} mean {st.mean(r):+6.2f} SE {st.stdev(r)/len(r)**.5:5.2f} exTop2 {st.mean(sorted(r)[:-2]):+6.2f}")
