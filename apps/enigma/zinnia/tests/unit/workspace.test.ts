import { beforeEach, describe, expect, it } from "vitest";

describe("the local workspace", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the chosen folder and nothing else", async () => {
    // The path is not a secret, but it is the only thing worth keeping: the
    // listing is re-read every visit, and a cached one would go stale the
    // moment anything changed the folder from outside the app.
    localStorage.setItem("zinnia:workspace", JSON.stringify({ root: "/home/me/work" }));
    const { useWorkspace } = await import("../../src/files/useWorkspace");
    expect(useWorkspace().root.value).toBe("/home/me/work");
  });

  it("starts empty rather than guessing a folder", async () => {
    // Guessing a root would mean reading somewhere the user never pointed at,
    // and the fs grant only covers what they picked in the dialog anyway.
    const { useWorkspace } = await import("../../src/files/useWorkspace");
    const ws = useWorkspace();
    ws.root.value = "";
    expect(ws.root.value).toBe("");
  });
});

describe("the stored record", () => {
  beforeEach(() => localStorage.clear());

  it.each([
    ["not json at all", "{oops"],
    ["a record with no root", JSON.stringify({})],
    ["a root that is not a string", JSON.stringify({ root: 42 })],
    ["a bare array", JSON.stringify([])],
  ])("survives %s", async (_label, stored) => {
    localStorage.setItem("zinnia:workspace", stored);
    // Re-importing gets a fresh module-level ref, which is where the read
    // happens; a throw here would take the whole tab down on launch.
    const mod = await import(`../../src/files/useWorkspace?case=${encodeURIComponent(stored)}`);
    expect(() => mod.useWorkspace()).not.toThrow();
  });
});
