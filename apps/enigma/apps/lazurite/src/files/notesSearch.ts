// The notes search, as the frontend calls it.
//
// One command, one shape. The Rust side (src-tauri/src/search.rs) walks the
// folder on every call and keeps nothing; this is the thin bridge to it. The
// field names are the Rust struct's, snake case included — tauri serialises
// them as written, and renaming here would be a second contract to keep.
//
// Off the desktop there is no Rust, so the answer is "nothing", not an error:
// the browser build has no folder to search in the first place.

export interface NoteHit {
  /** Absolute; what gets opened. */
  path: string;
  /** Relative to the notes root, forward slashes; what the list shows. */
  rel_path: string;
  name: string;
  /** The first matching body line, or "" when only the name/path matched. */
  snippet: string;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Search the notes under `root`. Sealed files match by name only — see the
 *  Rust header for why their bodies are never read. */
export async function searchNotes(root: string, query: string): Promise<NoteHit[]> {
  if (!isTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NoteHit[]>("notes_search", { root, query });
}
