"""ODDSBORNE session pm_notes go over steward-rpc (oddsborne_insert_note), not the pooler.

A failed note is logged and does not block exits. Dry-run writes nothing. The SQL function is
SECURITY INVOKER, validates its inputs, and is granted only to oddsborne_worker and service_role.
"""
from __future__ import annotations

import ast
import json
import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SESSIONS = [HERE / "oddsborne" / f for f in ("session_daily.py", "session_pm.py")]
SCHEMA = ROOT / "supabase" / "schemas" / "72_oddsborne_insert_note.sql"
EDGE = ROOT / "supabase" / "functions" / "steward-rpc" / "index.ts"

_spec = importlib.util.spec_from_file_location("pm_session_notes", HERE / "oddsborne" / "pm_session_notes.py")
NS = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(NS)


class _Rpc:
    def __init__(self, steps):
        self.steps = list(steps)
        self.calls = []

    def __call__(self, fn, args, idempotent=False):
        self.calls.append((fn, args, idempotent))
        nxt = self.steps.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def _load(path: Path, name: str):
    text = path.read_text()
    fn = next(n for n in ast.parse(text).body if isinstance(n, ast.FunctionDef) and n.name == name)
    g = {"print": lambda *a, **k: None}
    exec(compile(ast.Module([fn], []), str(path), "exec"), g)
    return g[name]


class NoteArgsTests(unittest.TestCase):
    def test_scan_and_skip_payloads(self):
        scan = NS.note_args(thesis_id="weather_same_day_high", note_type="scan", title="Morning scan",
                            body="cash=1", decision="hold", meta={"session": "am", "at": datetime(2026, 10, 16, tzinfo=timezone.utc)})
        self.assertEqual(scan["decision"], "hold")
        self.assertEqual(scan["meta"]["at"], "2026-10-16 00:00:00+00:00")
        skip = NS.note_args(thesis_id="sports_devig_maker_edge", note_type="skip", title="Morning skips",
                            body="", decision="skip", meta={})
        self.assertEqual(skip["body"], "")
        self.assertNotIn("decision", NS.note_args(note_type="scan", title="Afternoon scan", body="x", decision=None, meta={}))

    def test_rejects_bad_fields_before_any_call(self):
        with self.assertRaises(ValueError):
            NS.note_args(note_type="nope", title="t", body="b")
        with self.assertRaises(ValueError):
            NS.note_args(note_type="scan", title="  ", body="b")
        with self.assertRaises(ValueError):
            NS.note_args(note_type="scan", title="t", body="b", decision="maybe")
        with self.assertRaises(ValueError):
            NS.note_args(note_type="scan", title="t", body="b", meta=["not", "an", "object"])
        with self.assertRaises(ValueError):
            NS.note_args(note_type="other", title="t", body="b", my_probability=1.5)
        with self.assertRaises(ValueError):
            NS.note_args(note_type="other", title="t", body="b", market_id="not-a-uuid")


class ThesisTaggingTests(unittest.TestCase):
    """GRASSHOPPER 2026-10-17: skip notes carry the skipped bet's thesis, one note per thesis;
    the untagged whole-scan summary note never sets decision. Every split skip note sets decision='skip'
    (AM and PM) so the pm_notes trigger scores it per market from meta.comps_top."""

    WX = ["Chicago Midway 2026-10-17: SKIP — mode bucket priced", "NYC 2026-10-17: SKIP — no edge"]
    SPORTS = ["SPORT aec-nfl-dal-gb-2026-10-18: COVERED — held", "SPORT aec-mlb-tb-cle: SKIP — post-fee < 0"]

    def _groups(self, wx, sports):
        return [(NS.THESIS_WX, wx, {"weather": len(wx)}), (NS.THESIS_SPORTS, sports, {"comps_top": len(sports)})]

    def test_weather_only_skip_note_gets_weather_thesis(self):
        # Regression: 7c47deb6 (10/16) and 9675de0a (10/17) were weather-only but tagged sports.
        notes = NS.skip_note_args(title="Morning skips AM 2026-10-17", groups=self._groups(self.WX, []))
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["thesis_id"], "weather_same_day_high")
        self.assertEqual(notes[0]["title"], "Morning skips AM 2026-10-17")
        self.assertEqual(notes[0]["note_type"], "skip")
        self.assertEqual(notes[0]["decision"], "skip")
        self.assertNotIn("SPORT", notes[0]["body"])

    def test_sports_only_skip_note_gets_sports_thesis(self):
        notes = NS.skip_note_args(title="Afternoon skips PM 2026-10-17", groups=self._groups([], self.SPORTS))
        self.assertEqual([n["thesis_id"] for n in notes], ["sports_devig_maker_edge"])
        self.assertEqual(notes[0]["decision"], "skip")  # afternoon skip notes used to have no decision

    def test_mixed_skips_split_one_note_per_thesis(self):
        notes = NS.skip_note_args(title="Morning skips AM 2026-10-17",
                                  meta={"session": "20261017_am"}, groups=self._groups(self.WX, self.SPORTS))
        self.assertEqual([n["thesis_id"] for n in notes], ["weather_same_day_high", "sports_devig_maker_edge"])
        self.assertEqual([n["title"] for n in notes],
                         ["Morning skips AM 2026-10-17 (weather)", "Morning skips AM 2026-10-17 (sports)"])
        wx, sp = notes
        self.assertEqual(wx["decision"], "skip")
        self.assertEqual(sp["decision"], "skip")
        self.assertTrue(all(line in wx["body"] for line in self.WX))
        self.assertNotIn("SPORT", wx["body"])
        self.assertTrue(all(line in sp["body"] for line in self.SPORTS))
        self.assertNotIn("Midway", sp["body"])
        self.assertEqual(wx["meta"], {"session": "20261017_am", "weather": 2, "thesis_id": "weather_same_day_high"})
        self.assertEqual(sp["meta"]["comps_top"], 2)
        self.assertNotIn("weather", sp["meta"])

    def test_skip_notes_always_decide_skip(self):
        # There is no decision argument: a skip note is always decision='skip', whatever meta says.
        with self.assertRaises(TypeError):
            NS.skip_note_args(title="t", decision=None, groups=self._groups(self.WX, []))
        for wx, sp in ((self.WX, []), ([], self.SPORTS), (self.WX, self.SPORTS)):
            for note in NS.skip_note_args(title="t", meta={"decision": "ignored-meta"}, groups=self._groups(wx, sp)):
                self.assertEqual(note["decision"], "skip")

    def test_split_skip_note_keeps_decision_skip_and_market_meta_in_trigger_shape(self):
        # Comps as session_daily/session_pm build them (comp = {...}); sports_skip_meta = {"comps_top": comps_top[:10]}.
        comps = [
            {"sport": "nfl", "market": "aec-nfl-dal-gb-2026-10-18", "outcome": "yes", "fair": 0.48839,
             "bid": 0.4725, "ask": 0.475, "post_fee_maker": 0.013, "decision": "COVERED", "why": "already held"},
            {"sport": "mlb", "market": "aec-mlb-tb-cle-2026-10-17", "outcome": "yes", "fair": 0.512992,
             "bid": 0.515, "ask": 0.52, "post_fee_maker": -0.004, "decision": "SKIP", "why": "post-fee maker < bar"},
            {"sport": "nfl", "market": "aec-nfl-was-sf-2026-10-19", "outcome": "yes", "fair": 0.21,
             "bid": 0.22, "ask": 0.225, "post_fee_maker": -0.012, "decision": "SKIP", "why": "no edge",
             "at": datetime(2026, 10, 17, 14, tzinfo=timezone.utc)},
            {"sport": "mlb", "market": "aec-mlb-nyy-bos-2026-10-17", "outcome": "yes", "fair": None,
             "bid": None, "ask": None, "post_fee_maker": None, "decision": "SKIP", "why": "missing fair/bbo"},
        ]
        wx_meta = {"weather": [{"city": "NYC", "day": "2026-10-17", "decision": "SKIP", "reason": "x"}]}
        notes = NS.skip_note_args(
            title="Afternoon skips PM 2026-10-17", meta={"session": "20261017_pm"},
            groups=[(NS.THESIS_WX, ["NYC 2026-10-17: SKIP — x"], wx_meta),
                    (NS.THESIS_SPORTS, [f"SPORT {c['market']}: {c['decision']}" for c in comps], {"comps_top": comps})])
        wx, sp = notes
        self.assertEqual((sp["thesis_id"], sp["note_type"], sp["decision"]), (NS.THESIS_SPORTS, "skip", "skip"))
        self.assertEqual(wx["decision"], "skip")
        # Same extraction as private.pm_note_scoreable_decisions on meta.comps / meta.comps_top:
        # lower(decision)='skip'; instrument = market_slug|market; book_price = bid in (0,1]; prob = fair in [0,1].
        def scored(meta):
            out = []
            for e in (meta.get("comps") or []) + (meta.get("comps_top") or []):
                if str(e.get("decision") or "").lower() != "skip":
                    continue
                inst = e.get("market_slug") or e.get("market")
                try:
                    bid, fair = float(e.get("bid")), float(e.get("fair"))
                except (TypeError, ValueError):
                    continue
                if inst and 0 < bid <= 1 and 0 <= fair <= 1:
                    out.append((inst, "yes", bid, fair))
            return sorted(out)
        payload = json.loads(json.dumps(sp))  # what steward-rpc actually sends
        self.assertEqual(payload["meta"]["comps_top"][2]["at"], "2026-10-17 14:00:00+00:00")
        self.assertEqual(scored(payload["meta"]), [
            ("aec-mlb-tb-cle-2026-10-17", "yes", 0.515, 0.512992),
            ("aec-nfl-was-sf-2026-10-19", "yes", 0.22, 0.21),
        ])
        # The weather note's meta carries no comps/candidates and no market key, so the trigger writes
        # nothing for it (no scored row, no unscoreable placeholder); weather passes go via weather_pass_log.
        self.assertEqual(scored(wx["meta"]), [])
        self.assertFalse({"comps", "comps_top", "candidates", "market_id", "market_slug", "slug", "instrument"} & set(wx["meta"]))

    def test_sessions_build_comps_top_in_trigger_shape(self):
        for path in SESSIONS:
            text = path.read_text()
            comp = text.split("comp = {", 1)[1].split("}\n", 1)[0]
            for key in ('"market": ms', '"fair": f_side', '"bid": mk_px', '"decision": decision, "why": why'):
                self.assertIn(key, comp, path.name)
            notes = text.split("# 9) Write pm_notes", 1)[1].split("# 10) Artifacts", 1)[0]
            self.assertIn('sports_skip_meta = {"comps_top": comps_top[:10]}', notes, path.name)
            skip = notes.split("skip_args = skip_note_args(", 1)[1].split("\n        )", 1)[0]
            self.assertNotIn("decision", skip, path.name)  # the helper forces decision='skip'

    def test_no_skips_writes_no_skip_note(self):
        self.assertEqual(NS.skip_note_args(title="t", groups=self._groups([], [])), [])

    def test_skip_group_without_thesis_is_rejected(self):
        with self.assertRaises(ValueError):
            NS.skip_note_args(title="t", groups=[(None, ["x"], {})])
        with self.assertRaises(ValueError):
            NS.skip_note_args(title="t", groups=[(NS.THESIS_WX, ["a"], {}), (NS.THESIS_WX, ["b"], {})])

    def test_summary_note_is_untagged_and_has_no_decision(self):
        # Regression: 951904de (10/17 session-wide scan) was tagged weather_same_day_high.
        scan = NS.summary_note_args(note_type="scan", title="Morning full-book + weather scan 2026-10-17",
                                    body="cash=1", meta={"session": "20261017_am"})
        self.assertNotIn("thesis_id", scan)
        self.assertNotIn("decision", scan)
        self.assertEqual(scan["note_type"], "scan")

    def test_sessions_never_tag_or_decide_the_scan_note(self):
        for path in SESSIONS:
            notes = path.read_text().split("# 9) Write pm_notes", 1)[1].split("# 10) Artifacts", 1)[0]
            self.assertNotIn("thesis_id=", notes, path.name)  # no hand-picked thesis on any session note
            self.assertNotIn("note_args(", notes.replace("skip_note_args(", "").replace("summary_note_args(", ""), path.name)
            scan = notes.split("scan_args = summary_note_args(", 1)[1].split(")", 1)[0]
            self.assertNotIn("decision", scan, path.name)
            self.assertIn("skip_args = skip_note_args(", notes, path.name)
            self.assertIn("groups=[(THESIS_WX, wx_skip_bits, wx_skip_meta), (THESIS_SPORTS, sports_skip_bits, sports_skip_meta)]",
                          notes, path.name)
            self.assertNotIn("SPORT", notes.split("wx_skip_bits = ", 1)[1].split("\n", 1)[0], path.name)
            text = path.read_text()
            self.assertIn(f'THESIS_WX = "{NS.THESIS_WX}"', text, path.name)
            self.assertIn(f'THESIS_SPORTS = "{NS.THESIS_SPORTS}"', text, path.name)


class WritePathTests(unittest.TestCase):
    def test_writes_one_skip_note_per_thesis(self):
        rpc = _Rpc([
            {"pm_note_id": "scan-id"},
            {"pm_note_id": "wx-id"},
            {"pm_note_id": "sports-id"},
            {"heartbeat_at": "2026-10-17T16:00:00+00:00"},
        ])
        out = NS.write_session_notes(rpc, {"note_type": "scan"},
                                     [{"thesis_id": NS.THESIS_WX}, {"thesis_id": NS.THESIS_SPORTS}])
        self.assertEqual(out["skip"], ["wx-id", "sports-id"])
        self.assertEqual([c[1].get("thesis_id") for c in rpc.calls[:3]], [None, NS.THESIS_WX, NS.THESIS_SPORTS])
        self.assertEqual(rpc.calls[-1][0], "oddsborne_touch_heartbeat")

    def test_empty_skip_list_writes_scan_and_heartbeat_only(self):
        rpc = _Rpc([{"pm_note_id": "scan-id"}, {"heartbeat_at": "2026-10-17T16:00:00+00:00"}])
        out = NS.write_session_notes(rpc, {"note_type": "scan"}, [])
        self.assertEqual(out["skip"], [])
        self.assertEqual([c[0] for c in rpc.calls], ["oddsborne_insert_note", "oddsborne_touch_heartbeat"])

    def test_second_skip_failure_keeps_committed_ids(self):
        rpc = _Rpc([{"pm_note_id": "scan-id"}, {"pm_note_id": "wx-id"}, RuntimeError("down")])
        with self.assertRaises(NS.NotesWriteError) as caught:
            NS.write_session_notes(rpc, {}, [{}, {}])
        self.assertEqual(caught.exception.stage, "skip")
        self.assertEqual(caught.exception.partial["scan"], "scan-id")
        self.assertEqual(caught.exception.partial["skip"], ["wx-id"])
        self.assertEqual(len(rpc.calls), 3)

    def test_writes_scan_then_skip_then_heartbeat_once_each(self):
        rpc = _Rpc([
            {"pm_note_id": "scan-id"},
            {"pm_note_id": "skip-id"},
            {"heartbeat_at": "2026-10-16T16:00:00+00:00"},
        ])
        out = NS.write_session_notes(rpc, {"note_type": "scan"}, {"note_type": "skip"})
        self.assertEqual(out, {"scan": "scan-id", "skip": "skip-id", "heartbeat": "2026-10-16T16:00:00+00:00"})
        self.assertEqual([c[0] for c in rpc.calls], ["oddsborne_insert_note", "oddsborne_insert_note", "oddsborne_touch_heartbeat"])
        self.assertTrue(all(c[2] is False for c in rpc.calls))

    def test_scan_failure_does_not_write_the_skip(self):
        rpc = _Rpc([RuntimeError("steward-rpc down")])
        with self.assertRaises(NS.NotesWriteError) as caught:
            NS.write_session_notes(rpc, {"note_type": "scan"}, {"note_type": "skip"})
        self.assertEqual(caught.exception.stage, "scan")
        self.assertIsNone(caught.exception.partial["scan"])
        self.assertEqual([c[0] for c in rpc.calls], ["oddsborne_insert_note"])

    def test_skip_failure_keeps_the_scan_id(self):
        rpc = _Rpc([{"pm_note_id": "scan-id"}, RuntimeError("skip refused")])
        with self.assertRaises(NS.NotesWriteError) as caught:
            NS.write_session_notes(rpc, {"note_type": "scan"}, {"note_type": "skip"})
        self.assertEqual(caught.exception.stage, "skip")
        self.assertEqual(caught.exception.partial["scan"], "scan-id")
        self.assertIsNone(caught.exception.partial["skip"])
        self.assertEqual(len(rpc.calls), 2)

    def test_heartbeat_failure_keeps_both_note_ids(self):
        rpc = _Rpc([{"pm_note_id": "scan-id"}, {"pm_note_id": "skip-id"}, RuntimeError("hb down")])
        with self.assertRaises(NS.NotesWriteError) as caught:
            NS.write_session_notes(rpc, {}, {})
        self.assertEqual(caught.exception.stage, "heartbeat")
        self.assertEqual(caught.exception.partial["scan"], "scan-id")
        self.assertEqual(caught.exception.partial["skip"], "skip-id")
        self.assertIsNone(caught.exception.partial["heartbeat"])

    def test_missing_id_is_a_failure(self):
        rpc = _Rpc([{"ok": True}])
        with self.assertRaises(NS.NotesWriteError):
            NS.write_session_notes(rpc, {}, {})


class SessionWiringTests(unittest.TestCase):
    def test_sessions_write_notes_over_https_after_exits(self):
        for path in SESSIONS:
            text = path.read_text()
            main = text.split("def main():", 1)[1]
            notes = main.split("# 9) Write pm_notes", 1)[1].split("# 10) Artifacts", 1)[0]
            self.assertNotIn("connect()", text, path.name)
            self.assertNotIn("cur.execute", text, path.name)
            self.assertNotIn("INSERT INTO public.pm_notes", text, path.name)
            self.assertNotIn("UPDATE public.pm_positions", text, path.name)
            self.assertLess(main.index("check_exits("), main.index("write_session_notes("), path.name)
            self.assertLess(notes.index("raise _DryRunNoWrite()"), notes.index("write_session_notes(make_rpc()"), path.name)
            self.assertIn("write_session_notes(make_rpc(), scan_args, skip_args)", notes, path.name)
            self.assertIn("ERROR pm_notes write failed (exits not blocked)", notes, path.name)
            self.assertNotIn("sys.exit", notes, path.name)
            self.assertIn('blockers.append(f"ERROR pm_notes steward-rpc failed', notes, path.name)
        daily = (HERE / "oddsborne" / "session_daily.py").read_text()
        pm = (HERE / "oddsborne" / "session_pm.py").read_text()
        self.assertNotIn("scan_decision", daily)
        self.assertNotIn("scan_decision", pm)
        for text in (daily, pm):
            self.assertIn("skip_args = skip_note_args(", text)  # decision='skip' is set by the helper
        self.assertIn('"$here/oddsborne/pm_session_notes.py:$box/oddsborne/pm_session_notes.py"',
                      (HERE / "sync_box.sh").read_text())

    def test_missing_slug_lookup_failure_does_not_raise(self):
        def boom(fn, args, idempotent=False):
            raise RuntimeError("down")

        for path in SESSIONS:
            lookup = _load(path, "slug_for_lot")
            self.assertEqual(lookup({"id": "lot-1", "slug": "already"}, boom), "already")
            self.assertIsNone(lookup({"id": "lot-1"}, boom))
            self.assertIn("oddsborne_position_get", path.read_text())


class ScoringTriggerContractTests(unittest.TestCase):
    """Pin the pm_notes scoring trigger contract the split skip notes rely on (latest migrations)."""

    def _latest(self, signature):
        files = [f for f in sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
                 if f"create or replace function {signature}" in f.read_text()]
        self.assertTrue(files, signature)
        text = files[-1].read_text()
        block = text[text.index(f"create or replace function {signature}"):]
        return block[:block.index("\n$")]

    def test_trigger_scores_only_skip_or_enter_notes(self):
        trig = self._latest("private.decision_candidate_from_pm_note()")
        self.assertIn("new.decision not in ('enter', 'skip')", trig)
        self.assertIn("from private.pm_note_scoreable_decisions(new) d", trig)

    def test_scoreable_decisions_reads_comps_top_market_bid_fair(self):
        fn = self._latest("private.pm_note_scoreable_decisions(p_note public.pm_notes)")
        for needle in ("p_note.meta->'comps_top'", "coalesce(elem->>'market_slug', elem->>'market')",
                       "private.try_numeric(elem->>'bid')", "private.try_numeric(elem->>'fair')",
                       "lower(coalesce(elem->>'decision', '')) = 'skip'"):
            self.assertIn(needle, fn)


class SqlContractTests(unittest.TestCase):
    def test_function_is_invoker_validated_and_worker_only(self):
        sql = SCHEMA.read_text()
        mig = sorted((ROOT / "supabase" / "migrations").glob("*_oddsborne_insert_note.sql"))
        self.assertEqual(len(mig), 1)
        self.assertEqual(mig[0].read_text(), sql)
        block = sql[sql.index("create or replace function public.oddsborne_insert_note(p jsonb)"):]
        block = block[:block.index("$$;")]
        self.assertIn("security invoker", block)
        self.assertNotIn("security definer", block.lower())
        self.assertNotIn("execute ", block.lower())
        for needle in ("refusal:input: note_type", "refusal:input: meta must be a JSON object",
                       "refusal:input: decision", "insert into public.pm_notes"):
            self.assertIn(needle, block)
        self.assertIn("revoke all on function public.oddsborne_insert_note(jsonb) from public, anon, authenticated;", sql)
        self.assertIn("grant execute on function public.oddsborne_insert_note(jsonb) to oddsborne_worker, service_role;", sql)
        self.assertNotIn("authenticated,", sql.split("grant execute", 1)[1])
        edge = EDGE.read_text()
        allow = edge[edge.index("oddsborne_worker: new Set(["):]
        allow = allow[:allow.index("])")]
        self.assertIn("'oddsborne_insert_note'", allow)
        for name in NS.NOTE_TYPES:
            self.assertIn(f"'{name}'", sql)


if __name__ == "__main__":
    unittest.main()
