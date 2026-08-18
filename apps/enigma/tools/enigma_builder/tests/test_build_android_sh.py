"""scripts/build_android.sh must DELEGATE signing checks, not reimplement them.

The repo once carried three implementations of the signing rules (Gradle, bash,
Python). Bash's copy is gone — these tests keep it gone, because a rule that
exists twice is a rule that drifts.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

import paths
import signing

SCRIPT = paths.REPO_ROOT / "scripts" / "build_android.sh"
TOOL_DIR = Path(__file__).resolve().parents[1]


def script_text() -> str:
    if not SCRIPT.is_file():
        pytest.skip("scripts/build_android.sh not in this checkout")
    return SCRIPT.read_text(encoding="utf-8")


def test_the_script_calls_signing_cli():
    assert "signing_cli.py" in script_text()


def test_the_duplicate_preflight_is_really_gone():
    """prop_value/signing_preflight were bash's hand-rolled property parser and
    rule set. If either name comes back, the delegation got reverted."""
    text = script_text()
    assert "prop_value" not in text
    assert "signing_preflight" not in text
    assert "storePassword" not in text


def test_the_python_is_launched_with_a_scrubbed_environment():
    """The frozen PyInstaller Builder leaks LD_LIBRARY_PATH etc. into children;
    launching the system python3 inside that environment loads the bundle's
    libraries. The env -u scrub is load-bearing, not decorative."""
    text = script_text()
    assert "env -u LD_LIBRARY_PATH" in text
    assert "PYTHONHOME" in text and "PYTHONPATH" in text


def _cli(args: list[str]) -> subprocess.CompletedProcess:
    # Bare python3, exactly as the script invokes it — no venv, no Qt.
    return subprocess.run(
        ["python3", str(TOOL_DIR / "signing_cli.py"), *args],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "PYTHONPATH": ""},
        cwd=TOOL_DIR,
    )


def test_cli_exit_codes_match_inspect(tmp_path):
    """The script branches on signing_cli's exit code; it must agree with
    what inspect() would say about the same tree."""
    # Unconfigured tree -> non-zero, like inspect().signed_release == False.
    root = tmp_path / "gen" / "android"
    (root / "app").mkdir(parents=True)
    real = paths.ANDROID_GEN / "app" / "build.gradle.kts"
    (root / "app" / "build.gradle.kts").write_text(
        real.read_text(encoding="utf-8"), encoding="utf-8"
    )
    result = _cli(["status", "--gen", str(root)])
    assert result.returncode == 1
    assert not signing.inspect(root).signed_release
    assert "UNSIGNED" in result.stdout
