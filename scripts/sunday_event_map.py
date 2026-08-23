#!/usr/bin/env python3
"""Persist a dated, watch-only weekly catalyst map in Supabase.

This script intentionally creates no broker orders.  Candidate entries are research-only
and use a zero notional so the Monday market-hours workflow can independently validate
price, liquidity, and portfolio overlap before a human review.
"""
from __future__ import annotations

import datetime as dt
import json

try:
    from scripts import database
except ModuleNotFoundError:
    import database

RUN_DATE = "2026-08-23"
WEEK = "2026-08-24_to_2026-08-30"


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def node(conn: database.Connection, node_id: str, node_type: str, label: str, props: dict) -> None:
    ts = now()
    conn.execute(
        """
        INSERT INTO graph_nodes(id, node_type, label, properties_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET label=excluded.label, properties_json=excluded.properties_json,
          updated_at=excluded.updated_at
        """,
        (node_id, node_type, label, json.dumps(props, sort_keys=True), ts, ts),
    )


def edge(conn: database.Connection, src: str, dst: str, edge_type: str, weight: float, props: dict | None = None) -> None:
    ts = now()
    conn.execute(
        """
        INSERT INTO graph_edges(src_id, dst_id, edge_type, weight, evidence_count, properties_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(src_id, dst_id, edge_type) DO UPDATE SET weight=excluded.weight,
          evidence_count=excluded.evidence_count, properties_json=excluded.properties_json,
          updated_at=excluded.updated_at
        """,
        (src, dst, edge_type, weight, json.dumps(props or {}, sort_keys=True), ts, ts),
    )


def ensure_symbol(conn: database.Connection, symbol: str) -> None:
    ts = now()
    conn.execute(
        """
        INSERT INTO symbols(symbol, first_seen_at, last_seen_at, mention_count, source_count, status)
        VALUES (?, ?, ?, 0, 0, 'candidate')
        ON CONFLICT(symbol) DO UPDATE SET last_seen_at=excluded.last_seen_at
        """,
        (symbol, ts, ts),
    )
    node(conn, f"symbol:{symbol}", "symbol", symbol, {"status": "candidate"})


def event(
    conn: database.Connection,
    slug: str,
    event_type: str,
    label: str,
    event_date: str,
    status: str,
    source_url: str,
    summary: str,
    decision: str,
    trigger: str,
    concepts: list[str],
    symbols: list[str],
    source_id: str,
) -> None:
    ts = now()
    row = conn.execute(
        "SELECT id FROM research_events WHERE label=? AND event_date=? ORDER BY id LIMIT 1", (label, event_date)
    ).fetchone()
    if row:
        event_id = row[0]
        conn.execute(
            """UPDATE research_events SET event_type=?, status=?, source_url=?, summary=?, updated_at=? WHERE id=?""",
            (event_type, status, source_url, summary, ts, event_id),
        )
    else:
        cursor = conn.execute(
            """
            INSERT INTO research_events(event_type, label, event_date, status, source_url, summary, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (event_type, label, event_date, status, source_url, summary, ts, ts),
        )
        event_id = cursor.lastrowid
    event_node = f"event:weekly:{slug}"
    node(
        conn,
        event_node,
        "event",
        label,
        {
            "week": WEEK,
            "event_date": event_date,
            "status": status,
            "source_url": source_url,
            "research_event_id": event_id,
            "decision": decision,
        },
    )
    conn.execute(
        """
        INSERT INTO event_decisions(event_id, decision, rationale, participation_trigger, decided_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET decision=excluded.decision, rationale=excluded.rationale,
          participation_trigger=excluded.participation_trigger, updated_at=excluded.updated_at
        """,
        (event_id, decision, summary, trigger, ts, ts),
    )
    edge(conn, source_id, event_node, "mentions", 2.0)
    for concept in concepts:
        edge(conn, event_node, concept, "catalyzes", 4.0)
    for symbol in symbols:
        ensure_symbol(conn, symbol)
        edge(conn, event_node, f"symbol:{symbol}", "catalyzes", 3.0)


def queue(conn: database.Connection, priority: int, topic: str, reason: str) -> None:
    ts = now()
    row = conn.execute("SELECT id FROM research_queue WHERE topic=? AND status='open'", (topic,)).fetchone()
    if row:
        conn.execute(
            "UPDATE research_queue SET priority=?, reason=?, source=?, updated_at=? WHERE id=?",
            (priority, reason, f"sunday_event_map:{RUN_DATE}", ts, row[0]),
        )
    else:
        conn.execute(
            """INSERT INTO research_queue(priority, status, topic, reason, source, created_at, updated_at)
            VALUES (?, 'open', ?, ?, ?, ?, ?)""",
            (priority, topic, reason, f"sunday_event_map:{RUN_DATE}", ts, ts),
        )


def setup(conn: database.Connection, rank: int, slug: str, symbol: str, thesis_id: str, event_slug: str, rationale: str) -> None:
    ts = now()
    marker = f"[week:{WEEK};rank:{rank}]"
    row = conn.execute(
        "SELECT id FROM trade_proposals WHERE symbol=? AND status='research_only' AND rationale LIKE ? ORDER BY id LIMIT 1",
        (symbol, f"{marker}%"),
    ).fetchone()
    full_rationale = f"{marker} {rationale} No order is authorized; this is a Monday review candidate only."
    if row:
        proposal_id = row[0]
        conn.execute(
            """UPDATE trade_proposals SET thesis_id=?, side='buy', notional=0, order_type='research_only_no_trade',
            rationale=?, reviewed_at=NULL WHERE id=?""",
            (thesis_id, full_rationale, proposal_id),
        )
    else:
        cursor = conn.execute(
            """INSERT INTO trade_proposals(thesis_id, symbol, side, notional, order_type, status, rationale, created_at)
            VALUES (?, ?, 'buy', 0, 'research_only_no_trade', 'research_only', ?, ?)""",
            (thesis_id, symbol, full_rationale, ts),
        )
        proposal_id = cursor.lastrowid
    setup_node = f"setup:{slug}:{WEEK}"
    node(
        conn,
        setup_node,
        "trade",
        f"Rank {rank}: {symbol} Monday review",
        {
            "rank": rank,
            "status": "research_only_no_trade",
            "trade_proposal_id": proposal_id,
            "rationale": rationale,
            "portfolio_overlap_gate": "Do not activate with another same-factor AI infrastructure setup without a current exposure snapshot.",
        },
    )
    edge(conn, f"thesis:{thesis_id}", setup_node, "proposes", 4.0)
    edge(conn, setup_node, f"symbol:{symbol}", "targets", 4.0)
    edge(conn, setup_node, f"event:weekly:{event_slug}", "depends_on", 4.0)


def main() -> None:
    conn = database.connect()

    node(conn, "concept:portfolio_overlap", "concept", "portfolio overlap", {
        "constraint": "No current portfolio_exposure snapshot exists; permit one expression per correlated AI-infrastructure factor until verified.",
        "week": WEEK,
    })

    sources = {
        "nvidia_ir": ("NVIDIA IR: Q2 FY27 results", "https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Sets-Conference-Call-for-Second-Quarter-Financial-Results/default.aspx"),
        "iren_ir": ("IREN IR: FY26 results", "https://iren.gcs-web.com/news-releases/news-release-details/iren-release-fy26-results-august-27-2026"),
        "mrvl_ir": ("Marvell IR: Q2 FY27 results and investor day", "https://investor.marvell.com/"),
        "hot_chips": ("Hot Chips 2026 program", "https://www.hotchips.org/"),
        "bea": ("BEA: July 2026 Personal Income and Outlays", "https://www.bea.gov/node/42996"),
        "nscale": ("Nscale: Anyscale acquisition", "https://www.nscale.com/press-releases/nscale-acquires-anyscale"),
        "sec_s1": ("SEC current S-1 filings feed", "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=S-1&output=atom"),
        "sec_f1": ("SEC current F-1 filings feed", "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=F-1&output=atom"),
        "ipo_calendar": ("MarketBeat IPO calendar", "https://www.marketbeat.com/ipos/"),
        "sentiment": ("ThesisForge local market bookmarks, observed 2026-08-22", "local://bookmarks/2091082950565621965,2091184261734834375,2091278639291826339,2091306935043924013"),
    }
    for key, (label, url) in sources.items():
        node(conn, f"source:weekly:{key}:{RUN_DATE}", "source", label, {"url": url, "observed_at": RUN_DATE, "source_class": "official" if key not in {"ipo_calendar", "sentiment"} else "secondary_or_local"})

    event(conn, "nvda_q2", "earnings", "NVIDIA Q2 FY27 earnings", "2026-08-26", "scheduled", sources["nvidia_ir"][1],
          "Confirmed Q2 FY27 results and call: written commentary follows the release at about 1:20 p.m. PT; the 5 p.m. ET call is the week's primary AI-capex read-through.",
          "watch", "Only consider downstream expressions after results, guidance, and the opening-range / volume reaction confirm. No pre-event participation.",
          ["concept:neocloud", "concept:photonics", "concept:ai_power", "concept:earnings_events"], ["NVDA", "MRVL", "IREN", "AAOI", "CEG"], "source:weekly:nvidia_ir:2026-08-23")

    event(conn, "iren_fy26", "earnings", "IREN FY26 results", "2026-08-27", "scheduled", sources["iren_ir"][1],
          "Confirmed FY26 results and 5 p.m. ET call. Review AI-cloud revenue quality, contracted capacity, power availability, capex, liquidity, and financing terms—not headline ARR alone.",
          "watch", "Review only if post-result capacity / contract evidence is verified and liquidity is adequate; reject if financing, execution, or cash needs dominate.",
          ["concept:neocloud", "concept:ai_power", "concept:earnings_events"], ["IREN", "NBIS", "CRWV", "HUT", "CORZ"], "source:weekly:iren_ir:2026-08-23")

    event(conn, "mrvl_q2", "earnings", "Marvell Q2 FY27 earnings", "2026-08-27", "scheduled", sources["mrvl_ir"][1],
          "Confirmed 1:45 p.m. PT earnings call. Data-center and electro-optics guide, custom-silicon program cadence, and margin / customer-concentration commentary are the photonics read-through.",
          "watch", "Review only after the data-center guide and the post-result volume reaction; do not front-run the report.",
          ["concept:photonics", "concept:neocloud", "concept:earnings_events"], ["MRVL", "AAOI", "COHR", "LITE"], "source:weekly:mrvl_ir:2026-08-23")

    event(conn, "ai_secondary_earnings", "earnings", "AI secondary earnings: CRWD, CRM, SNPS and PLAB", "2026-08-26", "scheduled", "https://www.kiplinger.com/investing/stocks/17494/next-week-earnings-calendar-stocks",
          "Wednesday reports from CRWD, CRM, SNPS, and PLAB provide a secondary demand, enterprise-AI, EDA, and semiconductor-supply-chain read-through. Dates are calendar-confirmed but should be rechecked Monday morning.",
          "watch", "Use only as corroboration for existing theses; a single software result is not a reason to add correlated infrastructure exposure.",
          ["concept:photonics", "concept:neocloud", "concept:earnings_events"], ["CRWD", "CRM", "SNPS", "PLAB"], "source:weekly:nvidia_ir:2026-08-23")

    event(conn, "hot_chips", "industry_conference", "Hot Chips 2026: Vera, Rubin, BlueField and Spectrum-X", "2026-08-24_to_2026-08-25", "scheduled", sources["hot_chips"][1],
          "Conference sessions include NVIDIA Vera CPU and Rubin GPU on Monday, then BlueField-4 and Spectrum-X networking on Tuesday. Treat technical disclosures as directional evidence, not a stand-alone trading catalyst.",
          "watch", "Escalate only if official disclosures alter deployment timing, networking architecture, or power intensity relative to current expectations.",
          ["concept:photonics", "concept:neocloud", "concept:ai_power"], ["NVDA", "MRVL", "AAOI", "LITE", "COHR"], "source:weekly:hot_chips:2026-08-23")

    event(conn, "pce", "policy_macro", "BEA July 2026 Personal Income and Outlays (PCE)", "2026-08-26", "scheduled", sources["bea"][1],
          "BEA schedules the July Personal Income and Outlays release for 8:30 a.m. ET Wednesday. The rates reaction is a portfolio-level gate for long-duration, high-beta AI infrastructure names.",
          "watch", "Do not activate high-beta infrastructure candidates if yields rise and relative strength breaks after the release; reassess with Monday / Wednesday breadth.",
          ["concept:ai_power", "concept:neocloud", "concept:photonics", "concept:crypto_ai"], ["IREN", "MRVL", "AAOI", "NBIS", "TAO-USD"], "source:weekly:bea:2026-08-23")

    event(conn, "nscale_ipo", "ipo_watch", "Nscale potential U.S. IPO / filing terms", "2026-09", "watching", sources["nscale"][1],
          "Nscale's acquisition of Anyscale reinforces its full-stack AI-cloud narrative. No confirmed S-1/F-1 accession, ticker, terms, or August 24–30 pricing date is recorded in this run; the event remains a public-comp read-through only.",
          "watch", "Reassess only after a confirmed filing / prospectus identifies terms, lockups, ticker, and tradability. Do not infer a direct trade from reports or social posts.",
          ["concept:neocloud", "concept:ai_power", "concept:ipo_events"], ["NBIS", "IREN", "CRWV", "CORZ", "HUT"], "source:weekly:nscale:2026-08-23")

    event(conn, "sec_filing_sweep", "filing_watch", "SEC S-1/F-1 sweep: AI infrastructure, power and crypto-AI", "2026-08-24_to_2026-08-30", "watching", sources["sec_s1"][1],
          "No thesis-linked S-1/F-1 filing is asserted without a verified SEC accession. Sweep the SEC's S-1 and F-1 feeds each market day for AI data-center, power, photonics, neocloud, and crypto-AI issuers.",
          "watch", "Create a new filing event only after an SEC accession is verified; then extract issuer, ticker, use of proceeds, dilution, lockups, and public-comp links.",
          ["concept:ipo_events", "concept:neocloud", "concept:ai_power", "concept:crypto_ai"], ["IREN", "NBIS", "CRWV", "CORZ"], "source:weekly:sec_s1:2026-08-23")
    edge(conn, "source:weekly:sec_f1:2026-08-23", "event:weekly:sec_filing_sweep", "mentions", 2.0)

    event(conn, "ipo_lockup", "lockup_watch", "IPO and lockup calendar: thesis-linked verification sweep", "2026-08-24_to_2026-08-30", "watching", sources["ipo_calendar"][1],
          "The monitored IPO calendar contains a small consumer listing on August 24, not a thesis-linked infrastructure issue. No thesis-linked lockup expiration is confirmed for the coming week; do not manufacture a supply catalyst from generic lockup calendars.",
          "watch", "Add an issuer-specific lockup event only after prospectus / 8-K terms and the precise expiry date are verified.",
          ["concept:ipo_events", "concept:neocloud", "concept:crypto_ai"], ["IREN", "NBIS", "CRWV"], "source:weekly:ipo_calendar:2026-08-23")

    event(conn, "ownership_review", "ownership_filings", "13F and insider-filings verification: AI-power / neocloud overlap", "2026-08-24", "watching", "https://www.sec.gov/edgar/search/", 
          "The 13F reporting window has passed; local bookmarks show attention to power-utility holdings and neocloud / photonics upside targets, but these are sentiment inputs, not verified ownership facts. Verify holdings through the actual 13F and Form 4 accessions before changing conviction.",
          "watch", "Treat changes as evidence only after the filer, reporting period, security, and share change are confirmed in EDGAR; no copy-trading.",
          ["concept:ai_power", "concept:neocloud", "concept:photonics"], ["VST", "CEG", "IREN", "AAOI", "LITE"], "source:weekly:sentiment:2026-08-23")

    event(conn, "mrvl_investor_day", "investor_day", "Marvell investor day (announced)", "2026-10-06", "scheduled", sources["mrvl_ir"][1],
          "Marvell has announced an investor day for October 6. It is not this week's catalyst, but is retained as a forward event for the optical / custom-silicon thesis.",
          "watch", "Reassess after the Q2 call establishes whether the October agenda could change forward AI interconnect expectations.",
          ["concept:photonics", "concept:neocloud"], ["MRVL", "AAOI", "COHR", "LITE"], "source:weekly:mrvl_ir:2026-08-23")

    event(conn, "sentiment_clusters", "sentiment", "Online sentiment clusters: crowded AI power; high-beta neocloud / photonics", "2026-08-23", "observed", sources["sentiment"][1],
          "Local market bookmarks cluster around (1) AI power / nuclear scarcity and utility ownership, (2) high price-target narratives in IREN, NBIS, HUT, CORZ, CRWV and optical names, and (3) the NVDA–IREN–MRVL earnings sequence. Crowding raises the confirmation bar and argues against stacking same-factor positions.",
          "watch", "Require independent primary evidence plus price / volume confirmation; invalidate a momentum setup if it loses relative strength after its named catalyst.",
          ["concept:ai_power", "concept:nuclear", "concept:neocloud", "concept:photonics", "concept:crypto_ai", "concept:portfolio_overlap"], ["VST", "CEG", "IREN", "NBIS", "CRWV", "AAOI", "LITE", "TAO-USD"], "source:weekly:sentiment:2026-08-23")

    edge(conn, "event:weekly:sentiment_clusters", "event:weekly:nvda_q2", "depends_on", 2.0, {"reason": "earnings sequence is the dominant near-term attention cluster"})
    edge(conn, "event:weekly:nvda_q2", "event:weekly:iren_fy26", "depends_on", 3.0, {"reason": "NVDA capex commentary is a read-through gate for neocloud results"})
    edge(conn, "event:weekly:nvda_q2", "event:weekly:mrvl_q2", "depends_on", 3.0, {"reason": "NVDA platform and networking commentary is a photonics read-through gate"})
    for slug in ("nvda_q2", "iren_fy26", "mrvl_q2", "pce", "sentiment_clusters"):
        edge(conn, f"event:weekly:{slug}", "concept:portfolio_overlap", "exposes", 2.0)

    queue(conn, 100, f"{WEEK}: portfolio-overlap gate", "No portfolio_exposure snapshot is stored. Before any Monday review, reconcile live holdings and allow at most one new correlated AI-infrastructure expression across NVDA read-through, neocloud, power, and photonics.")
    queue(conn, 98, f"{WEEK}: NVDA earnings catalyst sheet", "Prepare a data-center demand, gross-margin, supply, China/export, Rubin timing, and hyperscaler-capex checklist. Rank downstream read-throughs only after the release and reaction.")
    queue(conn, 94, f"{WEEK}: IREN results quality / financing check", "Verify AI-cloud revenue, contract quality, power and data-center capacity, capex, liquidity, dilution, and post-result volume before elevating the neocloud setup.")
    queue(conn, 93, f"{WEEK}: Marvell optics / custom-silicon check", "Extract data-center revenue and guide, electro-optics, custom program cadence, margin, concentration, and the October investor-day agenda; compare the read-through to AAOI/COHR/LITE.")
    queue(conn, 88, f"{WEEK}: Hot Chips technical synthesis", "Capture only official slides or recordings relevant to Vera, Rubin, BlueField-4, and Spectrum-X; log changed deployment, networking, or power assumptions.")
    queue(conn, 86, f"{WEEK}: SEC S-1/F-1 and lockup sweep", "Check EDGAR S-1/F-1 accessions and issuer-specific prospectuses each market day. Record no filing / lockup as no result rather than inventing a catalyst.")
    queue(conn, 84, f"{WEEK}: 13F and Form 4 verification", "Replace local social claims with specific EDGAR accessions, reporting periods, and actual position deltas; keep ownership signals separate from price targets.")
    queue(conn, 82, f"{WEEK}: PCE rates-risk gate", "At Wednesday 8:30 a.m. ET, assess the yields and breadth response. Reduce confidence in high-duration, high-beta expressions if the rates reaction is adverse.")

    setup(conn, 1, "mrvl_event_review", "MRVL", "semis_photonics", "mrvl_q2", "Post-earnings photonics / custom-silicon review. Activation evidence: constructive data-center and electro-optics guide, no material margin or concentration deterioration, and a sustained post-result opening-range hold on expanding volume. Invalidation: guide / design-win cadence weakens, AI customer concentration becomes the dominant concern, or the sector rejects the result. Do not pair at full size with AAOI / COHR / LITE; choose one optical expression.")
    setup(conn, 2, "iren_event_review", "IREN", "neocloud_compute", "iren_fy26", "Post-results neocloud review. Activation evidence: independently verifiable AI-cloud contracts and capacity, credible funding / capex path, and relative-strength confirmation after the call. Invalidation: financing or dilution dominates, capacity / power commissioning slips, customer concentration worsens, or the stock fails the post-event relative-strength check. Do not stack with NBIS / CRWV / HUT / CORZ before the overlap gate.")
    setup(conn, 3, "ceg_nvda_pce_review", "CEG", "ai_power_nuclear", "nvda_q2", "AI-power read-through review after PCE and NVDA. Activation evidence: constructive hyperscaler / power-demand commentary plus utilities relative strength after the rates response. Invalidation: adverse PCE / yields response, no evidence that demand converts to generation / contract economics, or CEG loses relative strength to the power basket. CEG is the single cleaner power expression; do not add VST, OKLO, or SMR simultaneously without a verified portfolio budget.")
    setup(conn, 4, "aaoI_sympathy_review", "AAOI", "semis_photonics", "mrvl_q2", "Sympathy-only optics review after Marvell. Activation evidence: MRVL confirms interconnect demand and AAOI shows independent price / volume confirmation with acceptable liquidity. Invalidation: MRVL's data-center commentary does not support optics, AAOI breaks relative strength, or margin / capacity worries dominate. This is mutually exclusive with the rank-1 MRVL optics expression until a portfolio snapshot is present.")

    conn.commit()
    totals = {
        "nodes": conn.execute("SELECT COUNT(*) FROM graph_nodes").fetchone()[0],
        "edges": conn.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0],
        "events_this_week": conn.execute("SELECT COUNT(*) FROM research_events WHERE event_date LIKE '2026-08-2%' OR event_date LIKE '2026-08-30%'").fetchone()[0],
        "research_only_setups": conn.execute("SELECT COUNT(*) FROM trade_proposals WHERE status='research_only'").fetchone()[0],
    }
    conn.close()
    print(json.dumps(totals, indent=2))


if __name__ == "__main__":
    main()
