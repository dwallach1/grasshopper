"""ODDSBORNE maker_fee: post-fee maker edge for Polymarket US (shared by session/passlog scripts).

Fee schedule (Polymarket US, eff. 2026-10-07; ledger maker fills fit ~0.0124):
  taker pays   THETA        * p * (1-p),  THETA        = 0.0695  (pm_enter.fee_per_contract)
  maker RECEIVES MAKER_REBATE * p * (1-p),  MAKER_REBATE = 0.0125

  raw maker edge  = fair - price + MAKER_REBATE*p*(1-p)
  gate maker edge = raw - haircut          (the MIN_EDGE 1c bar applies to the GATE number)

Adverse-selection haircut (desk review 2026-10-11), from maker_score_latest.json:
  computed = v2 assumed-fill mean edge vs close (c/game) - v3b touched-pass mean edge vs close (c/game)
  n_games < 30  -> haircut = max(0.59c, computed)   (refreshes can only raise it, never below 0.59c)
  n_games >= 30 -> haircut = max(0, computed)
  file missing / unreadable -> 0.59c
"""
from __future__ import annotations

import json
from pathlib import Path

THETA = 0.0695
MAKER_REBATE = 0.0125
HAIRCUT_FLOOR_PRE30 = 0.0059  # 0.59c, guardrail until maker_score has >= 30 games
HAIRCUT_MIN_GAMES = 30
_HERE = Path(__file__).resolve().parent
SCORE_PATHS = [Path("/workspace/oddsborne/maker_score_latest.json"),
               Path("/workspace/oddsborne/deepdive_raw/maker_score_latest.json"),
               _HERE / "maker_score_latest.json", _HERE / "deepdive_raw" / "maker_score_latest.json"]


def taker_fee(p: float) -> float:
    return THETA * p * (1.0 - p)


def maker_rebate(p: float) -> float:
    return MAKER_REBATE * p * (1.0 - p)


def post_fee_taker(fair, price):
    if fair is None or price is None:
        return None
    return round(fair - price - taker_fee(price), 6)


def post_fee_maker_raw(fair, price):
    if fair is None or price is None:
        return None
    return round(fair - price + maker_rebate(price), 6)


def load_haircut(paths=None) -> dict:
    """Return {'haircut': dollars/contract, 'computed', 'n_games', 'source', 'rule'}. Never raises."""
    for p in (paths or SCORE_PATHS):
        try:
            p = Path(p)
            if not p.exists():
                continue
            d = json.loads(p.read_text())
            assumed_c = float(d["v2_maker_all_fills"]["vs_close"]["mean_edge_c_per_game"])
            touched_c = float(d["v3b_book_touch_proxy"]["edge_vs_close_if_touched"]["mean_edge_c_per_game"])
            n_games = int(d.get("n_games") or 0)
            computed = (assumed_c - touched_c) / 100.0
            if n_games < HAIRCUT_MIN_GAMES:
                h, rule = max(HAIRCUT_FLOOR_PRE30, computed), f"n_games {n_games}<{HAIRCUT_MIN_GAMES}: max(0.59c, computed)"
            else:
                h, rule = max(0.0, computed), f"n_games {n_games}>={HAIRCUT_MIN_GAMES}: max(0, computed)"
            return {"haircut": round(h, 6), "computed": round(computed, 6), "assumed_fill_c": assumed_c,
                    "touched_c": touched_c, "n_games": n_games, "source": str(p), "rule": rule}
        except Exception as e:  # malformed file: try next, else default
            last = f"{type(e).__name__}: {str(e)[:120]}"
            continue
    return {"haircut": HAIRCUT_FLOOR_PRE30, "computed": None, "n_games": None, "source": None,
            "rule": "maker_score_latest.json missing/unreadable: default 0.59c"}


HAIRCUT_INFO = load_haircut()
HAIRCUT = HAIRCUT_INFO["haircut"]


def post_fee_maker_gate(fair, price, haircut: float | None = None):
    raw = post_fee_maker_raw(fair, price)
    if raw is None:
        return None
    return round(raw - (HAIRCUT if haircut is None else haircut), 6)


# ---------------------------------------------------------------------------
# Two-way de-vig (2026-10-12): proportional no-vig overstates underdogs (favourite-longshot bias).
# The GATE uses conservative_fair(): the fair giving the LOWER edge for the side being bought,
# i.e. min(proportional, power, Shin) of that side's fair.
# ---------------------------------------------------------------------------
def am_to_implied(american) -> float | None:
    try:
        a = float(str(american).replace("+", "").replace("\u2212", "-"))
    except Exception:
        return None
    if a == 0:
        return None
    return 100.0 / (a + 100.0) if a > 0 else (-a) / (-a + 100.0)


def _bisect(f, lo, hi, n=200):
    flo = f(lo)
    for _ in range(n):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if (fm > 0) == (flo > 0):
            lo, flo = mid, fm
        else:
            hi = mid
    return 0.5 * (lo + hi)


def devig_proportional(pa: float, pb: float):
    s = pa + pb
    return pa / s, pb / s


def devig_power(pa: float, pb: float):
    """Find k with pa**k + pb**k = 1 (k>=1 when overround>0)."""
    if pa + pb <= 1.0:
        return devig_proportional(pa, pb)
    k = _bisect(lambda k: pa ** k + pb ** k - 1.0, 1.0, 50.0)
    a, b = pa ** k, pb ** k
    return a / (a + b), b / (a + b)


def devig_shin(pa: float, pb: float):
    """Shin (1993) insider-share model, solved for z so the two fairs sum to 1."""
    s = pa + pb
    if s <= 1.0:
        return devig_proportional(pa, pb)

    def fair(pi, z):
        return (((z * z + 4.0 * (1.0 - z) * pi * pi / s) ** 0.5) - z) / (2.0 * (1.0 - z))

    z = _bisect(lambda z: fair(pa, z) + fair(pb, z) - 1.0, 0.0, 0.999)
    a, b = fair(pa, z), fair(pb, z)
    return a / (a + b), b / (a + b)


def devig_methods(ml: dict) -> dict:
    """ml: {team: {'american': .., 'p': implied?}} (two-way). Returns {team: {'prop','power','shin'}} or {}."""
    items = []
    for k, v in (ml or {}).items():
        p = v.get("p") if isinstance(v, dict) else None
        if p is None and isinstance(v, dict):
            p = am_to_implied(v.get("american"))
        if p is None and not isinstance(v, dict):
            p = am_to_implied(v)
        if p is not None and 0 < float(p) < 1:
            items.append((k, float(p)))
    if len(items) != 2:
        return {}
    (ka, pa), (kb, pb) = items
    out = {ka: {}, kb: {}}
    for name, fn in (("prop", devig_proportional), ("power", devig_power), ("shin", devig_shin)):
        a, b = fn(pa, pb)
        out[ka][name], out[kb][name] = round(a, 6), round(b, 6)
    return out


def conservative_fair(side: str, power_yes: float, shin_yes: float, prop_yes: float | None = None) -> dict:
    """Fair for buying `side` ('yes'|'no') given the YES team's power/Shin fairs.
    YES buy -> min(prop, power, shin) of YES; NO buy -> min(1-prop, 1-power, 1-shin) = 1 - max(...).
    prop_yes should always be passed; if omitted only power/Shin are compared.
    Returns {'prop','power','shin','used','method'} all expressed for the side bought."""
    side = (side or "").lower()
    if side == "yes":
        pw, sh = power_yes, shin_yes
        pr = prop_yes
    elif side == "no":
        pw, sh = 1.0 - power_yes, 1.0 - shin_yes
        pr = None if prop_yes is None else 1.0 - prop_yes
    else:
        raise ValueError(f"side must be yes/no, got {side!r}")
    cands = [(pw, "power"), (sh, "shin")] + ([] if pr is None else [(pr, "prop")])
    used, method = min(cands, key=lambda t: t[0])  # never more generous than any of prop/power/Shin
    return {"prop": None if pr is None else round(pr, 6), "power": round(pw, 6), "shin": round(sh, 6),
            "used": round(used, 6), "method": method}


if __name__ == "__main__":
    print(json.dumps(HAIRCUT_INFO, indent=1))
