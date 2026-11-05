"""Enigma's Android signing contract, tested against Rutile's checker.

The module under test is the repo's (tools/android/android_signing); the tests
live here because what they assert is ENIGMA's: that its Gradle signing block,
its pin file and its .gitignore still say what the checker expects.

    python3 -m pytest scripts/android_signing/tests
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "tools" / "android" / "android_signing"))


@pytest.fixture(autouse=True)
def isolate_signing_config(tmp_path_factory, monkeypatch):
    """Point HOME and XDG_CONFIG_HOME at a temp directory for every test.

    signing.py resolves ~/.config/enigma-builder/signing.properties through
    them, and a test must never read — or, in the keystore-creation tests,
    write beside — the developer's real signing credentials. Autouse and
    unconditional on purpose.
    """
    home = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    # And the signing env vars themselves — an exported ENIGMA_KEY_PASSWORD
    # on the developer's machine must not leak into credential-resolution
    # tests as a surprise fourth source.
    for var in ("ENIGMA_KEYSTORE_FILE", "ENIGMA_KEYSTORE_PASSWORD",
                "ENIGMA_KEY_ALIAS", "ENIGMA_KEY_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    return home
