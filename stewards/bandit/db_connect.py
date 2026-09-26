"""Connect as bandit_worker through the Supabase session pooler (IPv4).

The password comes from load_secrets (env BANDIT_WORKER_DB_PASSWORD first). Never printed.
Override the host with STEWARD_DB_HOST if the pooler region changes.
"""
from __future__ import annotations

import os

import psycopg

from load_secrets import require

REF = os.environ.get("SUPABASE_PROJECT_REF", "xqungxapqicdmboniezz")
HOST = os.environ.get("STEWARD_DB_HOST", "aws-0-us-west-2.pooler.supabase.com")


def connect() -> psycopg.Connection:
    password = require("BANDIT_WORKER_DB_PASSWORD")["BANDIT_WORKER_DB_PASSWORD"]
    return psycopg.connect(
        host=HOST,
        port=5432,
        user=f"bandit_worker.{REF}",
        password=password,
        dbname="postgres",
        sslmode="require",
    )
