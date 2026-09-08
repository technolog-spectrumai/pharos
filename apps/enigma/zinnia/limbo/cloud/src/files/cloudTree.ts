// Turning the vault's two flat lists into a tree.
//
// The server hands back files and buckets-with-directories SEPARATELY and never
// nested: `/vault/api/files/` returns every file with a `bucket_slug` and a
// `directory_id`, and `/vault/api/buckets/` returns the folders with a
// `parent_id` each. The nesting is computed here, once, in a pure function —
// which is also why it can be tested without a component or a server.
//
// Rows are FLAT and depth-tagged rather than nested, so the template never
// recurses: indentation is a padding calculation and visibility is a walk up
// the parent chain. That is the shape enigma's file tree settled on and it
// keeps arbitrarily deep folders from becoming arbitrarily deep components.
import type { VaultBucketDto, VaultDirectoryDto, VaultFileDto } from "../api/vault";

export interface TreeNode {
  /** Stable across refreshes: `b:<slug>` or `d:<id>`. */
  id: string;
  /** Parent node id; null at the root. */
  pid: string | null;
  depth: number;
  kind: "bucket" | "directory";
  name: string;
  /** For addressing files: which bucket this node lives in… */
  bucketSlug: string;
  /** …and which directory, null meaning the bucket's own root. */
  directoryId: number | null;
}

export const bucketNodeId = (slug: string) => `b:${slug}`;
export const directoryNodeId = (id: number) => `d:${id}`;

/**
 * Depth-first rows for the folder pane.
 *
 * Every bucket gets a root row, ALWAYS — including when there is only one.
 * Collapsing the single-bucket row away seems tidier and is wrong: a file
 * sitting at the bucket's root belongs to that row and nothing else, so
 * dropping it makes those files unreachable. There is no other node that
 * represents "the top of this bucket".
 */
export function buildTree(buckets: VaultBucketDto[]): TreeNode[] {
  const rows: TreeNode[] = [];

  for (const bucket of buckets) {
    const rootId = bucketNodeId(bucket.slug);
    rows.push({
      id: rootId,
      pid: null,
      depth: 0,
      kind: "bucket",
      name: bucket.name || bucket.slug,
      bucketSlug: bucket.slug,
      directoryId: null,
    });

    const byParent = new Map<number | null, VaultDirectoryDto[]>();
    for (const dir of bucket.directories) {
      const parent = dir.parent_id ?? null;
      const siblings = byParent.get(parent) ?? [];
      siblings.push(dir);
      byParent.set(parent, siblings);
    }
    for (const siblings of byParent.values()) {
      siblings.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Iterative, with a seen-set. A directory whose parent_id points at another
    // bucket's directory — or at itself after some server-side edit — would
    // otherwise recurse forever; a malformed tree should render short, not hang.
    const seen = new Set<number>();
    const walk = (parentId: number | null, pid: string | null, depth: number) => {
      for (const dir of byParent.get(parentId) ?? []) {
        if (seen.has(dir.id)) continue;
        seen.add(dir.id);
        const id = directoryNodeId(dir.id);
        rows.push({
          id,
          pid,
          depth,
          kind: "directory",
          name: dir.name,
          bucketSlug: bucket.slug,
          directoryId: dir.id,
        });
        walk(dir.id, id, depth + 1);
      }
    };
    walk(null, rootId, 1);

    // Orphans: a directory whose parent is not in this bucket's list. Shown at
    // the bucket root rather than dropped — a folder the server says exists but
    // the app cannot see is worse than one shown in the wrong place.
    for (const dir of bucket.directories) {
      if (seen.has(dir.id)) continue;
      seen.add(dir.id);
      rows.push({
        id: directoryNodeId(dir.id),
        pid: rootId,
        depth: 1,
        kind: "directory",
        name: dir.name,
        bucketSlug: bucket.slug,
        directoryId: dir.id,
      });
    }
  }
  return rows;
}

/** The files that belong to one node of the tree. */
export function filesIn(files: VaultFileDto[], node: TreeNode | null): VaultFileDto[] {
  if (!node) return [];
  return files
    .filter(
      (f) =>
        f.bucket_slug === node.bucketSlug &&
        (f.directory_id ?? null) === node.directoryId,
    )
    .sort((a, b) => (a.title || a.key).localeCompare(b.title || b.key));
}

/** Whether a folder can be deleted — the server refuses a non-empty one with a
 *  409, so offering the button would just produce an error the user could have
 *  been spared. The server still decides; this only hides a doomed action. */
export function isEmptyDirectory(
  node: TreeNode,
  nodes: TreeNode[],
  files: VaultFileDto[],
): boolean {
  if (node.kind !== "directory") return false;
  if (nodes.some((n) => n.pid === node.id)) return false;
  return !files.some(
    (f) => f.bucket_slug === node.bucketSlug && (f.directory_id ?? null) === node.directoryId,
  );
}

/** The path back to the root, for the breadcrumb. */
export function trailTo(node: TreeNode | null, nodes: TreeNode[]): TreeNode[] {
  const trail: TreeNode[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let current = node;
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    trail.unshift(current);
    current = current.pid ? (byId.get(current.pid) ?? null) : null;
  }
  return trail;
}
