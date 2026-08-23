# Financial data vault

ThesisForge treats Financial Datasets as a paid upstream source, not as its database. Every network response is written to `data/thesisforge.sqlite` before normalization. Repeat reads use the local cache until the dataset-specific freshness window expires.

## Safety properties

- The API key is read only from `FINANCIAL_DATASETS_API_KEY` and is never included in fingerprints, logs, or stored request headers.
- Raw response bytes, response headers, request parameters, status, timestamp, and SHA-256 are retained for every upstream call, including API errors.
- Raw JSON is gzip-compressed in SQLite. Normalized records keep their source request ID, so every fact is traceable to the exact purchased payload.
- Identical normalized records are deduplicated. Changed records are appended rather than overwritten.
- Pilot runs are dry by default and have a hard paid-request cap.
- Financial Datasets MCP results are imported under the same request fingerprint as direct HTTP results, preventing transport-specific duplicate purchases.

## Trial workflow

Add the purchased key to `.env.local`:

```sh
FINANCIAL_DATASETS_API_KEY=...
```

Load it into the shell, then inspect a three-ticker pilot without spending credits:

```sh
set -a
source .env.local
set +a
python3 scripts/financial_data.py pilot GEV VST CEG
```

After reviewing the request count, execute it:

```sh
python3 scripts/financial_data.py pilot GEV VST CEG --execute --max-paid-requests 40
```

The pilot requests 11 core datasets per ticker: company facts, quarterly metrics, three standardized statements, earnings, filings, insider trades, institutional holdings, news, and one year of daily prices. A repeated identical run uses the vault where the response remains fresh.

Inspect usage and storage:

```sh
python3 scripts/financial_data.py stats
```

Fetch an individual endpoint through the same cache:

```sh
python3 scripts/financial_data.py fetch /financial-metrics --param ticker=GEV --param period=quarterly --param limit=4
```

Use `--force` only when a fresh upstream snapshot is intentionally worth another request. Historical price queries whose end date is already in the past are cached for ten years.
