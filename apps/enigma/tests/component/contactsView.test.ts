// The Contacts tab, mounted whole: saved peers, DHT presence and the nickname
// directory, and the person-first room invite.
//
// The view talks to Rust through rakotis, so the tests run in Tauri mode against
// a small in-memory backend: kv is a Map, and every other command answers what
// the test told it to. What gets pinned is what reaches that backend — which is
// the whole contract here. A contact the user never confirmed must not be
// stored, a name must not be published before the user agreed to the price, and
// no DHT call may leave the app while the DHT is off or Tor has torn it down.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { ref } from "vue";
import { createRouter, createMemoryHistory } from "vue-router";
import { formatDate, initBuildConfig, type ContactEntry, type P2pRoomEntry } from "rakotis";

const { qr } = vi.hoisted(() => ({
  qr: { decoded: "" as string | null, clears: 0 },
}));

// The one command table every Tauri call ends up in. Unknown commands reject,
// which doubles as an assertion: a command this view should never send fails loudly.
type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  const h = handlers[cmd];
  if (!h) throw new Error(`no backend for ${cmd}`);
  return h(args ?? {});
});

// useRoomInvites subscribes to the invite events at creation; keep the handlers
// so a test can play the part of the Rust side announcing an invite.
const listeners = new Map<string, (e: { payload: Record<string, string> }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: Record<string, string> }) => void) => {
    listeners.set(name, cb);
    return () => {};
  },
}));

vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class {
    async scanFile() {
      if (qr.decoded === null) throw new Error("No MultiFormat Readers were able to detect the code.");
      return qr.decoded;
    }
    async clear() {
      qr.clears += 1;
    }
  },
}));

// The store is the app-wide orchestrator; the view only reads three things off
// it. `invites` is the REAL composable over a stub channel, so the invite modal
// is exercised against the actual offer/answer state machine.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;
vi.mock("../../src/stores/chat", () => ({ useChatStore: () => store }));

// The REAL Tauri API, faked one level down at its IPC hook (what Tauri's own
// mockIPC does) rather than vi.mock'ed: rakotis reaches it through a dynamic
// import on every call, and the view fires several at once (presence + poll
// cadence, the nickname save + publish). Two concurrent dynamic imports of a
// vi.mock'ed module were seen to hand one caller the real module, loaded with
// real I/O — a race no amount of promise-flushing settles. Importing it here
// also keeps that load out of the first test.
import "@tauri-apps/api/core";
import { i18n } from "../../src/i18n";
import EnigmaContactsView from "../../src/views/EnigmaContactsView.vue";
import { useRoomInvites } from "../../src/components/contacts/useRoomInvites";
import { loadTabVisibility, setTabVisible } from "../../src/tabs";
import { hpConfirm, resolveHpConfirm, setHpTranslator, stopHp } from "../../src/components/hp/useHp";

(i18n.global.locale as any).value = "en";

// iroh NodeIds render as 64 hex chars.
const ME = "c3".repeat(32);
const ALA = "a1".repeat(32);
const BOB = "b2".repeat(32);
const CAROL = "d4".repeat(32);

const ROOMS: P2pRoomEntry[] = [
  { room: "room-1", name: "Book club" },
  // A Tor room cannot be invited into from here (different transport).
  { room: "room-2", name: "Onion room", tor: true } as P2pRoomEntry,
];

const kv = new Map<string, string>();
const kvKey = (a: Record<string, unknown>) => `${a.ns}/${a.scope}/${a.k}`;
const setting = (k: string, v: string) => kv.set(`p2p:settings/default/${k}`, v);
const seedContacts = (list: ContactEntry[]) => kv.set("contacts/default/", JSON.stringify(list));
const storedContacts = (): ContactEntry[] => JSON.parse(kv.get("contacts/default/") ?? "[]");
const callsTo = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

function defaultHandlers(): Record<string, Handler> {
  return {
    kv_get: (a) => kv.get(kvKey(a)) ?? null,
    kv_put: (a) => {
      kv.set(kvKey(a), String(a.v));
    },
    app_get_use_tor: () => false,
    dht_presence: () => [],
    dht_find_nick: () => [],
    dht_publish_nick: () => null,
    dht_apply: () => null,
    hp_ledger: () => [],
    hp_charge: (a) => ({ applied: -1000, code: a.actionId }),
    hp_recover: (a) => ({ applied: 500, code: a.recoveryId }),
    realtime_node_info: () => ({}),
    invite_send: () => "accepted",
    invite_respond: () => null,
  };
}

function makeChannel() {
  return {
    p2pRooms: ref<P2pRoomEntry[]>([...ROOMS]),
    mlsIdentity: ref("me"),
    currentUserName: ref("Me"),
    ensureNode: vi.fn(async (): Promise<string | null> => ME),
    loadP2pRooms: vi.fn(async () => {}),
    openP2pRoom: vi.fn(async () => {}),
    joinByInvite: vi.fn(async () => true),
  };
}

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/:any(.*)*", component: { render: () => null } }],
});

beforeEach(async () => {
  invokeMock.mockClear();
  kv.clear();
  listeners.clear();
  qr.decoded = "";
  qr.clears = 0;
  handlers = defaultHandlers();
  // Tauri mode: the real `invoke` forwards to __TAURI_INTERNALS__.invoke.
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
  const p2p = makeChannel();
  store = {
    p2p,
    invites: useRoomInvites(p2p as never),
    vox: { callNode: vi.fn(async () => {}) },
  };
  stopHp();
  setHpTranslator({
    t: (k) => String((i18n.global.t as (x: string) => string)(k)),
    has: (k) => Boolean((i18n.global.te as (x: string) => boolean)(k)),
  });
  await loadTabVisibility();
  await router.replace("/contacts");
  await flushPromises();
  invokeMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// Every rakotis call reaches the backend through a dynamic import of the Tauri
// API, so one action is a chain of several promise hops; a single flush is not
// always enough to see where it lands.
async function settle() {
  for (let i = 0; i < 10; i++) await flushPromises();
}

async function mountView() {
  const w = mount(EnigmaContactsView, {
    props: { darkMode: true },
    // OyaModal teleports to <body>; stub it so modal content stays in the wrapper.
    global: { plugins: [i18n, router], stubs: { teleport: true } },
  });
  await settle();
  return w;
}

function buttonByText(w: VueWrapper, text: string) {
  const btn = w.findAll("button").find((b) => b.text().includes(text));
  expect(btn, `button "${text}"`).toBeDefined();
  return btn!;
}

const rowFor = (w: VueWrapper, nodeId: string) => {
  const li = w.findAll("li").find((l) => l.text().includes(nodeId));
  expect(li, `row ${nodeId.slice(0, 6)}`).toBeDefined();
  return li!;
};

const codeInput = (w: VueWrapper) => w.find('input[placeholder="Paste a contact code (node ID)"]');
const nameInput = (w: VueWrapper) => w.find('input[placeholder="Display name"]');

// ── my code ─────────────────────────────────────────────────────────────────

describe("my contact code", () => {
  it("shows this device's NodeId, the code a peer saves about me", async () => {
    const w = await mountView();
    const shown = w.findAll("input[readonly]").map((i) => (i.element as HTMLInputElement).value);
    expect(shown).toContain(ME);
    expect(w.text()).not.toContain("Show my node ID");
  });

  it("offers a retry when the node could not be started, and shows the code once it is", async () => {
    // ensureNode answers null when the endpoint is not up (offline, Tor) — the
    // card must not render an empty code nobody can use.
    store.p2p.ensureNode.mockResolvedValueOnce(null);
    const w = await mountView();
    expect(w.findAll("input[readonly]")).toHaveLength(0);

    await buttonByText(w, "Show my node ID").trigger("click");
    await settle();

    expect(store.p2p.ensureNode).toHaveBeenCalledTimes(2);
    const shown = w.findAll("input[readonly]").map((i) => (i.element as HTMLInputElement).value);
    expect(shown).toContain(ME);
  });
});

// ── the saved list ──────────────────────────────────────────────────────────

describe("saved contacts", () => {
  it("says there are none yet rather than showing an empty list", async () => {
    const w = await mountView();
    expect(w.text()).toContain("No contacts yet.");
  });

  it("lists every stored contact with its name and full code", async () => {
    seedContacts([
      { nodeId: ALA, name: "Ala", addedAt: 1 },
      { nodeId: BOB, name: "Bob", addedAt: 2 },
    ]);
    const w = await mountView();
    expect(rowFor(w, ALA).text()).toContain("Ala");
    expect(rowFor(w, BOB).text()).toContain("Bob");
    expect(w.text()).not.toContain("No contacts yet.");
  });

  it("renames a contact, and ignores a blank name", async () => {
    seedContacts([{ nodeId: ALA, name: "Ala", addedAt: 1 }]);
    const w = await mountView();

    await rowFor(w, ALA).find('button[title="Rename contact"]').trigger("click");
    const field = nameInput(w);
    expect((field.element as HTMLInputElement).value).toBe("Ala");

    // A blank rename would leave a row with no label at all.
    await field.setValue("   ");
    await buttonByText(w, "Save").trigger("click");
    await settle();
    expect(storedContacts()[0].name).toBe("Ala");

    await field.setValue("  Ala from work ");
    await buttonByText(w, "Save").trigger("click");
    await settle();
    expect(storedContacts()[0].name).toBe("Ala from work");
    expect(rowFor(w, ALA).text()).toContain("Ala from work");
    // The modal closed: its field is gone.
    expect(nameInput(w).exists()).toBe(false);
  });

  it("deletes only the contact whose row was used", async () => {
    seedContacts([
      { nodeId: ALA, name: "Ala", addedAt: 1 },
      { nodeId: BOB, name: "Bob", addedAt: 2 },
    ]);
    const w = await mountView();
    await rowFor(w, ALA).find('button[title="Delete contact"]').trigger("click");
    await settle();

    expect(storedContacts().map((c) => c.nodeId)).toEqual([BOB]);
    expect(w.text()).not.toContain(ALA);
  });
});

// ── adding a contact ────────────────────────────────────────────────────────

describe("adding a contact", () => {
  async function openAdd() {
    const w = await mountView();
    await buttonByText(w, "Add contact").trigger("click");
    return w;
  }
  const submit = (w: VueWrapper) =>
    w.findAll("button").filter((b) => b.text() === "Add contact").pop()!.trigger("click");

  it("refuses something that is not a contact code, and stores nothing", async () => {
    const w = await openAdd();
    await codeInput(w).setValue("hello there");
    await submit(w);
    await settle();

    expect(w.text()).toContain("That doesn't look like a contact code.");
    expect(kv.has("contacts/default/")).toBe(false);
  });

  it("refuses this device's own code", async () => {
    // Saving yourself would put a permanently "online" row in the list.
    const w = await openAdd();
    await codeInput(w).setValue(ME);
    await submit(w);
    await settle();

    expect(w.text()).toContain("That's your own contact code.");
    expect(kv.has("contacts/default/")).toBe(false);
  });

  it("normalises a pasted code and names an unnamed contact after its first 8 chars", async () => {
    const w = await openAdd();
    await codeInput(w).setValue(`  ${CAROL.toUpperCase()}\n`);
    await submit(w);
    await settle();

    const [saved] = storedContacts();
    expect(saved.nodeId).toBe(CAROL);
    expect(saved.name).toBe(CAROL.slice(0, 8));
    expect(rowFor(w, CAROL).exists()).toBe(true);
    // Closed on success.
    expect(codeInput(w).exists()).toBe(false);
  });

  it("keeps the typed name, trimmed, and puts the new contact first", async () => {
    seedContacts([{ nodeId: ALA, name: "Ala", addedAt: 1 }]);
    const w = await openAdd();
    await codeInput(w).setValue(BOB);
    await nameInput(w).setValue("  Bob  ");
    await nameInput(w).trigger("keyup.enter");
    await settle();

    expect(storedContacts().map((c) => [c.nodeId, c.name])).toEqual([
      [BOB, "Bob"],
      [ALA, "Ala"],
    ]);
  });

  it("fills the code in from a QR image", async () => {
    qr.decoded = `  ${BOB}  `;
    const w = await openAdd();
    const file = w.find('input[type="file"]');
    Object.defineProperty(file.element, "files", { value: [new File(["png"], "qr.png")], configurable: true });
    await file.trigger("change");
    await settle();

    expect((codeInput(w).element as HTMLInputElement).value).toBe(BOB);
    expect(qr.clears).toBe(1);
    expect(w.text()).not.toContain("No QR code found in that image.");
  });

  it("says so when the image holds no QR code, and leaves the field alone", async () => {
    qr.decoded = null;
    const w = await openAdd();
    await codeInput(w).setValue("partial");
    const file = w.find('input[type="file"]');
    Object.defineProperty(file.element, "files", { value: [new File(["png"], "cat.png")], configurable: true });
    await file.trigger("change");
    await settle();

    expect(w.text()).toContain("No QR code found in that image.");
    expect((codeInput(w).element as HTMLInputElement).value).toBe("partial");
  });
});

// ── presence ────────────────────────────────────────────────────────────────

describe("presence with DHT discovery on", () => {
  it("asks the DHT about every saved contact and records who was seen", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0));
    setting("dht_discovery", "on");
    seedContacts([
      { nodeId: ALA, name: "Ala", addedAt: 1 },
      { nodeId: BOB, name: "Bob", addedAt: 2, lastSeen: new Date(2026, 6, 1, 9, 30).getTime() },
    ]);
    handlers.dht_presence = () => [
      { node_id: ALA, online: true },
      { node_id: BOB, online: false },
    ];
    const w = await mountView();

    expect(callsTo("dht_presence")).toEqual([{ nodeIds: [ALA, BOB] }]);
    const dot = (id: string) => rowFor(w, id).find("span[title]");
    expect(dot(ALA).attributes("title")).toBe("Recently online (within ~1 hour)");
    expect(dot(ALA).classes()).toContain("bg-success-dark");
    expect(dot(BOB).attributes("title")).toBe("Not seen recently");
    expect(dot(BOB).classes()).not.toContain("bg-success-dark");
    // "Last seen" survives a restart because the sighting is written back.
    expect(storedContacts().find((c) => c.nodeId === ALA)?.lastSeen).toBe(Date.now());
    // An online contact needs no "last seen"; an offline one shows when.
    expect(rowFor(w, ALA).text()).not.toContain("Last seen");
    expect(rowFor(w, BOB).text()).toContain(
      `Last seen ${formatDate(new Date(2026, 6, 1, 9, 30).getTime(), "dateTime")}`,
    );
    expect(w.text()).toContain("The dot shows who published a fresh presence record");
  });

  it("re-polls on the stored cadence, and stops when the view goes away", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    setting("dht_discovery", "on");
    setting("dht_presence_poll_secs", "120");
    seedContacts([{ nodeId: ALA, name: "Ala", addedAt: 1 }]);
    const w = await mountView();
    expect(callsTo("dht_presence")).toHaveLength(1);

    vi.advanceTimersByTime(119_000);
    await settle();
    expect(callsTo("dht_presence")).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(callsTo("dht_presence")).toHaveLength(2);

    // A poll left running after the tab closes would keep querying the DHT
    // about the user's contacts for the rest of the session.
    w.unmount();
    vi.advanceTimersByTime(600_000);
    await settle();
    expect(callsTo("dht_presence")).toHaveLength(2);
  });

  it("checks a freshly added contact's presence straight away", async () => {
    setting("dht_discovery", "on");
    const w = await mountView();
    // Nothing saved yet → nothing to ask about.
    expect(callsTo("dht_presence")).toHaveLength(0);

    await buttonByText(w, "Add contact").trigger("click");
    await codeInput(w).setValue(ALA);
    await codeInput(w).trigger("keyup.enter");
    await settle();

    expect(callsTo("dht_presence")).toEqual([{ nodeIds: [ALA] }]);
  });
});

describe("presence without a usable DHT", () => {
  it("sends nothing to the DHT while discovery is off, and says how to turn it on", async () => {
    seedContacts([{ nodeId: ALA, name: "Ala", addedAt: 1 }]);
    const w = await mountView();

    expect(callsTo("dht_presence")).toHaveLength(0);
    expect(w.text()).toContain("Enable DHT discovery in Settings to see who's recently online.");
    // No presence dot is drawn at all: grey would read as "offline".
    expect(rowFor(w, ALA).find("span[title]").exists()).toBe(false);
  });

  it("treats Tor mode as no DHT even with discovery switched on", async () => {
    // Tor tears iroh down, and the DHT with it; asking anyway would fail in Rust.
    setting("dht_discovery", "on");
    handlers.app_get_use_tor = () => true;
    seedContacts([{ nodeId: ALA, name: "Ala", addedAt: 1 }]);
    const w = await mountView();

    expect(callsTo("dht_presence")).toHaveLength(0);
    // The nickname switch is gone, and search is visibly disabled with the reason.
    expect(w.find('button[role="switch"]').exists()).toBe(false);
    const search = w.find('input[placeholder="Search a nickname (exact spelling)"]');
    expect((search.element as HTMLInputElement).disabled).toBe(true);
    expect(w.text()).toContain("Enable DHT discovery in Settings to search and be findable.");
  });
});

describe("a build without the DHT", () => {
  it("has no nickname directory and no presence hint at all", async () => {
    // The off-state copy points at a Settings card this build does not have
    // (dhtGate.test.ts covers the same rule for the smaller surfaces).
    await initBuildConfig({ dht_enabled: false });
    try {
      seedContacts([{ nodeId: ALA, name: "Ala", addedAt: 1 }]);
      const w = await mountView();
      const text = w.text();
      expect(text).not.toContain("Find people");
      expect(text).not.toContain("Findable by nickname");
      expect(text).not.toContain("DHT discovery in Settings");
      // The rest of the tab is intact.
      expect(rowFor(w, ALA).exists()).toBe(true);
    } finally {
      await initBuildConfig({ dht_enabled: true });
    }
  });
});

// ── the nickname directory ──────────────────────────────────────────────────

describe("publishing my nickname", () => {
  async function mountWithDht(nick = "") {
    setting("dht_discovery", "on");
    if (nick) setting("dht_nickname", nick);
    const w = await mountView();
    const field = w.find('input[placeholder="Your public nickname"]');
    return { w, field };
  }

  it("asks before publishing and sends nothing when the user says no", async () => {
    const { w, field } = await mountWithDht();
    await field.setValue("  Ala  ");
    await buttonByText(w, "Publish").trigger("click");
    await settle();

    // The confirm is up with the publish's own price, and nothing has left yet.
    expect(hpConfirm.value?.centi).toBe(-1000);
    expect(callsTo("dht_publish_nick")).toHaveLength(0);

    resolveHpConfirm(false);
    await settle();
    expect(callsTo("dht_publish_nick")).toHaveLength(0);
    expect(callsTo("hp_charge")).toHaveLength(0);
    expect(kv.get("p2p:settings/default/dht_nick_publish")).toBeUndefined();
    expect(w.find('button[role="switch"]').attributes("aria-checked")).toBe("false");
    // The name itself is still saved (trimmed): only the publish was declined.
    expect(kv.get("p2p:settings/default/dht_nickname")).toBe("Ala");
  });

  it("publishes once confirmed, stays findable, and charges only after the write", async () => {
    const { w, field } = await mountWithDht();
    await field.setValue("Ala");
    await buttonByText(w, "Publish").trigger("click");
    await settle();
    resolveHpConfirm(true);
    await settle();

    expect(callsTo("dht_publish_nick")).toHaveLength(1);
    expect(kv.get("p2p:settings/default/dht_nick_publish")).toBe("on");
    expect(w.find('button[role="switch"]').attributes("aria-checked")).toBe("true");
    expect(w.text()).toContain("Name published");
    expect(callsTo("hp_charge")).toEqual([{ actionId: "dht.nickname.publish", bytes: null, minutes: null }]);
    const order = invokeMock.mock.calls.map((c) => c[0]);
    expect(order.indexOf("dht_publish_nick")).toBeLessThan(order.indexOf("hp_charge"));
  });

  it("reports a failed publish with the backend's reason and charges nothing", async () => {
    handlers.dht_publish_nick = () => {
      throw "DHT not bootstrapped yet";
    };
    const { w } = await mountWithDht("Ala");
    await w.find('input[placeholder="Your public nickname"]').trigger("keyup.enter");
    await settle();
    resolveHpConfirm(true);
    await settle();

    expect(w.text()).toContain("Couldn't publish the name.");
    expect(w.text()).toContain("DHT not bootstrapped yet");
    expect(w.text()).not.toContain("Name published");
    expect(callsTo("hp_charge")).toHaveLength(0);
  });

  it("does not ask or publish without a nickname", async () => {
    const { w } = await mountWithDht();
    await buttonByText(w, "Publish").trigger("click");
    await settle();

    expect(hpConfirm.value).toBeNull();
    expect(callsTo("dht_publish_nick")).toHaveLength(0);
  });

  it("switching findability on is the same confirmed publish", async () => {
    const { w } = await mountWithDht("Ala");
    await w.find('button[role="switch"]').trigger("click");
    await settle();
    expect(hpConfirm.value).not.toBeNull();
    resolveHpConfirm(true);
    await settle();

    expect(callsTo("dht_publish_nick")).toHaveLength(1);
    expect(w.text()).toContain("Name published");
  });

  it("switching it off stops the announcer at once and credits the withdrawal", async () => {
    setting("dht_nick_publish", "on");
    const { w } = await mountWithDht("Ala");
    const toggle = w.find('button[role="switch"]');
    expect(toggle.attributes("aria-checked")).toBe("true");

    await toggle.trigger("click");
    await settle();

    expect(kv.get("p2p:settings/default/dht_nick_publish")).toBe("off");
    // The rebind is what stops the refresh; without it the claim lives on until restart.
    expect(callsTo("dht_apply")).toHaveLength(1);
    expect(callsTo("hp_recover")).toEqual([{ recoveryId: "dht.nickname.withdraw" }]);
    expect(callsTo("dht_publish_nick")).toHaveLength(0);
    expect(toggle.attributes("aria-checked")).toBe("false");
  });

  it("leaves the switch inert while discovery is off", async () => {
    const w = await mountView();
    await w.find('button[role="switch"]').trigger("click");
    await settle();

    expect(hpConfirm.value).toBeNull();
    expect(kv.get("p2p:settings/default/dht_nick_publish")).toBeUndefined();
    expect(w.text()).toContain("Enable DHT discovery in Settings to search and be findable.");
    // No nickname field to type into while there is nowhere to publish it.
    expect(w.find('input[placeholder="Your public nickname"]').exists()).toBe(false);
  });
});

describe("finding people by nickname", () => {
  async function search(nick: string) {
    setting("dht_discovery", "on");
    const w = await mountView();
    await w.find('input[placeholder="Search a nickname (exact spelling)"]').setValue(nick);
    await buttonByText(w, "Search").trigger("click");
    await settle();
    return w;
  }

  it("sends the trimmed nickname and says when nobody claims it", async () => {
    const w = await search("  zed ");
    expect(callsTo("dht_find_nick")).toEqual([{ nick: "zed" }]);
    expect(w.text()).toContain("No one is currently publishing that nickname.");
  });

  it("does not search for an empty nickname", async () => {
    const w = await search("   ");
    expect(callsTo("dht_find_nick")).toHaveLength(0);
    // "No results" only after a search that actually ran.
    expect(w.text()).not.toContain("No one is currently publishing that nickname.");
  });

  it("marks my own claim and already-saved contacts, and offers the code for the rest", async () => {
    seedContacts([{ nodeId: BOB, name: "Bob", addedAt: 1 }]);
    handlers.dht_find_nick = () => [
      { node_id: ME, name: "ala", ts: 1 },
      { node_id: BOB, name: "ala", ts: 2 },
      { node_id: CAROL, name: "ala", ts: 3 },
    ];
    const w = await search("ala");

    // Every claim shows the full code: the name alone is not an identity.
    for (const id of [ME, BOB, CAROL]) expect(w.text()).toContain(id);
    const mine = w.findAll("li").find((l) => l.text().includes(ME))!;
    expect(mine.text()).toContain("you");
    expect(mine.text()).not.toContain("Use code");
    const saved = w.findAll("li").filter((l) => l.text().includes(BOB))[0];
    expect(saved.text()).toContain("Added");
    expect(saved.text()).not.toContain("Use code");
    const other = w.findAll("li").find((l) => l.text().includes(CAROL))!;
    expect(other.text()).toContain("Use code");
  });

  it("adds a found claimant only through the add form, prefilled", async () => {
    handlers.dht_find_nick = () => [{ node_id: CAROL, name: "Carol?", ts: 3 }];
    const w = await search("Carol?");
    await buttonByText(w, "Use code").trigger("click");

    // Nothing stored yet: the user still has to confirm in the modal.
    expect(kv.has("contacts/default/")).toBe(false);
    expect((codeInput(w).element as HTMLInputElement).value).toBe(CAROL);
    expect((nameInput(w).element as HTMLInputElement).value).toBe("Carol?");
  });
});

// ── direct room invites ─────────────────────────────────────────────────────

describe("inviting a contact to a room", () => {
  async function openInvite() {
    seedContacts([{ nodeId: ALA, name: "Ala", addedAt: 1 }]);
    const w = await mountView();
    await rowFor(w, ALA).find('button[title="Send room invite"]').trigger("click");
    return w;
  }

  it("offers only the rooms an invite can reach (no Tor rooms)", async () => {
    const w = await openInvite();
    expect(w.text()).toContain("Invite Ala to a room");
    expect(buttonByText(w, "Book club").exists()).toBe(true);
    expect(w.text()).not.toContain("Onion room");
  });

  it("says there is nothing to invite into when no room qualifies", async () => {
    store.p2p.p2pRooms.value = [ROOMS[1]];
    const w = await openInvite();
    expect(w.text()).toContain("No shareable rooms yet");
  });

  it("opens the room, sends the offer to that contact, and reports the acceptance", async () => {
    const w = await openInvite();
    await buttonByText(w, "Book club").trigger("click");
    await settle();

    // The room must be open first: the MLS admission runs against it.
    expect(store.p2p.openP2pRoom).toHaveBeenCalledWith(ROOMS[0]);
    expect(callsTo("invite_send")).toEqual([{ nodeId: ALA, room: "room-1", name: "Book club" }]);
    expect(w.text()).toContain("Ala accepted — they're joining the room.");
  });

  it("shows the wait while the contact decides", async () => {
    let answer!: (v: string) => void;
    handlers.invite_send = () => new Promise<string>((r) => (answer = r));
    const w = await openInvite();
    await buttonByText(w, "Book club").trigger("click");
    await settle();
    expect(w.text()).toContain("Waiting for Ala to accept…");

    answer("declined");
    await settle();
    expect(w.text()).toContain("Ala declined the invite.");
  });

  it("shows why an offer failed, and Try again goes back to the room list", async () => {
    handlers.invite_send = () => {
      throw "INVITE_UNREACHABLE: dial timed out";
    };
    const w = await openInvite();
    await buttonByText(w, "Book club").trigger("click");
    await settle();

    expect(w.text()).toContain("Couldn't reach Ala");
    expect(w.text()).toContain("INVITE_UNREACHABLE: dial timed out");

    await buttonByText(w, "Try again").trigger("click");
    expect(buttonByText(w, "Book club").exists()).toBe(true);
  });

  it("explains, in words, that the browser build cannot send direct invites", async () => {
    // Built in a plain browser, the composable has no transport and reports a
    // key; the modal must translate it rather than print "contacts.inviteUnavailable".
    const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    store.invites = useRoomInvites(store.p2p);
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = internals;
    const w = await openInvite();
    await buttonByText(w, "Book club").trigger("click");
    await settle();

    expect(w.text()).toContain("Direct invites need the desktop/mobile app.");
    expect(w.text()).not.toContain("contacts.inviteUnavailable");
    expect(callsTo("invite_send")).toHaveLength(0);
  });

  it("closing the modal forgets the last outcome", async () => {
    const w = await openInvite();
    await buttonByText(w, "Book club").trigger("click");
    await settle();
    await buttonByText(w, "Close").trigger("click");
    expect(store.invites.outgoing.value).toBe("idle");

    // Reopened, it starts on the room list again, not on "accepted".
    await rowFor(w, ALA).find('button[title="Send room invite"]').trigger("click");
    expect(w.text()).not.toContain("accepted");
    expect(buttonByText(w, "Book club").exists()).toBe(true);
  });
});

describe("an incoming invite", () => {
  function announce(fromNodeId: string) {
    listeners.get("invite://incoming")!({
      payload: { inviteId: "inv-1", fromNodeId, roomName: "Book club", invite: "sealed-invite" },
    });
  }

  it("names a known sender by their saved name", async () => {
    seedContacts([{ nodeId: ALA, name: "Ala", addedAt: 1 }]);
    const w = await mountView();
    expect(w.text()).not.toContain("Room invite");

    announce(ALA);
    await settle();
    expect(w.text()).toContain("Ala invites you to join “Book club”.");
  });

  it("names an unknown sender by a code prefix, never by a claimed name", async () => {
    const w = await mountView();
    announce(BOB);
    await settle();
    expect(w.text()).toContain(`${BOB.slice(0, 10)}… invites you to join “Book club”.`);
  });

  it("declining answers the inviter and joins nothing", async () => {
    const w = await mountView();
    announce(ALA);
    await settle();
    await buttonByText(w, "Decline").trigger("click");
    await settle();

    expect(callsTo("invite_respond")).toEqual([{ inviteId: "inv-1", accept: false }]);
    expect(callsTo("invite_redeem")).toHaveLength(0);
    expect(w.text()).not.toContain("invites you to join");
    expect(router.currentRoute.value.path).toBe("/contacts");
  });

  it("accepting answers first, redeems the invitation, and takes the user to the chat", async () => {
    handlers.invite_peek = () => ({ kind: "personal", inviter: ALA, expiresAt: 9_999_999_999_999 });
    handlers.mls_init_session = () => false;
    handlers.mls_key_package = () => [1, 2, 3];
    handlers.invite_redeem = () => ({ welcome: "V0VMQ09NRQ==", roomName: "Book club", peers: [ALA], onion: "" });
    const w = await mountView();
    announce(ALA);
    await settle();
    await buttonByText(w, "Accept").trigger("click");
    await settle();

    expect(callsTo("invite_respond")).toEqual([{ inviteId: "inv-1", accept: true }]);
    const order = invokeMock.mock.calls.map((c) => c[0]);
    // The inviter is parked on our answer; redeeming before answering would deadlock.
    expect(order.indexOf("invite_respond")).toBeLessThan(order.indexOf("invite_peek"));
    expect(callsTo("invite_peek")).toEqual([{ ticket: "sealed-invite" }]);
    expect(store.p2p.joinByInvite).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.path).toBe("/chat");
  });
});

// ── calling a contact ───────────────────────────────────────────────────────

describe("calling a contact", () => {
  it("rings the contact's NodeId and opens the Vox tab", async () => {
    seedContacts([{ nodeId: ALA, name: "Ala", addedAt: 1 }]);
    const w = await mountView();
    await rowFor(w, ALA).find('button[title="Call"]').trigger("click");
    await settle();

    expect(store.vox.callNode).toHaveBeenCalledWith(ALA, "Ala");
    expect(router.currentRoute.value.path).toBe("/vox");
  });

  it("offers no call button when the user hid the Vox tab", async () => {
    // Ringing jumps to /vox, which the route guard would bounce straight back.
    await setTabVisible("vox", false);
    seedContacts([{ nodeId: ALA, name: "Ala", addedAt: 1 }]);
    const w = await mountView();
    expect(rowFor(w, ALA).find('button[title="Call"]').exists()).toBe(false);
    expect(rowFor(w, ALA).find('button[title="Send room invite"]').exists()).toBe(true);
  });
});
