import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import FilesView from "../../src/views/FilesView.vue";
import { i18n } from "../../src/i18n";

// Everything below the view is mocked at the Tauri boundary — the same seam the
// cloud sign-in tests use. What is being tested is the view's own judgement:
// what it offers, what it refuses, and what it says.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(), stat: vi.fn(), readTextFile: vi.fn(), writeTextFile: vi.fn(),
}));

const file = (over: Record<string, unknown> = {}) => ({
  id: 1, title: "drawing.svg", key: "drawing-svg", file_type: "svg",
  file_size_bytes: 2048, is_public: false, is_encrypted: false,
  uploaded_at: "2026-08-01T10:00:00Z", download_url: null,
  bucket_slug: "main", directory_id: null, is_editable: true, ...over,
});

/** The transport returns a Response; these are what the proxy would reply. */
function reply(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) };
}

function mountFiles() {
  return mount(FilesView, { global: { plugins: [i18n], stubs: { teleport: true } } });
}

/** The request chain is deeper than one microtask: a dynamic `import()` of the
 *  Tauri bridge, then the invoke, then `Response.text()`. A single
 *  flushPromises leaves the store still loading, so drain until it settles. */
async function settle() {
  for (let i = 0; i < 8; i++) await flushPromises();
}

beforeEach(async () => {
  localStorage.clear();
  invoke.mockReset();
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const { useCloud } = await import("../../src/cloud/useCloud");
  const cloud = useCloud();
  cloud.setSettings({ server: "https://s.test", fingerprint: "" });
  cloud.signedIn.value = true;
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the Files tab — cloud", () => {
  it("asks the user to sign in rather than showing an empty vault", async () => {
    const { useCloud } = await import("../../src/cloud/useCloud");
    useCloud().signedIn.value = false;
    const w = mountFiles();
    await settle();
    expect(w.find('[data-testid="files-signed-out"]').exists()).toBe(true);
    expect(w.find('[data-testid="files-tree"]').exists()).toBe(false);
  });

  it("lists what the server returned, folders and files", async () => {
    invoke
      .mockResolvedValueOnce(reply(200, { files: [file(), file({ key: "in-folder", title: "notes.xml", directory_id: 7 })] }))
      .mockResolvedValueOnce(reply(200, {
        buckets: [{ id: 1, slug: "main", name: "Main", directories: [{ id: 7, name: "reports", parent_id: null, path: "reports" }] }],
      }));
    const w = mountFiles();
    await settle();

    expect(w.get('[data-testid="tree-d:7"]').text()).toContain("reports");
    // A single bucket collapses away, so the root selection is the folder.
    expect(w.find('[data-testid="file-drawing-svg"]').exists() || w.find('[data-testid="file-in-folder"]').exists()).toBe(true);
  });

  it("marks an encrypted file and refuses to open it", async () => {
    // Encryption is out of scope; the editor would be handed ciphertext.
    invoke
      .mockResolvedValueOnce(reply(200, { files: [file({ key: "secret", title: "secret.svg", is_encrypted: true })] }))
      .mockResolvedValueOnce(reply(200, { buckets: [{ id: 1, slug: "main", name: "Main", directories: [] }] }));
    const w = mountFiles();
    await settle();

    expect(w.get('[data-testid="encrypted-secret"]').exists()).toBe(true);
    const open = w.get('[data-testid="open-secret"]');
    expect((open.element as HTMLButtonElement).disabled).toBe(true);

    const before = invoke.mock.calls.length;
    await open.trigger("click");
    await settle();
    expect(invoke.mock.calls.length).toBe(before); // nothing was fetched
    expect(w.emitted("open")).toBeUndefined();
  });

  it("says when the listing hit the server's cap", async () => {
    // There is no pagination behind it, so the rest of the vault is simply
    // unreachable — showing a truncated list as the whole thing would lie.
    invoke
      .mockResolvedValueOnce(reply(200, { files: Array.from({ length: 200 }, (_, i) => file({ key: `f${i}` })) }))
      .mockResolvedValueOnce(reply(200, { buckets: [{ id: 1, slug: "main", name: "Main", directories: [] }] }));
    const w = mountFiles();
    await settle();
    expect(w.get('[data-testid="files-cap"]').text()).toContain("200");
  });

  it("opens a file into the editor its content calls for", async () => {
    invoke
      .mockResolvedValueOnce(reply(200, { files: [file()] }))
      .mockResolvedValueOnce(reply(200, { buckets: [{ id: 1, slug: "main", name: "Main", directories: [] }] }))
      .mockResolvedValueOnce(reply(200, {
        key: "drawing-svg", title: "drawing.svg", file_type: "svg", is_editable: true,
        size: 10, content: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
      }));
    const w = mountFiles();
    await settle();
    await w.get('[data-testid="open-drawing-svg"]').trigger("click");
    await settle();

    const opened = w.emitted("open")?.[0][0] as { kind: string; name: string };
    expect(opened.kind).toBe("sketch");
    expect(opened.name).toBe("drawing.svg");
  });

  it("confirms before deleting, and does nothing until it is confirmed", async () => {
    invoke
      .mockResolvedValueOnce(reply(200, { files: [file()] }))
      .mockResolvedValueOnce(reply(200, { buckets: [{ id: 1, slug: "main", name: "Main", directories: [] }] }));
    const w = mountFiles();
    await settle();

    const before = invoke.mock.calls.length;
    await w.get('[data-testid="delete-drawing-svg"]').trigger("click");
    await settle();
    expect(invoke.mock.calls.length).toBe(before); // asked, not done

    invoke.mockResolvedValueOnce(reply(204, {}));
    await w.get('[data-testid="files-confirm-delete"]').trigger("click");
    await settle();
    const [, args] = invoke.mock.calls.at(-1)!;
    expect((args as Record<string, unknown>).method).toBe("DELETE");
  });

  it("reports a refusal from the server instead of guessing", async () => {
    // The client never decides what may be seen — a 404 is the server saying so.
    invoke
      .mockResolvedValueOnce(reply(404, { error: "Not found." }))
      .mockResolvedValueOnce(reply(200, { buckets: [] }));
    const w = mountFiles();
    await settle();
    expect(w.get('[data-testid="files-error"]').text()).toBe("That is no longer there.");
  });

  it("signs out when the session died server-side", async () => {
    const { useCloud } = await import("../../src/cloud/useCloud");
    invoke
      .mockResolvedValueOnce(reply(401, { error: "Not authenticated." }))
      .mockResolvedValueOnce(reply(200, { buckets: [] }));
    const w = mountFiles();
    await settle();
    expect(useCloud().signedIn.value).toBe(false);
    expect(w.find('[data-testid="files-signed-out"]').exists()).toBe(true);
  });
});

describe("the Files tab — local", () => {
  it("offers a folder picker before anything else", async () => {
    const w = mountFiles();
    await settle();
    await w.get('[data-testid="files-pane-local"]').trigger("click");
    expect(w.get('[data-testid="workspace-empty"]').exists()).toBe(true);
    expect(w.get('[data-testid="workspace-pick"]').exists()).toBe(true);
  });
});
