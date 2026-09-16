// Editing with the server gone, and reconciling when it comes back.
//
// The four claims worth testing, because each is a way the feature could
// quietly destroy work rather than merely fail:
//
//   1. a network failure opens the cached copy; a 403 does NOT
//   2. an offline save is kept, and is NOT marked as saved on the server
//   3. reconnecting pushes the queue
//   4. a file the server changed underneath us is REPORTED, never merged
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type ApiClient, type CacheStore } from "totoapi";
import {
  workspaceState, open, openFile, edit, save, syncPending, useCache,
  __resetForTests,
} from "../../src/platform/workspace";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

const WS = {
  slug: "notebook", name: "Notebook", kind: "python", namespace: "dracena",
  owner: "janek", writable: true, created_at: "2026-09-10T00:00:00Z",
  can_execute: true,
};

const FILE = {
  pk: 7, name: "main.py", content: "print(1)",
  truncated: false, readonly: false,
};

/** A server that can be switched off mid-test. */
function server(routes: Record<string, [number, unknown]>) {
  const box = { online: true };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!box.online) throw new TypeError("Failed to fetch");
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    const hit = routes[key];
    if (!hit) return jsonResponse(404, { error: `no route ${key}`, code: "" });
    return jsonResponse(hit[0], hit[1]);
  });
  const client = createClient({
    baseUrl: "https://zen.test",
    getToken: () => null,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, box, routes };
}

function memoryCache(): CacheStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    async get(k) { return raw.get(k) ?? null; },
    async set(k, v) { raw.set(k, v); },
    async remove(k) { raw.delete(k); },
    async keys() { return [...raw.keys()]; },
  };
}

const ROUTES: Record<string, [number, unknown]> = {
  "GET /api/v1/workspaces/notebook": [200, WS],
  "GET /api/v1/workspaces/notebook/tree": [200, { items: [] }],
  "GET /api/v1/workspaces/notebook/files/7": [200, FILE],
  "POST /api/v1/workspaces/notebook/files/7/save": [200, { saved: true }],
};

/** Open the workspace and its one file, online, so the cache is warm. */
async function warm(client: ApiClient) {
  await open(client, "notebook");
  await openFile(client, 7);
}

beforeEach(() => {
  __resetForTests();
});

describe("going offline", () => {
  it("opens the cached copy when the network is gone", async () => {
    const cache = memoryCache();
    useCache(cache);
    const { client, box } = server(ROUTES);
    await warm(client);

    __resetForTests();
    useCache(cache);
    box.online = false;

    await open(client, "notebook");
    expect(workspaceState.offline).toBe(true);
    expect(workspaceState.current?.slug).toBe("notebook");
  });

  it("does NOT go offline when the server refuses", async () => {
    // THE DISTINCTION THAT MATTERS. A 403 is the server answering. Quietly
    // opening a cached copy would hide a permission problem behind a cache and
    // let somebody edit a workspace they have lost access to.
    const cache = memoryCache();
    useCache(cache);
    const { client } = server(ROUTES);
    await warm(client);

    __resetForTests();
    useCache(cache);
    const refusing = server({
      "GET /api/v1/workspaces/notebook": [403, { error: "nope", code: "" }],
    });

    await expect(open(refusing.client, "notebook")).rejects.toThrow();
    expect(workspaceState.offline).toBe(false);
  });

  it("reports the network failure when nothing is cached", async () => {
    useCache(memoryCache());
    const { client, box } = server(ROUTES);
    box.online = false;
    await expect(open(client, "notebook")).rejects.toThrow();
  });

  it("opens a cached FILE with the server gone", async () => {
    const cache = memoryCache();
    useCache(cache);
    const { client, box } = server(ROUTES);
    await warm(client);

    __resetForTests();
    useCache(cache);
    box.online = false;
    await open(client, "notebook");
    const buffer = await openFile(client, 7);
    expect(buffer.text).toBe(FILE.content);
  });
});

describe("saving while offline", () => {
  it("keeps the text but does not pretend it reached the server", async () => {
    // `saved` is what the server confirmed. Moving it here would mark the
    // buffer clean, and the edit would then be dropped on the next open —
    // losing exactly the work this feature exists to keep.
    const cache = memoryCache();
    useCache(cache);
    const { client, box } = server(ROUTES);
    await warm(client);

    box.online = false;
    edit(7, "edited on a train");
    await save(client, 7);

    const buffer = workspaceState.buffers.find((b) => b.pk === 7);
    expect(workspaceState.offline).toBe(true);
    expect(buffer?.text).toBe("edited on a train");
    expect(buffer?.saved).toBe(FILE.content);
    expect(workspaceState.error).toBe("");
  });

  it("counts what is waiting", async () => {
    const cache = memoryCache();
    useCache(cache);
    const { client, box } = server(ROUTES);
    await warm(client);

    box.online = false;
    edit(7, "pending work");
    await save(client, 7);
    expect(workspaceState.pendingCount).toBe(1);
  });
});

describe("coming back", () => {
  it("pushes what was edited offline", async () => {
    const cache = memoryCache();
    useCache(cache);
    const { client, box } = server(ROUTES);
    await warm(client);

    box.online = false;
    edit(7, "written offline");
    await save(client, 7);

    box.online = true;
    const conflicts = await syncPending(client);

    expect(conflicts).toEqual([]);
    expect(workspaceState.offline).toBe(false);
    expect(workspaceState.buffers.find((b) => b.pk === 7)?.saved)
      .toBe("written offline");
  });

  it("reports a conflict instead of overwriting somebody else's work", async () => {
    // THE ONE THAT MUST NEVER SILENTLY RESOLVE. Two afternoons, one file;
    // picking a winner automatically means throwing one away without telling
    // the person it existed.
    const cache = memoryCache();
    useCache(cache);
    const moved = { ...ROUTES };
    const { client, box } = server(moved);
    await warm(client);

    box.online = false;
    edit(7, "my version");
    await save(client, 7);

    // Somebody else saved while we were away.
    moved["GET /api/v1/workspaces/notebook/files/7"] =
      [200, { ...FILE, content: "their version" }];
    box.online = true;

    const conflicts = await syncPending(client);
    expect(conflicts).toEqual(["main.py"]);
    // Still pending — nothing was pushed and nothing was discarded.
    expect(workspaceState.pendingCount).toBe(1);
  });

  it("keeps the queue when the server is still away", async () => {
    const cache = memoryCache();
    useCache(cache);
    const { client, box } = server(ROUTES);
    await warm(client);

    box.online = false;
    edit(7, "still waiting");
    await save(client, 7);
    await syncPending(client);

    expect(workspaceState.pendingCount).toBe(1);
  });
});

describe("re-reading online never discards an offline edit", () => {
  it("keeps the local text and refreshes the baseline", async () => {
    const cache = memoryCache();
    useCache(cache);
    const { client, box } = server(ROUTES);
    await warm(client);

    box.online = false;
    edit(7, "typed on the train");
    await save(client, 7);

    // Reconnect and re-open the file from scratch.
    box.online = true;
    __resetForTests();
    useCache(cache);
    await open(client, "notebook");
    const buffer = await openFile(client, 7);

    expect(buffer.text).toBe("typed on the train");
    expect(buffer.saved).toBe(FILE.content);
  });
});

describe("with no cache attached at all", () => {
  it("behaves exactly as it did before offline editing existed", async () => {
    useCache(null);
    const { client, box } = server(ROUTES);
    await warm(client);
    box.online = false;
    await expect(open(client, "notebook")).rejects.toThrow();
  });
});
