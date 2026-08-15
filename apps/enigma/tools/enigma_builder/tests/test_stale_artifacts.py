"""Keeping old installers out of a new build's artifact list.

`deploy/build.sh` collects a "Both" build by copying *every* package in
src-tauri/target/release/bundle into deploy/dist. That sweeps up packages left
from earlier builds and from older app identities, and because `cp` stamps each
copy with the current time, a timestamp cannot tell them apart from the ones
this build just produced. Content can — which is what these tests pin.

Nothing is ever deleted: the point is to leave old installers on disk while
keeping them out of the artifact list and the output folder.
"""

from __future__ import annotations

import os
import time

import pytest

import paths


@pytest.fixture(autouse=True)
def dist(tmp_path, monkeypatch, window):
    """A private deploy/dist, so no test can see or touch the real one.

    Depends on ``window`` on purpose, and that ordering is load-bearing:
    building a MainWindow calls ``paths.set_repo_root``, which REBINDS every
    path global including DEPLOY_DIST. Patching first would be silently undone
    and the test would then read — and its cleanup would delete — real
    installers in the checkout.
    """
    directory = tmp_path / "dist"
    directory.mkdir()
    monkeypatch.setattr(paths, "DEPLOY_DIST", directory)
    return directory


def _dist_file(dist, name: str, data: bytes):
    """Write ``data`` into the folder a Both build collects into."""
    path = dist / name
    path.write_bytes(data)
    return path


def _both_build(tab):
    tab.platform_buttons["both"].setChecked(True)
    for box in tab.distro_boxes.values():
        box.setChecked(True)


def test_recopied_old_packages_are_left_out(app, window, tmp_path, dist):
    """The exact situation on disk: old identities, all with fresh mtimes."""
    tab = window.build_tab
    _both_build(tab)
    tab.fresh_only_box.setChecked(True)

    old_one = _dist_file(dist, "EnigmaApp_0.1.0_amd64.deb", b"old-identity")
    old_two = _dist_file(dist, "Enigma_0.1.2_amd64.deb", b"older-version")
    fresh = _dist_file(dist, "Enigma26_0.1.3_amd64.deb", b"this-build")
    try:
        # Snapshot with only the two old packages present, as at build start.
        fresh.unlink()
        tab._artifact_snapshot = tab._snapshot_artifacts()
        assert len(tab._artifact_snapshot) == 2

        # The build runs: it writes its own package, and deploy/build.sh
        # re-copies the old ones, refreshing every timestamp.
        fresh.write_bytes(b"this-build")
        now = time.time()
        for path in (old_one, old_two, fresh):
            os.utime(path, (now, now))
        tab._started_at = now - 1

        tab.collect_box.setChecked(True)
        tab.output_edit.setText(str(tmp_path / "out"))
        tab._show_artifacts()

        listed = tab.artifact_label.text()
        assert "Enigma26_0.1.3_amd64.deb" in listed
        assert "EnigmaApp_0.1.0_amd64.deb" not in listed
        assert "Enigma_0.1.2_amd64.deb" not in listed

        # Left where they were, not deleted — the user archives them.
        assert old_one.is_file() and old_two.is_file()
        # ...and not copied into the output folder either.
        assert not (tmp_path / "out" / old_one.name).exists()
        assert (tmp_path / "out" / fresh.name).is_file()
    finally:
        for path in (old_one, old_two, fresh):
            path.unlink(missing_ok=True)


def test_a_rebuilt_package_still_counts(app, window, tmp_path, dist):
    """Same filename, new bytes — that IS this build's output."""
    tab = window.build_tab
    _both_build(tab)
    tab.fresh_only_box.setChecked(True)

    package = _dist_file(dist, "Enigma26_0.1.3_amd64.deb", b"previous-attempt")
    try:
        tab._artifact_snapshot = tab._snapshot_artifacts()

        package.write_bytes(b"rebuilt-with-changes")
        now = time.time()
        os.utime(package, (now, now))
        tab._started_at = now - 1

        tab.collect_box.setChecked(False)
        tab._show_artifacts()
        assert "Enigma26_0.1.3_amd64.deb" in tab.artifact_label.text()
    finally:
        package.unlink(missing_ok=True)


def test_unticking_the_flag_restores_collect_everything(app, window, tmp_path, dist):
    """Off = the previous behaviour, timestamps only."""
    tab = window.build_tab
    _both_build(tab)
    tab.fresh_only_box.setChecked(False)

    old = _dist_file(dist, "EnigmaApp_0.1.0_amd64.deb", b"old-identity")
    try:
        tab._artifact_snapshot = {}
        now = time.time()
        os.utime(old, (now, now))
        tab._started_at = now - 1

        tab.collect_box.setChecked(False)
        tab._show_artifacts()
        assert "EnigmaApp_0.1.0_amd64.deb" in tab.artifact_label.text()
    finally:
        old.unlink(missing_ok=True)


def test_snapshot_is_skipped_when_the_flag_is_off(app, window, dist):
    """Digesting 30 MB packages is not free — do not pay for it unused."""
    tab = window.build_tab
    _both_build(tab)
    tab.fresh_only_box.setChecked(False)

    package = _dist_file(dist, "Enigma26_0.1.3_amd64.deb", b"x")
    try:
        snapshot = tab._snapshot_artifacts() if tab.fresh_only else {}
        assert snapshot == {}
    finally:
        package.unlink(missing_ok=True)
