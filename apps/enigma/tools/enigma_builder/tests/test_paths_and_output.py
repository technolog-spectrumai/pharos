"""Repo-root resolution and the artifact copy step.

Both exist so the Builder can run as a standalone binary from anywhere: it has
to find (or be told) which checkout to drive, and it has to put the results
where the user asked rather than where a script happened to leave them.
"""

from __future__ import annotations

import hashlib
import os

import pytest

import paths


@pytest.fixture(autouse=True)
def restore_root():
    """Every test here moves the global root; put it back afterwards."""
    original = paths.REPO_ROOT
    yield
    paths.set_repo_root(original)


def test_the_repo_is_detected_from_the_tool_location():
    assert paths.is_repo(paths.REPO_ROOT)
    assert paths.have_repo()
    assert paths.CANONICAL_YAML.is_file()


def test_marker_identifies_a_checkout(tmp_path):
    assert not paths.is_repo(tmp_path)
    (tmp_path / paths.MARKER).parent.mkdir(parents=True)
    (tmp_path / paths.MARKER).write_text("app: {}\n")
    assert paths.is_repo(tmp_path)


def test_set_repo_root_rebinds_every_derived_path(tmp_path):
    paths.set_repo_root(tmp_path)
    assert paths.REPO_ROOT == tmp_path.resolve()
    assert paths.CANONICAL_YAML == tmp_path.resolve() / paths.MARKER
    assert paths.BUILD_DESKTOP_SH == tmp_path.resolve() / "build_desktop.sh"
    assert paths.DEPLOY_DIST == tmp_path.resolve() / "apps/enigma/deploy/dist"
    assert paths.default_output_dir() == paths.DEPLOY_DIST


def test_no_repo_leaves_the_module_usable():
    """A standalone first run must not explode on import or on a path read."""
    paths.set_repo_root(None)
    assert not paths.have_repo()
    assert paths.missing_repo_files()  # everything is missing, nothing raises


def test_env_var_overrides_detection(tmp_path, monkeypatch):
    (tmp_path / paths.MARKER).parent.mkdir(parents=True)
    (tmp_path / paths.MARKER).write_text("app: {}\n")
    monkeypatch.setenv(paths.ROOT_ENV_VAR, str(tmp_path))
    assert paths.search_for_repo() == tmp_path.resolve()


def test_env_var_pointing_at_a_non_repo_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.ROOT_ENV_VAR, str(tmp_path))
    # Falls through to the in-repo location the tool actually lives in.
    assert paths.search_for_repo() == paths.REPO_ROOT


# ----- the standalone first run -------------------------------------------


def test_window_survives_having_no_repository(app, monkeypatch):
    """First launch of the standalone binary: nothing found, nothing broken."""
    import window as window_mod

    monkeypatch.setattr(window_mod.MainWindow, "_prompt_for_repo", lambda self: None)
    monkeypatch.setattr(
        window_mod.MainWindow, "_restore_repo_root", lambda self, override: None
    )
    paths.set_repo_root(None)

    win = window_mod.MainWindow()
    try:
        assert not win.model.ready
        assert win.build_tab.repo_badge.text() == "not set"
        assert not win.build_tab.start_button.isEnabled()
        assert not win.build_tab.clean_button.isEnabled()
        # No config means no findings to hang off the tabs — and the titles
        # are reset from the tab ORDER, so all four come back unmarked.
        assert [win.tabs.tabText(i) for i in range(win.tabs.count())] == list(
            window_mod.TAB_TITLES
        )
    finally:
        win.close()


def test_pointing_at_a_repo_brings_the_window_to_life(app, monkeypatch):
    import window as window_mod

    monkeypatch.setattr(window_mod.MainWindow, "_prompt_for_repo", lambda self: None)
    original_root = paths.REPO_ROOT
    monkeypatch.setattr(
        window_mod.MainWindow, "_restore_repo_root", lambda self, override: None
    )
    paths.set_repo_root(None)

    win = window_mod.MainWindow()
    try:
        assert not win.model.ready
        win.set_repo_root(original_root)
        assert win.model.ready
        assert win.build_tab.repo_badge.text() == "found"
        assert win.build_tab.start_button.isEnabled()
        assert win.model.get("app.name")
    finally:
        win.close()


def test_a_non_repo_path_is_refused(app, window, tmp_path, monkeypatch):
    """Typing a wrong path must warn and leave the tool where it was."""
    from PyQt6.QtWidgets import QMessageBox

    warned = []
    monkeypatch.setattr(QMessageBox, "warning", lambda *a, **k: warned.append(a))
    before = paths.REPO_ROOT

    window.build_tab.set_repo_path(tmp_path)
    assert warned
    assert paths.REPO_ROOT == before


# ----- the copy step ------------------------------------------------------


def make_tab(window, tmp_path, platform="desktop"):
    tab = window.build_tab
    tab.platform_buttons[platform].setChecked(True)
    tab.collect_box.setChecked(True)
    tab.output_edit.setText(str(tmp_path / "out"))
    return tab


def test_copy_writes_artifacts_and_checksums(app, window, tmp_path):
    tab = make_tab(window, tmp_path)
    source = tmp_path / "enigma_0.1.0_amd64.deb"
    source.write_bytes(b"payload")

    copied = tab._copy_artifacts([source])

    target = tmp_path / "out" / source.name
    assert copied == [target]
    assert target.read_bytes() == b"payload"

    sums = (tmp_path / "out" / "SHA256SUMS").read_text().strip()
    assert sums == f"{hashlib.sha256(b'payload').hexdigest()}  {source.name}"


def test_android_files_get_the_app_prefix(app, window, tmp_path):
    """Tauri's app-universal-*.apk names are identical between builds."""
    tab = make_tab(window, tmp_path, platform="android")
    source = tmp_path / "app-universal-release-unsigned.apk"
    source.write_bytes(b"apk")

    copied = tab._copy_artifacts([source])
    assert copied[0].name == "enigma-universal-release-unsigned.apk"


def test_copying_onto_itself_is_a_no_op(app, window, tmp_path):
    """Output folder == where the file already is must not truncate it."""
    tab = make_tab(window, tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    source = out / "enigma.deb"
    source.write_bytes(b"payload")

    copied = tab._copy_artifacts([source])
    assert copied == [source]
    assert source.read_bytes() == b"payload"


def test_missing_output_folder_is_created(app, window, tmp_path):
    tab = make_tab(window, tmp_path)
    tab.output_edit.setText(str(tmp_path / "deep" / "nested" / "out"))
    source = tmp_path / "enigma.rpm"
    source.write_bytes(b"x")

    copied = tab._copy_artifacts([source])
    assert copied[0].parent.is_dir()


def test_unwritable_output_folder_reports_instead_of_raising(app, window, tmp_path):
    tab = make_tab(window, tmp_path)
    locked = tmp_path / "locked"
    locked.mkdir()
    os.chmod(locked, 0o500)
    try:
        tab.output_edit.setText(str(locked / "out"))
        source = tmp_path / "enigma.deb"
        source.write_bytes(b"x")

        copied = tab._copy_artifacts([source])
        assert copied == [source]  # unchanged, and the log carries the reason
        assert "cannot create" in tab.log.toPlainText()
    finally:
        os.chmod(locked, 0o700)
