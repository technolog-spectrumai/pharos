import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import {
  OyaButton,
  OyaCard,
  OyaIconButton,
  OyaBadge,
  OyaAvatar,
  OyaTextField,
  OyaTextArea,
  OyaCopyField,
  OyaQrCode,
} from "rakotis";
import ChatBubble from "../../src/components/ChatBubble.vue";
import type { Message } from "../../src/stores/chat";
import { i18n } from "../../src/i18n";

// Dark mode is now class-based (`.dark` on <html>); components carry `light + dark:`
// class pairs instead of a `darkMode` prop.
vi.mock("qrcode", () => ({ toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,QR") }));

describe("OyaButton", () => {
  it("renders slot content and emits native clicks", async () => {
    const wrapper = mount(OyaButton, { slots: { default: "Press me" } });
    expect(wrapper.text()).toContain("Press me");
    await wrapper.trigger("click");
    expect(wrapper.emitted("click")).toHaveLength(1);
  });

  it("applies the primary palette by default (light base + dark: variant)", () => {
    const wrapper = mount(OyaButton);
    expect(wrapper.classes()).toContain("bg-accent-light");
    expect(wrapper.classes()).toContain("dark:bg-accent-dark");
  });

  it("applies the secondary palette when variant=secondary", () => {
    const wrapper = mount(OyaButton, { props: { variant: "secondary" } });
    expect(wrapper.classes()).toContain("bg-bubble-bg-light");
    expect(wrapper.classes()).toContain("dark:bg-bubble-bg-dark");
  });

  it("honours the type prop", () => {
    const wrapper = mount(OyaButton, { props: { type: "submit" } });
    expect(wrapper.attributes("type")).toBe("submit");
  });
});

describe("OyaCard", () => {
  it("renders its slot", () => {
    const wrapper = mount(OyaCard, { slots: { default: "Body" } });
    expect(wrapper.text()).toBe("Body");
  });
  it("uses compact padding when padded=false", () => {
    const wrapper = mount(OyaCard, { props: { padded: false } });
    expect(wrapper.classes()).toContain("pb-2");
  });
});

describe("OyaIconButton", () => {
  it("exposes an aria-label and reflects the disabled state", () => {
    const wrapper = mount(OyaIconButton, { props: { icon: "camera", label: "Scan", disabled: true } });
    expect(wrapper.attributes("aria-label")).toBe("Scan");
    expect(wrapper.attributes("disabled")).toBeDefined();
    expect(wrapper.classes()).toContain("cursor-not-allowed");
  });
});

describe("OyaBadge", () => {
  it("applies the theme-aware success palette", () => {
    const wrapper = mount(OyaBadge, { props: { tone: "success" }, slots: { default: "On" } });
    expect(wrapper.text()).toContain("On");
    expect(wrapper.classes()).toContain("bg-success-light");
    expect(wrapper.classes()).toContain("dark:bg-success-dark");
  });
});

describe("OyaAvatar", () => {
  it("derives initials from name when there is no src", () => {
    const wrapper = mount(OyaAvatar, { props: { name: "Zoe" } });
    expect(wrapper.text()).toBe("ZO");
    expect(wrapper.find("img").exists()).toBe(false);
  });
  it("renders an <img> when src is set", () => {
    const wrapper = mount(OyaAvatar, { props: { name: "Zoe", src: "data:image/png;base64,xx" } });
    expect(wrapper.find("img").exists()).toBe(true);
  });
});

describe("OyaTextField / OyaTextArea", () => {
  it("OyaTextField emits update:modelValue on input and enter", async () => {
    const wrapper = mount(OyaTextField, { props: { modelValue: "" } });
    await wrapper.find("input").setValue("hello");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["hello"]);
    await wrapper.find("input").trigger("keyup.enter");
    expect(wrapper.emitted("enter")).toHaveLength(1);
  });
  it("OyaTextArea emits update:modelValue on input", async () => {
    const wrapper = mount(OyaTextArea, { props: { modelValue: "" } });
    await wrapper.find("textarea").setValue("draft");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["draft"]);
  });
});

describe("OyaCopyField", () => {
  it("copies the value, emits copied, and flips the tick", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const wrapper = mount(OyaCopyField, { props: { value: "ticket-xyz", copyLabel: "Copy" } });
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("ticket-xyz");
    expect(wrapper.emitted("copied")).toHaveLength(1);
    expect(wrapper.find("button").text()).toBe("✓");
  });
});

describe("OyaQrCode", () => {
  it("renders an <img> once the QR data URL resolves", async () => {
    const wrapper = mount(OyaQrCode, { props: { value: "abc", size: 100 } });
    await flushPromises();
    expect(wrapper.find("img").exists()).toBe(true);
  });

  it("fills the width it is given on phones, capping only on desktop", async () => {
    // A QR is only useful if the other camera can resolve it: a fixed 176px
    // code is unscannable on a phone. `size` is the DESKTOP cap; below `lg`
    // the image takes its container's width.
    const wrapper = mount(OyaQrCode, { props: { value: "abc", size: 176 } });
    await flushPromises();
    const img = wrapper.find("img");
    expect(img.classes()).toContain("w-full");
    expect(img.classes()).toContain("aspect-square");
    // The desktop cap is applied only from `lg` up...
    expect(img.classes()).toContain("lg:max-w-[var(--qr-cap)]");
    expect(img.attributes("style")).toContain("--qr-cap: 176px");
    // ...and it is NOT a fixed width/height any more.
    expect(img.attributes("style")).not.toContain("width: 176px");
  });

  it("generates at a fixed high resolution regardless of display size", async () => {
    // Generating at the CSS size makes a phone-width code blurry, which costs
    // more scans than being small does.
    const { toDataURL } = await import("qrcode");
    (toDataURL as unknown as { mockClear: () => void }).mockClear();
    mount(OyaQrCode, { props: { value: "abc", size: 100 } });
    await flushPromises();
    const opts = (toDataURL as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1];
    expect((opts as { width: number }).width).toBe(640);
  });
});

function msg(over: Partial<Message> = {}): Message {
  return {
    id: over.id ?? "1",
    user: over.user ?? "Bob",
    initials: over.initials ?? "BO",
    content: over.content ?? "hello",
    timestamp: over.timestamp ?? new Date("2026-01-01T10:00:00Z"),
    self: over.self ?? false,
    type: over.type ?? "chat_message",
    avatar_url: over.avatar_url,
    image_data: over.image_data,
    audio_data: over.audio_data,
    encrypted: over.encrypted,
  } as Message;
}

describe("ChatBubble", () => {
  it("renders a plain text message with the author and body", () => {
    const wrapper = mount(ChatBubble, { props: { message: msg({ content: "hi there" }) } });
    expect(wrapper.text()).toContain("Bob");
    expect(wrapper.text()).toContain("hi there");
  });

  it("renders an image message as an <img>", () => {
    const wrapper = mount(ChatBubble, {
      props: { message: msg({ type: "image_message", image_data: "data:image/png;base64,xx" }) },
    });
    expect(wrapper.find("img").exists()).toBe(true);
  });

  it("renders a voice message as an <audio> control", () => {
    const wrapper = mount(ChatBubble, {
      props: { message: msg({ type: "voice_message", audio_data: "data:audio/webm;base64,yy" }) },
    });
    expect(wrapper.find("audio").exists()).toBe(true);
  });

  it("says a map share cannot be shown, rather than rendering an empty bubble", () => {
    // Maps left the app; such a message is still in old histories and can
    // still arrive from a peer on an older build. It carries no text.
    for (const type of ["map_pin", "map_loc", "map_region"] as const) {
      const wrapper = mount(ChatBubble, {
        props: { message: msg({ type, content: "" }) },
        global: { plugins: [i18n] },
      });
      expect(wrapper.get('[data-testid="map-share-unavailable"]').text()).toContain("no maps");
      expect(wrapper.text()).toContain("Bob");
    }
  });

  it("right-aligns the author's own messages", () => {
    const wrapper = mount(ChatBubble, { props: { message: msg({ self: true }) } });
    expect(wrapper.find("article").classes()).toContain("justify-end");
  });

  it("shows initials when there is no avatar", () => {
    const wrapper = mount(ChatBubble, { props: { message: msg({ initials: "ZZ" }) } });
    expect(wrapper.text()).toContain("ZZ");
  });
});
