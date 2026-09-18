import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import NotesSearch from "../../src/files/NotesSearch.vue";
import { i18n } from "../../src/i18n";

// The Rust walk is mocked at the Tauri boundary. What is under test is the
// box's own conduct: when it asks, what it asks, and which answers it shows.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const ROOT = "/home/u/notes";

function hit(name: string, snippet = "") {
  return { path: `${ROOT}/${name}`, rel_path: name, name, snippet };
}

function mountSearch(root = ROOT) {
  return mount(NotesSearch, { props: { root }, global: { plugins: [i18n] } });
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  vi.useFakeTimers();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the notes search box", () => {
  it("asks once, after the typing pauses, with the root and the query", async () => {
    const w = mountSearch();
    const input = w.get('[data-testid="notes-search"]');
    await input.setValue("n");
    await input.setValue("ne");
    await input.setValue("needle");
    // Three keystrokes inside the window are one question, not three.
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("notes_search", { root: ROOT, query: "needle" });
  });

  it("lists what came back and hands a chosen hit up as a path", async () => {
    invoke.mockResolvedValue([hit("a.md", "the needle is here"), hit("sub/b.txt")]);
    const w = mountSearch();
    await w.get('[data-testid="notes-search"]').setValue("needle");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();

    expect(w.get('[data-testid="notes-result-0"]').text()).toContain("a.md");
    expect(w.get('[data-testid="notes-result-0"]').text()).toContain("the needle is here");
    expect(w.get('[data-testid="notes-result-1"]').text()).toContain("sub/b.txt");

    await w.get('[data-testid="notes-result-1"]').trigger("click");
    expect(w.emitted("open")?.[0][0]).toEqual({ path: `${ROOT}/sub/b.txt`, name: "sub/b.txt" });
  });

  it("says so when nothing matches, and says nothing before a search", async () => {
    const w = mountSearch();
    expect(w.find('[data-testid="notes-search-empty"]').exists()).toBe(false);
    await w.get('[data-testid="notes-search"]').setValue("zzz");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(w.find('[data-testid="notes-search-empty"]').exists()).toBe(true);
  });

  it("drops an answer that arrives after a newer question", async () => {
    // The first search is slow; the second is fast. The slow answer lands
    // last and must not replace the list the user is looking at.
    let releaseFirst: (hits: unknown[]) => void = () => {};
    invoke
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce([hit("fresh.md")]);
    const w = mountSearch();
    const input = w.get('[data-testid="notes-search"]');

    await input.setValue("old");
    await vi.advanceTimersByTimeAsync(250);
    await input.setValue("new");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(w.get('[data-testid="notes-result-0"]').text()).toContain("fresh.md");

    releaseFirst([hit("stale.md")]);
    await flushPromises();
    expect(w.find('[data-testid="notes-results"]').text()).toContain("fresh.md");
    expect(w.find('[data-testid="notes-results"]').text()).not.toContain("stale.md");
  });

  it("clears the list when the box is emptied, without asking again", async () => {
    invoke.mockResolvedValue([hit("a.md")]);
    const w = mountSearch();
    const input = w.get('[data-testid="notes-search"]');
    await input.setValue("a");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(w.find('[data-testid="notes-results"]').exists()).toBe(true);

    await input.setValue("");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(w.find('[data-testid="notes-results"]').exists()).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shows a failure as a sentence and keeps no stale rows", async () => {
    invoke.mockRejectedValue(new Error("root: no such folder"));
    const w = mountSearch();
    await w.get('[data-testid="notes-search"]').setValue("x");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(w.get('[data-testid="notes-search-error"]').text()).toContain("no such folder");
    expect(w.find('[data-testid="notes-results"]').exists()).toBe(false);
  });

  it("does nothing off the desktop, where there is no folder to walk", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const w = mountSearch();
    await w.get('[data-testid="notes-search"]').setValue("x");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(invoke).not.toHaveBeenCalled();
  });
});
