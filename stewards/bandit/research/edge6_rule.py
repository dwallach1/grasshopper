"""edge6 meme_flush_rebound: the locked signal and house-exit path (edge6_prereg.md). Pure functions, no I/O.
Bars: [ts, open, high, low, close, volume_usd], 5m, ascending, closed bars only."""
BAR = 300; TP, KILL, COST, HOLD = 1.50, 0.60, 0.02, 48
LO, HI, MIN_VOL6H = 0.50, 0.70, 50_000


def e2_bar(b, t):
    """edge2 meme_pullback_reclaim on bar t (same test as the scan's _e2_bar); edge2 has precedence."""
    if t < 71: return False
    w = b[t-71:t+1]; cl = [x[4] for x in w]; P = max(cl); pi = cl.index(P)
    if not (pi > 0 and len(w) - 1 - pi >= 6): return False
    L = min(cl[:pi]); c = b[t][4]
    return P / L - 1 >= 0.40 and 0.6 * P <= c <= 0.8 * P and c > b[t-1][2] and sum(x[5] for x in w) >= 50000


def signal(b, t):
    """Info dict if closed bar t is an edge6 signal, else None. Needs t >= 72."""
    if t < 72: return None
    w = b[t-71:t+1]; H = max(x[2] for x in w); c = b[t][4]; vol = sum(x[5] for x in w)
    if not (H > 0 and c > 0): return None
    d = c / H
    if not (LO <= d <= HI and vol >= MIN_VOL6H): return None
    if e2_bar(b, t): return None
    return dict(flush_pct=round((1 - d) * 100, 2), h6_high=H, vol6h_usd=round(vol))


def exit_path(b, i):
    """House exits from entry at open of bar i: (gross, trigger, exit_ts, flagged_incomplete)."""
    e = b[i][1]; end = b[i][0] + HOLD * BAR; last = None
    for k in range(i, len(b)):
        x = b[k]
        if x[0] >= end: break
        if x[3] <= e * KILL: return KILL - 1, "kill", x[0], False
        if x[2] >= e * TP: return TP - 1, "tp_full", x[0], False
        last = x
    return last[4] / e - 1, "4h_stop", last[0], b[-1][0] < b[i][0] + (HOLD - 1) * BAR


def trades(b):
    """All edge6 trades in one pool's bars; dedupe: next signal at/after the prior exit and >= 48 bars later."""
    out = []; nxt = 0
    for t in range(72, len(b) - 1):
        if t < nxt: continue
        s = signal(b, t)
        if not s: continue
        if b[t+1][1] <= 0: continue
        g, trig, xts, inc = exit_path(b, t + 1)
        out.append(dict(signal_ts=b[t][0], entry_ts=b[t+1][0], entry=b[t+1][1], gross=g, net=g - COST,
                        trigger=trig, exit_ts=xts, incomplete=inc, **s))
        xi = next((k for k in range(t + 1, len(b)) if b[k][0] >= xts), len(b))
        nxt = max(xi, t + 48)
    return out
