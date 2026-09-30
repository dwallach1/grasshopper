"""Court 2026-09-30 (migration 48): the QUANTANAMO 80 gate stops opening on a small sample.

The results score is unchanged (100 Phi(mean / (max(sd, 0.25) / sqrt(n_eff))), scored only at >= 3 live
trades). The hole: that score hits 80 at some point before 10 live trades on ~31% of zero-edge paths.
Three fixes, same paths (QUANTANAMO ledger returns, centered, 4,000 paths, 80 trades):

  shrink_k  : the score itself becomes 100 Phi(z * sqrt(n_live / (n_live + k))). A neutral prior of k
              zero-mean trades that fades. Changes the number the desk shows.
  lcb_c     : the gate reads 100 Phi(z - c) and the shown score stays. A fixed lower bound.
  streak_K  : the raw score must be >= 80 for K consecutive re-scores (one per new live trade).

The ruling uses the shrink math ONLY for the gate (prior k = 16). False opens and time-to-autonomy match
shrink_k16; the shown score, and therefore every live score, stays put. Sizing does not read the gate, so
doubling odds are the same before and after (reported, not assumed).
"""
import json, math
from statistics import NormalDist
import numpy as np
from sim import L, RATE, HERE, dd_scale

z80 = NormalDist().inv_cdf(0.80)
phi = lambda z: 0.5 * (1 + math.erf(z / math.sqrt(2)))
G = 0.5772156649
def emax(n):
    z = NormalDist().inv_cdf
    return 0.0 if n <= 1 else (1 - G) * z(1 - 1 / n) + G * z(1 - 1 / (n * math.e))
EM = emax(17)
PRIOR = 16
P, T = 4000, 80
pool0 = np.asarray(L['quantanamo'], float)
pool0 = pool0 - pool0.mean()
SD = float(pool0.std(ddof=1))

def draw(sh, seed, extra=0):
    rng = np.random.default_rng(seed)
    pool = np.maximum(pool0 + sh * SD, -1.06)
    X = pool[rng.integers(0, len(pool), size=(P, T))]
    n = np.arange(1, T + 1)
    c1 = np.cumsum(X, 1); c2 = np.cumsum(X * X, 1)
    mean = c1 / n
    var = np.maximum((c2 - c1 * c1 / n) / np.maximum(n - 1, 1), 0)
    var[:, 0] = 0
    sd = np.sqrt(var)
    z = np.zeros_like(mean)
    z[:, 1:] = mean[:, 1:] / (np.maximum(sd[:, 1:], 0.25) / np.sqrt(n[1:]))
    return z, n, rng

def first(mask):
    hit = mask.any(1)
    return np.where(hit, mask.argmax(1) + 1, -1)

def pack(name, sh, idx):
    opened = idx > 0
    cens = np.where(opened, idx, T + 1)
    return dict(mech=name, sharpe=sh,
                false_open_before_10=round(float(((idx > 0) & (idx < 10)).mean()), 3),
                p_open_by_20=round(float(((idx > 0) & (idx <= 20)).mean()), 3),
                p_open_by_40=round(float(((idx > 0) & (idx <= 40)).mean()), 3),
                p_open_by_80=round(float(opened.mean()), 3),
                median_trades_to_open=round(float(np.median(idx[opened])), 1) if opened.any() else None,
                median_censored=round(float(np.median(cens)), 1))

def streak_mask(z, n, K):
    ge = (z >= z80) & (n >= 3)
    streak = np.zeros(z.shape[0], int)
    mask = np.zeros_like(ge)
    for t in range(z.shape[1]):
        streak = np.where(ge[:, t], streak + 1, 0)
        mask[:, t] = streak >= K
    return mask

rows = []
for sh, seed in ((0.0, 80), (0.2, 81), (0.4, 82)):
    z, n, _ = draw(sh, seed)
    rows.append(pack('raw', sh, first((z >= z80) & (n >= 3))))
    for k in (8, 12, 16):
        rows.append(pack(f'shrink_{k}', sh, first((z * np.sqrt(n / (n + k)) >= z80) & (n >= 3))))
    rows.append(pack('lcb_0.84', sh, first((z - 0.84 >= z80) & (n >= 3))))
    rows.append(pack('streak_4', sh, first(streak_mask(z, n, 4))))

# Overfit backtests (rule 47 weight) on a zero-edge thesis: does a fake +0.2 Sharpe reopen the gate?
def overfit(prior):
    rng = np.random.default_rng(90)
    pool = np.maximum(pool0, -1.06)
    X = pool[rng.integers(0, len(pool), size=(P, T))]
    n = np.arange(1, T + 1).astype(float)
    c1 = np.cumsum(X, 1); c2 = np.cumsum(X * X, 1)
    mean = c1 / n
    var = np.maximum((c2 - c1 * c1 / n) / np.maximum(n - 1, 1), 0)
    sd = np.sqrt(var)
    # two tests, one survivors-only (missing 0.35), n_bt 200, 17 trials
    tm = 0.2 * SD + rng.normal(0, SD / math.sqrt(200), size=(P, 2))
    d = tm - EM * SD / math.sqrt(199)
    base = np.array([100.0, 100.0]); f = np.array([0.65, 1.0])
    m_bt = (base * f * d).sum(1) / (base * f).sum()
    fbar = float((base * f).sum() / base.sum())
    w = np.where(n >= 3, np.minimum(5.0, n / 2) * fbar, 0.0)
    ne = n + w
    me = (n * mean + w * m_bt[:, None]) / ne
    se = np.maximum(sd, 0.25) / np.sqrt(ne)
    z = np.zeros_like(me); z[:, 1:] = me[:, 1:] / se[:, 1:]
    raw = first((z >= z80) & (n >= 3))
    shr = z * np.sqrt(n / (n + prior))
    gate = first((shr >= z80) & (n >= 3))
    return pack('raw_overfit', 0.0, raw), pack(f'gate_prior_{prior}_overfit', 0.0, gate)

ov_raw, ov_gate = overfit(PRIOR)

def year(sh, seed):
    rng = np.random.default_rng(seed)
    pool = np.maximum(pool0 + sh * SD, -1.06)
    starter = 0.03 / max(SD, 0.25)
    eqs, dd, t2 = [], [], []
    for _ in range(1500):
        eq = peak = 1.0; mdd = 0.0; n = 0; S = SS = 0.0; hit = None
        for t in range(RATE['quantanamo']):
            m = S / n if n else 0.0
            sdl = math.sqrt(max((SS - n * m * m) / (n - 1), 0.0)) if n >= 2 else 0.0
            lcb = (m - sdl / math.sqrt(n)) if n >= 2 and sdl > 0 else -1
            proven = n >= 10 and lcb > 0
            s_unit = starter * eq
            if proven:
                growth = s_unit * 2 ** (1 + (n - 10) / 5)
                kelly = eq * 0.5 * lcb / (sdl * sdl) if sdl > 0 else growth
                f = max(s_unit, min(kelly, growth))
            else:
                f = s_unit
            f *= dd_scale(1 - eq / peak); f = min(f, eq)
            r = pool[rng.integers(len(pool))]
            eq = max(eq + f * r, 0.0); n += 1; S += r; SS += r * r
            peak = max(peak, eq); mdd = max(mdd, 1 - eq / peak)
            if eq >= 2 and hit is None: hit = t + 1
        eqs.append(eq); dd.append(mdd); t2.append(hit)
    eq = np.array(eqs); mdd = np.array(dd)
    return dict(sharpe=sh, median_x=round(float(np.median(eq)), 3),
                p2x=round(float(np.mean([h is not None for h in t2])), 3),
                p_dd50=round(float(np.mean(mdd >= 0.5)), 3),
                p_ruin=round(float(np.mean(eq <= 0.2)), 3))

def replay_score(rets, tests):
    """Raw score and gate score after each live trade. tests: list of dicts, rule 47 pooling."""
    out = []
    for k in range(1, len(rets) + 1):
        x = np.array(rets[:k], float)
        n = len(x); m = float(x.mean()); sdl = float(x.std(ddof=1)) if n >= 2 else 0.0
        if n < 3 or not tests:
            w = mb = 0.0
        else:
            base = [0.5 * t['n'] for t in tests]
            f = [1 - t['missing'] if t['survivors'] else 1.0 for t in tests]
            cm = [t['ds'] * t['sd'] for t in tests]
            w = min(sum(base), 5.0, n / 2) * sum(b * a for b, a in zip(base, f)) / sum(base)
            mb = sum(b * a * c for b, a, c in zip(base, f, cm)) / sum(b * a for b, a in zip(base, f))
        ne = n + w
        raw = gate = None
        if n >= 3:
            mean = (n * m + w * mb) / ne
            z = mean / (max(sdl, 0.25) / math.sqrt(ne))
            raw = int(round(100 * phi(z)))
            gate = int(round(100 * phi(z * math.sqrt(n / (n + PRIOR)))))
        out.append(dict(n=n, score=raw, gate_score=gate, weight=round(w, 3)))
    return out

if __name__ == '__main__':
    growth = [year(sh, 100 + int(sh * 10)) for sh in (0.0, 0.2, 0.4)]
    egs = [-0.000323, 0.184198, 0.414727, -0.164271, -0.151045, -0.194043]
    t31 = dict(n=714, sd=0.062007, ds=-0.122844, survivors=True, missing=0.3456)
    t30 = dict(n=13, sd=0.0964, ds=-0.328902, survivors=True, missing=0.1131)
    meme = [0.586495, -0.125468, -0.021582, -0.245064]
    weather = [-1.058333, 4.272065, 1.816781, -0.989167]
    neo = [-0.050397, 0.011983]
    replay = {
        'earnings_gap_structure_no_backtest': replay_score(egs, []),
        'earnings_gap_structure': replay_score(egs, [t31, t30]),
        'meme_4h_momentum_clip': replay_score(meme, []),
        'weather_same_day_high': replay_score(weather, []),
        'neocloud_compute': replay_score(neo, []),
    }
    out = dict(params=dict(paths=P, trades=T, prior=PRIOR, sd=round(SD, 4),
                           z80=round(z80, 4), growth_paths=1500),
               comparison=rows, overfit=[ov_raw, ov_gate], growth=growth, replay=replay)
    json.dump(out, open(HERE / 'gate80.json', 'w'), indent=1)
    print(f'{"mech":22} sh  false<10  by20  by40  by80  med  medC')
    for r in rows:
        print(f"{r['mech']:22} {r['sharpe']:<3} {r['false_open_before_10']:7}  {r['p_open_by_20']:5} {r['p_open_by_40']:5} {r['p_open_by_80']:5} {str(r['median_trades_to_open']):6} {r['median_censored']}")
    print('overfit', ov_raw['false_open_before_10'], ov_gate['false_open_before_10'])
    print('growth', growth)
    for k, v in replay.items():
        print(k, [(a['n'], a['score'], a['gate_score']) for a in v])
