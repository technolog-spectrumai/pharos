// Privacy HP — the rendered half: the price shown on a control, the info
// sentence behind it, the meters, the confirm dialog, and the welcome page.
//
// The brief's UI rules are the assertions here: the price is visible BEFORE the
// tap, an info icon reveals one sentence, only high/severe costs confirm, and
// the flash reports what just happened.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import {
  OyaHpPrice,
  OyaHpMeter,
  deriveBalances,
  getHpPolicy,
  resetHpLedgerForTest,
} from "rakotis";

const fileShare = { state: ref("idle") };
const vox = { phase: ref("idle") };
const invites = { incoming: ref(false) };
const meetings = { attentionCount: ref(0) };

vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({
    syncRuntimeIdentity: vi.fn(),
    init: vi.fn(),
    p2p: { currentUserName: ref(""), myAvatar: ref("") },
    fileShare,
    vox,
    invites,
    meetings,
    callsEnabled: true,
    contactsEnabled: true,
    calendarEnabled: true,
  }),
}));

import { i18n } from "../../src/i18n";
import HpPanel from "../../src/components/hp/HpPanel.vue";
import HpConfirmModal from "../../src/components/hp/HpConfirmModal.vue";
import HpFlash from "../../src/components/hp/HpFlash.vue";
import EnigmaWelcomeView from "../../src/views/EnigmaWelcomeView.vue";
import EnigmaPrivacyView from "../../src/views/EnigmaPrivacyView.vue";
import HpChip from "../../src/components/hp/HpChip.vue";
import { setTabVisible } from "../../src/tabs";
import router from "../../src/router";
import {
  chargeHp,
  confirmHp,
  refreshHp,
  resolveHpConfirm,
  setHpTranslator,
  stopHp,
} from "../../src/components/hp/useHp";

const global = {
  plugins: [i18n, router],
  stubs: { "font-awesome-icon": true, RouterLink: true },
};

// OyaModal teleports to <body>, so the confirmation renders outside the mounted
// wrapper. Stubbing the teleport keeps it inside, the way the other modal tests
// in this suite do.
const modalGlobal = { ...global, stubs: { ...global.stubs, teleport: true } };

beforeEach(async () => {
  // Teleported popovers live on <body>, outside any wrapper, so a mount left
  // standing by an earlier test would still be on the page. Clear them so each
  // test's assertions are about its own component.
  document
    .querySelectorAll('[data-testid="hp-explain"], [data-testid="hp-explain-backdrop"]')
    .forEach((n) => n.remove());
  // The panel remembers which sections were open; each test starts folded.
  localStorage.removeItem("enigma:hp:open");
  setActivePinia(createPinia());
  resetHpLedgerForTest();
  stopHp();
  setHpTranslator({
    t: (k) => String((i18n.global.t as (x: string) => string)(k)),
    has: (k) => Boolean((i18n.global.te as (x: string) => boolean)(k)),
  });
  await refreshHp();
});

// ── the price badge ─────────────────────────────────────────────────────────

describe("OyaHpPrice", () => {
  it("shows the price with a real minus sign", () => {
    const w = mount(OyaHpPrice, { props: { centi: -300 }, global });
    expect(w.get('[data-testid="hp-price"]').text()).toBe("−3 HP");
  });

  it("shows a fractional price without trailing zeros", () => {
    const w = mount(OyaHpPrice, { props: { centi: -5 }, global });
    expect(w.get('[data-testid="hp-price"]').text()).toBe("−0.05 HP");
  });

  it("appends a rate unit for a metered action", () => {
    const w = mount(OyaHpPrice, { props: { centi: -5, unit: "msg" }, global });
    expect(w.get('[data-testid="hp-price"]').text()).toContain("/msg");
  });

  it("shows a credit as a plus", () => {
    const w = mount(OyaHpPrice, { props: { centi: 500 }, global });
    expect(w.get('[data-testid="hp-price"]').text()).toBe("+5 HP");
  });

  it("reveals exactly one sentence behind the info icon", async () => {
    const explain = "Anyone holding your network identity can tell when you are around.";
    const w = mount(OyaHpPrice, { props: { centi: -1000, explain }, attachTo: document.body, global });
    expect(document.querySelector('[data-testid="hp-explain"]')).toBeNull();
    await w.get('[data-testid="hp-info"]').trigger("click");
    expect(document.querySelector('[data-testid="hp-explain"]')?.textContent?.trim()).toBe(explain);
    w.unmount();
  });

  it("escapes its container instead of being clipped by it", async () => {
    // The bug this fixes: the badge sits inside modal cards that are
    // `overflow-y-auto`, and an absolutely-positioned child of a scroll
    // container is clipped by it — the explanation ended up half off the side
    // of the New-chat dialog. Teleporting to <body> is what takes it out of
    // every ancestor's clipping box, so that is what is asserted.
    const w = mount(OyaHpPrice, {
      props: { centi: -1000, explain: "why" },
      attachTo: document.body,
      global,
    });
    await w.get('[data-testid="hp-info"]').trigger("click");
    const panel = document.querySelector('[data-testid="hp-explain"]');
    expect(panel).not.toBeNull();
    // Not a descendant of the badge — that is the whole point.
    expect(w.element.contains(panel!)).toBe(false);
    expect(panel!.parentElement).toBe(document.body);
    expect(panel!.className).toContain("fixed");
    // Positioned in viewport coordinates, which is what makes it immune to an
    // ancestor's overflow.
    expect((panel as HTMLElement).style.top).not.toBe("");
    w.unmount();
  });

  it("opens downward from the icon", async () => {
    // Upward looked tidier beside a button low in a dialog, but these badges sit
    // near the TOP of one, where "up" is off the dialog entirely.
    const w = mount(OyaHpPrice, {
      props: { centi: -1000, explain: "why" },
      attachTo: document.body,
      global,
    });
    const icon = w.get('[data-testid="hp-info"]').element as HTMLElement;
    await w.get('[data-testid="hp-info"]').trigger("click");
    const panel = document.querySelector('[data-testid="hp-explain"]') as HTMLElement;
    expect(parseFloat(panel.style.top)).toBeGreaterThanOrEqual(
      icon.getBoundingClientRect().bottom,
    );
    w.unmount();
  });

  it("never positions itself off the left edge", async () => {
    // Right-aligning to the icon would push a badge near the left margin
    // off-screen; the clamp is what stops that.
    const w = mount(OyaHpPrice, {
      props: { centi: -1000, explain: "why" },
      attachTo: document.body,
      global,
    });
    await w.get('[data-testid="hp-info"]').trigger("click");
    const panel = document.querySelector('[data-testid="hp-explain"]') as HTMLElement;
    expect(parseFloat(panel.style.left)).toBeGreaterThanOrEqual(0);
    w.unmount();
  });

  it("closes on a click away and leaves nothing behind", async () => {
    const w = mount(OyaHpPrice, {
      props: { centi: -1000, explain: "why" },
      attachTo: document.body,
      global,
    });
    await w.get('[data-testid="hp-info"]').trigger("click");
    expect(document.querySelector('[data-testid="hp-explain"]')).not.toBeNull();
    const backdrop = document.querySelector('[data-testid="hp-explain-backdrop"]') as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await w.vm.$nextTick();
    expect(document.querySelector('[data-testid="hp-explain"]')).toBeNull();
    w.unmount();
  });

  it("cleans up when unmounted while open", async () => {
    // A dialog can be closed with the panel still up; a teleported node that
    // outlived its owner would sit on the page forever.
    const w = mount(OyaHpPrice, {
      props: { centi: -1000, explain: "why" },
      attachTo: document.body,
      global,
    });
    await w.get('[data-testid="hp-info"]').trigger("click");
    w.unmount();
    expect(document.querySelector('[data-testid="hp-explain"]')).toBeNull();
  });

  it("offers no info icon when there is nothing to explain", () => {
    const w = mount(OyaHpPrice, { props: { centi: -100 }, global });
    expect(w.find('[data-testid="hp-info"]').exists()).toBe(false);
  });
});

// ── the meter ───────────────────────────────────────────────────────────────

describe("OyaHpMeter", () => {
  const meter = (entries: any[] = [], now = Date.now()) =>
    deriveBalances(getHpPolicy(), entries, now).daily;

  it("shows balance over maximum", () => {
    const w = mount(OyaHpMeter, { props: { meter: meter(), label: "Today" }, global });
    expect(w.get('[data-testid="hp-meter-value"]').text()).toBe("100 / 100");
  });

  it("sizes the bar to the balance", () => {
    const spent = [{ ts: Date.now(), kind: "spend", code: "x", hp: -5000, n: 1, bucket: 0 }];
    const w = mount(OyaHpMeter, { props: { meter: meter(spent), label: "Today" }, global });
    expect(w.get('[data-testid="hp-meter-bar"]').attributes("style")).toContain("width: 50%");
  });

  it("exposes the level to assistive tech", () => {
    const w = mount(OyaHpMeter, { props: { meter: meter(), label: "Today" }, global });
    const bar = w.get('[role="meter"]');
    expect(bar.attributes("aria-valuenow")).toBe("100");
    expect(bar.attributes("aria-valuemax")).toBe("100");
  });
});

// ── the panel ───────────────────────────────────────────────────────────────

describe("HpPanel", () => {
  it("renders both meters", () => {
    const w = mount(HpPanel, { global });
    expect(w.findAll('[data-testid="hp-meter"]')).toHaveLength(2);
  });

  it("lists a price for every priced action, once its section is opened", async () => {
    const w = mount(HpPanel, { global });
    for (const [group, id] of [
      ["discovery", "dht.presence.enable"],
      ["rooms", "ticket.export.clearnet"],
      ["traffic", "vox.call"],
    ]) {
      await w.get(`[data-testid="hp-group-${group}"]`).trigger("click");
      expect(w.find(`[data-testid="hp-price-row-${id}"]`).exists(), id).toBe(true);
    }
  });

  it("starts with every section folded, so the meters are not buried", () => {
    // Eight groups of four-ish rows would push the meters off the screen. The
    // headings are a contents page; you open the one you are asking about.
    const w = mount(HpPanel, { global });
    expect(w.findAll('[data-testid^="hp-group-body-"]')).toHaveLength(0);
    expect(w.find('[data-testid="hp-price-row-vox.call"]').exists()).toBe(false);
    // ...but every heading is there to be opened.
    expect(w.findAll('[data-testid^="hp-group-"]').length).toBeGreaterThan(5);
  });

  it("folds a section back up", async () => {
    const w = mount(HpPanel, { global });
    const head = w.get('[data-testid="hp-group-local"]');
    await head.trigger("click");
    expect(w.find('[data-testid="hp-group-body-local"]').exists()).toBe(true);
    expect(head.attributes("aria-expanded")).toBe("true");
    await head.trigger("click");
    expect(w.find('[data-testid="hp-group-body-local"]').exists()).toBe(false);
    expect(head.attributes("aria-expanded")).toBe("false");
  });

  it("says how many prices a folded section holds", async () => {
    // A folded heading still has to convey size, or folding just hides the
    // table without telling you what you are missing.
    const w = mount(HpPanel, { global });
    expect(w.get('[data-testid="hp-group-transport"]').text()).toMatch(/\d/);
  });

  it("remembers which sections were open", async () => {
    const w = mount(HpPanel, { global });
    await w.get('[data-testid="hp-group-messages"]').trigger("click");
    // A fresh mount — as happens on every visit to the tab — keeps the choice.
    const again = mount(HpPanel, { global });
    expect(again.find('[data-testid="hp-group-body-messages"]').exists()).toBe(true);
    expect(again.find('[data-testid="hp-group-body-local"]').exists()).toBe(false);
  });

  it("shows the safe message lane as free rather than as a zero price", async () => {
    const w = mount(HpPanel, { global });
    await w.get('[data-testid="hp-group-messages"]').trigger("click");
    const row = w.get('[data-testid="hp-price-row-msg.tor.mls"]');
    expect(row.text()).toContain("Free");
    expect(row.text()).not.toContain("0 HP");
  });

  it("offers the Tor regeneration bonus rather than pricing the switch", () => {
    // Tor is free to toggle; what it changes is the rate. The panel says so next
    // to the meters, because it is the only lever on how fast HP comes back.
    const w = mount(HpPanel, { global });
    expect(w.get('[data-testid="hp-tor-bonus"]').text()).toMatch(/three times faster/i);
    // And it must not appear as a price anywhere in the list.
    expect(w.find('[data-testid="hp-price-row-transport.tor.disable"]').exists()).toBe(false);
  });

  it("says plainly that regeneration does not undo exposure", () => {
    const w = mount(HpPanel, { global });
    expect(w.get('[data-testid="hp-disclaimer"]').text()).toMatch(/still out there/i);
  });

  it("hides the price list and history in compact mode", () => {
    const w = mount(HpPanel, { props: { compact: true }, global });
    expect(w.findAll('[data-testid="hp-meter"]')).toHaveLength(2);
    expect(w.find('[data-testid="hp-group-traffic"]').exists()).toBe(false);
  });

  it("shows an empty history before anything happens", () => {
    const w = mount(HpPanel, { global });
    expect(w.find('[data-testid="hp-history-empty"]').exists()).toBe(true);
  });

  it("lists a charge in the history once one is made", async () => {
    await chargeHp("dht.presence.enable");
    const w = mount(HpPanel, { global });
    await flushPromises();
    const history = w.get('[data-testid="hp-history"]').text();
    expect(history).toContain("−5 HP");
    expect(history).toContain("DHT");
  });

  it("promises the ledger holds no content", () => {
    const w = mount(HpPanel, { global });
    expect(w.text()).toMatch(/never a message, contact, room name/i);
  });
});

// ── the confirmation ────────────────────────────────────────────────────────

describe("HpConfirmModal", () => {
  it("stays closed until something asks", () => {
    const w = mount(HpConfirmModal, { global: modalGlobal });
    expect(w.find('[data-testid="hp-confirm"]').exists()).toBe(false);
  });

  it("shows the price and the one-sentence reason for a severe action", async () => {
    const w = mount(HpConfirmModal, { global: modalGlobal });
    const pending = confirmHp("dht.nickname.publish");
    await flushPromises();
    expect(w.get('[data-testid="hp-confirm-price"]').text()).toBe("−10 HP");
    expect(w.get('[data-testid="hp-confirm"]').text()).toMatch(/directory/i);
    resolveHpConfirm(false);
    await pending;
  });

  it("says out loud that it measures rather than protects", async () => {
    const w = mount(HpConfirmModal, { global: modalGlobal });
    const pending = confirmHp("dht.nickname.publish");
    await flushPromises();
    expect(w.get('[data-testid="hp-confirm"]').text()).toMatch(/does not protect/i);
    resolveHpConfirm(false);
    await pending;
  });

  it("lets the action through when Continue is clicked", async () => {
    const w = mount(HpConfirmModal, { global: modalGlobal });
    const pending = confirmHp("dht.nickname.publish");
    await flushPromises();
    await w.get('[data-testid="hp-confirm-continue"]').trigger("click");
    await expect(pending).resolves.toBe(true);
  });

  it("explains an empty meter without refusing the action", async () => {
    for (let i = 0; i < 20; i++) await chargeHp("ticket.export.clearnet");
    const w = mount(HpConfirmModal, { global: modalGlobal });
    const pending = confirmHp("room.create.tor");
    await flushPromises();
    expect(w.find('[data-testid="hp-confirm-exhausted"]').exists()).toBe(true);
    await w.get('[data-testid="hp-confirm-continue"]').trigger("click");
    await expect(pending).resolves.toBe(true);
  });
});

// ── the flash ───────────────────────────────────────────────────────────────

describe("HpFlash", () => {
  it("reports the charge that just happened", async () => {
    const w = mount(HpFlash, { global });
    await chargeHp("dht.presence.enable");
    await flushPromises();
    const text = w.get('[data-testid="hp-flash"]').text();
    expect(text).toContain("−5 HP");
    expect(text).toMatch(/DHT/);
  });

  it("shows nothing for a no-op charge", async () => {
    const w = mount(HpFlash, { global });
    await chargeHp("msg.tor.mls", { bytes: 4096 });
    await flushPromises();
    expect(w.find('[data-testid="hp-flash"]').exists()).toBe(false);
  });
});

// ── the Privacy tab ─────────────────────────────────────────────────────────

describe("EnigmaPrivacyView", () => {
  it("shows the meters and the full price list", async () => {
    const w = mount(EnigmaPrivacyView, { global });
    await flushPromises();
    expect(w.findAll('[data-testid="hp-meter"]')).toHaveLength(2);
    // The full panel, not the compact one the welcome page uses — its sections
    // start folded, so what distinguishes them is that the headings are there.
    expect(w.find('[data-testid="hp-group-traffic"]').exists()).toBe(true);
    await w.get('[data-testid="hp-group-traffic"]').trigger("click");
    expect(w.find('[data-testid="hp-price-row-vox.call"]').exists()).toBe(true);
  });

  it("renders the same panel the welcome page does", async () => {
    // One component in both places, so the two can never disagree about a number.
    const tab = mount(EnigmaPrivacyView, { global });
    const welcome = mount(EnigmaWelcomeView, { global });
    await flushPromises();
    expect(tab.get('[data-testid="hp-meter-value"]').text()).toBe(
      welcome.get('[data-testid="hp-meter-value"]').text(),
    );
  });
});

describe("HpChip", () => {
  it("opens the Privacy tab", async () => {
    // The shield and the number are one control.
    const push = vi.spyOn(router, "push").mockResolvedValue(undefined as never);
    try {
      const w = mount(HpChip, { global });
      await refreshHp();
      await flushPromises();
      await w.get('[data-testid="hp-chip"]').trigger("click");
      expect(push).toHaveBeenCalledWith("/privacy");
    } finally {
      push.mockRestore();
    }
  });

  it("falls back to the welcome page when that tab is hidden", async () => {
    // A chip that did nothing, or landed somewhere unrelated, would be worse
    // than no chip — and the welcome page carries the same meters.
    const push = vi.spyOn(router, "push").mockResolvedValue(undefined as never);
    await setTabVisible("privacy", false);
    try {
      const w = mount(HpChip, { global });
      await refreshHp();
      await flushPromises();
      await w.get('[data-testid="hp-chip"]').trigger("click");
      expect(push).toHaveBeenCalledWith("/welcome");
    } finally {
      await setTabVisible("privacy", true);
      push.mockRestore();
    }
  });
});

// ── the welcome page ────────────────────────────────────────────────────────

describe("EnigmaWelcomeView", () => {
  it("shows the app version, the user's name and the HP meters", async () => {
    const w = mount(EnigmaWelcomeView, { global });
    await flushPromises();
    expect(w.get('[data-testid="welcome-version"]').text()).toMatch(/\d+\.\d+\.\d+/);
    expect(w.find('[data-testid="welcome-name"]').exists()).toBe(true);
    expect(w.findAll('[data-testid="hp-meter"]')).toHaveLength(2);
  });

  it("offers a way through to the full price list", async () => {
    const w = mount(EnigmaWelcomeView, { global });
    await flushPromises();
    expect(w.find('[data-testid="welcome-hp-details"]').exists()).toBe(true);
  });

  it("describes what the app is without claiming a server", async () => {
    const w = mount(EnigmaWelcomeView, { global });
    await flushPromises();
    expect(w.text()).toMatch(/serverless/i);
  });
});
