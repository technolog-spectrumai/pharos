import { ref, computed } from "vue";
import { defineStore } from "pinia";
import { api, type Room, type Participant } from "../services/api";
import { wsService, type WsStatus } from "../services/ws";
import { nanoid } from "nanoid";

export interface Message {
  id: string;
  type: "chat_message" | "system_error" | "system_info";
  user: string;
  initials: string;
  avatar_url: string | null;
  content: string;
  participant_type: "human" | "ai_agent" | "system";
  self: boolean;
  timestamp: Date;
}

export const useChatStore = defineStore("chat", () => {
  const rooms = ref<Room[]>([]);
  const currentRoom = ref<Room | null>(null);
  const messages = ref<Message[]>([]);
  const participants = ref<Participant[]>([]);
  const wsStatus = ref<WsStatus>("disconnected");
  const loadingRooms = ref(false);
  const error = ref<string | null>(null);

  // Current user display name (set from user store via App.vue)
  const currentUserName = ref<string>("You");

  const isConnected = computed(() => wsStatus.value === "connected");

  // Register WS handlers once
  wsService.onStatus((status) => {
    wsStatus.value = status;
    if (status === "connected") {
      messages.value.push(makeSystemMessage(`Connected to ${currentRoom.value?.name ?? "room"}.`));
    } else if (status === "disconnected") {
      messages.value.push(makeSystemMessage("Disconnected."));
    } else if (status === "error") {
      messages.value.push(makeSystemMessage("Connection error — retrying…", "system_error"));
    }
  });

  wsService.onMessage((data) => {
    if (data.type === "chat_message" && data.message) {
      const isSelf = data.user === currentUserName.value;
      messages.value.push({
        id: nanoid(),
        type: "chat_message",
        user: data.user ?? "Unknown",
        initials: initials(data.user ?? "?"),
        avatar_url: (data.avatar_url as string) ?? null,
        content: data.message as string,
        participant_type: (data.participant_type as "human" | "ai_agent") ?? "human",
        self: isSelf,
        timestamp: new Date(),
      });
    } else if (data.type === "system_error" && data.message) {
      messages.value.push(makeSystemMessage(data.message as string, "system_error"));
    }
  });

  function makeSystemMessage(
    content: string,
    type: "system_info" | "system_error" = "system_info"
  ): Message {
    return {
      id: nanoid(),
      type,
      user: "System",
      initials: "S",
      avatar_url: null,
      content,
      participant_type: "system",
      self: false,
      timestamp: new Date(),
    };
  }

  function initials(name: string): string {
    return name
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }

  async function fetchRooms() {
    loadingRooms.value = true;
    error.value = null;
    try {
      const data = await api.getRooms();
      rooms.value = data.rooms;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loadingRooms.value = false;
    }
  }

  async function joinRoom(slug: string) {
    // Leave existing connection
    if (currentRoom.value?.slug === slug) return;
    wsService.disconnect();
    messages.value = [];
    participants.value = [];
    currentRoom.value = null;

    try {
      const room = await api.getRoom(slug);
      currentRoom.value = room;
      participants.value = room.participants ?? [];
      wsService.connect(slug);
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  function leaveRoom() {
    wsService.disconnect();
    currentRoom.value = null;
    messages.value = [];
    participants.value = [];
  }

  function sendMessage(content: string) {
    if (!content.trim() || !isConnected.value) return;
    wsService.send({ type: "chat_message", message: content.trim() });
  }

  return {
    rooms,
    currentRoom,
    messages,
    participants,
    wsStatus,
    loadingRooms,
    error,
    isConnected,
    currentUserName,
    fetchRooms,
    joinRoom,
    leaveRoom,
    sendMessage,
  };
});
