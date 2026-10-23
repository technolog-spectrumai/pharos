// @vitest-environment jsdom
//
// The theme, read from the one place it lives: the `.dark` class on <html>.
//
// What is pinned is FOLLOWING the theme rather than sampling it. A widget that
// paints its own chrome read the class once at mount and stayed dark after the
// user switched to light; these tests change the class after subscribing and
// assert the change arrives — and that a class change that is not a theme
// change does not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = () => document.documentElement;

/** MutationObserver callbacks run as microtasks; one turn of the event loop
 *  delivers every record queued before it. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  html().className = "";
  vi.resetModules();
});

afterEach(() => {
  html().className = "";
});

describe("reading the theme", () => {
  it("is dark exactly when <html> carries the dark class", async () => {
    const { isDark } = await import("../../src/theme/theme");
    expect(isDark()).toBe(false);
    html().classList.add("dark");
    expect(isDark()).toBe(true);
  });

  it("is not fooled by a class that merely contains the word", async () => {
    const { isDark } = await import("../../src/theme/theme");
    html().className = "darkish not-dark";
    expect(isDark()).toBe(false);
  });
});

describe("being told when it changes", () => {
  it("reports a switch to dark and back to light, in order", async () => {
    const { watchDark } = await import("../../src/theme/theme");
    const seen: boolean[] = [];
    const stop = watchDark((dark) => seen.push(dark));

    html().classList.add("dark");
    await settle();
    html().classList.remove("dark");
    await settle();

    expect(seen).toEqual([true, false]);
    stop();
  });

  it("stays quiet when another class changes and the theme does not", async () => {
    // App.vue is not the only writer of <html>'s classes. Re-theming Univer
    // for every unrelated class toggle would repaint the sheet for nothing.
    const { watchDark } = await import("../../src/theme/theme");
    html().classList.add("dark");
    const onChange = vi.fn();
    const stop = watchDark(onChange);

    html().classList.add("modal-open");
    await settle();
    html().classList.remove("modal-open");
    await settle();

    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it("ignores attributes other than class", async () => {
    const { watchDark } = await import("../../src/theme/theme");
    const onChange = vi.fn();
    const stop = watchDark(onChange);

    html().setAttribute("lang", "pl");
    html().setAttribute("data-theme", "dark");
    await settle();

    expect(onChange).not.toHaveBeenCalled();
    stop();
    html().removeAttribute("lang");
    html().removeAttribute("data-theme");
  });

  it("stops reporting once unsubscribed", async () => {
    const { watchDark } = await import("../../src/theme/theme");
    const onChange = vi.fn();
    const stop = watchDark(onChange);

    stop();
    html().classList.add("dark");
    await settle();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("compares against the theme at subscription, not at import", async () => {
    // The baseline is sampled when `watchDark` is called. Had it been taken
    // earlier, a subscriber arriving after a switch would be told about a
    // change that happened before it was listening.
    const { watchDark } = await import("../../src/theme/theme");
    html().classList.add("dark");
    await settle();

    const seen: boolean[] = [];
    const stop = watchDark((dark) => seen.push(dark));
    html().classList.add("dark-again-but-still-dark");
    await settle();
    html().classList.remove("dark");
    await settle();

    expect(seen).toEqual([false]);
    stop();
  });
});

describe("the theme as a reactive value", () => {
  it("starts from the class as it was when the module loaded", async () => {
    html().classList.add("dark");
    const { isDarkRef } = await import("../../src/theme/theme");
    expect(isDarkRef.value).toBe(true);
  });

  it("follows the class afterwards, so a computed built on it recomputes", async () => {
    const { computed } = await import("vue");
    const { isDarkRef } = await import("../../src/theme/theme");
    const paper = computed(() => (isDarkRef.value ? "black" : "white"));
    expect(paper.value).toBe("white");

    html().classList.add("dark");
    await settle();
    expect(paper.value).toBe("black");

    html().classList.remove("dark");
    await settle();
    expect(paper.value).toBe("white");
  });

  it("cannot be written from outside — the class stays the source of truth", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { isDarkRef } = await import("../../src/theme/theme");

    (isDarkRef as unknown as { value: boolean }).value = true;

    expect(isDarkRef.value).toBe(false);
    warn.mockRestore();
  });
});
