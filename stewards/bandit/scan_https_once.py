"""READ-ONLY meme gate scan over HTTPS only (no db_connect, no DB writes, no orders signed/sent).
Universe + stats: Jupiter tokens v2 (same as _scan_live_once.py). Quote: Jupiter swap v2 /order at 0.12 SOL
(unsigned; never signed or executed). DexScreener cross-check on names that clear.
Ledger mints come from the Supabase connector (meme_positions JOIN meme_tokens), pasted in LEDGER below.
Output: /workspace/bandit/_scan_https_out.json (local file only).
"""
from __future__ import annotations
import json, os, statistics, time
from datetime import datetime, timezone
from decimal import Decimal, getcontext
from zoneinfo import ZoneInfo
import requests
from load_secrets import require

getcontext().prec = 50
SOL_MINT = "So11111111111111111111111111111111111111112"
WALLET = "3AKSqcwDwuH1CPC9ZBN6S8ajGjjeFUyqmaUiyxPFKRFG"
QUOTE_SOL = Decimal("0.12")
QUOTE_LAMPORTS = int(QUOTE_SOL * Decimal(10**9))
MIN_LIQ = 100_000
MAX_AGE_H = 14 * 24

# copied from _scan_live_once.py
SKIP = {
    "2PENPmfgJfq6CG3k4byj4oWwHf8SerqakmYHMkUupump": ("familiars", "just closed +50% full-bank / soft-skip"),
    "6HU4CmRb15C2nQDx8Ld2f2W2wTdmog6aZiiXdrT5Pzi8": ("GROK", "just closed TP50+rem / soft-skip"),
    "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP": ("SI", "just closed 4h / soft-skip"),
    "CdhZy8wrRxNxoV8HtoByXKN7mvS46avtuZ1b39tKfx7": ("X7", "soft-skip"),
    "3AKNTYP2u9RT2UEtQKMWhmfkmDWpSxBuBmTvgqFMpump": ("ACAT", "ACAT-lesson rug / soft-skip"),
    "4UHmZGe6X4DZ5dxYGiGXMhi3Sp34uPWtHB7qDMyvRbYB": ("QUEEF", "soft-skip"),
    "HgcxVs6kJhPAaGqnPNGaa7zYgNT49hJrLufiqcNMuYZT": ("FEELSGOOD", "soft-skip"),
    "GTBxUiw6wJdmmkCGZgRHLyYxqu1vG4KtRpeox6yDpump": ("JEANPHIL", "soft-skip"),
    "91ryaCo5yGpYZM3bs6GUPs97VWJQj7RozBmqPULgpump": ("TIGRINO", "soft-skip"),
    "73rBKgANTyD7RWjLvXCaMDb81Hhpz2ouv9dgzRdXpump": ("GTA6", "soft-skip"),
    "4QsNTBKwHgyYUUHq9tDzk1CCVu7y5hK7z3GE9R36pump": ("NUB", "soft-skip"),
    "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump": ("OTC", "soft-skip"),
    "8K5X85PAJHAAVSvYaAzgVPPAPsqqHmvx16ZyBiscYF8L": ("CTO", "soft-skip"),
    "A13oRB9FFaiUjfi6LdCg6p9ka1u8SfGkUFs4SKvPpump": ("TOAD", "soft-skip"),
    "4rkGWJNSUPBcMicXMRAzohEyeJLFG8gUjwiWaz7Pddr3": ("CRACKER", "high TH / soft-skip"),
    "9U1f18idDeySFnYrurxqT1f5n5nE4g4Uk5LLzP69bh1": ("SOLCAT", "ledger close"),
    "241aTYhVXZ4WBVSFpfY37RqoCGBQ73KiRFAKvTtnmoon": ("MCAT", "ledger close"),
    "DvdmEnztCmXwBnAbedD48XVGZJSxq31zNvnyftXdpump": ("PILL", "ledger close"),
    "98kfF7rmsg1QDUEoCqNE7g7M1FdrTt92TEp2CLzypump": ("PAID", "ledger close"),
    "88t4EdAjiuUDzHujJnK5nywitQzYQWEJq2ouUgRGpump": ("JUBJUB", "ledger close"),
    "AqoPZcUumKUBHrnfBsNtoNuneYEjoimaiWYq8GH8gpX9": ("STONK10", "ledger close"),
    "3nqHijNUExsnjNBb15WJsJ2xisyMVGN6FK4aUgZk1Rwj": ("TACZ", "ledger close"),
    "9oXA1VWKNiYDYa6VKHBFFBBvZdvuhw1b2eD5Aka7YrVt": ("FLAME", "ledger close"),
    "5dvXTZ5qwgafnHtwu3Ls3QrWx1U4LQsFeCuJgkk4QEC6": ("EMBER", "ledger close"),
    "Hg5Ja55T5wESq4vyFoiVCMeHXtGyVA69X2UHq8hgpump": ("BATON", "ledger close"),
    "CaWZeUM4FvX9dPkjGc2xHS6tSN3qJfTWyvaG77aM5o7h": ("AGI", "ledger close"),
    "8H5yfL1GoDETLDaLYZzrgQuZs37eiKJjdfP21b6ypump": ("SAAR", "ledger close"),
    "HcfnJxLov6tY8i1dq9uYRRZKCvxADPpovcfkyXzdpump": ("Chonketha", "ledger close"),
    "EbT2jpoeRJVFNWAFJE97EGfQF3iwHsEY8sh17fGbL5ER": ("ZDOG", "ledger close"),
}
# Supabase connector, 2026-10-06: SELECT DISTINCT t.mint, t.symbol FROM meme_positions p JOIN meme_tokens t
#   ON t.id=p.token_id WHERE p.account_key='solana-bandit-primary'   (31 rows)
LEDGER = {
    "3AKNTYP2u9RT2UEtQKMWhmfkmDWpSxBuBmTvgqFMpump": "ACAT", "CaWZeUM4FvX9dPkjGc2xHS6tSN3qJfTWyvaG77aM5o7h": "AGI",
    "Hg5Ja55T5wESq4vyFoiVCMeHXtGyVA69X2UHq8hgpump": "BATON", "HcfnJxLov6tY8i1dq9uYRRZKCvxADPpovcfkyXzdpump": "Chonketha",
    "nDZknLvfFRp5rgUHdzTrQsmSY5NKzoavqdLjSHVpump": "COLLECT", "8K5X85PAJHAAVSvYaAzgVPPAPsqqHmvx16ZyBiscYF8L": "CTO",
    "5dvXTZ5qwgafnHtwu3Ls3QrWx1U4LQsFeCuJgkk4QEC6": "EMBER", "2PENPmfgJfq6CG3k4byj4oWwHf8SerqakmYHMkUupump": "familiars",
    "HgcxVs6kJhPAaGqnPNGaa7zYgNT49hJrLufiqcNMuYZT": "FEELSGOOD", "9oXA1VWKNiYDYa6VKHBFFBBvZdvuhw1b2eD5Aka7YrVt": "FLAME",
    "HSUMi4rMgjrx7zRUabw3ogGu1pa5hmF2eVcXj9Apump": "goon", "6HU4CmRb15C2nQDx8Ld2f2W2wTdmog6aZiiXdrT5Pzi8": "GROK",
    "73rBKgANTyD7RWjLvXCaMDb81Hhpz2ouv9dgzRdXpump": "GTA6", "GTBxUiw6wJdmmkCGZgRHLyYxqu1vG4KtRpeox6yDpump": "JEANPHIL",
    "88t4EdAjiuUDzHujJnK5nywitQzYQWEJq2ouUgRGpump": "JUBJUB", "241aTYhVXZ4WBVSFpfY37RqoCGBQ73KiRFAKvTtnmoon": "MCAT",
    "4QsNTBKwHgyYUUHq9tDzk1CCVu7y5hK7z3GE9R36pump": "NUB", "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump": "OTC",
    "98kfF7rmsg1QDUEoCqNE7g7M1FdrTt92TEp2CLzypump": "PAID", "DvdmEnztCmXwBnAbedD48XVGZJSxq31zNvnyftXdpump": "PILL",
    "4UHmZGe6X4DZ5dxYGiGXMhi3Sp34uPWtHB7qDMyvRbYB": "QUEEF", "8H5yfL1GoDETLDaLYZzrgQuZs37eiKJjdfP21b6ypump": "SAAR",
    "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP": "SI", "9U1f18idDeySFnYrurxqT1f5n5nE4g4Uk5LLzP69bh1": "SOLCAT",
    "AqoPZcUumKUBHrnfBsNtoNuneYEjoimaiWYq8GH8gpX9": "STONK10", "3nqHijNUExsnjNBb15WJsJ2xisyMVGN6FK4aUgZk1Rwj": "TACZ",
    "91ryaCo5yGpYZM3bs6GUPs97VWJQj7RozBmqPULgpump": "TIGRINO", "A13oRB9FFaiUjfi6LdCg6p9ka1u8SfGkUFs4SKvPpump": "TOAD",
    "CdhZy8wrRxNxoV8HtoByXKN7mvS46avtuZ1b39tKfx7": "X7", "jLz71QZfjnZZMLjUaCBw7KmUyftkkNq8NkWi2u9dyap": "YAP",
    "EbT2jpoeRJVFNWAFJE97EGfQF3iwHsEY8sh17fGbL5ER": "ZDOG",
}
# standing skips: excluded unless they clear EVERY gate
STANDING = {
    "C1mBfBoDkwWfd6uTFZp62ARHLjeVp3bDpCDMfMZtPngE": "HOOKED",
    "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU": "e/acc",
    "GoADAwux19tGxb3W4ykPzZz8p5JCSYaxBRpuW7s9pump": "OCTO",
}
STANDING_SYM = {"HOOKED", "E/ACC", "OCTO"}
BAN_SYM = {
    "SOL","USDC","USDT","WSOL","BONK","WIF","JUP","RAY","TRUMP","PUMP","JTO","PYTH","ORCA",
    "MSOL","JITOSOL","WBTC","WETH","CBBTC","USDG","CASH","SPYX","NVDAX","AAPLX","TSLAX",
    "MET","ZEC","KMNO","HYPE","BTC","ETH","USD1","USDS","PYUSD","FDUSD","EURC",
    "JLP","JUPSOL","INF","DRIFT","RENDER","W","TNSR","CLOUD","MOBILE","HNT","DADDY",
}

headers = {"x-api-key": require("JUPITER_API_KEY")["JUPITER_API_KEY"]}
TOK = "https://api.jup.ag/tokens/v2"
JUP = "https://api.jup.ag/swap/v2"
PT = ZoneInfo("America/Los_Angeles")
now = datetime.now(timezone.utc)

def fetch_cat(path, params=None, retries=4):
    for i in range(retries):
        try:
            r = requests.get(f"{TOK}/{path}", headers=headers, params=params or {"limit": 100}, timeout=45)
        except Exception as e:
            print("err", path, type(e).__name__); time.sleep(1.5); continue
        if r.status_code == 429:
            time.sleep(1.5 * (i + 1)); continue
        if r.status_code != 200:
            print("http", path, r.status_code); return []
        d = r.json()
        return d if isinstance(d, list) else []
    print("giveup", path); return []

seen = {}
for cat in ("toptrending", "toptraded", "toporganicscore"):
    for iv in ("5m", "1h", "6h", "24h"):
        rows = fetch_cat(f"{cat}/{iv}", {"limit": 100})
        print(f"{cat}/{iv}: {len(rows)}")
        for t in rows:
            mid = t.get("id")
            if mid and (mid not in seen or float(t.get("liquidity") or 0) > float(seen[mid].get("liquidity") or 0)):
                t["_src"] = f"{cat}/{iv}"; seen[mid] = t
        time.sleep(0.35)
rows = fetch_cat("recent", {"limit": 100}); print("recent:", len(rows))
for t in rows:
    mid = t.get("id")
    if mid and mid not in seen:
        t["_src"] = "recent"; seen[mid] = t
# make sure the standing skips are evaluated even if they fell out of the category lists
missing = [m for m in STANDING if m not in seen]
if missing:
    try:
        r = requests.get(f"{TOK}/search", headers=headers, params={"query": ",".join(missing)}, timeout=45)
        for t in (r.json() if r.ok else []):
            if t.get("id") in STANDING and t["id"] not in seen:
                t["_src"] = "standing_lookup"; seen[t["id"]] = t
    except Exception as e:
        print("standing lookup err", type(e).__name__)
print("universe", len(seen))

def age_h(t):
    fp = t.get("firstPool") or {}
    c = fp.get("createdAt") or t.get("createdAt")
    if not c: return None
    try:
        if isinstance(c, (int, float)):
            ts = float(c); ts = ts / 1000 if ts > 1e12 else ts
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        else:
            dt = datetime.fromisoformat(str(c).replace("Z", "+00:00"))
            if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
        return (now - dt).total_seconds() / 3600
    except Exception:
        return None

def fnum(x):
    try: return None if x is None else float(x)
    except Exception: return None

rows_all = []
for mid, t in seen.items():
    sym = (t.get("symbol") or "").strip(); usym = sym.upper(); name = t.get("name") or ""
    liq = float(t.get("liquidity") or 0); ah = age_h(t)
    s5, s1, s6, s24 = (t.get(k) or {} for k in ("stats5m", "stats1h", "stats6h", "stats24h"))
    b1, se1 = float(s1.get("buyVolume") or 0), float(s1.get("sellVolume") or 0)
    v1 = b1 + se1
    nb, ns = int(s1.get("numBuys") or 0), int(s1.get("numSells") or 0)
    bs_vol = b1 / v1 if v1 else None
    bs_tx = nb / (nb + ns) if (nb + ns) else None
    pc5, pc1, pc6, pc24 = (fnum(s.get("priceChange")) for s in (s5, s1, s6, s24))
    row = dict(mint=mid, symbol=sym, name=name, decimals=t.get("decimals"), liq=liq, age_h=ah,
               pc5m=pc5, pc1h=pc1, pc6h=pc6, pc24h=pc24, v1h=v1, buy_share_vol_1h=bs_vol, buy_share_tx_1h=bs_tx,
               nbuy1h=nb, nsell1h=ns, usdPrice=t.get("usdPrice"), mcap=t.get("mcap"), launchpad=t.get("launchpad"),
               graduated=t.get("graduated"), organicScore=t.get("organicScore"), holders=t.get("holderCount"),
               src=t.get("_src"))
    excl = None
    if mid in LEDGER: excl = f"ledger {LEDGER[mid]}"
    elif mid in SKIP: excl = f"skip_dict {SKIP[mid][0]}"
    elif usym in BAN_SYM: excl = f"ban_sym {sym}"
    row["excluded"] = excl
    row["standing_skip"] = STANDING.get(mid) or (sym if usym in STANDING_SYM else None)
    f = []
    if liq < MIN_LIQ: f.append(f"liq ${liq:,.0f} < $100k")
    if ah is None: f.append("age unknown")
    elif ah >= MAX_AGE_H: f.append(f"age {ah/24:.1f}d >= 14d")
    if pc1 is None or pc1 < 5: f.append(f"1h {pc1 if pc1 is None else round(pc1,2)}% < +5%")
    if pc6 is None or pc6 < 10: f.append(f"6h {pc6 if pc6 is None else round(pc6,2)}% < +10%")
    if v1 < 25_000: f.append(f"1h vol ${v1:,.0f} < $25k")
    if max(bs_vol or 0, bs_tx or 0) < 0.52:
        f.append(f"buy share tx={None if bs_tx is None else round(bs_tx,4)} vol={None if bs_vol is None else round(bs_vol,4)} < 0.52")
    if pc5 is None or not pc5 > -8: f.append(f"5m {pc5 if pc5 is None else round(pc5,2)}% <= -8%")
    # desk rule #127 bandit-1h-entry-cap (+30%) repealed by GRASSHOPPER 2026-10-18: the original +200% ceiling is back.
    # Coins above +30% are still tagged (meta.hot_1h / chg_1h on every log, _hot_meta below), never blocked for it.
    if pc1 is not None and pc1 > 200: f.append(f"1h +{pc1:.0f}% > +200%")
    if pc24 is None or not pc24 > -40: f.append(f"24h {pc24 if pc24 is None else round(pc24,2)}% <= -40%")
    row["market_fails"] = f
    rows_all.append(row)

elig = [r for r in rows_all if not r["excluded"]]
mkt_pass = [r for r in elig if not r["market_fails"]]
one_fail = sorted([r for r in elig if len(r["market_fails"]) == 1], key=lambda r: -r["liq"])
two_fail = sorted([r for r in elig if len(r["market_fails"]) == 2], key=lambda r: -r["liq"])
print(f"eligible={len(elig)} market_pass={len(mkt_pass)} one_fail={len(one_fail)} two_fail={len(two_fail)}")

def jup_order(mint, slip=300):
    p = {"inputMint": SOL_MINT, "outputMint": mint, "amount": str(QUOTE_LAMPORTS), "taker": WALLET, "slippageBps": str(slip)}
    for _ in range(3):
        try:
            r = requests.get(f"{JUP}/order", params=p, headers=headers, timeout=60)
        except Exception as e:
            time.sleep(2); last = {"error": type(e).__name__}; continue
        if r.status_code == 429: time.sleep(2); continue
        if not r.ok: return {"error": f"HTTP {r.status_code}", "body": r.text[:200]}
        return r.json()
    return {"error": "429/err"}

def sol_usd():
    for _ in range(4):
        try:
            r = requests.get("https://api.jup.ag/price/v3", params={"ids": SOL_MINT}, headers=headers, timeout=30)
            if r.ok:
                return float(r.json()[SOL_MINT]["usdPrice"])
        except Exception:
            pass
        time.sleep(2)
    return None

def dex(mint):
    try:
        r = requests.get(f"https://api.dexscreener.com/latest/dex/tokens/{mint}", timeout=30)
        if not r.ok: return {"err": f"HTTP {r.status_code}"}
        pairs = [p for p in (r.json().get("pairs") or []) if p.get("chainId") == "solana"]
        if not pairs: return {"err": "no_solana_pairs"}
        p = max(pairs, key=lambda x: float((x.get("liquidity") or {}).get("usd") or 0))
        pca = p.get("pairCreatedAt")
        return {"dex": p.get("dexId"), "pair": p.get("pairAddress"), "liq_usd": (p.get("liquidity") or {}).get("usd"),
                "pc": p.get("priceChange"), "vol_h1": (p.get("volume") or {}).get("h1"),
                "txns_h1": (p.get("txns") or {}).get("h1"), "priceUsd": p.get("priceUsd"),
                "pair_age_h": (now.timestamp() - pca / 1000) / 3600 if pca else None}
    except Exception as e:
        return {"err": type(e).__name__}

SOLUSD = sol_usd()
to_quote = mkt_pass + one_fail[:15] + two_fail[:5]
for r in to_quote:
    o = jup_order(r["mint"]); time.sleep(0.3)
    dec = int(r["decimals"] or 6)
    imp = o.get("priceImpactPct")
    try: imp_abs = abs(float(imp)) if imp is not None else None
    except Exception: imp_abs = None
    out_raw = o.get("outAmount")
    q = {"router": o.get("router"), "priceImpactPct": imp, "priceImpact": o.get("priceImpact"),
         "has_tx": bool(o.get("transaction")), "err": o.get("error") or o.get("errorMessage"), "outAmount": out_raw}
    if out_raw:
        out_tok = Decimal(out_raw) / (Decimal(10) ** dec)
        in_sol = Decimal(o.get("inAmount") or QUOTE_LAMPORTS) / Decimal(10**9)
        q["out_tokens"] = float(out_tok)
        q["price_sol"] = float(in_sol / out_tok) if out_tok else None
        q["price_usd"] = q["price_sol"] * SOLUSD if (q["price_sol"] and SOLUSD) else None
    r["quote"] = q; r["impact_frac"] = imp_abs
    qf = []
    if not out_raw or not q["has_tx"]: qf.append(f"no_route/no_tx {q['err']}")
    if imp_abs is None or imp_abs >= 0.01: qf.append(f"Jupiter impact {imp} >= 1% (frac 0.01)")
    r["quote_fails"] = qf
    r["all_fails"] = r["market_fails"] + qf
    if not r["market_fails"]:
        r["dexscreener"] = dex(r["mint"]); time.sleep(0.3)
    print(f"Q {r['symbol']:12} imp={imp} out={q.get('out_tokens')} fails={r['all_fails']}")

clear = [r for r in to_quote if not r["all_fails"]]
def rank(r):
    s = min(r["pc1h"], 100) * 1.0 + min(r["pc6h"], 300) * 0.3 + min(r["v1h"] / 5000, 80) + min(r["liq"] / 5000, 80)
    s += (max(r["buy_share_tx_1h"] or 0, r["buy_share_vol_1h"] or 0) - 0.5) * 400
    s -= (r["impact_frac"] or 0) * 3000
    return s
for r in clear: r["rank_score"] = rank(r)
clear.sort(key=lambda r: -r["rank_score"])
near = sorted([r for r in to_quote if r.get("all_fails")], key=lambda r: (len(r["all_fails"]), -r["liq"]))

out = {"scan_utc": now.isoformat(), "scan_pt": now.astimezone(PT).isoformat(), "sol_usd": SOLUSD,
       "universe": len(seen), "eligible": len(elig), "market_pass": len(mkt_pass),
       "clear": clear, "near_misses": near[:12],
       "standing": [r for r in rows_all if r["standing_skip"]],
       "excluded_in_universe": [(r["symbol"], r["excluded"]) for r in rows_all if r["excluded"]]}
# hot_1h tag (GRASSHOPPER 2026-10-18, after repealing the +30% 1h cap): non-blocking. Every decision this scan logs
# (thesis_paused skips, edge2-6 paper logs, any future enter) carries meta.hot_1h (1h change > +30%) and meta.chg_1h
# (the Jupiter stats1h change at scan time, percent) so a later review can compare hot coins with the rest.
HOT_1H_PCT = 30
def _hot_meta(r):
    """{'hot_1h': bool, 'chg_1h': pct} from the scan row; {} when the 1h change is unknown (never guessed)."""
    pc = (r or {}).get("pc1h")
    if pc is None: return {}
    try: pc = float(pc)
    except Exception: return {}
    return {"hot_1h": pc > HOT_1H_PCT, "chg_1h": round(pc, 2)}
# thesis paused (desk 2026-10-09): paper-log every coin that clears all gates as a pass, scored at 4h.
# Set BANDIT_THESIS_PAUSED=0 to turn off once the thesis is live again.
PAUSE_TAG = "thesis_paused"
paper_logged = []
if os.environ.get("BANDIT_SCAN_NO_LOG") != "1" and os.environ.get("BANDIT_THESIS_PAUSED", "1") == "1":
    try:
        import steward_rpc
        for r in clear:
            px = (r.get("quote") or {}).get("price_sol")
            if not px:
                paper_logged.append((r["symbol"], None, "no_price")); continue
            try:
                res = steward_rpc.log_decision("bandit", decision="skip", instrument=r["mint"], side="long", price=px,
                    thesis_id="meme_4h_momentum_clip",
                    reason=f"{r['symbol']}: cleared every gate but thesis paused (paper forward log); 1h +{r['pc1h']:.1f}%, 6h {r['pc6h']:.1f}%, liq ${r['liq']:,.0f}, impact {r.get('impact_frac')}",
                    blocked_by=PAUSE_TAG, decided_at=now.astimezone(PT).isoformat(),
                    source_id=f"scan_https_{now.astimezone(PT).strftime('%Y%m%dT%H%M')}_{r['mint'][:8]}_paused",
                    meta=_hot_meta(r) or None)
                paper_logged.append((r["symbol"], (res or {}).get("id"), "ok" if (res or {}).get("ok") else res))
            except Exception as e:
                paper_logged.append((r["symbol"], None, f"err {type(e).__name__}: {str(e)[:120]}"))
    except Exception as e:
        paper_logged.append(("*", None, f"import err {type(e).__name__}"))
out["paper_logged"] = paper_logged
# edge2 meme_pullback_reclaim (GRASSHOPPER 2026-10-12, PAPER ONLY): check every eligible coin's last closed 5m bars
# against the pre-registered rule in /workspace/bandit/research/edge2_prereg.md and log triggers as skips (4h horizon,
# computed by the ledger). Never trades. Dedupe: a coin logs at most once per 4h (state file below).
E2_TAG = "paper_only"; E2_STATE = "/workspace/bandit/_edge2_dedupe.json"; GT = "https://api.geckoterminal.com/api/v2"
def gt_get(path, params=None):
    for i in range(4):
        try:
            r = requests.get(f"{GT}/{path}", params=params or {}, headers={"accept": "application/json"}, timeout=30)
        except Exception:
            time.sleep(2); continue
        if r.status_code == 429: time.sleep(6 * (i + 1)); continue
        return r.json() if r.ok else None
    return None
def edge2_check(mint):
    """Return (triggered, info). Rule exactly per edge2_prereg.md, on the top-reserve pool's closed 5m USD bars."""
    pools = gt_get(f"networks/solana/tokens/{mint}/pools", {"page": 1})
    pl = (pools or {}).get("data") or []
    GT_POOLS[mint] = pl if pools is not None else None  # None = call failed (edge4/edge5 then skip, never guess)
    if not pl: return False, "no_pool"
    pool = max(pl, key=lambda x: float((x.get("attributes") or {}).get("reserve_in_usd") or 0))["attributes"]["address"]
    time.sleep(2.1)
    d = gt_get(f"networks/solana/pools/{pool}/ohlcv/minute", {"aggregate": 5, "limit": 100, "currency": "usd", "token": mint})
    time.sleep(2.1)
    b = sorted(((d or {}).get("data") or {}).get("attributes", {}).get("ohlcv_list") or [], key=lambda r: r[0])
    b = [r for r in b if r[0] + 300 <= now.timestamp()]  # closed bars only
    GT_BARS[mint] = (pool, b)
    if len(b) < 73: return False, f"bars {len(b)} < 73"
    t = len(b) - 1; w = b[t - 71:t + 1]; cl = [r[4] for r in w]; P = max(cl); pi = cl.index(P)
    if pi == 0 or len(w) - 1 - pi < 6: return False, "peak too recent/at window start"
    L = min(cl[:pi]); c = b[t][4]; vol = sum(r[5] for r in w); run = P / L - 1; dd = 1 - c / P
    info = dict(pool=pool, bar_ts=b[t][0], run_pct=round(run * 100, 1), pullback_pct=round(dd * 100, 1),
                peak_age_bars=len(w) - 1 - pi, vol6h_usd=round(vol), reclaim=c > b[t - 1][2])
    ok = run >= 0.40 and 0.6 * P <= c <= 0.8 * P and c > b[t - 1][2] and vol >= 50000
    return ok, info
GT_POOLS = {}; GT_BARS = {}; E2_HITS = set()  # shared with edge3/4/5 below
E345_HITS = set()  # coins edge3/4/5 signalled this scan: precedence over edge6
edge2_logged = []; edge2_checked = 0
try: e2_state = json.load(open(E2_STATE))
except Exception: e2_state = {}
_no_log = os.environ.get("BANDIT_SCAN_NO_LOG") == "1"
for r in elig:
    if r["liq"] < MIN_LIQ or r["age_h"] is None or r["age_h"] >= MAX_AGE_H: continue  # live liquidity/age floors
    edge2_checked += 1
    try: ok, info = edge2_check(r["mint"])
    except Exception as e: ok, info = False, f"err {type(e).__name__}"
    if not ok: continue
    E2_HITS.add(r["mint"])  # edge2 precedence for edge3/4/5 (counts even if deduped/unlogged)
    last = e2_state.get(r["mint"])
    if last and now.timestamp() - last < 4 * 3600:
        edge2_logged.append((r["symbol"], None, "dedupe_4h")); continue
    q = r.get("quote")
    if not q:
        try:
            o = jup_order(r["mint"]); dec = int(r["decimals"] or 6); out_raw = o.get("outAmount")
            q = {"price_sol": float((Decimal(o.get("inAmount") or QUOTE_LAMPORTS) / Decimal(10**9)) / (Decimal(out_raw) / Decimal(10) ** dec)) if out_raw and Decimal(out_raw) > 0 else None,
                 "priceImpactPct": o.get("priceImpactPct")}
        except Exception as e:
            edge2_logged.append((r["symbol"], None, f"quote_err {type(e).__name__}")); continue
    px = q.get("price_sol")
    if not px:
        edge2_logged.append((r["symbol"], None, "no_price")); continue
    stamp = now.astimezone(PT).strftime('%Y%m%dT%H%M')
    if _no_log:
        edge2_logged.append((r["symbol"], None, f"dry_run would_log px={px} {info} {_hot_meta(r)}")); continue
    try:
        import steward_rpc
        res = steward_rpc.log_decision("bandit", decision="skip", instrument=r["mint"], side="long", price=px,
            thesis_id="meme_pullback_reclaim",
            reason=f"{r['symbol']}: edge2 pullback-reclaim trigger (paper only): run +{info['run_pct']}% in 6h, pullback {info['pullback_pct']}%, peak {info['peak_age_bars']} bars ago, reclaim bar, 6h vol ${info['vol6h_usd']:,}; impact {q.get('priceImpactPct')}",
            blocked_by=E2_TAG, decided_at=now.astimezone(PT).isoformat(),
            source_id=f"scan_https_{stamp}_{r['mint'][:8]}_edge2", meta={"edge2": info, "horizon": "4h", **_hot_meta(r)})
        okr = (res or {}).get("ok")
        if okr: e2_state[r["mint"]] = now.timestamp()
        edge2_logged.append((r["symbol"], (res or {}).get("id"), "ok" if okr else res))
    except Exception as e:
        edge2_logged.append((r["symbol"], None, f"err {type(e).__name__}: {str(e)[:120]}"))
if not _no_log:
    with open(E2_STATE, "w") as fh: json.dump(e2_state, fh)
out["edge2_checked"] = edge2_checked
out["edge2_logged"] = edge2_logged
# ---------------------------------------------------------------------------------------------------------------
# edge3 meme_range_breakout / edge4 meme_grad_pullback / edge5 meme_liq_accum: PAPER ONLY, never trade.
# Rules exactly per stewards/bandit/research/edge{3,4,5}_prereg.md (sha256 599acd6d.../f88d7e42.../71cfaa04...);
# edge3/edge4 on forward paper per research/edge3_edge4_amendment_20261016.md. Each logs a skip with
# blocked_by="paper_only" and its own 4h dedupe/state file. edge2 precedence: a coin edge2 triggered this scan is skipped.
# Hourly scan vs 5m rules: edge3/edge4 look at bars that closed since the previous scan (capped at 75 min); the log
# carries signal_bar_ts and prereg_entry_ts (open of the bar after the signal bar) in meta for the path scorer.
# Dry run (BANDIT_SCAN_NO_LOG=1): nothing logged, dedupe/pending state not written; edge5 snapshots still recorded.
PAPER_TAG = "paper_only"
E3_STATE = "/workspace/bandit/_edge3_dedupe.json"; E4_STATE = "/workspace/bandit/_edge4_state.json"
E5_STATE = os.environ.get("BANDIT_E5_STATE", "/workspace/bandit/_edge5_state.json"); LIQ_SNAP = os.environ.get("BANDIT_LIQ_SNAP", "/workspace/bandit/_liq_snapshots.json")
LAST_SCAN = "/workspace/bandit/_edge34_last_scan.json"
_now_ts = now.timestamp(); _stamp = now.astimezone(PT).strftime('%Y%m%dT%H%M'); _dec_pt = now.astimezone(PT).isoformat()
def _load(path, default):
    try: return json.load(open(path))
    except Exception: return default
def _save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh: json.dump(obj, fh)
    os.replace(tmp, path)
def _px_sol(r):
    """Jupiter /order quote price (SOL per token), same as edge2. Unsigned, never executed."""
    q = r.get("quote")
    if q and q.get("price_sol"): return q.get("price_sol"), q.get("priceImpactPct"), None
    try:
        o = jup_order(r["mint"]); dec = int(r["decimals"] or 6); out_raw = o.get("outAmount")
        px = float((Decimal(o.get("inAmount") or QUOTE_LAMPORTS) / Decimal(10**9)) / (Decimal(out_raw) / Decimal(10) ** dec)) if out_raw and Decimal(out_raw) > 0 else None
        return px, o.get("priceImpactPct"), None if px else "no_price"
    except Exception as e:
        return None, None, f"quote_err {type(e).__name__}"
def _paper_log(r, thesis, suffix, reason, meta, blocked_by=PAPER_TAG, px_fallback=None, allow_priceless=False):
    """Log one paper-only skip. allow_priceless (edge5 voids only): with no live quote and no stored signal price,
    log it with NO price (never an invented one) plus no_price_reason; the ledger stores it unscoreable."""
    meta = dict(meta or {}, **_hot_meta(r))                 # hot_1h tag on every paper log (edge3-6, edge5 voids)
    px, imp, err = _px_sol(r)
    if (err or not px) and px_fallback: px, err, imp = px_fallback, None, "n/a (signal-time quote)"
    no_px = None
    if err or not px:
        if not allow_priceless: return None, err or "no_price"
        px, imp, no_px = None, "n/a (no price)", f"void, no live quote ({err or 'no_price'}) and no stored signal price"
        reason, meta = f"[no_price] {reason}", dict(meta, no_price=no_px)   # prefix: the ledger keeps 280 chars
    if _no_log: return None, f"dry_run would_log blocked_by={blocked_by} px={px} {meta}"
    import steward_rpc
    res = steward_rpc.log_decision("bandit", decision="skip", instrument=r["mint"], side="long", price=px,
        thesis_id=thesis, reason=f"{reason}; impact {imp}", blocked_by=blocked_by, decided_at=_dec_pt,
        source_id=f"scan_https_{_stamp}_{r['mint'][:8]}_{suffix}", meta=meta, no_price_reason=no_px)
    return (res or {}).get("id"), "ok" if (res or {}).get("ok") else res
def _iso_ts(x):
    try: return datetime.fromisoformat(str(x).replace("Z", "+00:00")).timestamp()
    except Exception: return None
def _dex_id(p): return (((p.get("relationships") or {}).get("dex") or {}).get("data") or {}).get("id")
def _e2_bar(b, t):
    """edge2 meme_pullback_reclaim on bar t of a bar list (same test as edge2_check)."""
    if t < 71: return False
    w = b[t-71:t+1]; cl = [x[4] for x in w]; P = max(cl); pi = cl.index(P)
    if not (pi > 0 and len(w) - 1 - pi >= 6): return False
    L = min(cl[:pi]); c = b[t][4]
    return P / L - 1 >= 0.40 and 0.6 * P <= c <= 0.8 * P and c > b[t-1][2] and sum(x[5] for x in w) >= 50000
_prev_scan = (_load(LAST_SCAN, {}) or {}).get("ts")
_since = max(_prev_scan or 0, _now_ts - 75 * 60) if _prev_scan else _now_ts - 65 * 60   # bars that closed after this
universe345 = [r for r in elig if r["liq"] >= MIN_LIQ and r["age_h"] is not None and r["age_h"] < MAX_AGE_H]

# ---- edge3 meme_range_breakout (top-reserve pool bars reused from the edge2 fetch) ----
def edge3_signal(b, t):
    if t < 72: return None
    w = b[t-72:t]; H = max(x[2] for x in w); L = min(x[3] for x in w)
    if not L > 0 or H / L - 1 > 0.25: return None
    o, h, lo, c, v = b[t][1:6]; M = statistics.median(x[5] for x in w); vol = sum(x[5] for x in w)
    if not (c > H and c > o and M > 0 and v >= 3.0 * M and vol >= 50000): return None
    return dict(range_pct=round((H / L - 1) * 100, 2), vol_mult=round(v / M, 2), vol6h_usd=round(vol))
edge3_logged = []; edge3_checked = 0; e3_state = _load(E3_STATE, {})
for r in universe345:
    pb = GT_BARS.get(r["mint"])
    if not pb or len(pb[1]) < 73: continue
    pool, b = pb; edge3_checked += 1
    cand = [t for t in range(72, len(b)) if b[t][0] + 300 > _since]        # bars closed since the previous scan
    hit = next(((t, i) for t in cand for i in [edge3_signal(b, t)] if i), None)   # first qualifying bar
    if not hit: continue
    t, info = hit
    E345_HITS.add(r["mint"])
    if _e2_bar(b, t): edge3_logged.append((r["symbol"], None, "edge2_precedence")); continue  # impossible by construction; kept as a guard
    last = e3_state.get(r["mint"])
    if last and b[t][0] - last < 4 * 3600: edge3_logged.append((r["symbol"], None, "dedupe_4h")); continue
    meta = {"edge3": dict(info, pool=pool, signal_bar_ts=b[t][0], prereg_entry_ts=b[t][0] + 300,
                          lag_min=round((_now_ts - (b[t][0] + 300)) / 60, 1)), "horizon": "4h"}
    try:
        lid, st_ = _paper_log(r, "meme_range_breakout", "edge3",
            f"{r['symbol']}: edge3 range-breakout trigger (paper only): 6h range {info['range_pct']}%, close > 6h high, green, vol {info['vol_mult']}x median, 6h vol ${info['vol6h_usd']:,}", meta)
        if st_ == "ok": e3_state[r["mint"]] = b[t][0]
        edge3_logged.append((r["symbol"], lid, st_))
    except Exception as e:
        edge3_logged.append((r["symbol"], None, f"err {type(e).__name__}: {str(e)[:120]}"))

# ---- edge4 meme_grad_pullback (pumpswap migration pool; one signal per graduation, ever) ----
def edge4_eval(b, G):
    """First post-G bar satisfying prereg conditions 2-5 within 24h of G, or None."""
    for t in range(len(b)):
        if b[t][0] - G >= 86400: return None
        if t < 3: continue
        cl = [x[4] for x in b[:t]]; P = max(cl); p = cl.index(P)
        if p > t - 3: continue
        o, h, lo, c = b[t][1:5]
        if not (0.65 * P <= c <= 0.80 * P and c > b[t-1][2] and c > o): continue
        vol = sum(x[5] for x in b[:t])
        if vol < 50000: continue
        return t, dict(post_grad_high=P, pullback_pct=round((1 - c / P) * 100, 2), vol_since_G_usd=round(vol))
    return None
edge4_logged = []; edge4_checked = 0; e4_state = _load(E4_STATE, {})
for r in universe345:
    pl = GT_POOLS.get(r["mint"])
    if pl is None: continue                                              # pools call failed / not fetched
    sw = sorted([(_iso_ts((p.get("attributes") or {}).get("pool_created_at")), (p.get("attributes") or {}).get("address"))
                 for p in pl if _dex_id(p) == "pumpswap"], key=lambda x: x[0] or 9e18)
    sw = [x for x in sw if x[0]]
    if not sw: continue
    G, mig = sw[0]
    if _now_ts - G >= 86400 + 300: continue                              # past the 24h window
    if (r.get("launchpad") or "").lower() != "pump.fun" or r.get("graduated") is False:
        edge4_logged.append((r["symbol"], None, "grad_mismatch")); continue
    if e4_state.get(r["mint"], {}).get("G") == G and e4_state[r["mint"]].get("consumed"):
        continue                                                         # first pullback already used
    edge4_checked += 1
    time.sleep(2.1)
    d = gt_get(f"networks/solana/pools/{mig}/ohlcv/minute", {"aggregate": 5, "limit": 300, "currency": "usd", "token": r["mint"]})
    b = sorted(((d or {}).get("data") or {}).get("attributes", {}).get("ohlcv_list") or [], key=lambda x: x[0])
    b = [x for x in b if x[0] >= G and x[0] + 300 <= _now_ts]
    if d is None: edge4_logged.append((r["symbol"], None, "bars_err")); continue
    ev = edge4_eval(b, G)
    if not ev: continue
    t, info = ev
    state = {"G": G, "mig_pool": mig, "consumed": True, "signal_bar_ts": b[t][0]}
    if b[t][0] + 300 <= _since: outcome = "first_pullback_before_this_scan_window"
    elif t < 12: outcome = "first_pullback_before_12_bars"
    elif _e2_bar(b, t): outcome = "edge2_precedence"                     # prereg rule 7: same bar, same pool
    else: outcome = None
    if not outcome: E345_HITS.add(r["mint"])
    if outcome:
        edge4_logged.append((r["symbol"], None, f"consumed: {outcome}"))
        if not _no_log: e4_state[r["mint"]] = dict(state, outcome=outcome)
        continue
    meta = {"edge4": dict(info, mig_pool=mig, G_ts=G, hours_since_G=round((b[t][0] - G) / 3600, 2), signal_bar_ts=b[t][0],
                          prereg_entry_ts=b[t][0] + 300, lag_min=round((_now_ts - (b[t][0] + 300)) / 60, 1)), "horizon": "4h"}
    try:
        lid, st_ = _paper_log(r, "meme_grad_pullback", "edge4",
            f"{r['symbol']}: edge4 grad-pullback trigger (paper only): {meta['edge4']['hours_since_G']}h after pumpswap graduation, pullback {info['pullback_pct']}% from post-grad high, green reclaim bar, vol since grad ${info['vol_since_G_usd']:,}", meta)
        if st_ == "ok": e4_state[r["mint"]] = dict(state, outcome="logged", id=lid)
        edge4_logged.append((r["symbol"], lid, st_))
    except Exception as e:
        edge4_logged.append((r["symbol"], None, f"err {type(e).__name__}: {str(e)[:120]}"))

# ---- edge5 meme_liq_accum (forward-paper-only; Jupiter liquidity/price snapshots; entry on the NEXT scan) ----
E5_VOID_TAG = "paper_void_stale"; E5_STALE_S = 2 * 3600; E5_HISTORY_MAX = 500
def edge5_process_pending(state, now_ts, entry_fn, void_fn, no_log=False):
    """Pure (no I/O of its own): enter or void each pending edge5 signal; mutates `state` unless no_log.
    entry_fn / void_fn(mint, pend) -> (ledger id, status); status == "ok" means logged.
    - fresh + entry ok      -> removed from pending, dedupe[mint] = signal_ts, history 'entered'
    - fresh + entry failed  -> stays pending; retries += 1, last_error / last_try_ts recorded (retried next scan)
    - stale (> 2h)          -> void logged; ok -> removed, history 'void_stale'; failed -> stays, void_retries += 1
    Returns [(mint, id, status)]."""
    res = []
    hist = state.setdefault("history", [])
    for mint, pend in list(state.get("pending", {}).items()):
        stale = now_ts - pend["signal_ts"] > E5_STALE_S
        fn = void_fn if stale else entry_fn
        try: lid, st_ = fn(mint, pend)
        except Exception as e: lid, st_ = None, f"err {type(e).__name__}: {str(e)[:120]}"
        tag = "void_stale" if stale else "entry"
        res.append((mint, lid, f"{tag}: {st_}" if st_ != "ok" else f"{tag}: ok"))
        if no_log: continue
        if st_ == "ok":
            state["pending"].pop(mint)
            if not stale: state.setdefault("dedupe", {})[mint] = pend["signal_ts"]
            hist.append(dict(mint=mint, symbol=pend.get("symbol"), signal_ts=pend["signal_ts"], outcome="void_stale" if stale else "entered",
                             ledger_id=lid, at_ts=now_ts, retries=pend.get("retries", 0), void_retries=pend.get("void_retries", 0),
                             last_error=pend.get("last_error")))
        else:
            k = "void_retries" if stale else "retries"
            pend[k] = pend.get(k, 0) + 1; pend["last_error"] = str(st_)[:200]; pend["last_try_ts"] = now_ts
    del hist[:-E5_HISTORY_MAX]
    return res
snaps = _load(LIQ_SNAP, {})
e5_state = _load(E5_STATE, {"pending": {}, "dedupe": {}, "history": []})
edge5_logged = []; edge5_checked = 0
_rows_by_mint = {r["mint"]: r for r in elig}
# 1) signals from earlier scans enter now (next scan). A failed entry log stays pending and is retried next scan
#    (retries counted). Only staleness (> 2h since the signal scan) voids a pending entry; the void is itself logged
#    to the ledger (blocked_by=paper_void_stale, source_id ..._edge5void) and kept in state history. A failed void
#    log is retried too. See edge5_process_pending (pure; tested in stewards/test_bandit_edge5_pending.py).
def _e5_row(mint, pend): return _rows_by_mint.get(mint) or {"mint": mint, "symbol": pend.get("symbol"), "decimals": pend.get("decimals")}
def _e5_entry(mint, pend):
    r = _e5_row(mint, pend); i = pend["info"]
    meta = {"edge5": dict(i, signal_scan_ts=pend["signal_ts"], entry_scan_ts=_now_ts, entry_retries=pend.get("retries", 0)), "horizon": "4h"}
    return _paper_log(r, "meme_liq_accum", "edge5",
        f"{r['symbol']}: edge5 liq-accum entry on next scan (paper only): liq +{i['liq_chg_pct']}% / price {i['px_chg_pct']}% over {i['ref_age_h']}h, buy share {i['buy_share']}", meta)
def _e5_void(mint, pend):
    r = _e5_row(mint, pend); sig_pt = datetime.fromtimestamp(pend["signal_ts"], timezone.utc).astimezone(PT).strftime('%Y-%m-%d %H:%M PT')
    why = f"no successful entry log within 2h of the signal ({pend.get('retries', 0)} failed entry attempts; last error: {pend.get('last_error') or 'none (no scan ran)'})"
    meta = {"edge5": dict(pend["info"], signal_scan_ts=pend["signal_ts"]), "void": {"reason": "stale_2h", "signal_ts": pend["signal_ts"],
            "retries": pend.get("retries", 0), "last_error": pend.get("last_error")}}
    return _paper_log(r, "meme_liq_accum", "edge5void", f"{r['symbol']}: edge5 pending entry VOID (paper only, not a pass): signal {sig_pt}; {why}",
                      meta, blocked_by=E5_VOID_TAG, px_fallback=pend.get("signal_px_sol"), allow_priceless=True)
_e5_syms = {m: p_.get("symbol") for m, p_ in e5_state.get("pending", {}).items()}
E345_HITS.update(_e5_syms)   # pending edge5 entries/voids handled this scan keep precedence over edge6
for _m, _lid, _st in edge5_process_pending(e5_state, _now_ts, _e5_entry, _e5_void, _no_log):
    edge5_logged.append((_e5_syms.get(_m) or _m, _lid, _st))
# 2) record this scan's snapshot for every eligible coin (always, even with no signal), prune > 9h
for r in elig:
    try: px = float(r.get("usdPrice")) if r.get("usdPrice") is not None else None
    except Exception: px = None
    snaps.setdefault(r["mint"], []).append([_now_ts, r["liq"], px])
for mint in list(snaps):
    snaps[mint] = [s_ for s_ in snaps[mint] if _now_ts - s_[0] <= 9 * 3600]
    if not snaps[mint]: snaps.pop(mint)
_save(LIQ_SNAP, snaps)
# 3) new signals at this scan (they enter at the next scan)
for r in universe345:
    refs = [s_ for s_ in snaps.get(r["mint"], []) if 5 * 3600 <= _now_ts - s_[0] <= 7 * 3600]
    if not refs: continue
    edge5_checked += 1
    ref = min(refs, key=lambda s_: (abs(_now_ts - s_[0] - 6 * 3600), s_[0]))   # closest to 6h; ties -> older
    liq_ref, px_ref = ref[1], ref[2]
    try: px_now = float(r.get("usdPrice"))
    except Exception: continue
    if not liq_ref or liq_ref < 50000 or not px_ref: continue
    liq_chg = r["liq"] / liq_ref - 1; px_chg = px_now / px_ref - 1
    bs = max(r["buy_share_vol_1h"] or 0, r["buy_share_tx_1h"] or 0)
    if not (liq_chg >= 0.50 and abs(px_chg) <= 0.10 and bs >= 0.52 and r["age_h"] >= 12): continue
    pl = GT_POOLS.get(r["mint"])
    if pl is None:
        time.sleep(2.1); pr = gt_get(f"networks/solana/tokens/{r['mint']}/pools", {"page": 1})
        pl = (pr or {}).get("data") if pr is not None else None
    if pl is None: edge5_logged.append((r["symbol"], None, "pools_err")); continue
    if any((ct := _iso_ts((p.get("attributes") or {}).get("pool_created_at"))) and ct >= ref[0] for p in pl):
        edge5_logged.append((r["symbol"], None, "new_pool_in_window")); continue
    if r["mint"] in E2_HITS: edge5_logged.append((r["symbol"], None, "edge2_precedence")); continue
    last = e5_state["dedupe"].get(r["mint"])
    if r["mint"] in e5_state["pending"] or (last and _now_ts - last < 4 * 3600):
        edge5_logged.append((r["symbol"], None, "dedupe_4h")); continue
    info = dict(liq_now=round(r["liq"]), liq_ref=round(liq_ref), liq_chg_pct=round(liq_chg * 100, 1), px_chg_pct=round(px_chg * 100, 2),
                ref_age_h=round((_now_ts - ref[0]) / 3600, 2), buy_share=round(bs, 4), age_h=round(r["age_h"], 1))
    edge5_logged.append((r["symbol"], None, f"signal: pending entry at next scan {info}"))
    E345_HITS.add(r["mint"])
    if not _no_log:
        e5_state["pending"][r["mint"]] = {"signal_ts": _now_ts, "symbol": r["symbol"], "decimals": r["decimals"], "info": info,
                                          "retries": 0, "signal_px_sol": _px_sol(r)[0]}   # signal-time price: void-log fallback
# ---- edge6 meme_flush_rebound (paper only; research/edge6_prereg.md, sha256 d4770a56...) ----
# Buy the 30-50% flush: close of a closed 5m bar between 50% and 70% of the 6h high (72 bars incl. that bar), 6h USD
# volume >= $50k, not an edge2 bar. Bars closed since the previous scan, first qualifying bar. Precedence: edge2 >
# edge3 > edge4 > edge5 > edge6 (E2_HITS / E345_HITS). 4h dedupe per coin. Never trades.
E6_STATE = os.environ.get("BANDIT_E6_STATE", "/workspace/bandit/_edge6_dedupe.json")
def edge6_signal(b, t):
    """Same test as research/edge6_rule.py signal()."""
    if t < 72: return None
    w = b[t-71:t+1]; H = max(x[2] for x in w); c = b[t][4]; vol = sum(x[5] for x in w)
    if not (H > 0 and c > 0): return None
    d = c / H
    if not (0.50 <= d <= 0.70 and vol >= 50000): return None
    if _e2_bar(b, t): return None
    return dict(flush_pct=round((1 - d) * 100, 2), h6_high=H, vol6h_usd=round(vol))
edge6_logged = []; edge6_checked = 0; e6_state = _load(E6_STATE, {})
for r in universe345:
    pb = GT_BARS.get(r["mint"])
    if not pb or len(pb[1]) < 73: continue
    pool, b = pb; edge6_checked += 1
    cand = [t for t in range(72, len(b)) if b[t][0] + 300 > _since]        # bars closed since the previous scan
    hit = next(((t, i) for t in cand for i in [edge6_signal(b, t)] if i), None)
    if not hit: continue
    t, info = hit
    if r["mint"] in E2_HITS: edge6_logged.append((r["symbol"], None, "edge2_precedence")); continue
    if r["mint"] in E345_HITS: edge6_logged.append((r["symbol"], None, "edge345_precedence")); continue
    last = e6_state.get(r["mint"])
    if last and b[t][0] - last < 4 * 3600: edge6_logged.append((r["symbol"], None, "dedupe_4h")); continue
    meta = {"edge6": dict(info, pool=pool, signal_bar_ts=b[t][0], prereg_entry_ts=b[t][0] + 300,
                          lag_min=round((_now_ts - (b[t][0] + 300)) / 60, 1)), "horizon": "4h"}
    try:
        lid, st_ = _paper_log(r, "meme_flush_rebound", "edge6",
            f"{r['symbol']}: edge6 flush-rebound trigger (paper only): close {info['flush_pct']}% below 6h high, 6h vol ${info['vol6h_usd']:,}", meta)
        if st_ == "ok": e6_state[r["mint"]] = b[t][0]
        edge6_logged.append((r["symbol"], lid, st_))
    except Exception as e:
        edge6_logged.append((r["symbol"], None, f"err {type(e).__name__}: {str(e)[:120]}"))
if not _no_log:
    _save(E3_STATE, e3_state); _save(E4_STATE, e4_state); _save(E5_STATE, e5_state); _save(E6_STATE, e6_state); _save(LAST_SCAN, {"ts": _now_ts})
out["edge3_checked"] = edge3_checked; out["edge3_logged"] = edge3_logged
out["edge4_checked"] = edge4_checked; out["edge4_logged"] = edge4_logged
out["edge5_checked"] = edge5_checked; out["edge5_logged"] = edge5_logged
out["edge6_checked"] = edge6_checked; out["edge6_logged"] = edge6_logged
out["liq_snapshots"] = {"coins": len(snaps), "path": LIQ_SNAP}
with open(os.environ.get("BANDIT_SCAN_OUT", "/workspace/bandit/_scan_https_out.json"), "w") as fh:
    json.dump(out, fh, indent=2, default=str)
print("SCAN_PT", out["scan_pt"], "SOLUSD", SOLUSD)
print("CLEAR", len(clear), [r["symbol"] for r in clear])
print("NEAR", [(r["symbol"], r["all_fails"]) for r in near[:8]])
print("STANDING", [(r["symbol"], r["market_fails"], r.get("quote_fails")) for r in out["standing"]])
print("PAPER_LOGGED", paper_logged)
print("EDGE2_CHECKED", edge2_checked, "EDGE2_LOGGED", edge2_logged)
print("EDGE3_CHECKED", edge3_checked, "EDGE3_LOGGED", edge3_logged)
print("EDGE4_CHECKED", edge4_checked, "EDGE4_LOGGED", edge4_logged)
print("EDGE5_CHECKED", edge5_checked, "EDGE5_LOGGED", edge5_logged)
print("EDGE6_CHECKED", edge6_checked, "EDGE6_LOGGED", edge6_logged)
