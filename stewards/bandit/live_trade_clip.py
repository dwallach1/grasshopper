#!/usr/bin/env python3
"""BANDIT live clip template (desk #86/#87/#88): size comes from steward_sizing_guidance, not a hardcoded SIZE_SOL.

Usage:
  .venv/bin/python live_trade_clip.py --mint <MINT> --symbol <SYM> [--name <NAME>] --request 0.45 --rationale "<why>"
  add --dry-run to print guidance + size and exit without trading.

Buys exactly sized_notional from steward_sizing_guidance('bandit','meme_4h_momentum_clip',<SYM>,<request>,<invalidation>).
sized_notional = min(request x multiplier, edge-scaled max_stake, cash). The invalidation (SOL/token) defaults to
0.6 x the Jupiter pre-trade price (--invalidation-price overrides) and is written on the meme_positions lot;
guidance refuses (missing_invalidation) and the DB rejects a new open lot without one. meme_orders carries thesis_id.
Aborts if entry_allowed is false. No max-open or daily-stop rail (removed per David). 3% price-impact abort stays.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal, getcontext

import os

import base58
import requests
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction

# Helpers resolve from the directory the script is invoked from first (the box copy in
# /workspace/bandit keeps its own load_secrets/db_connect), then from this repo directory.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
STATE_DIR = os.environ.get("BANDIT_STATE_DIR") or _HERE

from db_connect import connect  # noqa: E402
from load_secrets import require  # noqa: E402

getcontext().prec = 50

WALLET = "3AKSqcwDwuH1CPC9ZBN6S8ajGjjeFUyqmaUiyxPFKRFG"
ACCOUNT_KEY = "solana-bandit-primary"
MINT = ""
SYMBOL = ""
NAME = ""
RATIONALE = ""
THESIS_ID = "meme_4h_momentum_clip"
SOL_MINT = "So11111111111111111111111111111111111111112"
SIZE_SOL = Decimal(0)  # set from steward_sizing_guidance in main(); never hardcode
SIZE_LAMPORTS = 0
GUIDANCE: dict = {}
DECIMALS = 6  # pump.fun typical; override after getTokenSupply
KILL = (
    "exit if -40% from entry OR thesis invalid OR 4h time stop; "
    "FULL EXIT / bank ALL at +50% — no half-scale to +100%"
)
JUP_BASE = "https://api.jup.ag/swap/v2"
JUP_PRICE = "https://api.jup.ag/price/v3"
KILL_FRACTION = Decimal("0.6")  # invalidation = 0.6 x pre-trade price (SOL/token), i.e. -40%
PLANNED_INVALIDATION: Decimal | None = None  # SOL per token; required by guidance and meme_positions
SLIPPAGE_TRIES = [300, 500]  # 3%, then 5% — do not crank higher


def rpc(helius_key: str, method: str, params):
    url = f"https://mainnet.helius-rpc.com/?api-key={helius_key}"
    r = requests.post(
        url,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        timeout=60,
    )
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"RPC {method} error: {body['error']}")
    return body["result"]


def get_balance_lamports(helius_key: str) -> tuple[int, int | None]:
    url = f"https://mainnet.helius-rpc.com/?api-key={helius_key}"
    r = requests.post(
        url,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBalance",
            "params": [WALLET],
        },
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(body["error"])
    return int(body["result"]["value"]), body["result"].get("context", {}).get("slot")


def jup_order(api_key: str, slippage_bps: int | None) -> dict:
    params = {
        "inputMint": SOL_MINT,
        "outputMint": MINT,
        "amount": str(SIZE_LAMPORTS),
        "taker": WALLET,
    }
    if slippage_bps is not None:
        params["slippageBps"] = str(slippage_bps)
    r = requests.get(
        f"{JUP_BASE}/order",
        params=params,
        headers={"x-api-key": api_key},
        timeout=60,
    )
    text = r.text
    if not r.ok:
        raise RuntimeError(f"/order HTTP {r.status_code}: {text[:800]}")
    order = r.json()
    return order


def planned_invalidation_sol(api_key: str) -> Decimal:
    """Pre-trade price in SOL per token from Jupiter price v3, x KILL_FRACTION."""
    r = requests.get(JUP_PRICE, params={"ids": f"{MINT},{SOL_MINT}"}, headers={"x-api-key": api_key}, timeout=30)
    if not r.ok:
        raise RuntimeError(f"price/v3 HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    tok = (data.get(MINT) or {}).get("usdPrice")
    sol = (data.get(SOL_MINT) or {}).get("usdPrice")
    if not tok or not sol or Decimal(str(sol)) <= 0 or Decimal(str(tok)) <= 0:
        raise RuntimeError("no Jupiter price for the mint or SOL; cannot set invalidation; no trade")
    return (Decimal(str(tok)) / Decimal(str(sol)) * KILL_FRACTION).quantize(Decimal("1e-18"))


def jup_execute(api_key: str, signed_b64: str, request_id: str) -> dict:
    r = requests.post(
        f"{JUP_BASE}/execute",
        headers={"Content-Type": "application/json", "x-api-key": api_key},
        json={"signedTransaction": signed_b64, "requestId": request_id},
        timeout=120,
    )
    text = r.text
    if not r.ok:
        raise RuntimeError(f"/execute HTTP {r.status_code}: {text[:800]}")
    return r.json()


def sign_order_tx(kp: Keypair, tx_b64: str) -> str:
    raw = base64.b64decode(tx_b64)
    tx = VersionedTransaction.from_bytes(raw)
    # Reconstruct with signer (solders signs on construction)
    signed = VersionedTransaction(tx.message, [kp])
    return base64.b64encode(bytes(signed)).decode("ascii")


def helius_send_fallback(helius_key: str, signed_b64: str) -> str:
    """Fallback: send signed tx via Helius RPC."""
    raw = base64.b64decode(signed_b64)
    # Helius prefers base64 encoding
    sig = rpc(
        helius_key,
        "sendTransaction",
        [
            signed_b64,
            {
                "encoding": "base64",
                "skipPreflight": False,
                "preflightCommitment": "confirmed",
                "maxRetries": 3,
            },
        ],
    )
    # confirm
    for _ in range(40):
        st = rpc(helius_key, "getSignatureStatuses", [[sig], {"searchTransactionHistory": True}])
        val = (st.get("value") or [None])[0]
        if val and val.get("confirmationStatus") in ("confirmed", "finalized"):
            if val.get("err"):
                raise RuntimeError(f"tx landed with err: {val['err']} sig={sig}")
            return sig
        time.sleep(1.5)
    raise RuntimeError(f"tx not confirmed in time: {sig}")


def ensure_token(cur) -> str:
    cur.execute(
        "SELECT id FROM meme_tokens WHERE mint=%s",
        (MINT,),
    )
    row = cur.fetchone()
    if row:
        token_id = str(row[0])
        cur.execute(
            """
            UPDATE meme_tokens
            SET symbol=COALESCE(symbol, %s),
                name=COALESCE(name, %s),
                kill_criteria=%s,
                updated_at=now()
            WHERE id=%s::uuid
            """,
            (SYMBOL, NAME, KILL, token_id),
        )
        return token_id
    cur.execute(
        """
        INSERT INTO meme_tokens (venue, mint, symbol, name, status, kill_criteria, meta)
        VALUES ('jupiter', %s, %s, %s, 'watch', %s, %s::jsonb)
        RETURNING id
        """,
        (MINT, SYMBOL, NAME, KILL, json.dumps({"source": "live_trade_clip", "name": NAME})),
    )
    return str(cur.fetchone()[0])


# --- fee capture: fee_sol = meta.fee (base+priority, if WALLET is fee payer) + Jito/MEV tips
# --- from WALLET in the same tx. Excludes refundable token-account rent and route fees.
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


def fetch_fee_breakdown(helius_key: str, sig, timeout_s: float = 45.0):
    """Poll getTransaction until available; return (fee_sol Decimal, fee_breakdown dict). Never raises."""
    bd = {"network_lamports": None, "tip_lamports": None, "source": "getTransaction"}
    if not sig:
        bd["unresolved"] = "no_signature"
        return Decimal(0), bd
    t_end = time.time() + timeout_s
    last_err = None
    while True:
        try:
            tx = rpc(
                helius_key,
                "getTransaction",
                [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0, "commitment": "confirmed"}],
            )
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
                bd.update(
                    network_lamports=network,
                    tip_lamports=tip,
                    slot=tx.get("slot"),
                    fee_payer_is_wallet=payer_is_wallet,
                )
                return Decimal(network + tip) / Decimal(10**9), bd
            last_err = "tx_not_available"
        except Exception as e:  # never let fee capture break fill recording; no URL/key in message
            last_err = type(e).__name__
        if time.time() >= t_end:
            bd["unresolved"] = last_err or "timeout"
            return Decimal(0), bd
        time.sleep(1.5)


def main() -> int:
    secrets = require(
        "BANDIT_SOLANA_PRIVATE_KEY",
        "HELIUS_API_KEY",
        "JUPITER_API_KEY",
        "BANDIT_WORKER_DB_PASSWORD",
    )
    global DECIMALS, SIZE_SOL, SIZE_LAMPORTS, GUIDANCE, PLANNED_INVALIDATION
    # Entry requires an invalidation (guidance returns missing_invalidation without one, and
    # meme_positions rejects a new open lot without invalidation_price).
    if PLANNED_INVALIDATION is None:
        PLANNED_INVALIDATION = planned_invalidation_sol(secrets["JUPITER_API_KEY"])
    if PLANNED_INVALIDATION <= 0:
        raise RuntimeError("invalidation price must be > 0")
    print(f"planned_invalidation_sol_per_token={PLANNED_INVALIDATION}")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM steward_sizing_guidance('bandit', %s, %s, %s, %s)",
                (THESIS_ID, SYMBOL, str(REQUEST_SOL), str(PLANNED_INVALIDATION)),
            )
            cols = [d[0] for d in cur.description]
            row = cur.fetchone()
    if not row:
        raise RuntimeError("steward_sizing_guidance returned no row")
    g = dict(zip(cols, row))
    GUIDANCE = {k: (str(v) if isinstance(v, (Decimal,)) or hasattr(v, "isoformat") else v) for k, v in g.items()}
    print("GUIDANCE=" + json.dumps({k: GUIDANCE.get(k) for k in (
        "requested", "multiplier", "multiplier_basis", "max_stake", "max_stake_reason", "sized_notional",
        "spendable_cash", "sample_trades", "thesis_confidence", "thesis_status", "invalidation_price",
        "book_age_minutes", "entry_allowed", "entry_blocked_reason")}))
    if not g.get("entry_allowed"):
        raise RuntimeError(f"entry_allowed=false: {g.get('entry_blocked_reason')}")
    SIZE_SOL = Decimal(str(g["sized_notional"])).quantize(Decimal("0.000001"))
    SIZE_LAMPORTS = int(SIZE_SOL * Decimal(10**9))
    if SIZE_LAMPORTS <= 0:
        raise RuntimeError(f"sized_notional {SIZE_SOL} <= 0; no trade")
    print(f"size_sol={SIZE_SOL} size_lamports={SIZE_LAMPORTS}")
    if DRY_RUN:
        print("DRY_RUN: no trade")
        return 0
    try:
        supply = rpc(secrets["HELIUS_API_KEY"], "getTokenSupply", [MINT])
        DECIMALS = int(supply["value"]["decimals"])
        print(f"mint_decimals={DECIMALS}")
    except Exception as e:
        print(f"decimals_fallback={DECIMALS} err={type(e).__name__}")
    kp = Keypair.from_bytes(base58.b58decode(secrets["BANDIT_SOLANA_PRIVATE_KEY"]))
    if str(kp.pubkey()) != WALLET:
        raise RuntimeError(f"keypair pubkey mismatch: {kp.pubkey()}")

    bal0, slot0 = get_balance_lamports(secrets["HELIUS_API_KEY"])
    print(f"pre_balance_lamports={bal0} slot={slot0}")
    if bal0 < SIZE_LAMPORTS + 5_000_000:
        raise RuntimeError(f"insufficient SOL: have {bal0} need ~{SIZE_LAMPORTS}+fees")

    # Ledger: ensure token + insert order (submitted)
    with connect() as conn:
        with conn.cursor() as cur:
            token_id = ensure_token(cur)
            cur.execute(
                """
                INSERT INTO meme_orders (
                  token_id, account_key, thesis_id, side, order_type, size_sol,
                  status, mode, kill_criteria, rationale, gate_results, payload, submitted_at,
                  max_stake_at_entry, max_stake_reason_at_entry
                ) VALUES (
                  %s::uuid, %s, %s, 'buy', 'market', %s,
                  'submitted', 'live', %s, %s, %s::jsonb, %s::jsonb, now(),
                  %s, %s
                ) RETURNING id
                """,
                (
                    token_id,
                    ACCOUNT_KEY,
                    THESIS_ID,
                    str(SIZE_SOL),
                    KILL,
                    f"BANDIT live — {SYMBOL} {SIZE_SOL} SOL ExactIn (steward size: req {REQUEST_SOL} x {GUIDANCE.get('multiplier')}); thesis meme_4h_momentum_clip; {RATIONALE}; kill -40%/thesis/4h; TP FULL bank at +50%",
                    json.dumps({"pre_balance_lamports": bal0, "slot": slot0, "steward_sizing_guidance": GUIDANCE}),
                    json.dumps(
                        {
                            "mint": MINT,
                            "symbol": SYMBOL,
                            "wallet": WALLET,
                            "size_lamports": SIZE_LAMPORTS,
                            "slippage_plan_bps": SLIPPAGE_TRIES,
                        }
                    ),
                    GUIDANCE.get("max_stake"),
                    GUIDANCE.get("max_stake_reason"),
                ),
            )
            order_id = str(cur.fetchone()[0])
        conn.commit()
    print(f"ledger_order_id={order_id} token_id={token_id}")

    last_err = None
    result = None
    used_slippage = None
    order_meta = None
    path = None

    for slip in SLIPPAGE_TRIES:
        try:
            print(f"attempting /order slippageBps={slip}")
            order = jup_order(secrets["JUPITER_API_KEY"], slip)
            order_meta = {
                k: order.get(k)
                for k in (
                    "requestId",
                    "inAmount",
                    "outAmount",
                    "otherAmountThreshold",
                    "router",
                    "mode",
                    "feeBps",
                    "feeMint",
                    "slippageBps",
                    "priceImpactPct",
                    "errorCode",
                    "errorMessage",
                    "expireAt",
                    "lastValidBlockHeight",
                )
                if k in order or order.get(k) is not None
            }
            # also keep raw keys present
            for k in ("inAmount", "outAmount", "requestId", "router", "mode", "transaction"):
                if k in order:
                    order_meta[k] = order[k] if k != "transaction" else ("set" if order[k] else order[k])

            # Abort if price impact > 1%
            try:
                impact_abs = abs(float(order.get("priceImpactPct") or 0))
            except (TypeError, ValueError):
                impact_abs = 0.0
            print(f"priceImpactPct={order.get('priceImpactPct')} impact_abs={impact_abs}")
            if impact_abs > 0.03:  # priceImpactPct is a fraction; 0.03 = 3% rail
                last_err = f"abort: price impact {impact_abs} > 3%"
                print(last_err)
                with connect() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            UPDATE meme_orders
                            SET status='rejected', updated_at=now(),
                                payload = payload || %s::jsonb
                            WHERE id=%s::uuid
                            """,
                            (json.dumps({"error": last_err, "order_meta": order_meta}), order_id),
                        )
                    conn.commit()
                print(f"FAILED order_id={order_id} error={last_err}")
                return 1

            tx_b64 = order.get("transaction")
            if not tx_b64:
                last_err = (
                    f"/order no transaction router={order.get('router')} "
                    f"code={order.get('errorCode')} msg={order.get('errorMessage')} "
                    f"outAmount={order.get('outAmount')}"
                )
                print(last_err)
                continue

            signed_b64 = sign_order_tx(kp, tx_b64)
            print(f"signed requestId={order.get('requestId')} router={order.get('router')} outAmount={order.get('outAmount')}")

            # Prefer Jupiter /execute
            try:
                ex = jup_execute(secrets["JUPITER_API_KEY"], signed_b64, order["requestId"])
                print(f"execute_status={ex.get('status')} code={ex.get('code')} sig={ex.get('signature')}")
                if ex.get("status") == "Success" or ex.get("code") == 0:
                    result = ex
                    used_slippage = slip
                    path = "jupiter_execute"
                    break
                last_err = f"/execute failed: {json.dumps(ex)[:800]}"
                print(last_err)
                # fallback Helius send of same signed tx
                print("fallback: Helius sendTransaction")
                sig = helius_send_fallback(secrets["HELIUS_API_KEY"], signed_b64)
                result = {
                    "status": "Success",
                    "signature": sig,
                    "totalInputAmount": order.get("inAmount"),
                    "totalOutputAmount": order.get("outAmount"),
                    "inputAmountResult": order.get("inAmount"),
                    "outputAmountResult": order.get("outAmount"),
                    "fallback": "helius_send",
                    "note": "amounts from quote (execute failed); confirm onchain",
                }
                used_slippage = slip
                path = "helius_send_fallback"
                break
            except Exception as e:
                last_err = f"/execute error: {e}"
                print(last_err)
                try:
                    print("fallback: Helius sendTransaction after execute exception")
                    sig = helius_send_fallback(secrets["HELIUS_API_KEY"], signed_b64)
                    result = {
                        "status": "Success",
                        "signature": sig,
                        "totalInputAmount": order.get("inAmount"),
                        "totalOutputAmount": order.get("outAmount"),
                        "inputAmountResult": order.get("inAmount"),
                        "outputAmountResult": order.get("outAmount"),
                        "fallback": "helius_send",
                        "note": "amounts from quote; execute raised",
                    }
                    used_slippage = slip
                    path = "helius_send_fallback"
                    break
                except Exception as e2:
                    last_err = f"helius fallback failed: {e2}"
                    print(last_err)
                    continue
        except Exception as e:
            last_err = f"slippage {slip} attempt failed: {e}"
            print(last_err)
            continue

    if not result:
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE meme_orders
                    SET status='rejected', updated_at=now(),
                        payload = payload || %s::jsonb
                    WHERE id=%s::uuid
                    """,
                    (
                        json.dumps({"error": str(last_err), "order_meta": order_meta}),
                        order_id,
                    ),
                )
            conn.commit()
        print(f"FAILED order_id={order_id} error={last_err}")
        return 1

    sig = result.get("signature")
    in_raw = result.get("totalInputAmount") or result.get("inputAmountResult")
    out_raw = result.get("totalOutputAmount") or result.get("outputAmountResult")
    # Prefer execute wallet-reflected amounts
    if result.get("totalInputAmount"):
        in_raw = result["totalInputAmount"]
    if result.get("totalOutputAmount"):
        out_raw = result["totalOutputAmount"]

    in_lamports = int(in_raw) if in_raw is not None else SIZE_LAMPORTS
    out_atoms = int(out_raw) if out_raw is not None else None
    if out_atoms is None:
        raise RuntimeError("no output amount from venue")

    in_sol = Decimal(in_lamports) / Decimal(10**9)
    out_tokens = Decimal(out_atoms) / Decimal(10**DECIMALS)
    # entry price in SOL per whole token
    entry_price = (in_sol / out_tokens) if out_tokens else None

    # post balance
    bal1, slot1 = bal0, slot0
    for _ in range(20):
        time.sleep(1.5)
        bal1, slot1 = get_balance_lamports(secrets["HELIUS_API_KEY"])
        if bal1 != bal0:
            break
    cash_sol = Decimal(bal1) / Decimal(10**9)

    _fee_sol, _fee_bd = fetch_fee_breakdown(secrets["HELIUS_API_KEY"], sig)
    fill_id = pos_id = pnl_id = None
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE meme_orders
                SET status='filled', signature=%s, price_sol=%s,
                    size_tokens=%s, updated_at=now(),
                    payload = payload || %s::jsonb
                WHERE id=%s::uuid
                """,
                (
                    sig,
                    str(entry_price) if entry_price is not None else None,
                    str(out_tokens),
                    json.dumps(
                        {
                            "path": path,
                            "slippage_bps": used_slippage,
                            "execute": {
                                k: result.get(k)
                                for k in (
                                    "status",
                                    "code",
                                    "signature",
                                    "totalInputAmount",
                                    "totalOutputAmount",
                                    "inputAmountResult",
                                    "outputAmountResult",
                                    "fallback",
                                    "note",
                                )
                            },
                            "order_meta": {k: v for k, v in (order_meta or {}).items() if k != "transaction"},
                        }
                    ),
                    order_id,
                ),
            )

            # position upsert-ish: open new or add to existing open
            cur.execute(
                """
                SELECT id, quantity, average_cost_sol FROM meme_positions
                WHERE token_id=%s::uuid AND account_key=%s AND status='open'
                ORDER BY created_at DESC LIMIT 1
                """,
                (token_id, ACCOUNT_KEY),
            )
            prow = cur.fetchone()
            if prow:
                pos_id = str(prow[0])
                old_q = Decimal(prow[1] or 0)
                old_avg = Decimal(prow[2] or 0)
                new_q = old_q + out_tokens
                new_avg = (
                    ((old_avg * old_q) + (entry_price * out_tokens)) / new_q
                    if new_q and entry_price is not None
                    else entry_price
                )
                cur.execute(
                    """
                    UPDATE meme_positions
                    SET quantity=%s, average_cost_sol=%s, mark_sol=%s, mark_at=now(),
                        kill_criteria=%s, updated_at=now(), thesis_id=COALESCE(thesis_id, 'meme_4h_momentum_clip'),
                        meta = meta || %s::jsonb
                    WHERE id=%s::uuid
                    """,
                    (
                        str(new_q),
                        str(new_avg) if new_avg is not None else None,
                        str(entry_price) if entry_price is not None else None,
                        KILL,
                        json.dumps({"last_sig": sig, "mint": MINT}),
                        pos_id,
                    ),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO meme_positions (
                      token_id, account_key, thesis_id, status, quantity, average_cost_sol,
                      mark_sol, mark_at, opened_at, kill_criteria, meta,
                      invalidation_price, invalidation_note
                    ) VALUES (
                      %s::uuid, %s, %s, 'open', %s, %s,
                      %s, now(), now(), %s, %s::jsonb,
                      %s, %s
                    ) RETURNING id
                    """,
                    (
                        token_id,
                        ACCOUNT_KEY,
                        THESIS_ID,
                        str(out_tokens),
                        str(entry_price) if entry_price is not None else None,
                        str(entry_price) if entry_price is not None else None,
                        KILL,
                        json.dumps({"mint": MINT, "symbol": SYMBOL, "entry_sig": sig, "thesis": THESIS_ID}),
                        str(entry_price * KILL_FRACTION) if entry_price is not None else str(PLANNED_INVALIDATION),
                        "meme_4h_momentum_clip kill: -40% from entry (SOL/token); also 4h time stop and full bank at +50%",
                    ),
                )
                pos_id = str(cur.fetchone()[0])

            cur.execute(
                """
                INSERT INTO meme_fills (
                  order_id, position_id, account_key, venue_fill_id, venue_order_id,
                  side, quantity, price_sol, fee_sol, executed_at, payload
                ) VALUES (
                  %s::uuid, %s::uuid, %s, %s, %s,
                  'buy', %s, %s, %s, now(), %s::jsonb
                ) RETURNING id
                """,
                (
                    order_id,
                    pos_id,
                    ACCOUNT_KEY,
                    sig,  # venue_fill_id unique per account
                    (order_meta or {}).get("requestId"),
                    str(out_tokens),
                    str(entry_price) if entry_price is not None else "0",
                    str(_fee_sol),
                    json.dumps(
                        {
                            "fee_breakdown": _fee_bd,
                            "in_lamports": in_lamports,
                            "out_atoms": out_atoms,
                            "decimals": DECIMALS,
                            "path": path,
                            "slippage_bps": used_slippage,
                        }
                    ),
                ),
            )
            fill_id = str(cur.fetchone()[0])

            # fresh pnl from Helius balance
            as_of = datetime.now(timezone.utc)
            # equity approx: cash + position mark (mark = entry for now; no invented price)
            pos_value = (out_tokens * entry_price) if entry_price is not None else Decimal(0)
            # if adding to existing, recompute from DB
            cur.execute(
                """
                SELECT COALESCE(SUM(quantity * COALESCE(mark_sol, average_cost_sol, 0)), 0)
                FROM meme_positions WHERE account_key=%s AND status='open'
                """,
                (ACCOUNT_KEY,),
            )
            unreal = Decimal(cur.fetchone()[0] or 0)
            equity = cash_sol + unreal
            cur.execute(
                """
                INSERT INTO meme_pnl (
                  account_key, as_of, realized, unrealized, fees, cash_sol, equity_sol, notes, payload
                ) VALUES (
                  %s, %s, 0, %s, 0, %s, %s, %s, %s::jsonb
                ) RETURNING id
                """,
                (
                    ACCOUNT_KEY,
                    as_of,
                    str(unreal),
                    str(cash_sol),
                    str(equity),
                    f"post live trade {SYMBOL} sig={sig}",
                    json.dumps(
                        {
                            "source": "helius_getBalance",
                            "wallet": WALLET,
                            "lamports": bal1,
                            "context_slot": slot1,
                            "trade_sig": sig,
                            "in_sol": str(in_sol),
                            "out_tokens": str(out_tokens),
                            "entry_price_sol": str(entry_price),
                        }
                    ),
                ),
            )
            pnl_id = str(cur.fetchone()[0])

            # heartbeat if grants allow
            cur.execute("SAVEPOINT hb")
            try:
                cur.execute(
                    """
                    UPDATE desk_agents SET heartbeat_at=now(), updated_at=now()
                    WHERE slug='bandit'
                    RETURNING id
                    """
                )
                hb = cur.fetchone()
                print(f"heartbeat_updated={bool(hb)}")
                cur.execute("RELEASE SAVEPOINT hb")
            except Exception as e:
                cur.execute("ROLLBACK TO SAVEPOINT hb")
                print(f"heartbeat_skipped={e}")
        conn.commit()

    # verify thesis_id + opened_at for deadline
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE meme_positions SET thesis_id=%s WHERE id=%s::uuid AND thesis_id IS DISTINCT FROM %s", (THESIS_ID, pos_id, THESIS_ID))
            cur.execute("SELECT thesis_id, opened_at FROM meme_positions WHERE id=%s::uuid", (pos_id,))
            thesis_db, opened_at = cur.fetchone()
        conn.commit()
    from datetime import timedelta
    from zoneinfo import ZoneInfo
    deadline = opened_at + timedelta(hours=4)
    last_fill = {
        "ok": True, "symbol": SYMBOL, "name": NAME, "mint": MINT, "decimals": DECIMALS,
        "size_sol": str(SIZE_SOL), "requested_sol": str(REQUEST_SOL), "multiplier": GUIDANCE.get("multiplier"), "in_sol": str(in_sol), "tokens": str(out_tokens),
        "entry_price_sol_per_token": str(entry_price), "signature": sig,
        "solscan": f"https://solscan.io/tx/{sig}", "path": path, "slippage_bps": used_slippage,
        "price_impact_pct": (order_meta or {}).get("priceImpactPct"),
        "venue_sol_before": str(Decimal(bal0) / Decimal(10**9)), "venue_sol_after": str(cash_sol),
        "venue_lamports_after": bal1, "thesis_id": thesis_db,
        "opened_at_utc": opened_at.astimezone(timezone.utc).isoformat(),
        "deadline_pt": deadline.astimezone(ZoneInfo("America/Los_Angeles")).isoformat(),
        "deadline_et": deadline.astimezone(ZoneInfo("America/New_York")).isoformat(),
        "ledger": {"token_id": token_id, "order_id": order_id, "fill_id": fill_id, "position_id": pos_id, "pnl_id": pnl_id},
    }
    with open(os.path.join(STATE_DIR, f"_last_fill_{SYMBOL.lower()}.json"), "w") as f:
        json.dump(last_fill, f, indent=2)
    print("LAST_FILL=" + json.dumps(last_fill))

    report = {
        "ok": True,
        "signature": sig,
        "path": path,
        "slippage_bps": used_slippage,
        "amount_in_sol": str(in_sol),
        "amount_out_tokens": str(out_tokens),
        "entry_price_sol_per_token": str(entry_price),
        "ledger": {
            "token_id": token_id,
            "order_id": order_id,
            "fill_id": fill_id,
            "position_id": pos_id,
            "pnl_id": pnl_id,
        },
        "ending_sol_balance": str(cash_sol),
        "ending_lamports": bal1,
        "solscan": f"https://solscan.io/tx/{sig}",
    }
    print("REPORT=" + json.dumps(report, indent=2))
    return 0


def _parse_args():
    global MINT, SYMBOL, NAME, RATIONALE, REQUEST_SOL, DRY_RUN, PLANNED_INVALIDATION
    ap = argparse.ArgumentParser()
    ap.add_argument("--mint", required=True)
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--name")
    ap.add_argument("--request", required=True, help="requested SOL before steward multiplier")
    ap.add_argument("--rationale", default="")
    ap.add_argument("--invalidation-price", help="SOL per token; default 0.6 x Jupiter pre-trade price")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    MINT, SYMBOL, NAME, RATIONALE = a.mint, a.symbol, (a.name or a.symbol), a.rationale
    REQUEST_SOL = Decimal(a.request)
    DRY_RUN = a.dry_run
    if a.invalidation_price is not None:
        PLANNED_INVALIDATION = Decimal(a.invalidation_price)


REQUEST_SOL = Decimal(0)
DRY_RUN = False

if __name__ == "__main__":
    _parse_args()
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"FATAL: {type(e).__name__}: {e}", file=sys.stderr)
        raise
