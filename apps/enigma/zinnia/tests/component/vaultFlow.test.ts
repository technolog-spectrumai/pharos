import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import App from "../../src/App.vue";
import { i18n } from "../../src/i18n";

// The whole vault seam in one place: sign in, list, open into the editor,
// save back through the content API. fetch is the only thing mocked — the
// stores, the client and the views are all real.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const FILE = {
  id: 7, title: "notes.md", key: "notes-md", file_type: "text",
  file_size_bytes: 5, is_public: false, is_encrypted: false,
  uploaded_at: "2026-08-16T10:00:00Z", download_url: null,
  bucket_slug: "main", directory_id: null, is_editable: true,
};

function mountApp() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(App, { global: { plugins: [i18n, pinia], stubs: { teleport: true } } });
}

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("the vault flow", () => {
  it("signs in, lists, opens a file into the editor, saves back", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/api/login/")) return jsonResponse(200, { ok: true, token: "sess-key" });
      if (url.endsWith("/vault/api/files/")) return jsonResponse(200, { files: [FILE] });
      if (url.endsWith("/vault/api/files/notes-md/content/") && init?.method !== "PUT")
        return jsonResponse(200, { key: "notes-md", title: "notes.md", file_type: "text",
                                   is_editable: true, size: 5, content: "hello" });
      if (url.endsWith("/vault/api/files/notes-md/content/") && init?.method === "PUT")
        return jsonResponse(200, { ...FILE });
      throw new Error(`unexpected fetch ${url}`);
    }));

    const w = mountApp();
    await w.get('[data-testid="nav-vault"]').trigger("click");
    await flushPromises();

    // Sign in.
    await w.get('[data-testid="vault-user"]').setValue("janek");
    await w.get('[data-testid="vault-pass"]').setValue("pw");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(localStorage.getItem("zinnia:token")).toBe("sess-key");

    // The listing arrived; open the file.
    await w.get('[data-testid="vault-row-7"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-testid="file-name"]').text()).toBe("notes.md");
    expect(w.find('[data-testid="ace-host"]').exists()).toBe(true); // routed to ACE

    // Save goes back through PUT with the Bearer token, not to disk.
    await w.get('[data-testid="file-save"]').trigger("click");
    await flushPromises();
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(put).toBeTruthy();
    expect((put!.init!.headers as Record<string, string>).Authorization).toBe("Bearer sess-key");
  });

  it("a dead session flips the app to signed-out instead of erroring forever", async () => {
    localStorage.setItem("zinnia:token", "stale");
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(401, { error: "Not authenticated." })));

    const w = mountApp();
    await w.get('[data-testid="nav-vault"]').trigger("click");
    await flushPromises();
    // The store dropped the token and the login form is back.
    expect(localStorage.getItem("zinnia:token")).toBeNull();
    expect(w.find('[data-testid="vault-user"]').exists()).toBe(true);
  });
});
