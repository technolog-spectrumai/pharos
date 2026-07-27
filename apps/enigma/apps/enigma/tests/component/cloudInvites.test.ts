import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";

// Cloud tab → Invites (cloud.md). The contract under test: you can never
// create-and-invite nobody, a create failure sends nothing, the per-recipient
// report is rendered honestly (including partial failure + retry), and the
// bearer-ticket notice is always present so the picked list is never mistaken
// for enforcement.
//
// The chat store is faked with plain `{ value }` holders — vi.hoisted runs
// before imports, so vue's ref() is unavailable there.

const { fakeP2p } = vi.hoisted(() => {
  const holder = <T>(value: T) => ({ value });
  return {
    fakeP2p: {
      p2pRooms: holder<Record<string, unknown>[]>([]),
      error: holder<string | null>(null),
      calls: [] as string[],
      createResult: "ticket-new" as string | null,
      loadP2pRooms: async () => {},
      createRoom: async (name: string) => {
        fakeP2p.calls.push(`createRoom:${name}`);
        return fakeP2p.createResult;
      },
      openP2pRoom: async (room: { room: string }) => {
        fakeP2p.calls.push(`openP2pRoom:${room.room}`);
      },
      joinByTicket: async () => {},
    },
  };
});
vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({ p2p: fakeP2p }),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return { ...actual, useRouter: () => ({ push: vi.fn() }) };
});

import CloudInvitesPanel from "../../src/components/cloud/CloudInvitesPanel.vue";
import { useCloudStore } from "../../src/stores/cloud";

type Report = {
  username: string;
  outcome: string;
  devices: number;
  delivered: number;
  error: string;
};

let pinia: ReturnType<typeof createPinia>;
let broadcastReport: Report[] = [];
/** cloud_status is authoritative over the store (the panel calls cloud.init()),
 *  so the signed-in state has to be set here, not only on the store. */
let statusLoggedIn = true;
/** Airplane mode + force-Tor both come back through invoke under fake Tauri
 *  (getOffline → app_get_offline; forceTor → cloud_status, which is
 *  authoritative over the store — see the note above). */
let statusOffline = false;
let statusForceTor = false;

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  fakeP2p.calls = [];
  fakeP2p.p2pRooms.value = [];
  fakeP2p.error.value = null;
  fakeP2p.createResult = "ticket-new";
  broadcastReport = [{ username: "alice", outcome: "ok", devices: 1, delivered: 1, error: "" }];
  statusLoggedIn = true;
  statusOffline = false;
  statusForceTor = false;
  pinia = createPinia();
  setActivePinia(pinia);
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "cloud_status":
        return {
          logged_in: statusLoggedIn,
          username: statusLoggedIn ? "me" : null,
          enabled: true,
          force_tor: statusForceTor,
          transport: statusForceTor ? "onion" : "loopback",
        };
      case "app_get_offline":
        return statusOffline;
      case "rdv_register":
        return "mynode";
      case "rdv_invite_fetch":
        return [];
      case "aster_resolve":
        return ["peer1"];
      case "rdv_invite_broadcast":
        return broadcastReport;
      default:
        return undefined;
    }
  });
});

const GLOBAL = () => ({ plugins: [i18n, pinia], stubs: { teleport: true } });

async function mountReady() {
  const cloud = useCloudStore();
  cloud.enabled = true;
  cloud.loggedIn = true;
  cloud.serverUrl = "https://localhost:8443";
  const wrapper = mount(CloudInvitesPanel, { global: GLOBAL() });
  await flushPromises();
  return wrapper;
}

/** The picker queues its resolves; settle until the chip stops "Checking…". */
async function addRecipient(wrapper: Awaited<ReturnType<typeof mountReady>>, name: string) {
  const input = wrapper.find('[data-testid="recipient-input"]');
  await input.setValue(name);
  await input.trigger("keydown.enter");
  for (let i = 0; i < 20; i++) await flushPromises();
}

describe("CloudInvitesPanel", () => {
  it("asks for a sign-in before showing anything server-shaped", async () => {
    statusLoggedIn = false;
    const cloud = useCloudStore();
    cloud.enabled = true;
    cloud.loggedIn = false;
    const wrapper = mount(CloudInvitesPanel, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.text()).toContain("Sign in above");
    expect(wrapper.find('[data-testid="leave-invite"]').exists()).toBe(false);
  });

  it("cannot create-and-invite with nobody picked", async () => {
    const wrapper = await mountReady();
    await wrapper.find('[data-testid="invite-create-name"]').setValue("planning");
    await wrapper.find('[data-testid="invite-create-submit"]').trigger("click");
    await flushPromises();
    expect(fakeP2p.calls).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalledWith("rdv_invite_broadcast", expect.anything());
  });

  it("creates the room first, then broadcasts once with the picked usernames", async () => {
    const wrapper = await mountReady();
    await addRecipient(wrapper, "alice");
    await wrapper.find('[data-testid="invite-create-name"]').setValue("planning");
    await wrapper.find('[data-testid="invite-create-submit"]').trigger("click");
    await flushPromises();

    expect(fakeP2p.calls).toEqual(["createRoom:planning"]);
    const call = invokeMock.mock.calls.find(([c]) => c === "rdv_invite_broadcast");
    expect(call).toBeTruthy();
    expect(call![1]).toEqual({
      serverUrl: "https://localhost:8443",
      usernames: ["alice"],
      roomName: "planning",
      ticket: "ticket-new",
    });
    // TTL is deliberately not sent — Rust's default is the server's own cap.
    expect(call![1]).not.toHaveProperty("ttlSeconds");
    expect(wrapper.find('[data-testid="invite-results"]').text()).toContain("everyone you picked");
  });

  it("sends nothing when the room could not be created", async () => {
    fakeP2p.createResult = null;
    const wrapper = await mountReady();
    await addRecipient(wrapper, "alice");
    await wrapper.find('[data-testid="invite-create-name"]').setValue("doomed");
    await wrapper.find('[data-testid="invite-create-submit"]').trigger("click");
    await flushPromises();
    expect(invokeMock).not.toHaveBeenCalledWith("rdv_invite_broadcast", expect.anything());
    expect(wrapper.text()).toContain("could not be created");
  });

  it("renders every per-recipient outcome and retries only the failures", async () => {
    broadcastReport = [
      { username: "alice", outcome: "ok", devices: 1, delivered: 1, error: "" },
      { username: "ghost", outcome: "unknown", devices: 0, delivered: 0, error: "" },
      { username: "bob", outcome: "quota", devices: 2, delivered: 0, error: "429" },
      { username: "carol", outcome: "skipped", devices: 0, delivered: 0, error: "" },
    ];
    const wrapper = await mountReady();
    for (const n of ["alice", "ghost", "bob", "carol"]) await addRecipient(wrapper, n);
    await wrapper.find('[data-testid="invite-create-name"]').setValue("planning");
    await wrapper.find('[data-testid="invite-create-submit"]').trigger("click");
    await flushPromises();

    const results = wrapper.find('[data-testid="invite-results"]');
    expect(results.text()).toContain("1 of 4");
    for (const n of ["alice", "ghost", "bob", "carol"]) {
      expect(wrapper.find(`[data-testid="invite-result-${n}"]`).exists()).toBe(true);
    }
    expect(results.text()).toContain("No such user on this server");
    expect(results.text()).toContain("too many unclaimed invites");

    await wrapper.find('[data-testid="invite-retry-failed"]').trigger("click");
    await flushPromises();
    // The one that succeeded is dropped so nobody gets a duplicate.
    expect(wrapper.find('[data-testid="recipient-chip-alice"]').exists()).toBe(false);
    for (const n of ["ghost", "bob", "carol"]) {
      expect(wrapper.find(`[data-testid="recipient-chip-${n}"]`).exists()).toBe(true);
    }
  });

  it("retries only people who received nothing — a partial delivery is left alone", async () => {
    // faros' two 429s are different animals: `full` is THEIR mailbox (the rest
    // of the list still went out) and only `quota` is our own budget. Neither
    // may drag a `partial` into the retry — one of their devices already holds
    // a working invite, and the report carries counts, not NodeIds.
    broadcastReport = [
      { username: "alice", outcome: "partial", devices: 2, delivered: 1, error: "" },
      { username: "bob", outcome: "full", devices: 1, delivered: 0, error: "box full" },
      { username: "carol", outcome: "ok", devices: 1, delivered: 1, error: "" },
    ];
    const wrapper = await mountReady();
    for (const n of ["alice", "bob", "carol"]) await addRecipient(wrapper, n);
    await wrapper.find('[data-testid="invite-create-name"]').setValue("planning");
    await wrapper.find('[data-testid="invite-create-submit"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="invite-results"]').text()).toContain("invite box is full");

    await wrapper.find('[data-testid="invite-retry-failed"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="recipient-chip-bob"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="recipient-chip-alice"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="recipient-chip-carol"]').exists()).toBe(false);
  });

  it("says the room still exists even when the whole broadcast fails", async () => {
    const wrapper = await mountReady();
    await addRecipient(wrapper, "alice");
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "rdv_invite_broadcast") throw "server unreachable";
      if (cmd === "aster_resolve") return ["peer1"];
      return undefined;
    });
    await wrapper.find('[data-testid="invite-create-name"]').setValue("planning");
    await wrapper.find('[data-testid="invite-create-submit"]').trigger("click");
    await flushPromises();
    // No results block to hide behind — the reassurance must still render.
    expect(wrapper.find('[data-testid="invite-results"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="invite-room-created"]').text()).toContain("planning");
    expect(wrapper.text()).toContain("server unreachable");
  });

  it("opens an existing room before broadcasting, and offers direct rooms too", async () => {
    fakeP2p.p2pRooms.value = [
      { room: "r-tor", name: "onion room", ticket: "t-tor", tor: true },
      { room: "r-iroh", name: "direct room", ticket: "t-iroh", tor: false },
      { room: "r-none", name: "ticketless", ticket: "", tor: false },
    ];
    const wrapper = await mountReady();
    await addRecipient(wrapper, "alice");
    const select = wrapper.find('[data-testid="invite-room-select"]');
    // Ticketless rooms cannot be sealed, so they are not offered.
    expect(select.findAll("option")).toHaveLength(3); // placeholder + two rooms
    expect(select.text()).toContain("onion room");
    expect(select.text()).toContain("direct room");
    expect(select.text()).not.toContain("ticketless");

    await select.setValue("r-iroh");
    await wrapper.find('[data-testid="invite-existing-submit"]').trigger("click");
    await flushPromises();
    expect(fakeP2p.calls).toEqual(["openP2pRoom:r-iroh"]);
    const call = invokeMock.mock.calls.find(([c]) => c === "rdv_invite_broadcast");
    expect(call![1]).toMatchObject({ roomName: "direct room", ticket: "t-iroh" });
  });

  it("always states that the ticket, not the list, decides who can join", async () => {
    const wrapper = await mountReady();
    expect(wrapper.find('[data-testid="invite-bearer-notice"]').text())
      .toContain("does not check who walks in");
    // The username-trust caveat appears once there is someone to send to.
    expect(wrapper.find('[data-testid="invite-username-notice"]').exists()).toBe(false);
    await addRecipient(wrapper, "alice");
    expect(wrapper.find('[data-testid="invite-username-notice"]').text())
      .toContain("dishonest server");
  });

  it("picks the session up when sign-in lands after mount", async () => {
    statusLoggedIn = false;
    const cloud = useCloudStore();
    cloud.enabled = true;
    cloud.loggedIn = false;
    cloud.serverUrl = "https://localhost:8443";
    mount(CloudInvitesPanel, { global: GLOBAL() });
    await flushPromises();
    invokeMock.mockClear();
    cloud.loggedIn = true;
    await flushPromises();
    await flushPromises();
    expect(invokeMock).toHaveBeenCalledWith("rdv_register", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("rdv_invite_fetch", expect.anything());
  });
});

// ── "the cloud is offline" ────────────────────────────────────────────────────
// Four independent reasons the panel can be unusable. The point of these is not
// that a press fails — it already did — but that the panel SAYS SO BEFORE the
// press, and that the way back is never itself blocked.
describe("CloudInvitesPanel — unusable cloud", () => {
  /** Airplane mode has no event, so the panel re-reads it on mount. */
  function airplaneOn() {
    statusOffline = true;
  }

  it("airplane mode states the reason instead of the sign-in hint", async () => {
    airplaneOn();
    const wrapper = await mountReady();
    const card = wrapper.find('[data-testid="invites-blocked-notice"]');
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain("airplane mode");
    // Signing in is itself a cloud request, so the login hint would be useless
    // advice here — the airplane reason has to outrank it.
    expect(wrapper.text()).not.toContain("Sign in above");
  });

  it("airplane mode disables both submits", async () => {
    airplaneOn();
    fakeP2p.p2pRooms.value = [{ room: "r1", name: "planning", ticket: "t1", peers: [] }];
    const wrapper = await mountReady();
    await addRecipient(wrapper, "alice");
    expect(wrapper.find('[data-testid="invite-create-submit"]').classes()).toContain(
      "pointer-events-none",
    );
    expect(wrapper.find('[data-testid="invite-existing-submit"]').classes()).toContain(
      "pointer-events-none",
    );
  });

  it("airplane mode while signed out shows the airplane reason, not the login one", async () => {
    airplaneOn();
    statusLoggedIn = false;
    const cloud = useCloudStore();
    cloud.enabled = true;
    cloud.loggedIn = false;
    cloud.serverUrl = "https://localhost:8443";
    const wrapper = mount(CloudInvitesPanel, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.find('[data-testid="invites-blocked-card"]').text()).toContain("airplane mode");
  });

  it("a server that does not answer disables the submits and says why", async () => {
    const wrapper = await mountReady();
    await addRecipient(wrapper, "alice");
    // A chip resolved while the server was up; now it goes away.
    useCloudStore().classify("unreachable: connect to h:443 failed: refused");
    await flushPromises();

    const notice = wrapper.find('[data-testid="invites-blocked-notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain("Couldn't reach your server");
    expect(wrapper.find('[data-testid="invite-create-submit"]').classes()).toContain(
      "pointer-events-none",
    );
  });

  it("an unreachable server cannot create an orphan room", async () => {
    const wrapper = await mountReady();
    await addRecipient(wrapper, "alice");
    useCloudStore().classify("unreachable: connect to h:443 failed: refused");
    await flushPromises();

    await wrapper.find('[data-testid="invite-create-name"]').setValue("planning");
    await wrapper.find('[data-testid="invite-create-submit"]').trigger("click");
    await flushPromises();

    // The old failure mode: the room was created locally, the broadcast then
    // "succeeded" with all-error rows, and the user kept a room nobody got.
    expect(fakeP2p.calls).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalledWith("rdv_invite_broadcast", expect.anything());
  });

  it("Enter in the room-name field is gated too, not just the button", async () => {
    const wrapper = await mountReady();
    await addRecipient(wrapper, "alice");
    useCloudStore().classify("unreachable: connect to h:443 timed out after 60s");
    await flushPromises();

    const name = wrapper.find('[data-testid="invite-create-name"]');
    await name.setValue("planning");
    await name.trigger("keyup.enter");
    await flushPromises();

    expect(fakeP2p.calls).toEqual([]);
  });

  it("the retry stays live — an unreachable verdict is one press from undone", async () => {
    const wrapper = await mountReady();
    useCloudStore().classify("unreachable: connect to h:443 failed: refused");
    await flushPromises();

    const retry = wrapper.find('[data-testid="invites-retry"]');
    expect(retry.exists()).toBe(true);
    // The one control `blocked` must never gate: a cold arti bootstrap can
    // exceed the timeout on a healthy server (cloud.md), so a false verdict
    // must always be recoverable without restarting the app.
    expect(retry.classes()).not.toContain("pointer-events-none");
  });

  it("retrying re-attempts and recovers when the server comes back", async () => {
    const wrapper = await mountReady();
    const cloud = useCloudStore();
    cloud.classify("unreachable: connect to h:443 failed: refused");
    await flushPromises();
    expect(wrapper.find('[data-testid="invites-blocked-notice"]').exists()).toBe(true);

    await wrapper.find('[data-testid="invites-retry"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("rdv_register", expect.anything());
    expect(cloud.reachable).toBe(true);
    expect(wrapper.find('[data-testid="invites-blocked-notice"]').exists()).toBe(false);
  });

  it("the inbox says it could not ask, rather than 'no invites waiting'", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "cloud_status") {
        return { logged_in: true, username: "me", enabled: true, force_tor: false, transport: "loopback" };
      }
      if (cmd === "rdv_invite_fetch") throw "unreachable: connect to h:443 failed: refused";
      if (cmd === "rdv_register") return "mynode";
      return undefined;
    });
    const wrapper = await mountReady();

    expect(wrapper.find('[data-testid="invites-inbox-error"]').exists()).toBe(true);
    // "No invites waiting" would read as "nobody invited you" — a different fact.
    expect(wrapper.find('[data-testid="server-invites"]').text()).not.toContain("No invites waiting");
  });

  it("a failed inbox fetch is itself enough to gate the submits", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "cloud_status") {
        return { logged_in: true, username: "me", enabled: true, force_tor: false, transport: "loopback" };
      }
      if (cmd === "rdv_invite_fetch") throw "unreachable: connect to h:443 failed: refused";
      if (cmd === "rdv_register") return "mynode";
      return undefined;
    });
    const wrapper = await mountReady();

    // No extra request was needed to learn this: the mount fetch already ran.
    expect(useCloudStore().reachable).toBe(false);
    expect(wrapper.find('[data-testid="invites-blocked-notice"]').exists()).toBe(true);
  });

  it("Tor gets its own wording — a slow first request is expected there", async () => {
    statusForceTor = true;
    const cloud = useCloudStore();
    cloud.enabled = true;
    cloud.loggedIn = true;
    cloud.serverUrl = "https://x.onion";
    const wrapper = mount(CloudInvitesPanel, { global: GLOBAL() });
    await flushPromises();
    cloud.classify("unreachable: connect to x.onion:443 timed out after 60s");
    await flushPromises();

    expect(wrapper.find('[data-testid="invites-blocked-notice"]').text()).toContain("Over Tor");
  });

  it("a healthy cloud shows no blocked notice at all", async () => {
    const wrapper = await mountReady();
    expect(wrapper.find('[data-testid="invites-blocked-notice"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="invites-inbox-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="leave-invite"]').exists()).toBe(true);
  });
});
