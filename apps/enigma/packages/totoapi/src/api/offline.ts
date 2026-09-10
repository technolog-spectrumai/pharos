// Editing without a server, and reconciling when one comes back.
//
// WHY THIS EXISTS. Both editors read and wrote every file straight to the
// server, so a dropped connection did not degrade them — it stopped them. You
// could not open a file, could not save one, and an edit already on screen had
// nowhere to go. That is the wrong shape for a laptop: the network is the part
// that is missing, and typing is the part that is not.
//
// WHAT CHANGES AND WHAT DOES NOT. Editing goes offline; COMPILING DOES NOT.
// A compile runs in a Compute Capsule on the server and there is no local
// LaTeX or Python here to fall back to — pretending otherwise would mean
// shipping a toolchain in a desktop app whose whole point is that it does not.
// So the split is: text is local, work is remote.
//
// THE CACHE IS A COPY, NEVER THE ORIGINAL. The server's workspace stays the
// record. This module holds what was last read, what has been typed since, and
// enough to tell the two apart — nothing that only exists here. A cache that
// became the only copy of somebody's afternoon would be a worse failure than
// the one it fixes.
//
// PURE LOGIC OVER AN INJECTED STORE. Nothing here opens a file or knows what
// Tauri is; it takes a `CacheStore` and calls it. That is what lets the whole
// module be tested against a Map, and what lets the desktop side back it with
// `hoard` (the fjall store sketch already uses) without this file learning
// about either.
import type { FileContent, TreeItem, WorkspaceDetail } from "./workspaces";

/** Somewhere to put bytes, keyed by a string. Deliberately this small: it is
 *  what `hoard` already offers (`save` / `load` / `forget` / `boards`), so the
 *  desktop implementation is a shim rather than a port. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** One file as the cache holds it. */
export interface CachedFile {
  pk: number;
  name: string;
  /** What the server last confirmed. The baseline a conflict is measured
   *  against, and what an unsaved edit is diffed from. */
  saved: string;
  /** What the person has typed. Equal to `saved` when nothing is pending. */
  text: string;
  /** Was the server's copy shortened on the way in? A truncated file must
   *  never be pushed back — the tail past the ceiling would be destroyed. */
  truncated: boolean;
  readonly: boolean;
  /** When `saved` was taken, so a stale cache can say how stale. */
  fetchedAt: number;
  /** When the local edit happened, or 0. */
  editedAt: number;
}

/** A workspace as the cache holds it: what it is, its tree, and its files. */
export interface CachedWorkspace {
  slug: string;
  detail: WorkspaceDetail;
  items: TreeItem[];
  files: Record<string, CachedFile>;
  cachedAt: number;
}

/** The version this module writes. A cache written by an older build is
 *  DISCARDED rather than migrated: it holds only copies of server state, so
 *  throwing it away costs a re-fetch and nothing else — and a migration path
 *  for a throwaway cache is code that can be wrong for no benefit. */
export const CACHE_VERSION = 1;

const PREFIX = "ws:";

function key(slug: string): string {
  return `${PREFIX}${slug}`;
}

interface Envelope {
  version: number;
  workspace: CachedWorkspace;
}

/** Read one workspace from the cache, or null when it is absent, unreadable or
 *  of another version.
 *
 *  NEVER THROWS. A corrupt cache entry must degrade to "not cached" — the
 *  caller's next move is to fetch it, which is exactly right. Throwing here
 *  would turn a bad byte on disk into an app that will not open. */
export async function readWorkspace(
  store: CacheStore, slug: string,
): Promise<CachedWorkspace | null> {
  let raw: string | null;
  try {
    raw = await store.get(key(slug));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as Envelope;
    if (envelope.version !== CACHE_VERSION) return null;
    if (!envelope.workspace || typeof envelope.workspace.slug !== "string") {
      return null;
    }
    return envelope.workspace;
  } catch {
    return null;
  }
}

export async function writeWorkspace(
  store: CacheStore, workspace: CachedWorkspace,
): Promise<void> {
  const envelope: Envelope = { version: CACHE_VERSION, workspace };
  await store.set(key(workspace.slug), JSON.stringify(envelope));
}

/** Every workspace slug the cache holds, for the offline picker. */
export async function cachedSlugs(store: CacheStore): Promise<string[]> {
  const keys = await store.keys();
  return keys
    .filter((k) => k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length))
    .sort();
}

export async function forgetWorkspace(
  store: CacheStore, slug: string,
): Promise<void> {
  await store.remove(key(slug));
}

/** Fold a freshly-read file into the cache WITHOUT discarding a local edit.
 *
 *  This is the whole reason `saved` and `text` are separate fields. Re-reading
 *  a file the person has edited must update the baseline — so a later push can
 *  tell whether the server moved underneath them — while leaving what they
 *  typed exactly where it is. Overwriting `text` here would be the same bug the
 *  online editor already refuses in `openFile`, just arriving by another road.
 */
export function foldFile(
  cached: CachedFile | undefined, file: FileContent, now: number,
): CachedFile {
  const pending = cached && cached.text !== cached.saved;
  return {
    pk: file.pk,
    name: file.name,
    saved: file.content,
    text: pending ? cached.text : file.content,
    truncated: file.truncated,
    readonly: file.readonly,
    fetchedAt: now,
    editedAt: pending ? cached.editedAt : 0,
  };
}

/** Record a local edit. Returns the file unchanged when the text has not
 *  actually moved, so an editor emitting change events on focus does not stamp
 *  `editedAt` for nothing. */
export function recordEdit(
  file: CachedFile, text: string, now: number,
): CachedFile {
  if (file.text === text) return file;
  return { ...file, text, editedAt: now };
}

/** Files with something to push, oldest edit first.
 *
 *  Ordered so that a queue drained in sequence replays the afternoon in the
 *  order it happened, which is what somebody reading the resulting history
 *  expects. */
export function pending(workspace: CachedWorkspace): CachedFile[] {
  return Object.values(workspace.files)
    .filter((f) => f.text !== f.saved)
    .sort((a, b) => a.editedAt - b.editedAt);
}

/** Why this file cannot be pushed, or "" when it can.
 *
 *  A sentence rather than a boolean, matching `saveRefusal` in the editors: a
 *  silently skipped file in a sync queue is how somebody loses work and never
 *  finds out which file it was. */
export function pushRefusal(file: CachedFile): string {
  if (file.truncated) {
    return "This file was too large to load whole, so saving would cut off "
      + "everything past what you can see.";
  }
  if (file.readonly) {
    return "This file is produced by a run — edit the source instead.";
  }
  return "";
}

/** What happened to one file when the queue was drained. */
export interface PushOutcome {
  pk: number;
  name: string;
  status: "pushed" | "refused" | "conflict" | "failed";
  /** Why, for everything but `pushed`. */
  detail: string;
}

/** Whether the server's copy moved while we were away.
 *
 *  Compared against the BASELINE, not against the local text: the question is
 *  "did somebody else change this since I last read it", and the answer must
 *  not depend on whether I also changed it. */
export function isConflict(file: CachedFile, serverText: string): boolean {
  return file.saved !== serverText;
}

/** A one-line summary for the UI: what is waiting, and since when. */
export interface PendingSummary {
  files: number;
  oldestEditedAt: number;
}

export function summarise(workspace: CachedWorkspace | null): PendingSummary {
  if (!workspace) return { files: 0, oldestEditedAt: 0 };
  const waiting = pending(workspace);
  return {
    files: waiting.length,
    oldestEditedAt: waiting.length ? waiting[0].editedAt : 0,
  };
}
