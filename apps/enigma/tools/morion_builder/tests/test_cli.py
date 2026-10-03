"""The Morion Builder's command line: what it resolves and what it would run.

Nothing here builds anything. `run_command` is replaced, so each test sees the
exact argv the builder would hand to bash — the contract with
apps/morion/build.sh and scripts/build_android.sh — and nothing is executed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1]
REPO = TOOL.parents[1]
sys.path.insert(0, str(TOOL))
sys.path.append(str(TOOL.parent / "appbuilder"))

import main  # noqa: E402
import platforms  # noqa: E402


@pytest.fixture
def ran(monkeypatch):
    calls: list[tuple[list[str], Path]] = []

    def fake(command, cwd):
        calls.append((command, Path(cwd)))
        return 0

    monkeypatch.setattr(main, "run_command", fake)
    monkeypatch.delenv("MORION_REPO", raising=False)
    return calls


def test_check_reads_morions_identity_from_the_repo(capsys):
    assert main.main(["morion-builder", "--repo", str(REPO), "--check"]) == 0
    out = capsys.readouterr().out
    assert "Morion (apps/morion)" in out
    # The package name and the identifier the OS files user data under both
    # predate the rename: shown, and unchanged.
    assert "packaged as Zinnia" in out
    assert "com.spectrumaipl.zinnia" in out
    assert "build.sh present" in out


def test_the_repo_is_found_by_walking_up(ran):
    assert main.resolve_root(None) == REPO


def test_a_folder_that_is_not_a_checkout_is_refused(tmp_path):
    with pytest.raises(SystemExit) as stop:
        main.main(["morion-builder", "--repo", str(tmp_path), "--check"])
    assert "has no apps/morion/" in str(stop.value)


def test_build_drives_morions_own_build_sh(ran):
    code = main.main(["morion-builder", "--repo", str(REPO), "build", "--debug", "--no-test"])
    assert code == 0
    command, cwd = ran[0]
    assert command == ["bash", str(REPO / "apps/morion/build.sh"), "--debug", "--no-test"]
    assert cwd == REPO / "apps/morion"


def test_frontend_only_and_bundles_are_passed_through(ran):
    here = next(t.key for t in platforms.TARGETS if t.buildable_here())
    main.main(["morion-builder", "--repo", str(REPO), "build", "--frontend", f"--bundles={here}"])
    assert ran[0][0][-2:] == ["--frontend", f"--bundles={here}"]


def test_a_format_this_host_cannot_make_is_refused_before_anything_runs(ran):
    elsewhere = next((t.key for t in platforms.TARGETS if not t.buildable_here()), None)
    if elsewhere is None:
        pytest.skip("this host can build every format")
    with pytest.raises(SystemExit):
        main.main(["morion-builder", "--repo", str(REPO), "build", f"--bundles={elsewhere}"])
    assert ran == []


def test_android_defaults_to_a_release_apk_for_phones(ran):
    main.main(["morion-builder", "--repo", str(REPO), "android"])
    command, cwd = ran[0]
    assert command == ["bash", str(REPO / "scripts/build_android.sh"), "morion", "release", "aarch64"]
    assert cwd == REPO


def test_the_default_abi_is_one_the_android_script_accepts():
    # scripts/build_android.sh is the authority on ABI names; the builder's
    # default must be one it takes, or every default build fails at once.
    script = (REPO / "scripts/build_android.sh").read_text()
    assert "aarch64|x86_64|armv7|i686" in script
    abi = main.parser().parse_args(["android"]).abi
    assert abi in ("aarch64", "x86_64", "armv7", "i686", "all")


def test_dev_runs_morions_run_dev_sh(ran):
    main.main(["morion-builder", "--repo", str(REPO), "dev", "--web"])
    assert ran[0][0] == ["bash", str(REPO / "apps/morion/run_dev.sh"), "--web"]


def test_targets_needs_no_repo(capsys, monkeypatch):
    monkeypatch.setattr(main, "resolve_root", lambda _: pytest.fail("targets must not need a checkout"))
    assert main.main(["morion-builder", "targets"]) == 0
    assert "building on" in capsys.readouterr().out


def test_there_is_no_app_to_name_any_more():
    with pytest.raises(SystemExit):
        main.parser().parse_args(["build", "morion"])
