// What this build actually does with cryptography, as data.
//
// Data rather than markup, for two reasons. The view becomes a renderer, so a
// claim cannot be quietly edited into a template nobody reads; and the list can
// be TESTED — every row's prose asserted present in both catalogues, which is
// what stops a half-translated security page from rendering raw i18n keys where
// a statement of fact should be.
//
// The claims here were established by reading the source, not the comments:
// four doc comments in this repository were stale about exactly these facts,
// which is a large part of why this page exists at all.

export type CapabilityStatus =
  /** Used, right now, by something a person can reach. */
  | "active"
  /** Recognised on the way in; nothing writes it any more. */
  | "legacy"
  /** Compiled into the binary and called by nothing. */
  | "dormant"
  /** In the repository, deliberately outside the build. */
  | "parked"
  /** A protection this build does NOT have. */
  | "absent";

export type CapabilityGroup = "sealing" | "reach" | "content" | "keys";

export interface Capability {
  /** Stable: it is the i18n leaf AND the row's testid. */
  id: string;
  group: CapabilityGroup;
  /** A PROPER NOUN — an algorithm, a format, a library. Rendered verbatim in
   *  every locale and deliberately kept out of both catalogues: "Argon2id" is
   *  not a word anyone translates, and the same string in two files is two
   *  chances to typo one of them. Empty when the row is about a posture rather
   *  than a primitive. */
  name: string;
  status: CapabilityStatus;
}

export const CAPABILITIES: readonly Capability[] = [
  { id: "seal", group: "sealing", name: "XChaCha20-Poly1305", status: "active" },
  { id: "kdf", group: "sealing", name: "Argon2id", status: "active" },
  { id: "frame", group: "sealing", name: "ZINNLOCK v1", status: "active" },
  { id: "write", group: "sealing", name: "", status: "active" },
  { id: "platform", group: "sealing", name: "TOTOSEAL, Fernet", status: "legacy" },
  { id: "openssl", group: "sealing", name: "OpenSSL", status: "active" },

  { id: "workspace", group: "reach", name: "", status: "active" },
  { id: "network", group: "reach", name: "", status: "parked" },

  { id: "csp", group: "content", name: "Content-Security-Policy", status: "active" },
  { id: "cspLimit", group: "content", name: "", status: "absent" },
  { id: "render", group: "content", name: "", status: "active" },
  { id: "refusal", group: "content", name: "", status: "active" },

  { id: "passphrase", group: "keys", name: "", status: "active" },
  { id: "keyring", group: "keys", name: "", status: "absent" },
  { id: "dormantCrypto", group: "keys", name: "gervasius, rakotis", status: "dormant" },
];

export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  "sealing",
  "reach",
  "content",
  "keys",
];

export function capabilitiesIn(group: CapabilityGroup): Capability[] {
  return CAPABILITIES.filter((c) => c.group === group);
}
