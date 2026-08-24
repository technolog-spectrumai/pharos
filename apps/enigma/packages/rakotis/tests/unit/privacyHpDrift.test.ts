// The price table has one source of truth: apps/enigma/src-tauri/privacy_hp.yaml.
//
// Rust reads it at compile time; this package carries a browser-mode mirror so the
// app still works in the Vite dev server and so these tests have real numbers to
// assert against. A mirror is a drift hazard, so this file removes the hazard: it
// parses the actual YAML and fails if a single value disagrees.
//
// If this test fails, the YAML is right and `services/hp.ts` is stale.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { FALLBACK_HP_POLICY as MIRROR } from "../../src/services/hp";

/** Walk up from the working directory to the monorepo root and take the YAML
 *  from there. `import.meta.url` is not a file: URL under the jsdom environment
 *  these tests run in, so the lookup is done by path instead. */
function findPolicyYaml(): string {
  const rel = "apps/enigma/src-tauri/privacy_hp.yaml";
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`cannot find ${rel} above ${process.cwd()}`);
}

const YAML_PATH = findPolicyYaml();

interface RawAction {
  id: string;
  kind: string;
  cost: number | string;
  per_mib?: number;
  per_minute?: number;
  cap_per_event?: number;
  explain_key: string;
}

const yaml = parse(readFileSync(YAML_PATH, "utf8")) as {
  version: number;
  confirm_at_hp: number;
  scale: Record<string, number>;
  meters: Record<string, { max: number; regen_hp: number; regen_per_minutes: number; window_days?: number }>;
  actions: RawAction[];
  recovery: {
    daily_cap: number;
    weekly_cap: number;
    fixed: { id: string; credit: number; requires: string | null; explain_key: string }[];
    data: {
      per_mib: number;
      min_award: number;
      max_per_event: number;
      daily_cap: number;
      weekly_cap: number;
      sources: { id: string; explain_key: string }[];
    };
  };
};

/** HP → centi-HP, the same conversion build.rs performs. */
const centi = (hp: number) => Math.round(hp * 100);

/** `cost: severe` and `cost: 0.05` are both legal in the YAML. */
const costCenti = (cost: number | string) =>
  typeof cost === "number" ? centi(cost) : centi(yaml.scale[cost]);

describe("the mirror matches privacy_hp.yaml", () => {
  it("agrees on the meters", () => {
    expect(MIRROR.version).toBe(yaml.version);
    expect(MIRROR.confirmAtCenti).toBe(centi(yaml.confirm_at_hp));
    expect(MIRROR.dailyMaxCenti).toBe(centi(yaml.meters.daily.max));
    expect(MIRROR.dailyRegenCenti).toBe(centi(yaml.meters.daily.regen_hp));
    expect(MIRROR.dailyRegenPerMinutes).toBe(yaml.meters.daily.regen_per_minutes);
    expect(MIRROR.weeklyMaxCenti).toBe(centi(yaml.meters.weekly.max));
    expect(MIRROR.weeklyRegenCenti).toBe(centi(yaml.meters.weekly.regen_hp));
    expect(MIRROR.weeklyRegenPerMinutes).toBe(yaml.meters.weekly.regen_per_minutes);
    expect(MIRROR.weeklyWindowDays).toBe(yaml.meters.weekly.window_days);
  });

  it("agrees on every action, field by field", () => {
    expect(MIRROR.actions.map((a) => a.id)).toEqual(yaml.actions.map((a) => a.id));
    for (const raw of yaml.actions) {
      const mine = MIRROR.actions.find((a) => a.id === raw.id);
      expect(mine, `${raw.id} missing from the mirror`).toBeDefined();
      expect(mine!.kind, `${raw.id}.kind`).toBe(raw.kind);
      expect(mine!.costCenti, `${raw.id}.cost`).toBe(costCenti(raw.cost));
      expect(mine!.perMibCenti, `${raw.id}.per_mib`).toBe(centi(raw.per_mib ?? 0));
      expect(mine!.perMinuteCenti, `${raw.id}.per_minute`).toBe(centi(raw.per_minute ?? 0));
      expect(mine!.capPerEventCenti, `${raw.id}.cap_per_event`).toBe(centi(raw.cap_per_event ?? 0));
      expect(mine!.explainKey, `${raw.id}.explain_key`).toBe(raw.explain_key);
    }
  });

  it("agrees on every recovery, including which exposure it pairs with", () => {
    expect(MIRROR.recoveries.map((r) => r.id)).toEqual(yaml.recovery.fixed.map((r) => r.id));
    for (const raw of yaml.recovery.fixed) {
      const mine = MIRROR.recoveries.find((r) => r.id === raw.id)!;
      expect(mine.creditCenti, `${raw.id}.credit`).toBe(centi(raw.credit));
      expect(mine.requires ?? null, `${raw.id}.requires`).toBe(raw.requires ?? null);
      expect(mine.explainKey, `${raw.id}.explain_key`).toBe(raw.explain_key);
    }
  });

  it("agrees on the data-deletion credit and its caps", () => {
    const d = yaml.recovery.data;
    expect(MIRROR.recoveryDailyCapCenti).toBe(centi(yaml.recovery.daily_cap));
    expect(MIRROR.recoveryWeeklyCapCenti).toBe(centi(yaml.recovery.weekly_cap));
    expect(MIRROR.dataPerMibCenti).toBe(centi(d.per_mib));
    expect(MIRROR.dataMinAwardCenti).toBe(centi(d.min_award));
    expect(MIRROR.dataMaxPerEventCenti).toBe(centi(d.max_per_event));
    expect(MIRROR.dataDailyCapCenti).toBe(centi(d.daily_cap));
    expect(MIRROR.dataWeeklyCapCenti).toBe(centi(d.weekly_cap));
    expect(MIRROR.dataSources.map((s) => s.id)).toEqual(d.sources.map((s) => s.id));
  });
});

describe("the YAML holds to its own rules", () => {
  it("keeps the ladder fixed", () => {
    // Halved 2026-08-24. Pinned as literals because the RATIOS between rungs
    // are what make prices comparable — re-tuning one silently is the thing this
    // assertion exists to catch.
    expect(yaml.scale).toEqual({ negligible: 0.5, low: 1.5, moderate: 2.5, high: 5, severe: 10 });
  });

  it("states every price to at most two decimal places", () => {
    // Everything is stored as integer hundredths; a third place would be lost.
    const all: [string, number][] = [
      ["confirm_at_hp", yaml.confirm_at_hp],
      ...yaml.actions.flatMap((a): [string, number][] => [
        [`${a.id}.cost`, typeof a.cost === "number" ? a.cost : yaml.scale[a.cost]],
        [`${a.id}.per_mib`, a.per_mib ?? 0],
        [`${a.id}.per_minute`, a.per_minute ?? 0],
        [`${a.id}.cap_per_event`, a.cap_per_event ?? 0],
      ]),
      ...yaml.recovery.fixed.map((r): [string, number] => [`${r.id}.credit`, r.credit]),
    ];
    for (const [path, v] of all) {
      expect(Math.abs(v * 100 - Math.round(v * 100)), `${path} = ${v}`).toBeLessThan(1e-6);
    }
  });

  it("puts every fixed price on a ladder rung", () => {
    const rungs = Object.values(yaml.scale);
    for (const a of yaml.actions) {
      if (a.kind === "metered") continue;
      const hp = typeof a.cost === "number" ? a.cost : yaml.scale[a.cost];
      expect(rungs, `${a.id} is off the ladder`).toContain(hp);
    }
    for (const r of yaml.recovery.fixed) {
      expect(rungs, `${r.id} credit is off the ladder`).toContain(r.credit);
    }
  });

  it("caps every metered rate so one event cannot drain a meter", () => {
    for (const a of yaml.actions) {
      if (a.per_mib || a.per_minute) {
        expect(a.cap_per_event, `${a.id} bills by rate but has no cap`).toBeGreaterThan(0);
      }
    }
  });

  it("pairs every requires: with an action that exists", () => {
    const ids = new Set(yaml.actions.map((a) => a.id));
    for (const r of yaml.recovery.fixed) {
      if (r.requires) expect(ids, `${r.id}.requires`).toContain(r.requires);
    }
  });

  it("never lets a single credit exceed the caps that pay it", () => {
    for (const r of yaml.recovery.fixed) {
      expect(r.credit, `${r.id}`).toBeLessThanOrEqual(yaml.recovery.daily_cap);
    }
    expect(yaml.recovery.data.max_per_event).toBeLessThanOrEqual(yaml.recovery.data.daily_cap);
    expect(yaml.recovery.data.daily_cap).toBeLessThanOrEqual(yaml.recovery.data.weekly_cap);
    expect(yaml.recovery.daily_cap).toBeLessThanOrEqual(yaml.recovery.weekly_cap);
  });

  it("keeps key rotation paying more than a plain passphrase change", () => {
    const by = (id: string) => yaml.recovery.fixed.find((r) => r.id === id)!.credit;
    expect(by("local.reencrypt.keyring")).toBeGreaterThan(by("local.passphrase.change"));
    expect(by("local.reencrypt.files")).toBeGreaterThan(by("local.passphrase.change"));
    expect(by("local.passphrase.strengthen")).toBeGreaterThan(by("local.passphrase.change"));
  });

  it("gives no action a unique id twice", () => {
    const ids = yaml.actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
