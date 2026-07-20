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
 *  ("Enigma") — mirror of tauri.conf.json `productName` / window title, which use
 *  the same capitalized form. `bundleId` mirrors tauri.conf.json `identifier`. */
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
  featureDefaults: { offline: false, useTor: false, stableOnion: false },
  /** P2P file-transfer UI policy. */
  fileShare: {
    /** Transfers this size or smaller (bytes) render without a progress bar —
     *  they finish instantly, a bar is noise. */
    progressBarMinBytes: 1024,
    /** Default "max file size" (MB) before the user changes it in Settings;
     *  0 = unlimited. Mirrors build_config.yaml `settings.max_file_size_mb`
     *  (authoritative in Tauri); main.ts passes this as the browser-mode
     *  fallback to `initBuildConfig`. */
    defaultMaxFileSizeMb: 16,
  },
  /** Maps UI policy. */
  map: {
    /** Initial view when NO region is active: whole-world. When the user has
     *  explicitly activated a region, the map deliberately opens spread to it
     *  (their own choice, stored sealed per profile) — that is the one
     *  sanctioned "stored location" in the app. */
    defaultCenter: [10, 30] as [number, number], // [lng, lat]
    defaultZoom: 1.5,
    /** Source maxzoom used until map_source_info answers (protomaps builds
     *  are z15; overzoom renders beyond it either way). */
    fallbackSourceMaxZoom: 15,
  },
} as const;

/** Dev-tooling constants. `vitePort` MUST agree with vite.config.ts `server.port`,
 *  tauri.conf.json `devUrl`, and scripts/tauri-dev-server.mjs — this is the
 *  documented reference for that value (those files own their own copy today). */
export const dev = {
  vitePort: 1420,
} as const;
