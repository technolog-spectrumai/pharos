// What the Cloud tab remembers between launches.
//
// Everything here is NON-SECRET by construction — the server address, the
// account name, and the fingerprint of a certificate the user chose to trust.
// The token is not here and never will be: it lives in the OS secret store,
// written and read only by src-tauri/src/cloud.rs. This app renders untrusted
// `.svg` files and deck HTML with no CSP, so anything in localStorage should be
// assumed readable by a document the user merely opened.
//
// The fingerprint is stored rather than derived because it is the record of a
// decision: "I looked at this certificate and accepted it". Recomputing it
// would defeat the point — the whole value is that a DIFFERENT certificate
// stops matching.
//
// Pure functions, so they can be tested without a component — the same split
// as systemColors.ts.

export interface CloudSettings {
  /** Normalised by Rust and stored verbatim. Never recomputed here: this is the
   *  key the token is filed under, and a second normalizer that drifted would
   *  orphan the credential while leaving it on disk. */
  server: string;
  /** The certificate fingerprint the user accepted for this server, if any. */
  fingerprint: string;
}

const STORAGE_KEY = "zinnia:cloud";

export const EMPTY: CloudSettings = { server: "", fingerprint: "" };

/** SHA-256 as `AA:BB:…`, 32 uppercase hex pairs — the shape Rust emits and the
 *  shape `openssl x509 -fingerprint -sha256` prints, so the two are comparable
 *  by eye. */
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT.test(value.toUpperCase());
}

/** Per FIELD, never all-or-nothing: a stored blob from an older build is
 *  missing whatever was added since, and discarding the whole record to repair
 *  one absent field would sign the user out for no reason. */
export function normalize(raw: unknown): CloudSettings {
  const stored = (raw ?? {}) as Record<string, unknown>;
  return {
    server: typeof stored.server === "string" ? stored.server : "",
    fingerprint: isFingerprint(stored.fingerprint) ? stored.fingerprint.toUpperCase() : "",
  };
}

export function load(): CloudSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalize(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...EMPTY };
  }
}

export function save(settings: CloudSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* a full or blocked store must not break the tab */
  }
}
