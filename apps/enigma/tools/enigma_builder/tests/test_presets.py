"""Preset loading, detection, and the invariants that make it safe.

These read the real checked-in edition files. That is deliberate: the Builder
must never carry its own copy of the edition matrix — a comment drifting from a
value has happened before, and the values are what build.rs compiles.
"""

from __future__ import annotations

import pytest

import paths
from config_model import PRESET_PATHS, ConfigModel, load_yaml, merge_known
from validation import FEATURE_GATES, get_path

GATE_PATHS = [path for path, _ in FEATURE_GATES]


@pytest.fixture(scope="module")
def editions() -> dict[str, dict]:
    return {name: load_yaml(paths.preset_yaml(name)) for name in paths.PRESETS}


def gates(config: dict) -> dict[str, bool]:
    return {path: get_path(config, path) for path in GATE_PATHS}


def test_every_edition_file_parses(editions):
    for name, config in editions.items():
        assert config, f"{name} edition config is missing or unparseable"


def test_basic_is_the_private_organiser(editions):
    """Contacts, calendar, PIN unlock and device linking — nothing networked
    beyond the ticket/QR pairing that has no gate."""
    enabled = {path for path, value in gates(editions["basic"]).items() if value}
    assert enabled == {
        "contacts.enabled",
        "calendar.enabled",
        "lock.pin_unlock",
    }


def test_standard_is_basic_plus_connectivity(editions):
    basic = gates(editions["basic"])
    standard = gates(editions["standard"])
    differing = {path for path in GATE_PATHS if basic[path] != standard[path]}
    assert differing == {
        "p2p.allow_hosted_relays",
        "dht.enabled",
        "peers.enabled",
        "keyring.enabled",
        "calls.enabled",
    }
    assert all(standard[path] for path in differing)


def test_professional_is_standard_plus_maps(editions):
    standard = gates(editions["standard"])
    professional = gates(editions["professional"])
    differing = {path for path in GATE_PATHS if standard[path] != professional[path]}
    assert differing == {"maps.enabled"}
    assert all(gates(editions["professional"]).values())


@pytest.mark.parametrize("section", ["crypto", "settings", "network"])
def test_editions_share_crypto_settings_and_network(editions, section):
    """The invariant that lets apply_preset touch only the gates.

    A Basic peer has to share rooms with a Professional peer, so these
    sections are identical across the product line on purpose.
    """
    values = [config[section] for config in editions.values()]
    assert all(value == values[0] for value in values)


def test_apply_preset_then_detect_round_trips():
    model = ConfigModel()
    for edition in paths.PRESETS:
        assert model.apply_preset(edition)
        assert model.detect_preset() == edition


def test_editing_off_the_preset_chain_lands_on_custom():
    """The presets form a chain (professional − maps = standard), so detection
    legitimately slides DOWN the chain on those edits. Custom is what lies
    outside it — no preset ships without contacts."""
    model = ConfigModel()
    model.apply_preset("professional")
    model.set("maps.enabled", False)
    assert model.detect_preset() == "standard"  # the chain, working as intended
    model.set("contacts.enabled", False)
    assert model.detect_preset() is None
    assert "custom" in model.provenance()


def test_apply_preset_leaves_expert_values_alone():
    model = ConfigModel()
    model.set("settings.idle_lock_mins.default", 7)
    model.set("network.onion_port", 9)
    model.apply_preset("light")
    assert model.get("settings.idle_lock_mins.default") == 7
    assert model.get("network.onion_port") == 9


def test_apply_preset_keeps_fixed_identity():
    model = ConfigModel()
    model.set("app.name", "Enigma Field")
    model.apply_preset("light")
    assert model.get("app.name") == "Enigma26"
    assert model.get("app.identifier") == "com.spectrumaipl.enigma26"


def test_preset_paths_are_gates_and_runtime_defaults_only():
    assert all(
        path.startswith(tuple(p.split(".")[0] for p in GATE_PATHS))
        or path.startswith("features.")
        for path in PRESET_PATHS
    )
    assert not any(
        path.startswith(("crypto.", "settings.", "network.", "app."))
        for path in PRESET_PATHS
    )


def test_unknown_preset_is_reported_not_applied():
    model = ConfigModel()
    before = dict(gates(model.config))
    assert model.apply_preset("enterprise") is False
    assert gates(model.config) == before


def test_batch_emits_one_change(qtbot_free_model=None):
    model = ConfigModel()
    seen = []
    model.changed.connect(lambda: seen.append(1))
    with model.batch():
        model.set("maps.enabled", not model.get("maps.enabled"))
        model.set("calls.enabled", not model.get("calls.enabled"))
    assert len(seen) == 1


def test_setting_an_unchanged_value_emits_nothing():
    model = ConfigModel()
    seen = []
    model.changed.connect(lambda: seen.append(1))
    model.set("maps.enabled", model.get("maps.enabled"))
    assert seen == []


def test_merge_known_drops_unknown_and_mistyped_keys(canonical):
    stored = {
        "maps": {"enabled": False},
        "kanban": {"enabled": True},
        "network": {"onion_port": "9999"},
    }
    merged = merge_known(canonical, stored)
    assert merged["maps"]["enabled"] is False
    assert "kanban" not in merged
    assert merged["network"]["onion_port"] == canonical["network"]["onion_port"]


def test_merge_known_does_not_confuse_bool_and_int(canonical):
    merged = merge_known(canonical, {"network": {"onion_port": True}})
    assert merged["network"]["onion_port"] == canonical["network"]["onion_port"]
