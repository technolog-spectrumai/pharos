// The server's tree rows, as Petalite's FileTree wants them.
//
// AN ADAPTER, and it earns its own module because the two shapes disagree on
// the field that matters. The server sends `{t, id, pid, depth, name, …}` —
// flat, addressed by integer id, with no path anywhere. `FileTree` wants
// `{name, path, isDirectory, depth}` and keys everything on `path`: expansion,
// the active row, the `data-testid`.
//
// So the path is BUILT here, by walking `pid` upward. That is the only part of
// this file with anything to get wrong, which is why it is pure and tested
// rather than inlined into a component.
import type { TreeItem } from "totoapi";

export interface Row {
  name: string;
  /** Slash-joined, no leading slash: `src/main.py`. Unique within a workspace,
   *  which is what lets it key expansion and selection. */
  path: string;
  isDirectory: boolean;
  depth: number;
  /** The server's id — what every file endpoint is addressed by. `path` is for
   *  the UI; this is for the API, and confusing them is the bug this comment
   *  exists to prevent. */
  id: number;
  /** Produced by a run: openable, never writable. */
  readonly: boolean;
  /** Cannot be opened at all — the vault holds it encrypted. */
  encrypted: boolean;
}

/** Build the display rows, in the order the server sent them.
 *
 *  ORDER IS THE SERVER'S. It already sorts directories and files the way the
 *  room draws them, and re-sorting here would be a second opinion that differs
 *  from the web UI for the same bucket.
 */
export function toRows(items: TreeItem[]): Row[] {
  // Directory names by id, so a child can name its parent. Built first and in
  // full: the server emits parents before children, but relying on that would
  // make this quietly wrong the day the ordering changes.
  const nameOf = new Map<number, string>();
  const parentOf = new Map<number, number | null>();
  for (const item of items) {
    if (item.t === "dir") {
      nameOf.set(item.id, item.name);
      parentOf.set(item.id, item.pid ?? null);
    }
  }

  function pathFor(item: TreeItem): string {
    const parts = [item.name];
    let parent = item.pid ?? null;
    // Bounded by the number of directories: a `pid` cycle in bad data would
    // otherwise hang the render, and a tree is the one place a cycle is cheap
    // to introduce and expensive to notice.
    let guard = nameOf.size + 1;
    while (parent !== null && guard > 0) {
      const name = nameOf.get(parent);
      if (name === undefined) break;
      parts.unshift(name);
      parent = parentOf.get(parent) ?? null;
      guard -= 1;
    }
    return parts.join("/");
  }

  return items.map((item) => ({
    name: item.name,
    path: pathFor(item),
    isDirectory: item.t === "dir",
    depth: item.depth,
    id: item.id,
    readonly: Boolean(item.readonly),
    encrypted: Boolean(item.encrypted),
  }));
}

/** Which rows are visible, given which folders are open.
 *
 *  A flat list plus a collapse rule, rather than a nested render: the server
 *  sends flat rows and `FileTree` draws flat rows, so nesting them here only to
 *  flatten them again would be work in both directions.
 *
 *  A row is hidden when ANY ancestor is collapsed — not just its parent. The
 *  parent-only version leaves grandchildren dangling under a closed folder,
 *  which looks like a rendering bug and is the reason this takes paths rather
 *  than ids.
 */
export function visible(rows: Row[], expanded: Set<string>): Row[] {
  return rows.filter((row) => {
    const parts = row.path.split("/");
    // Every ancestor path, shortest first.
    for (let i = 1; i < parts.length; i += 1) {
      if (!expanded.has(parts.slice(0, i).join("/"))) return false;
    }
    return true;
  });
}

/** Whether a row can be opened into an editor buffer at all. */
export function isOpenable(row: Row): boolean {
  return !row.isDirectory && !row.encrypted;
}
