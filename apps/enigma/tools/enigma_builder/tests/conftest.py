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
