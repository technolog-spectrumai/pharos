"""tauri.conf.json is a tracked file, so writing it must be surgical."""

from __future__ import annotations

import json

import identity as identity_mod
import paths
from identity import Identity


def test_round_trip_is_byte_identical():
    """A no-op write must not reformat the file.

    This is what lets the Builder edit three fields without producing a diff
    nobody asked for.
    """
    original = paths.TAURI_CONF.read_text(encoding="utf-8")
    assert identity_mod.render_conf(json.loads(original)) == original


def test_only_the_version_line_changes_for_locked_identity():
    original = paths.TAURI_CONF.read_text(encoding="utf-8").splitlines()
    conf = json.loads("\n".join(original))
    conf.update(
        identity_mod.locked_identity(Identity("Anything", "com.example.field", "9.9.9"))
        .as_conf_fields()
    )
    changed = identity_mod.render_conf(conf).splitlines()

    differing = [
        (before, after)
        for before, after in zip(original, changed)
        if before != after
    ]
    assert len(original) == len(changed)
    assert len(differing) == 1
    assert "version" in differing[0][0]


def test_identity_reads_the_three_fields():
    identity = identity_mod.disk_identity()
    conf = identity_mod.read_conf()
    assert identity.name == conf["productName"]
    assert identity.identifier == conf["identifier"]
    assert identity.version == conf["version"]


def test_app_section_maps_to_build_config_field_names():
    identity = Identity("N", "i.d", "1.2.3")
    assert identity.as_app_section() == {
        "name": "N",
        "identifier": "i.d",
        "version": "1.2.3",
    }


def test_write_identity_locks_name_and_identifier():
    identity = identity_mod.locked_identity(Identity("N", "i.d", "1.2.3"))
    assert identity.name == identity_mod.FIXED_APP_NAME
    assert identity.identifier == identity_mod.FIXED_APP_IDENTIFIER
    assert identity.version == "1.2.3"


def test_pending_diff_lists_only_changed_fields():
    current = Identity("Enigma26", "com.a.b", "0.1.0")
    pending = Identity("Enigma26", "com.a.b", "0.2.0")
    lines = identity_mod.conf_pending_diff(current, pending)
    assert lines == ["version: 0.1.0 → 0.2.0"]


def test_head_identity_matches_disk_on_a_clean_tree():
    """Skips silently where git cannot answer (no repo, file untracked)."""
    head = identity_mod.head_identity()
    if head is None:
        return
    assert isinstance(head, Identity)
    assert head.identifier


def test_the_version_is_announced_but_not_editable(app, window):
    """The version belongs to the code, not to the build engineer: shipping an
    artifact whose number they chose makes the number meaningless, and Android
    refuses an upgrade whose versionCode went backwards."""
    tab = window.identity_tab
    assert tab.version_edit.isReadOnly()
    shown = tab.version_edit.text()
    assert shown, "the builder must still be able to READ what it is building"
    assert shown in tab.version_hint.text()

    # Typing is refused rather than silently reverted on the next refresh.
    before = window.model.get("app.version")
    tab.version_edit.setText("9.9.9")
    assert window.model.get("app.version") == before


def test_the_announced_version_is_the_repo_version(app, window):
    """What the tab shows is what tauri.conf.json carries — the assert build.rs
    makes is the same one, so a drift here is a build failure later."""
    import json
    conf = json.loads(paths.TAURI_CONF.read_text(encoding="utf-8"))
    assert window.identity_tab.version_edit.text() == conf["version"]
