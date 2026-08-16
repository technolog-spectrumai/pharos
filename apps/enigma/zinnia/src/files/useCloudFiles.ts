// The vault, as the Files tab sees it.
//
// A module-level ref store, matching useSystemColors and useCloud — one vault,
// no need for actions or a devtools timeline.
//
// The listing this holds is WHAT THE SERVER RETURNED and nothing else. Every
// vault endpoint filters by `owner=request.user` before answering, so this
// store never decides what the user may see — it has no filtering-for-security
// code and must not grow any. A client that hid rows would only be hiding them
// from the person who is already allowed to see them.
import { computed, ref } from "vue";
import { createClient, type ApiClient } from "../api/client";
import { tauriFetch } from "../api/transport";
import { ApiFailure } from "../api/errors";
import {
  bucketTree, createDirectory, deleteDirectory, deleteFile, FILE_LIST_CAP,
  getContent, listFiles,
  type VaultBucketDto, type VaultFileDto,
} from "../api/vault";
import { buildTree, filesIn, type TreeNode } from "./cloudTree";
import { useCloud } from "../cloud/useCloud";

const files = ref<VaultFileDto[]>([]);
const buckets = ref<VaultBucketDto[]>([]);
const selectedId = ref<string | null>(null);
const loading = ref(false);
const error = ref("");
const search = ref("");
/** Set when the server returned its hard cap. There is no pagination behind it,
 *  so the rest of the vault is simply unreachable here — the UI says so rather
 *  than presenting a truncated list as the whole thing. */
const atCap = ref(false);

export function useCloudFiles() {
  const cloud = useCloud();

  function client(): ApiClient {
    return createClient({
      baseUrl: cloud.settings.value.server,
      // The token is in the OS keychain and never reaches JS; Rust attaches it.
      getToken: () => null,
      fetchImpl: tauriFetch(() => cloud.settings.value),
    });
  }

  const nodes = computed<TreeNode[]>(() => buildTree(buckets.value));
  const selected = computed<TreeNode | null>(
    () => nodes.value.find((n) => n.id === selectedId.value) ?? null,
  );

  const visibleFiles = computed(() => {
    const rows = filesIn(files.value, selected.value);
    const needle = search.value.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((f) => (f.title || f.key).toLowerCase().includes(needle));
  });

  async function refresh(): Promise<void> {
    if (!cloud.signedIn.value) return;
    loading.value = true;
    error.value = "";
    try {
      const api = client();
      // Two calls because the server splits them: files carry their bucket and
      // directory ids, the tree carries the folders. Neither contains the other.
      const [rows, tree] = await Promise.all([listFiles(api), bucketTree(api)]);
      files.value = rows;
      buckets.value = tree;
      atCap.value = rows.length >= FILE_LIST_CAP;
      if (!selectedId.value || !nodes.value.some((n) => n.id === selectedId.value)) {
        selectedId.value = nodes.value[0]?.id ?? null;
      }
    } catch (err) {
      error.value = describe(err);
      if (err instanceof ApiFailure && err.error.kind === "unauthorized") {
        // The session died server-side; Rust already cleared it, so reflect it.
        cloud.signedIn.value = false;
      }
    } finally {
      loading.value = false;
    }
  }

  async function open(file: VaultFileDto): Promise<string> {
    return (await getContent(client(), file.key)).content;
  }

  async function remove(file: VaultFileDto): Promise<void> {
    await deleteFile(client(), file.key);
    files.value = files.value.filter((f) => f.key !== file.key);
  }

  async function newFolder(name: string): Promise<void> {
    const node = selected.value;
    if (!node) return;
    await createDirectory(client(), {
      bucket_slug: node.bucketSlug,
      name,
      parent_id: node.directoryId,
    });
    await refresh();
  }

  async function removeFolder(node: TreeNode): Promise<void> {
    if (node.directoryId === null) return;
    await deleteDirectory(client(), node.directoryId);
    await refresh();
  }

  function select(id: string | null) {
    selectedId.value = id;
  }

  return {
    files, buckets, nodes, selected, selectedId, visibleFiles,
    loading, error, search, atCap,
    refresh, open, remove, newFolder, removeFolder, select,
  };
}

/** Errors reach the UI as an i18n key where the taxonomy has one, so a
 *  server-side wording change cannot break what the user reads. */
export function describe(err: unknown): string {
  if (err instanceof ApiFailure) return `cloud.apiErrors.${err.error.kind}`;
  if (typeof err === "string") return err;
  return "cloud.apiErrors.unknown";
}
