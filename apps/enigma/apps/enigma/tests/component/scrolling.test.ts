import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { initBuildConfig } from "rakotis";

// Every view must stay reachable: content longer than the window has to scroll,
// not disappear under the footer. jsdom has no layout engine, so what these
// tests pin down is the STRUCTURE that permits scrolling — which box owns the
// viewport height, which box may overflow, and which single box is the scroller.
//
// The shape the app commits to:
//   shell   h-[100dvh] + overflow-hidden   (dynamic viewport: Android's URL bar)
//   header  auto
//   main    flex-1 + min-h-0 + overflow-y-auto   ← THE scroller
//   footer  auto
// `min-h-0` is the load-bearing half: a flex child's automatic minimum size is
// its content, so without it <main> grows past the shell and never scrolls.
// Views that own their scrolling (the chat log, the file panels) fill main with `h-full`
// and keep it inside — never with a hard-coded `100vh - 8rem` guess.

const fileShare = { state: ref("idle") };
const vox = { phase: ref("idle") };
const invites = { incoming: ref(false) };
const meetings = { attentionCount: ref(0) };

vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({
    syncRuntimeIdentity: vi.fn(),
    init: vi.fn(),
    p2p: { currentUserName: ref(""), myAvatar: ref("") },
    fileShare,
    vox,
    invites,
    meetings,
  }),
}));

import App from "../../src/App.vue";
import EnigmaChatView from "../../src/views/EnigmaChatView.vue";
import EnigmaFilesView from "../../src/views/EnigmaFilesView.vue";
import EnigmaVoxView from "../../src/views/EnigmaVoxView.vue";
import MessageList from "../../src/components/chat/MessageList.vue";
import router from "../../src/router";
import { i18n } from "../../src/i18n";
import { loadTabVisibility } from "../../src/tabs";

(i18n.global.locale as any).value = "en";

// layout; off here so the mount stays about the shell (mirrors tabVisibility).
afterAll(async () => {
});

let pinia: ReturnType<typeof createPinia>;

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  await loadTabVisibility();
});

/** Utilities that let a box scroll its own overflow. */
const SCROLLS = ["overflow-y-auto", "overflow-auto", "overflow-y-scroll"];
const scrolls = (el: Element) => [...el.classList].some((c) => SCROLLS.includes(c));

/** A height pinned to the STATIC viewport — the class of bug this file guards:
 *  on Android the URL bar eats part of `100vh`, so the last rows sit below the
 *  fold with no way to reach them. */
const staticViewportHeight = (el: Element) =>
  [...el.classList].some((c) => c.includes("100vh") || c === "h-screen" || c === "min-h-screen");

/** App on a real route, with the routed view really rendered (not stubbed):
 *  the point of the test is what happens to a LONG view inside the shell. */
async function mountAppAt(path: string) {
  await router.replace(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [i18n, pinia, router] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe("the app shell", () => {
  it("is a fixed-height column measured against the dynamic viewport", async () => {
    const wrapper = await mountAppAt("/config");
    const shell = wrapper.element as HTMLElement;

    expect(shell.classList.contains("h-[100dvh]")).toBe(true);
    expect(shell.classList.contains("flex")).toBe(true);
    expect(shell.classList.contains("flex-col")).toBe(true);
    // The shell itself never scrolls (and never grows): main does.
    expect(shell.classList.contains("overflow-hidden")).toBe(true);
    expect(staticViewportHeight(shell)).toBe(false);
  });

  it("makes <main> the scroller, and gives it permission to shrink", async () => {
    const wrapper = await mountAppAt("/config");
    const main = wrapper.get("main");

    expect(main.classes()).toEqual(expect.arrayContaining(["flex-1", "min-h-0", "overflow-y-auto"]));
  });

  it("leaves a long view free to overflow — main is the ONLY scroller above it", async () => {
    const wrapper = await mountAppAt("/config");
    const main = wrapper.get("main").element as HTMLElement;
    const view = main.firstElementChild as HTMLElement;

    // Settings is the longest view in the app; make sure this really is the
    // "long view" case and not an empty shell.
    expect(view).not.toBeNull();
    expect(view.querySelectorAll("section").length).toBeGreaterThan(3);

    // The view neither clips its own content nor pins itself to the viewport…
    expect(view.classList.contains("overflow-hidden")).toBe(false);
    expect(staticViewportHeight(view)).toBe(false);

    // …and walking from the view up to the shell, exactly one box scrolls: main.
    const scrollers: string[] = [];
    for (let el: HTMLElement | null = view; el && el !== document.body; el = el.parentElement) {
      if (scrolls(el)) scrollers.push(el.tagName.toLowerCase());
    }
    expect(scrollers).toEqual(["main"]);
  });

  it("keeps the footer inside the shell instead of below the fold", async () => {
    const wrapper = await mountAppAt("/config");
    const shell = wrapper.element as HTMLElement;
    const kids = [...shell.children].map((c) => c.tagName.toLowerCase());
    expect(kids).toEqual(expect.arrayContaining(["header", "main", "footer"]));
    expect(kids.indexOf("footer")).toBeGreaterThan(kids.indexOf("main"));
  });
});

describe("the views that fill the pane", () => {
  // Chat / Files / Calls hand their scrolling to a panel inside them, so
  // they must be exactly as tall as <main> — `h-full`, never a `100vh - 8rem`
  // guess at the chrome's height (wrong on desktop, badly wrong on Android).
  const stubs = {
    ChatPanel: true,
    FilePanel: true,
    KeyringPanel: true,
    LocalPanel: true,
    VoxPanel: true,
  };
  const views = [
    ["chat", EnigmaChatView],
    ["files", EnigmaFilesView],
    ["vox", EnigmaVoxView],
  ] as const;

  for (const [name, view] of views) {
    it(`${name} fills main exactly, with no hard-coded viewport height`, async () => {
      const wrapper = mount(view, {
        props: { darkMode: true },
        global: { plugins: [i18n, pinia], stubs },
      });
      await flushPromises();

      expect(wrapper.classes(), name).toEqual(expect.arrayContaining(["h-full", "min-h-0"]));
      expect(staticViewportHeight(wrapper.element), name).toBe(false);
    });
  }

  it("gives the Files pane a flex column, so its panels can scroll themselves", async () => {
    const wrapper = mount(EnigmaFilesView, {
      props: { darkMode: true },
      global: { plugins: [i18n, pinia], stubs },
    });
    await flushPromises();

    // A display:block wrapper silently ignores a panel's `flex-1 min-h-0
    // overflow-y-auto` — the panel then outgrows the pane and gets clipped by
    // the view's `overflow-hidden`.
    const panel = wrapper.find("file-panel-stub").element.parentElement as HTMLElement;
    expect([...panel.classList]).toEqual(expect.arrayContaining(["flex", "flex-col", "min-h-0"]));
  });
});

describe("the panels that own their scrolling", () => {
  it("keeps the chat log scrolling inside itself", () => {
    const channel = { currentRoom: ref(null), messages: ref([]) };
    const wrapper = mount(MessageList, {
      props: { channel: channel as any },
      global: { plugins: [i18n] },
    });
    // The message log is deliberately its own scroller inside the chat grid:
    // `min-h-0` so the grid row may shrink, `overflow-y-auto` so it scrolls.
    expect(wrapper.classes()).toEqual(expect.arrayContaining(["min-h-0", "overflow-y-auto"]));
  });
});
