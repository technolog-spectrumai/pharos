import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the storage layer so the API client has a deterministic base URL + token.
const setAuthToken = vi.fn(async () => {});
const clearAuthToken = vi.fn(async () => {});
vi.mock("../../src/services/appStorage", () => ({
  getServerUrl: vi.fn(async () => "http://test.local/"),
  getAuthToken: vi.fn(async () => "tok123"),
  setAuthToken: (...a: any[]) => setAuthToken(...a),
  clearAuthToken: (...a: any[]) => clearAuthToken(...a),
}));

import { api } from "../../src/services/api";

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
  setAuthToken.mockClear();
  clearAuthToken.mockClear();
});

describe("ApiService request building", () => {
  it("GET getFiles hits the right URL with a Bearer token and JSON headers", async () => {
    const f = mockFetchOnce({ files: [] });
    await api.getFiles();
    const { url, headers } = lastCall(f);
    expect(url).toBe("http://test.local/vault/api/files/");
    expect(headers.Authorization).toBe("Bearer tok123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("GET getBuckets hits the buckets endpoint", async () => {
    const f = mockFetchOnce({ buckets: [] });
    await api.getBuckets();
    expect(lastCall(f).url).toBe("http://test.local/vault/api/buckets/");
  });

  it("GET getFileContent targets the file content endpoint", async () => {
    const f = mockFetchOnce({ content: "hi", file_type: "text" });
    const res = await api.getFileContent("notes-md");
    expect(lastCall(f).url).toBe("http://test.local/vault/api/files/notes-md/content/");
    expect(res.content).toBe("hi");
  });

  it("PUT saveFileContent sends method PUT and the content body", async () => {
    const f = mockFetchOnce({ key: "k", title: "t" });
    await api.saveFileContent("k", "new body");
    const { init } = lastCall(f);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ content: "new body" });
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

  it("throws with status + body text on a non-OK response", async () => {
    mockFetchOnce({ error: "nope" }, false, 404);
    await expect(api.getFiles()).rejects.toThrow(/404/);
  });
});
