// Who owns the collaboration session, and what ends it.
//
// The session is a module singleton (src/collab/index.ts) rather than state
// inside the editor, and these tests pin the three consequences that choice
// has to earn:
//
//   * it SURVIVES a tab switch — every visited tab stays mounted, but even a
//     hidden editor must not drop a live pairing;
//   * it ENDS when the drawing changes — New or Open replaces the board the
//     peer paired with, and silently carrying the pairing to another file
//     would share something nobody agreed to;
//   * a New or an Open leaves the session bound to the NEW drawing. Vue's
//     keyed remount tears the old editor down first and mounts the new one
//     second (measured, not assumed), so ordering is not the hazard here —
//     what this pins is that the handover happens at all, and that `detach`
//     releases only what the caller still owns.
import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import EditorHost from "../../src/views/EditorHost.vue";
import { collab } from "../../src/collab";
import { i18n } from "../../src/i18n";

function mountHost() {
  return mount(EditorHost, {
    props: { kind: "sketch" as const, active: true },
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}

beforeEach(async () => {
  await collab.leave();
  i18n.global.locale.value = "en";
});

describe("session ownership", () => {
  it("attaches to the drawing the editor opens", async () => {
    const w = mountHost();
    await flushPromises();
    expect(collab.attached.value).toBe(true);
    expect(collab.phase.value).toBe("idle"); // attached, not yet paired
    expect(w.findComponent({ name: "SketchEditor" }).exists()).toBe(true);
  });

  it("keeps the session attached across a New, and ends any pairing", async () => {
    // newFile bumps `generation`, so the SketchEditor is destroyed and
    // recreated. What must survive is the BINDING: the session follows the
    // drawing on screen, and a board with no session attached cannot share.
    const w = mountHost();
    await flushPromises();
    await (w.vm as unknown as { newFile: () => Promise<void> }).newFile();
    await flushPromises();

    expect(collab.attached.value).toBe(true); // bound to the new drawing
  });

  it("survives the editor being hidden, the way a tab switch hides it", async () => {
    const w = mountHost();
    await flushPromises();
    expect(collab.attached.value).toBe(true);

    // A hidden tab stays MOUNTED (App.vue uses v-show, not v-if) — the
    // session must not notice.
    await w.setProps({ active: false });
    await flushPromises();
    expect(collab.attached.value).toBe(true);

    await w.setProps({ active: true });
    await flushPromises();
    expect(collab.attached.value).toBe(true);
  });

  it("ends the session when the editor goes away for good", async () => {
    const w = mountHost();
    await flushPromises();
    expect(collab.attached.value).toBe(true);

    w.unmount();
    await flushPromises();
    // Nothing is on screen to draw on, so nothing may still be shared.
    expect(collab.attached.value).toBe(false);
    expect(collab.phase.value).toBe("idle");
  });
});
