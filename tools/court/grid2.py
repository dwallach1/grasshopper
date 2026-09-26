import json, itertools
from multiprocessing import Pool
from sim import run, L, RATE, HERE
SD = {k: float(v.std(ddof=1)) for k, v in L.items()}
DD = (0.10, 0.40, 0.5)
def pols(st):
    P = {
      'book5_halving':     {'kind':'edge','s':0.05,'scale_with_book':True,'halving':True},
      'book5_none':        {'kind':'edge','s':0.05,'scale_with_book':True},
      'book5_ddscale':     {'kind':'edge','s':0.05,'scale_with_book':True,'dd':DD},
      'book5_halving+dd':  {'kind':'edge','s':0.05,'scale_with_book':True,'halving':True,'dd':DD},
    }
    for v in (0.02, 0.03, 0.04):
        P[f'volstarter_v{int(v*100)}%_dd'] = {'kind':'edge','s':v/max(SD[st],0.25 if st=='quantanamo' else 0),'scale_with_book':True,'dd':DD}
    return P
SH = [0.0, 0.1, 0.2]
def job(a):
    st, sh, name, stress = a
    mu = sh * L[st].std(ddof=1)
    tail = (0.05, -0.40) if stress else None
    return (st, sh, round(mu,4), name, stress, round(pols(st)[name]['s'],4), run(st, mu, pols(st)[name], RATE[st], paths=1500, tail=tail))
def btjob(a):
    st, sh, bias_sh, name = a
    mu = sh * L[st].std(ddof=1)
    P = {'kind':'edge','s':0.05,'scale_with_book':True,'dd':DD}
    bt = None if name == 'no_bt' else {'n':30,'w':0.5,'haircut':0.5,'bias':bias_sh*L[st].std(ddof=1)}
    return (st, sh, bias_sh, name, run(st, mu, P, RATE[st], paths=1500, bt=bt))
if __name__ == '__main__':
    jobs = [(st, sh, n, False) for st in L for sh in SH for n in pols(st)] + [('quantanamo', sh, n, True) for sh in SH for n in pols('quantanamo')]
    bts = [(st, sh, b, nm) for st in L for (sh, b) in [(0.0,0.0),(0.0,0.2),(0.1,0.0),(0.2,0.0)] for nm in ('no_bt','bt30_w.5_h.5')]
    with Pool(8) as p:
        out = p.map(job, jobs); bo = p.map(btjob, bts)
    json.dump({'grid2': out, 'bt': bo}, open(HERE / 'grid2.json','w'), indent=0)
    for st, sh, mu, name, stress, s, r in out:
        print(f"{st:10s} sh={sh} stress={int(stress)} {name:22s} s={s:<7} medX={r['median_x']:<7} P2x={r['p2x']:<5} P10x={r['p10x']:<5} DD50={r['p_dd50']:<5} ruin={r['p_ruin80']:<5} t2x={r['med_trades_to_2x']}")
    print()
    for st, sh, b, nm, r in bo:
        print(f"{st:10s} sh={sh} bt_bias_sh={b} {nm:14s} medX={r['median_x']:<7} P2x={r['p2x']:<5} DD50={r['p_dd50']:<5} ruin={r['p_ruin80']:<5} tProven={r['med_trades_to_proven']} Pproven={r['p_proven']}")
