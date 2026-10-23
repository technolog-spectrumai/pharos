// The crypto bridge: every MLS operation is a `mls_*` Tauri command, and this
// module only marshals bytes across the IPC and decides what a failure means.
//
// Those decisions are the contract the chat channel is written against, so they
// are pinned here one by one. Most failures become a falsy value the channel can
// branch on ("no key package", "not added"). Two deliberately do NOT:
// `processMessage` must throw, because the channel reads the error text to tell a
// group-id mismatch (recoverable — ask to be re-added) from real corruption, and
// `clearState` must throw, because a reset that silently kept the old state would
// re-join the very group it was meant to leave.
//
// In a plain browser there is no Rust at all, and every call degrades without
// touching the IPC.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));

import { cryptoService, bytesToBase64, base64ToBytes } from "../../src/crypto";

const R = "room-1";
const ID = "alice";

beforeEach(() => {
  invoke.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

const inTauri = () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
};

describe("base64 helpers", () => {
  it("round-trip every byte value", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
  });

  it("match the standard encoding the wire uses", () => {
    expect(bytesToBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
    expect(base64ToBytes("CAk=")).toEqual(new Uint8Array([8, 9]));
  });
});

describe("in a plain browser", () => {
  it("degrades every operation without calling into Rust", async () => {
    const kp = new Uint8Array([1]);
    expect(await cryptoService.initSession(R, ID)).toBe(false);
    expect(await cryptoService.keyPackage(R, ID)).toBeNull();
    expect(await cryptoService.addMember(R, ID, kp)).toBeNull();
    expect(await cryptoService.joinFromWelcome(R, ID, kp)).toBe(false);
    expect(await cryptoService.processMessage(R, ID, kp)).toBeNull();
    expect(await cryptoService.encrypt(R, ID, "hi")).toBeNull();
    await expect(cryptoService.clearState(R, ID)).resolves.toBeUndefined();
    expect(await cryptoService.members(R, ID)).toEqual([]);
    expect(await cryptoService.removeMember(R, ID, "bob")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("in the Tauri app", () => {
  beforeEach(inTauri);

  it("opens a session for one identity in one room", async () => {
    invoke.mockResolvedValueOnce(true);
    expect(await cryptoService.initSession(R, ID)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("mls_init_session", { room: R, identity: ID });
  });

  it("returns a key package as bytes, or null when Rust cannot build one", async () => {
    invoke.mockResolvedValueOnce([1, 2, 3]);
    expect(await cryptoService.keyPackage(R, ID)).toEqual(new Uint8Array([1, 2, 3]));
    expect(invoke).toHaveBeenLastCalledWith("mls_key_package", { room: R, identity: ID });

    invoke.mockRejectedValueOnce("no session");
    expect(await cryptoService.keyPackage(R, ID)).toBeNull();
  });

  it("adds a member from a key package and splits the answer into Welcome and commit", async () => {
    invoke.mockResolvedValueOnce([[8], [9, 9]]);
    const out = await cryptoService.addMember(R, ID, new Uint8Array([1, 2, 3]));
    // The IPC carries plain arrays, not typed arrays.
    expect(invoke).toHaveBeenCalledWith("mls_add_member", { room: R, identity: ID, keyPackage: [1, 2, 3] });
    expect(out).toEqual({ welcome: new Uint8Array([8]), commit: new Uint8Array([9, 9]) });

    invoke.mockRejectedValueOnce(new Error("bad key package"));
    expect(await cryptoService.addMember(R, ID, new Uint8Array([0]))).toBeNull();
  });

  it("re-files a scratch session under the room an invitation named", async () => {
    invoke.mockResolvedValueOnce(undefined);
    expect(await cryptoService.adoptSession("invite:x", R, ID)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("mls_adopt_session", { fromRoom: "invite:x", toRoom: R, identity: ID });

    invoke.mockRejectedValueOnce("no such session");
    expect(await cryptoService.adoptSession("invite:x", R, ID)).toBe(false);
  });

  it("joins from a Welcome, reporting success as a boolean", async () => {
    invoke.mockResolvedValueOnce(undefined);
    expect(await cryptoService.joinFromWelcome(R, ID, new Uint8Array([8, 9]))).toBe(true);
    expect(invoke).toHaveBeenCalledWith("mls_join_from_welcome", { room: R, identity: ID, welcome: [8, 9] });

    invoke.mockRejectedValueOnce("welcome not for us");
    expect(await cryptoService.joinFromWelcome(R, ID, new Uint8Array([8]))).toBe(false);
  });

  it("returns decrypted bytes, or null for a frame with no application payload", async () => {
    invoke.mockResolvedValueOnce([104, 105]);
    expect(await cryptoService.processMessage(R, ID, new Uint8Array([7]))).toEqual(new Uint8Array([104, 105]));
    expect(invoke).toHaveBeenCalledWith("mls_process_message", { room: R, identity: ID, bytes: [7] });

    invoke.mockResolvedValueOnce(null);
    expect(await cryptoService.processMessage(R, ID, new Uint8Array([7]))).toBeNull();
  });

  it("lets a processing error reach the caller, text intact", async () => {
    invoke.mockRejectedValueOnce(new Error("group id differs"));
    await expect(cryptoService.processMessage(R, ID, new Uint8Array([7]))).rejects.toThrow("group id differs");
  });

  it("encrypts the UTF-8 bytes of the plaintext", async () => {
    invoke.mockResolvedValueOnce([42]);
    expect(await cryptoService.encrypt(R, ID, "zó")).toEqual(new Uint8Array([42]));
    expect(invoke).toHaveBeenCalledWith("mls_encrypt", { room: R, identity: ID, plaintext: [0x7a, 0xc3, 0xb3] });

    invoke.mockRejectedValueOnce("not a member");
    expect(await cryptoService.encrypt(R, ID, "x")).toBeNull();
  });

  it("clears a session, and lets a failed clear surface", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await cryptoService.clearState(R, ID);
    expect(invoke).toHaveBeenCalledWith("mls_clear_state", { room: R, identity: ID });

    invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(cryptoService.clearState(R, ID)).rejects.toThrow("disk full");
  });

  it("lists the authenticated members, or none when the group cannot be read", async () => {
    invoke.mockResolvedValueOnce(["alice", "bob"]);
    expect(await cryptoService.members(R, ID)).toEqual(["alice", "bob"]);
    expect(invoke).toHaveBeenCalledWith("mls_members", { room: R, identity: ID });

    invoke.mockRejectedValueOnce("no group");
    expect(await cryptoService.members(R, ID)).toEqual([]);
  });

  it("removes a member and returns the commit to broadcast, or null", async () => {
    invoke.mockResolvedValueOnce([5, 6]);
    expect(await cryptoService.removeMember(R, ID, "bob")).toEqual(new Uint8Array([5, 6]));
    expect(invoke).toHaveBeenCalledWith("mls_remove_member", { room: R, identity: ID, target: "bob" });

    invoke.mockRejectedValueOnce("not admin");
    expect(await cryptoService.removeMember(R, ID, "bob")).toBeNull();
  });
});
