//! Bakes build_config.yaml into the binary: parse → validate → generate
//! `$OUT_DIR/build_config_gen.rs` (included as `enigma_lib::build_config`).
//! Any invalid or missing value fails the build here, before compilation;
//! algorithm declarations are additionally const-asserted in the generated
//! code against the vendored crypto crates, so drift in either direction
//! (YAML edited, or rotor_core/gervasius changed) is a compile error.
//!
//! WHICH yaml is chosen by the `ENIGMA_EDITION` env var (light/plus/pro →
//! `configs/build_config.<edition>.yaml`); unset keeps the historical
//! `build_config.yaml`. See pland.md for the product line.

use std::env;
use std::fmt::Write as _;
use std::path::Path;

use serde::Deserialize;

// ── YAML schema (all fields required: the file is the complete record) ──────

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    app: AppSection,
    cloud: CloudSection,
    p2p: P2pSection,
    dht: DhtSection,
    crypto: CryptoSection,
    calls: CallsSection,
    contacts: ContactsSection,
    calendar: CalendarSection,
    peers: PeersSection,
    maps: MapsSection,
    keyring: KeyringSection,
    devices: DevicesSection,
    features: FeaturesSection,
    settings: SettingsSection,
    network: NetworkSection,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppSection {
    name: String,
    identifier: String,
    version: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CloudSection {
    allow_connections: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct P2pSection {
    allow_hosted_relays: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DhtSection {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CryptoSection {
    mls_ciphersuite: String,
    at_rest_aead: String,
    kdf: KdfSection,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KdfSection {
    algorithm: String,
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CallsSection {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContactsSection {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CalendarSection {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PeersSection {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MapsSection {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyringSection {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DevicesSection {
    allow_linking: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeaturesSection {
    use_tor: bool,
    stable_onion: bool,
    dht_discovery: bool,
    dht_nick_publish: bool,
    file_integrity: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsSection {
    connect_timeout_secs: Clamp,
    dht_room_publish_secs: Clamp,
    max_file_size_mb: Clamp,
    map_storage_limit_mb: Clamp,
    devlink_pair_window_secs: Clamp,
    devlink_resync_secs: Clamp,
    chat_history_cap_msgs: Clamp,
    idle_lock_mins: Clamp,
    peer_resync_secs: Clamp,
    file_chunk_kib: Clamp,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Clamp {
    default: u64,
    min: u64,
    max: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NetworkSection {
    max_frame_bytes: u64,
    onion_port: u16,
    max_redirects: u64,
    tor_write_timeout_secs: u64,
    tor_handshake_timeout_secs: u64,
}

// ── validation ──────────────────────────────────────────────────────────────

/// Friendly early check; the authoritative check is the const assert emitted
/// into the generated module (it also catches the crates changing under a
/// stale YAML). Extend together with rotor_core's `ciphersuite_name`.
const KNOWN_MLS_SUITES: &[&str] = &[
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    "MLS_128_DHKEMP256_AES128GCM_SHA256_P256",
    "MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448",
];

fn validate(cfg: &RawConfig, manifest_dir: &Path, errors: &mut Vec<String>) {
    let mut err = |path: &str, msg: String| errors.push(format!("{path}: {msg}"));

    // app: non-empty, identifier shape, and equality with tauri.conf.json.
    if cfg.app.name.trim().is_empty() {
        err("app.name", "must not be empty".into());
    }
    if cfg.app.version.trim().is_empty() {
        err("app.version", "must not be empty".into());
    }
    if cfg.app.identifier.is_empty()
        || !cfg.app.identifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        err("app.identifier", format!("'{}' must be non-empty [a-zA-Z0-9.-]", cfg.app.identifier));
    }
    let conf_path = manifest_dir.join("tauri.conf.json");
    match std::fs::read_to_string(&conf_path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string()))
    {
        Ok(conf) => {
            let pairs = [
                ("app.name", "productName", cfg.app.name.as_str()),
                ("app.identifier", "identifier", cfg.app.identifier.as_str()),
                ("app.version", "version", cfg.app.version.as_str()),
            ];
            for (yaml_path, conf_key, yaml_val) in pairs {
                let conf_val = conf.get(conf_key).and_then(|v| v.as_str()).unwrap_or("");
                if conf_val != yaml_val {
                    err(
                        yaml_path,
                        format!(
                            "'{yaml_val}' does not match tauri.conf.json {conf_key} '{conf_val}' \
                             (tauri.conf.json stays authoritative — fix whichever is stale)"
                        ),
                    );
                }
            }
        }
        Err(e) => err("app", format!("cannot read {}: {e}", conf_path.display())),
    }

    // crypto: allowlisted declarations + Argon2 sanity rails.
    if !KNOWN_MLS_SUITES.contains(&cfg.crypto.mls_ciphersuite.as_str()) {
        err(
            "crypto.mls_ciphersuite",
            format!("'{}' is not a known suite (known: {KNOWN_MLS_SUITES:?})", cfg.crypto.mls_ciphersuite),
        );
    }
    if cfg.crypto.at_rest_aead != "xchacha20-poly1305" {
        err("crypto.at_rest_aead", format!("'{}' — only 'xchacha20-poly1305' is compiled in", cfg.crypto.at_rest_aead));
    }
    if cfg.crypto.kdf.algorithm != "argon2id" {
        err("crypto.kdf.algorithm", format!("'{}' — only 'argon2id' is compiled in", cfg.crypto.kdf.algorithm));
    }
    let kdf = &cfg.crypto.kdf;
    if !(8_192..=4_194_304).contains(&kdf.m_cost_kib) {
        err("crypto.kdf.m_cost_kib", format!("{} outside sane range 8192 (8 MiB) ..= 4194304 (4 GiB)", kdf.m_cost_kib));
    }
    if !(1..=64).contains(&kdf.t_cost) {
        err("crypto.kdf.t_cost", format!("{} outside 1..=64", kdf.t_cost));
    }
    if !(1..=64).contains(&kdf.p_cost) {
        err("crypto.kdf.p_cost", format!("{} outside 1..=64", kdf.p_cost));
    }

    // settings clamps.
    let clamps = [
        ("settings.connect_timeout_secs", &cfg.settings.connect_timeout_secs, 1u64),
        ("settings.dht_room_publish_secs", &cfg.settings.dht_room_publish_secs, 10u64),
        ("settings.max_file_size_mb", &cfg.settings.max_file_size_mb, 0u64),
        ("settings.map_storage_limit_mb", &cfg.settings.map_storage_limit_mb, 1u64),
        ("settings.devlink_pair_window_secs", &cfg.settings.devlink_pair_window_secs, 30u64),
        ("settings.devlink_resync_secs", &cfg.settings.devlink_resync_secs, 10u64),
        ("settings.chat_history_cap_msgs", &cfg.settings.chat_history_cap_msgs, 10u64),
        // floor 0: auto-lock off is a legitimate configuration.
        ("settings.idle_lock_mins", &cfg.settings.idle_lock_mins, 0u64),
        ("settings.peer_resync_secs", &cfg.settings.peer_resync_secs, 10u64),
        // floor 16 KiB: below that the per-chunk MLS overhead dominates.
        ("settings.file_chunk_kib", &cfg.settings.file_chunk_kib, 16u64),
    ];
    for (path, c, floor) in clamps {
        if !(c.min <= c.default && c.default <= c.max) {
            err(path, format!("violates min <= default <= max ({} <= {} <= {})", c.min, c.default, c.max));
        }
        if c.min < floor {
            err(path, format!("min {} below floor {floor}", c.min));
        }
    }

    // dht: the Mainline rendezvous rides the iroh endpoint's hosted discovery
    // (p2p_dht::discovery_enabled checks ALLOW_HOSTED_RELAYS first), so the
    // combination below would be silently inert rather than merely off.
    if cfg.dht.enabled && !cfg.p2p.allow_hosted_relays {
        err(
            "dht.enabled",
            "true requires p2p.allow_hosted_relays: true — the DHT rides the iroh \
             endpoint's hosted discovery and is inert without it"
                .into(),
        );
    }

    // network.
    let net = &cfg.network;
    if net.onion_port == 0 {
        err("network.onion_port", "must be 1..=65535".into());
    }
    if !((1u64 << 20)..=(256u64 << 20)).contains(&net.max_frame_bytes) {
        err("network.max_frame_bytes", format!("{} outside 1 MiB ..= 256 MiB", net.max_frame_bytes));
    }
    // The user-tunable chunk ceiling must fit a single wire frame.
    if cfg.settings.file_chunk_kib.max * 1024 > net.max_frame_bytes {
        err(
            "settings.file_chunk_kib",
            format!(
                "max {} KiB exceeds network.max_frame_bytes ({})",
                cfg.settings.file_chunk_kib.max, net.max_frame_bytes
            ),
        );
    }
    if !(1..=20).contains(&net.max_redirects) {
        err("network.max_redirects", format!("{} outside 1..=20", net.max_redirects));
    }
    for (path, secs) in [
        ("network.tor_write_timeout_secs", net.tor_write_timeout_secs),
        ("network.tor_handshake_timeout_secs", net.tor_handshake_timeout_secs),
    ] {
        if !(1..=600).contains(&secs) {
            err(path, format!("{secs} outside 1..=600"));
        }
    }
}

// ── codegen ─────────────────────────────────────────────────────────────────

fn rust_str(s: &str) -> String {
    format!("{s:?}") // debug-format of &str is a valid Rust string literal
}

fn generate(cfg: &RawConfig) -> String {
    let mut o = String::new();
    let _ = write!(
        &mut o,
        r#"// @generated from build_config.yaml by build.rs — do not edit.

pub mod app {{
    pub const NAME: &str = {name};
    pub const IDENTIFIER: &str = {identifier};
    pub const VERSION: &str = {version};
}}

pub mod cloud {{
    pub const ALLOW_CONNECTIONS: bool = {allow_cloud};
}}

pub mod p2p {{
    pub const ALLOW_HOSTED_RELAYS: bool = {allow_relays};
}}

pub mod dht {{
    pub const ENABLED: bool = {dht_enabled};
}}

pub mod crypto {{
    pub const MLS_CIPHERSUITE: &str = {mls};
    pub const AT_REST_AEAD: &str = {aead};
    pub const KDF_ALGORITHM: &str = {kdf_alg};
    pub const KDF_M_COST_KIB: u32 = {m_cost};
    pub const KDF_T_COST: u32 = {t_cost};
    pub const KDF_P_COST: u32 = {p_cost};
    pub const KDF_OUT_LEN: u32 = 32; // fixed — mirrors gervasius::KDF_OUT_LEN
}}

pub mod features {{
    pub const USE_TOR_DEFAULT: bool = {use_tor};
    pub const STABLE_ONION_DEFAULT: bool = {stable_onion};
    pub const DHT_DISCOVERY_DEFAULT: bool = {dht_discovery};
    pub const DHT_NICK_PUBLISH_DEFAULT: bool = {dht_nick};
    pub const FILE_INTEGRITY_DEFAULT: bool = {file_integrity};
}}

pub mod settings {{
    pub const CONNECT_TIMEOUT_DEFAULT_SECS: u64 = {ct_def};
    pub const CONNECT_TIMEOUT_MIN_SECS: u64 = {ct_min};
    pub const CONNECT_TIMEOUT_MAX_SECS: u64 = {ct_max};
    pub const DHT_ROOM_PUBLISH_DEFAULT_SECS: u64 = {rp_def};
    pub const DHT_ROOM_PUBLISH_MIN_SECS: u64 = {rp_min};
    pub const DHT_ROOM_PUBLISH_MAX_SECS: u64 = {rp_max};
    pub const MAX_FILE_SIZE_DEFAULT_MB: u64 = {fs_def};
    pub const MAX_FILE_SIZE_MIN_MB: u64 = {fs_min};
    pub const MAX_FILE_SIZE_MAX_MB: u64 = {fs_max};
    pub const MAP_STORAGE_LIMIT_DEFAULT_MB: u64 = {ms_def};
    pub const MAP_STORAGE_LIMIT_MIN_MB: u64 = {ms_min};
    pub const MAP_STORAGE_LIMIT_MAX_MB: u64 = {ms_max};
    pub const DEVLINK_PAIR_WINDOW_DEFAULT_SECS: u64 = {pw_def};
    pub const DEVLINK_PAIR_WINDOW_MIN_SECS: u64 = {pw_min};
    pub const DEVLINK_PAIR_WINDOW_MAX_SECS: u64 = {pw_max};
    pub const DEVLINK_RESYNC_DEFAULT_SECS: u64 = {rs_def};
    pub const DEVLINK_RESYNC_MIN_SECS: u64 = {rs_min};
    pub const DEVLINK_RESYNC_MAX_SECS: u64 = {rs_max};
    pub const CHAT_HISTORY_CAP_DEFAULT_MSGS: u64 = {hc_def};
    pub const CHAT_HISTORY_CAP_MIN_MSGS: u64 = {hc_min};
    pub const CHAT_HISTORY_CAP_MAX_MSGS: u64 = {hc_max};
    pub const IDLE_LOCK_DEFAULT_MINS: u64 = {il_def};
    pub const IDLE_LOCK_MIN_MINS: u64 = {il_min};
    pub const IDLE_LOCK_MAX_MINS: u64 = {il_max};
    pub const PEER_RESYNC_DEFAULT_SECS: u64 = {pr_def};
    pub const PEER_RESYNC_MIN_SECS: u64 = {pr_min};
    pub const PEER_RESYNC_MAX_SECS: u64 = {pr_max};
    pub const FILE_CHUNK_DEFAULT_KIB: u64 = {fc_def};
    pub const FILE_CHUNK_MIN_KIB: u64 = {fc_min};
    pub const FILE_CHUNK_MAX_KIB: u64 = {fc_max};
}}

pub mod network {{
    pub const MAX_FRAME_BYTES: usize = {max_frame};
    pub const ONION_PORT: u16 = {onion_port};
    pub const MAX_REDIRECTS: usize = {redirects};
    pub const TOR_WRITE_TIMEOUT_SECS: u64 = {tor_write};
    pub const TOR_HANDSHAKE_TIMEOUT_SECS: u64 = {tor_hs};
}}

pub mod calls {{
    pub const ENABLED: bool = {calls_enabled};
}}

pub mod contacts {{
    pub const ENABLED: bool = {contacts_enabled};
}}

pub mod calendar {{
    pub const ENABLED: bool = {calendar_enabled};
}}

pub mod peers {{
    pub const ENABLED: bool = {peers_enabled};
}}

pub mod maps {{
    pub const ENABLED: bool = {maps_enabled};
}}

pub mod keyring {{
    pub const ENABLED: bool = {keyring_enabled};
}}

pub mod devices {{
    pub const ALLOW_LINKING: bool = {devices_allow_linking};
}}

// ── compile-time algorithm asserts against the vendored crates ──────────────

const fn str_eq(a: &str, b: &str) -> bool {{
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {{
        return false;
    }}
    let mut i = 0;
    while i < a.len() {{
        if a[i] != b[i] {{
            return false;
        }}
        i += 1;
    }}
    true
}}

const _: () = assert!(
    str_eq(crypto::MLS_CIPHERSUITE, rotor_core::CIPHERSUITE_NAME),
    "build_config.yaml crypto.mls_ciphersuite does not match the compiled rotor_core ciphersuite"
);
const _: () = assert!(
    str_eq(crypto::AT_REST_AEAD, gervasius::AEAD_NAME),
    "build_config.yaml crypto.at_rest_aead does not match the compiled gervasius AEAD"
);
const _: () = assert!(
    str_eq(crypto::KDF_ALGORITHM, gervasius::KDF_NAME),
    "build_config.yaml crypto.kdf.algorithm does not match the compiled gervasius KDF"
);
const _: () = assert!(
    crypto::KDF_OUT_LEN == gervasius::KDF_OUT_LEN,
    "KDF out_len is fixed at 32"
);
"#,
        name = rust_str(&cfg.app.name),
        identifier = rust_str(&cfg.app.identifier),
        version = rust_str(&cfg.app.version),
        allow_cloud = cfg.cloud.allow_connections,
        allow_relays = cfg.p2p.allow_hosted_relays,
        dht_enabled = cfg.dht.enabled,
        mls = rust_str(&cfg.crypto.mls_ciphersuite),
        aead = rust_str(&cfg.crypto.at_rest_aead),
        kdf_alg = rust_str(&cfg.crypto.kdf.algorithm),
        m_cost = cfg.crypto.kdf.m_cost_kib,
        t_cost = cfg.crypto.kdf.t_cost,
        p_cost = cfg.crypto.kdf.p_cost,
        use_tor = cfg.features.use_tor,
        stable_onion = cfg.features.stable_onion,
        dht_discovery = cfg.features.dht_discovery,
        dht_nick = cfg.features.dht_nick_publish,
        file_integrity = cfg.features.file_integrity,
        ct_def = cfg.settings.connect_timeout_secs.default,
        ct_min = cfg.settings.connect_timeout_secs.min,
        ct_max = cfg.settings.connect_timeout_secs.max,
        rp_def = cfg.settings.dht_room_publish_secs.default,
        rp_min = cfg.settings.dht_room_publish_secs.min,
        rp_max = cfg.settings.dht_room_publish_secs.max,
        fs_def = cfg.settings.max_file_size_mb.default,
        fs_min = cfg.settings.max_file_size_mb.min,
        fs_max = cfg.settings.max_file_size_mb.max,
        ms_def = cfg.settings.map_storage_limit_mb.default,
        ms_min = cfg.settings.map_storage_limit_mb.min,
        ms_max = cfg.settings.map_storage_limit_mb.max,
        pw_def = cfg.settings.devlink_pair_window_secs.default,
        pw_min = cfg.settings.devlink_pair_window_secs.min,
        pw_max = cfg.settings.devlink_pair_window_secs.max,
        rs_def = cfg.settings.devlink_resync_secs.default,
        rs_min = cfg.settings.devlink_resync_secs.min,
        rs_max = cfg.settings.devlink_resync_secs.max,
        hc_def = cfg.settings.chat_history_cap_msgs.default,
        hc_min = cfg.settings.chat_history_cap_msgs.min,
        hc_max = cfg.settings.chat_history_cap_msgs.max,
        il_def = cfg.settings.idle_lock_mins.default,
        il_min = cfg.settings.idle_lock_mins.min,
        il_max = cfg.settings.idle_lock_mins.max,
        pr_def = cfg.settings.peer_resync_secs.default,
        pr_min = cfg.settings.peer_resync_secs.min,
        pr_max = cfg.settings.peer_resync_secs.max,
        fc_def = cfg.settings.file_chunk_kib.default,
        fc_min = cfg.settings.file_chunk_kib.min,
        fc_max = cfg.settings.file_chunk_kib.max,
        max_frame = cfg.network.max_frame_bytes,
        onion_port = cfg.network.onion_port,
        redirects = cfg.network.max_redirects,
        tor_write = cfg.network.tor_write_timeout_secs,
        tor_hs = cfg.network.tor_handshake_timeout_secs,
        calls_enabled = cfg.calls.enabled,
        contacts_enabled = cfg.contacts.enabled,
        calendar_enabled = cfg.calendar.enabled,
        peers_enabled = cfg.peers.enabled,
        maps_enabled = cfg.maps.enabled,
        keyring_enabled = cfg.keyring.enabled,
        devices_allow_linking = cfg.devices.allow_linking,
    );
    o
}

/// Product editions (pland.md). Each maps to `configs/build_config.<name>.yaml`;
/// an unset ENIGMA_EDITION keeps the historical top-level build_config.yaml.
/// `custom` is the local Enigma Builder's output (tools/enigma_builder): that
/// file is generated and gitignored, so a fresh checkout has no `custom` config
/// and building one without running the Builder first fails with "not found".
const EDITIONS: &[&str] = &["light", "plus", "pro", "custom"];

/// Resolve which YAML to bake in. Unknown names FAIL — never silently fall back
/// to the default config, or a typo'd edition would ship every feature.
fn resolve_config_path(manifest_dir: &Path) -> std::path::PathBuf {
    println!("cargo:rerun-if-env-changed=ENIGMA_EDITION");
    let edition = match env::var("ENIGMA_EDITION") {
        Ok(e) if !e.trim().is_empty() => e.trim().to_ascii_lowercase(),
        _ => return manifest_dir.join("build_config.yaml"),
    };
    if !EDITIONS.contains(&edition.as_str()) {
        panic!("\n\nENIGMA_EDITION='{edition}' is not a known edition (valid: {EDITIONS:?}) — see pland.md\n");
    }
    manifest_dir.join("configs").join(format!("build_config.{edition}.yaml"))
}

fn generate_build_config() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
    let manifest_dir = Path::new(&manifest_dir);
    let yaml_path = resolve_config_path(manifest_dir);
    println!("cargo:rerun-if-changed=build_config.yaml");
    println!("cargo:rerun-if-changed=configs");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    let raw = std::fs::read_to_string(&yaml_path).unwrap_or_else(|e| {
        panic!(
            "\n\nbuild config not found at {} ({e}) — this file is required (see build.md, pland.md)\n",
            yaml_path.display()
        )
    });
    let cfg: RawConfig = serde_norway::from_str(&raw).unwrap_or_else(|e| {
        panic!("\n\nbuild config is not valid ({}):\n  {e}\n", yaml_path.display())
    });

    let mut errors = Vec::new();
    validate(&cfg, manifest_dir, &mut errors);
    if !errors.is_empty() {
        let list: String = errors.iter().map(|e| format!("  - {e}\n")).collect();
        panic!("\n\nbuild config is invalid:\n{list}(file: {})\n", yaml_path.display());
    }

    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let out_path = Path::new(&out_dir).join("build_config_gen.rs");
    std::fs::write(&out_path, generate(&cfg))
        .unwrap_or_else(|e| panic!("cannot write {}: {e}", out_path.display()));
}

fn main() {
    generate_build_config(); // fail fast, before tauri_build
    tauri_build::build()
}
