"""The CLI surface: subcommand parsing, --repo in both positions, headlessness.

The two argparse hazards pinned here are real regressions waiting to happen:
a subparser sharing --repo with a plain default would CLOBBER the top-level
value with None, and making the subcommand required would break the bare
`enigma-builder` GUI launch.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

import paths
from main import parse_args

TOOL_DIR = Path(__file__).resolve().parents[1]


# ----- parsing --------------------------------------------------------------


def test_no_arguments_means_the_gui():
    args = parse_args([])
    assert args.command is None
    assert not args.check
    assert args.repo is None


def test_check_still_parses():
    args = parse_args(["--check"])
    assert args.check
    assert args.command is None


def test_repo_before_the_subcommand_survives():
    args = parse_args(["--repo", "/some/where", "signing", "android", "status"])
    assert args.repo == "/some/where"
    assert (args.command, args.platform, args.action) == ("signing", "android", "status")


def test_repo_after_the_subcommand_also_works():
    args = parse_args(["signing", "android", "status", "--repo", "/some/where"])
    assert args.repo == "/some/where"


def test_an_unknown_subcommand_is_a_usage_error():
    with pytest.raises(SystemExit) as excinfo:
        parse_args(["frobnicate"])
    assert excinfo.value.code == 2


def test_signing_without_an_action_is_a_usage_error():
    with pytest.raises(SystemExit):
        parse_args(["signing", "android"])


# ----- headless execution ---------------------------------------------------


def _run(args: list[str], **env_overrides) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    # No display: the command must never need one. QT_QPA_PLATFORM offscreen
    # covers the QCoreApplication that QSettings resolution creates.
    env.pop("DISPLAY", None)
    env["QT_QPA_PLATFORM"] = "offscreen"
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, str(TOOL_DIR / "main.py"), *args],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )


def test_signing_status_runs_headless():
    result = _run(["signing", "android", "status", "--repo", str(paths.REPO_ROOT)])
    # This checkout has no keystore.properties, so status reports unsigned
    # and exits 1 — the point here is that it ran, reported, and never needed
    # a window.
    assert "release" in result.stdout.lower()
    assert result.returncode in (0, 1)


def test_check_output_is_unchanged():
    result = _run(["--check", "--repo", str(paths.REPO_ROOT)])
    assert result.returncode == 0
    assert result.stdout.startswith("repository: ")
    assert "(--repo)" in result.stdout
    assert "all required files present" in result.stdout


def test_standalone_signing_cli_needs_no_qt():
    """The module scripts/build_android.sh will call must run under a bare
    python3 with no PyQt6 — assert it never imports Qt."""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, signing_cli; "
            "assert not any(m.startswith('PyQt') for m in sys.modules), "
            "'signing_cli must stay Qt-free'",
        ],
        capture_output=True,
        text=True,
        timeout=30,
        cwd=TOOL_DIR,
    )
    assert result.returncode == 0, result.stderr
