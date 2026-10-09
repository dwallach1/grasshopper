"""READ-ONLY meme gate scan over HTTPS only (no db_connect, no DB writes, no orders signed/sent).
Universe + stats: Jupiter tokens v2 (same as _scan_live_once.py). Quote: Jupiter swap v2 /order at 0.12 SOL
(unsigned; never signed or executed). DexScreener cross-check on names that clear.
Ledger mints come from the Supabase connector (meme_positions JOIN meme_tokens), pasted in LEDGER below.
Output: /workspace/bandit/_scan_https_out.json (local file only).
"""
from __future__ import annotations
import json, os, time
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
    if pc1 is not None and pc1 > 30: f.append(f"1h +{pc1:.0f}% > +30% (1h_cap_30 trial, desk 2026-10-07)")
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
# desk rule #127 bandit-1h-entry-cap: always quote coins blocked ONLY by the 1h cap so they can be logged as passes
CAP_TAG = "1h_cap_30"
_q_ids = {r["mint"] for r in to_quote}
for r in elig:
    if r["market_fails"] and all(CAP_TAG in x for x in r["market_fails"]) and r["mint"] not in _q_ids:
        to_quote.append(r); _q_ids.add(r["mint"])
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
# auto-log every coin blocked only by the 1h cap (rule #127) as a pass, scored at the 4h horizon
cap_blocked = [r for r in to_quote if r.get("all_fails") and all(CAP_TAG in x for x in r["all_fails"])]
cap_logged = []
if os.environ.get("BANDIT_SCAN_NO_LOG") != "1":
    try:
        import steward_rpc
        for r in cap_blocked:
            px = (r.get("quote") or {}).get("price_sol")
            if not px:
                cap_logged.append((r["symbol"], None, "no_price")); continue
            try:
                res = steward_rpc.log_decision("bandit", decision="skip", instrument=r["mint"], side="long", price=px,
                    thesis_id="meme_4h_momentum_clip",
                    reason=f"{r['symbol']}: blocked only by 1h cap (1h +{r['pc1h']:.1f}% > +30%); 6h {r['pc6h']}%, liq ${r['liq']:,.0f}, impact {r.get('impact_frac')}",
                    blocked_by=CAP_TAG, decided_at=now.astimezone(PT).isoformat(),
                    source_id=f"scan_https_{now.astimezone(PT).strftime('%Y%m%dT%H%M')}_{r['mint'][:8]}_1hcap")
                cap_logged.append((r["symbol"], (res or {}).get("id"), "ok" if (res or {}).get("ok") else res))
            except Exception as e:
                cap_logged.append((r["symbol"], None, f"err {type(e).__name__}: {str(e)[:120]}"))
    except Exception as e:
        cap_logged.append(("*", None, f"import err {type(e).__name__}"))
out["cap_blocked"] = [{"symbol": r["symbol"], "mint": r["mint"], "pc1h": r["pc1h"], "price_sol": (r.get("quote") or {}).get("price_sol")} for r in cap_blocked]
out["cap_logged"] = cap_logged
with open("/workspace/bandit/_scan_https_out.json", "w") as fh:
    json.dump(out, fh, indent=2, default=str)
print("SCAN_PT", out["scan_pt"], "SOLUSD", SOLUSD)
print("CLEAR", len(clear), [r["symbol"] for r in clear])
print("NEAR", [(r["symbol"], r["all_fails"]) for r in near[:8]])
print("STANDING", [(r["symbol"], r["market_fails"], r.get("quote_fails")) for r in out["standing"]])
print("CAP_BLOCKED_LOGGED", cap_logged)
