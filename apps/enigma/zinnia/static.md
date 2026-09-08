# Zinnia as a static browser application

A plan for compiling zinnia to a pile of static files a web server can hand
out, and — if that is done — for how it would integrate with zenobia. This is a
design document, not a work order: it lays out the **major paths** first, then
the **details that need choosing** whichever path wins. Where a recommendation
exists it is marked, but every path is described well enough to be picked.

## Where the code already is

The distance to a browser build is shorter than it looks, because the app was
written with the seam in place:

* `./run_dev.sh --web` already serves the whole app in a browser with no Rust.
  Every Tauri call sits behind an `isTauri()` check made **per call**, and the
  fallbacks exist today: Open becomes a hidden `<input type="file">`, Save
  becomes a download (`EditorHost.saveAs`), and the header shows
  `file.browserNote`.
* `npm run build` produces a self-contained `dist/` (~15 MB) with no runtime
  network fetches — ACE modes and workers are bundled offline, KaTeX css
  included. `vite build` is already the first half of `build.sh`.
* The Rust surface is small and enumerable: the fs/dialog/opener plugins
  (browser fallbacks exist) and `lock.rs` — three commands over the `gervasius`
  crate. Only the lock has no browser equivalent today.
* The server half is **parked, not lost**: `limbo/cloud/` holds a typed client
  whose transport is injected (`createClient({fetchImpl})`). The desktop routed
  it through Rust; a browser build would hand it the real `fetch`. That is the
  seam it was built around.

What does NOT carry over from the desktop:

* **The token-out-of-JS design.** The parked cloud kept the session token in
  the OS keyring precisely because the webview renders untrusted `.svg` and
  deck HTML. The desktop now constrains that with a CSP, but a browser has no
  keyring and no Rust, so the token half of the protection has to come from
  somewhere else (see *Auth* and *Untrusted content* below).
* **The folder grant.** The sidepanel's "pick a folder, read only that" is a
  Tauri runtime scope. Browsers have a rough equivalent (File System Access
  API) in Chromium only.
* **File locking.** `lock_file`/`unlock_file` are Rust. Either compile
  `gervasius::gervazy` to WASM, do the sealing server-side, or leave sealing
  out of the browser build.

---

## The major design paths

Three ways to be "a static browser application", in increasing order of
coupling to the platform. They are not exclusive — A is a subset of B, and C
consumes the output of A or B — but each one is a coherent stopping point, and
choosing the stopping point is the real decision.

### Path A — the standalone static app

One `vite build`, hosted anywhere that can serve files (nginx, a CDN, GitHub
Pages, `python -m http.server`). No account, no server of its own, no zenobia.

* **Files.** Feature-detect the File System Access API
  (`window.showDirectoryPicker`): where it exists (Chromium), the sidepanel
  works as it does on the desktop — a picked directory handle is the root, kept
  in IndexedDB, re-permissioned on next visit. Where it does not (Firefox,
  Safari), the panel collapses to what the app already does in `--web` today:
  Open is a file input, Save is a download, and the tree is hidden rather than
  faked.
* **Identity/state.** `localStorage` only, exactly the keys that exist now
  (`zinnia:dark`, `zinnia:files`, palette). Nothing new.
* **Locking.** Out, or WASM (a detail below). Out is the honest default: a
  static page with no account has no strongbox to fetch a salt from anyway.
* **What it is for.** A zero-install trial of the editors, a kiosk, an offline
  HTML5 app. Also the necessary substrate for C.

**Cost:** small — a `vite.config` variant, the directory-handle adapter, and a
capability check where `isTauri()` is consulted. **Risk:** none to the desktop
build; the seam already exists.

### Path B — the static app with the platform as its file home

Path A plus the revival of `limbo/cloud/` against a browser transport: sign in
to a zenobia server, and the vault pane comes back beside the local one. The
static files can still be hosted anywhere; the server is configuration, not
build input.

* **Transport.** `createClient` gets the real `fetch` with
  `credentials: "include"` (cookie mode) or an `Authorization` header (token
  mode) — one small file replacing `limbo/cloud/src/api/transport.ts`. The
  error taxonomy, DTOs and `base_hash` conflict handling revive unchanged;
  their tests come back with them.
* **Auth is the hard part**, because the desktop's answer (keyring) is gone:
  * *Cookie/session* — zinnia is on an origin zenobia trusts, the browser holds
    the Django session cookie, JS never sees a credential. Needs same-origin
    hosting (→ Path C) or `CORS_ALLOW_CREDENTIALS` + exact origin allow-listing
    (zenobia already runs `corsheaders` with regexes for `tauri://` and
    localhost). CSRF token handling comes with it.
  * *Bearer token in JS* — works cross-origin (`POST /api/login/` already hands
    the session key back as a token), but parks the token where the desktop
    design refused to put it. Acceptable ONLY together with the untrusted-content
    isolation below, and should be `sessionStorage`, not `localStorage`.
  * **Recommendation:** cookie/session, which pushes B towards C.
* **TLS trust.** The desktop's pinned-certificate flow cannot exist in a
  browser — the browser owns TLS. `cloud_probe`/`PinnedVerifier` stay in limbo
  even if the rest revives; a self-signed server must be trusted at the browser
  level instead. Document it, don't emulate it.
* **What it is for.** The full office-suite-plus-vault experience with no
  install at all, on any machine with a browser.

**Cost:** the transport file, the auth decision, and reviving the parked pane
UIs. **Risk:** security posture — see *Untrusted content*. The desktop's policy
already exists; this path is where something other than Tauri has to serve it.

### Path C — zinnia as zenobia's editor surface

Path B, hosted **by zenobia itself**, same origin, and registered in the
platform's own plugin registry so the vault's Edit buttons open zinnia. This is
the deepest integration and the one the platform's architecture already has a
socket for.

* **Hosting.** `vite build --base=/static/zinnia/` → the bundle lands in a
  `zinnia_app` Django app's `static/` dir (or straight into `STATICFILES_DIRS`)
  and WhiteNoise serves it like everything else; one template view mounts
  `index.html` at `/zinnia/`. `collectstatic` ships it; no second web server, no
  CORS, no token in JS — the session cookie is already there.
* **The plugin socket.** zenobia's vault routes Edit buttons through
  `VaultEditorPlugin`, keyed by `file_type` — that is how the ACE editors in
  `toto-base` claim `text`/`json`/`xml`/…, how `toto.sketch` used to claim
  `svg` before it was parked, and how dracena re-claimed `python` for its
  workspace rooms. Zinnia registers one plugin per type it wants:
  `svg`, `document`, `pxml`/`presentation`, `sheet` — each returning
  `/zinnia/?file=<pk>`. The old browser sketch editor stays in limbo; zinnia
  **is** its replacement, which is what `delta`'s sketch LIMBO.md already says
  ("drawing moves to the zinnia desktop app") — this path extends that sentence
  to the browser.
* **Deep linking.** Zinnia has no router (deliberately — tabs hold buffers).
  `?file=<pk>` does not need one: on boot, read the query param, fetch the file
  through the revived vault client, and hand it to `openFromFiles` — the exact
  path a sidepanel click takes. Back/forward and shareable URLs can come later
  (a detail below), the plugin contract needs only the entry URL.
* **Division of labour with what zenobia already has.** The `toto-base` ACE
  editors keep the plain-text types; zinnia claims the structured ones it is
  the actual editor for. `EDITABLE_TYPES` in ambrosia's filetree already lists
  `pxml`/`presentation` as "text, editable" — those rows would start opening in
  zinnia instead of raw ACE. Server-side rules keep applying untouched: the
  editor save path runs `file_edits_allowed()`, the antivirus `scanning`
  façade, `base_hash` conflicts and the edit lock — zinnia talks to the same
  `/vault/api/` the desktop did, so it inherits all of it for free.
* **What it is for.** Zenobia gets a real drawing/document/deck/sheet editor in
  the browser again; zinnia gets an installation-free tier; both from one
  codebase and one `dist/`.

**Cost:** a small Django app (static mount + plugins + template), the Path B
transport in cookie mode, and the `?file=` bootstrap. **Risk:** the untrusted-
content problem is now *inside the platform's origin* and must be solved, not
weighed (next section).

---

## Untrusted content — the one problem every path shares

Zinnia renders deck blocks with `v-html` (`SlideBlock.vue`, behind `trust-html`)
and opens arbitrary `.svg`. On the desktop this is contained by the app's
process boundary and mitigated by the token-in-keyring design. In a browser:

* On **Path A** the blast radius is zinnia's own origin, which holds nothing —
  a tolerable posture, and the desktop's policy is the one to port.
* On **Path B (token mode)** a hostile deck could exfiltrate the token. That is
  why token mode is conditional.
* On **Path C** a hostile deck runs **same-origin with zenobia**, i.e. with the
  session cookie's ambient authority. Not shippable as-is.

Choose one (they compose, strongest first):

1. **Sandboxed iframe rendering** — `trust-html` and deck play render inside
   `<iframe sandbox="allow-scripts" srcdoc=…>` on a null origin, messages over
   `postMessage`. The right fix for C; also the only one that lets `html`
   blocks keep genuinely running.
2. **Sanitise-or-refuse for HTML blocks in browser builds** — the sketch editor
   already REFUSES active SVG rather than stripping (`svgDocument.ts`); extend
   the same stance to deck `html` blocks when not desktop: show the source,
   don't execute it. Cheapest, loses a feature the desktop keeps.
3. **CSP on the document** — **done on the desktop** (`app.security.csp` in
   `tauri.conf.json`): `script-src 'self'`, no `'unsafe-inline'`, no
   `'unsafe-eval'`, and `img-src` without a remote origin so an injected node
   cannot phone home. It kills the classic injected-`<script>`/`onerror=`
   vectors even inside `v-html`. Necessary on every path, sufficient on none:
   `style-src` still needs `'unsafe-inline'` (Vue's `:style`, KaTeX, Univer all
   write style attributes), and exfiltration from injected DOM is not
   script-tag-shaped. A browser build must re-declare the same policy as a
   response header or a `<meta>` — the Tauri config does not travel with `dist/`.

**Recommendation:** 3 always; 2 for A/B; 1 before C ships deck editing.

---

## Details to choose (whichever path)

Each of these is independent of the path choice unless marked.

| # | Detail | Options | Note |
|---|---|---|---|
| 1 | **Build variant mechanism** | (a) one build, runtime `isTauri()` checks — what exists; (b) `vite build --mode browser` + `import.meta.env` for dead-code elimination | (a) until bundle size hurts; the checks are already written. |
| 2 | **Capability object vs scattered checks** | keep per-call `isTauri()`; or one `capabilities.ts` (`{localTree, nativeDialogs, locking}`) consulted everywhere | The FS-Access-API branch makes a third "kind of true" — a capability object stops the checks from becoming a matrix. Do this when the FS adapter lands. |
| 3 | **Local files in browser** | (a) FS Access API + IndexedDB-persisted handle, fallback to input/download; (b) input/download only; (c) OPFS as a private workspace | (a) is the sidepanel's browser story; (c) gives even Firefox a persistent tree but the files live inside the browser, which surprises people — decide deliberately. |
| 4 | **Locking in browser** | (a) absent (greyed with a why); (b) `gervazy` → WASM via `wasm-pack`, salt still from strongbox; (c) server-side encrypt only (vault files only) | (b) keeps the byte-compatible promise; note Argon2id in WASM is single-threaded and slow — measure before promising. (a) for A; (c) falls out of B/C for vault rows anyway. |
| 5 | **Auth (B/C)** | cookie/session vs Bearer-in-JS | Cookie. See Path B. |
| 6 | **Untrusted content** | §above: iframe / refuse / CSP | CSP is shipped on the desktop and must be re-served for a browser build; iframe before C. |
| 7 | **Vite `base`** | `/` (A, B); `/static/zinnia/` (C); or `./` relative for host-anywhere | Relative `./` keeps one artefact valid for all three — check the ACE worker URLs tolerate it. |
| 8 | **Chunking** | status quo (one 1.6 MB index + 5 MB Univer locale chunks); or route-level `import()` so Sheets costs nothing until opened | The app already lazy-MOUNTS tabs; lazy-LOADING them is the browser-grade version of the same decision. Worth it before any public hosting. |
| 9 | **PWA/offline** | none; or manifest + service worker precache | Natural for A ("installable office suite"), noise for C (zenobia is online by definition). |
| 10 | **Deep links (C)** | `?file=<pk>` bootstrap only; or adopt the dormant `path` fields in `APP_TABS` and add a real router | Bootstrap only, first. The tabs.ts header already documents why routing and live buffers conflict. |
| 11 | **Where the Django side lives (C)** | a `zinnia_app` in zenobia's repo; or served from `STATICFILES_DIRS` + a bare `TemplateView` | The app form gives the plugins a `ready()` to register in and a place for the `?file=` template — matches how every other surface plugs in. |
| 12 | **Which file types zinnia claims (C)** | all four structured types at once; or `svg` first (the vacant slot), then decks, then the rest | `svg` first: the slot is empty (sketch is parked), the win is immediate, and the blast radius of a rollback is one plugin key. |
| 13 | **Dev workflow** | keep 1430/`--web` and point the client at a dev zenobia via CORS; or vite `server.proxy` to zenobia so cookies are same-origin in dev | Proxy, once B/C exists — it rehearses the production origin story instead of a different one. |

## Suggested order

1. **A**, with details 1a/2/3a/4a/7-relative — ship the standalone build,
   because everything later stands on it and it is nearly free.
2. **Port the desktop CSP and take the refuse-HTML stance** (6) — while the app
   is still origin-alone. The policy already exists; what a static build lacks
   is a way to serve it.
3. **C's hosting skeleton** (11) — zenobia serves the same artefact; still no
   account integration, but the deployment path is proven.
4. **B in cookie mode** (5) — revive `limbo/cloud/` minus `transport.ts`,
   minus the pinning; the vault pane returns.
5. **C's plugins** (12), `svg` first — the vault's Edit button opens zinnia.
6. Then the optional weight: iframe sandboxing for decks (6.1), chunk splitting
   (8), WASM locking (4b), PWA (9).

Each step leaves the desktop build untouched — same sources, same tests, the
Tauri path just keeps being the `isTauri() === true` branch.
