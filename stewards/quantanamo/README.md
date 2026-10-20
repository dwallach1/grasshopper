# QUANTANAMO box scripts

Versioned copies of the bookmark sweep QUANTANAMO runs at the end of every scan. `sync_box.sh` restores them to `/workspace/bookmark-ingest/`. Those two scripts are standard library only; outputs (`sql/`, `out/`, `pages/`) stay on the box.

## Equity pass marks

`pass_marks.py` prices logged equity skips once the 5th regular NYSE session has closed. `portfolio_exposure` and `broker_fills` only carry tickers QUANTANAMO owns or traded, so without this writer the resolver leaves those rows at `resolve_status = no_mark_yet`.

There is no QUANTANAMO scheduled Python entry in this repo. The bookmark scripts do not call it, and the Cloudflare research cron does not import it. Run it on the box after the Agentic heartbeat / end of scan (the same moment a taken bet would be marked), or call `pass_marks.sweep_quietly()` from that path. `QUANTANAMO_PASS_MARKS=0` skips the sweep.

```bash
bash /workspace/grasshopper/stewards/sync_box.sh
/workspace/quantanamo/.venv/bin/python /workspace/quantanamo/pass_marks.py --dry-run
/workspace/quantanamo/.venv/bin/python /workspace/quantanamo/pass_marks.py
```

`sync_box.sh` creates `/workspace/quantanamo` and a venv from `requirements.txt`. Ledger calls go through `steward_rpc.py`, the same file BANDIT and ODDSBORNE use (`steward_pending_decision_marks` / `steward_record_decision_mark` as `quantanamo_worker`).

Prices come from Financial Datasets (`https://api.financialdatasets.ai`, the provider the knowledge worker already uses). The key is `FINANCIAL_DATASETS_API_KEY` in the environment or the steward secrets file. The mark is the close of the first daily bar whose NYSE session close is at or after `horizon_at` (`GET /prices`, `interval=day`). `observed_at` is that session close (16:00 America/New_York, 13:00 on an early close), not the bar's date stamp. A live snapshot is used only after 18 hours with no traded daily close, and only when the snapshot's own timestamp is at or after the horizon. A horizon mark is insert-once, so the script does not lock in an earlier live quote. Nothing is interpolated. When both sources affirmatively have no price past that grace, the row is flagged with `no_price_reason`. Network errors are retried.

## Earnings implied move on open lots

`earnings_implied.py` stores, per open equity lot, the next earnings report and the ATM straddle used for open risk (`public.equity_implied_moves` via `steward_record_equity_implied_move`). Until that report is out, the lot's open risk is the max of the line distance and `(straddle / underlying) × position market value`. After the report, the line only. A missing chain or quote is stored as `implied_move_missing` and the line is used. The expiry written is the nearest listed expiration on or after the report date, including a monthly expiry weeks later.

There is no Robinhood client in this process. Each pass:

```bash
bash /workspace/grasshopper/stewards/sync_box.sh
python3 /workspace/quantanamo/earnings_implied.py plan
# Call the printed Robinhood tools, save the raw responses, then:
python3 /workspace/quantanamo/earnings_implied.py write payload.json --execute
```

`plan` prints the open lots with no current implied-move row and the calls: `get_earnings_results` (`symbol`; one held name, so the upcoming quarter is included past the 31-day market calendar), `get_option_chains` (`underlying_symbol`), `get_equity_quotes` (`symbols`), then `get_option_instruments` (`chain_symbol`, `state`, and `expiration_dates` once the nearest listed expiry on or after the report is known) and `get_option_quotes` (`instrument_ids` of the ATM call and put). `write` reads that file and prints `select public.steward_record_equity_implied_move(...)`. `--execute` runs it. `--dry-run` prints the SQL only. A missing quote is stored as `implied_move_missing`. No price is invented. From the repo the same commands are `python3 stewards/quantanamo/earnings_implied.py plan` and `write`. `QUANTANAMO_EARNINGS_IMPLIED=0` skips `sweep_quietly`.

`v_ledger_watchdog.equity_implied_move_gaps` counts those lots (no row, or a report still ahead with no straddle and no missing flag), so a missed write is a number on the watchdog.

After the report's release clock (09:30 America/New_York for a before-the-open print, 20:00 for an after-close print), `score` writes the realized move on that same row. An AM print uses the prior session's close as the reference and that session's open and close after the print. A PM print uses the report day's close and the next session's open and close. Bars come from Financial Datasets, or from Robinhood `get_equity_historicals` when `write` was given them. A missing bar is `score_missing_reason`. No bar is invented. `reported` flips when the score is stored. A close more than 1.5× the priced move, or an open through the exit, writes one `research_lessons` row and one `belief_updates` row (`kind` `earnings_print`, `new_confidence` null). Fewer than 5 scored closes stay a thin sample: the lesson says so, and `v_equity_earnings_scorecard.verdict` stays null. An expiry more than 7 days after the report is `expiry_loose` (the nearest listed expiry was already that far). That flag does not change the open-risk max.

`--price` is that post-session close when it is already in hand (a Robinhood regular-session close, or a Financial Datasets read from somewhere else). The command then skips the Financial Datasets fetch, so `FINANCIAL_DATASETS_API_KEY` is not required. `--price-source` names that close (`robinhood_historicals_rth_close`, `financialdatasets_mcp`) and is stored on the score statement and on `equity_implied_moves.meta`. The reference close is the one already stored on the lot, otherwise the underlying the straddle was marked on. A stored post open is kept; a missing open does not invent one and does not drop the supplied close. `--lot` scores one due lot. With `--price`, `--lot` is required when more than one lot is due. A non-positive `--price` is rejected. Without `--price`, scoring still reads Financial Datasets.

```bash
python3 /workspace/quantanamo/earnings_implied.py score --price 105.25 --price-source robinhood_historicals_rth_close
python3 /workspace/quantanamo/earnings_implied.py score --price 105.25 --price-source financialdatasets_mcp --lot <lot_id> --execute
```

Score NFLX (after the close on 2026-10-20) and EFX (before the open on 2026-10-20) on the morning of 2026-10-21, after migration `20261019220000_equity_earnings_score.sql` is applied:

```bash
bash /workspace/grasshopper/stewards/sync_box.sh
python3 /workspace/quantanamo/earnings_implied.py score --execute
```

EFX can be fully scored that morning (the 10/20 session has closed). NFLX has its reference close and, after 09:30 ET, the 10/21 open; the 10/21 close is not usable until 16:00 ET, so the morning row is `no_post_close`. The same scoring runs at the end of `write <payload.json> --execute`.
