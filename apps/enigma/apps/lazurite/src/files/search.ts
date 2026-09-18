// The workspace search, as the frontend calls it.
//
// One command, one shape. The Rust side (src-tauri/src/search.rs) walks the
// workspace on every call and keeps nothing; this is the thin bridge to it.
// Field names are the Rust struct's — renaming here would be a second
// contract to keep. Off the desktop there is no Rust and no workspace, so the
// answer is "nothing", not an error.
import type { SearchMode } from "./searchSettings";
import { invoke, isTauri } from "../ipc";

export interface SearchHit {
  /** Absolute; what gets opened. */
  path: string;
  /** Relative to the workspace root, forward slashes; what the list shows. */
  relPath: string;
  name: string;
  tags: string[];
  /** Which of name, tag, path, text matched. */
  matched: Array<"name" | "tag" | "path" | "text">;
  /** The first matching body line, or "" when the body was not searched. */
  snippet: string;
  score: number;
  sealed: boolean;
}

/** Search the workspace. An encrypted file is matched by name, path and
 *  tags only — see the Rust header for why its body is never read. */
export async function searchWorkspace(query: string, mode: SearchMode): Promise<SearchHit[]> {
  if (!isTauri()) return [];
  return invoke<SearchHit[]>("workspace_search", { query, mode });
}
