"""Offscreen GUI smoke tests.

    QT_QPA_PLATFORM=offscreen venv/bin/python -m pytest tests/

Building the window is itself a check on both theme palettes: a token missing
from either dict raises KeyError as the stylesheet is substituted.
"""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import paths  # noqa: E402
from theme import THEMES  # noqa: E402
from validation import errors  # noqa: E402
from window import TAB_TITLES  # noqa: E402


def test_the_default_window_has_four_tabs_ending_in_build(window):
    """A bare launch must be able to BUILD. The Build tab used to live in a
    second window opened by a button, and people simply never found it."""
    titles = [window.tabs.tabText(i) for i in range(window.tabs.count())]
    assert titles == ["Features", "Identity", "Expert", "Build"]
    assert titles == list(TAB_TITLES)
    assert window.tabs.indexOf(window.build_tab) == 3


def test_the_build_tab_is_reachable_and_carries_the_log(window):
    """Reachable in one click, with the log and Start button on it."""
    window.tabs.setCurrentWidget(window.build_tab)
    assert window.tabs.currentWidget() is window.build_tab
    assert window.build_tab.log is not None
    assert window.build_tab.start_button.text() == "Start build"


def test_the_log_is_pinned_labelled_and_mirrors_the_status(window):
    """The log sits outside the scroll area with its own heading, so a running
    build is visible wherever the form above is scrolled to."""
    from PyQt6.QtWidgets import QLabel

    tab = window.build_tab
    titles = [
        label.text()
        for label in tab.findChildren(QLabel)
        if label.objectName() == "sectionTitle"
    ]
    assert "Build output" in titles
    assert tab.log.minimumHeight() >= 200

    tab._set_status("Building")
    assert tab.status_label.text() == "Building"
    assert tab.log_status.text() == "Building"


def test_only_the_owning_tab_is_flagged_and_build_is_never_renamed(window):
    """The ⚠ marker is placed by tab TITLE, not by index — a wrong index used
    to rename the wrong tab, and there are four tabs now."""
    window.model.set("dht.enabled", True)
    window.model.set("p2p.allow_hosted_relays", False)
    titles = [window.tabs.tabText(i) for i in range(window.tabs.count())]
    assert titles[0] == "Features ⚠"
    assert titles[1:] == ["Identity", "Expert", "Build"]

    window.model.set("p2p.allow_hosted_relays", True)
    assert [window.tabs.tabText(i) for i in range(4)] == list(TAB_TITLES)


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
    window.features_tab.preset_buttons["standard"].click()
    assert window.model.detect_preset() == "standard"
    assert window.model.get("calls.enabled") is True
    assert window.model.get("maps.enabled") is False

    preview = window.features_tab.preview.toPlainText()
    assert "maps:" in preview
    assert "# Derived from preset: standard" in preview


def test_the_picker_offers_exactly_the_three_editions(window):
    """No gate checkboxes, no Custom chip: the product line IS the presets."""
    tab = window.features_tab
    assert set(tab.preset_buttons) == {"basic", "standard", "professional"}
    assert not hasattr(tab, "gate_boxes")
    assert not hasattr(tab, "custom_chip")
    tab.preset_buttons["basic"].click()
    assert window.model.detect_preset() == "basic"
    # The read-only list shows the REAL yaml values for the choice.
    assert tab.feature_badges["maps.enabled"].text() == "not included"
    assert tab.feature_badges["contacts.enabled"].text() == "included"
    tab.preset_buttons["professional"].click()
    assert window.model.detect_preset() == "professional"
    assert tab.feature_badges["maps.enabled"].text() == "included"


def test_a_hand_edited_invalid_combo_still_blocks_the_build(window):
    """The GUI can no longer produce dht-without-relays, but a hand-edited
    file could try; validation (mirroring build.rs) must still catch it."""
    window.model.set("dht.enabled", True)
    window.model.set("p2p.allow_hosted_relays", False)
    assert not window.build_tab.start_button.isEnabled()

    window.model.set("p2p.allow_hosted_relays", True)
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


def test_both_target_uses_the_sequencing_script(window):
    """Only `both` needs deploy/build.sh — it is what runs the two legs."""
    tab = window.build_tab
    tab.platform_buttons["both"].setChecked(True)
    assert tab.command()[:3] == ["bash", str(paths.DEPLOY_BUILD_SH), "both"]


def test_output_folder_does_not_change_the_command(window, tmp_path):
    """Collecting is a copy step in Python, so it must not switch scripts."""
    tab = window.build_tab
    tab.platform_buttons["desktop"].setChecked(True)
    tab.release_button.setChecked(True)
    tab.collect_box.setChecked(True)
    tab.output_edit.setText(str(tmp_path))
    assert tab.command() == ["bash", str(paths.BUILD_DESKTOP_SH)]
    assert tab.output_dir == tmp_path


def test_output_folder_defaults_to_deploy_dist(window):
    window.build_tab._reset_output()
    assert window.build_tab.output_dir == paths.DEPLOY_DIST


def test_clearing_the_output_field_falls_back_to_the_default(window):
    window.build_tab.output_edit.setText("")
    assert window.build_tab.output_dir == paths.DEPLOY_DIST


def test_output_controls_follow_the_collect_checkbox(window):
    tab = window.build_tab
    tab.collect_box.setChecked(False)
    assert not tab.output_edit.isEnabled()
    tab.collect_box.setChecked(True)
    assert tab.output_edit.isEnabled()


def test_repository_row_shows_the_resolved_checkout(window):
    assert window.build_tab.repo_edit.text() == str(paths.REPO_ROOT)
    assert window.build_tab.repo_badge.text() == "found"


def test_nothing_is_running_on_a_fresh_window(window):
    assert not window.build_tab.is_busy()
