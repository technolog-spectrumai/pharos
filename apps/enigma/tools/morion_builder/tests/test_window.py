"""The window, offscreen: it builds, it wires the real worker API, and its
buttons call what they say. Skipped where PyQt6 is not installed."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

pytest.importorskip("PyQt6")
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

TOOL = Path(__file__).resolve().parents[1]
REPO = TOOL.parents[1]
sys.path.insert(0, str(TOOL))
sys.path.append(str(TOOL.parent / "appbuilder"))

import appspec  # noqa: E402
from PyQt6.QtCore import QSettings  # noqa: E402
from PyQt6.QtWidgets import QApplication  # noqa: E402


@pytest.fixture(scope="module")
def qt():
    return QApplication.instance() or QApplication(["test"])


@pytest.fixture
def window(qt, monkeypatch, tmp_path):
    QSettings.setPath(QSettings.Format.NativeFormat, QSettings.Scope.UserScope, str(tmp_path))
    import window as module

    # Modal boxes would wait for a click that never comes offscreen. The
    # ".rpm built here" question is answered yes; the rest are recorded.
    said: list[str] = []
    monkeypatch.setattr(module.QMessageBox, "question",
                        lambda *a, **k: module.QMessageBox.StandardButton.Yes)
    monkeypatch.setattr(module.QMessageBox, "information", lambda _w, title, *_: said.append(title))
    monkeypatch.setattr(module.QMessageBox, "warning", lambda _w, title, *_: said.append(title))
    started: list[tuple[list[str], Path, str]] = []
    monkeypatch.setattr(module.BuilderWindow, "_start",
                        lambda self, command, cwd, label: started.append((command, cwd, label)))
    w = module.BuilderWindow(appspec.load(REPO, "morion"))
    w.started = started
    w.said = said
    yield w
    w.close()


def test_it_shows_morions_identity_and_icon(window):
    assert window.windowTitle() == "Morion Builder"
    assert "packaged as Zinnia · com.spectrumaipl.zinnia" in window.identity.text()
    assert not window.windowIcon().isNull()


def test_the_build_button_runs_a_desktop_build(window):
    # clicked(bool) must not reach a keyword-only handler as a positional.
    window.build_btn.click()
    command, cwd, label = window.started[-1]
    assert command[:2] == ["bash", str(REPO / "apps/morion/build.sh")]
    assert cwd == REPO / "apps/morion"
    assert label == "Building"


def test_frontend_only(window):
    window.frontend_btn.click()
    assert "--frontend" in window.started[-1][0]


def test_the_apk_follows_the_debug_box_and_the_abi(window):
    window.debug_box.setChecked(True)
    window.abi_box.setCurrentIndex(window.abi_box.findData("x86_64"))
    window.android_btn.click()
    command, cwd, _ = window.started[-1]
    assert command == ["bash", str(REPO / "scripts/build_android.sh"), "morion", "debug", "x86_64"]
    assert cwd == REPO


def test_cancel_asks_the_worker_for_the_whole_group(window):
    asked = []

    class Worker:
        def request_cancel(self):
            asked.append(True)

    window.worker = Worker()
    window.on_cancel()
    assert asked == [True]
    window.worker = None


def test_no_format_ticked_says_so_instead_of_building(window):
    for box in window.target_boxes.values():
        box.setChecked(False)
    window.build_btn.click()
    assert window.started == []
    assert window.said == ["Nothing to build"]
