// The share card: private QR, shareable QR — and no longer a room ticket.
//
// The permanent ticket was the third mode. It is gone, along with any way to open
// a room to the gossip topic, so both remaining modes are bounded credentials the
// issuer can withdraw.
//
// What these pin is mostly *honesty of presentation*. The card is where a user
// decides how much of themselves to hand out, so each mode has to state its
// consequence and its price before the tap, and the bearer mode has to say
// plainly that it is not secret.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { i18n } from "../../src/i18n";
import { resetHpLedgerForTest } from "rakotis";
import RoomShareCard from "../../src/components/chat/RoomShareCard.vue";
import { refreshHp, resolveHpConfirm, setHpTranslator, stopHp } from "../../src/components/hp/useHp";

const global = { plugins: [i18n], stubs: { "font-awesome-icon": true } };

function card(props: Record<string, unknown> = {}) {
  return mount(RoomShareCard, {
    props: { roomSlug: "room-1", roomName: "Room One", ...props },
    global,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  // The card reads its invitation list through Tauri; without this it is in
  // browser-fallback mode and the list never loads.
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  setActivePinia(createPinia());
  resetHpLedgerForTest();
  stopHp();
  setHpTranslator({
    t: (k) => String((i18n.global.t as (x: string) => string)(k)),
    has: (k) => Boolean((i18n.global.te as (x: string) => boolean)(k)),
  });
  invokeMock.mockResolvedValue([]);
  await refreshHp();
});

describe("RoomShareCard", () => {
  it("offers the two invitation modes and no third", async () => {
    const w = card();
    await flushPromises();
    expect(w.find('[data-testid="share-mode-personal"]').exists()).toBe(true);
    expect(w.find('[data-testid="share-mode-general"]').exists()).toBe(true);
    // The retired one. Its absence is the feature.
    expect(w.find('[data-testid="share-mode-ticket"]').exists()).toBe(false);
  });

  it("opens on the private QR, the cheaper and narrower credential", async () => {
    const w = card();
    await flushPromises();
    expect(w.get('[data-testid="share-consequence"]').text()).toMatch(/only the person you choose/i);
    // Straight to minting: there is no longer a mode that shows an existing code.
    expect(w.find('[data-testid="invite-create"]').exists()).toBe(true);
  });

  it("states each mode's consequence before the tap", async () => {
    const w = card();
    await flushPromises();
    const said: string[] = [];
    for (const m of ["personal", "general"]) {
      await w.get(`[data-testid="share-mode-${m}"]`).trigger("click");
      said.push(w.get('[data-testid="share-consequence"]').text());
    }
    // Two modes, two distinct sentences — neither of them boilerplate.
    expect(new Set(said).size).toBe(2);
    expect(said[0]).toMatch(/only the person you choose/i);
    expect(said[1]).toMatch(/anyone holding the code/i);
  });

  it("prices a private QR far below a shareable one", async () => {
    // The headline the whole feature exists for: the narrow credential is cheap,
    // the bearer one costs what the permanent ticket used to.
    const w = card();
    await flushPromises();
    const privatePrice = w.get('[data-testid="share-price"]').text();
    await w.get('[data-testid="share-mode-general"]').trigger("click");
    const bearerPrice = w.get('[data-testid="share-price"]').text();
    expect(privatePrice).toContain("−1.5 HP");
    expect(bearerPrice).toContain("−5 HP");
  });

  it("prices a private QR at its cheapest over Tor", async () => {
    const w = card({ tor: true });
    await flushPromises();
    await w.get('[data-testid="share-mode-personal"]').trigger("click");
    expect(w.get('[data-testid="share-price"]').text()).toContain("−0.5 HP");
  });

  it("warns plainly that a shareable code is not secret", async () => {
    const w = card();
    await flushPromises();
    await w.get('[data-testid="share-mode-general"]').trigger("click");
    const warning = w.get('[data-testid="share-bearer-warning"]').text();
    expect(warning).toMatch(/not secret/i);
    expect(warning).toMatch(/photo|forwarded/i);
  });

  it("shows the bearer warning only for the bearer mode", async () => {
    const w = card();
    await flushPromises();
    expect(w.find('[data-testid="share-bearer-warning"]').exists()).toBe(false);
    await w.get('[data-testid="share-mode-personal"]').trigger("click");
    expect(w.find('[data-testid="share-bearer-warning"]').exists()).toBe(false);
  });

  it("says the room must stay open, rather than leaving it to be discovered", async () => {
    const w = card();
    await flushPromises();
    await w.get('[data-testid="share-mode-personal"]').trigger("click");
    expect(w.get('[data-testid="invite-room-open"]').text()).toMatch(/keep this room open/i);
  });

  it("asks for a recipient for a private QR and not for a bearer one", async () => {
    // A bearer invitation binds to nobody — that IS the difference — so offering
    // a picker for it would misdescribe what it does.
    const w = card();
    await flushPromises();
    await w.get('[data-testid="share-mode-personal"]').trigger("click");
    expect(w.find('[data-testid="invite-recipient"]').exists() || w.find('[data-testid="invite-paste"]').exists()).toBe(true);
    await w.get('[data-testid="share-mode-general"]').trigger("click");
    expect(w.find('[data-testid="invite-recipient"]').exists()).toBe(false);
    expect(w.find('[data-testid="invite-paste"]').exists()).toBe(false);
  });

  it("falls back to pasting a node code when there are no contacts", async () => {
    // An empty contact list must not be a dead end.
    const w = card();
    await flushPromises();
    await w.get('[data-testid="share-mode-personal"]').trigger("click");
    expect(w.find('[data-testid="invite-paste"]').exists()).toBe(true);
  });

  it("will not create a private QR without a recipient", async () => {
    const w = card();
    await flushPromises();
    await w.get('[data-testid="share-mode-personal"]').trigger("click");
    expect(w.get('[data-testid="invite-create"]').attributes("disabled")).toBeDefined();
  });

  it("offers every deadline preset, and no 'never'", async () => {
    // The unbounded credential already exists and is called a room ticket.
    const w = card();
    await flushPromises();
    await w.get('[data-testid="share-mode-general"]').trigger("click");
    for (const secs of [3600, 86400, 604800]) {
      expect(w.find(`[data-testid="invite-ttl-${secs}"]`).exists(), String(secs)).toBe(true);
    }
    expect(w.find('[data-testid="invite-ttl-custom"]').exists()).toBe(true);
    expect(w.text().toLowerCase()).not.toContain("never");
  });

  it("mints a bearer invitation and shows its countdown", async () => {
    const w = card();
    await flushPromises();
    await w.get('[data-testid="share-mode-general"]').trigger("click");

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "invite_create") {
        return { ticket: "nfaqcode", expiresAt: Date.now() + 3_600_000, kind: "general" };
      }
      if (cmd === "invite_list") return [];
      return null;
    });
    await w.get('[data-testid="invite-create"]').trigger("click");
    await flushPromises();
    // A bearer invitation is −10 HP, so it always raises the confirmation
    // carrying its warning. Nothing is minted until that is answered.
    expect(invokeMock.mock.calls.find((c) => c[0] === "invite_create")).toBeUndefined();
    resolveHpConfirm(true);
    await flushPromises();

    const created = invokeMock.mock.calls.find((c) => c[0] === "invite_create");
    expect(created?.[1]).toMatchObject({ roomSlug: "room-1", kind: "general", ttlSecs: 86_400 });
    // A bearer invitation binds to nobody.
    expect(created?.[1].recipient).toBeNull();
    expect(w.get('[data-testid="invite-countdown"]').text()).toMatch(/valid for/i);
  });

  it("drops a minted code when the mode changes", async () => {
    // It belongs to the mode that made it; leaving it under another heading
    // would misdescribe what the user is holding.
    const w = card();
    await flushPromises();
    await w.get('[data-testid="share-mode-general"]').trigger("click");
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "invite_create"
        ? { ticket: "nfaqcode", expiresAt: Date.now() + 3_600_000, kind: "general" }
        : [],
    );
    await w.get('[data-testid="invite-create"]').trigger("click");
    await flushPromises();
    resolveHpConfirm(true);
    await flushPromises();
    expect(w.find('[data-testid="invite-countdown"]').exists()).toBe(true);

    await w.get('[data-testid="share-mode-personal"]').trigger("click");
    expect(w.find('[data-testid="invite-countdown"]').exists()).toBe(false);
  });

  it("lists this room's invitations and nobody else's", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "invite_list"
        ? [
            { id: "a1", kind: "general", state: "active", roomSlug: "room-1", expiresAt: Date.now() + 3_600_000, recipient: null },
            { id: "b2", kind: "personal", state: "consumed", roomSlug: "other-room", expiresAt: 0, recipient: "bob" },
          ]
        : null,
    );
    const w = card();
    await flushPromises();
    await w.get('[data-testid="share-mode-general"]').trigger("click");
    const list = w.get('[data-testid="invite-list"]').text();
    expect(list).toContain("Shareable QR");
    expect(list).not.toContain("Used");
  });

  it("offers withdraw only on an invitation that can still be used", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "invite_list"
        ? [
            { id: "live", kind: "general", state: "active", roomSlug: "room-1", expiresAt: Date.now() + 3_600_000, recipient: null },
            { id: "dead", kind: "general", state: "consumed", roomSlug: "room-1", expiresAt: 0, recipient: null },
          ]
        : null,
    );
    const w = card();
    await flushPromises();
    await w.get('[data-testid="share-mode-general"]').trigger("click");
    expect(w.find('[data-testid="invite-revoke-live"]').exists()).toBe(true);
    expect(w.find('[data-testid="invite-revoke-dead"]').exists()).toBe(false);
  });
});
