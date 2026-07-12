import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { OyaButton } from "rakotis";
import { OyaCard } from "rakotis";
import ChatBubble from "../../src/components/ChatBubble.vue";
import type { Message } from "../../src/stores/chat";

describe("OyaButton", () => {
  it("renders slot content and emits native clicks", async () => {
    const wrapper = mount(OyaButton, {
      props: { darkMode: true },
      slots: { default: "Press me" },
    });
    expect(wrapper.text()).toContain("Press me");
    await wrapper.trigger("click");
    expect(wrapper.emitted("click")).toHaveLength(1);
  });

  it("applies the primary palette in dark mode by default", () => {
    const wrapper = mount(OyaButton, { props: { darkMode: true } });
    expect(wrapper.classes()).toContain("bg-accent-dark");
  });

  it("applies the secondary palette when variant=secondary", () => {
    const wrapper = mount(OyaButton, { props: { darkMode: false, variant: "secondary" } });
    expect(wrapper.classes()).toContain("bg-bubble-bg-light");
  });

  it("honours the type prop", () => {
    const wrapper = mount(OyaButton, { props: { darkMode: true, type: "submit" } });
    expect(wrapper.attributes("type")).toBe("submit");
  });
});

describe("OyaCard", () => {
  it("renders its slot", () => {
    const wrapper = mount(OyaCard, { props: { darkMode: true }, slots: { default: "Body" } });
    expect(wrapper.text()).toBe("Body");
  });
  it("uses compact padding when padded=false", () => {
    const wrapper = mount(OyaCard, { props: { darkMode: true, padded: false } });
    expect(wrapper.classes()).toContain("pb-2");
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
    const wrapper = mount(ChatBubble, { props: { darkMode: true, message: msg({ content: "hi there" }) } });
    expect(wrapper.text()).toContain("Bob");
    expect(wrapper.text()).toContain("hi there");
  });

  it("renders an image message as an <img>", () => {
    const wrapper = mount(ChatBubble, {
      props: { darkMode: true, message: msg({ type: "image_message", image_data: "data:image/png;base64,xx" }) },
    });
    expect(wrapper.find("img").exists()).toBe(true);
  });

  it("renders a voice message as an <audio> control", () => {
    const wrapper = mount(ChatBubble, {
      props: { darkMode: true, message: msg({ type: "voice_message", audio_data: "data:audio/webm;base64,yy" }) },
    });
    expect(wrapper.find("audio").exists()).toBe(true);
  });

  it("right-aligns the author's own messages", () => {
    const wrapper = mount(ChatBubble, { props: { darkMode: true, message: msg({ self: true }) } });
    expect(wrapper.find("article").classes()).toContain("justify-end");
  });

  it("shows initials when there is no avatar", () => {
    const wrapper = mount(ChatBubble, { props: { darkMode: false, message: msg({ initials: "ZZ" }) } });
    expect(wrapper.text()).toContain("ZZ");
  });
});
