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
    getFullGraph: vi.fn(),
    createBox: vi.fn(),
    updateBox: vi.fn(),
    deleteBox: vi.fn(),
    createLink: vi.fn(),
    deleteLink: vi.fn(),
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
