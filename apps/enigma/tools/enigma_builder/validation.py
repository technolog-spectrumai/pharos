"""Python mirror of ``src-tauri/build.rs``'s ``validate()``.

Every rule here exists so the GUI can refuse a config *before* spending a
build on it; build.rs remains the authority and re-checks all of it. Keep the
two in lockstep — the issue paths deliberately match the paths build.rs prints
so an error in this tool and an error from cargo read the same.

Pure functions over plain dicts: no Qt, no file I/O, directly unit-testable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

ERROR = "error"
WARNING = "warning"

MIB = 1024 * 1024

# build.rs KNOWN_MLS_SUITES — extend together with rotor_core's ciphersuite_name.
KNOWN_MLS_SUITES = (
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    "MLS_128_DHKEMP256_AES128GCM_SHA256_P256",
    "MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448",
)

AT_REST_AEAD = "xchacha20-poly1305"
KDF_ALGORITHM = "argon2id"

# Per-key floors on `min`; the floor of 0 for idle_lock_mins is deliberate
# (auto-lock off is a legitimate configuration).
SETTINGS_FLOORS: dict[str, int] = {
    "connect_timeout_secs": 1,
    "dht_room_publish_secs": 10,
    "max_file_size_mb": 0,
    "map_storage_limit_mb": 1,
    "devlink_pair_window_secs": 30,
    "devlink_resync_secs": 10,
    "chat_history_cap_msgs": 10,
    "idle_lock_mins": 0,
    "peer_resync_secs": 10,
    # Below 16 KiB the per-chunk MLS overhead dominates the payload.
    "file_chunk_kib": 16,
    # Fewer than four digits would be guessable by hand at the keypad.
    "pin_digits": 4,
}

# YAML gate path -> tauri.conf.json key, for the equality assert.
IDENTITY_KEYS = (
    ("app.name", "name", "productName"),
    ("app.identifier", "identifier", "identifier"),
    ("app.version", "version", "version"),
)

# The build-time feature gates, as (yaml path, label).
FEATURE_GATES = (
    ("p2p.allow_hosted_relays", "Hosted relays"),
    ("dht.enabled", "Mainline DHT"),
    ("calls.enabled", "Voice calls"),
    ("contacts.enabled", "Contacts"),
    ("calendar.enabled", "Calendar"),
    ("peers.enabled", "Peer sync"),
    ("maps.enabled", "Maps"),
    ("keyring.enabled", "Keyring"),
    ("lock.pin_unlock", "PIN unlock"),
    ("devices.allow_linking", "Device linking"),
)

RUNTIME_DEFAULTS = (
    "features.use_tor",
    "features.stable_onion",
    "features.dht_discovery",
    "features.dht_nick_publish",
    "features.file_integrity",
)


@dataclass(frozen=True)
class Issue:
    """One validation finding. ``path`` matches the path build.rs prints."""

    path: str
    message: str
    severity: str = ERROR

    @property
    def is_error(self) -> bool:
        return self.severity == ERROR

    def __str__(self) -> str:
        return f"{self.path}: {self.message}"


def get_path(cfg: dict[str, Any], path: str) -> Any:
    """Look up a dotted path, returning None if any segment is missing."""
    node: Any = cfg
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def set_path(cfg: dict[str, Any], path: str, value: Any) -> None:
    """Set a dotted path, creating intermediate dicts as needed."""
    parts = path.split(".")
    node = cfg
    for part in parts[:-1]:
        nxt = node.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            node[part] = nxt
        node = nxt
    node[parts[-1]] = value


def _as_int(value: Any) -> int | None:
    # bool is an int subclass in Python; a bool where a count belongs is a
    # config error, not a zero.
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _check_range(
    issues: list[Issue], cfg: dict, path: str, low: int, high: int, suffix: str = ""
) -> int | None:
    value = _as_int(get_path(cfg, path))
    if value is None:
        issues.append(Issue(path, "missing or not a whole number"))
        return None
    if not low <= value <= high:
        issues.append(Issue(path, f"{value} outside {low}..={high}{suffix}"))
    return value


def validate_config(
    cfg: dict[str, Any],
    tauri_conf: dict[str, Any] | None = None,
    canonical: dict[str, Any] | None = None,
) -> list[Issue]:
    """Validate a full build config.

    ``tauri_conf`` is the *pending* tauri.conf.json content (what the Builder
    will write), so the equality rule only fires when the two genuinely
    disagree — never mid-edit. ``canonical`` supplies the reference values for
    GUI-only warnings; pass the parsed ``build_config.yaml``.
    """
    issues: list[Issue] = []
    _validate_app(issues, cfg, tauri_conf)
    _validate_crypto(issues, cfg)
    _validate_settings(issues, cfg)
    _validate_gates(issues, cfg)
    _validate_network(issues, cfg, canonical)
    return issues


def _validate_app(
    issues: list[Issue], cfg: dict, tauri_conf: dict[str, Any] | None
) -> None:
    name = get_path(cfg, "app.name")
    version = get_path(cfg, "app.version")
    identifier = get_path(cfg, "app.identifier")

    if not isinstance(name, str) or not name.strip():
        issues.append(Issue("app.name", "must not be empty"))
    if not isinstance(version, str) or not version.strip():
        issues.append(Issue("app.version", "must not be empty"))
    if not isinstance(identifier, str) or not identifier or not all(
        c.isascii() and (c.isalnum() or c in ".-") for c in identifier
    ):
        issues.append(
            Issue(
                "app.identifier",
                f"'{identifier}' must be non-empty [a-zA-Z0-9.-]",
            )
        )

    if tauri_conf is None:
        return
    for yaml_path, field, conf_key in IDENTITY_KEYS:
        yaml_val = get_path(cfg, f"app.{field}")
        conf_val = tauri_conf.get(conf_key, "")
        if not isinstance(conf_val, str):
            conf_val = ""
        if conf_val != yaml_val:
            issues.append(
                Issue(
                    yaml_path,
                    f"'{yaml_val}' does not match tauri.conf.json {conf_key} "
                    f"'{conf_val}' (tauri.conf.json stays authoritative — "
                    f"fix whichever is stale)",
                )
            )


def _validate_crypto(issues: list[Issue], cfg: dict) -> None:
    suite = get_path(cfg, "crypto.mls_ciphersuite")
    if suite not in KNOWN_MLS_SUITES:
        issues.append(
            Issue(
                "crypto.mls_ciphersuite",
                f"'{suite}' is not a known suite (known: {list(KNOWN_MLS_SUITES)})",
            )
        )
    aead = get_path(cfg, "crypto.at_rest_aead")
    if aead != AT_REST_AEAD:
        issues.append(
            Issue("crypto.at_rest_aead", f"'{aead}' — only '{AT_REST_AEAD}' is compiled in")
        )
    algorithm = get_path(cfg, "crypto.kdf.algorithm")
    if algorithm != KDF_ALGORITHM:
        issues.append(
            Issue(
                "crypto.kdf.algorithm",
                f"'{algorithm}' — only '{KDF_ALGORITHM}' is compiled in",
            )
        )
    _check_range(
        issues, cfg, "crypto.kdf.m_cost_kib", 8_192, 4_194_304,
        suffix="",
    )
    _check_range(issues, cfg, "crypto.kdf.t_cost", 1, 64)
    _check_range(issues, cfg, "crypto.kdf.p_cost", 1, 64)


def _validate_settings(issues: list[Issue], cfg: dict) -> None:
    for key, floor in SETTINGS_FLOORS.items():
        path = f"settings.{key}"
        clamp = get_path(cfg, path)
        if not isinstance(clamp, dict):
            issues.append(Issue(path, "missing"))
            continue
        default = _as_int(clamp.get("default"))
        low = _as_int(clamp.get("min"))
        high = _as_int(clamp.get("max"))
        if default is None or low is None or high is None:
            issues.append(Issue(path, "default/min/max must all be whole numbers"))
            continue
        if not low <= default <= high:
            issues.append(
                Issue(
                    path,
                    f"violates min <= default <= max ({low} <= {default} <= {high})",
                )
            )
        if low < floor:
            issues.append(Issue(path, f"min {low} below floor {floor}"))


def _validate_gates(issues: list[Issue], cfg: dict) -> None:
    for path, _label in FEATURE_GATES:
        if not isinstance(get_path(cfg, path), bool):
            issues.append(Issue(path, "must be true or false"))
    for path in RUNTIME_DEFAULTS:
        if not isinstance(get_path(cfg, path), bool):
            issues.append(Issue(path, "must be true or false"))

    if get_path(cfg, "dht.enabled") and not get_path(cfg, "p2p.allow_hosted_relays"):
        issues.append(
            Issue(
                "dht.enabled",
                "true requires p2p.allow_hosted_relays: true — the DHT rides the "
                "iroh endpoint's hosted discovery and is inert without it",
            )
        )


def _validate_network(
    issues: list[Issue], cfg: dict, canonical: dict[str, Any] | None
) -> None:
    port = _as_int(get_path(cfg, "network.onion_port"))
    if port is None or not 1 <= port <= 65535:
        issues.append(Issue("network.onion_port", "must be 1..=65535"))

    max_frame = _as_int(get_path(cfg, "network.max_frame_bytes"))
    if max_frame is None:
        issues.append(Issue("network.max_frame_bytes", "missing or not a whole number"))
    elif not MIB <= max_frame <= 256 * MIB:
        issues.append(
            Issue("network.max_frame_bytes", f"{max_frame} outside 1 MiB ..= 256 MiB")
        )

    # The user-tunable chunk ceiling must fit a single wire frame.
    chunk_max = _as_int(get_path(cfg, "settings.file_chunk_kib.max"))
    if chunk_max is not None and max_frame is not None and chunk_max * 1024 > max_frame:
        issues.append(
            Issue(
                "settings.file_chunk_kib",
                f"max {chunk_max} KiB exceeds max_frame_bytes ({max_frame})",
            )
        )

    _check_range(issues, cfg, "network.max_redirects", 1, 20)
    _check_range(issues, cfg, "network.tor_write_timeout_secs", 1, 600)
    _check_range(issues, cfg, "network.tor_handshake_timeout_secs", 1, 600)

    # GUI-only warning: build.rs accepts any in-range value, but peers in one
    # room must agree on the frame cap, so a lone re-tuned build silently
    # rejects (or emits) messages its peers cannot handle.
    if canonical is not None and max_frame is not None:
        reference = _as_int(get_path(canonical, "network.max_frame_bytes"))
        if reference is not None and max_frame != reference:
            issues.append(
                Issue(
                    "network.max_frame_bytes",
                    f"{max_frame} differs from the repo default {reference} — "
                    f"WIRE-INTEROP: every peer in a room must agree, so change "
                    f"this only in lockstep across a fleet",
                    WARNING,
                )
            )


def errors(issues: list[Issue]) -> list[Issue]:
    return [i for i in issues if i.is_error]


def warnings(issues: list[Issue]) -> list[Issue]:
    return [i for i in issues if not i.is_error]


def issues_for(issues: list[Issue], *prefixes: str) -> list[Issue]:
    """Issues whose path is, or sits under, one of ``prefixes``."""
    return [
        i
        for i in issues
        if any(i.path == p or i.path.startswith(f"{p}.") for p in prefixes)
    ]
