"""Court 2026-09-27: backtest evidence counts both ways (docs/rules/backtest-evidence-credit.md).

Monte Carlo of the evidence rule itself. A steward runs M preregistered, out-of-sample, cost-inclusive
tests of a thesis (each n_bt trades; each test's mean ~ N(true mean, sd / sqrt(n_bt)), sd = the
steward's ledger sd), then trades it live (sim.run, one year at ledger pace, 1,500 paths).
  credit_only_honest : the old rule, first test logged only if it survives (mean > 0 after trial
                       deflation with trials = M), one row, weight min(0.5 n, 20), mean shrunk 50%.
  credit_only_cherry : the old rule gamed: log only the best of the M tests, claim 1 trial.
  symmetric_all      : the ruling: all M tests logged pass or fail, each deflated by trials = M,
                       pooled weight capped at 20, mean shrunk 50% either sign.
  no_backtest        : live trades only.
Also: P(the 80 gate opens before any live trade) and P(proven before any live trade) at zero edge,
and the replay of earnings_gap_structure's real live sequence with and without test 31."""
import json, math
from multiprocessing import Pool
import numpy as np
from sim import run, L, RATE, HERE

DD = (0.10, 0.40, 0.5)
POLICY = {'kind': 'edge', 's': 0.05, 'scale_with_book': True, 'dd': DD}
N_BT, M = 200, 5
G = 0.5772156649

def zq(p):
    from statistics import NormalDist
    return NormalDist().inv_cdf(p)

def emax(n):
    return 0.0 if n <= 1 else (1 - G) * zq(1 - 1 / n) + G * zq(1 - 1 / (n * math.e))

def phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))

def sampler(kind, sd):
    se = sd / math.sqrt(N_BT); w1 = min(0.5 * N_BT, 20); defl = emax(M) * se
    def f(rng, mu):
        means = mu + rng.normal(0, se, M)
        if kind == 'credit_only_honest':
            m = means[0] - defl
            return (w1, means[0], sd) if m > 0 else (0.0, 0.0, sd)
        if kind == 'credit_only_cherry':
            b = means.max()
            return (w1, b, sd) if b > 0 else (0.0, 0.0, sd)
        if kind == 'symmetric_all':
            return (min(w1 * M, 20.0), float(np.mean(means - defl)), sd)
        return (0.0, 0.0, sd)
    return f

def gate_stats(kind, st, sh, paths=20000, seed=11):
    rng = np.random.default_rng(seed); sd = float(L[st].std(ddof=1)); mu = sh * sd
    f = sampler(kind, sd); gate = proven = 0
    for _ in range(paths):
        w, m, s = f(rng, mu)
        if w <= 0: continue
        z = 0.5 * m / (max(s, 0.25) / math.sqrt(w)); gate += phi(z) >= 0.80
        proven += w >= 10 and 0.5 * m - s / math.sqrt(w) > 0
    return round(gate / paths, 4), round(proven / paths, 4)

KINDS = ['no_backtest', 'credit_only_honest', 'credit_only_cherry', 'symmetric_all']

def job(a):
    st, sh, kind = a
    sd = float(L[st].std(ddof=1)); mu = sh * sd
    bt = None if kind == 'no_backtest' else {'sample': sampler(kind, sd), 'haircut': 0.5}
    r = run(st, mu, POLICY, RATE[st], paths=1500, bt=bt)
    g, p = gate_stats(kind, st, sh)
    return dict(steward=st, sharpe=sh, rule=kind, gate80_before_live=g, proven_before_live=p, **r)

def score(live, bt):
    """Results score as coded (41 + 46): n_eff = n + W, pooled mean with the backtest mean shrunk 50%,
    sd_eff = max(pooled sd, 0.25), score = 100 Phi(mean / (sd / sqrt(n_eff))) when n_eff >= 3."""
    n = len(live); w = bt['w'] if bt else 0.0; ne = n + w
    if ne < 3: return None
    m = float(np.mean(live)) if n else 0.0
    mean = (n * m + w * 0.5 * (bt['mean'] if bt else 0)) / ne
    sdl = float(np.std(live, ddof=1)) if n >= 2 else None
    if sdl is not None and w > 0: var = (n * sdl ** 2 + w * bt['sd'] ** 2) / ne
    elif sdl is not None: var = sdl ** 2
    elif w > 0: var = bt['sd'] ** 2
    else: var = 0
    sde = max(math.sqrt(var), 0.25)
    return round(100 * phi(mean / (sde / math.sqrt(ne))))

if __name__ == '__main__':
    jobs = [(st, sh, k) for st in ('quantanamo', 'bandit') for sh in (0.0, 0.1, 0.2) for k in KINDS]
    with Pool(8) as p:
        grid = p.map(job, jobs)
    # Replay: earnings_gap_structure's six live returns on stake, in order (trade_outcomes, 2026-09-27),
    # with and without test 31 (714 trades, mean -0.3457%, sd 6.2007%, trial 17, survivors only).
    live = [-0.00032, 0.1842, 0.41473, -0.16427, -0.15105, -0.19404]
    t31 = {'n': 714, 'mean': -0.003457, 'sd': 0.062007, 'trials': 17, 'survivors_only': True}
    w31 = min(0.5 * t31['n'], 20) * 0.5
    d31 = emax(t31['trials']) * t31['sd'] / math.sqrt(t31['n'])
    bt31 = {'w': w31, 'mean': t31['mean'] - d31, 'sd': t31['sd']}
    replay = {'thesis': 'earnings_gap_structure', 'live_returns': live,
              'test31': {**t31, 'weight': w31, 'expected_max_17': round(emax(17), 4), 'trial_deflation': round(d31, 6),
                         'mean_deflated': round(t31['mean'] - d31, 6)},
              'score_after_each_trade_old_rule': [score(live[:k], None) for k in range(1, 7)],
              'score_after_each_trade_new_rule': [score(live[:k], bt31) for k in range(1, 7)],
              'score_positive_mirror': score(live, {**bt31, 'mean': -bt31['mean']}),
              'score_new_rule_no_survivor_discount': score(live, {**bt31, 'w': 20.0})}
    out = {'params': {'n_bt': N_BT, 'tests': M, 'expected_max_M': round(emax(M), 4), 'paths': 1500}, 'grid': grid, 'replay': replay}
    json.dump(out, open(HERE / 'evidence.json', 'w'), indent=1)
    for r in grid:
        print(f"{r['steward']:10s} sh={r['sharpe']} {r['rule']:19s} gate80@0={r['gate80_before_live']:<6} proven@0={r['proven_before_live']:<6} "
              f"medX={r['median_x']:<7} P2x={r['p2x']:<6} DD50={r['p_dd50']:<6} ruin={r['p_ruin80']:<6} tProven={r['med_trades_to_proven']} Pproven={r['p_proven']}")
    print(json.dumps(replay, indent=1))
