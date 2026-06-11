import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createTestingPinia } from "@pinia/testing";
import { i18n, setLocale } from "../../src/i18n";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock("euclid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("euclid")>();
  return { ...actual, getServerUrl: vi.fn(async () => "http://server.test") };
});
vi.mock("../../src/assets/logos", () => ({ logo2Dark: "dark", logo2Light: "light", appIcon: "icon" }));
vi.mock("../../src/services/api", () => ({
  api: { login: vi.fn(async () => {}), getMe: vi.fn(async () => ({})) },
}));

import LoginView from "../../src/views/EnigmaLoginView.vue";
import { OyaButton } from "euclid";
import { api } from "../../src/services/api";

function mountLogin() {
  return mount(LoginView, {
    props: { darkMode: true },
    global: { plugins: [i18n, createTestingPinia({ createSpy: vi.fn })] },
  });
}

beforeEach(() => {
  localStorage.clear();
  i18n.global.locale.value = "en";
  (api.login as ReturnType<typeof vi.fn>).mockClear();
  pushMock.mockClear();
});

describe("EnigmaLoginView (interface)", () => {
  it("renders the localized title and field labels", async () => {
    const w = mountLogin();
    await flushPromises();
    expect(w.text()).toContain("Sign in to Enigma");
    expect(w.text()).toContain("Username");
    expect(w.text()).toContain("Password");
    expect(w.text()).toContain("server.test");
  });

  it("renders the title in Polish when the locale is pl", async () => {
    setLocale("pl");
    const w = mountLogin();
    await flushPromises();
    expect(w.text()).toContain("Zaloguj się do Enigmy");
  });

  it("submits the entered credentials then navigates home", async () => {
    const w = mountLogin();
    await flushPromises();
    await w.get("#username").setValue("  alice  ");
    await w.get("#password").setValue("secret");
    await w.findComponent(OyaButton).trigger("click");
    await flushPromises();
    expect(api.login).toHaveBeenCalledWith("alice", "secret");
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("does not submit when fields are empty", async () => {
    const w = mountLogin();
    await flushPromises();
    await w.findComponent(OyaButton).trigger("click");
    await flushPromises();
    expect(api.login).not.toHaveBeenCalled();
  });

  it("shows an error and clears the password when login fails", async () => {
    (api.login as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Invalid credentials."));
    const w = mountLogin();
    await flushPromises();
    await w.get("#username").setValue("bob");
    await w.get("#password").setValue("wrong");
    await w.findComponent(OyaButton).trigger("click");
    await flushPromises();
    expect(w.text()).toContain("Invalid credentials.");
    expect((w.get("#password").element as HTMLInputElement).value).toBe("");
  });
});
