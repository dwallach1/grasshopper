# Financial data vault

ThesisForge treats Financial Datasets as a paid upstream source, not as its database. Every network response is written to the canonical Supabase Postgres database before normalization. Repeat reads use the persistent cache until the dataset-specific freshness window expires.

## Safety properties

- The API key is resolved only from the knowledge Worker's `FINANCIAL_DATASETS_API_KEY_SECRET` binding to the account-level Cloudflare Secrets Store entry `FINANCIAL_DATASETS_API_KEY`. It is never included in fingerprints, logs, or stored request headers.
- Raw response bytes, response headers, request parameters, status, timestamp, and SHA-256 are retained for every upstream call, including API errors.
- Raw response bytes are retained in Postgres. Normalized records keep their source request ID, so every fact is traceable to the exact purchased payload.
- Identical normalized records are deduplicated. Changed records are appended rather than overwritten.
- Retryable 429/5xx responses receive two bounded retries; the final response is retained for diagnosis.
- Paid requests are never scheduled and can only be initiated through the Access-authenticated manager route and internal service binding.

## Operator workflow

The dashboard's manager-only `POST /api/knowledge/financial` route accepts the upstream endpoint, query parameters, optional request body, and `force` flag. It forwards through the private `KNOWLEDGE_PIPELINE` service binding; neither the browser nor dashboard Worker can read the financial API key.

For example, a company-facts request body is:

```json
{
  "endpoint": "company/facts",
  "params": { "ticker": "TSLA" },
  "force": false
}
```

Use `force` only when a new purchased response is intentionally worth another request. Otherwise the persistent endpoint-specific cache is authoritative until its freshness window expires.

Production validation on 2026-08-24 forced the documented TSLA company-facts query through dashboard → service binding → knowledge Worker → Financial Datasets. The provider returned HTTP 200 from the network; request ID 32 was retained and one normalized record was written to Postgres.
