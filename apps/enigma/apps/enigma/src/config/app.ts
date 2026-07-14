// ─────────────────────────────────────────────────────────────────────────────
// Enigma app config — the single source of truth for brand identity, UI policy,
// and dev-tooling constants that the *frontend* consumes. Values that also exist
// in a build manifest (tauri.conf.json / Cargo.toml / vite.config.ts) are mirrored
// here with a note; those manifests remain authoritative for the native build, and
// CONVENTIONS.md tracks the pairs that must be bumped together.
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
 *  (see CONVENTIONS.md → "Policy split across layers"). */
export const policy = {
  /** Minimum passphrase length for the at-rest vault (App.vue setup gate). */
  passphraseMinLen: 8,
  /** Profile display-name cap (EnigmaProfileView "Your name" field). */
  displayNameMaxLen: 150,
  /** Profile / data-profile label cap (the "New profile name" and data-profile
   *  identifier fields in EnigmaProfileView / EnigmaConfigView). */
  profileNameMaxLen: 80,
  /** Default state of the P2P feature switches — mirrors the Rust
   *  `AppProfileState` serde defaults (all false). The backend is authoritative;
   *  the UI must never hardcode a different default. */
  featureDefaults: { offline: false, useTor: false, stableOnion: false },
  /** P2P file-transfer UI policy. */
  fileShare: {
    /** Transfers this size or smaller (bytes) render without a progress bar —
     *  they finish instantly, a bar is noise. */
    progressBarMinBytes: 1024,
    /** Default "max file size" (MB) before the user changes it in Settings;
     *  0 = unlimited. Rakotis can't import app config, so callers pass this to
     *  `getMaxFileSizeMb` / `setMaxFileSizeMb`. */
    defaultMaxFileSizeMb: 16,
  },
} as const;

/** Dev-tooling constants. `vitePort` MUST agree with vite.config.ts `server.port`,
 *  tauri.conf.json `devUrl`, and scripts/tauri-dev-server.mjs — this is the
 *  documented reference for that value (those files own their own copy today). */
export const dev = {
  vitePort: 1420,
} as const;
