import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import WorkspaceSearch from "../../src/files/WorkspaceSearch.vue";
import { i18n } from "../../src/i18n";
import { useSearchMode } from "../../src/files/searchSettings";
import { useWorkspace } from "petalite/files";

// The Rust walk is mocked at the Tauri boundary. What is under test is the
// box's own conduct: when it asks, what it asks, which answers it shows, and
// that nothing read from a body outlives that body's encryption.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const ROOT = "/home/u/work";

// A box left mounted from an earlier test would answer the shared algorithm
// setting too, and eat the mocked replies meant for the one under test.
enableAutoUnmount(afterEach);

function hit(name: string, extra: Partial<{ snippet: string; tags: string[]; matched: string[]; sealed: boolean; relPath: string }> = {}) {
  return {
    path: `${ROOT}/${extra.relPath ?? name}`, relPath: extra.relPath ?? name, name,
    tags: extra.tags ?? [], matched: extra.matched ?? ["name"], snippet: extra.snippet ?? "",
    score: 1, sealed: extra.sealed ?? false,
  };
}

function mountSearch(root = ROOT) {
  return mount(WorkspaceSearch, { props: { root }, global: { plugins: [i18n] } });
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  vi.useFakeTimers();
  localStorage.clear();
  useSearchMode().set("hybrid");
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the workspace search box", () => {
  it("asks once, after the typing pauses, with the query and the chosen algorithm", async () => {
    useSearchMode().set("quick");
    const w = mountSearch();
    const input = w.get('[data-testid="workspace-search"]');
    await input.setValue("n");
    await input.setValue("ne");
    await input.setValue("needle");
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("workspace_search", { query: "needle", mode: "quick" });
    // The panel was told a query is on screen.
    expect(w.emitted("update:active")?.at(-1)).toEqual([true]);
  });

  it("lists what came back — name, path, tags, how it matched, the line — and hands a hit up as a path", async () => {
    invoke.mockResolvedValue([
      hit("a.md", { snippet: "the needle is here", matched: ["name", "text"], tags: ["work", "q3"] }),
      hit("b.txt", { relPath: "sub/b.txt", matched: ["path"] }),
      hit("v.md", { sealed: true, matched: ["tag"], tags: ["needle"] }),
    ]);
    const w = mountSearch();
    await w.get('[data-testid="workspace-search"]').setValue("needle");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();

    expect(w.get('[data-testid="search-result-0"]').text()).toContain("a.md");
    expect(w.get('[data-testid="search-snippet-0"]').text()).toBe("the needle is here");
    expect(w.get('[data-testid="search-matched-0"]').text()).toBe("name · text");
    expect(w.get('[data-testid="search-result-0"]').text()).toContain("work");
    expect(w.get('[data-testid="search-result-1"]').text()).toContain("sub/b.txt");
    expect(w.get('[data-testid="search-matched-1"]').text()).toBe("path");
    // A sealed hit is drawn with a padlock and never a line of its body.
    expect(w.get('[data-testid="search-result-2"]').html()).toContain('icon="lock"');
    expect(w.find('[data-testid="search-snippet-2"]').exists()).toBe(false);

    await w.get('[data-testid="search-result-1"]').trigger("click");
    expect(w.emitted("open")?.[0][0]).toEqual({ path: `${ROOT}/sub/b.txt`, name: "b.txt" });
  });

  it("asks again when the algorithm changes, and when a file's encryption changes", async () => {
    const w = mountSearch();
    await w.get('[data-testid="workspace-search"]').setValue("x");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(1);

    useSearchMode().set("full");
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("workspace_search", { query: "x", mode: "full" });

    // Encrypting a file replaces the sealed map; a stale body line must go.
    invoke.mockResolvedValue([hit("s.md", { sealed: true, matched: ["name"] })]);
    const ws = useWorkspace();
    ws.sealed.value = new Map(ws.sealed.value).set(`${ROOT}/s.md`, true);
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(w.find('[data-testid="search-snippet-0"]').exists()).toBe(false);
  });

  it("drops an answer that arrives after a newer question", async () => {
    let releaseFirst: (hits: unknown[]) => void = () => {};
    invoke
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce([hit("fresh.md")]);
    const w = mountSearch();
    const input = w.get('[data-testid="workspace-search"]');
    await input.setValue("old");
    await vi.advanceTimersByTimeAsync(250);
    await input.setValue("new");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(w.get('[data-testid="search-result-0"]').text()).toContain("fresh.md");
    releaseFirst([hit("stale.md")]);
    await flushPromises();
    expect(w.find('[data-testid="workspace-search-results"]').text()).not.toContain("stale.md");
  });

  it("clears when emptied, says when nothing matches, shows a failure, and does nothing off the desktop", async () => {
    invoke.mockResolvedValue([hit("a.md")]);
    const w = mountSearch();
    const input = w.get('[data-testid="workspace-search"]');
    await input.setValue("a");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(w.find('[data-testid="workspace-search-results"]').exists()).toBe(true);
    await input.setValue("");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(w.find('[data-testid="workspace-search-results"]').exists()).toBe(false);
    expect(w.emitted("update:active")?.at(-1)).toEqual([false]);
    expect(invoke).toHaveBeenCalledTimes(1);

    invoke.mockResolvedValue([]);
    await input.setValue("zzz");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(w.find('[data-testid="workspace-search-empty"]').exists()).toBe(true);

    invoke.mockRejectedValue(new Error("no_workspace: choose a workspace folder first"));
    await input.setValue("y");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(w.get('[data-testid="workspace-search-error"]').text()).toBe("Search failed. Choose a workspace folder first.");

    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    invoke.mockClear();
    await input.setValue("z");
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(invoke).not.toHaveBeenCalled();
  });
});
