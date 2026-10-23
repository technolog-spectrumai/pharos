// The message composer: what it lets you send, when, and what each send costs.
//
// The composer is the one place a user types something that leaves the device,
// so its gates matter more than its looks: nothing may go out before the room's
// MLS session is ready, nothing while a captain has muted you, and an attachment
// is billed by its size because on a clearnet lane a 4 MiB voice note is a far
// more distinctive event than a line of text. The rate chip above it is the one
// price in the app that moves under you, and it has to follow the live Tor and
// MLS state rather than a value sampled at mount.
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
import VoiceRecorderButton from "../../src/components/chat/VoiceRecorderButton.vue";
import EmojiPicker from "../../src/components/chat/EmojiPicker.vue";
import { useNetworkStore } from "../../src/stores/network";
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

let urlSeq = 0;
const createObjectURL = vi.fn((_b: Blob) => `blob:test/${++urlSeq}`);
const revokeObjectURL = vi.fn((_u: string) => {});

function makeChannel() {
  return {
    currentRoom: ref<{ slug: string; name: string } | null>({ slug: "room-1", name: "Room" }),
    isConnected: ref(true),
    isParticipant: ref(true),
    mlsStatus: ref("ready"),
    selfMuteUntil: ref<number | null>(null),
    sendMessage: vi.fn(),
    sendImage: vi.fn(async (_file: File, _onProgress?: (pct: number) => void) => {}),
    sendAudio: vi.fn(async (_blob: Blob) => {}),
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
const imageButton = (w: ReturnType<typeof mount>) => w.get('button[title="Send image"]');
const emojiButton = (w: ReturnType<typeof mount>) => w.get('button[title="Emoji"]');

async function pickImage(w: ReturnType<typeof mount>, file: File | null) {
  const input = w.get('input[type="file"]');
  Object.defineProperty(input.element, "files", { value: file ? [file] : [], configurable: true });
  await input.trigger("change");
}

beforeEach(() => {
  invokeMock.mockClear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
  pinia = createPinia();
  setActivePinia(pinia);
  store = { vox: { phase: ref("idle") } };
  stopHp();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── the rate chip ───────────────────────────────────────────────────────────

describe("MessageComposer — the per-message rate", () => {
  it("prices the clearnet MLS lane per message", () => {
    const { w } = mountComposer();
    expect(w.get('[data-testid="hp-msg-rate"]').text()).toContain("−0.02 HP/msg");
    expect(w.find('[data-testid="hp-msg-free"]').exists()).toBe(false);
  });

  it("drops to Free the moment the room is MLS over Tor", async () => {
    const { w } = mountComposer();
    useNetworkStore().useTor = true;
    await settle();
    expect(w.get('[data-testid="hp-msg-free"]').text()).toBe("Free");
    expect(w.find('[data-testid="hp-msg-rate"]').exists()).toBe(false);
  });

  it("charges the cleartext fallback while MLS is still coming up", async () => {
    // Before MLS reports ready a send falls back to a cleartext frame; the chip
    // has to say so rather than keep showing the sealed lane's price.
    const ch = makeChannel();
    ch.mlsStatus.value = "key_exchange";
    const { w } = mountComposer(ch);
    expect(w.get('[data-testid="hp-msg-rate"]').text()).toContain("−0.25 HP/msg");
    useNetworkStore().useTor = true;
    await settle();
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
    expect(imageButton(w).attributes("disabled")).toBeDefined();
    expect(emojiButton(w).attributes("disabled")).toBeDefined();
    expect(w.findComponent(VoiceRecorderButton).props("disabled")).toBe(true);
  });

  it("asks an observer to join before typing", () => {
    const ch = makeChannel();
    ch.isParticipant.value = false;
    const { w } = mountComposer(ch);
    expect(textarea(w).attributes("placeholder")).toBe("Join this room to send messages");
    expect(textarea(w).attributes("disabled")).toBeDefined();
    expect(emojiButton(w).attributes("disabled")).toBeDefined();
    expect(w.findComponent(VoiceRecorderButton).props("disabled")).toBe(true);
  });

  it("says the session is being established until MLS is ready, but lets an image be staged", () => {
    // Attaching is allowed early (it is only staged); sending waits for MLS.
    const ch = makeChannel();
    ch.mlsStatus.value = "initializing";
    const { w } = mountComposer(ch);
    expect(textarea(w).attributes("placeholder")).toBe("Establishing secure session…");
    expect(textarea(w).attributes("disabled")).toBeDefined();
    expect(imageButton(w).attributes("disabled")).toBeUndefined();
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
    expect(imageButton(w).attributes("disabled")).toBeDefined();
  });

  it("disables attaching while disconnected", () => {
    const ch = makeChannel();
    ch.isConnected.value = false;
    const { w } = mountComposer(ch);
    expect(imageButton(w).attributes("disabled")).toBeDefined();
    expect(textarea(w).attributes("disabled")).toBeDefined();
  });

  it("invites a message when everything is ready", () => {
    const { w } = mountComposer();
    expect(textarea(w).attributes("placeholder")).toBe("Message…");
    expect(textarea(w).attributes("disabled")).toBeUndefined();
  });

  it("keeps the microphone off-limits while a call owns it", async () => {
    // A live or ringing-out call holds the default input device; recording a
    // voice note at the same time would fight it for the microphone.
    const { w } = mountComposer();
    const voice = () => w.findComponent(VoiceRecorderButton).props("disabled");
    expect(voice()).toBe(false);
    store.vox.phase.value = "calling";
    await settle();
    expect(voice()).toBe(true);
    store.vox.phase.value = "connected";
    await settle();
    expect(voice()).toBe(true);
    store.vox.phase.value = "incoming";
    await settle();
    expect(voice()).toBe(false);
  });

  it("leaves the microphone free in a build without calls", () => {
    store = { vox: null };
    const { w } = mountComposer();
    expect(w.findComponent(VoiceRecorderButton).props("disabled")).toBe(false);
  });
});

// ── sending text ────────────────────────────────────────────────────────────

describe("MessageComposer — sending text", () => {
  it("sends the trimmed text on Enter, clears the box and bills the text's bytes", async () => {
    const { w, ch } = mountComposer();
    await textarea(w).setValue("  hello  ");
    await textarea(w).trigger("keydown", { key: "Enter" });
    await settle();

    expect(ch.sendMessage).toHaveBeenCalledWith("hello");
    expect((textarea(w).element as HTMLTextAreaElement).value).toBe("");
    expect(charges()).toEqual([{ actionId: "msg.clearnet.mls", bytes: 5, minutes: null }]);
  });

  it("counts bytes, not characters, when billing", async () => {
    const { w } = mountComposer();
    await textarea(w).setValue("żółw");
    await sendButton(w).trigger("click");
    await settle();
    // Four characters, seven bytes of UTF-8.
    expect(charges()).toEqual([{ actionId: "msg.clearnet.mls", bytes: 7, minutes: null }]);
  });

  it("bills the lane the room is on at the moment of sending", async () => {
    const { w } = mountComposer();
    useNetworkStore().useTor = true;
    await textarea(w).setValue("over tor");
    await sendButton(w).trigger("click");
    await settle();
    expect(charges()).toEqual([{ actionId: "msg.tor.mls", bytes: 8, minutes: null }]);
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
    // The send gate reads the draft, so an emoji alone is a sendable message.
    expect(sendButton(w).attributes("disabled")).toBeUndefined();
  });
});

// ── attachments ─────────────────────────────────────────────────────────────

describe("MessageComposer — attachments", () => {
  const photo = () => new File([new Uint8Array(1500)], "cat.png", { type: "image/png" });

  it("stages a picked image as a preview, which alone makes the message sendable", async () => {
    const { w } = mountComposer();
    expect(sendButton(w).attributes("disabled")).toBeDefined();
    await pickImage(w, photo());
    expect(w.text()).toContain("Image ready to send");
    expect(w.text()).toContain("cat.png");
    expect(w.get("img").attributes("src")).toBe("blob:test/" + urlSeq);
    expect(sendButton(w).attributes("disabled")).toBeUndefined();
  });

  it("opens the image picker from the image button", async () => {
    const { w } = mountComposer();
    const click = vi.spyOn(w.get('input[type="file"]').element as HTMLInputElement, "click");
    await imageButton(w).trigger("click");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("ignores a picker closed without a file", async () => {
    const { w } = mountComposer();
    await pickImage(w, null);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(w.text()).not.toContain("Image ready to send");
  });

  it("sends the image with live progress, then bills its size and frees the preview", async () => {
    const ch = makeChannel();
    let finish!: () => void;
    let report!: (pct: number) => void;
    ch.sendImage.mockImplementation(
      (_f, onProgress) =>
        new Promise<void>((resolve) => {
          report = onProgress!;
          finish = resolve;
        }),
    );
    const { w } = mountComposer(ch);
    const file = photo();
    await pickImage(w, file);
    const url = createObjectURL.mock.results[0].value as string;

    await sendButton(w).trigger("click");
    await settle();
    expect(ch.sendImage).toHaveBeenCalledWith(file, expect.any(Function));
    // The preview goes at once; the upload bar takes its place.
    expect(w.text()).not.toContain("Image ready to send");
    expect(w.text()).toContain("Sending…");
    expect(imageButton(w).attributes("disabled")).toBeDefined();

    report(40);
    await settle();
    expect(w.text()).toContain("40%");

    finish();
    await settle();
    expect(w.text()).not.toContain("Sending…");
    expect(charges()).toEqual([{ actionId: "msg.clearnet.mls", bytes: 1500, minutes: null }]);
    expect(revokeObjectURL).toHaveBeenCalledWith(url);
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it("sends the attachment first and the caption after, billing each", async () => {
    const { w, ch } = mountComposer();
    await pickImage(w, photo());
    await textarea(w).setValue("look");
    await sendButton(w).trigger("click");
    await settle();

    expect(ch.sendImage.mock.invocationCallOrder[0]).toBeLessThan(ch.sendMessage.mock.invocationCallOrder[0]);
    expect(ch.sendMessage).toHaveBeenCalledWith("look");
    expect(charges()).toEqual([
      { actionId: "msg.clearnet.mls", bytes: 1500, minutes: null },
      { actionId: "msg.clearnet.mls", bytes: 4, minutes: null },
    ]);
  });

  it("keeps the caption and bills nothing when the upload fails", async () => {
    const ch = makeChannel();
    ch.sendImage.mockRejectedValue(new Error("relay gone"));
    const errors: unknown[] = [];
    const { w } = mountComposer(ch, (e) => errors.push(e));
    await pickImage(w, photo());
    await textarea(w).setValue("caption");
    await sendButton(w).trigger("click");
    await settle();

    expect((errors[0] as Error).message).toBe("relay gone");
    expect(w.text()).not.toContain("Sending…");
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(ch.sendMessage).not.toHaveBeenCalled();
    expect((textarea(w).element as HTMLTextAreaElement).value).toBe("caption");
    expect(charges()).toEqual([]);
  });

  it("frees the staged image when the preview is cancelled", async () => {
    const { w } = mountComposer();
    await pickImage(w, photo());
    const url = createObjectURL.mock.results[0].value as string;
    await w.findAll("button").find((b) => b.text().includes("Cancel"))!.trigger("click");
    expect(revokeObjectURL).toHaveBeenCalledWith(url);
    expect(w.text()).not.toContain("Image ready to send");
    expect(sendButton(w).attributes("disabled")).toBeDefined();
  });

  it("replaces a staged attachment with the next one, freeing the first", async () => {
    const { w } = mountComposer();
    await pickImage(w, photo());
    const first = createObjectURL.mock.results[0].value as string;
    await pickImage(w, new File(["x"], "dog.png", { type: "image/png" }));
    expect(revokeObjectURL).toHaveBeenCalledWith(first);
    expect(w.text()).toContain("dog.png");
    expect(w.text()).not.toContain("cat.png");
  });

  it("stages a recorded voice note and sends it as audio, billed by size", async () => {
    const { w, ch } = mountComposer();
    const blob = new Blob([new Uint8Array(3000)], { type: "audio/webm" });
    w.findComponent(VoiceRecorderButton).vm.$emit("staged", blob, "Voice message · 0:03");
    await settle();
    expect(w.text()).toContain("Voice message ready to send");
    expect(w.text()).toContain("Voice message · 0:03");
    expect(w.find("audio").exists()).toBe(true);

    await sendButton(w).trigger("click");
    await settle();
    expect(ch.sendAudio).toHaveBeenCalledWith(blob);
    expect(ch.sendImage).not.toHaveBeenCalled();
    expect(charges()).toEqual([{ actionId: "msg.clearnet.mls", bytes: 3000, minutes: null }]);
  });

  it("frees a staged attachment when the composer goes away", async () => {
    const { w } = mountComposer();
    await pickImage(w, photo());
    const url = createObjectURL.mock.results[0].value as string;
    w.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(url);
  });
});

// ── the emoji picker on its own ─────────────────────────────────────────────

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
