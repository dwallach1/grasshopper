# Compounding X research

A bookmarked tweet is a signal, not a conclusion. The compounding research
pipeline turns each bookmark event into a bounded, self-directed research
session: it reads the conversation under the tweet, hydrates quoted and
referenced tweets, opens linked articles, and then lets the research model
(`openai/gpt-5.6-sol` through Cloudflare AI Gateway BYOK) decide which hops are worth
taking next — more reply threads, tweet lookups, X searches, or article
fetches — until evidence saturates or the budget runs out.

## Flow

```text
bookmark sync (09:35 + 14:35 America/New_York, or POST /x/sync)
        │  ingest + classify (existing pipeline)
        ▼
createResearchSessions()  — up to 3 new sessions per sync,
        │                   one per market-related bookmark
        ▼
thesisforge-knowledge-x-research queue (1 message = 1 step)
        │
        ▼
runResearchStep()
  1. execute pending actions
     step 1 is deterministic: read_conversation(bookmark) +
     lookup_tweets(quoted/referenced ids)
     later steps execute the model's chosen actions
  2. persist discovered tweets (x_research_tweets) and
     archived articles (existing articles + R2 pipeline)
  3. build the dossier: bookmark, classification, prior claim
     investigation, discovered tweets, article excerpts,
     prior findings, remaining budget
  4. ask the research model for findings + next actions
     (strict JSON, source_refs validated against the dossier)
  5. should_continue? → re-enqueue next step : finalize
        │
        ▼
finalize: session findings persisted, thesis_evidence rows written
          (evidence_type 'x_compounding_research'), knowledge graph
          rebuilt, dashboard republished
```

## Budgets (fail-closed at every layer)

| Layer | Budget |
|---|---|
| Sessions per sync | 3 (`MAX_RESEARCH_SESSIONS_PER_SYNC`) |
| LLM steps per session | 4 (`MAX_RESEARCH_STEPS`) |
| X API reads per session | 10 (`MAX_X_READS_PER_SESSION`) |
| Article fetches per session | 6 (`MAX_ARTICLE_FETCHES_PER_SESSION`) |
| Actions per step | 3 (`MAX_ACTIONS_PER_STEP`) |
| Vault-level X reads | 10 searches + 30 lookups per 15-minute window (`X_READ_BUDGETS`) |

Budget exhaustion is never an error: it becomes an observation the model
sees, so it concludes with what it has. The vault budget protects the X API
tier across all concurrent sessions; the DO serializes access exactly like
bookmark sync.

## Model boundary

The research role recommends nothing. Its output schema forces
`trade_recommendation: "none"`, every finding must cite `source_refs` that
exist in the dossier (unknown refs fail the step closed), and tweet/article
content is passed as untrusted evidence with explicit instructions never to
follow instructions found inside it. Findings become `thesis_evidence`
(type `x_compounding_research`) via the same symbol → theme mapping as
claim investigation; the deterministic policy and broker agent remain
the only path to trades.

## Storage

| Table | Contents |
|---|---|
| `x_research_sessions` | One row per bookmark: status, step/read/fetch counters, pending actions, accumulated findings |
| `x_research_steps` | Per-step audit: executed actions, observations, raw model output |
| `x_research_tweets` | Tweets discovered per session (replies, quotes, lookups, searches) with author, likes, raw JSON |
| `articles` / `research_documents` / R2 | Articles opened by the agent reuse the existing archive pipeline (content-addressed R2 originals) |

## Operations

- Automatic: the morning and pre-close bookmark syncs start sessions for new
  market-related bookmarks, 30 minutes before each portfolio decision window.
- Manual: `POST /api/knowledge/x/research` (dashboard proxy, manager only)
  with `{"bookmarkId": "..."}` creates or restarts a session.
- Queues must exist before first deploy:

```bash
wrangler queues create thesisforge-knowledge-x-research
wrangler queues create thesisforge-knowledge-x-research-dlq
```

- The migration `20260825031500_x_compounding_research.sql` creates the
  session tables with the standard `thesisforge_worker` RLS policies.
- X API note: `read_conversation` and `search_x` use
  `GET /2/tweets/search/recent`, which requires an X API tier with recent
  search access. On tiers without it, those actions surface a 4xx as an
  observation and the session degrades gracefully to quoted-tweet
  hydration and article crawling.
