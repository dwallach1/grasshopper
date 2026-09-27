"""Generate docs/rules/<id>.md and the desk_rules seed SQL from rules_data.py.
  python3 tools/court/build_rules.py            # writes docs/rules/*.md
  python3 tools/court/build_rules.py --sql A|B  # prints the full registry upsert (A: status now, B: after)
  python3 tools/court/build_rules.py --status-updates  # prints status-only updates (A -> B)
  python3 tools/court/build_rules.py --upsert id1,id2  # registry upsert (final status) for the named rules
  python3 tools/court/build_rules.py --checksum A|B  # md5 to compare with the live registry (query in docs/rules/README.md)"""
import os, sys, pathlib, hashlib
from rules_data import RULES, RULING_DATE
ROOT = pathlib.Path(__file__).resolve().parents[2]

def md(r):
    paths = "\n".join(f"- `{p}`" for p in r["paths"]) or "- (not in force)"
    return f"""# {r['title']}

`rule_id: {r['id']}` · status: **{r['status'] if os.environ.get('COURT_PHASE') == 'A' else r['status_after']}** · verdict: **{r['verdict']}** · ruling {r.get('ruling_date', RULING_DATE)} · next review {r['next_review']}{' · **needs David**' if r['needs_david'] else ''}

## Purpose (failure prevented)
{r['purpose']}

## Mechanism
{r['mechanism']}

Code paths:
{paths}

## The court

**GROWTH.** {r['growth']}

**RUIN.** {r['ruin']}

**STATISTICS.** {r['statistics']}

**INCENTIVES / GAMING.** {r['incentives']}

## Evidence
{r['evidence']}

## Ruling
**{r['verdict'].upper()}.** {r['ruling']}

Amendment: {r['amendment']}

| Growth cost | Ruin-risk reduction |
|---|---|
| {r['growth_cost']} | {r['ruin_reduction']} |

## Interactions
{r['interactions']}
"""

def q(s):
    return "null" if s is None else "'" + str(s).replace("'", "''") + "'"

def arr(a):
    return "array[" + ", ".join(q(x) for x in a) + "]::text[]" if a else "'{}'::text[]"

def seed(phase):
    rows = []
    for r in RULES:
        st = r["status"] if phase == "A" else r["status_after"]
        nr = r["next_review"] if r["next_review"][:2] == "20" else None
        rows.append("  (" + ", ".join([q(r["id"]), q(r["title"]), q(r["purpose"]), q(r["mechanism"]), arr(r["paths"]), q(st),
            q(r["verdict"]), q(r["ruling"] + " Amendment: " + r["amendment"]), q(r["growth_cost"]), q(r["ruin_reduction"]),
            q(r["statistics"]), q(r["incentives"]), q(r["interactions"]), "true" if r["needs_david"] else "false",
            q(f"docs/rules/{r['id']}.md"), q(r.get("ruling_date", RULING_DATE)) + "::date", (q(nr) + "::date") if nr else "null"]) + ")")
    cols = ("rule_id, title, purpose, mechanism, owner_paths, status, verdict, ruling_summary, growth_cost, "
            "ruin_risk_reduction, statistics_note, gaming_analysis, interactions, needs_david, ruling_file, ruling_date, next_review_date")
    return (f"insert into public.desk_rules ({cols}) values\n" + ",\n".join(rows) +
            "\non conflict (rule_id) do update set " + ", ".join(f"{c.strip()} = excluded.{c.strip()}" for c in cols.split(",")[1:]) +
            ", updated_at = now();\n")

def upsert_rules(ids):
    keep = set(ids)
    global RULES
    saved = RULES
    try:
        RULES = [r for r in saved if r["id"] in keep]
        assert len(RULES) == len(keep), "unknown rule id"
        return seed("B")
    finally:
        RULES = saved

def status_updates():
    out = []
    for r in RULES:
        if r["status"] != r["status_after"]:
            out.append(f"update public.desk_rules set status = {q(r['status_after'])}, updated_at = now() where rule_id = {q(r['id'])};")
    return "\n".join(out) + "\n"

def checksum(phase):
    # Matches: select md5(string_agg(rule_id||'|'||status||'|'||verdict||'|'||ruling_summary||'|'||mechanism||'|'||
    #   array_to_string(owner_paths, ',')||E'\n', '' order by rule_id collate "C")) from public.desk_rules;
    rows = sorted(RULES, key=lambda r: r["id"].encode())
    s = "".join("|".join([r["id"], r["status"] if phase == "A" else r["status_after"], r["verdict"],
                          r["ruling"] + " Amendment: " + r["amendment"], r["mechanism"], ",".join(r["paths"])]) + "\n"
                for r in rows)
    return hashlib.md5(s.encode()).hexdigest()

if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--upsert":
        print(upsert_rules(sys.argv[2].split(",")), end=""); sys.exit(0)
    if len(sys.argv) > 2 and sys.argv[1] == "--checksum":
        print(checksum(sys.argv[2])); sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == "--status-updates":
        print(status_updates(), end="")
    elif len(sys.argv) > 2 and sys.argv[1] == "--sql":
        print(seed(sys.argv[2]), end="")
    else:
        d = ROOT / "docs" / "rules"; d.mkdir(parents=True, exist_ok=True)
        for r in RULES:
            (d / f"{r['id']}.md").write_text(md(r))
        print(f"wrote {len(RULES)} rulings to {d}")
