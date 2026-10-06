"""Shared pieces of the BANDIT position scripts (mark_clip.py, exit_clip.py, pnl_snapshot.py).

Ported from the per-token clones (_<sym>_mark_once.py, _<sym>_kill_exit.py / _deadline_exit.py /
_tp50_full_exit.py): the same Helius / Jupiter Swap V2 calls, parametrized by the lot instead of
hardcoded constants. Ledger I/O goes over HTTPS (steward_rpc -> edge function steward-rpc -> the SQL
functions in supabase/schemas/51_steward_exit_rpc.sql, run as bandit_worker). Never prints secrets.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN, getcontext
from zoneinfo import ZoneInfo

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

getcontext().prec = 50

STEWARD = "bandit"
WALLET = "3AKSqcwDwuH1CPC9ZBN6S8ajGjjeFUyqmaUiyxPFKRFG"
ACCOUNT_KEY = "solana-bandit-primary"
SOL_MINT = "So11111111111111111111111111111111111111112"
JUP_BASE = "https://api.jup.ag/swap/v2"
SLIPPAGE_TRIES = [300, 500]  # 3%, then 5% — do not crank higher (same as every exit clone)
MARK_SLIPPAGE_BPS = 300
DEADLINE_HOURS = 4  # meme_4h_momentum_clip time stop: opened_at + 4h
DUST_MAX_SOL = Decimal("0.0002")
KILL = (
    "exit if -40% from entry OR thesis invalid OR 4h time stop; "
    "FULL EXIT / bank ALL at +50% — no half-scale to +100%"
)
ET = ZoneInfo("America/New_York")
PT = ZoneInfo("America/Los_Angeles")

# exit triggers (meta.deadline_exit.trigger / meme_orders.gate_results.trigger), as the clones wrote them
TRIGGERS = {
    "kill_-40pct": "kill -40% from entry",
    "invalidation": "mark at or below the lot's invalidation_price",
    "deadline_4h_stop": "4h time stop",
    "tp50_full_bank": "FULL bank at +50%",
    "thesis_invalid": "thesis invalid",
    "manual": "manual exit",
}
# mark_clip action -> exit_clip --trigger
ACTION_TRIGGER = {"deadline_exit": "deadline_4h_stop", "kill_exit": "kill_-40pct", "tp50_full_exit": "tp50_full_bank"}

FEE_TIP_ACCOUNTS = frozenset({
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
})


def require_runtime(modules: tuple[str, ...]) -> None:
    """Fail fast, before any venue or DB call, when the steward venv is missing or broken."""
    broken = []
    for module in modules:
        try:
            __import__(module)
        except Exception as exc:  # ImportError, or a broken binary wheel
            broken.append(f"{module} ({type(exc).__name__})")
    if broken:
        repo = os.environ.get("GRASSHOPPER_REPO") or os.path.join(os.sep, "workspace", "grasshopper")
        sys.stderr.write(
            f"{STEWARD}: Python env not ready: {', '.join(broken)} (interpreter {sys.executable}).\n"
            f"Nothing was sent. Run:  bash {os.path.join(repo, 'stewards', 'sync_box.sh')}\n"
            f"then retry with {os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), '.venv', 'bin', 'python')}.\n"
        )
        raise SystemExit(3)


def jdump(o) -> str:
    return json.dumps(o, default=lambda x: str(x) if isinstance(x, (Decimal, datetime)) else repr(x))


def D(v) -> Decimal | None:
    return None if v is None or v == "" else Decimal(str(v))


def parse_ts(v) -> datetime | None:
    if v is None or isinstance(v, datetime):
        return v
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


# ----------------------------------------------------------------- ledger (HTTPS)
def ledger(fn: str, args: dict, idempotent: bool = False):
    """Ledger call as bandit_worker over HTTPS (public.<fn>(args::jsonb), one transaction)."""
    from steward_rpc import call
    return call(STEWARD, fn, args, idempotent=idempotent)


# ----------------------------------------------------------------- Helius / Jupiter
def helius(helius_key: str, method: str, params):
    import requests
    r = requests.post(f"https://mainnet.helius-rpc.com/?api-key={helius_key}",
                      json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=60)
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"RPC {method} error: {body['error']}")
    return body["result"]


def get_balance_lamports(helius_key: str) -> tuple[int, int | None]:
    body = helius(helius_key, "getBalance", [WALLET])
    return int(body["value"]), (body.get("context") or {}).get("slot")


def get_decimals(helius_key: str, mint: str) -> int:
    return int(helius(helius_key, "getTokenSupply", [mint])["value"]["decimals"])


def get_token_atoms(helius_key: str, mint: str) -> int:
    """Sum of the wallet's token-account amounts for the mint."""
    res = helius(helius_key, "getTokenAccountsByOwner", [WALLET, {"mint": mint}, {"encoding": "jsonParsed"}])
    total = 0
    for acct in res.get("value") or []:
        try:
            total += int(acct["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"])
        except Exception:
            continue
    return total


def jup_sell_order(api_key: str, mint: str, amount_atoms: int, slippage_bps: int) -> dict:
    """Jupiter Swap V2 /order: mint -> SOL for amount_atoms (also the mark quote)."""
    import requests
    r = requests.get(f"{JUP_BASE}/order",
                     params={"inputMint": mint, "outputMint": SOL_MINT, "amount": str(amount_atoms),
                             "taker": WALLET, "slippageBps": str(slippage_bps)},
                     headers={"x-api-key": api_key}, timeout=60)
    if not r.ok:
        raise RuntimeError(f"/order HTTP {r.status_code}: {r.text[:800]}")
    return r.json()


def jup_execute(api_key: str, signed_b64: str, request_id: str) -> dict:
    import requests
    r = requests.post(f"{JUP_BASE}/execute", headers={"Content-Type": "application/json", "x-api-key": api_key},
                      json={"signedTransaction": signed_b64, "requestId": request_id}, timeout=120)
    if not r.ok:
        raise RuntimeError(f"/execute HTTP {r.status_code}: {r.text[:800]}")
    return r.json()


def sign_order_tx(kp, tx_b64: str) -> str:
    from solders.transaction import VersionedTransaction
    tx = VersionedTransaction.from_bytes(base64.b64decode(tx_b64))
    return base64.b64encode(bytes(VersionedTransaction(tx.message, [kp]))).decode("ascii")


def helius_send_fallback(helius_key: str, signed_b64: str) -> str:
    sig = helius(helius_key, "sendTransaction",
                 [signed_b64, {"encoding": "base64", "skipPreflight": False, "preflightCommitment": "confirmed",
                               "maxRetries": 3}])
    for _ in range(40):
        st = helius(helius_key, "getSignatureStatuses", [[sig], {"searchTransactionHistory": True}])
        val = (st.get("value") or [None])[0]
        if val and val.get("confirmationStatus") in ("confirmed", "finalized"):
            if val.get("err"):
                raise RuntimeError(f"tx landed with err: {val['err']} sig={sig}")
            return sig
        time.sleep(1.5)
    raise RuntimeError(f"tx not confirmed in time: {sig}")


def fetch_fee_breakdown(helius_key: str, sig, timeout_s: float = 45.0):
    """Poll getTransaction; return (fee_sol, breakdown). fee = network fee (wallet payer) + Jito/MEV tips. Never raises."""
    bd = {"network_lamports": None, "tip_lamports": None, "source": "getTransaction"}
    if not sig:
        bd["unresolved"] = "no_signature"
        return Decimal(0), bd
    t_end = time.time() + timeout_s
    last_err = None
    while True:
        try:
            tx = helius(helius_key, "getTransaction",
                        [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0, "commitment": "confirmed"}])
            if tx and tx.get("meta") is not None:
                meta_tx = tx["meta"]
                msg = (tx.get("transaction") or {}).get("message") or {}
                keys = [k.get("pubkey") if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]
                payer_is_wallet = bool(keys) and keys[0] == WALLET
                network = int(meta_tx.get("fee") or 0) if payer_is_wallet else 0
                ixs = list(msg.get("instructions") or [])
                for inner in meta_tx.get("innerInstructions") or []:
                    ixs.extend(inner.get("instructions") or [])
                tip = 0
                for ix in ixs:
                    p = ix.get("parsed")
                    if ix.get("program") == "system" and isinstance(p, dict) and p.get("type") == "transfer":
                        info = p.get("info") or {}
                        if info.get("source") == WALLET and info.get("destination") in FEE_TIP_ACCOUNTS:
                            tip += int(info.get("lamports") or 0)
                bd.update(network_lamports=network, tip_lamports=tip, slot=tx.get("slot"),
                          fee_payer_is_wallet=payer_is_wallet)
                return Decimal(network + tip) / Decimal(10**9), bd
            last_err = "tx_not_available"
        except Exception as e:  # never let fee capture break fill recording; no URL/key in message
            last_err = type(e).__name__
        if time.time() >= t_end:
            bd["unresolved"] = last_err or "timeout"
            return Decimal(0), bd
        time.sleep(1.5)


def close_token_accounts_safe(helius_key: str, kp, mint: str, position_closed: bool, exit_price) -> dict:
    """After a full exit: close the mint's token account(s) (burn + close if dust). Never raises."""
    info = {"attempted": False, "accounts": [], "close_sig": None, "rent_reclaimed_lamports": 0}
    try:
        from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
        from solders.hash import Hash
        from solders.instruction import AccountMeta, Instruction
        from solders.message import Message
        from solders.pubkey import Pubkey
        from solders.transaction import Transaction

        if not position_closed:
            info["skipped"] = "position_not_closed"
            return info
        res = helius(helius_key, "getTokenAccountsByOwner",
                     [WALLET, {"mint": mint}, {"encoding": "jsonParsed", "commitment": "confirmed"}])
        accts = res.get("value") or []
        if not accts:
            info["skipped"] = "no_token_account"
            return info
        owner = kp.pubkey()
        if str(owner) != WALLET:
            info["skipped"] = "keypair_mismatch"
            return info
        ixs = [set_compute_unit_limit(40000), set_compute_unit_price(1000)]
        planned = []
        for a in accts:
            ai = a["account"]["data"]["parsed"]["info"]
            amt = int(ai["tokenAmount"]["amount"])
            dec = int(ai["tokenAmount"]["decimals"])
            prog = a["account"]["owner"]
            rec = {"token_account": a["pubkey"], "program": prog, "amount_atoms": amt,
                   "lamports": int(a["account"]["lamports"])}
            if ai.get("mint") != mint or ai.get("isNative"):
                rec["skipped"] = "mint_mismatch_or_native"
                info["accounts"].append(rec)
                continue
            if ai.get("state") != "initialized":
                rec["skipped"] = f"state_{ai.get('state')}"
                info["accounts"].append(rec)
                continue
            if ai.get("closeAuthority") not in (None, WALLET):
                rec["skipped"] = "foreign_close_authority"
                info["accounts"].append(rec)
                continue
            acct_pk, prog_pk = Pubkey.from_string(a["pubkey"]), Pubkey.from_string(prog)
            if amt > 0:
                if exit_price is None:
                    rec["skipped"] = "no_price_for_dust_check"
                    info["accounts"].append(rec)
                    continue
                val = Decimal(amt) / Decimal(10**dec) * Decimal(str(exit_price))
                rec["dust_value_sol_est"] = str(val)
                if val >= DUST_MAX_SOL:
                    rec["skipped"] = "remaining_not_dust"
                    info["accounts"].append(rec)
                    continue
                ixs.append(Instruction(prog_pk, bytes([8]) + amt.to_bytes(8, "little"), [
                    AccountMeta(acct_pk, False, True), AccountMeta(Pubkey.from_string(mint), False, True),
                    AccountMeta(owner, True, False)]))
                rec["burned_atoms"] = amt
            ixs.append(Instruction(prog_pk, bytes([9]), [
                AccountMeta(acct_pk, False, True), AccountMeta(owner, False, True), AccountMeta(owner, True, False)]))
            planned.append(rec)
            info["accounts"].append(rec)
        if not planned:
            info["skipped"] = info.get("skipped") or "nothing_to_close"
            return info
        info["attempted"] = True
        bh = helius(helius_key, "getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"]
        tx = Transaction([kp], Message(ixs, owner), Hash.from_string(bh))
        b64 = base64.b64encode(bytes(tx)).decode("ascii")
        sim = helius(helius_key, "simulateTransaction", [b64, {"encoding": "base64", "commitment": "confirmed"}])["value"]
        if sim.get("err"):
            info["error"] = f"simulate_err:{json.dumps(sim.get('err'))[:200]}"
            return info
        sig = helius(helius_key, "sendTransaction",
                     [b64, {"encoding": "base64", "preflightCommitment": "confirmed", "maxRetries": 5}])
        info["close_sig"] = sig
        for _ in range(40):
            st = helius(helius_key, "getSignatureStatuses", [[sig], {"searchTransactionHistory": True}])
            val = (st.get("value") or [None])[0]
            if val and val.get("confirmationStatus") in ("confirmed", "finalized"):
                if val.get("err"):
                    info["error"] = f"close_tx_err:{json.dumps(val.get('err'))[:200]}"
                    return info
                info["confirmed"] = True
                info["rent_reclaimed_lamports"] = sum(r["lamports"] for r in planned)
                _f, f_bd = fetch_fee_breakdown(helius_key, sig, timeout_s=20.0)
                info["close_fee_lamports"] = f_bd.get("network_lamports")
                return info
            time.sleep(1.5)
        info["error"] = "close_tx_not_confirmed"
        return info
    except Exception as e:  # never propagate; no URL/key in message
        info["error"] = type(e).__name__
        return info


# ----------------------------------------------------------------- rails (pure; unit-tested)
def deadline_for(opened_at) -> datetime:
    return parse_ts(opened_at) + timedelta(hours=DEADLINE_HOURS)


def decide(pnl_pct: float, mark: Decimal, invalidation: Decimal | None, past_deadline: bool) -> tuple[str, str]:
    """The watch rails, in the clones' order (David 2026-09-23: FULL EXIT / bank ALL at +50%)."""
    if past_deadline:
        return "deadline_exit", "past_4h_stop"
    if pnl_pct <= -40:
        return "kill_exit", "hit_-40pct"
    if invalidation is not None and mark <= invalidation:
        return "kill_exit", "hit_invalidation_price"
    if pnl_pct >= 50:
        return "tp50_full_exit", "hit_+50pct_full_bank"
    if pnl_pct <= -25:
        return "warn", "near_kill_-25pct"
    if pnl_pct >= 40:
        return "warn", "near_tp50_+40pct"
    return "hold", "in_band"


def to_atoms(qty: Decimal, decimals: int) -> int:
    return int((Decimal(qty) * (Decimal(10) ** decimals)).to_integral_value(rounding=ROUND_DOWN))


def exit_fill_args(pos: dict, order_id: str, trigger: str, sig: str, in_atoms: int, out_lamports: int,
                   decimals: int, remain_atoms: int, cash_lamports: int, slot, fee_sol: Decimal, fee_bd: dict,
                   order_meta: dict | None, path: str, slippage: int, execute: dict, now: datetime) -> dict:
    """Arguments for public.bandit_exit_record_fill (pure; unit-tested)."""
    avg = D(pos["average_cost_sol"])
    in_tokens = Decimal(in_atoms) / Decimal(10**decimals)
    out_sol = Decimal(out_lamports) / Decimal(10**9)
    exit_price = out_sol / in_tokens if in_tokens else None
    realized = (exit_price - avg) * in_tokens if exit_price is not None else Decimal(0)
    prior = Decimal(str((pos.get("meta") or {}).get("tp50_realized_sol") or "0"))
    remain_tokens = Decimal(remain_atoms) / Decimal(10**decimals)
    cash_sol = Decimal(cash_lamports) / Decimal(10**9)
    sym = (pos.get("token") or {}).get("symbol")
    close_meta = {
        "deadline_exit": {"at": now.isoformat(), "sig": sig, "sold_tokens": str(in_tokens), "out_sol": str(out_sol),
                          "exit_price_sol": str(exit_price), "realized_sol": str(realized), "trigger": trigger,
                          "writer": "exit_clip"},
        "last_sig": sig, "exit_reason": trigger,
    }
    return {
        "order_id": order_id, "position_id": str(pos["id"]), "signature": sig,
        "exit_price": str(exit_price) if exit_price is not None else None,
        "in_tokens": str(in_tokens), "out_sol": str(out_sol), "remain_tokens": str(remain_tokens),
        "venue_order_id": (order_meta or {}).get("requestId"), "fee_sol": str(fee_sol),
        "executed_at": now.isoformat(), "cash_sol": str(cash_sol), "as_of": now.isoformat(),
        "realized_total": str(prior + realized), "pnl_notes": f"{sym} exit ({trigger}) sig={sig}",
        "close_meta": close_meta,
        "order_payload": {"path": path, "slippage_bps": slippage,
                          "execute": {k: execute.get(k) for k in ("status", "code", "signature", "totalInputAmount",
                                                                   "totalOutputAmount", "inputAmountResult",
                                                                   "outputAmountResult", "fallback")},
                          "order_meta": {k: v for k, v in (order_meta or {}).items() if k != "transaction"},
                          "realized_sol": str(realized)},
        "fill_payload": {"fee_breakdown": fee_bd, "in_atoms": in_atoms, "out_lamports": out_lamports,
                         "decimals": decimals, "path": path, "slippage_bps": slippage, "trigger": trigger,
                         "realized_sol": str(realized), "writer": "exit_clip"},
        "pnl_payload": {"source": "helius_getBalance", "wallet": WALLET, "lamports": cash_lamports,
                        "context_slot": slot, "trade_sig": sig, "sold_tokens": str(in_tokens), "out_sol": str(out_sol),
                        "exit_price_sol": str(exit_price), "remaining_tokens": str(remain_tokens), "trigger": trigger,
                        "position_id": str(pos["id"]), "writer": "exit_clip"},
        "_computed": {"realized_this_sol": str(realized), "realized_total_sol": str(prior + realized),
                      "exit_price": exit_price, "in_tokens": in_tokens, "out_sol": out_sol,
                      "remain_tokens": remain_tokens, "cash_sol": cash_sol},
    }
