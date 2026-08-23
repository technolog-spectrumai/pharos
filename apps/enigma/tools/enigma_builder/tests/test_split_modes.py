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


# ----- the icon set reaches the headless build -------------------------------


def _prod_with_icon(tmp_path, icon):
    """A valid product config naming an icon set."""
    return ConfigModel().save_product(tmp_path / "prod.yaml", icon=icon)


def test_a_headless_build_generates_the_icon_set_the_config_names(
    tmp_path, monkeypatch
):
    """The gap that mattered: `branding.icon` was read and thrown away, so the
    same product file built one brand in the GUI and another on the command
    line. The icon step must run BEFORE the build script."""
    import subprocess as sp

    import icons as icons_mod
    import iconsets

    chosen = iconsets.usable_sets()[0]
    product = _prod_with_icon(tmp_path, chosen.id)
    monkeypatch.setattr(paths, "DEPLOY_DIST", tmp_path / "dist")

    launched: list[list[str]] = []

    def fake_run(command, **kwargs):
        launched.append(list(command))
        class Done:
            returncode = 0
        return Done()

    monkeypatch.setattr(sp, "run", fake_run)
    # Never touch the committed icon trees from a test.
    monkeypatch.setattr(icons_mod, "snapshot", lambda: {"sentinel": b""})
    monkeypatch.setattr(icons_mod, "restore", lambda saved: len(saved))
    monkeypatch.setattr(icons_mod, "sync_android_icons", lambda: 0)

    code = productbuild.run(product, platform="desktop", build_type="release")
    assert code == 0
    assert len(launched) == 2, launched
    assert launched[0][:3] == ["npx", "tauri", "icon"]
    assert launched[0][3] == str(chosen.master.resolve())
    assert launched[1][0] == "bash"  # the build ran after the icons


def test_the_headless_build_restores_the_icons_even_when_the_build_fails(
    tmp_path, monkeypatch
):
    """The generated icons are tracked files; a failed build must not leave the
    working tree branded."""
    import subprocess as sp

    import icons as icons_mod
    import iconsets

    product = _prod_with_icon(tmp_path, iconsets.usable_sets()[0].id)
    monkeypatch.setattr(paths, "DEPLOY_DIST", tmp_path / "dist")

    def fake_run(command, **kwargs):
        class Done:
            returncode = 0 if command[0] == "npx" else 7
        return Done()

    restored: list[int] = []
    monkeypatch.setattr(sp, "run", fake_run)
    monkeypatch.setattr(icons_mod, "snapshot", lambda: {"sentinel": b""})
    monkeypatch.setattr(icons_mod, "restore",
                        lambda saved: restored.append(len(saved)) or len(saved))
    monkeypatch.setattr(icons_mod, "sync_android_icons", lambda: 0)

    assert productbuild.run(product, platform="desktop") == 7
    assert restored == [1], "icons were not put back after a failed build"


def test_a_config_naming_an_unknown_icon_set_fails_instead_of_rebranding(
    tmp_path, monkeypatch
):
    """Falling back to the repo's icons would ship a release under the wrong
    brand with a zero exit code. Fail closed, before any work happens."""
    import subprocess as sp

    product = _prod_with_icon(tmp_path, "no-such-set")
    launched: list[list[str]] = []
    monkeypatch.setattr(sp, "run",
                        lambda command, **kw: launched.append(list(command)))

    assert productbuild.run(product, platform="desktop") == 1
    assert launched == [], "work started despite an unusable icon set"


def test_a_config_with_no_icon_still_builds_the_repo_icons(tmp_path, monkeypatch):
    """No branding block is the old behaviour and must stay untouched: no icon
    step, straight to the build script."""
    import subprocess as sp

    product = ConfigModel().save_product(tmp_path / "plain.yaml")
    monkeypatch.setattr(paths, "DEPLOY_DIST", tmp_path / "dist")
    launched: list[list[str]] = []

    def fake_run(command, **kwargs):
        launched.append(list(command))
        class Done:
            returncode = 0
        return Done()

    monkeypatch.setattr(sp, "run", fake_run)
    assert productbuild.run(product, platform="desktop") == 0
    assert len(launched) == 1 and launched[0][0] == "bash"


def test_build_info_records_which_icon_set_branded_the_artifacts(
    tmp_path, monkeypatch
):
    """build-info.json is the provenance record; the icon is part of what was
    built."""
    import json
    import subprocess as sp

    import icons as icons_mod
    import iconsets

    chosen = iconsets.usable_sets()[0]
    product = _prod_with_icon(tmp_path, chosen.id)
    monkeypatch.setattr(paths, "DEPLOY_DIST", tmp_path / "dist")

    class Done:
        returncode = 0

    monkeypatch.setattr(sp, "run", lambda command, **kw: Done())
    monkeypatch.setattr(icons_mod, "snapshot", lambda: {})
    monkeypatch.setattr(icons_mod, "sync_android_icons", lambda: 0)

    assert productbuild.run(product, platform="desktop") == 0
    info = json.loads(
        (tmp_path / "dist" / "build-info.json").read_text(encoding="utf-8")
    )
    assert info["icon_set"] == chosen.id


def test_the_gui_and_the_headless_build_resolve_an_icon_the_same_way(tmp_path):
    """One resolver, so a product config cannot mean two different sets."""
    import iconsets

    chosen = iconsets.usable_sets()[0]
    for stored in (chosen.id, str(chosen.master), str(chosen.path)):
        assert iconsets.resolve(stored) is not None
        assert productbuild._resolve_icon(stored, base=tmp_path) == chosen.master
    # And an arbitrary file is not a set, on either path.
    stray = tmp_path / "screenshot.png"
    stray.write_bytes(chosen.master.read_bytes())
    assert iconsets.resolve(str(stray)) is None
    with pytest.raises(ValueError, match="does not ship"):
        productbuild._resolve_icon(str(stray), base=tmp_path)
