// A folder on this machine, browsed inside the app.
//
// One root, chosen through the folder picker and remembered. That choice is
// what makes this legal without weakening the app's permissions: the dialog
// plugin widens the fs runtime scope to exactly the directory the user picked
// (`allow_directory(path, recursive)`), and the fs plugin accepts a path if
// EITHER the runtime scope or the static one allows it. So the app can read
// inside that folder and nowhere else, and no static filesystem scope has to be
// granted at build time.
//
// A consequence worth knowing: the grant lives in the running process. After a
// restart the remembered path is still shown, but the first read will fail
// until the user picks it again — so a failure here offers the picker rather
// than reporting a broken folder.
//
// ── the tree ────────────────────────────────────────────────────────────────
// This was one-directory-at-a-time — a listing plus breadcrumbs — which is what
// a full-width Files tab wanted. The sidepanel wants the opposite: a tree, so
// you can see where a file sits without walking away from where you are.
//
// Rows are FLAT and depth-tagged rather than nested, so the template never
// recurses: indentation is a padding calculation. That is the shape enigma's
// file tree and the platform's own explorer both settled on, and it keeps
// arbitrarily deep folders from becoming arbitrarily deep components.
//
// Children are loaded PER FOLDER, when it is first expanded, and cached until a
// refresh. A recursive walk of the root would be the simpler code and the wrong
// behaviour: the picked folder can be a home directory, and reading all of it
// to draw a panel that shows twelve rows is a stall with nothing to show for it.
import { computed, ref } from "vue";

export interface Entry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: number;
}

/** An entry placed in the tree: same fields, plus how deep it sits. */
export interface Row extends Entry {
  depth: number;
}

const STORAGE_KEY = "zinnia:workspace";

const root = ref<string>(loadRoot());
/** Directory path -> its listing. The root's own listing is filed under the
 *  root path, so the walk below needs no special case for depth 0. */
const children = ref<Map<string, Entry[]>>(new Map());
/** Which folders are open. Paths, not indices: a refresh replaces every row
 *  object, and an index would then point at a different folder. */
const expanded = ref<Set<string>>(new Set());
const loading = ref(false);
const error = ref("");
/** The ROOT itself could not be read. Kept apart from `error`, which any
 *  sub-folder read can also set: this one means the whole tree is unavailable,
 *  and the panel answers it with the picker rather than an empty listing.
 *
 *  The ordinary cause is not a broken folder. The read grant lives in the
 *  running process, so after a restart the remembered path is still known and
 *  no longer readable until it is picked again. */
const unreadable = ref(false);

function loadRoot(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { root?: unknown };
    return typeof parsed.root === "string" ? parsed.root : "";
  } catch {
    return "";
  }
}

function saveRoot(value: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ root: value }));
  } catch {
    /* a full or blocked store must not break the panel */
  }
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Join without a path library: Tauri hands back native separators, and the
 *  only thing being appended is a single directory entry name. */
function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

/**
 * The rows a filter leaves, with the folders that lead to them.
 *
 * Pure, so it can be tested without a filesystem. An ancestor is kept even when
 * its own name does not match: dropping it would leave the match indented under
 * nothing, which reads as a file at the root of a folder it is not in.
 *
 * It filters what has been LOADED — the rows you can see — not the whole disk.
 * A folder nobody opened has never been read, and reading every folder to
 * answer a keystroke is exactly what the lazy load above exists to avoid.
 */
export function filterRows(rows: Row[], needle: string): Row[] {
  const wanted = needle.trim().toLowerCase();
  if (!wanted) return rows;

  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.name.toLowerCase().includes(wanted)) keep[i] = true;
    // Walking backwards means every descendant has already been decided: a
    // folder is kept if anything still deeper than it was kept.
    if (row.isDirectory && !keep[i]) {
      for (let j = i + 1; j < rows.length && rows[j].depth > row.depth; j++) {
        if (keep[j]) { keep[i] = true; break; }
      }
    }
  }
  return rows.filter((_, i) => keep[i]);
}

export function useWorkspace() {
  /**
   * The tree, depth-first, as flat rows.
   *
   * The `seen` set is not paranoia: a symlink pointing at one of its own
   * ancestors is an ordinary thing to find in a home directory, and without it
   * expanding one would walk until the stack gave out. A cycle should render
   * short, not hang.
   */
  const rows = computed<Row[]>(() => {
    if (!root.value) return [];
    const out: Row[] = [];
    const seen = new Set<string>();
    const walk = (dir: string, depth: number) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      for (const entry of children.value.get(dir) ?? []) {
        out.push({ ...entry, depth });
        if (entry.isDirectory && expanded.value.has(entry.path)) {
          walk(entry.path, depth + 1);
        }
      }
    };
    walk(root.value, 0);
    return out;
  });

  const isExpanded = (path: string) => expanded.value.has(path);

  async function pickRoot(): Promise<void> {
    if (!isTauri()) {
      error.value = "files.desktopOnly";
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    // `recursive: true` is what extends the grant to subfolders — without it
    // the picked folder would open and every folder inside it would refuse.
    const picked = await open({ directory: true, multiple: false, recursive: true });
    // Cancelled. Clear any complaint left over from the folder they came to
    // change — it is about to be re-tested, or it is no longer the subject.
    if (typeof picked !== "string") {
      error.value = "";
      return;
    }
    root.value = picked;
    children.value = new Map();
    expanded.value = new Set();
    saveRoot(picked);
    await refresh();
  }

  /** Read one folder into the cache. Throws; every caller decides what a
   *  failure means for the row it was opening. */
  async function read(dir: string): Promise<void> {
    const { readDir, stat } = await import("@tauri-apps/plugin-fs");
    const raw = await readDir(dir);
    // DirEntry carries a name and nothing else — no size, no date — so each row
    // needs its own stat. Failures per entry are tolerated: one unreadable file
    // should not blank the whole listing.
    const rowsHere = await Promise.all(
      raw.map(async (entry): Promise<Entry> => {
        const path = join(dir, entry.name);
        let size: number | undefined;
        let modified: number | undefined;
        try {
          const info = await stat(path);
          size = info.size;
          modified = info.mtime ? new Date(info.mtime).getTime() : undefined;
        } catch {
          /* keep the row; it just has no size or date */
        }
        return { name: entry.name, path, isDirectory: entry.isDirectory, size, modified };
      }),
    );
    // Folders first, then files, each alphabetical — what every file manager
    // does, and what makes a long listing scannable.
    rowsHere.sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name)
        : a.isDirectory ? -1 : 1,
    );
    // A new Map, not a mutation: a Map written in place is not reactive.
    children.value = new Map(children.value).set(dir, rowsHere);
  }

  /** Re-read the root and every folder currently open.
   *
   *  Shallowest first, so a folder whose parent has vanished is simply not
   *  walked into again — the row it hung under is already gone. */
  async function refresh(): Promise<void> {
    if (!root.value || !isTauri()) return;
    loading.value = true;
    error.value = "";
    children.value = new Map();
    try {
      await read(root.value);
      unreadable.value = false;
      const open = [...expanded.value].sort((a, b) => a.length - b.length);
      for (const dir of open) {
        try {
          await read(dir);
        } catch {
          // Gone, renamed, or no longer permitted. Forget it rather than
          // reporting it: the folder it lived in has already been re-read, so
          // the tree is consistent without it.
          expanded.value = new Set([...expanded.value].filter((p) => p !== dir));
        }
      }
    } catch (err) {
      // The root is gone, or was never granted. Say so as a STATE rather than
      // as a message over a stale listing: the tree that was on screen belongs
      // to a folder this run can no longer read, and showing it would invite
      // clicking a row that cannot be opened.
      error.value = (err as Error)?.message ?? String(err);
      unreadable.value = true;
      expanded.value = new Set();
    } finally {
      loading.value = false;
    }
  }

  /** Open a folder, reading it the first time; close it if it is already open.
   *
   *  A collapse keeps the cached listing. Reopening is then instant, and the
   *  refresh button is what says "read this again" — so a click that only
   *  changes what is on screen never waits on a disk. */
  async function toggle(dir: string): Promise<void> {
    const next = new Set(expanded.value);
    if (next.delete(dir)) {
      expanded.value = next;
      return;
    }
    next.add(dir);
    expanded.value = next;
    if (children.value.has(dir)) return;
    error.value = "";
    try {
      await read(dir);
    } catch (err) {
      error.value = (err as Error)?.message ?? String(err);
      expanded.value = new Set([...expanded.value].filter((p) => p !== dir));
    }
  }

  /** Forget the folder entirely, so the app is back to having none.
   *
   *  It does NOT withdraw the read grant — that lives in the running process
   *  and there is no API to hand it back — so this is "stop showing me this
   *  folder", not "stop being able to read it". Restarting is what actually
   *  drops the grant. Said plainly here because the difference matters. */
  function clearRoot(): void {
    root.value = "";
    children.value = new Map();
    expanded.value = new Set();
    error.value = "";
    unreadable.value = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* a blocked store must not break the panel */
    }
  }

  /** Whether a file on disk is sealed — the same detection the platform uses,
   *  so a file encrypted on either side is badged on both. */
  async function isLocked(entry: Entry): Promise<boolean> {
    if (entry.isDirectory || !isTauri()) return false;
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("is_file_locked", { path: entry.path });
  }

  async function readText(entry: Entry): Promise<string> {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return readTextFile(entry.path);
  }

  return {
    root, rows, loading, error, expanded, unreadable,
    isExpanded, pickRoot, clearRoot, refresh, toggle, readText, isLocked,
  };
}
