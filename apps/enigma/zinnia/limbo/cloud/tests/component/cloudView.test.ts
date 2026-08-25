import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import CloudView from "../../src/views/CloudView.vue";
import { i18n } from "../../src/i18n";

// The Tauri branch, exercised the way rakotis does it: pretend to be the
// desktop app and mock the command channel. Everything the view does that
// matters — refusing to offer credentials to an unverified server, clearing the
// password, never seeing a token — happens on this side of that boundary.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const FP = "A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:"
  + "A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90";

function mountCloud() {
  return mount(CloudView, { global: { plugins: [i18n], stubs: { teleport: true } } });
}

beforeEach(async () => {
  localStorage.clear();
  invoke.mockReset();
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  // The module-level session ref outlives a component, so reset it explicitly.
  const { useCloud } = await import("../../src/cloud/useCloud");
  const cloud = useCloud();
  cloud.setSettings({ server: "", fingerprint: "" });
  cloud.signedIn.value = false;
  cloud.username.value = "";
  cloud.pending.value = null;
  cloud.error.value = "";
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("CloudView", () => {
  it("asks for nothing until a server has been checked", async () => {
    // Credentials are not offered to an address nobody has looked at yet.
    const w = mountCloud();
    await flushPromises();
    expect(w.find('[data-testid="cloud-address"]').exists()).toBe(true);
    expect(w.find('[data-testid="cloud-password"]').exists()).toBe(false);
    expect(w.find('[data-testid="cloud-signin"]').exists()).toBe(false);
  });

  describe("an untrusted certificate", () => {
    beforeEach(() => {
      invoke.mockResolvedValue({
        reachable: true, tls: "untrusted", fingerprint: FP, reason: null,
      });
    });

    it("shows the fingerprint and withholds the password field", async () => {
      // The decision comes FIRST. A checkbox beside the password invites
      // clicking past it; a step that has to be answered does not.
      const w = mountCloud();
      await w.get('[data-testid="cloud-address"]').setValue("https://s.test");
      await w.get('[data-testid="cloud-check"]').trigger("click");
      await flushPromises();

      expect(w.get('[data-testid="cloud-untrusted"]').exists()).toBe(true);
      expect(w.get('[data-testid="cloud-fingerprint"]').text()).toBe(FP);
      expect(w.find('[data-testid="cloud-password"]').exists()).toBe(false);
      expect(w.find('[data-testid="cloud-signin"]').exists()).toBe(false);
    });

    it("offers the credentials once the certificate is accepted", async () => {
      const w = mountCloud();
      await w.get('[data-testid="cloud-address"]').setValue("https://s.test");
      await w.get('[data-testid="cloud-check"]').trigger("click");
      await flushPromises();

      await w.get('[data-testid="cloud-trust"]').trigger("click");
      await flushPromises();

      expect(w.find('[data-testid="cloud-untrusted"]').exists()).toBe(false);
      expect(w.find('[data-testid="cloud-password"]').exists()).toBe(true);
      // …and the acceptance is recorded, so it survives a restart.
      expect(JSON.parse(localStorage.getItem("zinnia:cloud")!).fingerprint).toBe(FP);
    });

    it("sends the accepted fingerprint with the login", async () => {
      const w = mountCloud();
      await w.get('[data-testid="cloud-address"]').setValue("https://s.test");
      await w.get('[data-testid="cloud-check"]').trigger("click");
      await flushPromises();
      await w.get('[data-testid="cloud-trust"]').trigger("click");
      await flushPromises();

      invoke.mockResolvedValue({
        signed_in: true, username: "ada", server: "https://s.test", storage: "keychain",
      });
      await w.get('[data-testid="cloud-user"]').setValue("ada");
      await w.get('[data-testid="cloud-password"]').setValue("hunter2");
      await w.get('[data-testid="cloud-form"]').trigger("submit");
      await flushPromises();

      const [cmd, args] = invoke.mock.calls.at(-1)!;
      expect(cmd).toBe("cloud_login");
      expect((args as Record<string, unknown>).fingerprint).toBe(FP);
    });
  });

  it("goes straight to the credentials for a trusted server", async () => {
    invoke.mockResolvedValue({ reachable: true, tls: "trusted", fingerprint: FP, reason: null });
    const w = mountCloud();
    await w.get('[data-testid="cloud-address"]').setValue("https://good.test");
    await w.get('[data-testid="cloud-check"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-testid="cloud-untrusted"]').exists()).toBe(false);
    expect(w.find('[data-testid="cloud-password"]').exists()).toBe(true);
    // No pin is kept: a server that verifies normally needs none, and a stale
    // one would leave a weaker rule in place than the situation calls for.
    expect(JSON.parse(localStorage.getItem("zinnia:cloud")!).fingerprint).toBe("");
  });

  it("clears the password whether the login succeeded or not", async () => {
    invoke.mockResolvedValueOnce({ reachable: true, tls: "trusted", fingerprint: null, reason: null });
    const w = mountCloud();
    await w.get('[data-testid="cloud-address"]').setValue("https://good.test");
    await w.get('[data-testid="cloud-check"]').trigger("click");
    await flushPromises();

    invoke.mockRejectedValueOnce("bad_credentials: nope");
    await w.get('[data-testid="cloud-user"]').setValue("ada");
    await w.get('[data-testid="cloud-password"]').setValue("wrong");
    await w.get('[data-testid="cloud-form"]').trigger("submit");
    await flushPromises();

    // A rejected attempt leaves a password sitting in the field for whoever is
    // at the keyboard next, exactly as a successful one would.
    expect((w.get('[data-testid="cloud-password"]').element as HTMLInputElement).value).toBe("");
    expect(w.get('[data-testid="cloud-error"]').text()).toBe("That username and password did not match.");
  });

  it("shows the session and never a token once signed in", async () => {
    invoke.mockResolvedValueOnce({ reachable: true, tls: "trusted", fingerprint: null, reason: null });
    const w = mountCloud();
    await w.get('[data-testid="cloud-address"]').setValue("https://good.test");
    await w.get('[data-testid="cloud-check"]').trigger("click");
    await flushPromises();

    invoke.mockResolvedValueOnce({
      signed_in: true, username: "ada", server: "https://good.test", storage: "keychain",
    });
    await w.get('[data-testid="cloud-user"]').setValue("ada");
    await w.get('[data-testid="cloud-password"]').setValue("hunter2");
    await w.get('[data-testid="cloud-form"]').trigger("submit");
    await flushPromises();

    expect(w.get('[data-testid="cloud-username"]').text()).toBe("ada");
    expect(w.get('[data-testid="cloud-server"]').text()).toBe("https://good.test");
    expect(localStorage.getItem("zinnia:cloud")).not.toMatch(/token|hunter2/i);
    expect(w.find('[data-testid="cloud-memory-only"]').exists()).toBe(false);
  });

  it("says so when the session will not survive a restart", async () => {
    // A memory-only session must not look like a stored one — that is the
    // whole reason the fallback reports itself instead of failing quietly.
    invoke.mockResolvedValueOnce({ reachable: true, tls: "trusted", fingerprint: null, reason: null });
    const w = mountCloud();
    await w.get('[data-testid="cloud-address"]').setValue("https://good.test");
    await w.get('[data-testid="cloud-check"]').trigger("click");
    await flushPromises();

    invoke.mockResolvedValueOnce({
      signed_in: true, username: "ada", server: "https://good.test", storage: "memory",
    });
    await w.get('[data-testid="cloud-user"]').setValue("ada");
    await w.get('[data-testid="cloud-password"]').setValue("hunter2");
    await w.get('[data-testid="cloud-form"]').trigger("submit");
    await flushPromises();

    expect(w.get('[data-testid="cloud-memory-only"]').exists()).toBe(true);
  });

  it("reports an http:// address without asking the server", async () => {
    invoke.mockRejectedValue("insecure_scheme: the address must start with https://");
    const w = mountCloud();
    await w.get('[data-testid="cloud-address"]').setValue("http://s.test");
    await w.get('[data-testid="cloud-check"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-testid="cloud-error"]').text()).toContain("https://");
  });

  it("signs out and forgets the session", async () => {
    const { useCloud } = await import("../../src/cloud/useCloud");
    const cloud = useCloud();
    cloud.setSettings({ server: "https://good.test", fingerprint: "" });
    cloud.signedIn.value = true;
    cloud.username.value = "ada";

    // The view refreshes on mount, so cloud_status has to answer first —
    // otherwise the mount itself resets the session this test just set up.
    invoke.mockResolvedValueOnce({
      signed_in: true, username: "ada", server: "https://good.test", storage: "keychain",
    });
    const w = mountCloud();
    await flushPromises();
    expect(w.get('[data-testid="cloud-username"]').text()).toBe("ada");

    invoke.mockResolvedValueOnce(undefined);
    await w.get('[data-testid="cloud-signout"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-testid="cloud-session"]').exists()).toBe(false);
    expect(w.find('[data-testid="cloud-form"]').exists()).toBe(true);
  });
});
