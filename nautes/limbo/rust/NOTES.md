# `fs_local.rs` — parked 2026-07-27

Two Tauri commands that wrote a user-chosen file to disk:

- `fs_write_text_file(path, contents)` — UTF-8 text.
- `fs_write_base64_file(path, b64)` — binary supplied as base64, because the
  callers held canvas data URLs, which already carry their payload that way.

Both existed for the **export** paths of the Sketch board (SVG + PNG) and the
Mind map (JSON). When those two features were parked there was no caller left, so
the Rust went with them — this is the only Rust the parked Notes features ever
had; everything else about them was pure frontend over sealed kv.

Deliberately plain: unlike `local_lock.rs`'s `writeLocalNote`, these carry no
locked-file or notes-recents semantics. The path always came from the native save
dialog (`@tauri-apps/plugin-dialog`), i.e. the user picked it — the commands do
not sanitize or scope it, which is exactly why nothing else should call them
without thinking about that first.

## As parked

| File | Was |
|---|---|
| `fs_local.rs` | `apps/enigma/src-tauri/src/fs_local.rs` (incl. its 3 unit tests) |
| `fs_local_wrappers.ts.snippet` | `writeTextFileToDisk` / `writeBase64FileToDisk` in `packages/rakotis/src/services/appStorage.ts` |

## Restore checklist

1. Move `fs_local.rs` back to `apps/enigma/src-tauri/src/`.
2. `apps/enigma/src-tauri/src/lib.rs`: re-add `mod fs_local;` (it sat between
   `mod tor;` and `mod local_lock;`) and the two `invoke_handler` entries:
   ```rust
   fs_local::fs_write_text_file,
   fs_local::fs_write_base64_file,
   ```
3. Paste `fs_local_wrappers.ts.snippet` back into
   `packages/rakotis/src/services/appStorage.ts` (it sat just before the
   "Local-file key-rotation reminder interval" section). They are exported
   through the package barrel automatically (`export *`).
4. `cargo test` in `apps/enigma/src-tauri` — the file brings its own three tests
   (base64 round-trip, malformed-base64 rejection, text write).

## Alternative worth considering first

Tauri 2 ships `@tauri-apps/plugin-fs`, which covers both of these with a scoped,
permission-declared API. If you are restoring Sketch or Mind for real rather than
archaeologically, prefer wiring their export paths to that plugin and leaving
this file parked — it exists because the plugin was not in the dependency set at
the time, not because a custom command was better.
