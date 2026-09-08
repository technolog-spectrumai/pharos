import { describe, expect, it, vi } from "vitest";
import { createClient, normalizeServerUrl } from "../../src/api/client";
import { ApiFailure } from "../../src/api/errors";
import { login } from "../../src/api/auth";
import { createFile, getContent, listFiles, putContent } from "../../src/api/vault";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: typeof fetch, token: string | null = "tok") {
  return createClient({ baseUrl: "http://server.test", getToken: () => token, fetchImpl });
}

describe("normalizeServerUrl — FROZEN, see client.ts header", () => {
  it("strips trailing slashes and keeps everything else", () => {
    expect(normalizeServerUrl("http://x.test/")).toBe("http://x.test");
    expect(normalizeServerUrl("https://x.test///")).toBe("https://x.test");
    expect(normalizeServerUrl("http://x.test:8000/sub/")).toBe("http://x.test:8000/sub");
  });

  it("throws on garbage rather than storing it", () => {
    expect(() => normalizeServerUrl("not a url")).toThrow();
  });
});

describe("the client", () => {
  it("sends Bearer + Accept: application/json on every call", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { files: [] }));
    await listFiles(clientWith(fetchMock as unknown as typeof fetch));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://server.test/vault/api/files/");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    // Load-bearing: the 402 gate keys JSON-vs-HTML on this header.
    expect(headers.Accept).toBe("application/json");
  });

  it("sends no Authorization header when logged out", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, token: "t" }));
    await login(clientWith(fetchMock as unknown as typeof fetch, null), "u", "p");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  const table: Array<[number, unknown, string]> = [
    [401, { error: "Not authenticated." }, "unauthorized"],
    [402, { error: "x", entitlement: "sketch", plans_url: "/plans/" }, "payment-required"],
    [403, { error: "File editing is disabled on this host." }, "forbidden"],
    [404, { error: "File not found." }, "not-found"],
    [413, { error: "Too large." }, "too-large"],
    [415, { error: "This file type is not editable." }, "unsupported-type"],
    [423, { error: "x", locked_by: "anna" }, "locked"],
    [409, { error: "x", content_hash: "abc" }, "conflict"],
    [500, { error: "boom" }, "server"],
  ];
  for (const [status, body, kind] of table) {
    it(`maps ${status} to ${kind}`, async () => {
      const fetchMock = vi.fn(async () => jsonResponse(status, body));
      const err = await getContent(clientWith(fetchMock as unknown as typeof fetch), "k")
        .then(() => null, (e) => e as ApiFailure);
      expect(err).toBeInstanceOf(ApiFailure);
      expect(err!.error.kind).toBe(kind);
    });
  }

  it("classifies a Django HTML error page by status alone", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html>login</html>", { status: 401 }));
    const err = await listFiles(clientWith(fetchMock as unknown as typeof fetch))
      .then(() => null, (e) => e as ApiFailure);
    expect(err!.error.kind).toBe("unauthorized");
  });

  it("wraps transport failures as network errors", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("offline"); });
    const err = await listFiles(clientWith(fetchMock as unknown as typeof fetch))
      .then(() => null, (e) => e as ApiFailure);
    expect(err!.error.kind).toBe("network");
  });

  it("PUTs content as {content} and returns the refreshed dict", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { key: "k", title: "t" }));
    await putContent(clientWith(fetchMock as unknown as typeof fetch), "a b", "hello");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://server.test/vault/api/files/a%20b/content/");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ content: "hello" });
  });
});

describe("pushing to the vault", () => {
  it("sends the base hash so the server can refuse a stale overwrite", async () => {
    // Without base_hash the save is last-writer-wins, which is exactly why
    // vault files used to open read-only here.
    const fetchMock = vi.fn(async () => jsonResponse(200, { key: "k" }));
    await putContent(clientWith(fetchMock as unknown as typeof fetch), "k", "new", "abc123");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ content: "new", base_hash: "abc123" });
  });

  it("surfaces a stale save as a conflict, not a generic failure", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(409, {
      error: "changed", content_hash: "server-side", kept_as_version: 4,
    }));
    const err = await putContent(
      clientWith(fetchMock as unknown as typeof fetch), "k", "mine", "stale",
    ).then(() => null, (e) => e as ApiFailure);
    expect(err!.error.kind).toBe("conflict");
  });

  it("surfaces a locked file as locked, so the UI can name the holder", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(423, {
      error: "busy", locked_by: "ada",
    }));
    const err = await putContent(clientWith(fetchMock as unknown as typeof fetch), "k", "x")
      .then(() => null, (e) => e as ApiFailure);
    expect(err!.error.kind).toBe("locked");
    expect((err!.error as { holder: string }).holder).toBe("ada");
  });

  it("creates a new vault file WITH its content in one request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { key: "talk", file_type: "pxml" }));
    await createFile(clientWith(fetchMock as unknown as typeof fetch), {
      bucket_slug: "b", title: "talk.pxml", file_type: "pxml", content: "<presentation/>",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://server.test/vault/api/files/create/");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      bucket_slug: "b", title: "talk.pxml", file_type: "pxml", content: "<presentation/>",
    });
  });
});
