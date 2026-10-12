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
