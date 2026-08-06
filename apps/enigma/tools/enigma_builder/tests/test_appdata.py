"""Locating the built app's local data, and the reset the Builder delegates.

The reset itself is scripts/reset_profile.sh; the Builder only builds the
command line and decides what to show. The safety property tested here is that
the tool can never *construct* a path outside the app's own data roots.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import appdata


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    """An XDG data home with one populated identifier."""
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    root = tmp_path / "com.example.app"
    for profile in ("default", "alice"):
        directory = root / "profiles" / profile
        directory.mkdir(parents=True)
        (directory / "vault.json").write_text("{}")
        (directory / "chat.db").write_bytes(b"x" * 100)
    (root / "ystore").mkdir()
    (root / "iroh_vox.key").write_bytes(b"k" * 32)
    return root


def test_data_root_follows_xdg_data_home(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert appdata.data_root("com.example.app") == tmp_path / "com.example.app"


def test_data_root_defaults_to_local_share(monkeypatch):
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    assert appdata.data_root("com.example.app") == (
        Path.home() / ".local" / "share" / "com.example.app"
    )


@pytest.mark.parametrize("identifier", ["", "   ", "/", "..", ".", "a/b"])
def test_a_dangerous_identifier_yields_no_root(identifier):
    assert appdata.data_root(identifier) is None


def test_profiles_are_listed(fake_home):
    assert appdata.profile_names("com.example.app") == ["alice", "default"]


def test_vault_presence_is_detected(fake_home):
    assert appdata.has_vault("com.example.app", "default")
    assert not appdata.has_vault("com.example.app", "nobody")


def test_targets_offer_everything_then_each_profile(fake_home):
    found = appdata.targets("com.example.app")
    assert [t.path for t in found] == [
        fake_home,
        fake_home / "profiles" / "alice",
        fake_home / "profiles" / "default",
    ]
    assert found[0].size > found[1].size  # the root includes the profiles
    assert all(t.exists for t in found)
    assert all(t.key for t in found), "each target needs a stable identity"


def test_a_sandboxed_xdg_data_home_does_not_hide_the_real_data(tmp_path, monkeypatch):
    """Regression: VS Code's snap exports its own XDG_DATA_HOME.

    Pointing at the sandbox alone made the tool report "no data yet" while the
    app's real vault sat in ~/.local/share, so Clear app data appeared to do
    nothing on the machine it was most likely to be run from.
    """
    sandbox = tmp_path / "snap" / "code" / "253" / ".local" / "share"
    sandbox.mkdir(parents=True)
    monkeypatch.setenv("XDG_DATA_HOME", str(sandbox))

    real_home = tmp_path / "home"
    monkeypatch.setattr(Path, "home", staticmethod(lambda: real_home))
    real_root = real_home / ".local" / "share" / "com.example.app"
    (real_root / "profiles" / "default").mkdir(parents=True)
    (real_root / "profiles" / "default" / "vault.json").write_text("{}")

    assert appdata.candidate_roots("com.example.app") == [
        sandbox / "com.example.app",
        real_root,
    ]
    assert appdata.existing_roots("com.example.app") == [real_root]
    assert appdata.has_vault("com.example.app", "default")
    assert appdata.profile_names("com.example.app") == ["default"]
    assert [t.path for t in appdata.targets("com.example.app")][0] == real_root


def test_both_roots_are_listed_when_both_exist(tmp_path, monkeypatch):
    other = tmp_path / "other"
    monkeypatch.setenv("XDG_DATA_HOME", str(other))
    real_home = tmp_path / "home"
    monkeypatch.setattr(Path, "home", staticmethod(lambda: real_home))

    for base in (other, real_home / ".local" / "share"):
        (base / "com.example.app" / "profiles" / "default").mkdir(parents=True)

    found = appdata.targets("com.example.app")
    assert len(found) == 4  # root + one profile, twice
    # With two roots the label has to say which one, or the choice is a coin flip.
    assert all("[" in t.label for t in found)


def test_targets_are_empty_when_nothing_was_ever_run(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert appdata.targets("com.example.never") == []


def test_summary_explains_why_the_old_passphrase_works(fake_home):
    text = appdata.summary("com.example.app", "default")
    assert "already exists" in text and "existing passphrase" in text


def test_summary_after_reset_promises_setup(fake_home):
    import shutil

    shutil.rmtree(fake_home)
    assert "passphrase setup" in appdata.summary("com.example.app", "default")


# ----- delegation to scripts/reset_profile.sh -------------------------------


def test_reset_command_calls_the_repo_script():
    import paths

    command = appdata.reset_command(["default"])
    assert command == ["bash", str(paths.RESET_PROFILE_SH), "default"]


def test_reset_command_purge_needs_no_prompt():
    command = appdata.reset_command(["alice", "bob"], purge=True)
    assert command[2:4] == ["--purge", "-y"]
    assert command[-2:] == ["alice", "bob"]


def test_the_reset_script_exists_and_archives_not_deletes():
    """The Builder's promise ("archived, not deleted") is the script's contract."""
    import paths

    text = paths.RESET_PROFILE_SH.read_text()
    assert ".reset-" in text          # the archive suffix appdata looks for
    assert "reject_unsafe" in text    # unsafe profile names are refused there


def test_archived_lists_what_a_reset_left_behind(fake_home):
    (fake_home / "profiles" / "alice").rename(
        fake_home / "profiles" / "alice.reset-20260101-000000"
    )
    found = appdata.archived("com.example.app")
    assert [p.name for p in found] == ["alice.reset-20260101-000000"]


def test_an_archived_profile_is_not_offered_as_a_profile(fake_home):
    (fake_home / "profiles" / "alice").rename(
        fake_home / "profiles" / "alice.reset-20260101-000000"
    )
    assert appdata.profile_names("com.example.app") == ["default"]


# ----- the path guard -------------------------------------------------------


@pytest.mark.parametrize(
    "victim",
    [Path("/"), Path("/etc")],
)
def test_paths_outside_the_root_are_refused(fake_home, victim):
    assert not appdata.is_safe_to_remove("com.example.app", victim)


def test_home_and_ssh_are_refused(fake_home):
    assert not appdata.is_safe_to_remove("com.example.app", Path.home())
    assert not appdata.is_safe_to_remove("com.example.app", Path.home() / ".ssh")


def test_a_profile_inside_the_root_is_allowed(fake_home):
    assert appdata.is_safe_to_remove(
        "com.example.app", fake_home / "profiles" / "alice"
    )


def test_a_sibling_identifier_is_refused(fake_home, tmp_path):
    """One build's reset must never reach another build's data."""
    other = tmp_path / "com.example.other"
    other.mkdir()
    assert not appdata.is_safe_to_remove("com.example.app", other)


def test_an_empty_identifier_refuses_everything(fake_home):
    assert not appdata.is_safe_to_remove("", fake_home)


def test_a_symlink_escaping_the_root_is_refused(fake_home, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    link = fake_home / "escape"
    link.symlink_to(outside)
    # resolve() follows the link, so the guard sees where it really points.
    assert not appdata.is_safe_to_remove("com.example.app", link)


# ----- the GUI --------------------------------------------------------------


def test_the_card_reports_the_real_identifier(app, window):
    tab = window.build_tab
    assert tab._identifier() == window.identity_tab.pending_identity().identifier
    assert tab.appdata_label.text()


def test_profile_defaults_to_default(app, window):
    assert window.build_tab.profile == "default"


def test_stored_profiles_are_offered(app, window, monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    identifier = window.identity_tab.pending_identity().identifier
    for name in ("alice", "bob"):
        (tmp_path / identifier / "profiles" / name).mkdir(parents=True)

    tab = window.build_tab
    tab._refresh_appdata()
    names = [tab.profile_combo.itemText(i) for i in range(tab.profile_combo.count())]
    assert names == ["alice", "bob", "default"] or names == ["default", "alice", "bob"]


def test_test_run_needs_a_binary(app, window, monkeypatch):
    import paths

    tab = window.build_tab
    monkeypatch.setattr(paths, "app_binary", lambda _t: Path("/nonexistent/enigma"))
    tab._refresh_appdata()
    assert not tab.run_button.isEnabled()


def test_test_run_launches_the_binary_with_the_profile(app, window, monkeypatch, tmp_path):
    import paths

    binary = tmp_path / "enigma"
    binary.write_text("#!/bin/sh\n")
    binary.chmod(0o755)
    monkeypatch.setattr(paths, "app_binary", lambda _t: binary)

    captured: list = []
    monkeypatch.setattr(
        type(window.build_tab), "_run_queue", lambda self, steps: captured.extend(steps)
    )
    tab = window.build_tab
    tab.profile_combo.setCurrentText("tester")
    tab._test_run()

    assert [s.label for s in captured] == ["Running"]
    step = captured[0]
    assert step.command == [str(binary)]
    assert step.env["APP_PROFILE"] == "tester"
    assert step.env["CHAT_USER"] == "tester"
    assert step.env["ENIGMA_EDITION"] == "custom"
    assert step.env["RUST_BACKTRACE"] == "1"


def test_reset_first_prepends_the_reset_step(app, window, monkeypatch, tmp_path):
    import paths

    binary = tmp_path / "enigma"
    binary.write_text("#!/bin/sh\n")
    binary.chmod(0o755)
    monkeypatch.setattr(paths, "app_binary", lambda _t: binary)

    captured: list = []
    monkeypatch.setattr(
        type(window.build_tab), "_run_queue", lambda self, steps: captured.extend(steps)
    )
    tab = window.build_tab
    tab.reset_first_box.setChecked(True)
    tab._test_run()

    assert [s.label for s in captured] == ["Resetting profile", "Running"]
    assert captured[0].command[:2] == ["bash", str(paths.RESET_PROFILE_SH)]


def test_reset_button_runs_the_script_after_confirmation(app, window, monkeypatch):
    from PyQt6.QtWidgets import QMessageBox

    import paths

    captured: list = []
    monkeypatch.setattr(
        type(window.build_tab), "_run_queue", lambda self, steps: captured.extend(steps)
    )
    monkeypatch.setattr(
        QMessageBox, "warning", staticmethod(lambda *a, **k: QMessageBox.StandardButton.Yes)
    )
    window.build_tab._reset_profile()
    assert [s.label for s in captured] == ["Resetting profile"]
    assert captured[0].command == ["bash", str(paths.RESET_PROFILE_SH), "default"]


def test_cancelling_the_reset_modal_runs_nothing(app, window, monkeypatch):
    from PyQt6.QtWidgets import QMessageBox

    captured: list = []
    monkeypatch.setattr(
        type(window.build_tab), "_run_queue", lambda self, steps: captured.extend(steps)
    )
    monkeypatch.setattr(
        QMessageBox,
        "warning",
        staticmethod(lambda *a, **k: QMessageBox.StandardButton.Cancel),
    )
    window.build_tab._reset_profile()
    assert captured == []
