"""Shared e2e orchestration for the edge apps (Enigma, Aurora).

Each app's ``e2e.py`` is a thin wrapper that calls :func:`run` with its config.
The runner:

  1. resolves a backend — an already-running server (``E2E_SERVER``), a Docker
     Compose stack it brings up, or none (smoke-only);
  2. waits until the toto telegraph health endpoint is reachable;
  3. seeds a test user (and a chat room) via ``manage.py`` in the web container;
  4. runs the app's Playwright suite (``npm run test:e2e``) — the **smoke** tier
     always runs (it stubs the backend), and the **live** tier runs only when a
     server is available (the specs self-skip on missing ``E2E_SERVER``);
  5. tears the stack down (unless ``--keep-up``).

Stdlib only — no Python Playwright needed; it drives the existing Node runner and
browsers. Designed to be CI/CD friendly: non-zero exit on any failure.

The Docker-backend path lives outside this repository: point ``TOTO_ROOT`` at a
toto monorepo checkout (default: sibling ``../toto``); ``E2E_COMPOSE`` overrides
the compose file. Without a backend, the smoke tier still runs (``--no-backend``).

Encryption note: browser-mode chat is plaintext (MLS is a desktop/Tauri-only
feature), so the live tier verifies reachability + relay-WS message delivery
end-to-end. MLS ciphertext itself is covered by Rust tests in rotor-core and the
Rakotis envelope state machine.
"""
from __future__ import annotations

import argparse
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

# The compose stack serves over a self-signed cert (nginx → https); accept it.
_INSECURE_SSL = ssl.create_default_context()
_INSECURE_SSL.check_hostname = False
_INSECURE_SSL.verify_mode = ssl.CERT_NONE

EDGE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))   # the npm workspace
# The live tier needs a toto monorepo checkout (Django backend + compose stack).
# Set TOTO_ROOT to its path; defaults to a sibling ../toto checkout.
REPO_ROOT = os.path.abspath(os.environ.get("TOTO_ROOT") or os.path.join(EDGE_ROOT, "..", "toto"))
DEFAULT_COMPOSE = os.path.join(REPO_ROOT, ".compose", "portal", "docker-compose.yaml")


@dataclass
class AppConfig:
    name: str                     # workspace name, e.g. "enigma"
    app_dir: str                  # absolute path to apps/<name>
    docker_server: str = "https://localhost"      # host URL for the compose stack (nginx → https)
    web_service: str = "web_portal"               # compose service running Django
    seed_user: str = "e2e"
    seed_pass: str = "e2epass-123"
    seed_room: str = "general"    # telegraph channel slug seeded for the relay round-trip
    health_path: str = "/telegraph/api/health/"
    extra_env: dict = field(default_factory=dict)


def _log(msg: str) -> None:
    print(f"[e2e:{msg}]" if msg.startswith(" ") else f"[e2e] {msg}", flush=True)


def _run(cmd: list[str], cwd: str | None = None, env: dict | None = None, check: bool = True) -> int:
    _log(f"$ {' '.join(cmd)}")
    full_env = {**os.environ, **(env or {})}
    proc = subprocess.run(cmd, cwd=cwd, env=full_env)
    if check and proc.returncode != 0:
        raise SystemExit(f"[e2e] command failed ({proc.returncode}): {' '.join(cmd)}")
    return proc.returncode


def _wait_for_health(server: str, path: str, timeout: int = 180) -> bool:
    url = server.rstrip("/") + path
    _log(f"waiting for backend health at {url} (≤{timeout}s)…")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5, context=_INSECURE_SSL) as resp:
                if resp.status == 200:
                    _log("backend is reachable ✓")
                    return True
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(3)
    _log("backend did not become reachable in time ✗")
    return False


def _compose(compose_file: str, *args: str) -> list[str]:
    return ["docker", "compose", "-f", compose_file, *args]


def _seed(cfg: AppConfig, compose_file: str) -> None:
    """Seed the test user, a telegraph channel, and an active membership.

    The relay-chat WebSocket requires an active TelegraphMember (a Person linked to
    the user), so we seed the full chain — User → Person → TelegraphMember — for a
    known room, which is what the live round-trip spec exercises.
    """
    _log(f"seeding test user '{cfg.seed_user}'…")
    _run(
        _compose(compose_file, "exec", "-T", cfg.web_service,
                 "python", "manage.py", "create_user", cfg.seed_user, cfg.seed_pass, "--admin", "true"),
        cwd=REPO_ROOT, check=False,
    )
    _log(f"seeding telegraph channel '{cfg.seed_room}' + active membership…")
    seed_py = (
        "from django.contrib.auth import get_user_model;"
        "from toto.people.models import Person;"
        "from toto.telegraph.models import TelegraphChannel, TelegraphMember;"
        f"u=get_user_model().objects.get(username='{cfg.seed_user}');"
        f"ch,_=TelegraphChannel.objects.get_or_create(slug='{cfg.seed_room}', defaults={{'name':'{cfg.seed_room.title()}'}});"
        "p,_=Person.objects.get_or_create(user=u, defaults={'display_name':'E2E Tester'});"
        "TelegraphMember.objects.get_or_create(channel=ch, person=p, defaults={'is_active':True});"
        "print('seeded', u.username, 'in', ch.slug)"
    )
    _run(
        _compose(compose_file, "exec", "-T", cfg.web_service, "python", "manage.py", "shell", "-c", seed_py),
        cwd=REPO_ROOT, check=False,
    )


def run(cfg: AppConfig, argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=f"e2e for {cfg.name}")
    parser.add_argument("--server", default=os.environ.get("E2E_SERVER"),
                        help="Use an already-running backend at this URL (skips Docker).")
    parser.add_argument("--compose", default=os.environ.get("E2E_COMPOSE", DEFAULT_COMPOSE),
                        help="docker compose file to bring the backend up with.")
    parser.add_argument("--no-backend", action="store_true",
                        help="Smoke tier only: don't start or require a backend.")
    parser.add_argument("--keep-up", action="store_true",
                        help="Leave the Docker stack running after the tests.")
    args = parser.parse_args(argv)

    started_docker = False
    server = args.server

    try:
        if args.no_backend:
            _log("no-backend mode: running the stubbed smoke tier only.")
            server = None
        elif server:
            _log(f"using existing backend at {server}")
            if not _wait_for_health(server, cfg.health_path):
                return 2
        else:
            _log(f"bringing up the backend via Docker: {args.compose}")
            # `up` builds the image on first run if missing, else reuses it (code is
            # bind-mounted, so a rebuild isn't needed for app changes).
            _run(_compose(args.compose, "up", "-d", "--wait"), cwd=REPO_ROOT, check=False)
            started_docker = True
            server = cfg.docker_server
            if not _wait_for_health(server, cfg.health_path):
                _log("dumping web container logs:")
                _run(_compose(args.compose, "logs", "--tail", "60", cfg.web_service), cwd=REPO_ROOT, check=False)
                return 2
            _seed(cfg, args.compose)

        # Run the Playwright suite. The live tier keys off E2E_SERVER; smoke always runs.
        env = dict(cfg.extra_env)
        if server:
            env["E2E_SERVER"] = server
            env["E2E_USER"] = os.environ.get("E2E_USER", cfg.seed_user)
            env["E2E_PASS"] = os.environ.get("E2E_PASS", cfg.seed_pass)
        _log(f"running Playwright suite for {cfg.name} "
             f"({'live + smoke' if server else 'smoke only'})…")
        rc = _run(["npm", "run", "test:e2e", "-w", cfg.name], cwd=EDGE_ROOT, env=env, check=False)
        return rc
    finally:
        if started_docker and not args.keep_up:
            _log("tearing down the Docker stack…")
            _run(_compose(args.compose, "down", "-v"), cwd=REPO_ROOT, check=False)
