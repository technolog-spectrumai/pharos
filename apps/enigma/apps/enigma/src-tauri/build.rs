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
    p2p: P2pSection,
    dht: DhtSection,
    crypto: CryptoSection,
    calls: CallsSection,
    contacts: ContactsSection,
    calendar: CalendarSection,
    maps: MapsSection,
    keyring: KeyringSection,
    lock: LockSection,
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
struct LockSection {
    pin_unlock: bool,
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
    chat_history_cap_msgs: Clamp,
    idle_lock_mins: Clamp,
    file_chunk_kib: Clamp,
    pin_digits: Clamp,
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

const FIXED_APP_NAME: &str = "Enigma26";
const FIXED_APP_IDENTIFIER: &str = "com.spectrumaipl.enigma26";

/// The active edition's `tauri.<edition>.conf.json`, if it has one.
///
/// Keep this in lockstep with what the launchers pass to `--config`
/// (`run_dev.sh`, `run2.sh`, `build_desktop.sh`): if the two ever disagree, the
/// bundle would carry one identity and this assertion would check another —
/// exactly the class of drift the assertion exists to catch.
fn edition_conf_overlay(manifest_dir: &Path) -> Option<serde_json::Value> {
    let edition = env::var("ENIGMA_EDITION").ok()?;
    let edition = edition.trim().to_ascii_lowercase();
    if edition.is_empty() {
        return None;
    }
    let path = manifest_dir.join(format!("tauri.{edition}.conf.json"));
    println!("cargo:rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

fn validate(cfg: &RawConfig, manifest_dir: &Path, errors: &mut Vec<String>) {
    let mut err = |path: &str, msg: String| errors.push(format!("{path}: {msg}"));

    // app: fixed product identity, valid version, and equality with tauri.conf.json.
    if cfg.app.name.trim().is_empty() {
        err("app.name", "must not be empty".into());
    } else if cfg.app.name != FIXED_APP_NAME {
        err(
            "app.name",
            format!("must be '{FIXED_APP_NAME}' (app name is not configurable)"),
        );
    }
    if cfg.app.version.trim().is_empty() {
        err("app.version", "must not be empty".into());
    }
    if cfg.app.identifier.is_empty()
        || !cfg.app.identifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        err("app.identifier", format!("'{}' must be non-empty [a-zA-Z0-9.-]", cfg.app.identifier));
    } else if cfg.app.identifier != FIXED_APP_IDENTIFIER {
        err(
            "app.identifier",
            format!(
                "must be '{FIXED_APP_IDENTIFIER}' (Android applicationId is not configurable)"
            ),
        );
    }
    let conf_path = manifest_dir.join("tauri.conf.json");
    match std::fs::read_to_string(&conf_path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string()))
    {
        Ok(mut conf) => {
            // Per-edition overlay: editions keep one product identity now and
            // vary feature gates only. The overlay is still a partial config
            // the tauri CLI is given with `--config`, and it deep-merges over
            // tauri.conf.json; apply the same merge here so this assertion sees
            // the EFFECTIVE identity rather than the base file's.
            //
            // `custom` deliberately has no overlay: the Enigma Builder writes
            // tauri.conf.json itself (tools/enigma_builder/identity.py), so the
            // base file already IS its effective identity.
            if let Some(overlay) = edition_conf_overlay(manifest_dir) {
                if let (Some(base), Some(over)) = (conf.as_object_mut(), overlay.as_object()) {
                    for (k, v) in over {
                        base.insert(k.clone(), v.clone());
                    }
                }
            }
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
        ("settings.chat_history_cap_msgs", &cfg.settings.chat_history_cap_msgs, 10u64),
        // floor 0: auto-lock off is a legitimate configuration.
        ("settings.idle_lock_mins", &cfg.settings.idle_lock_mins, 0u64),
        // floor 16 KiB: below that the per-chunk MLS overhead dominates.
        ("settings.file_chunk_kib", &cfg.settings.file_chunk_kib, 16u64),
        // floor 4 digits: the PIN only re-opens an already-unlocked session, but
        // fewer than four would be guessable by hand at the keypad.
        ("settings.pin_digits", &cfg.settings.pin_digits, 4u64),
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
    pub const CHAT_HISTORY_CAP_DEFAULT_MSGS: u64 = {hc_def};
    pub const CHAT_HISTORY_CAP_MIN_MSGS: u64 = {hc_min};
    pub const CHAT_HISTORY_CAP_MAX_MSGS: u64 = {hc_max};
    pub const IDLE_LOCK_DEFAULT_MINS: u64 = {il_def};
    pub const IDLE_LOCK_MIN_MINS: u64 = {il_min};
    pub const IDLE_LOCK_MAX_MINS: u64 = {il_max};
    pub const FILE_CHUNK_DEFAULT_KIB: u64 = {fc_def};
    pub const FILE_CHUNK_MIN_KIB: u64 = {fc_min};
    pub const FILE_CHUNK_MAX_KIB: u64 = {fc_max};
    pub const PIN_DIGITS_DEFAULT: u64 = {pd_def};
    pub const PIN_DIGITS_MIN: u64 = {pd_min};
    pub const PIN_DIGITS_MAX: u64 = {pd_max};
}}

pub mod network {{
    pub const MAX_FRAME_BYTES: usize = {max_frame};
    pub const ONION_PORT: u16 = {onion_port};
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

pub mod maps {{
    pub const ENABLED: bool = {maps_enabled};
}}

pub mod lock {{
    pub const PIN_UNLOCK: bool = {pin_unlock};
}}

pub mod keyring {{
    pub const ENABLED: bool = {keyring_enabled};
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
        hc_def = cfg.settings.chat_history_cap_msgs.default,
        hc_min = cfg.settings.chat_history_cap_msgs.min,
        hc_max = cfg.settings.chat_history_cap_msgs.max,
        il_def = cfg.settings.idle_lock_mins.default,
        il_min = cfg.settings.idle_lock_mins.min,
        il_max = cfg.settings.idle_lock_mins.max,
        fc_def = cfg.settings.file_chunk_kib.default,
        fc_min = cfg.settings.file_chunk_kib.min,
        fc_max = cfg.settings.file_chunk_kib.max,
        pd_def = cfg.settings.pin_digits.default,
        pd_min = cfg.settings.pin_digits.min,
        pd_max = cfg.settings.pin_digits.max,
        max_frame = cfg.network.max_frame_bytes,
        onion_port = cfg.network.onion_port,
        tor_write = cfg.network.tor_write_timeout_secs,
        tor_hs = cfg.network.tor_handshake_timeout_secs,
        calls_enabled = cfg.calls.enabled,
        contacts_enabled = cfg.contacts.enabled,
        calendar_enabled = cfg.calendar.enabled,
        maps_enabled = cfg.maps.enabled,
        keyring_enabled = cfg.keyring.enabled,
        pin_unlock = cfg.lock.pin_unlock,
    );
    o
}

/// Product editions (pland.md). Each maps to `configs/build_config.<name>.yaml`;
/// an unset ENIGMA_EDITION keeps the historical top-level build_config.yaml.
/// `custom` is the local Enigma Builder's output (tools/enigma_builder): that
/// file is generated and gitignored, so a fresh checkout has no `custom` config
/// and building one without running the Builder first fails with "not found".
const EDITIONS: &[&str] = &["basic", "standard", "professional", "custom"];

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

// ═══════════════════════════════════════════════════════════════════════════
// Privacy HP — src-tauri/privacy_hp.yaml → `enigma_lib::hp_policy`
// ═══════════════════════════════════════════════════════════════════════════
//
// Same contract as the build config above: parse → validate → codegen, and any
// invalid value fails the build here rather than shipping a wrong price. The
// table is deliberately NOT per-edition (one privacy_hp.yaml, not one per
// configs/*.yaml) — an exposure does not get cheaper with a different tier.
//
// Every HP figure is converted to an integer number of hundredths ("centi-HP")
// at this point, and no float survives into the generated code. That is what
// makes balances reproducible: the ledger and both meters are integer
// arithmetic end to end.

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawHp {
    version: u32,
    scale: HpScale,
    confirm_at_hp: f64,
    meters: HpMeters,
    actions: Vec<HpAction>,
    recovery: HpRecovery,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HpScale {
    negligible: f64,
    low: f64,
    moderate: f64,
    high: f64,
    severe: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HpMeters {
    daily: HpMeter,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HpMeter {
    max: f64,
    regen_hp: f64,
    regen_per_minutes: u64,
    /// The faster period that applies while Tor is on. Must be SMALLER than
    /// `regen_per_minutes` (a shorter period means a higher rate) — running with
    /// Tor may never regenerate more slowly than running without it.
    tor_regen_per_minutes: u64,
    /// Daily has no rolling window — it resets on the local day boundary.
    #[serde(default)]
    window_days: Option<u64>,
}

/// `cost: severe` and `cost: 0.05` are both legal. The ladder is the idiom for a
/// fixed price (and is enforced for one); metered actions bill in fractions
/// below the bottom rung, so they name a number.
#[derive(Deserialize)]
#[serde(untagged)]
enum HpCost {
    Num(f64),
    Named(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HpAction {
    id: String,
    kind: String,
    cost: HpCost,
    #[serde(default)]
    per_mib: Option<f64>,
    #[serde(default)]
    per_minute: Option<f64>,
    #[serde(default)]
    cap_per_event: Option<f64>,
    explain_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HpRecovery {
    daily_cap: f64,
    /// Days the credit ceilings span. Independent of any meter — this bounds how
    /// fast credits can be MINTED, which is an anti-farming rule, not a budget.
    #[serde(default)]
    window_days: Option<u64>,
    window_cap: f64,
    fixed: Vec<HpFixed>,
    data: HpData,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HpFixed {
    id: String,
    credit: f64,
    /// `~` (null) = pays without a paired exposure being live.
    #[serde(default)]
    requires: Option<String>,
    explain_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HpData {
    per_mib: f64,
    min_award: f64,
    max_per_event: f64,
    daily_cap: f64,
    window_cap: f64,
    sources: Vec<HpDataSource>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HpDataSource {
    id: String,
    explain_key: String,
}

/// Ids the app actually charges against. Listed here so that RENAMING one in the
/// YAML fails the build instead of silently making that surface free — the
/// failure mode a price table must never have.
const REQUIRED_HP_ACTIONS: &[&str] = &[
    "transport.onion_stable.enable",
    "dht.nickname.publish",
    "dht.presence.enable",
    "room.create.clearnet",
    "room.create.tor",
    "room.join.clearnet",
    "room.join.tor",
    "invite.personal.create.clearnet",
    "invite.personal.create.tor",
    "invite.general.create.clearnet",
    "invite.general.create.tor",
    "tor.persistent.hold",
    "msg.tor.mls",
    "msg.clearnet.mls",
    "msg.tor.plain",
    "msg.clearnet.plain",
    "calendar.share.tor",
    "calendar.share.clearnet",
    "file.send",
    "vox.call",
    "local.autolock.off",
    "local.pin.enroll",
    "local.panic_code.clear",
    "local.lock_on_hide.off",
    "local.file_integrity.off",
];

/// Recovery ids the app awards. Same rationale as above, mirrored.
const REQUIRED_HP_RECOVERIES: &[&str] = &[
    "dht.nickname.withdraw",
    "dht.presence.withdraw",
    "local.autolock.on",
    "invite.revoke",
    "local.passphrase.strengthen",
    "local.passphrase.change",
    "local.reencrypt.keyring",
    "local.reencrypt.files",
    "room.rekey",
    "room.leave",
];

const REQUIRED_HP_DATA_SOURCES: &[&str] =
    &["data.delete.chat", "data.delete.maps", "data.delete.files"];

/// HP → centi-HP, rejecting a third decimal place. Every price in the table goes
/// through here, so "exact to two places" is enforced rather than assumed.
fn to_centi(path: &str, v: f64, errors: &mut Vec<String>) -> i64 {
    if !v.is_finite() || v < 0.0 {
        errors.push(format!("{path}: {v} must be a finite, non-negative number"));
        return 0;
    }
    let scaled = v * 100.0;
    let rounded = scaled.round();
    if (scaled - rounded).abs() > 1e-6 {
        errors.push(format!(
            "{path}: {v} has more than two decimal places — HP is stored in hundredths"
        ));
        return 0;
    }
    rounded as i64
}

fn validate_hp(cfg: &RawHp, errors: &mut Vec<String>) {
    let mut err = |msg: String| errors.push(format!("privacy_hp.yaml {msg}"));

    if cfg.version != 1 {
        err(format!("version: {} is not supported (expected 1)", cfg.version));
    }

    // The ladder is fixed. Its whole job is to keep prices comparable at a
    // glance, which a re-tuned rung would quietly destroy.
    // Halved 2026-08-24 (privacy_hp.yaml, the note above `scale:`). Pinned here
    // as literals on purpose: the rungs' RATIOS are what make prices comparable
    // at a glance, so re-tuning one silently is exactly what this must catch.
    let expected = [
        ("negligible", cfg.scale.negligible, 0.5),
        ("low", cfg.scale.low, 1.5),
        ("moderate", cfg.scale.moderate, 2.5),
        ("high", cfg.scale.high, 5.0),
        ("severe", cfg.scale.severe, 10.0),
    ];
    for (name, got, want) in expected {
        if (got - want).abs() > f64::EPSILON {
            err(format!("scale.{name}: {got} must be {want} — the ladder is fixed"));
        }
    }

    let ladder = [
        cfg.scale.negligible,
        cfg.scale.low,
        cfg.scale.moderate,
        cfg.scale.high,
        cfg.scale.severe,
    ];
    let on_ladder = |v: f64| ladder.iter().any(|l| (l - v).abs() < 1e-9);

    if !on_ladder(cfg.confirm_at_hp) {
        err(format!(
            "confirm_at_hp: {} is not a rung of the ladder {ladder:?}",
            cfg.confirm_at_hp
        ));
    }

    for (name, m) in [("daily", &cfg.meters.daily)] {
        if m.max <= 0.0 {
            err(format!("meters.{name}.max: must be positive"));
        }
        if m.regen_hp <= 0.0 {
            err(format!("meters.{name}.regen_hp: must be positive"));
        }
        if m.regen_per_minutes == 0 {
            err(format!("meters.{name}.regen_per_minutes: must be at least 1"));
        }
        if m.tor_regen_per_minutes == 0 {
            err(format!("meters.{name}.tor_regen_per_minutes: must be at least 1"));
        }
        // The whole mechanic is "Tor regenerates faster". A config where it did
        // not would invert the incentive silently, so it fails the build.
        if m.tor_regen_per_minutes > m.regen_per_minutes {
            err(format!(
                "meters.{name}.tor_regen_per_minutes: {} is SLOWER than the base {} — running with Tor must never regenerate more slowly",
                m.tor_regen_per_minutes, m.regen_per_minutes
            ));
        }
        if let Some(d) = m.window_days {
            if !(1..=31).contains(&d) {
                err(format!("meters.{name}.window_days: {d} outside 1..=31"));
            }
        }
    }
    if cfg.meters.daily.window_days.is_some() {
        err("meters.daily.window_days: the daily meter resets on the local day boundary and has no rolling window".into());
    }

    // ── actions ───────────────────────────────────────────────────────────────
    let mut seen: Vec<&str> = Vec::new();
    for a in &cfg.actions {
        let p = format!("actions[{}]", a.id);
        if a.id.is_empty()
            || !a.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_')
        {
            err(format!("{p}: id must be non-empty [a-z0-9._]"));
        }
        if seen.contains(&a.id.as_str()) {
            err(format!("{p}: duplicate id"));
        }
        seen.push(&a.id);

        if !a.explain_key.starts_with("hp.explain.") {
            err(format!(
                "{p}.explain_key: '{}' must start with 'hp.explain.' (the i18n namespace)",
                a.explain_key
            ));
        }

        let cost = match &a.cost {
            HpCost::Num(v) => *v,
            HpCost::Named(n) => match n.as_str() {
                "negligible" => cfg.scale.negligible,
                "low" => cfg.scale.low,
                "moderate" => cfg.scale.moderate,
                "high" => cfg.scale.high,
                "severe" => cfg.scale.severe,
                other => {
                    err(format!("{p}.cost: '{other}' is not a rung name"));
                    0.0
                }
            },
        };
        if cost > cfg.scale.severe {
            err(format!("{p}.cost: {cost} exceeds the top rung ({})", cfg.scale.severe));
        }

        match a.kind.as_str() {
            "toggle" | "event" => {
                if !on_ladder(cost) {
                    err(format!(
                        "{p}.cost: {cost} is not a rung of {ladder:?} — a fixed price must land on the ladder"
                    ));
                }
                if a.per_mib.is_some() || a.per_minute.is_some() || a.cap_per_event.is_some() {
                    err(format!("{p}: per_mib / per_minute / cap_per_event belong to kind 'metered'"));
                }
            }
            "metered" => {
                if a.per_mib.is_some() && a.per_minute.is_some() {
                    err(format!("{p}: choose per_mib or per_minute, not both"));
                }
                if let Some(cap) = a.cap_per_event {
                    if cap < cost {
                        err(format!("{p}.cap_per_event: {cap} is below the base cost {cost}"));
                    }
                    if cap > cfg.scale.severe {
                        err(format!("{p}.cap_per_event: {cap} exceeds the top rung"));
                    }
                }
                if (a.per_mib.is_some() || a.per_minute.is_some()) && a.cap_per_event.is_none() {
                    err(format!("{p}: a metered rate needs a cap_per_event, or one event could drain the meter"));
                }
            }
            other => err(format!("{p}.kind: '{other}' is not one of toggle | event | metered")),
        }
    }
    for want in REQUIRED_HP_ACTIONS {
        if !seen.contains(want) {
            err(format!(
                "actions: '{want}' is missing — the app charges it, so removing or renaming it here would make that surface silently free"
            ));
        }
    }

    // ── recovery ──────────────────────────────────────────────────────────────
    let mut rseen: Vec<&str> = Vec::new();
    let mut max_credit = 0.0f64;
    for r in &cfg.recovery.fixed {
        let p = format!("recovery.fixed[{}]", r.id);
        if rseen.contains(&r.id.as_str()) {
            err(format!("{p}: duplicate id"));
        }
        if seen.contains(&r.id.as_str()) {
            err(format!("{p}: id collides with an action id"));
        }
        rseen.push(&r.id);
        if !on_ladder(r.credit) {
            err(format!("{p}.credit: {} is not a rung of {ladder:?}", r.credit));
        }
        max_credit = max_credit.max(r.credit);
        if !r.explain_key.starts_with("hp.explain.") {
            err(format!("{p}.explain_key: must start with 'hp.explain.'"));
        }
        if let Some(req) = &r.requires {
            if !seen.contains(&req.as_str()) {
                err(format!("{p}.requires: '{req}' is not an action id"));
            }
        }
    }
    for want in REQUIRED_HP_RECOVERIES {
        if !rseen.contains(want) {
            err(format!("recovery.fixed: '{want}' is missing — the app awards it"));
        }
    }

    let d = &cfg.recovery.data;
    if d.per_mib <= 0.0 {
        err("recovery.data.per_mib: must be positive".into());
    }
    if d.min_award <= 0.0 {
        err("recovery.data.min_award: must be positive".into());
    }
    if d.max_per_event < d.min_award {
        err("recovery.data.max_per_event: below min_award".into());
    }
    if d.daily_cap < d.max_per_event {
        err("recovery.data.daily_cap: below max_per_event".into());
    }
    if d.window_cap < d.daily_cap {
        err("recovery.data.window_cap: below daily_cap".into());
    }
    let mut dseen: Vec<&str> = Vec::new();
    for src in &d.sources {
        if dseen.contains(&src.id.as_str()) || seen.contains(&src.id.as_str()) || rseen.contains(&src.id.as_str()) {
            err(format!("recovery.data.sources[{}]: duplicate or colliding id", src.id));
        }
        dseen.push(&src.id);
        if !src.explain_key.starts_with("hp.explain.") {
            err(format!("recovery.data.sources[{}].explain_key: must start with 'hp.explain.'", src.id));
        }
    }
    for want in REQUIRED_HP_DATA_SOURCES {
        if !dseen.contains(want) {
            err(format!("recovery.data.sources: '{want}' is missing — the app awards it"));
        }
    }

    // Caps must be able to pay at least one of anything, or a credit the UI
    // advertises could never actually land.
    if cfg.recovery.daily_cap < max_credit {
        err(format!(
            "recovery.daily_cap: {} cannot pay the largest single credit ({max_credit})",
            cfg.recovery.daily_cap
        ));
    }
    if cfg.recovery.window_cap < cfg.recovery.daily_cap {
        err("recovery.window_cap: below daily_cap".into());
    }
}

fn generate_hp(cfg: &RawHp, errors: &mut Vec<String>) -> String {
    let mut o = String::new();
    let _ = write!(
        &mut o,
        r#"// @generated from privacy_hp.yaml by build.rs — do not edit.
//
// All HP figures are CENTI-HP (hundredths). The webview never sends a number:
// it names an action id and this table supplies the price.

/// How an action is billed. Mirrored in rakotis' `privacyHp.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HpKind {{
    /// Charged on the off→on transition only; re-affirming costs nothing.
    Toggle,
    /// Charged on every activation.
    Event,
    /// Base + per-MiB or per-minute rate, capped, coalesced into hourly buckets.
    Metered,
}}

impl HpKind {{
    pub fn as_str(self) -> &'static str {{
        match self {{
            HpKind::Toggle => "toggle",
            HpKind::Event => "event",
            HpKind::Metered => "metered",
        }}
    }}
}}

pub struct HpAction {{
    pub id: &'static str,
    pub kind: HpKind,
    pub cost_centi: i64,
    /// 0 = not billed by size.
    pub per_mib_centi: i64,
    /// 0 = not billed by duration.
    pub per_minute_centi: i64,
    /// 0 = uncapped (only legal when there is no metered rate).
    pub cap_per_event_centi: i64,
    pub explain_key: &'static str,
}}

pub struct HpRecovery {{
    pub id: &'static str,
    pub credit_centi: i64,
    /// `Some(action_id)` = pays only while that exposure is live and unrecovered.
    pub requires: Option<&'static str>,
    pub explain_key: &'static str,
}}

pub struct HpDataSource {{
    pub id: &'static str,
    pub explain_key: &'static str,
}}

pub const VERSION: u32 = {version};
pub const CONFIRM_AT_CENTI: i64 = {confirm_at};

pub const DAILY_MAX_CENTI: i64 = {d_max};
pub const DAILY_REGEN_CENTI: i64 = {d_regen};
pub const DAILY_REGEN_PER_MINUTES: i64 = {d_per};
/// The faster period while Tor is on (smaller = faster).
pub const DAILY_TOR_REGEN_PER_MINUTES: i64 = {d_tor};

pub const RECOVERY_DAILY_CAP_CENTI: i64 = {r_daily};
pub const RECOVERY_WINDOW_CAP_CENTI: i64 = {r_window};
/// Days the credit ceilings span. Not a meter — an anti-farming bound.
pub const CREDIT_WINDOW_DAYS: i64 = {c_days};

pub const DATA_PER_MIB_CENTI: i64 = {dd_per_mib};
pub const DATA_MIN_AWARD_CENTI: i64 = {dd_min};
pub const DATA_MAX_PER_EVENT_CENTI: i64 = {dd_max};
pub const DATA_DAILY_CAP_CENTI: i64 = {dd_daily};
pub const DATA_WINDOW_CAP_CENTI: i64 = {dd_window};

pub const ACTIONS: &[HpAction] = &[
{actions}];

pub const RECOVERIES: &[HpRecovery] = &[
{recoveries}];

pub const DATA_SOURCES: &[HpDataSource] = &[
{sources}];

/// The price of `id`, or `None` if this build has no such action. Every charge
/// path goes through here — that is what makes a forged price impossible.
pub fn action(id: &str) -> Option<&'static HpAction> {{
    ACTIONS.iter().find(|a| a.id == id)
}}

pub fn recovery(id: &str) -> Option<&'static HpRecovery> {{
    RECOVERIES.iter().find(|r| r.id == id)
}}

pub fn data_source(id: &str) -> Option<&'static HpDataSource> {{
    DATA_SOURCES.iter().find(|d| d.id == id)
}}
"#,
        version = cfg.version,
        confirm_at = to_centi("confirm_at_hp", cfg.confirm_at_hp, errors),
        d_max = to_centi("meters.daily.max", cfg.meters.daily.max, errors),
        d_regen = to_centi("meters.daily.regen_hp", cfg.meters.daily.regen_hp, errors),
        d_per = cfg.meters.daily.regen_per_minutes,
        d_tor = cfg.meters.daily.tor_regen_per_minutes,
        r_daily = to_centi("recovery.daily_cap", cfg.recovery.daily_cap, errors),
        r_window = to_centi("recovery.window_cap", cfg.recovery.window_cap, errors),
        c_days = cfg.recovery.window_days.unwrap_or(7),
        dd_per_mib = to_centi("recovery.data.per_mib", cfg.recovery.data.per_mib, errors),
        dd_min = to_centi("recovery.data.min_award", cfg.recovery.data.min_award, errors),
        dd_max = to_centi("recovery.data.max_per_event", cfg.recovery.data.max_per_event, errors),
        dd_daily = to_centi("recovery.data.daily_cap", cfg.recovery.data.daily_cap, errors),
        dd_window = to_centi("recovery.data.window_cap", cfg.recovery.data.window_cap, errors),
        actions = {
            let mut s = String::new();
            for a in &cfg.actions {
                let cost = match &a.cost {
                    HpCost::Num(v) => *v,
                    HpCost::Named(n) => match n.as_str() {
                        "negligible" => cfg.scale.negligible,
                        "low" => cfg.scale.low,
                        "moderate" => cfg.scale.moderate,
                        "high" => cfg.scale.high,
                        "severe" => cfg.scale.severe,
                        _ => 0.0,
                    },
                };
                let kind = match a.kind.as_str() {
                    "toggle" => "HpKind::Toggle",
                    "event" => "HpKind::Event",
                    _ => "HpKind::Metered",
                };
                let _ = writeln!(
                    &mut s,
                    "    HpAction {{ id: {id}, kind: {kind}, cost_centi: {cost}, per_mib_centi: {mib}, per_minute_centi: {min}, cap_per_event_centi: {cap}, explain_key: {ek} }},",
                    id = rust_str(&a.id),
                    kind = kind,
                    cost = to_centi(&format!("actions[{}].cost", a.id), cost, errors),
                    mib = a.per_mib.map(|v| to_centi(&format!("actions[{}].per_mib", a.id), v, errors)).unwrap_or(0),
                    min = a.per_minute.map(|v| to_centi(&format!("actions[{}].per_minute", a.id), v, errors)).unwrap_or(0),
                    cap = a.cap_per_event.map(|v| to_centi(&format!("actions[{}].cap_per_event", a.id), v, errors)).unwrap_or(0),
                    ek = rust_str(&a.explain_key),
                );
            }
            s
        },
        recoveries = {
            let mut s = String::new();
            for r in &cfg.recovery.fixed {
                let req = match &r.requires {
                    Some(x) => format!("Some({})", rust_str(x)),
                    None => "None".to_string(),
                };
                let _ = writeln!(
                    &mut s,
                    "    HpRecovery {{ id: {id}, credit_centi: {c}, requires: {req}, explain_key: {ek} }},",
                    id = rust_str(&r.id),
                    c = to_centi(&format!("recovery.fixed[{}].credit", r.id), r.credit, errors),
                    req = req,
                    ek = rust_str(&r.explain_key),
                );
            }
            s
        },
        sources = {
            let mut s = String::new();
            for d in &cfg.recovery.data.sources {
                let _ = writeln!(
                    &mut s,
                    "    HpDataSource {{ id: {id}, explain_key: {ek} }},",
                    id = rust_str(&d.id),
                    ek = rust_str(&d.explain_key),
                );
            }
            s
        },
    );
    o
}

fn generate_privacy_hp() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
    let manifest_dir = Path::new(&manifest_dir);
    let yaml_path = manifest_dir.join("privacy_hp.yaml");
    println!("cargo:rerun-if-changed=privacy_hp.yaml");

    let raw = std::fs::read_to_string(&yaml_path).unwrap_or_else(|e| {
        panic!(
            "\n\nprivacy_hp.yaml not found at {} ({e}) — the Privacy HP price table is required (see technology.md §17)\n",
            yaml_path.display()
        )
    });
    let cfg: RawHp = serde_norway::from_str(&raw)
        .unwrap_or_else(|e| panic!("\n\nprivacy_hp.yaml is not valid:\n  {e}\n"));

    let mut errors = Vec::new();
    validate_hp(&cfg, &mut errors);
    let generated = generate_hp(&cfg, &mut errors); // to_centi reports here too
    if !errors.is_empty() {
        let list: String = errors.iter().map(|e| format!("  - {e}\n")).collect();
        panic!("\n\nprivacy_hp.yaml is invalid:\n{list}");
    }

    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let out_path = Path::new(&out_dir).join("hp_policy_gen.rs");
    std::fs::write(&out_path, generated)
        .unwrap_or_else(|e| panic!("cannot write {}: {e}", out_path.display()));
}

fn main() {
    generate_build_config(); // fail fast, before tauri_build
    generate_privacy_hp();
    tauri_build::build()
}
