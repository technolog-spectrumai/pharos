import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises } from "@vue/test-utils";

// The invite recipient picker (cloud.md): faros has no user directory, so each
// typed username is validated on its own against aster_resolve. These tests pin
// the four outcomes and the "you cannot send to nobody" gating.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useRecipientPicker } from "../../src/components/cloud/useRecipientPicker";

const MY_ID = "mynode";

function picker(canResolve = true) {
  return useRecipientPicker({
    serverUrl: () => "https://localhost:8443",
    myNodeId: () => MY_ID,
    canResolve: () => canResolve,
    max: 3,
  });
}

/** rakotis' `invoke` awaits a lazy `import()` before touching the mock, so a
 *  single flush can leave concurrent resolves mid-flight. Settle until the
 *  picker says it is idle. */
async function settle(p: { busy: { value: boolean } }): Promise<void> {
  for (let i = 0; i < 20 && p.busy.value; i++) await flushPromises();
  await flushPromises();
}

beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

describe("useRecipientPicker", () => {
  it("commits a draft on Enter and splits a pasted list", async () => {
    invokeMock.mockResolvedValue(["peer1"]);
    const p = picker();
    p.draft.value = "alice, bob";
    p.commitDraft();
    await settle(p);
    expect(p.recipients.value.map((r) => r.username)).toEqual(["alice", "bob"]);
    expect(p.draft.value).toBe("");
    // A pasted list resolves every chip — none may be left hanging.
    expect(p.recipients.value.map((r) => r.state)).toEqual(["ok", "ok"]);
  });

  it("folds case-insensitive duplicates and blank input", async () => {
    invokeMock.mockResolvedValue(["peer1"]);
    const p = picker();
    p.add("Alice");
    p.add(" alice ");
    p.add("");
    await settle(p);
    expect(p.recipients.value).toHaveLength(1);
    expect(p.recipients.value[0]!.username).toBe("Alice");
  });

  it("maps the four resolve outcomes", async () => {
    const p = picker();
    // Keyed by username: the picker queues resolves, so the mock is reached one
    // call at a time regardless of how fast the chips are added.
    invokeMock.mockImplementation(async (_cmd: string, args: { username: string }) => {
      if (args.username === "ghost") return []; // no account / never registered
      if (args.username === "me") return [MY_ID]; // only our own device
      return [MY_ID, "peer1"]; // ours filtered out
    });
    p.add("ghost");
    p.add("me");
    p.add("alice");
    await settle(p);
    const byName = (n: string) => p.recipients.value.find((r) => r.username === n)!;
    expect(byName("ghost").state).toBe("unknown");
    expect(byName("me").state).toBe("self");
    expect(byName("alice").state).toBe("ok");
    expect(byName("alice").nodeIds).toEqual(["peer1"]);
  });

  it("surfaces a resolve failure and can retry it", async () => {
    const p = picker();
    invokeMock.mockRejectedValueOnce("server unreachable");
    p.add("alice");
    await settle(p);
    expect(p.recipients.value[0]!.state).toBe("error");
    expect(p.recipients.value[0]!.error).toBe("server unreachable");
    invokeMock.mockResolvedValueOnce(["peer1"]);
    p.retry("alice");
    await settle(p);
    expect(p.recipients.value[0]!.state).toBe("ok");
  });

  it("gates sending: never with zero ok chips, never mid-resolve", async () => {
    const p = picker();
    expect(p.canSend.value).toBe(false);
    let release!: (v: string[]) => void;
    invokeMock.mockReturnValueOnce(new Promise<string[]>((r) => { release = r; }));
    p.add("alice");
    expect(p.busy.value).toBe(true);
    expect(p.canSend.value).toBe(false);
    release(["peer1"]);
    await settle(p);
    expect(p.canSend.value).toBe(true);

    invokeMock.mockResolvedValueOnce([]);
    p.add("ghost");
    await settle(p);
    // An unknown chip does not block a send to the ones that did resolve.
    expect(p.canSend.value).toBe(true);
    p.remove("alice");
    expect(p.canSend.value).toBe(false);
  });

  it("stops at the cap and drops a chip removed mid-flight", async () => {
    const p = picker();
    invokeMock.mockResolvedValue(["peer1"]);
    p.add("a"); p.add("b"); p.add("c");
    await settle(p);
    expect(p.atMax.value).toBe(true);
    p.add("d");
    expect(p.recipients.value).toHaveLength(3);

    // A late response for a removed chip must not resurrect it.
    let release!: (v: string[]) => void;
    invokeMock.mockReturnValueOnce(new Promise<string[]>((r) => { release = r; }));
    p.remove("a");
    p.add("late");
    p.remove("late");
    release(["peer1"]);
    await settle(p);
    expect(p.recipients.value.map((r) => r.username)).toEqual(["b", "c"]);
  });

  it("keepOnly retains order for the retry-failed flow", async () => {
    const p = picker();
    invokeMock.mockResolvedValue(["peer1"]);
    p.add("a"); p.add("b"); p.add("c");
    await settle(p);
    p.keepOnly(["C", "a"]);
    expect(p.recipients.value.map((r) => r.username)).toEqual(["a", "c"]);
  });

  it("marks chips as errored instead of resolving when signed out", async () => {
    const p = picker(false);
    p.add("alice");
    await settle(p);
    expect(p.recipients.value[0]!.state).toBe("error");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
