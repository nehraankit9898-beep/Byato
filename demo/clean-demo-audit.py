#!/usr/bin/env python3
"""
Clean the demo database of security events left behind by earlier test runs.

The demo recording signs in successfully, so a stale "FAILED LOGIN" /
"MFA CHALLENGE FAILED" row in the platform Security Centre would be
misleading on screen. Only the failed-attempt rows are removed; every
successful sign-in the recording makes is still logged live in AuditLog.

    python3 demo/clean-demo-audit.py [path/to/demo.db]
"""
import os
import sqlite3
import sys

DEFAULT_DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "db", "demo.db")
db_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB

if not os.path.exists(db_path):
    print(f"no demo database at {db_path} — nothing to clean")
    sys.exit(0)

conn = sqlite3.connect(db_path, timeout=15)
try:
    cur = conn.cursor()
    before_events = cur.execute("SELECT COUNT(*) FROM SecurityEvent").fetchone()[0]
    before_failed = cur.execute(
        "SELECT COUNT(*) FROM AuditLog WHERE action = 'LOGIN_FAILED'"
    ).fetchone()[0]
    cur.execute("DELETE FROM SecurityEvent")
    cur.execute("DELETE FROM AuditLog WHERE action = 'LOGIN_FAILED'")
    conn.commit()
    print(
        f"cleaned {db_path}: removed {before_events} security event(s) and "
        f"{before_failed} failed-login audit row/rows (successful logins kept)"
    )
finally:
    conn.close()
