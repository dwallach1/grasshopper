"""ODDSBORNE session pm_notes go over steward-rpc (oddsborne_insert_note), not the pooler.

A failed note is logged and does not block exits. Dry-run writes nothing. The SQL function is
SECURITY INVOKER, validates its inputs, and is granted only to oddsborne_worker and service_role.
"""
from __future__ import annotations

import ast
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


class WritePathTests(unittest.TestCase):
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
        self.assertIn('decision="skip"', daily.split("# 9) Write pm_notes", 1)[1])
        self.assertIn("decision=scan_decision", daily)
        skip = pm.split("title=f\"Afternoon skips PM", 1)[1].split("note_scan", 1)[0]
        self.assertIn("decision=None", skip)
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
