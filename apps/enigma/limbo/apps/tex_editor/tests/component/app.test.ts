// The shell: which screen shows, and what the buttons refuse to do.
//
// The three screens are derived from state rather than from a route, so this is
// where that derivation is proven. The Tauri bridge is mocked at the module
// boundary — a component test has no `__TAURI_INTERNALS__` — and the API is
// mocked at the store, because the store's own behaviour is already covered
// against a fake server in tests/unit.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { i18n } from "../../src/i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));

import App from "../../src/App.vue";
import { __setStateForTests, __resetForTests as resetSession } from "../../src/platform/session";
import * as workspace from "../../src/platform/workspace";

function render() {
  return mount(App, {
    global: {
      plugins: [i18n],
      stubs: {
        // ACE needs a real layout pass; jsdom has none, and the editor's own
        // contract is covered by the store's tests.
        CodeEditor: { template: "<div data-testid='code-editor-stub' />" },
      },
    },
  });
}

beforeEach(() => {
  resetSession();
  workspace.__resetForTests();
  vi.restoreAllMocks();
});

describe("which screen shows", () => {
  it("the connect screen when there is no session", async () => {
    const page = render();
    await flushPromises();
    expect(page.find("[data-testid='server']").exists()).toBe(true);
    expect(page.find("[data-testid='picker']").exists()).toBe(false);
  });

  it("the workspace picker once connected with nothing open", async () => {
    __setStateForTests({ connected: true, server: "https://z.test", username: "ada" });
    vi.spyOn(workspace, "loadList").mockResolvedValue(undefined);
    const page = render();
    await flushPromises();
    expect(page.find("[data-testid='picker']").exists()).toBe(true);
  });

  it("says so plainly when there are no workspaces", async () => {
    __setStateForTests({ connected: true, server: "https://z.test" });
    vi.spyOn(workspace, "loadList").mockResolvedValue(undefined);
    const page = render();
    await flushPromises();
    expect(page.find("[data-testid='no-workspaces']").exists()).toBe(true);
  });
});

describe("the connect screen", () => {
  it("will not connect on a token of the wrong shape", async () => {
    const page = render();
    await flushPromises();
    await page.find("[data-testid='server']").setValue("https://z.test");
    await page.find("[data-testid='token']").setValue("not-a-token");
    expect(
      page.find("[data-testid='connect']").attributes("disabled"),
    ).toBeDefined();
  });

  it("enables Connect for a well-shaped token", async () => {
    const page = render();
    await flushPromises();
    await page.find("[data-testid='server']").setValue("https://z.test");
    await page.find("[data-testid='token']").setValue("capsule.sel.ver");
    expect(
      page.find("[data-testid='connect']").attributes("disabled"),
    ).toBeUndefined();
  });

  it("SAYS WHERE THE TOKEN COMES FROM", async () => {
    // Without this sentence the field is a dead end: nothing else on the screen
    // says the token is minted on the server rather than typed here.
    const page = render();
    await flushPromises();
    expect(page.text()).toMatch(/Compute Capsules/);
  });

  it("masks the token field and never renders it as page text", async () => {
    // ASSERTED HONESTLY. A controlled Vue input binds `:value`, so the string
    // IS in the element's value attribute while it is being typed — that is
    // true of every text field in every one of these apps and is not something
    // this component can change.
    //
    // What it CAN promise is the two things that matter: the field is masked,
    // so a screenshot or a shoulder does not carry it; and the token never
    // appears as rendered TEXT, which is what would survive into a bug report
    // or a DOM snapshot pasted into a chat.
    const page = render();
    await flushPromises();
    const field = page.find("[data-testid='token']");
    expect(field.attributes("type")).toBe("password");
    await field.setValue("capsule.sel.ver");
    expect(page.text()).not.toContain("capsule.sel.ver");
  });

  it("shows how the token is stored, so a memory session does not look permanent",
    async () => {
      __setStateForTests({
        connected: true, server: "https://z.test", username: "ada",
        storage: "memory",
      });
      vi.spyOn(workspace, "loadList").mockResolvedValue(undefined);
      const page = render();
      await flushPromises();
      expect(page.find("[data-testid='connected']").text()).toMatch(/memory/i);
    });

  it("never calls forgetting a token 'signing out'", async () => {
    __setStateForTests({ connected: true, server: "https://z.test", username: "ada" });
    vi.spyOn(workspace, "loadList").mockResolvedValue(undefined);
    const page = render();
    await flushPromises();
    const text = page.find("[data-testid='connected']").text().toLowerCase();
    expect(text).not.toContain("sign out");
    // …and it says the token stays valid, which is the part that matters.
    expect(text).toMatch(/revoke/);
  });
});

describe("the editor screen", () => {
  const WS = {
    slug: "notebook", name: "Notebook", kind: "python", namespace: "dracena",
    owner: "ada", writable: true, created_at: "", can_execute: true,
  };

  async function editing(overrides: Record<string, unknown> = {}) {
    __setStateForTests({ connected: true, server: "https://z.test", username: "ada" });
    vi.spyOn(workspace, "loadList").mockResolvedValue(undefined);
    const page = render();
    await flushPromises();
    workspace.__setStateForTests({
      current: { ...WS, ...overrides },
      items: [],
      buffers: [{
        pk: 7, name: "main.py", text: "print(1)\n", saved: "print(1)\n",
        truncated: false, readonly: false,
      }],
      activePk: 7,
    });
    await flushPromises();
    return page;
  }

  it("shows the editor once a buffer is open", async () => {
    const page = await editing();
    expect(page.find("[data-testid='code-editor-stub']").exists()).toBe(true);
    expect(page.find("[data-testid='output']").exists()).toBe(true);
  });

  it("A REFUSAL IS A SENTENCE, not just a dead button", async () => {
    // A disabled Save with no explanation is how somebody loses an afternoon
    // working out what is wrong.
    const page = await editing({ writable: false });
    const notice = page.find("[data-testid='save-refusal']");
    expect(notice.exists()).toBe(true);
    expect(notice.text().length).toBeGreaterThan(20);
    expect(page.find("[data-testid='save']").attributes("disabled")).toBeDefined();
  });

  it("badges a read-only workspace", async () => {
    const page = await editing({ writable: false });
    expect(page.find("[data-testid='readonly-badge']").exists()).toBe(true);
  });

  it("disables Run where the platform does not permit execution", async () => {
    // Gated separately from editing — see AMBROSIA_EXECUTION_ACCESS. Somebody
    // who may edit is not necessarily somebody who may spend the CPU.
    const page = await editing({ can_execute: false });
    expect(page.find("[data-testid='run']").attributes("disabled")).toBeDefined();
  });

  it("says where the compile happens, in the log rather than a tooltip", async () => {
    // NOT the Python app's sentence. "Variables do not carry over" answers a
    // question nobody asks about a compile — nothing was ever kept between
    // them. What a person needs to know here is that it runs on the server, in
    // their Capsule, which is why a build can be queued and slow.
    const page = await editing();
    expect(page.find("[data-testid='output']").text())
      .toMatch(/runs in your Capsule on the server/i);
  });

  it("prompts to open a file when none is open", async () => {
    __setStateForTests({ connected: true, server: "https://z.test" });
    vi.spyOn(workspace, "loadList").mockResolvedValue(undefined);
    const page = render();
    await flushPromises();
    workspace.__setStateForTests({
      current: WS, items: [], buffers: [], activePk: null,
    });
    await flushPromises();
    expect(page.find("[data-testid='no-file']").exists()).toBe(true);
  });
});
