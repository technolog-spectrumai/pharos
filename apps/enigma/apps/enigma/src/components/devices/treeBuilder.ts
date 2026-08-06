// Pure helper: turn a flat set of files-with-relative-dirs into the DFS-ordered
// row list FileTree.vue renders. Directory rows are DERIVED from file paths —
// empty directories are a local-disk affair and never enter the shared list, so
// they only appear in the "this device" bucket via the scan, not here.
import type { TreeItem } from "./FileTree.vue";

export interface TreeFile {
  id: string;
  /** POSIX relative dir inside the enigma folder; "" = root. */
  dir: string;
  name: string;
  size?: number;
  marker?: TreeItem["marker"];
  locked?: boolean;
  selectable?: boolean;
}

/** Extra directories to materialize even if no file references them (scan). */
export function buildTree(files: TreeFile[], extraDirs: string[] = []): TreeItem[] {
  interface DirNode {
    id: string;
    name: string;
    parent: string | null; // dir path of the parent ("" root has parent null)
    children: Map<string, DirNode>;
    files: TreeFile[];
  }

  const root: DirNode = { id: "", name: "", parent: null, children: new Map(), files: [] };
  const nodes = new Map<string, DirNode>([["", root]]);

  function ensureDir(path: string): DirNode {
    const existing = nodes.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : path.slice(0, slash);
    const parent = ensureDir(parentPath);
    const node: DirNode = {
      id: `d:${path}`,
      name: slash === -1 ? path : path.slice(slash + 1),
      parent: parentPath,
      children: new Map(),
      files: [],
    };
    nodes.set(path, node);
    parent.children.set(node.name, node);
    return node;
  }

  for (const dir of extraDirs) if (dir) ensureDir(dir);
  for (const file of files) ensureDir(file.dir || "").files.push(file);

  const rows: TreeItem[] = [];
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });

  function emit(node: DirNode, depth: number, pid: string | null) {
    // toto ordering: subdirs first, then files, both by name.
    const dirs = [...node.children.values()].sort((a, b) => collator.compare(a.name, b.name));
    const files = [...node.files].sort((a, b) => collator.compare(a.name, b.name));
    for (const child of dirs) {
      rows.push({
        id: child.id,
        pid,
        depth,
        kind: "dir",
        name: child.name,
        nDirs: child.children.size,
        nFiles: child.files.length,
      });
      emit(child, depth + 1, child.id);
    }
    for (const file of files) {
      rows.push({
        id: file.id,
        pid,
        depth,
        kind: "file",
        name: file.name,
        size: file.size,
        marker: file.marker,
        locked: file.locked,
        selectable: file.selectable,
      });
    }
  }

  emit(root, 0, null);
  return rows;
}
