"""Replay each steward's real trade sequence (returns on stake, in order) under rule sets.
Book starts at the steward's first recorded equity; stats are steward-level (history is mostly untagged)."""
import json, numpy as np
from sim import dd_scale, HERE
L = json.load(open(HERE / 'ledger.json'))
START = {'quantanamo': 5000.0, 'oddsborne': 424.07, 'bandit': 2.0207}
ACTUAL_END = {'quantanamo': 5500.65, 'oddsborne': 276.87, 'bandit': 1.8032}
STARTER_PCT = {'quantanamo': 250/5500.648, 'oddsborne': 15/276.87, 'bandit': 0.10/1.803194}
FIXED = {'quantanamo': 250.0, 'oddsborne': 15.0, 'bandit': 0.10}
def replay(st, rule):
    eq = START[st]; peak = eq; mdd = 0; n = 0; S = SS = 0.0; streak = 0; stakes = []
    for r in L[st]:
        m = S / n if n else 0; sd = np.sqrt(max((SS - n*m*m)/(n-1), 0)) if n >= 2 else 0
        lcb = m - sd/np.sqrt(n) if n >= 2 else -1
        unit = FIXED[st] if rule == 'current' else STARTER_PCT[st] * eq
        if n >= 10 and lcb > 0:
            f = max(unit, min(eq*0.5*lcb/sd**2 if sd > 0 else 1e9, unit * 2**(1+(n-10)/5)))
        else:
            f = unit
        if rule == 'current': f *= 0.5 ** min(streak, 2)
        else: f *= dd_scale(1 - eq/peak)
        f = min(f, eq); stakes.append(f)
        eq += f * r; peak = max(peak, eq); mdd = max(mdd, 1 - eq/peak)
        n += 1; S += r; SS += r*r; streak = streak + 1 if r < 0 else 0
    return dict(end=round(eq, 4), ret_pct=round(100*(eq/START[st]-1), 2), maxdd_pct=round(100*mdd, 2), avg_stake=round(float(np.mean(stakes)), 4))
out = {}
for st in L:
    out[st] = {'trades': len(L[st]), 'actual': {'end': ACTUAL_END[st], 'ret_pct': round(100*(ACTUAL_END[st]/START[st]-1), 2)},
               'current_rules': replay(st, 'current'), 'proposed_rules': replay(st, 'proposed')}
print(json.dumps(out, indent=1))
json.dump(out, open(HERE / 'replay.json', 'w'), indent=1)
