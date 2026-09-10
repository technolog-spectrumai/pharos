// "Will my compile run?" — and a different sentence for every reason it will
// not.
//
// The point of these tests is not that the function returns a value; it is
// that a dead token and a dead network never collapse into the same message,
// because the reader's next action is different for each.
import { describe, expect, it } from "vitest";
import {
  canRunWork, checkReadiness, readinessLabel,
} from "../../src/api/readiness";
import { ApiFailure } from "../../src/api/errors";
import type { ApiClient } from "../../src/api/client";
import type { Capsule } from "../../src/api/capsules";

const POOL = {
  total: { cpu_millicores: 4000, ram_mb: 8192, scratch_mb: 40960, pids: 512 },
  booked: { cpu_millicores: 1000, ram_mb: 2048, scratch_mb: 10240, pids: 128 },
  available: { cpu_millicores: 3000, ram_mb: 6144, scratch_mb: 30720, pids: 384 },
};

const DRY = {
  ...POOL,
  available: { cpu_millicores: 0, ram_mb: 0, scratch_mb: 0, pids: 0 },
};

function capsule(over: Partial<Capsule> = {}): Capsule {
  return {
    uuid: "c-1", name: "workshop", state: "running", detail: "",
    reserved: POOL.booked, free: POOL.available, usage: null,
    sample_age_seconds: 1, expires_at: null, executions_running: 0,
    accepts_work: true, tier: "docker", isolates_kernel: false,
    ...over,
  };
}

/** A client whose two GETs are scripted by path. */
function fakeClient(routes: Record<string, unknown | (() => never)>): ApiClient {
  return {
    async get(path: string) {
      const hit = routes[path];
      if (typeof hit === "function") (hit as () => never)();
      if (hit === undefined) throw new ApiFailure({ kind: "not-found" });
      return hit;
    },
    async post() { throw new Error("not used"); },
  } as unknown as ApiClient;
}

describe("a server that is ready", () => {
  it("says so, and names the capsule the work lands in", async () => {
    const report = await checkReadiness(fakeClient({
      "/api/v1/pool": POOL,
      "/api/v1/capsules": { capsules: [capsule()] },
    }));
    expect(report.state).toBe("ready");
    expect(report.message).toContain("workshop");
    expect(report.target?.uuid).toBe("c-1");
    expect(canRunWork(report)).toBe(true);
  });
});

describe("each refusal gets its own sentence", () => {
  it("distinguishes a refused token from an unreachable server", async () => {
    // THE DISTINCTION THAT MATTERS: one means "mint a new token", the other
    // means "check your wifi". A single "could not connect" for both is the
    // message this whole module replaces.
    const dead = await checkReadiness(fakeClient({
      "/api/v1/pool": () => {
        throw new ApiFailure({ kind: "unauthorized" });
      },
    }));
    const offline = await checkReadiness(fakeClient({
      "/api/v1/pool": () => {
        throw new ApiFailure({ kind: "network", cause: new Error("down") });
      },
    }));

    expect(dead.state).toBe("unauthorized");
    expect(dead.message).toContain("token");
    expect(offline.state).toBe("unreachable");
    expect(offline.message).toContain("online");
    expect(dead.message).not.toBe(offline.message);
  });

  it("reports no capsule when none is reserved", async () => {
    const report = await checkReadiness(fakeClient({
      "/api/v1/pool": POOL,
      "/api/v1/capsules": { capsules: [] },
    }));
    expect(report.state).toBe("no-capsule");
    expect(report.message).toContain("Reserve one");
  });

  it("names the state when a capsule exists but will not take work", async () => {
    const report = await checkReadiness(fakeClient({
      "/api/v1/pool": POOL,
      "/api/v1/capsules": {
        capsules: [capsule({ accepts_work: false, state: "starting" })],
      },
    }));
    expect(report.state).toBe("no-capsule");
    expect(report.message).toContain("starting");
  });

  it("reports no capacity when the pool is dry", async () => {
    const report = await checkReadiness(fakeClient({
      "/api/v1/pool": DRY,
      "/api/v1/capsules": { capsules: [] },
    }));
    expect(report.state).toBe("no-capacity");
    expect(report.message).toContain("queue");
  });

  it("never lets a refusal run work", async () => {
    for (const routes of [
      { "/api/v1/pool": DRY, "/api/v1/capsules": { capsules: [] } },
      { "/api/v1/pool": POOL, "/api/v1/capsules": { capsules: [] } },
    ]) {
      expect(canRunWork(await checkReadiness(fakeClient(routes)))).toBe(false);
    }
    expect(canRunWork(null)).toBe(false);
  });
});

describe("a secondary failure does not become a fatal one", () => {
  it("still reports what it learned when capsules cannot be listed", async () => {
    // Authenticating proved the server is there. Failing to list capsules
    // after that is a smaller fact, and must not be reported as "offline".
    const report = await checkReadiness(fakeClient({
      "/api/v1/pool": POOL,
      "/api/v1/capsules": () => {
        throw new ApiFailure({ kind: "server", status: 500, message: "boom" });
      },
    }));
    expect(report.state).not.toBe("unreachable");
    expect(report.pool).not.toBeNull();
  });

  it("never throws, whatever the server does", async () => {
    const report = await checkReadiness(fakeClient({
      "/api/v1/pool": () => { throw new Error("something unclassified"); },
    }));
    expect(report.state).toBe("unreachable");
  });
});

describe("the label", () => {
  it("has a word for every state, including not-yet-checked", () => {
    expect(readinessLabel(null)).toBe("not checked");
    const seen = new Set<string>();
    for (const state of [
      "ready", "no-capacity", "no-capsule", "unauthorized", "unreachable",
    ] as const) {
      const label = readinessLabel({
        state, message: "", pool: null, capsules: [], target: null,
      });
      expect(label).not.toBe("not checked");
      seen.add(label);
    }
    // Distinct, so the chip cannot show one word for two situations.
    expect(seen.size).toBe(5);
  });
});
