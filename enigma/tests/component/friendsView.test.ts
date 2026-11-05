import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { i18n } from "../../src/i18n";

const calls: [string, unknown][] = [];
const replies: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    calls.push([cmd, args]);
    const r = replies[cmd];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? (r as (a: unknown) => unknown)(args) : r;
  },
}));
const listeners: Record<string, (e: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners[name] = cb;
    return () => delete listeners[name];
  },
}));

import EnigmaFriendsView from "../../src/views/EnigmaFriendsView.vue";

const ME = { name: "Alice", fingerprint: "AAAA BBBB CCCC DDDD EEEE FFFF", id: "a1", proteus: null };
const BOB = { id: "b0", name: "Bob", fingerprint: "BBBB", proteus: null, last_seen_secs: null };

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(replies)) delete replies[k];
  replies.pharos_start = ME;
  replies.pharos_friends = [];
  replies.pharos_messages = [];
});

function view() {
  return mount(EnigmaFriendsView, { global: { plugins: [i18n], stubs: { QrScannerModal: true, OyaQrCode: true, OyaModal: { props: ["open"], template: '<div v-if="open"><slot /></div>' } } } });
}

describe("Friends", () => {
  it("starts the engine and shows who you are", async () => {
    const w = view();
    await flushPromises();
    expect(calls[0][0]).toBe("pharos_start");
    expect(w.get("[data-testid=me-name]").text()).toBe("Alice");
  });

  it("pairs from a pasted card and shows the reply when there is no Proteus", async () => {
    replies.pharos_card = "pharos-card:MINE";
    replies.pharos_scan = { friend: "b0", name: "Bob", reply: "pharos-reply:BACK" };
    const w = view();
    await flushPromises();
    await w.get("[data-testid=add-friend]").trigger("click");
    await flushPromises();
    replies.pharos_friends = [BOB];
    await w.get("[data-testid=paste] input, [data-testid=paste]").setValue("pharos-card:THEIRS");
    await w.get("[data-testid=use-paste]").trigger("click");
    await flushPromises();
    expect(calls.find(([c]) => c === "pharos_scan")?.[1]).toEqual({ text: "pharos-card:THEIRS" });
    expect(w.get("[data-testid=pair-note]").text()).toContain("Bob");
    expect(w.html()).toContain("pharos-reply:BACK");
    expect(w.find("[data-testid=friend-Bob]").exists()).toBe(true);
  });

  it("refuses text that is neither a card nor a reply", async () => {
    replies.pharos_card = "pharos-card:MINE";
    const w = view();
    await flushPromises();
    await w.get("[data-testid=add-friend]").trigger("click");
    await w.get("[data-testid=paste] input, [data-testid=paste]").setValue("hello");
    await w.get("[data-testid=use-paste]").trigger("click");
    await flushPromises();
    expect(w.get("[data-testid=pair-note]").text()).toBe(i18n.global.t("friends.notACard"));
    expect(calls.some(([c]) => c === "pharos_scan" || c === "pharos_accept")).toBe(false);
  });

  it("sends a short message, and shows statuses as they arrive", async () => {
    replies.pharos_friends = [BOB];
    replies.pharos_send = "m1";
    const w = view();
    await flushPromises();
    const box = w.get("[data-testid=compose] textarea, [data-testid=compose]");
    await box.setValue("x".repeat(1001));
    expect(w.get("[data-testid=send]").attributes("disabled")).toBeDefined();
    await box.setValue("hi Bob");
    await w.get("[data-testid=send]").trigger("click");
    await flushPromises();
    expect(calls.find(([c]) => c === "pharos_send")?.[1]).toEqual({ friend: "b0", text: "hi Bob" });
    listeners["pharos://message"]({ payload: { id: "m1", friend: "b0", text: "hi Bob", sent_ms: 0, status: "Queued" } });
    await flushPromises();
    expect(w.find("[data-testid=status-Queued]").exists()).toBe(true);
    listeners["pharos://status"]({ payload: { id: "m1", status: "Delivered" } });
    await flushPromises();
    expect(w.find("[data-testid=status-Delivered]").exists()).toBe(true);
  });

  it("on a phone, shows the list or one conversation, with a way back", async () => {
    replies.pharos_friends = [BOB];
    const w = view();
    await flushPromises();
    // The first friend is preselected for wide screens, but a phone starts on the list.
    expect(w.get("[data-testid=friends-list]").classes()).toContain("flex");
    expect(w.get("[data-testid=conversation]").classes()).toContain("hidden");
    await w.get("[data-testid=friend-Bob]").trigger("click");
    await flushPromises();
    expect(w.get("[data-testid=friends-list]").classes()).toContain("hidden");
    expect(w.get("[data-testid=conversation]").classes()).toContain("flex");
    await w.get("[data-testid=back]").trigger("click");
    expect(w.get("[data-testid=friends-list]").classes()).toContain("flex");
  });

  it("shows a start failure instead of a blank page", async () => {
    replies.pharos_start = new Error("tor bootstrap: no network");
    const w = view();
    await flushPromises();
    expect(w.get("[role=alert]").text()).toContain("no network");
  });
});
