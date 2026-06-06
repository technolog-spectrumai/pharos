import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
  api,
  type NoteBox,
  type NoteCategory,
  type NoteLink,
  type NoteEdge,
  type NoteReference,
  type NoteProperties,
} from "../services/api";
import { getServerUrl } from "../services/appStorage";
import {
  loadSnapshot,
  saveSnapshot,
  loadQueue,
  saveQueue,
  makeTempId,
  opId,
  isNetworkError,
  type QueueOp,
} from "../services/notesOffline";

/**
 * Offline-first Notes store.
 *
 * - Hydrates from a local snapshot so notes are usable with no server.
 * - When online, mutations hit the server directly and refresh the cache.
 * - When offline (or once a queue exists), mutations apply optimistically and
 *   are queued; `sync()` replays the queue and pulls fresh data.
 */
export const useNotesStore = defineStore("notes", () => {
  const boxes = ref<NoteBox[]>([]);
  const categories = ref<NoteCategory[]>([]);
  const links = ref<NoteLink[]>([]); // ALL links (the per-box panels filter this)
  const references = ref<NoteReference[]>([]);
  const selectedBox = ref<NoteBox | null>(null);
  const graphNodes = ref<NoteBox[]>([]);
  const graphEdges = ref<NoteEdge[]>([]);

  const loading = ref(false);
  const graphLoading = ref(false);
  const error = ref<string | null>(null);

  // Offline / sync state
  const online = ref(typeof navigator === "undefined" ? true : navigator.onLine);
  const syncing = ref(false);
  const queue = ref<QueueOp[]>([]);
  const lastSyncedAt = ref<string | null>(null);
  const initialized = ref(false);
  let scope = "";

  const pendingCount = computed(() => queue.value.length);
  const hasPending = computed(() => queue.value.length > 0);

  // ── persistence ────────────────────────────────────────────────────────────
  function persist() {
    saveSnapshot(scope, {
      boxes: boxes.value,
      categories: categories.value,
      links: links.value,
      references: references.value,
      lastSyncedAt: lastSyncedAt.value,
    });
  }
  function enqueue(op: QueueOp) {
    queue.value.push(op);
    saveQueue(scope, queue.value);
    persist();
  }

  function categoryName(id?: number | null): string | null {
    if (id == null) return null;
    return categories.value.find((c) => c.id === id)?.name ?? null;
  }
  function boxLabel(id: number): string {
    return boxes.value.find((b) => b.id === id)?.label || "Untitled";
  }

  /** Run a server call; classify failures as offline (network) vs real errors. */
  async function tryServer<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const value = await fn();
      online.value = true;
      return { ok: true, value };
    } catch (e) {
      if (isNetworkError(e)) {
        online.value = false;
        return { ok: false };
      }
      throw e;
    }
  }

  const direct = () => online.value && queue.value.length === 0;

  // ── lifecycle ────────────────────────────────────────────────────────────────
  async function init() {
    scope = (await getServerUrl()).replace(/\/$/, "");
    const snap = loadSnapshot(scope);
    if (snap) {
      boxes.value = snap.boxes;
      categories.value = snap.categories;
      links.value = snap.links;
      references.value = snap.references;
      lastSyncedAt.value = snap.lastSyncedAt;
    }
    queue.value = loadQueue(scope);
    initialized.value = true;
    if (typeof navigator === "undefined" || navigator.onLine) {
      await sync().catch(() => {});
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────────
  async function fetchBoxes() {
    loading.value = true;
    error.value = null;
    try {
      if (!scope) scope = (await getServerUrl()).replace(/\/$/, "");
      const r = await tryServer(() => api.getBoxes());
      if (r.ok) {
        boxes.value = r.value.boxes;
        persist();
      }
    } catch (e: any) {
      error.value = e.message ?? "Failed to load notes";
    } finally {
      loading.value = false;
    }
  }

  async function fetchCategories() {
    const r = await tryServer(() => api.getCategories()).catch(() => null);
    if (r && r.ok) {
      categories.value = r.value.categories;
      persist();
    }
  }

  async function fetchAllLinks() {
    const r = await tryServer(() => api.getAllLinks()).catch(() => null);
    if (r && r.ok) {
      links.value = r.value.links;
      persist();
    }
  }

  async function fetchReferences() {
    const r = await tryServer(() => api.getReferences()).catch(() => null);
    if (r && r.ok) {
      references.value = r.value.references;
      persist();
    }
  }

  async function fetchGraph() {
    graphLoading.value = true;
    try {
      const r = await tryServer(() => api.getFullGraph()).catch(() => null);
      if (r && r.ok) {
        graphNodes.value = r.value.nodes;
        graphEdges.value = r.value.edges;
      }
    } finally {
      graphLoading.value = false;
    }
  }

  // ── writes (offline-aware) ────────────────────────────────────────────────────
  async function createBox(label: string, body: string, category_id?: number | null) {
    const data = { label, properties: (body ? { body } : {}) as NoteProperties, category_id };
    if (direct()) {
      const r = await tryServer(() => api.createBox(data));
      if (r.ok) {
        boxes.value.unshift(r.value);
        persist();
        selectBox(r.value);
        return r.value;
      }
    }
    const now = new Date().toISOString();
    const box: NoteBox = {
      id: makeTempId(boxes.value),
      label,
      is_locked: false,
      category_id: category_id ?? null,
      category_name: categoryName(category_id),
      properties: data.properties,
      created_at: now,
      updated_at: now,
    };
    boxes.value.unshift(box);
    enqueue({ id: opId(), kind: "createBox", tempId: box.id, data });
    selectBox(box);
    return box;
  }

  async function saveBox(
    id: number,
    changes: Partial<{ label: string; properties: NoteProperties; category_id: number | null }>,
  ) {
    const idx = boxes.value.findIndex((b) => b.id === id);
    const apply = (b: NoteBox): NoteBox => ({
      ...b,
      ...("label" in changes ? { label: changes.label! } : {}),
      ...("properties" in changes ? { properties: changes.properties! } : {}),
      ...("category_id" in changes
        ? { category_id: changes.category_id ?? null, category_name: categoryName(changes.category_id) }
        : {}),
      updated_at: new Date().toISOString(),
    });
    if (idx !== -1) boxes.value[idx] = apply(boxes.value[idx]);
    if (selectedBox.value?.id === id && idx !== -1) selectedBox.value = boxes.value[idx];

    if (direct() && id > 0) {
      const r = await tryServer(() => api.updateBox(id, changes));
      if (r.ok) {
        if (idx !== -1) boxes.value[idx] = r.value;
        if (selectedBox.value?.id === id) selectedBox.value = r.value;
        persist();
        return r.value;
      }
    }
    enqueue({ id: opId(), kind: "updateBox", boxId: id, data: changes });
    return idx !== -1 ? boxes.value[idx] : null;
  }

  async function removeBox(id: number) {
    boxes.value = boxes.value.filter((b) => b.id !== id);
    links.value = links.value.filter((l) => l.from_box !== id && l.to_box !== id);
    if (selectedBox.value?.id === id) selectedBox.value = null;

    if (direct() && id > 0) {
      const r = await tryServer(() => api.deleteBox(id));
      if (r.ok) {
        persist();
        return;
      }
    }
    enqueue({ id: opId(), kind: "deleteBox", boxId: id });
  }

  function selectBox(box: NoteBox | null) {
    selectedBox.value = box;
  }

  async function addLink(fromBox: number, toBox: number, label: string) {
    if (direct() && fromBox > 0 && toBox > 0) {
      const r = await tryServer(() => api.createLink(fromBox, toBox, label));
      if (r.ok) {
        links.value.unshift(r.value);
        persist();
        return r.value;
      }
    }
    const link: NoteLink = {
      id: makeTempId(links.value),
      from_box: fromBox,
      to_box: toBox,
      label: label || "related to",
      from_box_label: boxLabel(fromBox),
      to_box_label: boxLabel(toBox),
    };
    links.value.unshift(link);
    enqueue({ id: opId(), kind: "createLink", tempId: link.id, from_box: fromBox, to_box: toBox, label });
    return link;
  }

  async function removeLink(id: number) {
    links.value = links.value.filter((l) => l.id !== id);
    if (direct() && id > 0) {
      const r = await tryServer(() => api.deleteLink(id));
      if (r.ok) {
        persist();
        return;
      }
    }
    enqueue({ id: opId(), kind: "deleteLink", linkId: id });
  }

  async function removeReference(id: number) {
    references.value = references.value.filter((r) => r.id !== id);
    if (direct() && id > 0) {
      const r = await tryServer(() => api.deleteReference(id));
      if (r.ok) {
        persist();
        return;
      }
    }
    enqueue({ id: opId(), kind: "deleteReference", refId: id });
  }

  // ── sync ──────────────────────────────────────────────────────────────────────
  async function sync() {
    if (syncing.value) return;
    syncing.value = true;
    error.value = null;
    try {
      if (!scope) scope = (await getServerUrl()).replace(/\/$/, "");
      const boxIdMap = new Map<number, number>();
      const linkIdMap = new Map<number, number>();
      const resolveBox = (id: number) => (id < 0 ? boxIdMap.get(id) ?? id : id);

      let q = [...queue.value];
      while (q.length) {
        const op = q[0];
        if (op.kind === "createBox") {
          const box = await api.createBox(op.data);
          boxIdMap.set(op.tempId, box.id);
        } else if (op.kind === "updateBox") {
          const rid = resolveBox(op.boxId);
          if (rid > 0) await api.updateBox(rid, op.data);
        } else if (op.kind === "deleteBox") {
          const rid = resolveBox(op.boxId);
          if (rid > 0) await api.deleteBox(rid);
        } else if (op.kind === "createLink") {
          const f = resolveBox(op.from_box);
          const t = resolveBox(op.to_box);
          if (f > 0 && t > 0) {
            const link = await api.createLink(f, t, op.label);
            linkIdMap.set(op.tempId, link.id);
          }
        } else if (op.kind === "deleteLink") {
          const rid = op.linkId < 0 ? linkIdMap.get(op.linkId) ?? op.linkId : op.linkId;
          if (rid > 0) await api.deleteLink(rid);
        } else if (op.kind === "deleteReference") {
          if (op.refId > 0) await api.deleteReference(op.refId);
        }
        q = q.slice(1);
        queue.value = q;
        saveQueue(scope, q);
      }

      // Pull a fresh, authoritative snapshot.
      const [boxesR, catsR, linksR, refsR] = await Promise.all([
        api.getBoxes(),
        api.getCategories(),
        api.getAllLinks(),
        api.getReferences(),
      ]);
      boxes.value = boxesR.boxes;
      categories.value = catsR.categories;
      links.value = linksR.links;
      references.value = refsR.references;

      if (selectedBox.value) {
        const realId = boxIdMap.get(selectedBox.value.id) ?? selectedBox.value.id;
        selectedBox.value = boxes.value.find((b) => b.id === realId) ?? null;
      }

      lastSyncedAt.value = new Date().toISOString();
      online.value = true;
      persist();
    } catch (e: any) {
      if (isNetworkError(e)) {
        online.value = false;
      } else {
        error.value = e.message ?? "Sync failed";
      }
      throw e;
    } finally {
      syncing.value = false;
    }
  }

  const outgoingLinks = (boxId: number) => links.value.filter((l) => l.from_box === boxId);
  const incomingLinks = (boxId: number) => links.value.filter((l) => l.to_box === boxId);
  const boxReferences = (boxId: number) => references.value.filter((r) => r.box === boxId);

  return {
    boxes, categories, links, references, selectedBox, graphNodes, graphEdges,
    loading, graphLoading, error,
    online, syncing, pendingCount, hasPending, lastSyncedAt, initialized,
    init, sync,
    fetchBoxes, fetchCategories, fetchAllLinks, fetchReferences, fetchGraph,
    createBox, saveBox, removeBox, selectBox, addLink, removeLink, removeReference,
    outgoingLinks, incomingLinks, boxReferences,
  };
});
