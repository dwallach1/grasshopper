"""Render docs/rules/SIMULATION.md from grid.json, grid2.json and replay.json."""
import json, pathlib
H = pathlib.Path(__file__).resolve().parent
g = json.load(open(H / 'grid.json')); g2 = json.load(open(H / 'grid2.json')); rp = json.load(open(H / 'replay.json'))
L = json.load(open(H / 'ledger.json'))
import numpy as np
out = ["# Rules-court simulation (2026-09-26)", "",
"Reproduce with `python3 tools/court/grid.py && python3 tools/court/grid2.py && python3 tools/court/replay.py && python3 tools/court/report.py`. `ledger.json` holds each steward's closed, priced, non-paper returns on stake (`realized_pnl / cost`), in order, exported from `trade_outcomes`.", "",
"## Assumptions", "",
"- **Trades are sequential**, one position at a time. The Monte Carlo can't see concurrent correlated positions; see portfolio-exposure.",
"- **Returns are bootstrapped** from the steward's real returns on stake, then re-centred to a hypothetical true mean `mu = Sharpe/trade x sd`, floored at -1.06. Shape (fat tails, rugs, binary payoffs) comes from the ledger; the level of edge is the scenario.",
"- **The horizon is one year at ledger pace**: QUANTANAMO 100, ODDSBORNE 150, BANDIT 400 trades. There are 1,500 paths per cell, and the book starts at 1.0 (today's equity).",
"- **The rules are simulated as coded**: starter; proven at n ≥ 10 with 1σ LCB > 0; half-Kelly on the LCB; growth ≤ starter x 2^(1+(n-10)/5); cash only (stake ≤ equity). The sim tracks a single thesis per steward.",
"- **Drawdown scaling** is x1 at ≤ 10% below peak, linear to x0.5 at ≥ 40%.",
"- **QUANTANAMO stress**: with 7 trades, the worst return on stake is -19%, which understates gap risk. The stress rows add a 5% chance per trade of a -40% gap.",
"- **Backtest credit**: 30 backtest trades at weight 0.5 with a 50% mean haircut. The backtest mean = true mean + estimation noise (+ a fake +0.2 Sharpe in the overfit case).",
"- **Metrics**: `medX` is the median terminal multiple. `P2x` / `P10x` are the chance of touching 2x or 10x within the year. `DD50` is P(a peak-to-trough drawdown ≥ 50%). `ruin` is P(book < 20% of start).",
"- **Limits**: the samples are tiny (QUANTANAMO 7, ODDSBORNE 8, BANDIT 35), so the real edge is unknown; that's why every table is conditional on the true Sharpe. Nothing here is a P/L forecast.", "",
"## Ledger statistics (return on stake)", "", "| Steward | n | mean | sd | 1σ LCB | hit | P(loss) | P(loss \\| prev loss) | lag-1 corr |", "|---|---|---|---|---|---|---|---|---|"]
for s, r in L.items():
    r = np.array(r); n = len(r); m = r.mean(); sd = r.std(ddof=1); loss = r < 0
    pl = loss[1:][loss[:-1]].mean()
    out.append(f"| {s} | {n} | {m:+.4f} | {sd:.4f} | {m - sd/np.sqrt(n):+.4f} | {(r>0).mean():.2f} | {loss.mean():.2f} | {pl:.2f} | {np.corrcoef(r[:-1], r[1:])[0,1]:+.3f} |")
out += ["", "## Grid 1: current rules vs alternatives", "",
"`A_current` is fixed-dollar starter (5% of today's book), loss halving, 1σ. `C` is starter as a share of current book, plus drawdown scaling. `fixed_x%` is a fixed fraction of equity with no learning, for reference.", ""]
cur = None
for st, sh, mu, name, r in g:
    if (st, sh) != cur:
        cur = (st, sh); out += ["", f"**{st}, true Sharpe/trade {sh} (mu {mu:+.4f})**", "", "| policy | medX | P2x | P10x | DD50 | ruin | trades to 2x | trades to proven | P(proven) |", "|---|---|---|---|---|---|---|---|---|"]
    out.append(f"| {name} | {r['median_x']} | {r['p2x']} | {r['p10x']} | {r['p_dd50']} | {r['p_ruin80']} | {r['med_trades_to_2x']} | {r['med_trades_to_proven']} | {r['p_proven']} |")
out += ["", "## Grid 2: halving vs drawdown scaling; vol-normalized starters (David's options)", "",
"`volstarter_vX%` means stake = X% x book / sd(return on stake), so every unproven bet risks the same book volatility (QUANTANAMO sd floored at 0.25). `s` is the resulting starter as a share of book.", ""]
cur = None
for st, sh, mu, name, stress, s, r in g2['grid2']:
    if (st, sh, stress) != cur:
        cur = (st, sh, stress); out += ["", f"**{st}, Sharpe {sh}{' (gap stress: 5% x -40%)' if stress else ''}**", "", "| policy | starter share | medX | P2x | P10x | DD50 | ruin |", "|---|---|---|---|---|---|---|"]
    out.append(f"| {name} | {s} | {r['median_x']} | {r['p2x']} | {r['p10x']} | {r['p_dd50']} | {r['p_ruin80']} |")
out += ["", "## Backtest-evidence credit", "", "| steward | true Sharpe | fake backtest Sharpe bias | policy | medX | P2x | DD50 | trades to proven | P(proven) |", "|---|---|---|---|---|---|---|---|---|"]
for st, sh, b, nm, r in g2['bt']:
    out.append(f"| {st} | {sh} | {b} | {nm} | {r['median_x']} | {r['p2x']} | {r['p_dd50']} | {r['med_trades_to_proven']} | {r['p_proven']} |")
out += ["", "## Replay of the real sequences", "", "| steward | trades | actual book change | current rules | proposed rules | max DD current | max DD proposed |", "|---|---|---|---|---|---|---|"]
for st, v in rp.items():
    out.append(f"| {st} | {v['trades']} | {v['actual']['ret_pct']}% | {v['current_rules']['ret_pct']}% | {v['proposed_rules']['ret_pct']}% | {v['current_rules']['maxdd_pct']}% | {v['proposed_rules']['maxdd_pct']}% |")
out += ["", "The actual QUANTANAMO change includes unrealized gains on open lots sized at $1,000-2,500, which the closed-trade replay can't see. On closed trades alone, all rule sets are roughly flat, because the 7 closed trades net about +$13.", "",
"## Starter level options (David)", "",
"A vol-normalized starter gives the same book risk per unproven bet: stake = v x book / sd(return on stake). The sd values are QUANTANAMO 0.25 (floor; ledger 0.22), BANDIT 0.449 and ODDSBORNE 1.957. Books are as of 2026-09-26.", "",
"| Option | QUANTANAMO | BANDIT | ODDSBORNE |", "|---|---|---|---|",
"| Today (flat ~5%) | $250 (4.5%) → 1.1% book vol/bet | 0.10 SOL (5.5%) → 2.5% | $15 (5.4%) → 10.6% |",
"| v = 2% | $440 (8%) | 0.080 SOL (4.5%) | $2.83 (1.0%) |",
"| v = 3% | $660 (12%) | 0.12 SOL (6.7%) | $4.24 (1.5%) |",
"| v = 4% | $880 (16%) | 0.16 SOL (8.9%) | $5.66 (2.0%) |", "",
"All values are then x the drawdown scale (ODDSBORNE x0.5 today). See Grid 2 for P(2x) and P(DD50) under each option."]
(H.parents[1] / 'docs' / 'rules' / 'SIMULATION.md').write_text("\n".join(out) + "\n")
print("ok")
