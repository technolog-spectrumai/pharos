// ─────────────────────────────────────────────────────────────────────────────
// Enigma app config — brand identity, UI policy, and dev-tooling constants that
// the *frontend* consumes. Values that also exist in a build manifest
// (tauri.conf.json / Cargo.toml / vite.config.ts) are mirrored here with a note;
// those manifests remain authoritative for the native build, and technology.md §15
// tracks the pairs that must be bumped together.
//
// In the Tauri runtime, src-tauri/build_config.yaml (compile-time, fetched via
// `app_get_build_config` → rakotis `getBuildConfig()`) is AUTHORITATIVE for the
// values it covers: allow flags, feature defaults, setting defaults/clamps.
// main.ts seeds rakotis' browser-mode fallback from this file, so keep the
// overlapping values here in sync with the default build_config.yaml.
//
// Keep this file free of Vue/runtime imports so it can be imported anywhere
// (components, stores, tests) without side effects.
// ─────────────────────────────────────────────────────────────────────────────

const LEGAL_URL = "www.spectrumai.pl";

/** Brand / legal identity. `name` is the canonical human-facing spelling
 *  ("Enigma") — mirror of tauri.conf.json `productName` / window title.
 *  `bundleId` mirrors tauri.conf.json `identifier` and Android applicationId. */
export const brand = {
  name: "Enigma",
  org: "SpectrumAI",
  legalUrl: LEGAL_URL,
  copyright: `© ${LEGAL_URL}. All rights reserved.`,
  bundleId: "com.spectrumaipl.enigma",
} as const;

/** User-facing UI policy. NOTE: these are *frontend* guards only — the Rust side
 *  does not currently re-enforce them (a direct `invoke` bypasses them). If any of
 *  these becomes a security boundary, enforce the same value in Rust too
 *  (see technology.md §15 → "Policy enforced on both layers"). */
export const policy = {
  /** Minimum passphrase length for the at-rest vault (App.vue setup gate). */
  passphraseMinLen: 8,
  /** Profile display-name cap (EnigmaProfileView "Your name" field). */
  displayNameMaxLen: 150,
  /** Profile / data-profile label cap (the "New profile name" and data-profile
   *  identifier fields in EnigmaProfileView / EnigmaConfigView). */
  profileNameMaxLen: 80,
  /** Default state of the P2P feature switches — mirrors the default
   *  build_config.yaml `features:` section (which drives the Rust
   *  `AppProfileState` defaults). The backend is authoritative; the UI must
   *  never hardcode a different default. Browser-mode fallback via main.ts. */
  featureDefaults: { offline: false, stableOnion: false },
  /** A short message: at most this many characters (Pharos decision PD7). */
  maxMessageChars: 1000,
} as const;

/** Dev-tooling constants. `vitePort` MUST agree with vite.config.ts `server.port`,
 *  tauri.conf.json `devUrl` (which Rutile's dev-server shim reads) — this is the
 *  documented reference for that value (those files own their own copy today). */
export const dev = {
  vitePort: 1420,
} as const;
