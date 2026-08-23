"""Boundary tests for the build.rs mirror.

Each rule is checked at the values either side of its edge, because an
off-by-one here means the GUI happily starts a build that build.rs then
rejects minutes later.
"""

from __future__ import annotations

import pytest

from validation import (
    ERROR,
    WARNING,
    Issue,
    errors,
    issues_for,
    set_path,
    validate_config,
    warnings,
)
from identity import FIXED_APP_IDENTIFIER, FIXED_APP_NAME


def paths_with_errors(
    cfg,
    tauri_conf=None,
    canonical=None,
    android_application_id=None,
) -> set[str]:
    return {
        i.path
        for i in errors(
            validate_config(
                cfg,
                tauri_conf,
                canonical,
                android_application_id=android_application_id,
            )
        )
    }


def test_canonical_config_is_valid(cfg):
    assert validate_config(cfg) == []


def test_identity_equality_against_tauri_conf(cfg):
    conf = {
        "productName": cfg["app"]["name"],
        "identifier": cfg["app"]["identifier"],
        "version": cfg["app"]["version"],
    }
    assert paths_with_errors(cfg, conf) == set()

    conf["version"] = "9.9.9"
    assert "app.version" in paths_with_errors(cfg, conf)


def test_app_name_is_fixed(cfg):
    cfg["app"]["name"] = "Something Else"
    issue = issues_for(validate_config(cfg), "app.name")[0]
    assert FIXED_APP_NAME in issue.message


@pytest.mark.parametrize(
    "identifier,valid",
    [
        (FIXED_APP_IDENTIFIER, True),
        ("com.example.app", False),
        ("Com.Example-App9", False),
        ("", False),
        ("com.example app", False),
        ("com.example_app", False),
        ("com.exämple.app", False),
    ],
)
def test_identifier_charset(cfg, identifier, valid):
    cfg["app"]["identifier"] = identifier
    assert ("app.identifier" in paths_with_errors(cfg)) is not valid


def test_android_application_id_must_match_fixed_identifier(cfg):
    found = paths_with_errors(
        cfg,
        android_application_id="com.spectrumaipl.enigma",
    )
    assert "app.identifier" in found


@pytest.mark.parametrize("field", ["name", "version"])
def test_identity_fields_must_not_be_blank(cfg, field):
    cfg["app"][field] = "   "
    assert f"app.{field}" in paths_with_errors(cfg)


@pytest.mark.parametrize(
    "value,valid",
    [(8_191, False), (8_192, True), (4_194_304, True), (4_194_305, False)],
)
def test_kdf_memory_cost_range(cfg, value, valid):
    cfg["crypto"]["kdf"]["m_cost_kib"] = value
    assert ("crypto.kdf.m_cost_kib" in paths_with_errors(cfg)) is not valid


@pytest.mark.parametrize("field", ["t_cost", "p_cost"])
@pytest.mark.parametrize("value,valid", [(0, False), (1, True), (64, True), (65, False)])
def test_kdf_cost_ranges(cfg, field, value, valid):
    cfg["crypto"]["kdf"][field] = value
    assert (f"crypto.kdf.{field}" in paths_with_errors(cfg)) is not valid


def test_crypto_declarations_are_allowlisted(cfg):
    cfg["crypto"]["mls_ciphersuite"] = "MLS_SOMETHING_ELSE"
    cfg["crypto"]["at_rest_aead"] = "aes-256-gcm"
    cfg["crypto"]["kdf"]["algorithm"] = "scrypt"
    found = paths_with_errors(cfg)
    assert {
        "crypto.mls_ciphersuite",
        "crypto.at_rest_aead",
        "crypto.kdf.algorithm",
    } <= found


def test_clamp_ordering(cfg):
    cfg["settings"]["idle_lock_mins"] = {"default": 200, "min": 0, "max": 120}
    issue = issues_for(validate_config(cfg), "settings.idle_lock_mins")[0]
    assert "min <= default <= max" in issue.message


@pytest.mark.parametrize(
    "key,floor",
    [
        ("connect_timeout_secs", 1),
        ("dht_room_publish_secs", 10),
        ("map_storage_limit_mb", 1),
        ("chat_history_cap_msgs", 10),
        ("peer_resync_secs", 10),
        ("file_chunk_kib", 16),
        ("pin_digits", 4),
    ],
)
def test_settings_floors(cfg, key, floor):
    clamp = cfg["settings"][key]
    clamp["min"] = floor
    clamp["default"] = max(clamp["default"], floor)
    assert f"settings.{key}" not in paths_with_errors(cfg)

    clamp["min"] = floor - 1
    assert f"settings.{key}" in paths_with_errors(cfg)


@pytest.mark.parametrize("key", ["max_file_size_mb", "idle_lock_mins"])
def test_zero_floor_settings_accept_zero(cfg, key):
    cfg["settings"][key]["min"] = 0
    assert f"settings.{key}" not in paths_with_errors(cfg)


def test_dht_requires_hosted_relays(cfg):
    cfg["dht"]["enabled"] = True
    cfg["p2p"]["allow_hosted_relays"] = False
    issue = issues_for(validate_config(cfg), "dht.enabled")[0]
    assert "allow_hosted_relays" in issue.message

    cfg["dht"]["enabled"] = False
    assert "dht.enabled" not in paths_with_errors(cfg)


def test_gates_must_be_boolean(cfg):
    cfg["maps"]["enabled"] = "yes"
    assert "maps.enabled" in paths_with_errors(cfg)


@pytest.mark.parametrize(
    "value,valid",
    [
        (1024 * 1024 - 1, False),
        (1024 * 1024, True),
        (256 * 1024 * 1024, True),
        (256 * 1024 * 1024 + 1, False),
    ],
)
def test_max_frame_bytes_range(cfg, value, valid):
    cfg["network"]["max_frame_bytes"] = value
    # A 4 MiB chunk ceiling must still fit the smallest legal frame (1 MiB),
    # so shrink it here or the cross-check would mask the range assertion.
    cfg["settings"]["file_chunk_kib"] = {"default": 256, "min": 16, "max": 512}
    assert ("network.max_frame_bytes" in paths_with_errors(cfg)) is not valid


def test_chunk_ceiling_must_fit_a_frame(cfg):
    """A chunk rides as one wire frame — its max cannot exceed max_frame_bytes."""
    cfg["network"]["max_frame_bytes"] = 1024 * 1024  # 1 MiB
    cfg["settings"]["file_chunk_kib"] = {"default": 256, "min": 16, "max": 2048}  # 2 MiB
    assert "settings.file_chunk_kib" in paths_with_errors(cfg)

    cfg["settings"]["file_chunk_kib"] = {"default": 256, "min": 16, "max": 1024}  # exactly 1 MiB
    assert "settings.file_chunk_kib" not in paths_with_errors(cfg)


@pytest.mark.parametrize(
    "key,value,valid",
    [
        ("onion_port", 0, False),
        ("onion_port", 1, True),
        ("onion_port", 65_535, True),
        ("tor_write_timeout_secs", 0, False),
        ("tor_write_timeout_secs", 600, True),
        ("tor_write_timeout_secs", 601, False),
        ("tor_handshake_timeout_secs", 1, True),
        ("tor_handshake_timeout_secs", 601, False),
    ],
)
def test_network_ranges(cfg, key, value, valid):
    cfg["network"][key] = value
    assert (f"network.{key}" in paths_with_errors(cfg)) is not valid


def test_wire_interop_warning_is_not_blocking(cfg, canonical):
    cfg["network"]["max_frame_bytes"] = 32 * 1024 * 1024
    issues = validate_config(cfg, None, canonical)
    assert errors(issues) == []
    warned = warnings(issues)
    assert len(warned) == 1
    assert "WIRE-INTEROP" in warned[0].message


def test_no_warning_at_the_canonical_frame_size(cfg, canonical):
    assert warnings(validate_config(cfg, None, canonical)) == []


def test_issues_for_matches_prefixes_not_substrings():
    issues = [
        Issue("settings.idle_lock_mins", "x"),
        Issue("settings.idle_lock_mins_extra", "y"),
        Issue("network.onion_port", "z", WARNING),
    ]
    matched = issues_for(issues, "settings.idle_lock_mins")
    assert [i.path for i in matched] == ["settings.idle_lock_mins"]


def test_missing_section_is_reported_not_crashed(cfg):
    del cfg["network"]
    found = paths_with_errors(cfg)
    assert "network.onion_port" in found


def test_set_path_creates_intermediate_dicts():
    target: dict = {}
    set_path(target, "a.b.c", 1)
    assert target == {"a": {"b": {"c": 1}}}


def test_issue_severity_defaults_to_error():
    assert Issue("a", "b").severity == ERROR
