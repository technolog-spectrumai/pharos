"""Offscreen GUI smoke tests.

    QT_QPA_PLATFORM=offscreen venv/bin/python -m pytest tests/

Building the window is itself a check on both theme palettes: a token missing
from either dict raises KeyError as the stylesheet is substituted.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtWidgets import QApplication  # noqa: E402

import paths  # noqa: E402
from theme import THEMES  # noqa: E402
from validation import errors  # noqa: E402
from window import TAB_TITLES, MainWindow  # noqa: E402


@pytest.fixture(scope="module")
def app():
    instance = QApplication.instance() or QApplication([])
    instance.setApplicationName(paths.APP_NAME)
    instance.setOrganizationName(paths.ORG_NAME)
    instance.setStyle("Fusion")
    return instance


@pytest.fixture
def window(app):
    win = MainWindow()
    # The expert toggle shows a one-time modal, which would block a headless run.
    win.expert_tab._warned = True
    yield win
    win.close()


def test_window_has_the_four_tabs(window):
    assert [window.tabs.tabText(i) for i in range(window.tabs.count())] == list(
        TAB_TITLES
    )


def test_both_themes_apply(window):
    for name in THEMES:
        window._apply_theme(name)
        assert window.styleSheet()


def test_opens_with_a_valid_config(window):
    pending = window.identity_tab.pending_identity().as_conf_fields()
    assert errors(window.model.validate(pending)) == []
    assert window.build_tab.start_button.isEnabled()


def test_identity_is_seeded_from_tauri_conf(window):
    import identity as identity_mod

    conf = identity_mod.disk_identity()
    assert window.model.get("app.name") == conf.name
    assert window.model.get("app.identifier") == conf.identifier


def test_preset_click_updates_gates_and_preview(window):
    window.features_tab.preset_buttons["plus"].click()
    assert window.model.detect_preset() == "plus"
    assert window.model.get("calls.enabled") is True
    assert window.model.get("maps.enabled") is False

    preview = window.features_tab.preview.toPlainText()
    assert "maps:" in preview
    assert "# Derived from preset: plus" in preview


def test_toggling_a_gate_flips_the_chip_to_custom(window):
    window.features_tab.preset_buttons["pro"].click()
    assert not window.features_tab.custom_chip.isChecked()
    window.features_tab.gate_boxes["maps.enabled"].setChecked(False)
    assert window.features_tab.custom_chip.isChecked()


def test_cross_field_error_blocks_the_build(window):
    window.features_tab.gate_boxes["dht.enabled"].setChecked(True)
    window.features_tab.gate_boxes["p2p.allow_hosted_relays"].setChecked(False)

    assert "allow_hosted_relays" in window.features_tab.gate_error.text()
    assert window.tabs.tabText(0).endswith("⚠")
    assert not window.build_tab.start_button.isEnabled()

    window.features_tab.gate_boxes["dht.enabled"].setChecked(False)
    assert window.tabs.tabText(0) == TAB_TITLES[0]
    assert window.build_tab.start_button.isEnabled()


def test_expert_controls_are_disabled_until_enabled(window):
    window.tabs.setCurrentIndex(2)
    assert not window.expert_tab.clamp_rows["idle_lock_mins"].isEnabled()
    window.expert_tab.enable_box.setChecked(True)
    assert window.expert_tab.clamp_rows["idle_lock_mins"].isEnabled()


def test_crypto_card_is_read_only(window):
    label = window.expert_tab.crypto_labels["crypto.at_rest_aead"]
    assert label.text() == "xchacha20-poly1305"
    assert not hasattr(label, "setValue")


def test_build_commands_match_the_repo_scripts(window):
    tab = window.build_tab

    tab.platform_buttons["desktop"].setChecked(True)
    tab.release_button.setChecked(True)
    tab.collect_box.setChecked(False)
    assert tab.command() == ["bash", str(paths.BUILD_DESKTOP_SH)]

    tab.debug_button.setChecked(True)
    assert tab.command() == ["bash", str(paths.BUILD_DESKTOP_SH), "--debug"]

    tab.platform_buttons["android"].setChecked(True)
    tab.abi_boxes["x86_64"].setChecked(True)
    assert tab.command() == [
        "bash",
        str(paths.BUILD_ANDROID_SH),
        "enigma",
        "debug",
        "aarch64,x86_64",
    ]

    tab.abi_all.setChecked(True)
    assert tab.command()[-1] == "all"


def test_both_target_forces_the_collecting_script(window):
    tab = window.build_tab
    tab.platform_buttons["both"].setChecked(True)
    assert tab.collect_box.isChecked()
    assert not tab.collect_box.isEnabled()
    assert tab.command()[:3] == ["bash", str(paths.DEPLOY_BUILD_SH), "both"]


def test_nothing_is_running_on_a_fresh_window(window):
    assert not window.build_tab.is_busy()
