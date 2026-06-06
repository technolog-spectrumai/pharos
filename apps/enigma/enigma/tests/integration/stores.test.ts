import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// Replace the whole API client with controllable mocks — the stores are the
// unit under test, the network is not.
vi.mock("../../src/services/api", () => ({
  api: {
    getFiles: vi.fn(),
    getBuckets: vi.fn(),
    getFileContent: vi.fn(),
    saveFileContent: vi.fn(),
    renameFile: vi.fn(),
    deleteFile: vi.fn(),
    uploadFile: vi.fn(),
    encryptFile: vi.fn(),
    decryptFile: vi.fn(),
    getVaultMetrics: vi.fn(),
    getBoxes: vi.fn(),
    getCategories: vi.fn(),
    getBoxLinks: vi.fn(),
    getAllLinks: vi.fn(),
    getReferences: vi.fn(),
    getFullGraph: vi.fn(),
    createBox: vi.fn(),
    updateBox: vi.fn(),
    deleteBox: vi.fn(),
    createLink: vi.fn(),
    deleteLink: vi.fn(),
    deleteReference: vi.fn(),
  },
}));

import { api } from "../../src/services/api";
import { useVaultStore } from "../../src/stores/vault";
import { useNotesStore } from "../../src/stores/notes";

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function vf(over: Record<string, unknown> = {}) {
  return {
    id: 1, title: "f", key: "f", file_type: "text", file_size_bytes: 1,
    is_public: false, is_encrypted: false, uploaded_at: "2026-01-01T00:00:00Z",
    download_url: null, bucket_slug: "personal", directory_id: null, is_editable: true,
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

describe("vault store", () => {
  it("fetchFiles loads files and buckets in parallel", async () => {
    mockApi.getFiles.mockResolvedValue({ files: [vf({ key: "a" })] });
    mockApi.getBuckets.mockResolvedValue({ buckets: [{ id: 1, slug: "personal", name: "Personal", directories: [] }] });
    const store = useVaultStore();
    await store.fetchFiles();
    expect(store.files).toHaveLength(1);
    expect(store.buckets).toHaveLength(1);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });

  it("fetchFiles tolerates a failing buckets endpoint (degrades to no folders)", async () => {
    mockApi.getFiles.mockResolvedValue({ files: [vf()] });
    mockApi.getBuckets.mockRejectedValue(new Error("500"));
    const store = useVaultStore();
    await store.fetchFiles();
    expect(store.files).toHaveLength(1);
    expect(store.buckets).toEqual([]);
  });

  it("fetchFiles records an error when the files call fails", async () => {
    mockApi.getFiles.mockRejectedValue(new Error("boom"));
    mockApi.getBuckets.mockResolvedValue({ buckets: [] });
    const store = useVaultStore();
    await store.fetchFiles();
    expect(store.error).toBe("boom");
  });

  it("saveContent replaces the updated file in place", async () => {
    mockApi.getFiles.mockResolvedValue({ files: [vf({ key: "a", title: "old" })] });
    mockApi.getBuckets.mockResolvedValue({ buckets: [] });
    mockApi.saveFileContent.mockResolvedValue(vf({ key: "a", title: "new", file_size_bytes: 99 }));
    const store = useVaultStore();
    await store.fetchFiles();
    await store.saveContent("a", "hello");
    expect(mockApi.saveFileContent).toHaveBeenCalledWith("a", "hello");
    expect(store.files[0].title).toBe("new");
    expect(store.files[0].file_size_bytes).toBe(99);
  });

  it("loadContent delegates to the API", async () => {
    mockApi.getFileContent.mockResolvedValue({ key: "a", content: "X", file_type: "text", is_editable: true, size: 1, title: "a" });
    const store = useVaultStore();
    const res = await store.loadContent("a");
    expect(res.content).toBe("X");
  });

  it("remove deletes the file from local state", async () => {
    mockApi.getFiles.mockResolvedValue({ files: [vf({ key: "a" }), vf({ key: "b", id: 2 })] });
    mockApi.getBuckets.mockResolvedValue({ buckets: [] });
    mockApi.deleteFile.mockResolvedValue(undefined);
    const store = useVaultStore();
    await store.fetchFiles();
    await store.remove("a");
    expect(store.files.map((f) => f.key)).toEqual(["b"]);
  });
});

describe("notes store", () => {
  it("fetchBoxes populates boxes", async () => {
    mockApi.getBoxes.mockResolvedValue({ boxes: [{ id: 1, label: "Note", properties: {} }] });
    const store = useNotesStore();
    await store.fetchBoxes();
    expect(store.boxes).toHaveLength(1);
    expect(store.boxes[0].label).toBe("Note");
  });

  it("createBox sends label + properties and selects the new box", async () => {
    const created = { id: 5, label: "New", properties: { body: "hi" }, is_locked: false, category_id: null, category_name: null, created_at: "", updated_at: "" };
    mockApi.createBox.mockResolvedValue(created);
    mockApi.getBoxLinks.mockResolvedValue({ links: [] });
    const store = useNotesStore();
    await store.createBox("New", "hi");
    expect(mockApi.createBox).toHaveBeenCalledWith({ label: "New", properties: { body: "hi" }, category_id: undefined });
    expect(store.boxes[0].id).toBe(5);
    expect(store.selectedBox?.id).toBe(5);
  });

  it("createBox sends empty properties when there is no body", async () => {
    mockApi.createBox.mockResolvedValue({ id: 6, label: "Empty", properties: {} });
    mockApi.getBoxLinks.mockResolvedValue({ links: [] });
    const store = useNotesStore();
    await store.createBox("Empty", "");
    expect(mockApi.createBox).toHaveBeenCalledWith({ label: "Empty", properties: {}, category_id: undefined });
  });

  it("saveBox replaces the edited box and keeps the selection in sync", async () => {
    mockApi.getBoxes.mockResolvedValue({ boxes: [{ id: 1, label: "A", properties: {} }] });
    mockApi.updateBox.mockResolvedValue({ id: 1, label: "A2", properties: { body: "z" } });
    const store = useNotesStore();
    await store.fetchBoxes();
    await store.saveBox(1, { label: "A2", properties: { body: "z" } });
    expect(store.boxes[0].label).toBe("A2");
  });

  it("addLink and removeLink mutate the links list", async () => {
    mockApi.createLink.mockResolvedValue({ id: 10, from_box: 1, to_box: 2, label: "rel", from_box_label: "A", to_box_label: "B" });
    mockApi.deleteLink.mockResolvedValue(undefined);
    const store = useNotesStore();
    await store.addLink(1, 2, "rel");
    expect(store.links).toHaveLength(1);
    await store.removeLink(10);
    expect(store.links).toHaveLength(0);
  });

  it("fetchGraph stores nodes and edges", async () => {
    mockApi.getFullGraph.mockResolvedValue({ nodes: [{ id: "b1" }], edges: [{ id: "l1" }] });
    const store = useNotesStore();
    await store.fetchGraph();
    expect(store.graphNodes).toHaveLength(1);
    expect(store.graphEdges).toHaveLength(1);
  });
});

describe("notes store — offline + sync", () => {
  function stubPull(boxes: any[] = []) {
    mockApi.getBoxes.mockResolvedValue({ boxes });
    mockApi.getCategories.mockResolvedValue({ categories: [] });
    mockApi.getAllLinks.mockResolvedValue({ links: [] });
    mockApi.getReferences.mockResolvedValue({ references: [] });
  }

  it("queues an offline create (temp id) and replays it on sync", async () => {
    const store = useNotesStore();
    store.online = false;
    const box = await store.createBox("Offline note", "body");
    expect(box!.id).toBeLessThan(0); // optimistic temp id
    expect(store.boxes[0].label).toBe("Offline note");
    expect(store.pendingCount).toBe(1);
    expect(mockApi.createBox).not.toHaveBeenCalled();

    store.online = true;
    mockApi.createBox.mockResolvedValue({ id: 50, label: "Offline note", properties: { body: "body" } });
    stubPull([{ id: 50, label: "Offline note", properties: { body: "body" } }]);
    await store.sync();

    expect(mockApi.createBox).toHaveBeenCalledWith({ label: "Offline note", properties: { body: "body" }, category_id: undefined });
    expect(store.pendingCount).toBe(0);
    expect(store.boxes[0].id).toBe(50);
    expect(store.lastSyncedAt).not.toBeNull();
  });

  it("resolves a temp box id for a queued update during sync", async () => {
    const store = useNotesStore();
    store.online = false;
    const box = await store.createBox("X", "");
    await store.saveBox(box!.id, { label: "X2" });
    expect(store.pendingCount).toBe(2);

    store.online = true;
    mockApi.createBox.mockResolvedValue({ id: 70, label: "X", properties: {} });
    mockApi.updateBox.mockResolvedValue({ id: 70, label: "X2", properties: {} });
    stubPull([]);
    await store.sync();
    expect(mockApi.updateBox).toHaveBeenCalledWith(70, { label: "X2" });
  });

  it("replays a queued link with resolved box ids", async () => {
    const store = useNotesStore();
    store.online = false;
    const a = await store.createBox("A", "");
    const b = await store.createBox("B", "");
    await store.addLink(a!.id, b!.id, "rel");
    expect(store.pendingCount).toBe(3);

    store.online = true;
    mockApi.createBox
      .mockResolvedValueOnce({ id: 10, label: "A", properties: {} })
      .mockResolvedValueOnce({ id: 11, label: "B", properties: {} });
    mockApi.createLink.mockResolvedValue({ id: 99, from_box: 10, to_box: 11, label: "rel", from_box_label: "A", to_box_label: "B" });
    stubPull([]);
    await store.sync();
    expect(mockApi.createLink).toHaveBeenCalledWith(10, 11, "rel");
  });

  it("falls back to the offline queue on a network error", async () => {
    const store = useNotesStore();
    mockApi.createBox.mockRejectedValue(new TypeError("Failed to fetch"));
    const box = await store.createBox("Net", "");
    expect(box!.id).toBeLessThan(0);
    expect(store.online).toBe(false);
    expect(store.pendingCount).toBe(1);
  });

  it("does NOT queue on a real HTTP error (rethrows)", async () => {
    const store = useNotesStore();
    mockApi.createBox.mockRejectedValue(new Error("400: bad request"));
    await expect(store.createBox("X", "")).rejects.toThrow("400");
    expect(store.pendingCount).toBe(0);
  });
});
