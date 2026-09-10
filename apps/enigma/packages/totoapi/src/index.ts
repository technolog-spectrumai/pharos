// totoapi — everything an app says to a toto platform server.
//
// Lifted out of `limbo/cloud` on 2026-09-10, where it had been parked since
// 8/2026 as zinnia's Cloud tab. Nothing there was broken — the sign-in flow,
// the certificate pinning, the content-hash precondition and the error taxonomy
// were all written and tested — it was parked because zinnia is local-first and
// that was the one part which could not run offline. `py_editor` and
// `tex_editor` are remote by definition, so it comes back.
//
// WHAT CHANGED IN THE LIFT, and nothing else did:
//   * `auth.ts` — a capsule API token pasted once, not a username and password.
//     Its own header predicted this swap and said the call sites would not
//     change. They did not.
//   * `errors.ts` — a `refused` kind carrying the server's machine-readable
//     `code`, and 409 now tells a save conflict apart from a named refusal by
//     shape rather than by status.
//   * `settings.ts` — the localStorage key is per app rather than the constant
//     `"zinnia:cloud"`, because two editors may point at two servers.
//   * `capsules.ts` / `workspaces.ts` — new, transcribed from the server's own
//     dict literals rather than guessed.
//
// WHAT DID NOT CHANGE, deliberately: `normalizeServerUrl` is still FROZEN. That
// string is the keyring account name, so a machine that signed in under the old
// build still has a credential filed under it, and a changed rule would orphan
// it with nothing able to enumerate what was lost.
export * from "./api";
export * from "./platform";
