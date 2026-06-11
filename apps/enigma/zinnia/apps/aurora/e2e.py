#!/usr/bin/env python3
"""End-to-end test runner for the Aurora app (data workspace + relay chat).

Spins up the toto backend (Docker), seeds a user, and runs the Playwright suite
against the built bundle — the stubbed *smoke* tier plus, when a backend is
available, the *live* tier (reachability, login, authenticated UI, relay-chat
round-trip). CI/CD friendly: non-zero exit on failure.

Usage (from anywhere):
    python apps/aurora/e2e.py                 # Docker backend → live + smoke
    python apps/aurora/e2e.py --no-backend    # stubbed smoke tier only
    python apps/aurora/e2e.py --server URL    # use an already-running backend
    E2E_SERVER=http://localhost:8000 python apps/aurora/e2e.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "scripts"))

from e2e_runner import AppConfig, run  # noqa: E402

CONFIG = AppConfig(
    name="aurora",
    app_dir=HERE,
    seed_user=os.environ.get("E2E_USER", "e2e"),
    seed_pass=os.environ.get("E2E_PASS", "e2epass-123"),
)

if __name__ == "__main__":
    raise SystemExit(run(CONFIG))
