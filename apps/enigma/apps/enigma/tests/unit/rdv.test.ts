import { describe, it, expect, beforeEach } from "vitest";

// Cloud rendezvous (rdv.md): the opt-in kv flag the Rust publisher/lookup
// self-gate on. Browser mode uses the localStorage kv fallback, so the
// accessors are testable without Tauri — and the default MUST be off
// (publishing to a server is a deliberate choice).

import { getRdvPublish, setRdvPublish } from "rakotis";

beforeEach(() => {
  localStorage.clear();
});

describe("cloud rendezvous toggle", () => {
  it("defaults to off", async () => {
    expect(await getRdvPublish()).toBe(false);
  });

  it("round-trips through the kv fallback", async () => {
    await setRdvPublish(true);
    expect(await getRdvPublish()).toBe(true);
    await setRdvPublish(false);
    expect(await getRdvPublish()).toBe(false);
  });
});
