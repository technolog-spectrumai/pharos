// The one HTTP door: URL normalisation, headers, and the status→kind taxonomy.
//
// Rewritten in the 2026-09-10 lift out of limbo. The shape of the file is the
// one that was parked — a fake `fetchImpl`, a table of statuses, and the frozen
// URL rule first — because that shape is why the client was testable without a
// server. What changed is WHAT it calls: the vault endpoints went with the
// parked code, and these exercise `/api/v1/` instead.
import { describe, expect, it, vi } from "vitest";
import { createClient, normalizeServerUrl } from "../../src/api/client";
import { ApiFailure } from "../../src/api/errors";
import { pool, submitJob, jobLogs, encodeText, decodeText } from "../../src/api/capsules";
import { listWorkspaces, readFile, writeFile, run } from "../../src/api/workspaces";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: typeof fetch, token: string | null = "capsule.a.b") {
  return createClient({ baseUrl: "http://server.test", getToken: () => token, fetchImpl });
}

function callOf(mock: ReturnType<typeof vi.fn>, i = 0) {
  return mock.mock.calls[i] as unknown as [string, RequestInit];
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

  it("is stable for the same input, because it keys a stored credential", () => {
    // The normalised URL is the keyring ACCOUNT NAME. A rule that drifted would
    // orphan every saved token with nothing able to enumerate what was lost —
    // which is why the header calls it frozen and why this test exists.
    const inputs = ["https://zen.test", "https://zen.test/", "https://zen.test//"];
    const out = inputs.map(normalizeServerUrl);
    expect(new Set(out).size).toBe(1);
  });
});

describe("the client", () => {
  it("sends Bearer + Accept: application/json on every call", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { total: {} }));
    await pool(clientWith(fetchMock as unknown as typeof fetch));
    const [url, init] = callOf(fetchMock);
    expect(url).toBe("http://server.test/api/v1/pool");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer capsule.a.b");
    // Load-bearing: the subscription gate keys its JSON-vs-HTML refusal on it.
    expect(headers.Accept).toBe("application/json");
  });

  it("sends no Authorization header with no token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: "x" }));
    await pool(clientWith(fetchMock as unknown as typeof fetch, null)).catch(() => null);
    const [, init] = callOf(fetchMock);
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  const table: Array<[number, unknown, string]> = [
    [401, { error: "That token is not valid.", code: "bad_token" }, "unauthorized"],
    [402, { error: "x", entitlement: "anastasia", plans_url: "/plans/" }, "payment-required"],
    [403, { error: "You may not run code here.", code: "x" }, "forbidden"],
    [404, { error: "no such workspace" }, "not-found"],
    [413, { error: "over the limit", code: "inputs_too_large" }, "too-large"],
    [500, { error: "boom" }, "server"],
  ];
  for (const [status, body, kind] of table) {
    it(`maps ${status} to ${kind}`, async () => {
      const fetchMock = vi.fn(async () => jsonResponse(status, body));
      const err = await pool(clientWith(fetchMock as unknown as typeof fetch))
        .then(() => null, (e) => e as ApiFailure);
      expect(err).toBeInstanceOf(ApiFailure);
      expect(err!.error.kind).toBe(kind);
    });
  }

  it("classifies a Django HTML error page by status alone", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html>login</html>", { status: 401 }));
    const err = await pool(clientWith(fetchMock as unknown as typeof fetch))
      .then(() => null, (e) => e as ApiFailure);
    expect(err!.error.kind).toBe("unauthorized");
  });

  it("wraps transport failures as network errors", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("offline"); });
    const err = await pool(clientWith(fetchMock as unknown as typeof fetch))
      .then(() => null, (e) => e as ApiFailure);
    expect(err!.error.kind).toBe("network");
  });
});

describe("the two kinds of 409", () => {
  // The distinction is why `classify` reads a FIELD rather than the status:
  // reading them as one would make a quota refusal look like a stale buffer
  // and offer the user a merge.

  it("a named API refusal carries its code", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(409, {
      error: "You hold no mounted Compute Capsule.", code: "no_capsule",
    }));
    const err = await run(clientWith(fetchMock as unknown as typeof fetch), "ws")
      .then(() => null, (e) => e as ApiFailure);
    expect(err!.error.kind).toBe("refused");
    expect((err!.error as { code: string }).code).toBe("no_capsule");
    expect(err!.message).toBe("You hold no mounted Compute Capsule.");
  });

  it("a vault save conflict is still a conflict", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(409, {
      error: "changed", content_hash: "server-side",
    }));
    const err = await writeFile(clientWith(fetchMock as unknown as typeof fetch), "ws", 1, "x")
      .then(() => null, (e) => e as ApiFailure);
    expect(err!.error.kind).toBe("conflict");
  });

  it("a 501 is a refusal naming the deployment's limit", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(501, {
      error: "this deployment's runtime cannot stream job output",
      code: "unsupported",
    }));
    const err = await jobLogs(clientWith(fetchMock as unknown as typeof fetch), "j")
      .then(() => null, (e) => e as ApiFailure);
    expect(err!.error.kind).toBe("refused");
    expect((err!.error as { code: string }).code).toBe("unsupported");
  });
});

describe("jobs", () => {
  it("stages inputs as base64 under their filenames", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { uuid: "j" }));
    await submitJob(clientWith(fetchMock as unknown as typeof fetch), "cap", {
      operation: "run_python",
      params: { script: "main.py" },
      inputs: { "main.py": encodeText("print(1)") },
    });
    const [url, init] = callOf(fetchMock);
    expect(url).toBe("http://server.test/api/v1/capsules/cap/jobs");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.operation).toBe("run_python");
    expect(decodeText(body.inputs["main.py"])).toBe("print(1)");
  });

  it("carries the log offset in the query string", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { text: "", offset: 0 }));
    await jobLogs(clientWith(fetchMock as unknown as typeof fetch), "j", 512);
    expect(callOf(fetchMock)[0]).toBe("http://server.test/api/v1/jobs/j/logs?offset=512");
  });
});

describe("base64 round trip", () => {
  it("survives non-ASCII in both directions", () => {
    // btoa/atob are LATIN-1. Encoding a Polish comment without the explicit
    // TextEncoder step throws "String contains an invalid character", and a
    // naive decode mangles it silently — the worse of the two.
    const text = "# zażółć gęślą jaźń\nx = '→'\n";
    expect(decodeText(encodeText(text))).toBe(text);
  });

  it("survives an emoji, which is outside the BMP", () => {
    expect(decodeText(encodeText("print('🐍')"))).toBe("print('🐍')");
  });

  it("handles empty content", () => {
    expect(decodeText(encodeText(""))).toBe("");
  });
});

describe("workspaces", () => {
  it("reads a file by pk under its workspace slug", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { pk: 7, content: "x" }));
    await readFile(clientWith(fetchMock as unknown as typeof fetch), "notebook", 7);
    expect(callOf(fetchMock)[0])
      .toBe("http://server.test/api/v1/workspaces/notebook/files/7");
  });

  it("saves as {content} to the /save door", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { pk: 7, size: 1 }));
    await writeFile(clientWith(fetchMock as unknown as typeof fetch), "notebook", 7, "hi");
    const [url, init] = callOf(fetchMock);
    expect(url).toBe("http://server.test/api/v1/workspaces/notebook/files/7/save");
    expect(JSON.parse(init.body as string)).toEqual({ content: "hi" });
  });

  it("lists workspaces from the collection root", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { workspaces: [] }));
    await listWorkspaces(clientWith(fetchMock as unknown as typeof fetch));
    expect(callOf(fetchMock)[0]).toBe("http://server.test/api/v1/workspaces");
  });

  it("posts the run payload through unchanged", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { queued: false }));
    await run(clientWith(fetchMock as unknown as typeof fetch), "notebook",
              { code: "1 + 1" });
    const [url, init] = callOf(fetchMock);
    expect(url).toBe("http://server.test/api/v1/workspaces/notebook/run");
    expect(JSON.parse(init.body as string)).toEqual({ code: "1 + 1" });
  });
});
