import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import CollabPanel from "../../src/collab/CollabPanel.vue";
import { createCollabSession } from "../../src/collab/useCollabSession";
import { createSketch } from "../../src/sketch/useSketch";
import { i18n } from "../../src/i18n";
import { makeFakeNet, SAS } from "../helpers/fakeBus";

function setup() {
  const net = makeFakeNet();
  const a = createCollabSession(net.host, { me: "alice" });
  const b = createCollabSession(net.joiner, { me: "bob" });
  a.attach(createSketch());
  b.attach(createSketch());
  const mountFor = (session: typeof a) =>
    mount(CollabPanel, {
      props: { session },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
  return { net, a, b, mountFor };
}

beforeEach(() => {
  i18n.global.locale.value = "en";
});

describe("the Collab panel", () => {
  it("offers to share or to join, and nothing else, while idle", () => {
    const { a, mountFor } = setup();
    const w = mountFor(a);
    expect(w.find('[data-testid="collab-share"]').exists()).toBe(true);
    expect(w.find('[data-testid="collab-join"]').exists()).toBe(true);
    expect(w.find('[data-testid="collab-ticket"]').exists()).toBe(false);
    expect(w.find('[data-testid="collab-sas"]').exists()).toBe(false);
  });

  it("shows the code when sharing, then the digits and Accept when someone scans it", async () => {
    const { net, a, b, mountFor } = setup();
    const w = mountFor(a);
    await w.get('[data-testid="collab-share"]').trigger("click");
    await flushPromises();
    const ticket = w.get('[data-testid="collab-ticket"]').text();
    expect(ticket).toMatch(/^ticket-/);
    expect(w.find('[data-testid="collab-accept"]').exists()).toBe(false);

    await b.join(ticket);
    await net.settle();
    await flushPromises();
    expect(w.get('[data-testid="collab-sas"]').text()).toBe(SAS);
    expect(w.find('[data-testid="collab-accept"]').exists()).toBe(true);
    expect(w.find('[data-testid="collab-ticket"]').exists()).toBe(false);

    await w.get('[data-testid="collab-accept"]').trigger("click");
    await net.settle();
    await flushPromises();
    expect(w.find('[data-testid="collab-live"]').exists()).toBe(true);
    expect(b.phase.value).toBe("live");
  });

  it("joins from a pasted code and waits for the host, showing the same digits", async () => {
    const { net, a, b, mountFor } = setup();
    await a.host();
    const w = mountFor(b);
    await w.get('[data-testid="collab-join"]').trigger("click");
    await w.get("input").setValue(a.ticket.value!);
    await w.get('[data-testid="collab-connect"]').trigger("click");
    await net.settle();
    await flushPromises();
    expect(w.get('[data-testid="collab-sas"]').text()).toBe(SAS);
    expect(w.find('[data-testid="collab-waiting"]').exists()).toBe(true);
    // The joiner has no Accept: the decision is the host's.
    expect(w.find('[data-testid="collab-accept"]').exists()).toBe(false);
  });

  it("says why a bad code failed, in words", async () => {
    const { b, mountFor } = setup();
    const w = mountFor(b);
    await w.get('[data-testid="collab-join"]').trigger("click");
    await w.get("input").setValue("nonsense");
    await w.get('[data-testid="collab-connect"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-testid="collab-error"]').text()).toBe(i18n.global.t("collab.errors.bad_ticket"));
    expect(w.find('[data-testid="collab-share"]').exists()).toBe(true); // back to idle
  });

  it("refusing the digits ends the session on both sides", async () => {
    const { net, a, b, mountFor } = setup();
    const w = mountFor(a);
    await a.host();
    await b.join(a.ticket.value!);
    await net.settle();
    await flushPromises();
    await w.get('[data-testid="collab-reject"]').trigger("click");
    await net.settle();
    await flushPromises();
    expect(a.phase.value).toBe("idle");
    expect(b.peerOnline.value).toBe(false);
    expect(w.find('[data-testid="collab-share"]').exists()).toBe(true);
  });
});
