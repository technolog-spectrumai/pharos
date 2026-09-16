// Polling a queued compile.
//
// THE PART THAT IS NOT THE PYTHON APP. A Python Run answers with its output; a
// compile answers with a receipt and the result arrives seconds later. Every
// case here is a way that loop goes wrong: it never stops, it stops too early,
// it polls the wrong build, or it buries the transcript in copies of one run.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type ApiClient } from "totoapi";
import {
  workspaceState, open, execute, poll, isPolling, __resetForTests,
} from "../../src/platform/workspace";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

const WS = {
  slug: "paper", name: "Paper", kind: "latex", namespace: "texlab",
  owner: "ada", writable: true, created_at: "", can_execute: true,
};

const QUEUED = {
  slug: "paper", kind: "latex", queued: true, status: "queued",
  run: { id: 42, state: "pending", finished: false },
  main: "main.tex", main_pk: 3,
};

/** A server whose poll answers come from a queue, one per call. */
function serverWith(pollAnswers: Array<[number, unknown]>) {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    if (key === "GET /api/v1/workspaces/paper") return jsonResponse(200, WS);
    if (key === "GET /api/v1/workspaces/paper/tree") return jsonResponse(200, { items: [] });
    if (key === "POST /api/v1/workspaces/paper/run") return jsonResponse(200, QUEUED);
    if (key.startsWith("GET /api/v1/workspaces/paper/runs/")) {
      const answer = pollAnswers[Math.min(i, pollAnswers.length - 1)];
      i += 1;
      return jsonResponse(answer[0], answer[1]);
    }
    return jsonResponse(404, { error: `no route ${key}`, code: "" });
  });
  const client = createClient({
    baseUrl: "https://zen.test", getToken: () => null,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, calls };
}

function detail(over: Record<string, unknown> = {}) {
  return {
    id: 42, state: "running", finished: false, status: "running",
    stdout: "", error: "", passes: 0, artifacts: [], pdf_pk: null,
    main: "main.tex", duration: null, ...over,
  };
}

async function started(client: ApiClient) {
  await open(client, "paper");
  await execute(client, {}, "main.tex");
  return workspaceState.entries[workspaceState.entries.length - 1];
}

beforeEach(__resetForTests);

describe("a queued compile", () => {
  it("records the SERVER's run id, distinct from the transcript's own", async () => {
    // Confusing the two polls the wrong build — and would keep answering, so
    // nothing would look broken.
    const { client } = serverWith([[200, detail()]]);
    const entry = await started(client);
    expect(entry.id).toBe(1);
    expect(entry.runId).toBe(42);
  });

  it("shows as queued rather than as a finished run with no output", async () => {
    const { client } = serverWith([[200, detail()]]);
    const entry = await started(client);
    expect(entry.status).toBe("queued");
    expect(entry.finished).toBe(false);
  });

  it("labels itself with the main document when nothing else was given", async () => {
    const { client } = serverWith([[200, detail()]]);
    await open(client, "paper");
    await execute(client, {});
    expect(workspaceState.entries[0].source).toBe("main.tex");
  });
});

describe("the loop", () => {
  it("asks again while the build is running", async () => {
    const { client } = serverWith([[200, detail({ finished: false })]]);
    const entry = await started(client);
    expect(await poll(client, entry.id)).toBe(true);
  });

  it("STOPS when the build finishes", async () => {
    const { client } = serverWith([[200, detail({
      finished: true, status: "ok", stdout: "Output written on main.pdf\n",
    })]]);
    const entry = await started(client);
    expect(await poll(client, entry.id)).toBe(false);
    expect(workspaceState.entries[0].stdout).toContain("main.pdf");
    expect(workspaceState.entries[0].finished).toBe(true);
  });

  it("A FAILED POLL STOPS THE LOOP", async () => {
    // Left running it would hammer an unreachable server once a second for as
    // long as the window is open.
    const { client } = serverWith([[503, { error: "gone", code: "" }]]);
    const entry = await started(client);
    expect(await poll(client, entry.id)).toBe(false);
    expect(workspaceState.entries[0].finished).toBe(true);
    expect(workspaceState.entries[0].error).toBeTruthy();
  });

  it("polling a finished entry does nothing and asks for nothing", async () => {
    const { client, calls } = serverWith([[200, detail({ finished: true })]]);
    const entry = await started(client);
    await poll(client, entry.id);
    const before = calls.length;
    expect(await poll(client, entry.id)).toBe(false);
    expect(calls.length).toBe(before);
  });

  it("polling an entry that was never queued does nothing", async () => {
    const { client } = serverWith([[200, detail()]]);
    await open(client, "paper");
    expect(await poll(client, 999)).toBe(false);
  });

  it("REWRITES THE ENTRY IN PLACE rather than appending one per poll", async () => {
    // A compile is polled every second or two. A new entry each time would bury
    // the run before it in twenty copies of this one.
    const { client } = serverWith([
      [200, detail({ passes: 1 })],
      [200, detail({ passes: 2 })],
      [200, detail({ finished: true, status: "ok", passes: 3 })],
    ]);
    const entry = await started(client);
    await poll(client, entry.id);
    await poll(client, entry.id);
    await poll(client, entry.id);
    expect(workspaceState.entries).toHaveLength(1);
    expect(workspaceState.entries[0].passes).toBe(3);
  });

  it("takes the tree from a finished run, so build/ appears", async () => {
    // The server sends it WITH the finished run. A client that had to guess
    // when to refetch would either miss the new files or poll the tree forever.
    const items = [{ t: "file", id: 9, pid: null, depth: 0, name: "main.pdf" }];
    const { client } = serverWith([[200, detail({ finished: true, items })]]);
    const entry = await started(client);
    expect(workspaceState.items).toHaveLength(0);
    await poll(client, entry.id);
    expect(workspaceState.items.map((i) => i.name)).toEqual(["main.pdf"]);
  });

  it("does not take the tree from an unfinished run", async () => {
    // Mid-compile the build directory is half written; adopting it would show
    // files that are about to be replaced.
    const items = [{ t: "file", id: 9, pid: null, depth: 0, name: "half.pdf" }];
    const { client } = serverWith([[200, detail({ finished: false, items })]]);
    const entry = await started(client);
    await poll(client, entry.id);
    expect(workspaceState.items).toHaveLength(0);
  });
});

describe("isPolling", () => {
  it("is false with nothing queued", async () => {
    const { client } = serverWith([[200, detail()]]);
    await open(client, "paper");
    expect(isPolling()).toBe(false);
  });

  it("is true while a build is in flight, so Compile can be disabled", async () => {
    const { client } = serverWith([[200, detail()]]);
    await started(client);
    expect(isPolling()).toBe(true);
  });

  it("goes false once the build finishes", async () => {
    const { client } = serverWith([[200, detail({ finished: true })]]);
    const entry = await started(client);
    await poll(client, entry.id);
    expect(isPolling()).toBe(false);
  });

  it("stays false after a failed poll, so Compile is not stuck disabled", async () => {
    const { client } = serverWith([[500, { error: "boom" }]]);
    const entry = await started(client);
    await poll(client, entry.id);
    expect(isPolling()).toBe(false);
  });
});
