"""Curated icon sets: discovery, validation, and the Identity tab's chooser.

The point of the feature is that the choice is *closed* — a build engineer
picks one of the sets shipped in ``assets/icons/`` and cannot point the Builder
at an arbitrary file. So these tests care about two things above all: that the
sets actually shipped are usable (a broken one would silently narrow the menu),
and that a malformed set is reported rather than crashing the window on the way
up.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import iconsets
import icons as icons_mod

from test_icons import write_png


@pytest.fixture
def sets_root(tmp_path, monkeypatch) -> Path:
    """Redirect discovery at a temp directory of hand-built sets."""
    root = tmp_path / "icons"
    root.mkdir()
    monkeypatch.setenv(iconsets.SETS_ENV_VAR, str(root))
    return root


def make_set(root: Path, set_id: str, *, name: str | None = "A Set",
             description: str = "", author: str = "", version: int = 1,
             side: int = 1024, master: bool = True,
             metadata: bool = True) -> Path:
    directory = root / set_id
    directory.mkdir(parents=True, exist_ok=True)
    if master:
        write_png(directory / "icon.png", side)
    if metadata:
        payload: dict = {"description": description, "author": author,
                         "version": version}
        if name is not None:
            payload["name"] = name
        (directory / iconsets.METADATA_NAME).write_text(
            json.dumps(payload), encoding="utf-8"
        )
    return directory


# ----- the sets that actually ship -----------------------------------------


def test_the_shipped_set_is_discovered():
    """One mark ships, and it is the one the Builder is pinned to."""
    found = {icon_set.id for icon_set in iconsets.available_sets()}
    assert iconsets.FIXED_SET_ID in found


def test_every_shipped_set_is_valid():
    """A set that fails icons.validate_source would be offered and then reject
    the build — catch it here instead."""
    for icon_set in iconsets.available_sets():
        assert icon_set.master is not None, f"{icon_set.id} has no master image"
        errors, _warnings = icons_mod.validate_source(icon_set.master)
        assert errors == [], f"{icon_set.id}: {errors}"
        assert icon_set.problems == (), f"{icon_set.id}: {icon_set.problems}"
        assert icon_set.ok


def test_shipped_masters_are_square_and_large_enough():
    for icon_set in iconsets.available_sets():
        size = icons_mod.png_size(icon_set.master)
        assert size is not None, f"{icon_set.id} is not a readable PNG"
        assert size[0] == size[1]
        assert size[0] >= icons_mod.RECOMMENDED_SIDE


def test_shipped_sets_carry_real_metadata():
    for icon_set in iconsets.available_sets():
        assert icon_set.name and icon_set.name != icon_set.id
        assert icon_set.description
        assert icon_set.version == 1


def test_the_fixed_set_resolves_to_a_real_master_image():
    chosen = iconsets.fixed_set()
    assert chosen is not None and chosen.ok
    assert chosen.master.is_file() and chosen.master.stat().st_size > 0


# ----- discovery ------------------------------------------------------------


def test_sets_are_sorted_by_display_name(sets_root):
    make_set(sets_root, "zulu", name="Alpha")
    make_set(sets_root, "alpha", name="Zulu")
    make_set(sets_root, "mike", name="Mike")
    assert [s.id for s in iconsets.available_sets()] == ["zulu", "mike", "alpha"]


def test_the_id_breaks_a_name_tie(sets_root):
    make_set(sets_root, "b", name="Same")
    make_set(sets_root, "a", name="Same")
    assert [s.id for s in iconsets.available_sets()] == ["a", "b"]


def test_a_missing_assets_directory_is_empty_not_a_crash(tmp_path, monkeypatch):
    monkeypatch.setenv(iconsets.SETS_ENV_VAR, str(tmp_path / "not-there"))
    assert iconsets.available_sets() == []
    assert iconsets.usable_sets() == []
    assert iconsets.problem_report() == []
    # sets_dir still names somewhere, so the GUI can say where it looked.
    assert iconsets.sets_dir() == tmp_path / "not-there"


def test_loose_files_beside_the_sets_are_ignored(sets_root):
    make_set(sets_root, "real")
    (sets_root / "README.txt").write_text("not a set", encoding="utf-8")
    (sets_root / "_wip").mkdir()
    (sets_root / ".hidden").mkdir()
    assert [s.id for s in iconsets.available_sets()] == ["real"]


def test_load_set_by_id(sets_root):
    make_set(sets_root, "brand", name="Brand", description="d", author="a")
    loaded = iconsets.load_set("brand")
    assert loaded.id == "brand"
    assert loaded.name == "Brand"
    assert loaded.description == "d"
    assert loaded.credit == "by a"
    assert loaded.master == sets_root / "brand" / "icon.png"


def test_load_set_returns_none_for_an_unknown_id(sets_root):
    make_set(sets_root, "brand")
    assert iconsets.load_set("nope") is None
    assert iconsets.load_set("") is None


def test_load_set_refuses_to_escape_the_sets_directory(sets_root):
    """A product config is data; it must not be able to name ../../anything."""
    assert iconsets.load_set("../secrets") is None
    assert iconsets.load_set("..") is None
    assert iconsets.load_set("a/b") is None


def test_an_svg_master_is_accepted(sets_root):
    directory = make_set(sets_root, "vector", name="Vector", master=False)
    (directory / "icon.svg").write_text(
        "<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8"
    )
    loaded = iconsets.load_set("vector")
    assert loaded.ok
    assert loaded.master.name == "icon.svg"


# ----- broken sets are reported, never fatal --------------------------------


def test_a_set_with_no_master_image_is_reported(sets_root):
    make_set(sets_root, "empty", master=False)
    broken = iconsets.load_set("empty")
    assert not broken.ok
    assert broken.master is None
    assert any("master image" in problem for problem in broken.problems)
    # Still discovered, so the GUI can explain it.
    assert [s.id for s in iconsets.available_sets()] == ["empty"]
    assert iconsets.usable_sets() == []
    assert iconsets.problem_report() == [
        "empty: no master image — expected icon.png or icon.svg"
    ]


def test_a_set_with_no_metadata_is_reported(sets_root):
    make_set(sets_root, "nameless", metadata=False)
    broken = iconsets.load_set("nameless")
    assert not broken.ok
    assert broken.problems == ("set.json is missing",)
    # It still has a usable display name to show in the problem list.
    assert broken.name == "nameless"


def test_unreadable_metadata_is_reported(sets_root):
    make_set(sets_root, "bad")
    (sets_root / "bad" / iconsets.METADATA_NAME).write_text("{oops", encoding="utf-8")
    broken = iconsets.load_set("bad")
    assert not broken.ok
    assert any("not valid JSON" in problem for problem in broken.problems)


def test_metadata_that_is_not_an_object_is_reported(sets_root):
    make_set(sets_root, "listy")
    (sets_root / "listy" / iconsets.METADATA_NAME).write_text("[]", encoding="utf-8")
    assert any("JSON object" in p for p in iconsets.load_set("listy").problems)


def test_metadata_without_a_name_is_reported(sets_root):
    make_set(sets_root, "anon", name=None)
    broken = iconsets.load_set("anon")
    assert not broken.ok
    assert any('"name"' in problem for problem in broken.problems)


def test_a_future_schema_version_is_reported_not_guessed_at(sets_root):
    make_set(sets_root, "ahead", name="Ahead", version=iconsets.SCHEMA_VERSION + 1)
    broken = iconsets.load_set("ahead")
    assert not broken.ok
    assert any("understands" in problem for problem in broken.problems)


def test_a_bad_version_value_is_reported(sets_root):
    make_set(sets_root, "zero", name="Zero", version=0)
    assert any("positive integer" in p for p in iconsets.load_set("zero").problems)


def test_an_undersized_master_is_reported_through_icons_validate(sets_root):
    """The image rules live in icons.py; iconsets must not grow a second copy."""
    make_set(sets_root, "tiny", name="Tiny", side=64)
    broken = iconsets.load_set("tiny")
    assert not broken.ok
    assert any("at least" in problem for problem in broken.problems)


def test_a_merely_small_master_warns_without_being_rejected(sets_root):
    make_set(sets_root, "small", name="Small", side=icons_mod.MIN_SIDE)
    loaded = iconsets.load_set("small")
    assert loaded.ok
    assert any("recommended" in warning for warning in loaded.warnings)


def test_read_set_on_a_directory_that_is_not_there(tmp_path):
    described = iconsets.read_set(tmp_path / "ghost")
    assert not described.ok
    assert described.problems == ("the set directory is missing",)


def test_a_broken_set_does_not_hide_the_good_ones(sets_root):
    make_set(sets_root, "good", name="Good")
    make_set(sets_root, "broken", name="Broken", master=False)
    assert [s.id for s in iconsets.usable_sets()] == ["good"]
    assert [s.id for s in iconsets.broken_sets()] == ["broken"]


# ----- where the sets are looked for ----------------------------------------


def test_the_env_override_wins_over_the_bundled_sets(sets_root):
    make_set(sets_root, "only", name="Only")
    assert [s.id for s in iconsets.available_sets()] == ["only"]
    assert iconsets.sets_dir() == sets_root


def test_the_bundled_directory_is_the_default(monkeypatch):
    monkeypatch.delenv(iconsets.SETS_ENV_VAR, raising=False)
    expected = Path(iconsets.__file__).resolve().parent / "assets" / "icons"
    assert iconsets.sets_dir() == expected


def test_a_frozen_build_reads_from_the_pyinstaller_unpack_dir(tmp_path, monkeypatch):
    """One-file PyInstaller unpacks --add-data into _MEIPASS, which is NOT the
    directory paths._bundle_dir() resolves. Getting this wrong ships a Builder
    with no icons at all."""
    monkeypatch.delenv(iconsets.SETS_ENV_VAR, raising=False)
    monkeypatch.setattr(iconsets.sys, "frozen", True, raising=False)
    monkeypatch.setattr(iconsets.sys, "_MEIPASS", str(tmp_path), raising=False)
    (tmp_path / "assets" / "icons").mkdir(parents=True)
    make_set(tmp_path / "assets" / "icons", "packed", name="Packed")

    assert iconsets.sets_dir() == tmp_path / "assets" / "icons"
    assert [s.id for s in iconsets.available_sets()] == ["packed"]


def test_a_frozen_build_also_looks_beside_the_executable(tmp_path, monkeypatch):
    """So an engineer can drop one more set next to the binary."""
    monkeypatch.delenv(iconsets.SETS_ENV_VAR, raising=False)
    monkeypatch.setattr(iconsets.sys, "frozen", True, raising=False)
    monkeypatch.setattr(iconsets.sys, "_MEIPASS", str(tmp_path / "unpacked"),
                        raising=False)
    monkeypatch.setattr(iconsets.sys, "executable", str(tmp_path / "bin" / "builder"))
    (tmp_path / "bin" / "assets" / "icons").mkdir(parents=True)

    assert iconsets.sets_dir() == tmp_path / "bin" / "assets" / "icons"


# ----- the Identity tab: one fixed icon, announced not chosen ---------------


def test_the_app_icon_is_fixed_not_chosen(app, window):
    """The icon belongs to the product's identity, like its name and version.
    There is no chooser, and no way to point at anything else."""
    tab = window.identity_tab
    assert not hasattr(tab, "icon_combo")
    # And nothing in the tab opens a file dialog for an icon.
    source = Path("identity_tab.py").read_text(encoding="utf-8")
    assert "QFileDialog" not in source


def test_the_fixed_icon_is_the_one_that_ships(app, window):
    tab = window.identity_tab
    assert tab.pending_icon_id() == iconsets.FIXED_SET_ID
    assert tab.pending_icon() == iconsets.load_set(iconsets.FIXED_SET_ID).master


def test_the_builder_announces_which_icon_it_will_ship(app, window):
    """A build engineer cannot choose it, so they must at least SEE it."""
    tab = window.identity_tab
    chosen = iconsets.load_set(iconsets.FIXED_SET_ID)
    assert tab.icon_name.text() == chosen.name
    assert chosen.description in tab.icon_description.text()
    assert f"assets/icons/{chosen.id}/" in tab.icon_description.text()
    assert not tab.icon_preview.pixmap().isNull()
    assert tab.icon_error.text() == ""


def test_the_shipped_icon_passes_the_same_validation_a_build_runs(app, window):
    chosen = iconsets.load_set(iconsets.FIXED_SET_ID)
    errors, _warnings = icons_mod.validate_source(chosen.master)
    assert errors == [], f"the one icon we ship must be buildable: {errors}"


def test_a_missing_fixed_set_is_reported_and_keeps_the_repo_icons(
    app, window, tmp_path, monkeypatch
):
    """If the set is deleted the build must fall back visibly, not silently."""
    monkeypatch.setenv(iconsets.SETS_ENV_VAR, str(tmp_path / "gone"))
    tab = window.identity_tab
    tab.reload_icon_sets()
    assert tab.pending_icon() is None            # nothing to regenerate from
    assert iconsets.FIXED_SET_ID in tab.icon_problems.text()
    assert tab.icon_problems.text().strip()


# ----- the product config round trip ----------------------------------------


def test_saving_records_the_fixed_set_id_not_a_machine_path(app, window, tmp_path):
    window.product_file = tmp_path / "p.yaml"
    saved = window._save_product()

    text = saved.read_text(encoding="utf-8")
    assert f"icon: {iconsets.FIXED_SET_ID}" in text
    # No absolute path anywhere: the file must mean the same on any machine.
    assert "assets/icons" not in text
    assert str(tmp_path) not in text


def test_a_config_naming_another_icon_is_reported_not_obeyed(app, window):
    """Configs written when the icon WAS a choice still name one. Building a
    different brand than the config asked for is worth saying out loud."""
    tab = window.identity_tab
    assert tab.select_icon_set("some-other-mark") is False
    assert "some-other-mark" in tab.icon_error.text()
    assert iconsets.FIXED_SET_ID in tab.icon_error.text()
    # ...and it still ships the fixed icon.
    assert tab.pending_icon_id() == iconsets.FIXED_SET_ID


def test_a_config_naming_the_fixed_icon_is_accepted_quietly(app, window):
    tab = window.identity_tab
    assert tab.select_icon_set(iconsets.FIXED_SET_ID) is True
    assert tab.icon_error.text() == ""


def test_a_product_round_trip_keeps_the_icon(app, window, tmp_path):
    window.product_file = tmp_path / "p.yaml"
    saved = window._save_product()
    assert window.load_product(saved) is True
    assert window.identity_tab.pending_icon_id() == iconsets.FIXED_SET_ID
