"""Locating and clearing the built app's local data.

This is the only destructive thing the Builder does to something outside the
repo, so the guard on what may be deleted gets more attention than the rest.
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


def test_summary_after_clearing_promises_setup(fake_home):
    appdata.remove("com.example.app", fake_home)  # moved aside
    assert "passphrase setup" in appdata.summary("com.example.app", "default")


# ----- the delete guard ----------------------------------------------------


def test_a_profile_inside_the_root_may_be_cleared(fake_home):
    target = fake_home / "profiles" / "alice"
    assert appdata.is_safe_to_remove("com.example.app", target)
    aside = appdata.remove("com.example.app", target)
    assert not target.exists()
    assert (fake_home / "profiles" / "default").exists()
    # Moved aside, not destroyed.
    assert aside.is_dir()
    assert (aside / "vault.json").is_file()
    assert ".cleared-" in aside.name


def test_the_root_itself_may_be_cleared(fake_home):
    assert appdata.is_safe_to_remove("com.example.app", fake_home)
    aside = appdata.remove("com.example.app", fake_home)
    assert not fake_home.exists()
    assert (aside / "profiles" / "default" / "vault.json").is_file()


def test_clearing_is_reversible_by_renaming_back(fake_home):
    aside = appdata.remove("com.example.app", fake_home)
    assert not appdata.has_vault("com.example.app", "default")
    aside.rename(fake_home)
    assert appdata.has_vault("com.example.app", "default")


def test_a_cleared_directory_is_not_offered_as_a_profile(fake_home):
    appdata.remove("com.example.app", fake_home / "profiles" / "alice")
    assert appdata.profile_names("com.example.app") == ["default"]
    assert [t.key for t in appdata.targets("com.example.app")] == [
        str(fake_home),
        str(fake_home / "profiles" / "default"),
    ]


def test_two_clears_in_the_same_second_do_not_collide(fake_home):
    first = appdata.remove("com.example.app", fake_home / "profiles" / "alice")
    (fake_home / "profiles" / "alice").mkdir()
    second = appdata.remove("com.example.app", fake_home / "profiles" / "alice")
    assert first != second
    assert first.is_dir() and second.is_dir()


def test_purge_only_touches_cleared_directories(fake_home):
    aside = appdata.remove("com.example.app", fake_home / "profiles" / "alice")
    with pytest.raises(ValueError, match="not a cleared-aside"):
        appdata.purge("com.example.app", fake_home / "profiles" / "default")
    appdata.purge("com.example.app", aside)
    assert not aside.exists()


@pytest.mark.parametrize(
    "victim",
    [
        Path.home(),
        Path("/"),
        Path("/etc"),
        Path.home() / ".ssh",
    ],
)
def test_paths_outside_the_root_are_refused(fake_home, victim):
    assert not appdata.is_safe_to_remove("com.example.app", victim)
    with pytest.raises(ValueError, match="refusing to touch"):
        appdata.remove("com.example.app", victim)


def test_a_sibling_identifier_is_refused(fake_home, tmp_path):
    """Clearing one build must never reach another build's data."""
    other = tmp_path / "com.example.other"
    other.mkdir()
    assert not appdata.is_safe_to_remove("com.example.app", other)
    with pytest.raises(ValueError):
        appdata.remove("com.example.app", other)
    assert other.exists()


def test_an_empty_identifier_refuses_everything(fake_home):
    assert not appdata.is_safe_to_remove("", fake_home)
    with pytest.raises(ValueError):
        appdata.remove("", fake_home)
    assert fake_home.exists()


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


def test_clearing_is_available_without_building(app, window):
    """The button is a standalone utility, not a build step."""
    tab = window.build_tab
    assert not tab.is_busy()
    assert tab.clear_data_button.isEnabled() == bool(appdata.targets(tab._identifier()))


def test_the_button_is_disabled_while_a_build_runs(app, window):
    tab = window.build_tab
    tab._set_running(True)
    try:
        assert not tab.clear_data_button.isEnabled()
        assert not tab.appdata_combo.isEnabled()
    finally:
        tab._set_running(False)
    assert tab.clear_data_button.isEnabled() or not appdata.targets(tab._identifier())


def test_cancelling_the_modal_deletes_nothing(app, window, monkeypatch, tmp_path):
    from PyQt6.QtWidgets import QMessageBox

    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    identifier = window.identity_tab.pending_identity().identifier
    root = tmp_path / identifier
    (root / "profiles" / "default").mkdir(parents=True)
    (root / "profiles" / "default" / "vault.json").write_text("{}")

    tab = window.build_tab
    tab._refresh_appdata()
    monkeypatch.setattr(
        QMessageBox, "warning", staticmethod(lambda *a, **k: QMessageBox.StandardButton.Cancel)
    )
    tab._clear_app_data()
    assert root.exists()


def test_confirming_the_modal_clears_the_selection(app, window, monkeypatch, tmp_path):
    from PyQt6.QtWidgets import QMessageBox

    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    identifier = window.identity_tab.pending_identity().identifier
    root = tmp_path / identifier
    (root / "profiles" / "default").mkdir(parents=True)
    (root / "profiles" / "default" / "vault.json").write_text("{}")

    tab = window.build_tab
    tab._refresh_appdata()
    assert tab.appdata_badge.text() == "vault present"

    monkeypatch.setattr(
        QMessageBox, "warning", staticmethod(lambda *a, **k: QMessageBox.StandardButton.Yes)
    )
    monkeypatch.setattr(QMessageBox, "information", staticmethod(lambda *a, **k: None))
    tab._clear_app_data()

    assert not root.exists()
    aside = list(root.parent.glob(f"{identifier}.cleared-*"))
    assert len(aside) == 1, "the data must be moved aside, not destroyed"
    assert (aside[0] / "profiles" / "default" / "vault.json").is_file()
    assert tab.appdata_badge.text() == "clean"
    assert "cleared app data" in tab.log.toPlainText()
