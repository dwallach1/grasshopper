#!/usr/bin/env python3
"""Verify the ThesisForge worker's live Supabase permissions safely."""

from __future__ import annotations

from psycopg.errors import InsufficientPrivilege

from database import connect


def main() -> None:
    conn = connect(require_remote=True)
    write_ok = False
    delete_denied = False
    try:
        role = conn.execute("select current_user").fetchone()[0]
        thesis_count = conn.execute("select count(*) from theses").fetchone()[0]
        conn.execute(
            "insert into dashboard_snapshots (id, generated_at, payload) "
            "values (?, now(), ?::jsonb)",
            ("worker-permission-test", "{}"),
        )
        conn.execute(
            "update dashboard_snapshots set payload=?::jsonb where id=?",
            ('{"verified":true}', "worker-permission-test"),
        )
        write_ok = True

        try:
            conn.execute(
                "delete from dashboard_snapshots where id=?",
                ("worker-permission-test",),
            )
        except InsufficientPrivilege:
            delete_denied = True

        # The test insert/update is always temporary, including on failure.
        conn.rollback()
    finally:
        conn.close()

    print(
        f"backend=postgres role={role} theses={thesis_count} "
        f"read_ok=true write_ok={str(write_ok).lower()} "
        f"delete_denied={str(delete_denied).lower()}"
    )
    if role != "thesisforge_worker" or not write_ok or not delete_denied:
        raise SystemExit("worker permission verification failed")


if __name__ == "__main__":
    main()
