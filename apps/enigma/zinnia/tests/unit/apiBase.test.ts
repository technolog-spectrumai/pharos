import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the storage layer so ApiBase has a deterministic base URL + token.
const setAuthToken = vi.fn(async () => {});
const clearAuthToken = vi.fn(async () => {});
const isServerDataBlocked = vi.fn(async () => false);
vi.mock("../../src/services/appStorage", () => ({
  getServerUrl: vi.fn(async () => "http://test.local/"),
  getAuthToken: vi.fn(async () => "tok123"),
  isServerDataBlocked: (...a: any[]) => isServerDataBlocked(...a),
  setAuthToken: (...a: any[]) => setAuthToken(...a),
  clearAuthToken: (...a: any[]) => clearAuthToken(...a),
}));

import { ApiBase, httpErrorMessage, normalizeApiError } from "../../src/services/apiBase";

const api = new ApiBase();

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  // @ts-expect-error - jsdom global
  global.fetch = fetchMock;
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, headers: (init?.headers ?? {}) as Record<string, string> };
}

beforeEach(() => {
  localStorage.clear(); // wipe the offline response cache between tests
  setAuthToken.mockClear();
  clearAuthToken.mockClear();
  isServerDataBlocked.mockClear();
  isServerDataBlocked.mockResolvedValue(false);
});

describe("ApiBase request building", () => {
  it("GET getRooms hits the right URL with a Bearer token and JSON headers", async () => {
    const f = mockFetchOnce({ channels: [] });
    await api.getRooms();
    const { url, headers } = lastCall(f);
    expect(url).toBe("http://test.local/telegraph/api/channels/");
    expect(headers.Authorization).toBe("Bearer tok123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("GET getRoom targets the channel-detail endpoint", async () => {
    const f = mockFetchOnce({ slug: "general" });
    await api.getRoom("general");
    expect(lastCall(f).url).toBe("http://test.local/telegraph/api/channels/general/");
  });

  it("PATCH setLanguage sends the language to the me endpoint", async () => {
    const f = mockFetchOnce({ ok: true, language: "pl", stored: true });
    const res = await api.setLanguage("pl");
    const { url, init } = lastCall(f);
    expect(url).toBe("http://test.local/telegraph/api/me/");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ language: "pl" });
    expect(res.stored).toBe(true);
  });

  it("login posts credentials then stores the returned token", async () => {
    const f = mockFetchOnce({ ok: true, token: "sess-xyz" });
    await api.login("alice", "secret");
    const { url, init } = lastCall(f);
    expect(url).toBe("http://test.local/telegraph/api/login/");
    expect(init.method).toBe("POST");
    expect(setAuthToken).toHaveBeenCalledWith("sess-xyz");
  });

  it("health is sent without an Authorization header", async () => {
    const f = mockFetchOnce({ ok: true, service: "telegraph" });
    await api.health();
    expect(lastCall(f).headers.Authorization).toBeUndefined();
  });

  it("surfaces the server's error message on a non-OK response", async () => {
    mockFetchOnce({ error: "nope" }, false, 404);
    await expect(api.getRooms()).rejects.toThrow(/nope/);
  });

  it("falls back to status + body when there is no error field", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false, status: 500, statusText: "ERR",
      json: async () => ({}), text: async () => "boom",
    }));
    // @ts-expect-error jsdom global
    global.fetch = fetchMock;
    await expect(api.getRooms()).rejects.toThrow(/500: boom/);
  });

  it("login throws (not silently succeeds) when no token is returned", async () => {
    mockFetchOnce({ ok: true }); // 2xx but no token
    await expect(api.login("alice", "secret")).rejects.toThrow(/no session token/i);
    expect(setAuthToken).not.toHaveBeenCalled();
  });
});

describe("API error normalization", () => {
  it("httpErrorMessage prefers the server's error/detail field", () => {
    expect(httpErrorMessage(401, '{"error":"Invalid credentials."}')).toBe("Invalid credentials.");
    expect(httpErrorMessage(400, '{"detail":"bad"}')).toBe("bad");
  });

  it("httpErrorMessage falls back for non-JSON / empty bodies", () => {
    expect(httpErrorMessage(500, "boom")).toBe("500: boom");
    expect(httpErrorMessage(403, "")).toBe("Not authorized.");
    expect(httpErrorMessage(502, "")).toMatch(/HTTP 502/);
  });

  it("normalizeApiError unwraps the Tauri gateway 'status: body' string", () => {
    // This is exactly what the desktop app used to drop on the floor.
    const err = normalizeApiError('401: {"error":"Invalid credentials."}');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Invalid credentials.");
  });

  it("normalizeApiError passes through Errors and plain strings", () => {
    const orig = new Error("kaboom");
    expect(normalizeApiError(orig)).toBe(orig);
    expect(normalizeApiError("network unreachable").message).toBe("network unreachable");
    expect(normalizeApiError(undefined).message).toBe("Request failed.");
  });

  it("with server data off, an uncached GET rejects and never calls fetch", async () => {
    isServerDataBlocked.mockResolvedValue(true);
    const f = mockFetchOnce({ channels: [] });
    await expect(api.getRooms()).rejects.toThrow(/offline copy/i);
    expect(f).not.toHaveBeenCalled();
  });

  it("caches successful GETs and serves them from cache when server data is off", async () => {
    // Online request populates the cache…
    const f1 = mockFetchOnce({ channels: [{ id: 1 }] });
    await api.getRooms();
    expect(f1).toHaveBeenCalledTimes(1);

    // …then server-data-off serves the cached body without touching the network.
    isServerDataBlocked.mockResolvedValue(true);
    const f2 = mockFetchOnce({ channels: [{ id: 999 }] });
    const res = await api.getRooms();
    expect(res).toEqual({ channels: [{ id: 1 }] });
    expect(f2).not.toHaveBeenCalled();
  });

  it("blocks writes (non-GET) when server data is off", async () => {
    isServerDataBlocked.mockResolvedValue(true);
    await expect(api.joinRoom("general")).rejects.toThrow(/server data is off/i);
  });
});
