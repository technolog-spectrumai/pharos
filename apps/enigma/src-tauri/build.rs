//! Bakes build_config.yaml into the binary: parse → validate → generate
//! `$OUT_DIR/build_config_gen.rs` (included as `enigma_lib::build_config`).
//! Any invalid or missing value fails the build here, before compilation;
//! algorithm declarations are additionally const-asserted in the generated
//! code against Rutile's crypto crates, so drift in either direction
//! (YAML edited, or rotor_core/gervasius changed) is a compile error.
//!
//! What is NOT decided here: which optional features a build contains. Those
//! are Cargo features (`[features]` in Cargo.toml), chosen by the root build
//! config and compiled in or out with `#[cfg(feature = "…")]` — see
//! technology.md §20. This file is the same for every build.

use std::env;
use std::fmt::Write as _;
use std::path::Path;

use serde::Deserialize;

// ── YAML schema (all fields required: the file is the complete record) ──────

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    crypto: CryptoSection,
    settings: SettingsSection,
    network: NetworkSection,
}

/// The app's identity. Not in the YAML: tauri.conf.json owns it — that file is
/// what the native bundle is built from — and it is read here so the Rust side
/// can never disagree with the package it ships in.
struct AppIdentity {
    name: String,
    identifier: String,
    version: String,
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
struct SettingsSection {
    connect_timeout_secs: Clamp,
    max_file_size_mb: Clamp,
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

const FIXED_APP_NAME: &str = "Enigma27";
const FIXED_APP_IDENTIFIER: &str = "com.spectrumaipl.enigma27";

/// Read the identity out of tauri.conf.json, and hold it to the fixed one.
fn read_identity(manifest_dir: &Path, errors: &mut Vec<String>) -> AppIdentity {
    let conf_path = manifest_dir.join("tauri.conf.json");
    let conf = std::fs::read_to_string(&conf_path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string()))
        .unwrap_or_else(|e| {
            errors.push(format!("tauri.conf.json: cannot read {}: {e}", conf_path.display()));
            serde_json::Value::Null
        });
    let field = |key: &str| conf.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let id = AppIdentity { name: field("productName"), identifier: field("identifier"), version: field("version") };

    if id.name != FIXED_APP_NAME {
        errors.push(format!(
            "tauri.conf.json productName: '{}' must be '{FIXED_APP_NAME}' (app name is not configurable)",
            id.name
        ));
    }
    if id.identifier != FIXED_APP_IDENTIFIER {
        errors.push(format!(
            "tauri.conf.json identifier: '{}' must be '{FIXED_APP_IDENTIFIER}' (Android applicationId is not configurable)",
            id.identifier
        ));
    }
    if id.version.trim().is_empty() {
        errors.push("tauri.conf.json version: must not be empty".into());
    }
    id
}

fn validate(cfg: &RawConfig, errors: &mut Vec<String>) {
    let mut err = |path: &str, msg: String| errors.push(format!("{path}: {msg}"));

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
        ("settings.max_file_size_mb", &cfg.settings.max_file_size_mb, 0u64),
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

fn generate(cfg: &RawConfig, app: &AppIdentity) -> String {
    let mut o = String::new();
    let _ = write!(
        &mut o,
        r#"// @generated from build_config.yaml by build.rs — do not edit.

pub mod app {{
    pub const NAME: &str = {name};
    pub const IDENTIFIER: &str = {identifier};
    pub const VERSION: &str = {version};
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

pub mod settings {{
    pub const CONNECT_TIMEOUT_DEFAULT_SECS: u64 = {ct_def};
    pub const CONNECT_TIMEOUT_MIN_SECS: u64 = {ct_min};
    pub const CONNECT_TIMEOUT_MAX_SECS: u64 = {ct_max};
    pub const MAX_FILE_SIZE_DEFAULT_MB: u64 = {fs_def};
    pub const MAX_FILE_SIZE_MIN_MB: u64 = {fs_min};
    pub const MAX_FILE_SIZE_MAX_MB: u64 = {fs_max};
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
        name = rust_str(&app.name),
        identifier = rust_str(&app.identifier),
        version = rust_str(&app.version),
        mls = rust_str(&cfg.crypto.mls_ciphersuite),
        aead = rust_str(&cfg.crypto.at_rest_aead),
        kdf_alg = rust_str(&cfg.crypto.kdf.algorithm),
        m_cost = cfg.crypto.kdf.m_cost_kib,
        t_cost = cfg.crypto.kdf.t_cost,
        p_cost = cfg.crypto.kdf.p_cost,
        ct_def = cfg.settings.connect_timeout_secs.default,
        ct_min = cfg.settings.connect_timeout_secs.min,
        ct_max = cfg.settings.connect_timeout_secs.max,
        fs_def = cfg.settings.max_file_size_mb.default,
        fs_min = cfg.settings.max_file_size_mb.min,
        fs_max = cfg.settings.max_file_size_mb.max,
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
    );
    o
}

fn generate_build_config() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
    let manifest_dir = Path::new(&manifest_dir);
    // One file, the same for every build. What varies between builds is the
    // feature list, and that is cargo's.
    let yaml_path = manifest_dir.join("build_config.yaml");
    println!("cargo:rerun-if-changed=build_config.yaml");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    let raw = std::fs::read_to_string(&yaml_path).unwrap_or_else(|e| {
        panic!(
            "\n\nbuild config not found at {} ({e}) — this file is required (see technology.md §19)\n",
            yaml_path.display()
        )
    });
    let cfg: RawConfig = serde_norway::from_str(&raw).unwrap_or_else(|e| {
        panic!("\n\nbuild config is not valid ({}):\n  {e}\n", yaml_path.display())
    });

    let mut errors = Vec::new();
    let app = read_identity(manifest_dir, &mut errors);
    validate(&cfg, &mut errors);
    if !errors.is_empty() {
        let list: String = errors.iter().map(|e| format!("  - {e}\n")).collect();
        panic!("\n\nbuild config is invalid:\n{list}(file: {})\n", yaml_path.display());
    }

    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let out_path = Path::new(&out_dir).join("build_config_gen.rs");
    std::fs::write(&out_path, generate(&cfg, &app))
        .unwrap_or_else(|e| panic!("cannot write {}: {e}", out_path.display()));
}

fn main() {
    generate_build_config(); // fail fast, before tauri_build
    tauri_build::build()
}
