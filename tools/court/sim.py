"""Rules-court Monte Carlo (2026-09-26). Sequential trades, one position at a time.
Returns per trade are bootstrapped from each steward's real ledger returns (return on stake,
trade_outcomes realized_pnl / cost), re-centred to a hypothetical true mean `mu`
(r' = r - mean(r) + mu, floored at -1.06). Book starts at 1.0 (= today's equity)."""
import json, sys, pathlib, numpy as np
HERE = pathlib.Path(__file__).resolve().parent

L = {k: np.array(v) for k, v in json.load(open(HERE / 'ledger.json')).items()}
RATE = {'quantanamo': 100, 'oddsborne': 150, 'bandit': 400}   # trades per year (ledger pace, rounded)

def dd_scale(dd, lo=0.10, hi=0.40, floor=0.5):
    if dd <= lo: return 1.0
    if dd >= hi: return floor
    return 1.0 - (1.0 - floor) * (dd - lo) / (hi - lo)

def run(steward, mu, policy, n_trades, paths=4000, seed=7, bt=None, tail=None):
    rng = np.random.default_rng(seed)
    base = L[steward]; pool = np.maximum(base - base.mean() + mu, -1.06)
    P = policy
    term = np.empty(paths); maxdd = np.empty(paths); ruin = np.zeros(paths, bool)
    t2x = np.full(paths, np.nan); t10 = np.full(paths, np.nan); tproven = np.full(paths, np.nan)
    for p in range(paths):
        eq = 1.0; peak = 1.0; mdd = 0.0; n = 0; S = 0.0; SS = 0.0; streak = 0
        # optional backtest evidence: n_bt pseudo-trades with mean = mu + bias, weight w
        bt_n = bt_mean = bt_sd = 0; bt_w = 0.0
        if bt and 'sample' in bt:
            # per-path evidence (evidence.py): pooled weight, pooled mean before the 50% shrink, sd
            bt_w, bt_mean, bt_sd = bt['sample'](rng, mu)
        elif bt:
            bt_n = bt['n']; bt_mean = mu + bt['bias'] + rng.normal(0, base.std() / np.sqrt(bt['n'])); bt_sd = base.std()
            bt_w = bt['w'] * bt_n
        for t in range(n_trades):
            m_live = S / n if n else 0.0
            sd_live = np.sqrt(max((SS - n * m_live * m_live) / (n - 1), 0.0)) if n >= 2 else 0.0
            if bt and bt_w > 0:
                ne = n + bt_w
                mean = (n * m_live + bt_w * bt_mean * bt['haircut']) / ne if ne else 0
                sd = sd_live if n >= 2 else bt_sd
                sd = max(sd, bt_sd * 0.5)
                lcb = mean - P.get('z', 1) * sd / np.sqrt(ne) if ne >= 2 else -1
            else:
                ne = n
                mean = m_live
                sd = sd_live
                lcb = mean - P.get('z', 1) * sd / np.sqrt(n) if n >= 2 else -1
            proven = ne >= 10 and lcb > 0
            if proven and np.isnan(tproven[p]): tproven[p] = t
            if P['kind'] == 'fixed':           # fixed fraction of current equity, no learning
                f = P['s'] * eq
            else:
                s_unit = P['s'] * (eq if P.get('scale_with_book') else 1.0)
                if proven:
                    growth = s_unit * 2 ** (1 + (ne - 10) / 5)
                    kelly = eq * P.get('kelly_frac', 0.5) * lcb / (sd * sd) if sd > 0 else growth
                    f = max(s_unit, min(kelly, growth))
                else:
                    f = s_unit
                if P.get('halving'): f *= 0.5 ** min(streak, 2)
                if P.get('dd'): f *= dd_scale(1 - eq / peak, *P['dd'])
            f = min(f, eq)                     # cash only, no margin
            r = pool[rng.integers(len(pool))]
            if tail and rng.random() < tail[0]: r = tail[1]
            eq += f * r; eq = max(eq, 0.0)
            n += 1; S += r; SS += r * r; streak = streak + 1 if r < 0 else 0
            peak = max(peak, eq); mdd = max(mdd, 1 - eq / peak)
            if eq <= 0.2: ruin[p] = True
            if eq >= 2 and np.isnan(t2x[p]): t2x[p] = t + 1
            if eq >= 10 and np.isnan(t10[p]): t10[p] = t + 1
            if eq <= 0.01: break
        term[p] = eq; maxdd[p] = mdd
    med = lambda a: float(np.nanmedian(a)) if np.isfinite(a).any() else None
    return dict(median_x=round(float(np.median(term)), 3), p2x=round(float(np.mean(~np.isnan(t2x))), 3),
                p10x=round(float(np.mean(~np.isnan(t10))), 3), p_dd50=round(float(np.mean(maxdd >= 0.5)), 3),
                p_ruin80=round(float(ruin.mean()), 3), med_trades_to_2x=med(t2x), med_trades_to_proven=med(tproven),
                p_proven=round(float(np.mean(~np.isnan(tproven))), 3))
