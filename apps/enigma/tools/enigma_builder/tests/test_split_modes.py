"""The Config Builder / Builder split (B3-B4).

The boundary under test: config mode edits AND builds in one window — the
Build tab is the fourth tab, not a second window — while build mode consumes a
product file read-only and shows no editing surface.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import paths
import productbuild
from config_model import ConfigModel


# ----- window modes ---------------------------------------------------------


@pytest.fixture
def config_window(app):
    from window import MainWindow

    win = MainWindow(mode="config")
    win.expert_tab._warned = True
    yield win
    win.close()


def test_config_mode_carries_the_build_tab(app, config_window):
    """The build surface lives in THIS window; a second one went unnoticed."""
    titles = [config_window.tabs.tabText(i) for i in range(config_window.tabs.count())]
    assert titles == ["Features", "Identity", "Expert", "Build"]
    assert config_window.tabs.widget(3) is config_window.build_tab


def test_build_this_config_switches_tabs_instead_of_opening_a_window(
    app, config_window, tmp_path, monkeypatch
):
    """The old button opened a second MainWindow, which people missed entirely.
    Now it saves and moves you to the Build tab in place."""
    from PyQt6.QtWidgets import QApplication

    import window as window_mod

    target = tmp_path / "p.yaml"
    monkeypatch.setattr(
        window_mod.QFileDialog,
        "getSaveFileName",
        staticmethod(lambda *a, **k: (str(target), "")),
    )
    # An unmocked modal hangs the offscreen suite forever.
    monkeypatch.setattr(
        window_mod.QMessageBox, "critical", staticmethod(lambda *a, **k: None)
    )

    config_window.tabs.setCurrentIndex(0)
    before = len(QApplication.topLevelWidgets())

    config_window.build_button.click()

    assert config_window.tabs.currentWidget() is config_window.build_tab
    assert len(QApplication.topLevelWidgets()) == before
    assert not hasattr(config_window, "_builder_window")
    assert not hasattr(config_window, "_launch_builder")
    # The click still writes the product config it names in the label.
    assert target.is_file()
    assert str(target) in config_window.product_label.text()


def test_the_build_tab_still_opens_when_the_save_is_cancelled(
    app, config_window, monkeypatch
):
    """`_start` materialises the build config from the LIVE model, so backing
    out of the file dialog must not swallow the click."""
    import window as window_mod

    monkeypatch.setattr(
        window_mod.QFileDialog,
        "getSaveFileName",
        staticmethod(lambda *a, **k: ("", "")),
    )
    monkeypatch.setattr(
        window_mod.QMessageBox, "critical", staticmethod(lambda *a, **k: None)
    )

    config_window.tabs.setCurrentIndex(0)
    config_window.build_button.click()

    assert config_window.tabs.currentWidget() is config_window.build_tab
    assert config_window.product_file is None


def test_config_mode_tracks_dirtiness_and_saves(app, config_window, tmp_path):
    config_window.model.set("maps.enabled", False)
    assert config_window._product_dirty
    config_window.product_file = tmp_path / "p.yaml"
    saved = config_window._save_product()
    assert saved is not None and saved.is_file()
    assert not config_window._product_dirty
    assert str(saved) in config_window.product_label.text()


def test_build_mode_shows_only_the_build_tab(app, tmp_path):
    """`enigma-builder build product.yaml --gui`: ONE tab, no editing surface."""
    from window import MainWindow

    product = ConfigModel().save_product(tmp_path / "p.yaml")
    win = MainWindow(mode="build", product_file=product)
    try:
        titles = [win.tabs.tabText(i) for i in range(win.tabs.count())]
        assert titles == ["Build"]
        assert win.tabs.count() == 1
        assert not hasattr(win, "build_button")
        assert win.features_tab.isHidden()
        assert win.identity_tab.isHidden()
        assert "p.yaml" in win.windowTitle()
    finally:
        win.close()


def test_build_mode_keeps_the_fixed_identity(app, tmp_path):
    from window import MainWindow

    model = ConfigModel()
    model.set("app.name", "Acme Secure")
    model.set("app.identifier", "com.acme.secure")
    product = model.save_product(tmp_path / "acme.yaml")

    win = MainWindow(mode="build", product_file=product)
    try:
        pending = win.identity_tab.pending_identity()
        assert pending.name == "Enigma26"
        assert pending.identifier == "com.spectrumaipl.enigma26"
    finally:
        win.close()


# ----- headless product builds ----------------------------------------------


def test_command_selection_matches_the_gui():
    assert productbuild._command("desktop", "debug", "aarch64", False)[-1] == "--debug"
    assert str(paths.DEPLOY_BUILD_SH) in productbuild._command("both", "release", "all", False)[1]
    android = productbuild._command("android", "release", "aarch64", True)
    assert android[-1] == "--allow-unsigned-release"


def test_an_invalid_product_config_aborts_before_any_work(tmp_path, capsys):
    bad = tmp_path / "bad.yaml"
    bad.write_text("app:\n  name: ''\n", encoding="utf-8")
    code = productbuild.run(bad, platform="desktop", build_type="debug")
    assert code == 1


def test_a_run_materialises_restores_and_records(tmp_path, monkeypatch, capsys):
    """The full headless contract, with the build script stubbed out: the
    custom YAML is written, tauri.conf.json ends the run byte-identical, and
    build-info.json names the config that produced the artifacts."""
    import subprocess as sp

    import identity as identity_mod

    product = ConfigModel().save_product(tmp_path / "prod.yaml")
    monkeypatch.setattr(paths, "DEPLOY_DIST", tmp_path / "dist")

    launched: list[list[str]] = []

    def fake_run(command, **kwargs):
        launched.append(list(command))
        class Done:
            returncode = 0
        return Done()

    monkeypatch.setattr(sp, "run", fake_run)
    conf_before = identity_mod.read_conf_text()

    code = productbuild.run(product, platform="desktop", build_type="release")
    assert code == 0
    assert launched and launched[0][0] == "bash"
    assert identity_mod.read_conf_text() == conf_before
    assert paths.CUSTOM_YAML.is_file()

    info_file = tmp_path / "dist" / "build-info.json"
    assert info_file.is_file()
    import json

    info = json.loads(info_file.read_text(encoding="utf-8"))
    assert info["product_config"] == str(product)
    assert len(info["product_config_sha256"]) == 64
    assert info["platform"] == "desktop"
