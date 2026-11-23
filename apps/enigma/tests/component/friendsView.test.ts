// The Friends screen: our own pairing code, adding a friend from a pasted code
// with the check code shown before saving, and refusing our own code.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";

const kv = new Map<string, string>();
vi.mock("rakotis", async (orig) => ({
  ...(await orig<typeof import("rakotis")>()),
  kvGet: async (ns: string, scope: string, k: string) => kv.get(`${ns}/${scope}/${k}`) ?? null,
  kvPut: async (ns: string, scope: string, k: string, v: string) => void kv.set(`${ns}/${scope}/${k}`, v),
}));
const ME = "1".repeat(64);
vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({ p2p: { deviceId: async () => ME, currentUserName: ref("Me") } }),
}));

import { i18n } from "../../src/i18n";
import EnigmaFriendsView from "../../src/views/EnigmaFriendsView.vue";
import { encodePairing, friends, loadFriends } from "../../src/stores/friends";

(i18n.global.locale as any).value = "en";
const ANN = "a".repeat(64);

async function mountView() {
  const w = mount(EnigmaFriendsView, {
    global: { plugins: [i18n], stubs: { "font-awesome-icon": true, teleport: true, QrScannerModal: true, OyaQrCode: true } },
  });
  await flushPromises();
  return w;
}

beforeEach(async () => {
  kv.clear();
  await loadFriends(true);
});

describe("Friends", () => {
  it("shows our own pairing code", async () => {
    const w = await mountView();
    expect(w.get("[data-testid=my-pairing-code]").html()).toContain(encodePairing(ME, "Me"));
  });

  it("adds a friend from a pasted code after showing the check code", async () => {
    const w = await mountView();
    await w.get("input[placeholder=\"…or paste their code\"]").setValue(encodePairing(ANN, "Ann"));
    await w.findAll("button").find((b) => b.text() === "Add")!.trigger("click");
    // The check code is a SHA-256 (crypto.subtle): wait for it, not for one tick.
    await vi.waitFor(() => expect(w.get("[data-testid=pending-check]").text()).toMatch(/^\d{4} \d{4} \d{4}$/));
    await w.get("[data-testid=friend-save]").trigger("click");
    await flushPromises();
    expect(friends.value).toEqual([expect.objectContaining({ id: ANN, name: "Ann" })]);
    expect(w.get("[data-testid=friend-list]").text()).toContain("Ann");
  });

  it("refuses our own code and anything that is not a code", async () => {
    const w = await mountView();
    const add = () => w.findAll("button").find((b) => b.text() === "Add")!.trigger("click");
    await w.get("input[placeholder=\"…or paste their code\"]").setValue(encodePairing(ME, "Me"));
    await add();
    await flushPromises();
    expect(w.get("[data-testid=friend-error]").text()).toMatch(/your own code/i);
    await w.get("input[placeholder=\"…or paste their code\"]").setValue("nonsense");
    await add();
    await flushPromises();
    expect(w.get("[data-testid=friend-error]").text()).toMatch(/not an Enigma27 friend code/i);
    expect(friends.value).toHaveLength(0);
  });
});
