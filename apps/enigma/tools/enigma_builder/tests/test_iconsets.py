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


def test_the_shipped_sets_are_discovered():
    found = iconsets.available_sets()
    assert len(found) >= 2, "at least two example sets are meant to ship"
    assert {"skull", "cross", "okti", "okti-glasses", "sun-key", "sun-key2"} <= {
        icon_set.id for icon_set in found
    }


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


def test_the_two_example_sets_look_different():
    """The chooser's whole value is telling them apart in the preview."""
    default = iconsets.load_set("skull")
    mono = iconsets.load_set("cross")
    assert default.master.read_bytes() != mono.master.read_bytes()


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


# ----- the Identity tab's chooser -------------------------------------------


def test_the_default_choice_keeps_the_repo_icons(app, window):
    from identity_tab import KEEP_REPO_ICONS

    tab = window.identity_tab
    assert tab.icon_combo.currentIndex() == 0
    assert tab.icon_combo.currentText() == KEEP_REPO_ICONS
    assert tab.pending_icon() is None
    assert tab.pending_icon_id() is None


def test_every_shipped_set_is_offered(app, window):
    tab = window.identity_tab
    offered = [tab.icon_combo.itemData(i) for i in range(tab.icon_combo.count())]
    assert offered[0] is None
    assert set(offered[1:]) == {s.id for s in iconsets.usable_sets()}


def test_there_is_no_free_form_icon_picker_left(app, window):
    """The whole requirement: a set, not any file on disk."""
    tab = window.identity_tab
    assert not hasattr(tab, "icon_edit")
    assert not hasattr(tab, "_browse_icon")


def test_choosing_a_set_returns_its_master_path(app, window):
    tab = window.identity_tab
    assert tab.select_icon_set("cross") is True
    assert tab.pending_icon_id() == "cross"
    assert tab.pending_icon() == iconsets.load_set("cross").master
    assert tab.pending_icon().is_file()


def test_choosing_keep_repo_icons_returns_none(app, window):
    tab = window.identity_tab
    tab.select_icon_set("skull")
    assert tab.pending_icon() is not None

    tab.select_icon_set("")
    assert tab.pending_icon() is None
    assert tab.pending_icon_id() is None
    assert tab.icon_caption.text() == "current"


def test_the_preview_and_description_follow_the_choice(app, window):
    tab = window.identity_tab
    tab.select_icon_set("skull")
    chosen = iconsets.load_set("skull")
    assert tab.icon_caption.text() == "new"
    assert not tab.icon_preview.pixmap().isNull()
    assert chosen.description in tab.icon_description.text()
    assert "assets/icons/skull/" in tab.icon_description.text()
    assert tab.icon_error.text() == ""


def test_an_unknown_set_id_falls_back_and_says_so(app, window):
    tab = window.identity_tab
    assert tab.select_icon_set("acme-rebrand") is False
    assert tab.pending_icon() is None
    assert "acme-rebrand" in tab.icon_error.text()


def test_an_old_config_that_stored_a_path_still_resolves(app, window):
    """Product configs written before this change name a file, not a set."""
    tab = window.identity_tab
    master = iconsets.load_set("cross").master
    assert tab.select_icon_set(str(master)) is True
    assert tab.pending_icon_id() == "cross"


def test_a_relative_stored_path_is_resolved_against_the_config_folder(app, window):
    tab = window.identity_tab
    master = iconsets.load_set("skull").master
    assert tab.select_icon_set("skull/icon.png", base=master.parent.parent) is True
    assert tab.pending_icon_id() == "skull"


def test_a_path_to_nowhere_falls_back_without_raising(app, window):
    tab = window.identity_tab
    assert tab.select_icon_set("/no/such/place/icon.png") is False
    assert tab.pending_icon() is None
    assert tab.icon_error.text()


def test_reload_reports_a_sets_directory_with_nothing_in_it(
    app, window, tmp_path, monkeypatch
):
    tab = window.identity_tab
    monkeypatch.setenv(iconsets.SETS_ENV_VAR, str(tmp_path / "gone"))
    tab.reload_icon_sets()

    assert tab.icon_combo.count() == 1  # just "keep the repo icons"
    assert tab.pending_icon() is None
    assert "No usable icon sets" in tab.icon_problems.text()


def test_reload_lists_a_broken_set_instead_of_hiding_it(
    app, window, sets_root
):
    tab = window.identity_tab
    make_set(sets_root, "fine", name="Fine")
    make_set(sets_root, "wrecked", name="Wrecked", master=False)
    tab.reload_icon_sets()

    offered = [tab.icon_combo.itemData(i) for i in range(tab.icon_combo.count())]
    assert offered == [None, "fine"]
    assert "wrecked" in tab.icon_problems.text()


def test_reload_keeps_the_current_choice_when_the_set_survives(
    app, window, sets_root
):
    tab = window.identity_tab
    make_set(sets_root, "keeper", name="Keeper")
    tab.reload_icon_sets()
    tab.select_icon_set("keeper")

    tab.reload_icon_sets()
    assert tab.pending_icon_id() == "keeper"


def test_a_set_that_disappeared_between_reloads_is_reported(
    app, window, sets_root
):
    tab = window.identity_tab
    make_set(sets_root, "doomed", name="Doomed")
    tab.reload_icon_sets()
    tab.select_icon_set("doomed")

    (sets_root / "doomed" / "icon.png").unlink()
    (sets_root / "doomed" / iconsets.METADATA_NAME).unlink()
    (sets_root / "doomed").rmdir()
    tab.reload_icon_sets()

    assert tab.pending_icon() is None
    assert "doomed" in tab.icon_error.text()


# ----- the product config round trip ----------------------------------------


def test_saving_records_the_set_id_not_a_machine_path(app, window, tmp_path):
    window.identity_tab.select_icon_set("cross")
    window.product_file = tmp_path / "p.yaml"
    saved = window._save_product()

    text = saved.read_text(encoding="utf-8")
    assert "icon: cross" in text
    # No absolute path anywhere: the same file must mean "mono" on any machine.
    assert "assets/icons" not in text
    assert str(tmp_path) not in text


def test_loading_a_product_restores_the_chosen_set(app, window, tmp_path):
    window.identity_tab.select_icon_set("skull")
    window.product_file = tmp_path / "p.yaml"
    saved = window._save_product()

    window.identity_tab.select_icon_set("cross")
    assert window.load_product(saved) is True
    assert window.identity_tab.pending_icon_id() == "skull"


def test_loading_a_product_without_branding_clears_the_choice(app, window, tmp_path):
    window.identity_tab.select_icon_set("cross")
    window.product_file = tmp_path / "p.yaml"
    saved = window._save_product()

    # Strip the Builder-owned branding block, as a hand-written config would be.
    saved.write_text(
        saved.read_text(encoding="utf-8").split("\n# ── product-config extras")[0],
        encoding="utf-8",
    )
    assert window.load_product(saved) is True
    assert window.identity_tab.pending_icon_id() is None
