"""Court 2026-09-27 (migration 47): backtest credit is live-gated and small (docs/rules/backtest-evidence-credit.md).

Compares three evidence rules on one thesis per steward, one year at ledger pace, 1,500 paths:
  no_backtest : live trades only.
  rule_46     : as shipped in #107. Every logged test pools from trade 0; weight min(0.5 n, 20) per test,
                x0.5 survivors-only, pooled cap 20; mean = mean - E[max of N normals] sd/sqrt(n), shrunk 50%;
                the pooled sd floors the live sd at half the backtest sd; score needs n_eff >= 3.
  rule_47     : this ruling. No credit until 3 live trades; weight = min(sum 0.5 n, 5, n_live / 2)
                x (1 - missing share) for survivors-only tests; credited mean = deflated Sharpe x spread
                (= mean - E[max of N normals] sd/sqrt(n - 1)), no extra shrink; sd is the live sd only;
                a thesis is scored only with >= 3 live trades.
Sizing (both rules, as coded): starter = 0.03 x book / max(steward sd, 0.25); proven when n_eff >= 10 and the
1-sigma LCB > 0, then max(starter, min(half-Kelly on the LCB x book, starter x 2^(1 + (n_eff - 10) / 5)));
x drawdown scale; cash only. Score = 100 Phi(mean_eff / (max(sd, 0.25) / sqrt(n_eff))).

Evidence scenarios (each thesis has M = 2 preregistered tests of n_bt = 200 trades, trial count 17,
one survivors-only with 35% of events missing, like test 31):
  honest   : each test's mean ~ N(true mean, sd / sqrt(n_bt)).
  overfit  : the tests carry a fake +0.2 Sharpe (gaming / look-ahead that slipped through).
  mismatch : the live edge is real but the mechanical backtest has none (true mean 0), the
             earnings_gap_structure situation: does negative evidence choke a real live edge?
Plus the ledger replay of earnings_gap_structure's six live trades with tests 31 and 30."""
import json, math
from multiprocessing import Pool
from statistics import NormalDist
import numpy as np
from sim import L, RATE, HERE, dd_scale

G = 0.5772156649
N_BT, M, TRIALS, MISSING = 200, 2, 17, 0.35
PATHS = 1500
phi = lambda z: 0.5 * (1 + math.erf(z / math.sqrt(2)))

def emax(n):
    z = NormalDist().inv_cdf
    return 0.0 if n <= 1 else (1 - G) * z(1 - 1 / n) + G * z(1 - 1 / (n * math.e))

EM = emax(TRIALS)

def evidence(rule, test_means, sd):
    """Pooled evidence (weight function of n_live, credited mean) for a thesis's M tests."""
    if rule == 'no_backtest':
        return lambda n: 0.0, 0.0
    if rule == 'rule_46':
        w = [min(0.5 * N_BT, 20) * (0.5 if i == 0 else 1.0) for i in range(M)]
        d = [m - EM * sd / math.sqrt(N_BT) for m in test_means]
        W = min(sum(w), 20.0); mean = sum(wi * di for wi, di in zip(w, d)) / sum(w)
        return (lambda n: W), 0.5 * mean
    f = [(1 - MISSING) if i == 0 else 1.0 for i in range(M)]
    base = [0.5 * N_BT] * M
    d = [m - EM * sd / math.sqrt(N_BT - 1) for m in test_means]            # deflated Sharpe x spread
    fbar = sum(b * fi for b, fi in zip(base, f)) / sum(base)
    mean = sum(b * fi * di for b, fi, di in zip(base, f, d)) / sum(b * fi for b, fi in zip(base, f))
    return (lambda n: 0.0 if n < 3 else min(sum(base), 5.0, n / 2) * fbar), mean

def one_path(st, mu, rule, scen, rng):
    base = L[st]; sd_st = float(base.std(ddof=1))
    pool = np.maximum(base - base.mean() + mu, -1.06)
    mu_bt = {'honest': mu, 'overfit': mu + 0.2 * sd_st, 'mismatch': 0.0}[scen]
    test_means = list(mu_bt + rng.normal(0, sd_st / math.sqrt(N_BT), M))
    wfun, m_bt = evidence(rule, test_means, sd_st)
    starter = 0.03 / max(sd_st, 0.25)
    eq = peak = 1.0; mdd = 0.0; n = 0; S = SS = 0.0
    t2x = tproven = None; gate = False; scores = {}
    for t in range(RATE[st]):
        m = S / n if n else 0.0
        sdl = math.sqrt(max((SS - n * m * m) / (n - 1), 0.0)) if n >= 2 else 0.0
        w = wfun(n); ne = n + w
        mean = (n * m + w * m_bt) / ne if ne > 0 else 0.0
        if rule == 'rule_46' and w > 0:
            sd = max(sdl if n >= 2 else sd_st, sd_st * 0.5)
        else:
            sd = sdl
        lcb = mean - sd / math.sqrt(ne) if ne >= 2 and sd > 0 else -1
        # results score and the 80 gate
        scored = (n >= 3) if rule != 'rule_46' else (ne >= 3)
        if scored:
            sc = 100 * phi(mean / (max(sd, 0.25) / math.sqrt(ne)))
            if n in (3, 6, 10, 20): scores[n] = sc
            if sc >= 80 and n < 10: gate = True
        proven = ne >= 10 and lcb > 0
        if proven and tproven is None: tproven = t
        s_unit = starter * eq
        if proven:
            growth = s_unit * 2 ** (1 + (ne - 10) / 5)
            kelly = eq * 0.5 * lcb / (sd * sd) if sd > 0 else growth
            f = max(s_unit, min(kelly, growth))
        else:
            f = s_unit
        f *= dd_scale(1 - eq / peak); f = min(f, eq)
        r = pool[rng.integers(len(pool))]
        eq = max(eq + f * r, 0.0); n += 1; S += r; SS += r * r
        peak = max(peak, eq); mdd = max(mdd, 1 - eq / peak)
        if eq >= 2 and t2x is None: t2x = t + 1
    return eq, mdd, t2x, tproven, gate, scores

def job(a):
    st, sh, rule, scen = a
    rng = np.random.default_rng(17)
    mu = sh * float(L[st].std(ddof=1))
    R = [one_path(st, mu, rule, scen, rng) for _ in range(PATHS)]
    eq = np.array([r[0] for r in R]); mdd = np.array([r[1] for r in R])
    tp = [r[3] for r in R if r[3] is not None]
    sc = {k: [r[5][k] for r in R if k in r[5]] for k in (3, 6, 10, 20)}
    return dict(steward=st, sharpe=sh, rule=rule, scenario=scen,
                median_x=round(float(np.median(eq)), 3), p2x=round(float(np.mean([r[2] is not None for r in R])), 3),
                p_dd50=round(float(np.mean(mdd >= 0.5)), 3), p_ruin80=round(float(np.mean(eq <= 0.2)), 3),
                p_proven=round(len(tp) / PATHS, 3), med_trades_to_proven=(float(np.median(tp)) if tp else None),
                p_gate80_before_10_live=round(float(np.mean([r[4] for r in R])), 3),
                mean_score={k: (round(float(np.mean(v)), 1) if v else None) for k, v in sc.items()})

def score_live(live, tests, rule):
    """Replay score as coded for a live sequence and a list of logged tests."""
    n = len(live); m = float(np.mean(live)) if n else 0.0
    sdl = float(np.std(live, ddof=1)) if n >= 2 else None
    if rule == 'no_backtest' or not tests:
        w, mb = 0.0, 0.0
    elif rule == 'rule_46':
        ws = [min(0.5 * t['n'], 20) * (0.5 if t['survivors_only'] else 1) for t in tests]
        ds = [t['mean'] - emax(t['trials']) * t['sd'] / math.sqrt(t['n']) for t in tests]
        w = min(sum(ws), 20.0); mb = 0.5 * sum(a * b for a, b in zip(ws, ds)) / sum(ws)
    else:
        if n < 3: return None, 0.0
        base = [0.5 * t['n'] for t in tests]
        f = [1 - t['missing_share'] if t['survivors_only'] else 1.0 for t in tests]
        cm = [t['ds'] * t['sd'] for t in tests]
        w = min(sum(base), 5.0, n / 2) * sum(b * x for b, x in zip(base, f)) / sum(base)
        mb = sum(b * x * c for b, x, c in zip(base, f, cm)) / sum(b * x for b, x in zip(base, f))
    ne = n + w
    if (rule == 'rule_46' and ne < 3) or (rule != 'rule_46' and n < 3): return None, round(w, 3)
    if rule == 'rule_46' and w > 0 and sdl is not None:
        var = (n * sdl ** 2 + w * np.mean([t['sd'] for t in tests]) ** 2) / ne
    else:
        var = (sdl or 0) ** 2
    mean = (n * m + w * mb) / ne
    return round(100 * phi(mean / (max(math.sqrt(var), 0.25) / math.sqrt(ne)))), round(w, 3)

if __name__ == '__main__':
    jobs = [(st, sh, rule, 'honest') for st in ('quantanamo', 'bandit') for sh in (0.0, 0.1, 0.2)
            for rule in ('no_backtest', 'rule_46', 'rule_47')]
    jobs += [(st, 0.0, rule, 'overfit') for st in ('quantanamo', 'bandit') for rule in ('rule_46', 'rule_47')]
    jobs += [(st, 0.2, rule, 'mismatch') for st in ('quantanamo', 'bandit') for rule in ('rule_46', 'rule_47')]
    with Pool(8) as p:
        grid = p.map(job, jobs)
    # Ledger replay: earnings_gap_structure's live returns on stake in closing order (trade_outcomes
    # realized_pnl / cost, 2026-09-27: DG, SNOW, AOUT, ASAN, OCC, ZUMZ) with the stored test rows.
    live = [-0.000323, 0.184198, 0.414727, -0.164271, -0.151045, -0.194043]
    t31 = dict(id=31, n=714, mean=-0.003457, sd=0.062007, ds=-0.122844, trials=17, survivors_only=True, missing_share=0.3456)
    t30 = dict(id=30, n=13, mean=0.0178, sd=0.0964, ds=-0.328902, trials=16, survivors_only=True, missing_share=0.1131)
    replay = {'thesis': 'earnings_gap_structure', 'live_returns': live, 'tests': [t31, t30], 'after_trade': []}
    for k in range(1, 7):
        row = {'live_trades': k}
        row['no_backtest'] = score_live(live[:k], [], 'no_backtest')[0]
        row['rule_46_test31'] = score_live(live[:k], [t31], 'rule_46')[0]
        row['rule_47_tests31_30'], row['rule_47_weight'] = score_live(live[:k], [t31, t30], 'rule_47')
        replay['after_trade'].append(row)
    replay['rule_47_positive_mirror'] = score_live(live, [dict(t31, ds=-t31['ds']), dict(t30, ds=-t30['ds'])], 'rule_47')[0]
    out = {'params': dict(n_bt=N_BT, tests=M, trials=TRIALS, missing_share=MISSING, paths=PATHS, expected_max=round(EM, 4)),
           'grid': grid, 'replay': replay}
    json.dump(out, open(HERE / 'evidence_gate.json', 'w'), indent=1)
    for r in grid:
        print(f"{r['steward']:10s} sh={r['sharpe']} {r['scenario']:8s} {r['rule']:11s} medX={r['median_x']:<7} P2x={r['p2x']:<6} "
              f"DD50={r['p_dd50']:<6} ruin={r['p_ruin80']:<6} Pproven={r['p_proven']:<6} tProven={r['med_trades_to_proven']} "
              f"gate80<10={r['p_gate80_before_10_live']:<6} score@3/6/10/20={r['mean_score']}")
    print(json.dumps(replay, indent=1))
