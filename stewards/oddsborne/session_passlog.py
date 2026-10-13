"""Fresh re-quote of every date-matched sports side from a session_daily.py / session_pm.py run, then log passes
via steward_rpc.log_decision.
Usage: session_passlog.py [--session am|pm] [--date YYYY-MM-DD] [--extra-market SLUG ...] [--existing SLUG:SIDE ...] [--log]
  --date defaults to ODDS_DATE or today in America/New_York; --session defaults to am.
  --extra-market: markets the sweep missed, probed directly. --existing: held/resting sides that are not passes
  (verify them live first). Gate-clearing sides that were not entered are logged as passes with an explicit reason. Never invents prices: a side with no live BBO or no Bovada fair is not logged."""
import argparse, json, os, sys, time, importlib.util
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
sys.path.insert(0, "/workspace/oddsborne"); sys.path.insert(0, "/workspace/oddsborne/deepdive_raw")
from load_secrets import load_secrets
from polymarket_us import PolymarketUS
import _afternoon_helpers_20260930 as H
import steward_rpc
ap = argparse.ArgumentParser()
ap.add_argument("--session", choices=("am", "pm"), default="am")
ap.add_argument("--date", default=os.environ.get("ODDS_DATE") or datetime.now(ZoneInfo("America/New_York")).date().isoformat())
ap.add_argument("--extra-market", action="append", default=[])
ap.add_argument("--existing", action="append", default=[], help="SLUG:SIDE held or resting")
ap.add_argument("--log", action="store_true")
ARGS = ap.parse_args()
DSTAMP = ARGS.date.replace("-", "")
_src = "session_daily.py" if ARGS.session == "am" else "session_pm.py"
_argv, sys.argv = sys.argv, [_src, "--date", ARGS.date]  # session module reads its date from argv; never --dry-run here
spec = importlib.util.spec_from_file_location("s", f"/workspace/oddsborne/deepdive_raw/{_src}")
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
sys.argv = _argv
aft = S.aft
OUT = Path("/workspace/oddsborne")
LOG = ARGS.log
SESSION = f"{DSTAMP}_{ARGS.session}"

prev = json.loads((OUT / f"session_raw_{SESSION}_sports_dated.json").read_text())
DISCOVERY_ERROR = prev.get("discovery_error")
_res_path = OUT / f"session_raw_{SESSION}_result.json"
if not DISCOVERY_ERROR and _res_path.exists():
    DISCOVERY_ERROR = json.loads(_res_path.read_text()).get("discovery_error")
if DISCOVERY_ERROR or not prev.get("comps"):
    _msg = DISCOVERY_ERROR or f"ERROR: session {SESSION} has zero date-matched sports comps; nothing to pass-log (check discovery)"
    print("!" * 80, file=sys.stderr, flush=True)
    print(f"ERROR passlog {SESSION}: {_msg}", file=sys.stderr, flush=True)
    print("!" * 80, file=sys.stderr, flush=True)
    print(f"ERROR passlog {SESSION}: {_msg}", flush=True)
    if DISCOVERY_ERROR:
        sys.exit(2)
markets = []
for cp in prev["comps"]:
    if cp["market"] not in markets:
        markets.append(cp["market"])
markets += [m for m in ARGS.extra_market if m not in markets]  # missed by sweep (no p2 event match), probed directly

# fresh Bovada
urls = {"mlb": "https://www.bovada.lv/services/sports/event/v2/events/A/description/baseball?marketFilterId=def&preMatchOnly=true&lang=en",
        "nfl": "https://www.bovada.lv/services/sports/event/v2/events/A/description/football/nfl?marketFilterId=def&preMatchOnly=true&lang=en"}
games = []
for k, u in urls.items():
    p = OUT / f"session_raw_{SESSION}_bovada_{k}_relog.json"
    raw = aft.http_get(u)
    if raw.strip() in (b"", b"{}", b"[]"):
        time.sleep(1.0); raw = aft.http_get(u.split("?")[0] + "?lang=en")  # same fallback as daily
    if raw.strip() in (b"", b"{}", b"[]"):
        time.sleep(2.0); raw = aft.http_get(u)
    p.write_bytes(raw)
    games += S.parse_bovada_ts(p)

sec = load_secrets()
c = PolymarketUS(key_id=sec["POLYMARKET_US_KEY_ID"], secret_key=sec["POLYMARKET_US_SECRET_KEY"], timeout=45.0)
rows = []
for ms in markets:
    r = aft.call_retry(lambda ms=ms: c.markets.retrieve_by_slug(ms), f"get[{ms}]", 0.4)
    m = r.get("market", r) if isinstance(r, dict) else {}
    gst = datetime.fromisoformat(str(m.get("gameStartTime")).replace("Z", "+00:00")) if m.get("gameStartTime") else None
    lt = st = None
    for sd in (m.get("marketSides") or []):
        nm = (sd.get("team") or {}).get("name") or sd.get("description")
        if sd.get("long"): lt = nm
        else: st = nm
    g = None
    for gg in games:
        if gg["live"] or gg["start"] is None or gst is None: continue
        if abs((gg["start"] - gst).total_seconds()) <= 3 * 3600 and lt in gg["ml"] and st in gg["ml"]:
            g = gg; break
    if gst is not None and gst <= datetime.now(timezone.utc):
        rows.append({"market": ms, "error": f"game already started (gst={gst}); not a pass"}); continue
    raw, sb, tries = H.bbo_with_retry(c, ms, tries=4); time.sleep(0.4)
    bid, ask, spr = sb.get("bid"), sb.get("ask"), sb.get("spr")
    if g is None or bid is None or ask is None:
        rows.append({"market": ms, "error": f"no date-matched bovada or bbo (gst={gst}, long={lt}, bbo={bid}/{ask})"}); continue
    fm = aft.devig(g["ml"])
    dm = (S.MF.devig_methods(g["ml"]) or {}).get(lt)
    if not dm:
        rows.append({"market": ms, "error": f"no two-way de-vig for {lt}"}); continue
    am = {k: v["american"] for k, v in g["ml"].items()}
    for side in ("yes", "no"):
        cf = S.MF.conservative_fair(side, dm["power"], dm["shin"], dm["prop"])
        fair = cf["used"]  # 10-12: gate on conservative min(prop, power, Shin)
        team = lt if side == "yes" else st
        mk = bid if side == "yes" else round(1 - ask, 4)
        tk = ask if side == "yes" else round(1 - bid, 4)
        em_raw, et = S.post_fee_maker(fair, mk), S.post_fee(fair, tk)  # maker: +rebate; taker: -THETA fee
        em = S.post_fee_maker_gate(fair, mk)  # gate = raw - adverse-selection haircut; MIN_EDGE applies here
        rows.append({"market": ms, "side": side, "team": team, "fair": round(fair, 4), "fair_prop": cf["prop"], "fair_power": cf["power"], "fair_shin": cf["shin"], "fair_used": cf["used"], "fair_method": cf["method"], "maker": mk, "taker": tk,
                     "yes_bbo": f"{bid}/{ask}", "spr": spr, "pf_maker": em, "pf_maker_raw": em_raw, "maker_haircut": S.MAKER_HAIRCUT, "pf_taker": et, "bovada": am,
                     "bovada_start": g["start"].isoformat(), "gameStartTime": m.get("gameStartTime"),
                     "cand": em is not None and em >= S.MIN_EDGE and (spr or 1) <= 0.04})
for r in rows:
    print(json.dumps(r, default=str), flush=True)
cands = [r for r in rows if r.get("cand")]
print("CANDIDATES", len(cands), flush=True)
logged = []
# Entries were placed by the session run (no entry-count cap). Entered/held sides are not passes.
# Every other side is logged as a pass; a gate-clearing one gets an explicit not-entered reason.
_res = json.loads((OUT / f"session_raw_{SESSION}_result.json").read_text())
_enters = [se for se in (_res.get("sports_enters") or []) if isinstance(se, dict) and se.get("pick")]
def _side(se): return se.get("outcome") or se["pick"].get("outcome") or "yes"
ENTERED = {(se["pick"]["market"], _side(se)) for se in _enters if (se.get("live") or {}).get("decision") == "PLACED"}
EXISTING = {tuple(x.rsplit(":", 1)) for x in ARGS.existing}
ENTERED = ENTERED | EXISTING  # held/resting sides are not passes
NOT_ENTERED = {(x["market"], x.get("outcome") or "yes"): x.get("reason") for x in (_res.get("not_entered") or [])}
MKT_GAME = {cp["market"]: S.MF.game_key(cp) for cp in prev["comps"]}  # de-dup is per game, not per market slug
def _game(m): return MKT_GAME.get(m) or S.MF.game_key({"market": m})
ENTERED_GAMES = {_game(m) for m, _ in ENTERED}
ATTEMPTS = {(se["pick"]["market"], _side(se)): se for se in _enters}
print("ENTERED", sorted(ENTERED), flush=True)


def pass_reason(r):
    """Why a gate-clearing side was not entered."""
    k = (r["market"], r["side"])
    if k in NOT_ENTERED:
        return NOT_ENTERED[k]
    if _game(r["market"]) in ENTERED_GAMES:
        return "same_game"
    se = ATTEMPTS.get(k)
    if se is not None:
        j = se.get("live") or se.get("dry") or {}
        ref = j.get("refused") or {}
        if j.get("decision") == "REFUSED" and ref.get("gate") == "sizing":
            return f"guidance_cap ({str(ref.get('reason'))[:120]})"
        if j.get("decision") == "REFUSED":
            return f"refused_{ref.get('gate')} ({str(ref.get('reason'))[:120]})"
        if se.get("blocker"):
            return f"blocked_{se['blocker']}"
        if se.get("live") is None:
            return "not_live (dry-run only / ODDS_LIVE unset)"
        return f"not_placed ({j.get('decision')})"
    return "not_in_session_candidates (cleared only on re-quote)"


if LOG:
    for r in rows:
        if r.get("error"): continue
        if (r["market"], r["side"]) in ENTERED:
            print("SKIP_LOG_ENTERED", r["market"], r["side"], flush=True); continue
        sid = f"session_{SESSION}:{r['market']}:{r['side']}"
        reason = (f"{SESSION} pass: fair {r['fair']} [{r['fair_method']}; prop {r['fair_prop']} power {r['fair_power']} shin {r['fair_shin']}] ({r['team']}) maker@{r['maker']} taker@{r['taker']}; "
                  f"post-fee maker raw {r['pf_maker_raw']} (rebate {S.MAKER_REBATE}) gate {r['pf_maker']} "
                  f"(haircut {r['maker_haircut']}) taker {r['pf_taker']} (bar 0.01 on gate); Bovada {r['bovada']} "
                  f"start {r['bovada_start']} = gameStartTime {r['gameStartTime']}"
                  + (f"; CLEARED gate but not entered: {pass_reason(r)}" if r.get("cand") else ""))
        try:
            res = steward_rpc.log_decision("oddsborne", decision="skip", instrument=r["market"], side=r["side"],
                                           price=r["maker"], probability=r["fair"], thesis_id="sports_devig_maker_edge",
                                           reason=reason, source_id=sid)
        except Exception as e:
            res = {"error": f"{type(e).__name__}: {str(e)[:200]}"}
        logged.append({"m": r["market"], "side": r["side"], "price": r["maker"], "p": r["fair"],
                       "gameStartTime": r["gameStartTime"], "source_id": sid, "r": res})
        print("LOGGED", r["market"], r["side"], json.dumps(res, default=str), flush=True)
        time.sleep(0.2)
    (OUT / f"deepdive_raw/session_{SESSION}_pass_log.json").write_text(json.dumps(logged, indent=1, default=str))
(OUT / f"session_raw_{SESSION}_relog_quotes.json").write_text(json.dumps(rows, indent=1, default=str))
