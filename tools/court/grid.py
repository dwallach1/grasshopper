import json, itertools
from multiprocessing import Pool
from sim import run, L, RATE, HERE
POL = {
  'A_current(fixed$5%,halving,1sig)': {'kind':'edge','s':0.05,'halving':True},
  'B_current_no_halving':            {'kind':'edge','s':0.05},
  'C_book%5,ddscale,1sig':           {'kind':'edge','s':0.05,'scale_with_book':True,'dd':(0.10,0.40,0.5)},
  'C2_book%5,ddscale,2sig':          {'kind':'edge','s':0.05,'scale_with_book':True,'dd':(0.10,0.40,0.5),'z':2},
  'C_book%10,ddscale,1sig':          {'kind':'edge','s':0.10,'scale_with_book':True,'dd':(0.10,0.40,0.5)},
  'C_book%2.5,ddscale,1sig':         {'kind':'edge','s':0.025,'scale_with_book':True,'dd':(0.10,0.40,0.5)},
  'fixed_2%':  {'kind':'fixed','s':0.02}, 'fixed_5%': {'kind':'fixed','s':0.05},
  'fixed_10%': {'kind':'fixed','s':0.10}, 'fixed_20%': {'kind':'fixed','s':0.20},
}
SHARPES = [0.0, 0.05, 0.10, 0.20]
def job(a):
    st, sh, name = a
    mu = sh * L[st].std(ddof=1)
    return (st, sh, round(mu, 4), name, run(st, mu, POL[name], RATE[st], paths=1500))
if __name__ == '__main__':
    jobs = list(itertools.product(L.keys(), SHARPES, POL.keys()))
    with Pool(8) as p: out = p.map(job, jobs)
    json.dump(out, open(HERE / 'grid.json', 'w'), indent=0)
    print(len(out))
