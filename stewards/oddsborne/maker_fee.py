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


if __name__ == "__main__":
    print(json.dumps(HAIRCUT_INFO, indent=1))
