// The files area, from the client's side.
//
// What is under test is the WIRE: which URL each verb calls, what it puts in
// the body, and that the name never reaches the path. The server's own suite
// (`toto/anastasia/tests/test_files.py`, `test_transfer.py`) owns whether a
// name is safe and whether a copy out is charged; a second opinion here would
// be a second rule that could disagree.
import { describe, expect, it, vi } from "vitest";
import { createClient } from "../../src/api/client";
import {
  capsuleFiles, capsuleFileRead, capsuleFileWrite, capsuleFileDelete,
  capsuleFileFromVault, capsuleFileToVault, filesAreKept, filesCostToKeep,
  encodeText, decodeText,
} from "../../src/api/capsules";

const UUID = "8f14e45f-ceea-467a-9a3e-4ad9ae5d0a1b";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: typeof fetch) {
  return createClient({
    baseUrl: "http://server.test",
    getToken: () => "capsule.a.b",
    fetchImpl,
  });
}

function callOf(mock: ReturnType<typeof vi.fn>, i = 0) {
  return mock.mock.calls[i] as unknown as [string, RequestInit];
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body ?? "{}"));
}

describe("the files area", () => {
  it("lists over GET and carries `complete` through", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      uuid: UUID,
      files: [{ name: "out/a.txt", size: 3, modified: 1, is_dir: false }],
      complete: false,
    }));
    const listing = await capsuleFiles(clientWith(fetchMock as unknown as typeof fetch), UUID);
    const [url, init] = callOf(fetchMock);
    expect(url).toBe(`http://server.test/api/v1/capsules/${UUID}/files`);
    expect(init.method ?? "GET").toBe("GET");
    expect(listing.files[0].name).toBe("out/a.txt");
    // NOT dropped in transit. A listing that stopped early and said nothing
    // reads as "this is everything", which is how somebody concludes a file
    // was lost.
    expect(listing.complete).toBe(false);
  });

  it("puts the name in the BODY for every verb, never in the path", async () => {
    // The rule the server's routes are shaped around, asserted from this side
    // too: a name is a path, and a name in a URL is either illegal there or
    // legal and different. A regression would be a read of the wrong file.
    const name = "raporty/wyniki (końcowe).csv";
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const client = clientWith(fetchMock as unknown as typeof fetch);
    await capsuleFileRead(client, UUID, name);
    await capsuleFileWrite(client, UUID, name, "eA==");
    await capsuleFileDelete(client, UUID, name);
    for (let i = 0; i < 3; i += 1) {
      const [url, init] = callOf(fetchMock, i);
      expect(url).not.toContain("wyniki");
      expect(url).not.toContain("%20");
      expect(init.method).toBe("POST");
      expect(bodyOf(init).name).toBe(name);
    }
    expect(callOf(fetchMock, 0)[0]).toBe(
      `http://server.test/api/v1/capsules/${UUID}/files/get`);
    expect(callOf(fetchMock, 1)[0]).toBe(
      `http://server.test/api/v1/capsules/${UUID}/files/put`);
    expect(callOf(fetchMock, 2)[0]).toBe(
      `http://server.test/api/v1/capsules/${UUID}/files/delete`);
  });

  it("does not replace unless asked", async () => {
    // Absent and false must both reach the server as false: a client that
    // omitted the key would leave the decision to a default it cannot see.
    const fetchMock = vi.fn(async () => jsonResponse(201, { name: "a", size: 1 }));
    const client = clientWith(fetchMock as unknown as typeof fetch);
    await capsuleFileWrite(client, UUID, "a.txt", "eA==");
    expect(bodyOf(callOf(fetchMock, 0)[1]).replace).toBe(false);
    await capsuleFileWrite(client, UUID, "a.txt", "eA==", true);
    expect(bodyOf(callOf(fetchMock, 1)[1]).replace).toBe(true);
  });

  it("round-trips text through the base64 the endpoints want", async () => {
    // Not a formality: the naive btoa of a Polish filename throws, and a
    // client that built the payload with it would fail on a real document.
    const text = "zażółć gęślą jaźń\n";
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      name: "a.txt", bytes: 1, data_b64: encodeText(text),
    }));
    const got = await capsuleFileRead(
      clientWith(fetchMock as unknown as typeof fetch), UUID, "a.txt");
    expect(decodeText(got.data_b64)).toBe(text);
  });

  it("copies in by KEY, because a client has no database id", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, {
      name: "thesis.txt", bytes: 9,
      from: { key: "thesis-txt", title: "thesis.txt" },
    }));
    await capsuleFileFromVault(
      clientWith(fetchMock as unknown as typeof fetch), UUID,
      { key: "thesis-txt", name: "in/thesis.txt", replace: true });
    const [url, init] = callOf(fetchMock);
    expect(url).toBe(`http://server.test/api/v1/capsules/${UUID}/files/from-vault`);
    expect(bodyOf(init)).toEqual({
      key: "thesis-txt", name: "in/thesis.txt", replace: true,
    });
  });

  it("copies out naming the bucket, and answers with the vault row", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, {
      key: "result-csv", title: "result.csv", file_type: "csv",
      size: 8, bucket: "papers",
    }));
    const made = await capsuleFileToVault(
      clientWith(fetchMock as unknown as typeof fetch), UUID,
      { name: "out/result.csv", bucket: "papers" });
    const [url, init] = callOf(fetchMock);
    expect(url).toBe(`http://server.test/api/v1/capsules/${UUID}/files/to-vault`);
    expect(bodyOf(init)).toEqual({ name: "out/result.csv", bucket: "papers" });
    expect(made.key).toBe("result-csv");
  });

  it("reads a files 409 as REFUSED, not as a save conflict", async () => {
    // Two different 409s, told apart by shape: the vault's save conflict
    // carries `content_hash` and means "reconcile"; everything on /api/v1/
    // carries `code` and means "the server refused and said why". Reading
    // them as one would offer a merge for a name that escapes the files area.
    const fetchMock = vi.fn(async () => jsonResponse(409, {
      error: "'a.txt' already exists; ask to replace it if that is what you mean",
      code: "file_refused",
    }));
    const err = await capsuleFileWrite(
      clientWith(fetchMock as unknown as typeof fetch), UUID, "a.txt", "eA==")
      .catch((e) => e);
    expect(err.error.kind).toBe("refused");
    expect(err.error.code).toBe("file_refused");
    expect(err.error.message).toContain("already exists");
  });

  it("says what the area IS and what keeping a file COSTS", () => {
    // Two sentences every app that draws this area has to show. Kept here so
    // three apps cannot each write their own and one of them imply permanence
    // or silence the charge.
    expect(filesAreKept).toMatch(/do not survive a reboot/);
    expect(filesAreKept).toMatch(/Vault/);
    expect(filesCostToKeep).toMatch(/charged/);
    expect(filesCostToKeep).toMatch(/scanned/);
  });
});
