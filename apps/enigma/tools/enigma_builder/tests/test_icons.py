"""Icon validation, the Android mirror, and the snapshot/restore round trip.

The restore path matters most: regenerating icons rewrites roughly 90 tracked
files, and the Builder promises to put every one of them back.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import pytest

import icons as icons_mod
import paths


def write_png(path: Path, side: int, colour: tuple[int, int, int] = (200, 30, 90),
              height: int | None = None) -> Path:
    """A minimal valid RGB PNG, so tests need no image library."""
    rows = height if height is not None else side
    raw = b"".join(b"\x00" + bytes(colour) * side for _ in range(rows))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", side, rows, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    return path


# ----- reading the source -------------------------------------------------


def test_png_size_reads_the_header(tmp_path):
    path = write_png(tmp_path / "a.png", 1024)
    assert icons_mod.png_size(path) == (1024, 1024)


def test_png_size_rejects_a_non_png(tmp_path):
    path = tmp_path / "not.png"
    path.write_bytes(b"just text")
    assert icons_mod.png_size(path) is None


def test_a_good_icon_passes(tmp_path):
    errors, warnings_ = icons_mod.validate_source(write_png(tmp_path / "i.png", 1024))
    assert errors == []
    assert warnings_ == []


def test_a_small_but_usable_icon_warns_without_blocking(tmp_path):
    errors, warnings_ = icons_mod.validate_source(write_png(tmp_path / "i.png", 512))
    assert errors == []
    assert warnings_ and "recommended" in warnings_[0]


def test_too_small_is_an_error(tmp_path):
    errors, _ = icons_mod.validate_source(write_png(tmp_path / "i.png", 256))
    assert errors and "at least" in errors[0]


def test_non_square_is_an_error(tmp_path):
    path = write_png(tmp_path / "wide.png", 1024, height=512)
    errors, _ = icons_mod.validate_source(path)
    assert errors and "square" in errors[0]


def test_missing_file_is_an_error(tmp_path):
    errors, _ = icons_mod.validate_source(tmp_path / "nope.png")
    assert errors and "does not exist" in errors[0]


def test_wrong_extension_is_an_error(tmp_path):
    path = tmp_path / "icon.jpg"
    path.write_bytes(b"\xff\xd8\xff")
    errors, _ = icons_mod.validate_source(path)
    assert errors and "PNG or SVG" in errors[0]


def test_svg_is_accepted_without_measuring(tmp_path):
    path = tmp_path / "icon.svg"
    path.write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    assert icons_mod.validate_source(path) == ([], [])


def test_icon_command_passes_an_absolute_path(tmp_path):
    source = write_png(tmp_path / "i.png", 1024)
    command = icons_mod.icon_command(source)
    assert command[:3] == ["npx", "tauri", "icon"]
    assert Path(command[3]).is_absolute()


# ----- snapshot and restore ------------------------------------------------


def test_the_repo_has_icons_to_snapshot():
    found = icons_mod.tracked_icon_files()
    assert len(found) > 50, "expected the generated icon set to be present"
    assert any(p.name == "icon.icns" for p in found)
    assert any("mipmap" in str(p) for p in found)


def test_snapshot_then_restore_is_byte_identical(tmp_path):
    saved = icons_mod.snapshot()
    assert saved

    victim = icons_mod.icons_dir() / "32x32.png"
    original = victim.read_bytes()
    try:
        victim.write_bytes(b"clobbered")
        assert victim.read_bytes() != original

        restored = icons_mod.restore(saved)
        assert restored == 1  # only the file that actually changed
        assert victim.read_bytes() == original
    finally:
        victim.write_bytes(original)


def test_restore_recreates_a_deleted_file():
    saved = icons_mod.snapshot()
    victim = icons_mod.icons_dir() / "32x32.png"
    original = victim.read_bytes()
    try:
        victim.unlink()
        icons_mod.restore(saved)
        assert victim.read_bytes() == original
    finally:
        victim.write_bytes(original)


def test_restore_is_a_no_op_when_nothing_moved():
    assert icons_mod.restore(icons_mod.snapshot()) == 0


# ----- the Android mirror --------------------------------------------------


def test_android_trees_are_separate_paths():
    """The generated project keeps its own copy — that is why the sync exists."""
    assert icons_mod.android_icons_dir() != icons_mod.android_res_dir()
    assert icons_mod.android_res_dir().is_relative_to(paths.ANDROID_GEN)


@pytest.mark.skipif(
    not icons_mod.android_res_dir().is_dir(),
    reason="no generated Android project in this checkout",
)
def test_sync_copies_the_launcher_icons_and_can_be_undone():
    saved = icons_mod.snapshot()
    source = icons_mod.android_icons_dir() / "mipmap-hdpi" / "ic_launcher.png"
    target = icons_mod.android_res_dir() / "mipmap-hdpi" / "ic_launcher.png"
    before = target.read_bytes()
    try:
        copied = icons_mod.sync_android_icons()
        assert copied >= 12  # five densities x three files, plus the xml
        assert target.read_bytes() == source.read_bytes()
    finally:
        icons_mod.restore(saved)
    assert target.read_bytes() == before


def test_sync_reports_zero_without_a_generated_project(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "ANDROID_GEN", tmp_path / "absent")
    assert icons_mod.sync_android_icons() == 0


def test_recovery_hint_names_both_trees():
    hint = icons_mod.recovery_hint()
    assert "src-tauri/icons" in hint
    assert "gen/android" in hint


# ----- the GUI wiring ------------------------------------------------------


def capture_steps(window, monkeypatch):
    """Run _start up to the point of launching, and return the queued steps."""
    from PyQt6.QtWidgets import QMessageBox

    captured: list = []
    monkeypatch.setattr(
        type(window.build_tab), "_run_queue", lambda self, steps: captured.extend(steps)
    )
    monkeypatch.setattr(
        QMessageBox, "question", staticmethod(lambda *a, **k: QMessageBox.StandardButton.Yes)
    )
    window.build_tab._start()
    return captured


def test_no_icon_chosen_means_no_icon_step(app, window, monkeypatch):
    assert window.identity_tab.pending_icon() is None
    steps = capture_steps(window, monkeypatch)
    assert [s.label for s in steps] == ["Building"]


def test_choosing_an_icon_prepends_a_generation_step(app, window, monkeypatch):
    import iconsets

    source = iconsets.load_set("default").master
    window.identity_tab.select_icon_set("default")
    assert window.identity_tab.pending_icon() == source

    steps = capture_steps(window, monkeypatch)
    assert [s.label for s in steps] == ["Generating icons", "Building"]

    icon_step = steps[0]
    assert icon_step.command[:3] == ["npx", "tauri", "icon"]
    # The CLI locates tauri.conf.json from its working directory.
    assert icon_step.cwd == paths.APP_DIR
    assert icon_step.after is not None
    # The build itself still runs from the repo root with the custom edition.
    assert steps[1].cwd == paths.REPO_ROOT
    assert steps[1].env["ENIGMA_EDITION"] == paths.CUSTOM_EDITION


def test_a_snapshot_is_taken_before_the_icon_step(app, window, monkeypatch):
    window.identity_tab.select_icon_set("default")
    capture_steps(window, monkeypatch)
    assert len(window.build_tab._icon_snapshot) > 50


def test_an_unusable_icon_blocks_the_build(app, window, monkeypatch, tmp_path):
    from PyQt6.QtWidgets import QMessageBox

    # No icon SET can be too small — every shipped set is validated at
    # discovery and unusable ones are never offered. What is still reachable is
    # a set whose master went bad after the window opened (an edited checkout,
    # a sets directory on a stale mount), so drive that state directly: the
    # build's own re-check is the last line of defence and must hold.
    tiny = write_png(tmp_path / "tiny.png", 64)
    monkeypatch.setattr(
        type(window.identity_tab), "pending_icon", lambda self: tiny
    )

    shown: list = []
    monkeypatch.setattr(QMessageBox, "critical", staticmethod(lambda *a, **k: shown.append(a)))
    # _start() asks about free disk before it ever reaches the icon check, so a
    # machine under the 20 GB warning threshold would block here forever on a
    # modal nobody can answer. Answering it keeps this test about the icon.
    monkeypatch.setattr(
        QMessageBox, "question", staticmethod(lambda *a, **k: QMessageBox.StandardButton.Yes)
    )
    captured: list = []
    monkeypatch.setattr(
        type(window.build_tab), "_run_queue", lambda self, steps: captured.extend(steps)
    )
    window.build_tab._start()

    assert shown, "expected a dialog explaining why the icon cannot be used"
    assert captured == [], "nothing should have been queued"


def test_the_preview_shows_the_repo_icon_by_default(app, window):
    assert window.identity_tab.icon_caption.text() == "current"
    assert not window.identity_tab.icon_preview.pixmap().isNull()


def test_the_preview_switches_to_the_chosen_set(app, window):
    window.identity_tab.select_icon_set("default")
    assert window.identity_tab.icon_caption.text() == "new"
    assert not window.identity_tab.icon_preview.pixmap().isNull()

    window.identity_tab.select_icon_set("")
    assert window.identity_tab.icon_caption.text() == "current"
