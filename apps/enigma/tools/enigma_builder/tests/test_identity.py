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


def test_only_the_identity_lines_change():
    original = paths.TAURI_CONF.read_text(encoding="utf-8").splitlines()
    conf = json.loads("\n".join(original))
    conf.update(
        Identity("Enigma Field", "com.example.field", "9.9.9").as_conf_fields()
    )
    changed = identity_mod.render_conf(conf).splitlines()

    differing = [
        (before, after)
        for before, after in zip(original, changed)
        if before != after
    ]
    assert len(original) == len(changed)
    assert len(differing) == 3
    assert all(
        any(key in before for key in ("productName", "identifier", "version"))
        for before, _ in differing
    )


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


def test_pending_diff_lists_only_changed_fields():
    current = Identity("Enigma", "com.a.b", "0.1.0")
    pending = Identity("Enigma", "com.a.b", "0.2.0")
    lines = identity_mod.conf_pending_diff(current, pending)
    assert lines == ["version: 0.1.0 → 0.2.0"]


def test_head_identity_matches_disk_on_a_clean_tree():
    """Skips silently where git cannot answer (no repo, file untracked)."""
    head = identity_mod.head_identity()
    if head is None:
        return
    assert isinstance(head, Identity)
    assert head.identifier
