"""Package-name guessing, the installed-state queries, and the pkexec command."""

from __future__ import annotations

import pytest

import uninstall


class _Result:
    def __init__(self, returncode: int, stdout: str) -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""


# ----- naming ---------------------------------------------------------------


@pytest.mark.parametrize(
    "product,expected",
    [
        ("Enigma", "enigma"),
        ("My App", "my-app"),
        ("MyApp", "my-app"),
        ("my.app_2", "my-app-2"),
        ("  Enigma  ", "enigma"),
    ],
)
def test_kebab_matches_tauri_package_naming(product, expected):
    assert uninstall.kebab(product) == expected


def test_candidates_are_unique_and_lead_with_the_kebab_name():
    names = uninstall.candidates("Enigma")
    assert names[0] == "enigma"
    assert len(names) == len(set(names))


def test_candidates_fall_back_to_the_app_slug():
    assert uninstall.candidates("") == ["enigma"]


# ----- detection ------------------------------------------------------------


def _fake_which(available: dict[str, str]):
    return lambda name: available.get(name)


def test_an_installed_deb_is_found(monkeypatch):
    monkeypatch.setattr(
        uninstall.shutil, "which", _fake_which({"dpkg-query": "/usr/bin/dpkg-query"})
    )
    monkeypatch.setattr(
        uninstall.subprocess,
        "run",
        lambda *a, **k: _Result(0, "installed\t1.2.3"),
    )
    assert uninstall.installed_package("Enigma") == uninstall.Installed(
        "deb", "enigma", "1.2.3"
    )


def test_a_removed_deb_with_leftover_config_does_not_count(monkeypatch):
    """dpkg-query answers for these too; the status field is what decides."""
    monkeypatch.setattr(
        uninstall.shutil, "which", _fake_which({"dpkg-query": "/usr/bin/dpkg-query"})
    )
    monkeypatch.setattr(
        uninstall.subprocess,
        "run",
        lambda *a, **k: _Result(0, "config-files\t1.2.3"),
    )
    assert uninstall.installed_package("Enigma") is None


def test_an_installed_rpm_is_found(monkeypatch):
    monkeypatch.setattr(
        uninstall.shutil, "which", _fake_which({"rpm": "/usr/bin/rpm"})
    )
    monkeypatch.setattr(
        uninstall.subprocess, "run", lambda *a, **k: _Result(0, "1.2.3-1")
    )
    assert uninstall.installed_package("Enigma") == uninstall.Installed(
        "rpm", "enigma", "1.2.3-1"
    )


def test_nothing_installed_means_none(monkeypatch):
    monkeypatch.setattr(
        uninstall.shutil,
        "which",
        _fake_which({"dpkg-query": "/usr/bin/dpkg-query", "rpm": "/usr/bin/rpm"}),
    )
    monkeypatch.setattr(
        uninstall.subprocess, "run", lambda *a, **k: _Result(1, "")
    )
    assert uninstall.installed_package("Enigma") is None


# ----- the removal command --------------------------------------------------


def test_deb_removal_prefers_apt_get(monkeypatch):
    monkeypatch.setattr(
        uninstall.shutil,
        "which",
        _fake_which({"pkexec": "/usr/bin/pkexec", "apt-get": "/usr/bin/apt-get"}),
    )
    assert uninstall.remove_command("deb", "enigma") == [
        "/usr/bin/pkexec", "/usr/bin/apt-get", "remove", "-y", "enigma",
    ]


def test_rpm_removal_prefers_dnf(monkeypatch):
    monkeypatch.setattr(
        uninstall.shutil,
        "which",
        _fake_which({"pkexec": "/usr/bin/pkexec", "dnf": "/usr/bin/dnf"}),
    )
    assert uninstall.remove_command("rpm", "enigma") == [
        "/usr/bin/pkexec", "/usr/bin/dnf", "remove", "-y", "enigma",
    ]


def test_no_pkexec_means_no_command_and_a_manual_hint(monkeypatch):
    monkeypatch.setattr(uninstall.shutil, "which", _fake_which({}))
    assert uninstall.remove_command("deb", "enigma") is None
    assert uninstall.manual_hint("deb", "enigma") == "sudo apt-get remove enigma"
    assert uninstall.manual_hint("rpm", "enigma") == "sudo dnf remove enigma"


# ----- the GUI --------------------------------------------------------------


def test_the_button_enables_when_a_package_is_installed(app, window, monkeypatch):
    tab = window.build_tab
    monkeypatch.setattr(
        uninstall,
        "installed_package",
        lambda name: uninstall.Installed("deb", "enigma", "1.2.3"),
    )
    tab._uninstall_cache = None
    tab._refresh_uninstall()
    assert tab.uninstall_button.isEnabled()
    assert "1.2.3" in tab.uninstall_label.text()
    assert tab.uninstall_badge.text() == "deb installed"


def test_the_button_stays_disabled_when_nothing_is_installed(app, window, monkeypatch):
    tab = window.build_tab
    monkeypatch.setattr(uninstall, "installed_package", lambda name: None)
    tab._uninstall_cache = None
    tab._refresh_uninstall()
    assert not tab.uninstall_button.isEnabled()
    assert tab.uninstall_badge.text() == "not installed"


def test_the_query_is_cached_per_product_name(app, window, monkeypatch):
    tab = window.build_tab
    calls: list[str] = []

    def probe(name):
        calls.append(name)
        return None

    monkeypatch.setattr(uninstall, "installed_package", probe)
    tab._uninstall_cache = None
    tab._refresh_uninstall()
    tab._refresh_uninstall()
    assert len(calls) == 1
