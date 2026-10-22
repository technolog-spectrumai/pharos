import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { i18n } from "../../src/i18n";
import PinPad from "../../src/components/PinPad.vue";

// The keypad's contract: it shows HOW MANY digits are in, never which ones; it
// submits itself on the last digit (a fixed-length PIN has no "done" step); and
// a rejected attempt clears it so the next try starts from empty.

const GLOBAL = () => ({ plugins: [i18n] });

function mountPad(props: Record<string, unknown> = {}) {
  return mount(PinPad, { props: { digits: 6, ...props }, global: GLOBAL() });
}

const filled = (w: ReturnType<typeof mountPad>) =>
  w.findAll("[data-testid='pin-dots'] span").filter((s) => s.attributes("data-filled") === "true").length;

describe("PinPad", () => {
  it("renders one dot per digit and fills them as keys are pressed", async () => {
    const w = mountPad({ digits: 4 });
    expect(w.findAll("[data-testid='pin-dots'] span")).toHaveLength(4);
    expect(filled(w)).toBe(0);

    await w.find("[data-testid='pin-key-1']").trigger("click");
    await w.find("[data-testid='pin-key-2']").trigger("click");
    expect(filled(w)).toBe(2);
  });

  it("submits exactly once, on the last digit", async () => {
    const w = mountPad({ digits: 4 });
    for (const n of [1, 2, 3]) await w.find(`[data-testid='pin-key-${n}']`).trigger("click");
    expect(w.emitted("submit")).toBeUndefined();

    await w.find("[data-testid='pin-key-4']").trigger("click");
    expect(w.emitted("submit")).toHaveLength(1);
    expect(w.emitted("submit")![0][0]).toBe("1234");
  });

  it("never accepts more digits than the PIN length", async () => {
    const w = mountPad({ digits: 4 });
    for (const n of [1, 2, 3, 4]) await w.find(`[data-testid='pin-key-${n}']`).trigger("click");
    await w.find("[data-testid='pin-key-5']").trigger("click");
    expect(w.emitted("submit")).toHaveLength(1); // not two
  });

  it("backspace removes the last digit and is disabled when empty", async () => {
    const w = mountPad({ digits: 4 });
    expect(w.find("[data-testid='pin-backspace']").attributes("disabled")).toBeDefined();

    await w.find("[data-testid='pin-key-7']").trigger("click");
    expect(filled(w)).toBe(1);
    await w.find("[data-testid='pin-backspace']").trigger("click");
    expect(filled(w)).toBe(0);
  });

  it("clears itself when the parent reports a failed attempt", async () => {
    const w = mountPad({ digits: 4 });
    for (const n of [1, 2, 3, 4]) await w.find(`[data-testid='pin-key-${n}']`).trigger("click");
    // Submitted, but the dots stay filled until the verdict comes back — the
    // pad must not look empty while the attempt is still being checked.
    expect(filled(w)).toBe(4);

    await w.setProps({ error: "Wrong PIN." });
    await flushPromises();
    expect(filled(w)).toBe(0);
    expect(w.find("[data-testid='pin-error']").text()).toBe("Wrong PIN.");
  });

  it("accepts physical number keys and Backspace", async () => {
    const w = mountPad({ digits: 4 });
    for (const key of ["5", "5", "5"]) window.dispatchEvent(new KeyboardEvent("keydown", { key }));
    await flushPromises();
    expect(filled(w)).toBe(3);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));
    await flushPromises();
    expect(filled(w)).toBe(2);

    // Non-digits are ignored rather than swallowed as input.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await flushPromises();
    expect(filled(w)).toBe(2);
  });

  it("takes no input while an attempt is in flight", async () => {
    const w = mountPad({ digits: 4, busy: true });
    await w.find("[data-testid='pin-key-1']").trigger("click");
    expect(filled(w)).toBe(0);
    expect(w.emitted("submit")).toBeUndefined();
  });

  it("stops listening to the keyboard once unmounted", async () => {
    const w = mountPad({ digits: 4 });
    const spy = vi.spyOn(window, "removeEventListener");
    w.unmount();
    expect(spy).toHaveBeenCalledWith("keydown", expect.any(Function));
    spy.mockRestore();
  });
});
