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
import { computed, ref } from "vue";
import { baseName } from "./format";

export interface Entry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: number;
}

const STORAGE_KEY = "zinnia:workspace";

const root = ref<string>(loadRoot());
/** Where we are inside the root; "" means the root itself. */
const relative = ref<string>("");
const entries = ref<Entry[]>([]);
const loading = ref(false);
const error = ref("");

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
    /* a full or blocked store must not break the tab */
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

export function useWorkspace() {
  const currentPath = computed(() => (relative.value ? join(root.value, relative.value) : root.value));
  const crumbs = computed(() => {
    const names = relative.value ? relative.value.split("/").filter(Boolean) : [];
    let walked = "";
    return [
      { name: baseName(root.value) || root.value, rel: "" },
      ...names.map((name) => {
        walked = join(walked, name);
        return { name, rel: walked };
      }),
    ];
  });

  async function pickRoot(): Promise<void> {
    if (!isTauri()) {
      error.value = "files.desktopOnly";
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    // `recursive: true` is what extends the grant to subfolders — without it
    // the picked folder would open and every folder inside it would refuse.
    const picked = await open({ directory: true, multiple: false, recursive: true });
    if (typeof picked !== "string") return;
    root.value = picked;
    relative.value = "";
    saveRoot(picked);
    await refresh();
  }

  async function refresh(): Promise<void> {
    if (!root.value || !isTauri()) return;
    loading.value = true;
    error.value = "";
    try {
      const { readDir, stat } = await import("@tauri-apps/plugin-fs");
      const here = currentPath.value;
      const raw = await readDir(here);
      // DirEntry carries a name and nothing else — no size, no date — so each
      // row needs its own stat. Failures per entry are tolerated: one
      // unreadable file should not blank the whole listing.
      const rows = await Promise.all(
        raw.map(async (entry): Promise<Entry> => {
          const path = join(here, entry.name);
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
      entries.value = rows.sort((a, b) =>
        a.isDirectory === b.isDirectory
          ? a.name.localeCompare(b.name)
          : a.isDirectory ? -1 : 1,
      );
    } catch (err) {
      error.value = (err as Error)?.message ?? String(err);
      entries.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function enter(entry: Entry): Promise<void> {
    if (!entry.isDirectory) return;
    relative.value = join(relative.value, entry.name);
    await refresh();
  }

  async function goTo(rel: string): Promise<void> {
    relative.value = rel;
    await refresh();
  }

  /** Whether a file on disk is a Fernet token — same detection the platform
   *  uses, so a file encrypted on either side is badged on both. */
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
    root, relative, entries, loading, error, currentPath, crumbs,
    pickRoot, refresh, enter, goTo, readText, isLocked,
  };
}
