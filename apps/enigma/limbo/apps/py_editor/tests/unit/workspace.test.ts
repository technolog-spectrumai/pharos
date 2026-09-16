// The workspace store: what it fetches, what it refuses, and what it must
// never do to a person's work.
//
// Everything runs against a fake `fetchImpl` — no Tauri, no webview, no
// network — which is the whole reason the client was built with that seam. The
// cases that matter here are not "does it call the endpoint": they are the four
// ways an editor destroys work, each of which has a test named after it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type ApiClient } from "totoapi";
import {
  workspaceState, loadList, open, openFile, edit, save, saveRefusal,
  execute, close, active, isDirty, canWrite, clearTranscript,
  __resetForTests,
} from "../../src/platform/workspace";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** A server that answers from a table of `METHOD /path` → body. */
function serverWith(routes: Record<string, [number, unknown]>) {
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    seen.push(key);
    const hit = routes[key];
    if (!hit) return jsonResponse(404, { error: `no route ${key}`, code: "" });
    return jsonResponse(hit[0], hit[1]);
  });
  const client = createClient({
    baseUrl: "https://zen.test",
    getToken: () => null,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl, seen };
}

const WS = {
  slug: "notebook", name: "Notebook", kind: "python", namespace: "dracena",
  owner: "janek", writable: true, created_at: "2026-09-10T00:00:00Z",
  can_execute: true,
};

const FILE = {
  pk: 7, name: "main.py", file_type: "py", content: "print(1)\n",
  truncated: false, readonly: false, size: 9,
};

function openedServer(overrides: Record<string, [number, unknown]> = {}) {
  return serverWith({
    "GET /api/v1/workspaces/notebook": [200, WS],
    "GET /api/v1/workspaces/notebook/tree": [200, { items: [] }],
    "GET /api/v1/workspaces/notebook/files/7": [200, FILE],
    "POST /api/v1/workspaces/notebook/files/7/save": [200, { pk: 7, size: 1 }],
    ...overrides,
  });
}

async function opened(overrides = {}): Promise<ApiClient> {
  const { client } = openedServer(overrides);
  await open(client, "notebook");
  return client;
}

beforeEach(__resetForTests);

describe("listing and opening", () => {
  it("lists the workspaces the server returns", async () => {
    const { client } = serverWith({
      "GET /api/v1/workspaces": [200, { workspaces: [WS] }],
    });
    await loadList(client);
    expect(workspaceState.list.map((w) => w.slug)).toEqual(["notebook"]);
  });

  it("opening fetches the detail and the tree", async () => {
    const { client, seen } = openedServer();
    await open(client, "notebook");
    expect(workspaceState.current?.slug).toBe("notebook");
    expect(seen).toContain("GET /api/v1/workspaces/notebook/tree");
  });

  it("opening a second workspace drops the first one's buffers", async () => {
    const client = await opened();
    await openFile(client, 7);
    expect(workspaceState.buffers).toHaveLength(1);
    await open(client, "notebook");
    expect(workspaceState.buffers).toHaveLength(0);
    expect(workspaceState.activePk).toBeNull();
  });

  it("surfaces a refusal's sentence rather than a status code", async () => {
    const { client } = serverWith({
      "GET /api/v1/workspaces/gone": [404, { error: "no such workspace" }],
    });
    await expect(open(client, "gone")).rejects.toBeTruthy();
    expect(workspaceState.error).toBeTruthy();
  });
});

describe("buffers", () => {
  it("opens a file into a buffer and makes it active", async () => {
    const client = await opened();
    const buffer = await openFile(client, 7);
    expect(buffer.text).toBe("print(1)\n");
    expect(active()?.pk).toBe(7);
  });

  it("RE-OPENING DOES NOT DISCARD AN UNSAVED EDIT", async () => {
    // The worst thing this module could do. Clicking a file in the tree that is
    // already open must focus it, not refetch over the user's work.
    const client = await opened();
    await openFile(client, 7);
    edit(7, "print('mine')\n");
    await openFile(client, 7);
    expect(active()?.text).toBe("print('mine')\n");
    expect(isDirty(active()!)).toBe(true);
  });

  it("dirty is a comparison, not a flag that can drift", async () => {
    const client = await opened();
    const buffer = await openFile(client, 7);
    expect(isDirty(buffer)).toBe(false);
    edit(7, "x");
    expect(isDirty(buffer)).toBe(true);
    edit(7, "print(1)\n");
    expect(isDirty(buffer)).toBe(false);
  });

  it("closing focuses another buffer rather than nothing", async () => {
    const client = await opened({
      "GET /api/v1/workspaces/notebook/files/8": [200, { ...FILE, pk: 8, name: "b.py" }],
    });
    await openFile(client, 7);
    await openFile(client, 8);
    close(8);
    expect(active()?.pk).toBe(7);
  });

  it("closing the last buffer leaves nothing active", async () => {
    const client = await opened();
    await openFile(client, 7);
    close(7);
    expect(active()).toBeNull();
  });
});

describe("saving — the four ways to destroy work", () => {
  it("A TRUNCATED FILE MUST NOT BE SAVED", async () => {
    // The server shortens a file over its read ceiling. Saving that back writes
    // the visible part over the whole thing and the tail is gone.
    const client = await opened({
      "GET /api/v1/workspaces/notebook/files/7": [200, { ...FILE, truncated: true }],
    });
    const buffer = await openFile(client, 7);
    expect(saveRefusal(buffer)).toMatch(/too large/i);
    await expect(save(client, 7)).rejects.toBeTruthy();
  });

  it("a generated file must not be saved", async () => {
    const client = await opened({
      "GET /api/v1/workspaces/notebook/files/7": [200, { ...FILE, readonly: true }],
    });
    const buffer = await openFile(client, 7);
    expect(saveRefusal(buffer)).toMatch(/produced by a run/i);
  });

  it("a read-only workspace must not be saved to", async () => {
    const client = await opened({
      "GET /api/v1/workspaces/notebook": [200, { ...WS, writable: false }],
    });
    const buffer = await openFile(client, 7);
    expect(canWrite()).toBe(false);
    expect(saveRefusal(buffer)).toMatch(/read-only/i);
  });

  it("writable is read from the server, never inferred", async () => {
    // A client that decided for itself would have to know the permission rules
    // and would be wrong the day they change.
    await opened({ "GET /api/v1/workspaces/notebook": [200, { ...WS, writable: false }] });
    expect(canWrite()).toBe(false);
    await opened({ "GET /api/v1/workspaces/notebook": [200, { ...WS, writable: true }] });
    expect(canWrite()).toBe(true);
  });

  it("every refusal is a sentence, because a dead button teaches nothing", async () => {
    const client = await opened({
      "GET /api/v1/workspaces/notebook/files/7": [200, { ...FILE, truncated: true }],
    });
    const buffer = await openFile(client, 7);
    expect(saveRefusal(buffer).length).toBeGreaterThan(20);
  });

  it("A KEYSTROKE DURING A SAVE STAYS DIRTY", async () => {
    // The buffer is marked saved against the text that was SENT, not the text
    // that is there when the reply lands. Otherwise a character typed mid-flight
    // is silently marked as saved and lost on the next reload.
    const client = await opened();
    await openFile(client, 7);
    edit(7, "first\n");
    const inFlight = save(client, 7);
    edit(7, "first and second\n");
    await inFlight;
    expect(isDirty(active()!)).toBe(true);
    expect(active()!.saved).toBe("first\n");
  });

  it("a clean save clears the dirty state", async () => {
    const client = await opened();
    await openFile(client, 7);
    edit(7, "changed\n");
    await save(client, 7);
    expect(isDirty(active()!)).toBe(false);
  });
});

describe("running", () => {
  const OK_RUN = {
    slug: "notebook", kind: "python", queued: false, status: "ok",
    stdout: "1\n", stderr: "", error: "", exit_code: 0, files: [],
  };

  it("puts the output in the transcript", async () => {
    const client = await opened({
      "POST /api/v1/workspaces/notebook/run": [200, OK_RUN],
    });
    await execute(client, { code: "print(1)" }, "print(1)");
    expect(workspaceState.entries).toHaveLength(1);
    expect(workspaceState.entries[0].stdout).toBe("1\n");
  });

  it("A SCRIPT THAT RAISED IS A RESULT, NOT AN ERROR", async () => {
    // The server returns a traceback with a non-zero exit code as an ordinary
    // 200. Treating it as a failure shows "we could not run your code" for a
    // NameError and throws the traceback away — the exact mistake the server
    // side was rebuilt to avoid.
    const client = await opened({
      "POST /api/v1/workspaces/notebook/run": [200, {
        ...OK_RUN, status: "error", exit_code: 1,
        stdout: "Traceback (most recent call last):\nNameError: name 'x'\n",
      }],
    });
    await execute(client, { code: "print(x)" });
    const entry = workspaceState.entries[0];
    expect(entry.status).toBe("error");
    expect(entry.stdout).toContain("NameError");
    expect(workspaceState.error).toBe("");
  });

  it("a job that could not run at all IS an error", async () => {
    const client = await opened({
      "POST /api/v1/workspaces/notebook/run": [503, {
        error: "the job was killed at its deadline", code: "not_run",
      }],
    });
    await expect(execute(client, { code: "1" })).rejects.toBeTruthy();
    expect(workspaceState.error).toMatch(/deadline/);
  });

  it("a refusal keeps its machine-readable code", async () => {
    const client = await opened({
      "POST /api/v1/workspaces/notebook/run": [409, {
        error: "You hold no mounted Compute Capsule.", code: "no_capsule",
      }],
    });
    await execute(client, { code: "1" }).catch((e) => {
      expect(e.error.kind).toBe("refused");
      expect(e.error.code).toBe("no_capsule");
    });
  });

  it("a queued answer is recorded as queued rather than as empty output", async () => {
    // LaTeX answers this way. A transcript that showed it as a finished run
    // with no output would read as "it did nothing".
    const client = await opened({
      "POST /api/v1/workspaces/notebook/run": [200, {
        slug: "notebook", kind: "latex", queued: true, status: "queued",
        run: {}, main: "main.tex", main_pk: 3,
      }],
    });
    await execute(client, {});
    expect(workspaceState.entries[0].status).toBe("queued");
  });

  it("the transcript is append-only and Clear is the only way to lose it", async () => {
    const client = await opened({
      "POST /api/v1/workspaces/notebook/run": [200, OK_RUN],
    });
    await execute(client, { code: "1" });
    await execute(client, { code: "2" });
    expect(workspaceState.entries.map((e) => e.id)).toEqual([1, 2]);
    clearTranscript();
    expect(workspaceState.entries).toHaveLength(0);
  });

  it("refuses to run with no workspace open", async () => {
    const { client } = openedServer();
    await expect(execute(client, { code: "1" })).rejects.toThrow(/no workspace/);
  });
});
