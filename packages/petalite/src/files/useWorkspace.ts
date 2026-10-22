// A folder on this machine, browsed inside the app.
//
// One root, chosen through the folder picker and remembered. HOW the folder is
// read is injected (`setFileBackend`), the way the sealed-file probe is: this
// store is generic browsing, and the rule about where an app may read is that
// app's. Without a backend the fs plugin is used directly, and the dialog
// plugin's runtime grant is what makes that legal — a grant that lives in the
// running process, so after a restart the first read fails until the folder
// is picked again, and the panel offers the picker. An app that installs a
// backend with `open` (Morion: a Rust workspace with its own boundary) has
// no such gap: the remembered folder is reopened on the first refresh.
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
import { toDataUri } from "petalite/files";

export interface Entry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: number;
  /** Known at listing time when the backend reads the first bytes itself;
   *  absent, the probe is asked. */
  sealed?: boolean;
}

/** How the store reaches the disk. Every method takes a path the store got
 *  from a listing (or the root). `open` is called with the root before the
 *  first read of it and answers the root's canonical spelling; a backend
 *  without one reads wherever it is pointed. */
export interface FileBackend {
  open?(root: string): Promise<string>;
  list(dir: string): Promise<Entry[]>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
}

let backend: FileBackend | null = null;

/** Give the store its backend. Call before the first read — `main.ts`. */
export function setFileBackend(next: FileBackend | null): void {
  backend = next;
  openedRoot = "";
}

/** The fs-plugin backend, used when an app installs none. */
const pluginBackend: FileBackend = {
  async list(dir) {
    const { readDir, stat } = await import("@tauri-apps/plugin-fs");
    const raw = await readDir(dir);
    // DirEntry carries a name and nothing else — no size, no date — so each row
    // needs its own stat. Failures per entry are tolerated: one unreadable file
    // should not blank the whole listing.
    return Promise.all(
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
  },
  async readText(path) {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return readTextFile(path);
  },
  async readBytes(path) {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    return readFile(path);
  },
};

function fs(): FileBackend {
  return backend ?? pluginBackend;
}

/** The root the backend has been told to open, so it is told once per root. */
let openedRoot = "";

/** An entry placed in the tree: same fields, plus how deep it sits. */
export interface Row extends Entry {
  depth: number;
}

const STORAGE_KEY = "zinnia:workspace";
/** The folders opened before this one, most recent first. Paths only. */
const RECENT_KEY = "zinnia:workspaces:recent";
const RECENT_MAX = 6;

const root = ref<string>(loadRoot());
const recent = ref<string[]>(loadRecent());
/** Directory path -> its listing. The root's own listing is filed under the
 *  root path, so the walk below needs no special case for depth 0. */
const children = ref<Map<string, Entry[]>>(new Map());
/** Which folders are open. Paths, not indices: a refresh replaces every row
 *  object, and an index would then point at a different folder. */
const expanded = ref<Set<string>>(new Set());
const loading = ref(false);
const error = ref("");
/** Which files are sealed, by path.
 *
 *  Keyed by PATH rather than carried on the row, because every `read()`
 *  replaces the row objects wholesale — a field would be re-derived, and
 *  re-probed, on every refresh for rows that did not change. Paths outlive the
 *  rows, which is the same reason `expanded` is a Set of them.
 *
 *  Never cleared by `refresh()`. Probes are fire-and-forget, so one issued
 *  before a clear could land after it and resurrect a path; entries are only
 *  ever overwritten. A stale entry for a deleted file is harmless — nothing
 *  renders a row for a path that has no row — and growth is bounded by the
 *  files in expanded folders, exactly as `children` is. */
const sealed = ref<Map<string, boolean>>(new Map());

/** Asks whether one path is sealed. Injected rather than imported, because
 *  browsing a folder and encrypting a file are separate concerns that only meet
 *  at the padlock: this store is generic file browsing, and sealing is one
 *  app's feature bolted onto it.
 *
 *  Absent — the default — `probeAll` does nothing and `isSealed` is always
 *  false. That is not a degraded mode: it is exactly today's behaviour off the
 *  desktop, where `probeSealed` already answers false because there is no Rust
 *  to ask. An app that does not offer sealing simply never sets one. */
export type SealProbe = (path: string) => Promise<boolean>;

let probe: SealProbe | null = null;

/** Give the store its probe. Call BEFORE the first `read()` — a folder read
 *  fires the probes for its rows, and one installed afterwards would leave that
 *  first folder unbadged until a refresh. `main.ts` is the place. */
export function setSealProbe(next: SealProbe | null): void {
  probe = next;
}
/** The ROOT itself could not be read. Kept apart from `error`, which any
 *  sub-folder read can also set: this one means the whole tree is unavailable,
 *  and the panel answers it with the picker rather than an empty listing.
 *
 *  With the fs-plugin backend the ordinary cause is not a broken folder: the
 *  read grant lives in the running process, so after a restart the remembered
 *  path is no longer readable until it is picked again. With a backend that
 *  opens the root itself it means the folder is gone or was refused. */
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

function loadRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Put `value` at the front of the recent list, once. */
function remember(value: string) {
  const next = [value, ...recent.value.filter((p) => p !== value)].slice(0, RECENT_MAX);
  recent.value = next;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
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
    // `recursive: true` is what extends the plugin grant to subfolders — the
    // fs-plugin backend needs it; a Rust backend ignores the grant entirely.
    const picked = await open({ directory: true, multiple: false, recursive: true });
    // Cancelled. Clear any complaint left over from the folder they came to
    // change — it is about to be re-tested, or it is no longer the subject.
    if (typeof picked !== "string") {
      error.value = "";
      return;
    }
    await switchRoot(picked);
  }

  /** Make `path` the workspace: a folder picked just now, or one from the
   *  recent list. The backend's `open` settles its canonical spelling and can
   *  refuse it (gone, not a folder); a refusal leaves the current workspace
   *  as it was and reports through `error`. */
  async function switchRoot(path: string): Promise<boolean> {
    let canonical = path;
    const fsb = fs();
    if (fsb.open) {
      try {
        canonical = await fsb.open(path);
        openedRoot = canonical;
      } catch (err) {
        error.value = (err as Error)?.message ?? String(err);
        return false;
      }
    }
    root.value = canonical;
    children.value = new Map();
    expanded.value = new Set();
    sealed.value = new Map();
    saveRoot(canonical);
    remember(canonical);
    await refresh();
    return true;
  }

  /** Read one folder into the cache. Throws; every caller decides what a
   *  failure means for the row it was opening. */
  async function read(dir: string): Promise<void> {
    const rowsHere = await fs().list(dir);
    // Folders first, then files, each alphabetical — what every file manager
    // does, and what makes a long listing scannable.
    rowsHere.sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name)
        : a.isDirectory ? -1 : 1,
    );
    // A new Map, not a mutation: a Map written in place is not reactive.
    children.value = new Map(children.value).set(dir, rowsHere);
    // A SECOND pass, deliberately not awaited into the listing: the names are
    // what the panel draws, and making a folder wait on one round trip per file
    // to show a padlock nobody is looking at yet trades the tree for the badge.
    void probeAll(rowsHere);
  }

  /** Ask Rust which of these files are sealed, and record the answers.
   *
   *  Called from `read()` and nowhere else, because `read()` is the ONLY thing
   *  that adds rows — both `refresh()` and `toggle()` route through it, so
   *  filling the map anywhere else would leave a hole. */
  async function probeAll(entries: Entry[]): Promise<void> {
    // A listing that already read the first bytes answers for its own rows;
    // only the rest are asked.
    const known = entries.filter((e) => !e.isDirectory && e.sealed !== undefined);
    if (known.length) {
      const next = new Map(sealed.value);
      for (const entry of known) next.set(entry.path, entry.sealed === true);
      sealed.value = next;
    }
    if (!probe) return;
    const ask = probe;
    const files = entries.filter((e) => !e.isDirectory && e.sealed === undefined);
    if (!files.length) return;
    const answers = await Promise.all(
      files.map(async (entry) => {
        // `is_file_locked` already answers false for anything it cannot open,
        // so this catch is all but unreachable — it is here so a fire-and-forget
        // probe can never reject unobserved.
        try {
          return [entry.path, await ask(entry.path)] as const;
        } catch {
          return [entry.path, false] as const;
        }
      }),
    );
    // ONE reassignment for the whole folder; N would be N re-renders.
    const next = new Map(sealed.value);
    for (const [path, yes] of answers) next.set(path, yes);
    sealed.value = next;
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
      // A backend with `open` is told the root once per root — on the first
      // refresh after launch, which is how the remembered workspace comes
      // back without a dialog. It may answer a canonical spelling.
      const fsb = fs();
      if (fsb.open && openedRoot !== root.value) {
        const canonical = await fsb.open(root.value);
        openedRoot = canonical;
        if (canonical !== root.value) {
          root.value = canonical;
          saveRoot(canonical);
        }
      }
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
   *  With the fs-plugin backend it does NOT withdraw the read grant — that
   *  lives in the running process and there is no API to hand it back — so it
   *  means "stop showing me this folder", not "stop being able to read it". */
  function clearRoot(): void {
    root.value = "";
    openedRoot = "";
    children.value = new Map();
    expanded.value = new Set();
    // A different workspace shares no paths with this one.
    sealed.value = new Map();
    error.value = "";
    unreadable.value = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* a blocked store must not break the panel */
    }
  }

  /** Whether a file is sealed, from the cache. Synchronous on purpose: a
   *  template calls this per row, and reading `sealed.value` here is what makes
   *  the row re-render when a probe lands. */
  function isSealed(path: string): boolean {
    return sealed.value.get(path) === true;
  }

  /** Re-probe ONE path — what the Security tab calls after sealing a file. A
   *  full refresh would re-stat every open folder to correct one boolean. */
  async function reprobe(path: string): Promise<void> {
    if (!probe) return;
    const yes = await probe(path);
    sealed.value = new Map(sealed.value).set(path, yes);
  }

  async function readText(entry: Entry): Promise<string> {
    return fs().readText(entry.path);
  }

  /** A picture as a `data:` URI, ready for an <img>.
   *
   *  Read as BYTES, never as text: `readTextFile` decodes UTF-8, and a PNG put
   *  through that comes back as replacement characters — a lossy copy of the
   *  file that could then be saved over the real one. */
  async function readImage(entry: Entry): Promise<string> {
    return toDataUri(entry.name, await fs().readBytes(entry.path));
  }

  return {
    root, recent, rows, loading, error, expanded, unreadable, sealed,
    isExpanded, isSealed, reprobe, pickRoot, switchRoot, clearRoot, refresh, toggle, readText,
    readImage,
  };
}
