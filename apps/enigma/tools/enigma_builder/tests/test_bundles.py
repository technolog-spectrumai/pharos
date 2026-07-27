"""Target-distribution selection and the tauri.conf.json edit it drives."""

from __future__ import annotations

import json

import pytest

import bundles
import identity as identity_mod
import paths


def test_only_ubuntu_and_fedora_are_offered():
    assert bundles.KEYS == ("ubuntu", "fedora")
    assert bundles.bundle_id("ubuntu") == "deb"
    assert bundles.bundle_id("fedora") == "rpm"


def test_both_are_selected_by_default():
    assert set(bundles.DEFAULT) == set(bundles.KEYS)


@pytest.mark.parametrize(
    "selected,expected",
    [
        (["ubuntu"], ["deb"]),
        (["fedora"], ["rpm"]),
        (["ubuntu", "fedora"], ["deb", "rpm"]),
        (["fedora", "ubuntu"], ["deb", "rpm"]),  # stable order, not click order
        ([], []),
    ],
)
def test_config_value_for_a_selection(selected, expected):
    assert bundles.to_config_value(selected) == expected


@pytest.mark.parametrize(
    "value,expected",
    [
        ("all", ["ubuntu", "fedora"]),
        (None, ["ubuntu", "fedora"]),
        (["deb"], ["ubuntu"]),
        (["rpm"], ["fedora"]),
        (["deb", "rpm"], ["ubuntu", "fedora"]),
        (["deb", "appimage"], ["ubuntu"]),  # formats we do not offer are dropped
        ("deb", ["ubuntu"]),
        (42, ["ubuntu", "fedora"]),
    ],
)
def test_reading_a_config_value(value, expected):
    assert bundles.from_config_value(value) == expected


def test_globs_follow_the_selection():
    assert bundles.globs(["ubuntu"]) == ["*.deb"]
    assert bundles.globs(["fedora"]) == ["*.rpm"]
    assert bundles.globs(["ubuntu", "fedora"]) == ["*.deb", "*.rpm"]


def test_the_repo_config_reads_as_both():
    """The shipped `"targets": "all"` covers both offered distributions."""
    conf = identity_mod.read_conf()
    assert conf["bundle"]["targets"] == "all"
    assert bundles.read_from_config(conf) == ["ubuntu", "fedora"]


def test_applying_a_selection_narrows_only_that_key():
    conf = identity_mod.read_conf()
    before = json.dumps(conf, sort_keys=True)

    bundles.apply_to_config(conf, ["fedora"])
    assert conf["bundle"]["targets"] == ["rpm"]
    # Everything else in the bundle section survives.
    assert conf["bundle"]["active"] is True
    assert conf["bundle"]["icon"]
    assert conf["productName"] == json.loads(before)["productName"]


def test_applying_to_a_config_without_a_bundle_section():
    conf: dict = {}
    bundles.apply_to_config(conf, ["ubuntu"])
    assert conf == {"bundle": {"targets": ["deb"]}}


# ----- the host and the honest caveat --------------------------------------


def test_host_distro_is_identified_on_this_machine():
    key, pretty = bundles.host_distro()
    assert pretty and pretty != ""
    assert key in (None, *bundles.KEYS)


def test_no_warning_when_building_only_for_the_host():
    host_key, _pretty = bundles.host_distro()
    if host_key is None:
        pytest.skip("host is not one of the offered distributions")
    assert bundles.cross_build_warning([host_key]) == ""


def test_warning_when_building_for_another_distribution():
    host_key, _pretty = bundles.host_distro()
    foreign = next(k for k in bundles.KEYS if k != host_key)
    warning = bundles.cross_build_warning([foreign])
    assert "glibc" in warning
    assert "container or VM" in warning


# ----- the GUI --------------------------------------------------------------


def test_both_distributions_start_ticked(app, window):
    assert set(window.build_tab.distros) == set(bundles.KEYS)


def test_unticking_everything_blocks_the_build(app, window):
    tab = window.build_tab
    tab.platform_buttons["desktop"].setChecked(True)
    for box in tab.distro_boxes.values():
        box.setChecked(False)
    assert not tab.start_button.isEnabled()
    assert "at least one" in tab.distro_hint.text()

    tab.distro_boxes["ubuntu"].setChecked(True)
    assert tab.start_button.isEnabled()


def test_an_android_only_build_does_not_need_a_distribution(app, window):
    tab = window.build_tab
    tab.platform_buttons["android"].setChecked(True)
    for box in tab.distro_boxes.values():
        box.setChecked(False)
    assert tab.start_button.isEnabled()


def test_distribution_boxes_are_disabled_for_an_android_build(app, window):
    tab = window.build_tab
    tab.platform_buttons["android"].setChecked(True)
    assert not any(box.isEnabled() for box in tab.distro_boxes.values())
    tab.platform_buttons["both"].setChecked(True)
    assert all(box.isEnabled() for box in tab.distro_boxes.values())


def test_the_cross_build_warning_reaches_the_gui(app, window):
    tab = window.build_tab
    tab.platform_buttons["desktop"].setChecked(True)
    host_key, _pretty = bundles.host_distro()
    if host_key is None:
        pytest.skip("host is not one of the offered distributions")
    foreign = next(k for k in bundles.KEYS if k != host_key)

    for key, box in tab.distro_boxes.items():
        box.setChecked(key == host_key)
    assert tab.distro_hint.text() == ""

    tab.distro_boxes[foreign].setChecked(True)
    assert "⚠" in tab.distro_hint.text()


def test_artifact_patterns_follow_the_selection(app, window, tmp_path):
    """A Fedora-only build must not report a stale .deb as its output."""
    tab = window.build_tab
    tab.platform_buttons["desktop"].setChecked(True)
    tab.distro_boxes["ubuntu"].setChecked(False)
    tab.distro_boxes["fedora"].setChecked(True)

    bundle_dir = paths.TARGET_DIR / "release" / "bundle" / "test"
    bundle_dir.mkdir(parents=True, exist_ok=True)
    deb = bundle_dir / "stale.deb"
    rpm = bundle_dir / "fresh.rpm"
    try:
        deb.write_bytes(b"deb")
        rpm.write_bytes(b"rpm")
        tab._started_at = 0
        tab.collect_box.setChecked(True)
        tab.output_edit.setText(str(tmp_path / "out"))
        tab._show_artifacts()

        listed = tab.artifact_label.text()
        assert "fresh.rpm" in listed
        assert "stale.deb" not in listed
    finally:
        deb.unlink(missing_ok=True)
        rpm.unlink(missing_ok=True)
        bundle_dir.rmdir()
