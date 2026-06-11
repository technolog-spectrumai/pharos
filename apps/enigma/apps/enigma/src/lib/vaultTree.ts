// Pure, framework-free helpers that turn the flat vault API payloads
// (files + buckets-with-directories) into the nested forest the Storage view
// renders. Kept out of the component so it can be unit-tested in isolation.
import type { VaultFile, VaultBucket, VaultDirectory } from "../services/api";

export interface DirNode {
  id: number;
  name: string;
  path: string;
  bucketSlug: string;
  dirs: DirNode[];
  files: VaultFile[];
}

export interface BucketNode {
  slug: string;
  name: string;
  dirs: DirNode[];
  files: VaultFile[];
  fileCount: number;
}

function sortDirs(arr: DirNode[]): void {
  arr.sort((a, b) => a.name.localeCompare(b.name));
  for (const n of arr) {
    sortDirs(n.dirs);
    n.files.sort((a, b) => a.title.localeCompare(b.title));
  }
}

/**
 * Build the bucket → nested directory → file forest.
 *
 * - Files are grouped by `bucket_slug` (missing slug ⇒ "personal").
 * - A bucket appears if the buckets payload lists it OR a file references it.
 * - Files land in their `directory_id`; an unknown/missing directory id ⇒ the
 *   bucket root (so nothing is ever silently dropped).
 */
export function buildForest(files: VaultFile[], buckets: VaultBucket[]): BucketNode[] {
  const filesByBucket = new Map<string, VaultFile[]>();
  for (const f of files) {
    const slug = f.bucket_slug ?? "personal";
    const arr = filesByBucket.get(slug);
    if (arr) arr.push(f);
    else filesByBucket.set(slug, [f]);
  }

  const bucketMeta = new Map<string, { name: string; dirs: VaultDirectory[] }>();
  for (const b of buckets) bucketMeta.set(b.slug, { name: b.name, dirs: b.directories });
  for (const slug of filesByBucket.keys()) {
    if (!bucketMeta.has(slug)) bucketMeta.set(slug, { name: slug, dirs: [] });
  }

  const out: BucketNode[] = [];
  for (const [slug, meta] of bucketMeta) {
    const bucketFiles = filesByBucket.get(slug) ?? [];
    const nodeById = new Map<number, DirNode>();
    for (const d of meta.dirs) {
      nodeById.set(d.id, { id: d.id, name: d.name, path: d.path, bucketSlug: slug, dirs: [], files: [] });
    }

    const rootDirs: DirNode[] = [];
    for (const d of meta.dirs) {
      const node = nodeById.get(d.id)!;
      const parent = d.parent_id != null ? nodeById.get(d.parent_id) : undefined;
      if (parent) parent.dirs.push(node);
      else rootDirs.push(node);
    }

    const rootFiles: VaultFile[] = [];
    for (const f of bucketFiles) {
      const dir = f.directory_id != null ? nodeById.get(f.directory_id) : undefined;
      if (dir) dir.files.push(f);
      else rootFiles.push(f);
    }

    sortDirs(rootDirs);
    rootFiles.sort((a, b) => a.title.localeCompare(b.title));
    out.push({ slug, name: meta.name, dirs: rootDirs, files: rootFiles, fileCount: bucketFiles.length });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Depth-first lookup of a directory node by id. */
export function findDir(nodes: DirNode[], id: number): DirNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const r = findDir(n.dirs, id);
    if (r) return r;
  }
  return null;
}

/** Ancestor chain (root → target) for breadcrumbs; [] if not found. */
export function dirChain(nodes: DirNode[], id: number): DirNode[] {
  for (const n of nodes) {
    if (n.id === id) return [n];
    const sub = dirChain(n.dirs, id);
    if (sub.length) return [n, ...sub];
  }
  return [];
}
