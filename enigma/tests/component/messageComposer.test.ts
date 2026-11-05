// The message composer: short text only (Pharos sends no images, voice or
// files), what it lets you send, when, and what each send costs.
//
// Nothing may go out before the room's MLS session is ready, nothing while a
// captain has muted you, and nothing longer than the short-message limit. Every
// message travels over Tor; the rate chip follows the live MLS state.
//
// Runs in Tauri mode against the IPC hook, so every Privacy HP charge reaches a
// fake backend and the test can read exactly what was billed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import type { ChatChannel } from "rakotis";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;
vi.mock("../../src/stores/chat", () => ({ useChatStore: () => store }));

// The REAL Tauri API, faked at its IPC hook (see contactsView.test.ts for why
// not vi.mock). Loading it up front keeps its first dynamic import, which every
// charge goes through, out of the first test's timing.
import "@tauri-apps/api/core";
import { i18n } from "../../src/i18n";
import MessageComposer from "../../src/components/chat/MessageComposer.vue";
import EmojiPicker from "../../src/components/chat/EmojiPicker.vue";
import { stopHp } from "../../src/components/hp/useHp";

(i18n.global.locale as any).value = "en";

const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "hp_ledger") return [];
  if (cmd === "hp_charge") return { applied: -2, code: args?.actionId };
  return null;
});
const charges = () => invokeMock.mock.calls.filter((c) => c[0] === "hp_charge").map((c) => c[1]);

// A charge is several promise hops away from the click (the composer does not
// await its own send on Enter), so one flush is not always enough to see it land.
async function settle() {
  for (let i = 0; i < 10; i++) await flushPromises();
}


function makeChannel() {
  return {
    currentRoom: ref<{ slug: string; name: string } | null>({ slug: "room-1", name: "Room" }),
    isConnected: ref(true),
    isParticipant: ref(true),
    mlsStatus: ref("ready"),
    selfMuteUntil: ref<number | null>(null),
    sendMessage: vi.fn(),
  };
}
type Channel = ReturnType<typeof makeChannel>;

let pinia: Pinia;

function mountComposer(ch: Channel = makeChannel(), errorHandler?: (e: unknown) => void) {
  const w = mount(MessageComposer, {
    props: { channel: ch as unknown as ChatChannel },
    global: { plugins: [i18n, pinia], ...(errorHandler ? { config: { errorHandler } } : {}) },
  });
  return { w, ch };
}

const textarea = (w: ReturnType<typeof mount>) => w.get("textarea");
const sendButton = (w: ReturnType<typeof mount>) => w.findAll("button").find((b) => b.text() === "Send")!;
const emojiButton = (w: ReturnType<typeof mount>) => w.get('button[title="Emoji"]');

beforeEach(() => {
  invokeMock.mockClear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
  pinia = createPinia();
  setActivePinia(pinia);
  store = {};
  stopHp();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── the rate chip ───────────────────────────────────────────────────────────

describe("MessageComposer — the per-message rate", () => {
  it("is Free once the room is MLS over Tor", () => {
    const { w } = mountComposer();
    expect(w.get('[data-testid="hp-msg-free"]').text()).toBe("Free");
    expect(w.find('[data-testid="hp-msg-rate"]').exists()).toBe(false);
  });

  it("charges the cleartext fallback while MLS is still coming up", () => {
    const ch = makeChannel();
    ch.mlsStatus.value = "key_exchange";
    const { w } = mountComposer(ch);
    expect(w.get('[data-testid="hp-msg-rate"]').text()).toContain("−0.05 HP/msg");
  });
});

// ── what the box says, and when it is open ──────────────────────────────────

describe("MessageComposer — placeholder and gates", () => {
  it("asks for a room first when none is open", () => {
    const ch = makeChannel();
    ch.currentRoom.value = null;
    const { w } = mountComposer(ch);
    expect(textarea(w).attributes("placeholder")).toBe("Select a room to start chatting");
    expect(textarea(w).attributes("disabled")).toBeDefined();
    expect(emojiButton(w).attributes("disabled")).toBeDefined();
  });

  it("asks an observer to join before typing", () => {
    const ch = makeChannel();
    ch.isParticipant.value = false;
    const { w } = mountComposer(ch);
    expect(textarea(w).attributes("placeholder")).toBe("Join this room to send messages");
    expect(textarea(w).attributes("disabled")).toBeDefined();
  });

  it("says the session is being established until MLS is ready", () => {
    const ch = makeChannel();
    ch.mlsStatus.value = "initializing";
    const { w } = mountComposer(ch);
    expect(textarea(w).attributes("placeholder")).toBe("Establishing secure session…");
    expect(textarea(w).attributes("disabled")).toBeDefined();
  });

  it("locks with a countdown while the captain has muted you", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-03-01T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const ch = makeChannel();
    ch.selfMuteUntil.value = now + 10 * 60_000;
    const { w } = mountComposer(ch);
    expect(textarea(w).attributes("placeholder")).toBe("You are muted (10m left)");
    expect(textarea(w).attributes("disabled")).toBeDefined();
  });

  it("invites a message when everything is ready", () => {
    const { w } = mountComposer();
    expect(textarea(w).attributes("placeholder")).toBe("Message…");
    expect(textarea(w).attributes("disabled")).toBeUndefined();
  });

  it("offers no image, voice or file button: text only", () => {
    const { w } = mountComposer();
    expect(w.find('input[type="file"]').exists()).toBe(false);
    expect(w.find('button[title="Send image"]').exists()).toBe(false);
  });
});

// ── sending text ────────────────────────────────────────────────────────────

describe("MessageComposer — sending text", () => {
  it("sends the trimmed text on Enter, clears the box and bills it on the Tor lane", async () => {
    const { w, ch } = mountComposer();
    await textarea(w).setValue("  hello  ");
    await textarea(w).trigger("keydown", { key: "Enter" });
    await settle();
    expect(ch.sendMessage).toHaveBeenCalledWith("hello");
    expect((textarea(w).element as HTMLTextAreaElement).value).toBe("");
    expect(charges()).toEqual([{ actionId: "msg.tor.mls", bytes: 5, minutes: null }]);
  });

  it("counts bytes, not characters, when billing", async () => {
    const { w } = mountComposer();
    await textarea(w).setValue("żółw");
    await sendButton(w).trigger("click");
    await settle();
    expect(charges()).toEqual([{ actionId: "msg.tor.mls", bytes: 7, minutes: null }]);
  });

  it("shows the length, and refuses a message over the short-message limit", async () => {
    const { w, ch } = mountComposer();
    await textarea(w).setValue("x".repeat(1000));
    expect(w.get('[data-testid="msg-length"]').text()).toBe("1000 / 1000");
    expect(sendButton(w).attributes("disabled")).toBeUndefined();
    await textarea(w).setValue("x".repeat(1001));
    expect(w.get('[data-testid="msg-length"]').text()).toBe("1001 / 1000");
    expect(sendButton(w).attributes("disabled")).toBeDefined();
    await textarea(w).trigger("keydown", { key: "Enter" });
    await settle();
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it("counts characters as people see them, not UTF-16 units", async () => {
    const { w } = mountComposer();
    await textarea(w).setValue("😀".repeat(1000));
    expect(w.get('[data-testid="msg-length"]').text()).toBe("1000 / 1000");
    expect(sendButton(w).attributes("disabled")).toBeUndefined();
  });

  it("treats Shift+Enter as a new line, not a send", async () => {
    const { w, ch } = mountComposer();
    await textarea(w).setValue("line one");
    await textarea(w).trigger("keydown", { key: "Enter", shiftKey: true });
    await settle();
    expect(ch.sendMessage).not.toHaveBeenCalled();
    expect(charges()).toEqual([]);
  });

  it("refuses a blank message", async () => {
    const { w, ch } = mountComposer();
    await textarea(w).setValue("   ");
    expect(sendButton(w).attributes("disabled")).toBeDefined();
    await textarea(w).trigger("keydown", { key: "Enter" });
    await settle();
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to send while muted, even with text already typed", async () => {
    const { w, ch } = mountComposer();
    await textarea(w).setValue("typed before the mute");
    ch.selfMuteUntil.value = Date.now() + 60_000;
    await settle();
    expect(sendButton(w).attributes("disabled")).toBeDefined();
    await textarea(w).trigger("keydown", { key: "Enter" });
    await settle();
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to send before MLS is ready", async () => {
    const { w, ch } = mountComposer();
    await textarea(w).setValue("too early");
    ch.mlsStatus.value = "key_exchange";
    await settle();
    await textarea(w).trigger("keydown", { key: "Enter" });
    await settle();
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it("appends a picked emoji to what is already typed", async () => {
    const { w } = mountComposer();
    await textarea(w).setValue("hi ");
    await emojiButton(w).trigger("click");
    await w.findAll("button").find((b) => b.text() === "😀")!.trigger("click");
    expect((textarea(w).element as HTMLTextAreaElement).value).toBe("hi 😀");
    expect(sendButton(w).attributes("disabled")).toBeUndefined();
  });
});

describe("EmojiPicker", () => {
  const mountPicker = (props: { disabled?: boolean } = {}) =>
    mount(EmojiPicker, { props, global: { plugins: [i18n] } });
  const toggle = (w: ReturnType<typeof mount>) => w.get('button[title="Emoji"]');
  const emojiButtons = (w: ReturnType<typeof mount>) => w.findAll(".grid button");

  it("starts closed and opens on the faces tab", async () => {
    const w = mountPicker();
    expect(emojiButtons(w)).toHaveLength(0);
    await toggle(w).trigger("click");
    expect(emojiButtons(w)[0].text()).toBe("😀");
    expect(emojiButtons(w).map((b) => b.text())).not.toContain("🐶");
  });

  it("switches category on a tab", async () => {
    const w = mountPicker();
    await toggle(w).trigger("click");
    const animalsTab = w.findAll("button").find((b) => b.text() === "🐶" && !b.element.closest(".grid"))!;
    await animalsTab.trigger("click");
    expect(emojiButtons(w)[0].text()).toBe("🐶");
    expect(emojiButtons(w).map((b) => b.text())).not.toContain("😀");
  });

  it("emits the picked emoji and closes", async () => {
    const w = mountPicker();
    await toggle(w).trigger("click");
    await emojiButtons(w).find((b) => b.text() === "😎")!.trigger("click");
    expect(w.emitted("select")).toEqual([["😎"]]);
    expect(emojiButtons(w)).toHaveLength(0);
  });

  it("closes without picking when the backdrop is clicked", async () => {
    const w = mountPicker();
    await toggle(w).trigger("click");
    await w.get(".fixed.inset-0").trigger("click");
    expect(emojiButtons(w)).toHaveLength(0);
    expect(w.emitted("select")).toBeUndefined();
  });

  it("closes when its own button is clicked again", async () => {
    const w = mountPicker();
    await toggle(w).trigger("click");
    await toggle(w).trigger("click");
    expect(emojiButtons(w)).toHaveLength(0);
  });

  it("cannot be opened while disabled", async () => {
    const w = mountPicker({ disabled: true });
    expect(toggle(w).attributes("disabled")).toBeDefined();
    await toggle(w).trigger("click");
    expect(emojiButtons(w)).toHaveLength(0);
  });
});
