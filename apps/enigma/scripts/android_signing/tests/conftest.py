"""Make signing.py importable from tests/, and keep tests off real credentials.

    python3 -m pytest scripts/android_signing/tests
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


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
