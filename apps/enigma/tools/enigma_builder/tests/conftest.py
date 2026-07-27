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
