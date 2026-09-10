# the cloud — sign-in, the vault, and the client under both, parked (8/2026)

> **PARTIALLY REVIVED 2026-09-10.** Five files left this directory for
> `packages/totoapi`, because `py_editor` and `tex_editor` are remote by
> definition and needed exactly the half that was parked for being remote:
>
> | Left for | Was |
> |---|---|
> | `packages/totoapi/src/api/client.ts` | `src/api/client.ts` |
> | `packages/totoapi/src/api/errors.ts` | `src/api/errors.ts` |
> | `packages/totoapi/src/api/transport.ts` | `src/api/transport.ts` |
> | `packages/totoapi/src/platform/settings.ts` | `src/cloud/cloudSettings.ts` |
> | `packages/totoapi/tests/unit/*` | `tests/unit/{apiClient,cloudSettings}.test.ts` |
>
> What CHANGED in the lift is listed in `packages/totoapi/src/index.ts`. The
> short version: `auth.ts` was rewritten around capsule API tokens rather than
> `POST /api/login/` — its own header predicted that swap and said the call
> sites would not change, and they did not — and `normalizeServerUrl` is
> **still frozen**, for the reason this file gives below.
>
> **What is still here is still parked**, and most of it is the VAULT half:
> `vault.ts`, `cloudTree.ts`, `useCloudFiles.ts`, `useCloud.ts`, `CloudView.vue`
> and the old `auth.ts`. The new apps browse WORKSPACES (`/api/v1/workspaces`),
> which is a different surface with a different permission model, so none of it
> was reusable as it stood. `src-tauri/src/cloud.rs` is still here too and is
> the next thing to lift — see "To lift it back", which still applies to it
> verbatim, including the Cargo features a fresh `cargo add` will not pick.


UNUSED. This is everything zinnia said to a toto platform server: a Cloud tab
that signed in over a pinned TLS connection, a vault browser in the Files tab,
an editor buffer that remembered which vault row it came from and saved itself
back there, and the typed HTTP client all three sat on.

It is parked because zinnia is a local-first office suite and this was the only
part of it that could not run offline. Nothing here was broken — the sign-in
flow, the certificate pinning, the content-hash precondition on saves and the
error taxonomy were all written and tested — so this is a product decision, not
a repair. It can come back whole.

## What is here

| Path in limbo | Came from | What it is |
|---|---|---|
| `src/api/client.ts` | `src/api/` | The one HTTP door: URL normalisation, headers, status→error mapping. |
| `src/api/errors.ts` | `src/api/` | The taxonomy every caller switches on instead of a status code. |
| `src/api/auth.ts` | `src/api/` | `POST /api/login/`, `/api/logout/`, `/api/me/`. |
| `src/api/vault.ts` | `src/api/` | The vault endpoints and their DTOs, transcribed from `toto/vault/api_views.py`. |
| `src/api/transport.ts` | `src/api/` | The `fetchImpl` that routes every request through Rust so the token never reaches JS. |
| `src/cloud/cloudSettings.ts` | `src/cloud/` | What the tab remembered: server address and accepted fingerprint. Non-secret by construction. |
| `src/cloud/useCloud.ts` | `src/cloud/` | The session as the UI saw it — a module-level ref store, no token in it. |
| `src/files/cloudTree.ts` | `src/files/` | Buckets + directories → flat depth-tagged rows. |
| `src/files/useCloudFiles.ts` | `src/files/` | The vault store: listing, open, save, push, delete, folders, server-side encrypt. |
| `src/views/CloudView.vue` | `src/views/` | The sign-in surface and the certificate-acceptance step. |
| `src-tauri/src/cloud.rs` | `src-tauri/src/` | The five commands, the pinned verifier, the keyring. |
| `tests/**` | `tests/` | Its four suites, 54 tests, all green when parked. |

## What left with it, and what changed elsewhere

- **The Cloud TAB is gone, not hidden.** `"cloud"` left `AppTabId` and its row
  left `APP_TABS` (`src/tabs.ts`), and `App.vue` no longer imports or mounts
  `CloudView`. A tab kept as a disabled stub would be a promise the app cannot
  keep, and `AppTabId` is what every `data-testid="nav-…"` is derived from.
- **The Files tab lost its cloud pane and its sub-tab bar.** `FilesView.vue` was
  two panes behind a two-button switch; one pane left, so the switch left too
  rather than staying on as a bar with a single button. What survives is the
  local workspace browser — `useWorkspace`, breadcrumbs, and routing a file to
  the editor its bytes call for.
- **`EditorHost` saves only to disk.** `remote`, `saveToVault` and `freshHash`
  went, and `openRemote(name, text, origin?)` lost its third argument. It kept
  its name: it is still the door a buffer arrives through when it did not come
  from the Open dialog, which is what the Files panel hands over.
- **`kindForVaultFile` and `BY_VAULT_TYPE` left `src/files/openWith.ts`.** They
  answered "the server already typed this row, believe it over the filename" —
  a question with no asker now. `kindForFile` and the `.xml` sniffers stay: they
  are what routes a file on disk, and they are LEGACY RESCUE for every deck
  written before `.pxml` existed.
- **Five Rust commands and six crates.** `mod cloud;` and
  `cloud_probe/login/logout/status/request` left `src-tauri/src/lib.rs`, and
  `reqwest`, `rustls`, `rustls-pki-types`, `webpki-roots`, `sha2` and `keyring`
  left `Cargo.toml`. That is the bulk of the crate's dependency tree and most of
  its build time; leaving them pinned for code nothing calls would have been the
  expensive half of not deleting this.
- **Icons.** `faCloud`, `faPlug`, `faHardDrive`, `faDownload` and `faFolderPlus`
  left `src/icons.ts`, and so did the exported `NODE_ICONS` map — its two keys
  were `bucket` and `directory`, which are vault nouns. FontAwesome renders an
  unregistered name as nothing at all, so `tests/unit/icons.test.ts` scans the
  templates; it is what will catch a revival that forgets to put these back.
- **Both catalogues.** The whole `cloud` section (including `cloud.apiErrors.*`,
  which was the error taxonomy's user-facing half), `nav.cloud`,
  `files.{cloudTab,localTab,signInFirst,listCapped,noFolders,encrypted,download,delete,deleteTitle,deleteBody,newFolder,newFolderTitle,create}`
  and `file.{savedToCloud,cloudConflict,cloudLocked,pushedToCloud}` left
  `src/i18n/en.ts` and `src/i18n/pl.ts`. `settings.empty` also stopped promising
  that "the platform connection will move here".
- **Tests.** Four suites moved with the code. `tests/component/filesView.test.ts`
  was rewritten against the local pane (it had mocked the Tauri boundary to fake
  a server; it now mocks `readDir`/`stat`/`readTextFile`), the tab-order
  assertion in `tests/component/tabs.test.ts` lost `"cloud"`, and the vault
  cases left `tests/unit/openWith.test.ts`.
- **The README** lost its `src/api` section.

## What did NOT change, deliberately

- **`src-tauri/src/lock.rs` stays, and all three of its commands are now live.**
  File locking was the platform's format — Argon2id then XChaCha20-Poly1305 —
  but the sealing itself is local and needs no server. When this was written,
  `lock_file` and `unlock_file` had no caller: they took the salt and Argon2
  costs as parameters, and the only thing that fetched them was
  `useCloudFiles.strongbox()`. Parking cloud did not strand them so much as
  remove the route by which a caller would have got the salt.

  **That question has since been answered, and not by reviving anything here.**
  A sealed file now carries its own randomly drawn salt and its wrapped key in
  its own header (`ZINNLOCK`), so it needs no external salt at all — see
  `lock.rs` for why, and the Security tab for what it means. The consequence
  for a revival: files sealed by this build are NOT the platform's format and
  will not open server-side, and files the platform sealed are detected but
  refused here. Restoring cross-device sealing would mean restoring the
  strongbox endpoint AND a second write path, not just this directory.

- **`src/files/LockModal.vue` stays.** It is generic — it takes an `action`
  callback and knows nothing about a server — and it was already unmounted. It
  is the UI half a local lock feature would use.
- **`gervasius`, and the whole `packages/rakotis` subtree.** Untouched. The
  crate implements the shared seal format and is a `path` dependency of the
  Tauri crate; the subtree is pulled from its own remote and must not be edited
  here.
- **The `normalizeServerUrl` freeze.** The rule is still frozen — in
  `limbo/cloud/src/api/client.ts` and in `normalize()` in
  `limbo/cloud/src-tauri/src/cloud.rs`, which must keep agreeing. That string is
  the keyring account name, so a machine that signed in before this was parked
  still has a token filed under it. Changing the rule during a revival would
  orphan that credential with nothing able to enumerate what was lost.

## Anything left on a user's machine

- **The keyring entry survives.** Service `com.spectrumaipl.zinnia`, account =
  the normalised server URL, value = `{"token":…,"username":…}` as JSON. Nothing
  in the app reads or clears it now. It is a live session key, so a build that
  never signs out leaves one behind; a revival picks it straight back up, and
  anyone who wants it gone removes it with `secret-tool` or their keyring UI.
- **`localStorage["zinnia:cloud"]` survives** — the server address and the
  accepted fingerprint. Non-secret, ignored, and read again on revival.
- **`localStorage["zinnia:workspace"]` is untouched** and still live; that one
  is the local folder, not the server.

## To lift it back

1. `git mv` each path back to the column it came from in the table above —
   `limbo/cloud/src/api` → `src/api`, and so on. Every relative import inside
   resolves again the moment it lands.
2. Undo the bullet list under "what changed elsewhere". The Cargo entries are
   the ones to copy verbatim rather than re-resolve: `rustls-tls-manual-roots`
   on `reqwest` and the `ring` provider on `rustls` are what make the pinned
   verifier compile, and a fresh `cargo add` will not pick them.
3. `npm test` and `cargo check`. The parked suites assert the behaviour that
   matters — that the sign-in form is not offered for an unverified certificate,
   that the password field is cleared either way, that a 401 signs the session
   out, and that `normalizeServerUrl` still produces the same string.

Two things worth reconsidering rather than restoring:

* **The Cloud tab need not be a tab.** It was one because the vault pane needed
  somewhere to send people; a settings section would do, and would leave the tab
  bar to things that hold a file.
* **`openRemote` could take its `origin` back under a better name.** The
  argument was the vault identity plus the hash the buffer was read at; what it
  really means is "this buffer has somewhere to save itself that is not a path".
