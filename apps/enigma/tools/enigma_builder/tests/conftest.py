"""Make the flat tool modules importable from tests/, and host shared fixtures.

Run headless:  QT_QPA_PLATFORM=offscreen venv/bin/python -m pytest tests/
"""

from __future__ import annotations

import copy
import os
import sys
from pathlib import Path

import pytest
import yaml

TOOL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_DIR))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import paths  # noqa: E402  (path must be set up first)


@pytest.fixture(scope="session")
def app(tmp_path_factory):
    """One QApplication for the session — QThread needs one to run at all.

    QSettings is redirected into a temp directory first: the window persists
    the theme, the repo root and the output folder, and a test run must not
    leave those on the developer's real settings.
    """
    from PyQt6.QtCore import QSettings
    from PyQt6.QtWidgets import QApplication

    settings_dir = tmp_path_factory.mktemp("qsettings")
    QSettings.setDefaultFormat(QSettings.Format.IniFormat)
    QSettings.setPath(
        QSettings.Format.IniFormat, QSettings.Scope.UserScope, str(settings_dir)
    )

    instance = QApplication.instance() or QApplication([])
    instance.setApplicationName(paths.APP_NAME)
    instance.setOrganizationName(paths.ORG_NAME)
    instance.setStyle("Fusion")
    return instance


@pytest.fixture(autouse=True)
def isolate_app_data(tmp_path_factory, monkeypatch):
    """Point HOME and XDG_DATA_HOME at a temp directory for every test.

    The Builder can delete the built app's local data — vaults, chat history,
    transferred files. A test that exercises that path must not be able to see
    the real ~/.local/share, and it is not enough to override XDG_DATA_HOME
    alone: the tool deliberately also checks ~/.local/share, because a
    sandboxed editor exports an XDG_DATA_HOME that is not the app's. Both are
    redirected here so no test can reach real user data by any route.

    This is autouse and unconditional on purpose. It exists because a test that
    only redirected XDG_DATA_HOME once deleted a real 320 MB app-data
    directory.
    """
    home = tmp_path_factory.mktemp("home")
    (home / ".local" / "share").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_DATA_HOME", str(home / ".local" / "share"))
    # XDG_CONFIG_HOME too: signing.py resolves ~/.config/enigma-builder/
    # signing.properties through it, and a test must never read the
    # developer's real signing credentials (same class of bug the HOME
    # redirect exists for).
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    # And the signing env vars themselves — an exported ENIGMA_KEY_PASSWORD
    # on the developer's machine must not leak into credential-resolution
    # tests as a surprise fourth source.
    for var in ("ENIGMA_KEYSTORE_FILE", "ENIGMA_KEYSTORE_PASSWORD",
                "ENIGMA_KEY_ALIAS", "ENIGMA_KEY_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    return home


@pytest.fixture(autouse=True)
def repo_files_untouched():
    """Put back anything a test writes into the checkout.

    Several tests drive code paths that legitimately write tauri.conf.json and
    the icon trees. A test that stops before the Builder's own restore step —
    or that fails part-way — would otherwise leave the working tree modified,
    and the damage is invisible until someone reads `git status`. This makes
    that structurally impossible rather than a thing every test must remember.
    """
    import icons as icons_mod
    import identity as identity_mod

    conf = identity_mod.read_conf_text()
    icon_files = icons_mod.snapshot()
    try:
        yield
    finally:
        if conf and identity_mod.read_conf_text() != conf:
            identity_mod.write_conf_text(conf)
        icons_mod.restore(icon_files)


@pytest.fixture(autouse=True)
def build_artifacts_untouched():
    """Fail loudly if a test writes into or deletes from the real deploy/dist.

    Those are the user's built installers — tens of MB each, kept deliberately
    so old releases can be archived, and NOT reproducible from the checkout
    once gone. A test that patches ``paths.DEPLOY_DIST`` too late (the window
    fixture rebinds every path global) would otherwise read the real folder and
    have its own cleanup delete real packages. That happened once; this makes
    it fail here instead of on someone's disk.

    Detect rather than restore: at ~27 MB a package, snapshotting content for
    every test would cost more than the whole suite.
    """
    def listing() -> dict[str, int]:
        directory = paths.DEPLOY_DIST
        if not directory.is_dir():
            return {}
        return {
            p.name: p.stat().st_size for p in directory.iterdir() if p.is_file()
        }

    before = listing()
    yield
    after = listing()
    if before != after:
        removed = sorted(set(before) - set(after))
        added = sorted(set(after) - set(before))
        changed = sorted(
            name for name in set(before) & set(after) if before[name] != after[name]
        )
        pytest.fail(
            f"test touched the real {paths.DEPLOY_DIST}: "
            f"removed={removed} added={added} resized={changed}. "
            f"Patch paths.DEPLOY_DIST to a tmp_path, in a fixture that depends "
            f"on `window` so set_repo_root cannot undo it."
        )


@pytest.fixture
def window(app):
    from window import MainWindow

    win = MainWindow()
    # The expert toggle shows a one-time modal, which would block a headless run.
    win.expert_tab._warned = True
    yield win
    win.close()


@pytest.fixture(scope="session")
def canonical() -> dict:
    """The repo's canonical build config — the schema every test measures against."""
    return yaml.safe_load(paths.CANONICAL_YAML.read_text(encoding="utf-8"))


@pytest.fixture
def cfg(canonical: dict) -> dict:
    """A fresh, valid config each test can mutate freely."""
    return copy.deepcopy(canonical)
