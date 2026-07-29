import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  CLOUD_SERVER_URL_DEFAULT,
  CloudServerError,
  normalizeCloudServerUrl,
  cloudServerDefaultName,
  sameCloudServer,
  readCloudServers,
  listCloudServers,
  getActiveCloudServer,
  setActiveCloudServer,
  addCloudServer,
  updateCloudServer,
  removeCloudServer,
  getCloudServerUrl,
  setCloudServerUrl,
} from "../../src/services/appStorage";
import { kvGet, kvPut } from "../../src/services/localDb";

// jsdom has no Tauri runtime, so this exercises the localStorage kv backend —
// the same path the browser build uses.
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const NS = "cloud:settings";
const SCOPE = "default";

async function rawServers(): Promise<unknown> {
  return JSON.parse((await kvGet(NS, SCOPE, "servers")) ?? "null");
}

describe("normalizeCloudServerUrl — FROZEN, must match cloud.rs::normalize_scope", () => {
  it("trims and strips trailing slashes only", () => {
    expect(normalizeCloudServerUrl(" https://localhost:8443/ ")).toBe("https://localhost:8443");
    expect(normalizeCloudServerUrl("https://x.onion///")).toBe("https://x.onion");
    expect(normalizeCloudServerUrl("http://h:9000")).toBe("http://h:9000");
  });

  it("falls back to the default when empty", () => {
    expect(normalizeCloudServerUrl("")).toBe(CLOUD_SERVER_URL_DEFAULT);
    expect(normalizeCloudServerUrl("   ")).toBe(CLOUD_SERVER_URL_DEFAULT);
  });

  // These are the cases we deliberately do NOT collapse. Changing any of them
  // would orphan every already-stored cloud:auth token (nothing can enumerate
  // kv scopes), and would have to land in cloud.rs in the same commit.
  it("does NOT strip default ports, lowercase, or drop userinfo", () => {
    expect(normalizeCloudServerUrl("https://localhost:443")).toBe("https://localhost:443");
    expect(normalizeCloudServerUrl("https://localhost")).toBe("https://localhost");
    expect(normalizeCloudServerUrl("https://LOCALHOST:443")).toBe("https://LOCALHOST:443");
    expect(normalizeCloudServerUrl("https://user@localhost:443")).toBe("https://user@localhost:443");
  });
});

describe("sameCloudServer — display-only collision warning", () => {
  it("sees through default ports and host case", () => {
    expect(sameCloudServer("https://localhost:443", "https://localhost")).toBe(true);
    expect(sameCloudServer("https://LOCALHOST", "https://localhost:443")).toBe(true);
    expect(sameCloudServer("http://h", "http://h:80")).toBe(true);
  });

  it("still separates genuinely different servers", () => {
    expect(sameCloudServer("https://localhost:8443", "https://localhost:443")).toBe(false);
    expect(sameCloudServer("https://a.onion", "https://b.onion")).toBe(false);
    expect(sameCloudServer("https://h/base", "https://h")).toBe(false);
    // A scheme downgrade is a different endpoint, not the same server.
    expect(sameCloudServer("https://h:443", "http://h:443")).toBe(false);
  });
});

describe("cloudServerDefaultName", () => {
  it("uses the host, keeping a non-default port", () => {
    expect(cloudServerDefaultName("https://localhost:8443")).toBe("localhost:8443");
    expect(cloudServerDefaultName("https://localhost:443")).toBe("localhost");
    expect(cloudServerDefaultName("https://abc.onion")).toBe("abc.onion");
    expect(cloudServerDefaultName("http://h:80")).toBe("h");
  });
});

describe("registry seeding", () => {
  it("seeds one entry from the legacy server_url key, preserving it", async () => {
    await kvPut(NS, SCOPE, "server_url", "https://localhost:443");
    const state = await readCloudServers();
    expect(state.state).toBe("loaded");
    if (state.state !== "loaded") return;
    expect(state.servers).toHaveLength(1);
    expect(state.servers[0].url).toBe("https://localhost:443");
    expect(state.servers[0].name).toBe("localhost");
    expect(state.activeId).toBe(state.servers[0].id);
  });

  it("seeds the default when nothing was ever configured", async () => {
    const servers = await listCloudServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].url).toBe(CLOUD_SERVER_URL_DEFAULT);
  });

  it("is idempotent — a second read does not duplicate the entry", async () => {
    const first = await listCloudServers();
    const second = await listCloudServers();
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
  });

  it("re-seeds from a garbled blob instead of throwing", async () => {
    await kvPut(NS, SCOPE, "servers", "{not json");
    await kvPut(NS, SCOPE, "server_url", "https://recovered:8443");
    const servers = await listCloudServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].url).toBe("https://recovered:8443");
  });

  it("drops malformed entries but keeps the well-formed ones", async () => {
    await kvPut(
      NS,
      SCOPE,
      "servers",
      JSON.stringify([{ id: "a", name: "ok", url: "https://a" }, { name: "no id" }, { id: "c" }, null]),
    );
    const servers = await listCloudServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe("a");
  });

  it("an active_server naming no entry falls back to the first", async () => {
    await kvPut(NS, SCOPE, "servers", JSON.stringify([{ id: "a", name: "A", url: "https://a" }]));
    await kvPut(NS, SCOPE, "active_server", "ghost");
    const state = await readCloudServers();
    expect(state.state === "loaded" && state.activeId).toBe("a");
  });
});

describe("registry fails CLOSED when the store cannot be read", () => {
  // A locked vault must never resolve to CLOUD_SERVER_URL_DEFAULT — that is
  // faros' address, so a fail-open would point a login press at a server the
  // user never chose, and would persist a connection they never made.
  it("reports unreadable and writes nothing", async () => {
    const store = Object.getPrototypeOf(localStorage) as Storage;
    const spy = vi.spyOn(store, "getItem").mockImplementation(() => {
      throw new Error("vault locked");
    });
    const state = await readCloudServers();
    expect(state).toEqual({ state: "unreadable" });
    spy.mockRestore();
    expect(await rawServers()).toBeNull();
  });

  it("getActiveCloudServer returns null rather than a guess", async () => {
    const store = Object.getPrototypeOf(localStorage) as Storage;
    const spy = vi.spyOn(store, "getItem").mockImplementation(() => {
      throw new Error("vault locked");
    });
    expect(await getActiveCloudServer()).toBeNull();
    spy.mockRestore();
  });
});

describe("registry mutations", () => {
  it("adds, activates and mirrors server_url", async () => {
    const first = (await listCloudServers())[0];
    const zen = await addCloudServer("zenobia", "https://localhost:443/");
    expect(zen.url).toBe("https://localhost:443");
    expect(await listCloudServers()).toHaveLength(2);

    // Adding does not steal the active slot; activating is explicit.
    expect((await getActiveCloudServer())?.id).toBe(first.id);
    await setActiveCloudServer(zen.id);
    expect((await getActiveCloudServer())?.id).toBe(zen.id);
    expect(await kvGet(NS, SCOPE, "server_url")).toBe("https://localhost:443");
    expect(await getCloudServerUrl()).toBe("https://localhost:443");
  });

  it("renames without touching the URL, and re-mirrors on a URL edit", async () => {
    const a = (await listCloudServers())[0];
    await updateCloudServer(a.id, { name: "faros" });
    expect((await listCloudServers())[0]).toMatchObject({ name: "faros", url: a.url });

    await updateCloudServer(a.id, { url: "https://moved:9000" });
    expect(await kvGet(NS, SCOPE, "server_url")).toBe("https://moved:9000");
  });

  it("an empty name falls back to the host", async () => {
    const entry = await addCloudServer("   ", "https://abc.onion");
    expect(entry.name).toBe("abc.onion");
  });

  it("rejects a duplicate normalized URL on add and on edit", async () => {
    const a = (await listCloudServers())[0];
    await expect(addCloudServer("dupe", `${a.url}/`)).rejects.toBeInstanceOf(CloudServerError);
    const b = await addCloudServer("other", "https://other:1");
    await expect(updateCloudServer(b.id, { url: a.url })).rejects.toBeInstanceOf(CloudServerError);
    // Re-saving an entry's own URL is not a duplicate.
    await expect(updateCloudServer(b.id, { url: "https://other:1" })).resolves.toBeTruthy();
  });

  it("refuses to remove the last connection", async () => {
    const a = (await listCloudServers())[0];
    await expect(removeCloudServer(a.id)).rejects.toBeInstanceOf(CloudServerError);
  });

  it("removing the active one hands over to a neighbour and re-mirrors", async () => {
    const a = (await listCloudServers())[0];
    const b = await addCloudServer("b", "https://b:1");
    await setActiveCloudServer(a.id);
    const next = await removeCloudServer(a.id);
    expect(next.id).toBe(b.id);
    expect((await getActiveCloudServer())?.id).toBe(b.id);
    expect(await kvGet(NS, SCOPE, "server_url")).toBe("https://b:1");
  });

  it("removing a NON-active one leaves the active connection alone", async () => {
    const a = (await listCloudServers())[0];
    const b = await addCloudServer("b", "https://b:1");
    await setActiveCloudServer(a.id);
    await removeCloudServer(b.id);
    expect((await getActiveCloudServer())?.id).toBe(a.id);
    expect(await kvGet(NS, SCOPE, "server_url")).toBe(a.url);
  });

  it("activating an unknown id throws rather than silently doing nothing", async () => {
    await listCloudServers();
    await expect(setActiveCloudServer("ghost")).rejects.toBeInstanceOf(CloudServerError);
  });
});

describe("server_url stays a faithful mirror of the active entry", () => {
  // The compatibility invariant the whole design rests on: getCloudServerUrl()
  // and every existing reader must agree with the registry after EVERY mutation.
  it("holds across add / activate / edit / remove", async () => {
    const check = async () => {
      const active = await getActiveCloudServer();
      expect(await kvGet(NS, SCOPE, "server_url")).toBe(active?.url);
      expect(await getCloudServerUrl()).toBe(active?.url);
    };
    await listCloudServers();
    await check();
    const b = await addCloudServer("b", "https://b:1");
    await check();
    await setActiveCloudServer(b.id);
    await check();
    await updateCloudServer(b.id, { url: "https://b:2" });
    await check();
    await removeCloudServer(b.id);
    await check();
  });

  it("setCloudServerUrl edits the ACTIVE entry rather than desyncing the blob", async () => {
    const a = (await listCloudServers())[0];
    const out = await setCloudServerUrl("https://edited:7/");
    expect(out).toBe("https://edited:7");
    const servers = await listCloudServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ id: a.id, url: "https://edited:7" });
    expect(await kvGet(NS, SCOPE, "server_url")).toBe("https://edited:7");
  });
});
