import { ref, computed } from "vue";
import { defineStore } from "pinia";
import { api, type Room, type Participant } from "../services/api";
import { wsService, type WsStatus } from "../services/ws";
import { cryptoService, bytesToBase64, base64ToBytes } from "../services/crypto";
import { nanoid } from "nanoid";

export type MlsStatus =
  | "idle"
  | "initializing"
  | "key_exchange"   // sent key package, waiting for welcome
  | "ready"          // in a group, can encrypt
  | "error";

export interface Message {
  id: string;
  type: "chat_message" | "mls_app" | "system_error" | "system_info";
  user: string;
  initials: string;
  avatar_url: string | null;
  content: string;
  participant_type: "human" | "system";
  self: boolean;
  encrypted: boolean;
  timestamp: Date;
}

const log = (...args: unknown[]) => console.log("[enigma-chat]", ...args);

export const useChatStore = defineStore("chat", () => {
  const rooms = ref<Room[]>([]);
  const currentRoom = ref<Room | null>(null);
  const messages = ref<Message[]>([]);
  const participants = ref<Participant[]>([]);
  const wsStatus = ref<WsStatus>("disconnected");
  const loadingRooms = ref(false);
  const error = ref<string | null>(null);

  const currentUserName = ref<string>("You");

  // MLS state
  const mlsStatus = ref<MlsStatus>("idle");
  const mlsError = ref<string | null>(null);

  // track which device IDs we've already invited so we don't double-add
  const pendingInvites = new Set<string>();

  const isParticipant = ref(false);

  const isConnected = computed(() => wsStatus.value === "connected");
  const isEncrypted = computed(() => mlsStatus.value === "ready");

  function initials(name: string): string {
    return name.split(/\s+/).map(w => w[0] ?? "").slice(0, 2).join("").toUpperCase();
  }

  function systemMsg(content: string, type: "system_info" | "system_error" = "system_info"): Message {
    return {
      id: nanoid(), type, user: "System", initials: "S",
      avatar_url: null, content, participant_type: "system",
      self: false, encrypted: false, timestamp: new Date(),
    };
  }

  // ── WS status ────────────────────────────────────────────────────────────────
  wsService.onStatus((status) => {
    log("ws status →", status);
    wsStatus.value = status;
    if (status === "connected") {
      messages.value.push(systemMsg(`Connected to ${currentRoom.value?.name ?? "room"}.`));
      // Start MLS when WS is ready
      void startMls();
    } else if (status === "disconnected") {
      messages.value.push(systemMsg("Disconnected."));
      mlsStatus.value = "idle";
    } else if (status === "error") {
      messages.value.push(systemMsg("Connection error — retrying…", "system_error"));
    }
  });

  // ── WS messages ──────────────────────────────────────────────────────────────
  wsService.onMessage((data) => {
    void handleMessage(data);
  });

  async function handleMessage(data: Record<string, unknown>) {
    const type = data.type as string;
    log("ws →", type, data);

    if (type === "chat_message" && data.message) {
      messages.value.push({
        id: nanoid(), type: "chat_message",
        user: (data.user as string) ?? "Unknown",
        initials: initials((data.user as string) ?? "?"),
        avatar_url: (data.avatar_url as string) ?? null,
        content: data.message as string,
        participant_type: "human",
        self: data.user === currentUserName.value,
        encrypted: false,
        timestamp: new Date(),
      });
      return;
    }

    if (type === "system_error" && data.message) {
      messages.value.push(systemMsg(data.message as string, "system_error"));
      return;
    }

    if (type === "mls_key_package" && data.key_package) {
      const deviceId = (data.device_id as string) ?? (data.sender_channel as string);
      if (mlsStatus.value === "ready" && currentRoom.value && !pendingInvites.has(deviceId)) {
        pendingInvites.add(deviceId);
        log("Adding MLS member", deviceId);
        messages.value.push(systemMsg("🔑 Adding peer to encrypted group…"));
        const kp = base64ToBytes(data.key_package as string);
        const result = await cryptoService.addMember(
          currentRoom.value.slug, currentUserName.value, kp
        );
        if (result) {
          wsService.send({ type: "mls_commit", commit: bytesToBase64(result.commit) });
          wsService.send({
            type: "mls_welcome",
            welcome: bytesToBase64(result.welcome),
            target_channel: data.sender_channel,
          });
          log("Sent welcome + commit to", deviceId);
          messages.value.push(systemMsg("🔒 Peer added to encrypted group."));
        } else {
          log("addMember failed for", deviceId);
          pendingInvites.delete(deviceId);
        }
      }
      return;
    }

    if (type === "mls_welcome" && data.welcome) {
      if (mlsStatus.value === "key_exchange" && currentRoom.value) {
        log("Joining MLS group from welcome");
        messages.value.push(systemMsg("🔑 Received group invitation — joining encrypted group…"));
        const ok = await cryptoService.joinFromWelcome(
          currentRoom.value.slug, currentUserName.value,
          base64ToBytes(data.welcome as string),
        );
        if (ok) {
          mlsStatus.value = "ready";
          log("MLS ready (joined group)");
          messages.value.push(systemMsg("🔒 End-to-end encryption active."));
        } else {
          mlsStatus.value = "error";
          mlsError.value = "Failed to join encrypted group.";
          messages.value.push(systemMsg("Failed to join encrypted group.", "system_error"));
        }
      }
      return;
    }

    if (type === "mls_commit" && data.commit) {
      if ((mlsStatus.value === "ready" || mlsStatus.value === "key_exchange") && currentRoom.value) {
        log("Processing MLS commit");
        await cryptoService.processMessage(
          currentRoom.value.slug, currentUserName.value,
          base64ToBytes(data.commit as string),
        );
      }
      return;
    }

    if (type === "mls_app" && data.ciphertext) {
      if (data.device_id === currentUserName.value) {
        log("Ignoring own mls_app echo");
        return;
      }
      if (mlsStatus.value === "ready" && currentRoom.value) {
        log("Decrypting mls_app");
        const plaintext = await cryptoService.processMessage(
          currentRoom.value.slug, currentUserName.value,
          base64ToBytes(data.ciphertext as string),
        );
        if (plaintext) {
          messages.value.push({
            id: nanoid(), type: "mls_app",
            user: "Peer",
            initials: "P",
            avatar_url: null,
            content: new TextDecoder().decode(plaintext),
            participant_type: "human",
            self: false,
            encrypted: true,
            timestamp: new Date(),
          });
        } else {
          log("Decryption returned null for mls_app");
          messages.value.push(systemMsg("⚠ Could not decrypt an incoming message.", "system_error"));
        }
      }
      return;
    }
  }

  // ── MLS init ─────────────────────────────────────────────────────────────────
  async function startMls() {
    if (!currentRoom.value || !currentUserName.value) return;
    const room = currentRoom.value.slug;
    const identity = currentUserName.value;

    log("startMls", room, identity);
    mlsStatus.value = "initializing";
    mlsError.value = null;
    pendingInvites.clear();

    try {
      const restored = await cryptoService.initSession(room, identity);
      log("MLS session", restored ? "restored" : "created");

      if (restored) {
        mlsStatus.value = "ready";
        messages.value.push(systemMsg("🔒 Encryption session restored."));
      } else {
        // Broadcast key package so anyone already in a group can invite us
        const kp = await cryptoService.keyPackage(room, identity);
        if (kp) {
          wsService.send({ type: "mls_key_package", key_package: bytesToBase64(kp), device_id: identity });
          log("Key package sent");
          messages.value.push(systemMsg("🔑 Key package sent — waiting for group invitation…"));
          mlsStatus.value = "key_exchange";

          // Become the group creator after a short grace period if no welcome arrives
          setTimeout(() => {
            if (mlsStatus.value === "key_exchange") {
              log("No welcome received — declaring self as group creator");
              mlsStatus.value = "ready";
              messages.value.push(systemMsg("🔒 End-to-end encryption active (group creator)."));
            }
          }, 4000);
        }
      }
    } catch (e) {
      mlsStatus.value = "error";
      mlsError.value = (e as Error).message;
      log("MLS init error:", e);
      messages.value.push(systemMsg(`Encryption init failed: ${(e as Error).message}`, "system_error"));
    }
  }

  // ── Public actions ────────────────────────────────────────────────────────────
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
    if (currentRoom.value?.slug === slug) return;
    wsService.disconnect();
    messages.value = [];
    participants.value = [];
    currentRoom.value = null;
    mlsStatus.value = "idle";
    mlsError.value = null;
    pendingInvites.clear();
    isParticipant.value = false;

    try {
      const room = await api.getRoom(slug);
      currentRoom.value = room;
      participants.value = room.participants ?? [];
      isParticipant.value = room.is_participant ?? false;
      if (isParticipant.value) wsService.connect(slug);
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  function leaveRoom() {
    wsService.disconnect();
    currentRoom.value = null;
    messages.value = [];
    participants.value = [];
    mlsStatus.value = "idle";
    isParticipant.value = false;
  }

  async function joinParticipant() {
    if (!currentRoom.value) return;
    const slug = currentRoom.value.slug;
    error.value = null;
    try {
      await api.joinRoom(slug);
      isParticipant.value = true;
      const room = await api.getRoom(slug);
      currentRoom.value = room;
      participants.value = room.participants ?? [];
      messages.value = [];
      wsService.connect(slug);
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function leaveParticipant() {
    if (!currentRoom.value) return;
    const slug = currentRoom.value.slug;
    wsService.disconnect();
    mlsStatus.value = "idle";
    messages.value = [];
    error.value = null;
    try {
      await api.leaveRoom(slug);
      isParticipant.value = false;
      const room = await api.getRoom(slug);
      currentRoom.value = room;
      participants.value = room.participants ?? [];
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function sendMessage(content: string) {
    if (!content.trim() || !isConnected.value || !currentRoom.value) return;

    if (mlsStatus.value === "ready") {
      log("Sending encrypted message");
      const ct = await cryptoService.encrypt(
        currentRoom.value.slug, currentUserName.value, content.trim()
      );
      if (ct) {
        wsService.send({
          type: "mls_app",
          ciphertext: bytesToBase64(ct),
          device_id: currentUserName.value,
        });
        messages.value.push({
          id: nanoid(), type: "mls_app",
          user: currentUserName.value,
          initials: initials(currentUserName.value),
          avatar_url: null, content: content.trim(),
          participant_type: "human", self: true,
          encrypted: true, timestamp: new Date(),
        });
      } else {
        messages.value.push(systemMsg("Encryption failed — message not sent.", "system_error"));
      }
    } else {
      // Plaintext fallback while MLS is setting up
      log("Sending plaintext (MLS not ready)");
      wsService.send({ type: "chat_message", message: content.trim() });
    }
  }

  return {
    rooms, currentRoom, messages, participants,
    wsStatus, loadingRooms, error, isConnected,
    mlsStatus, mlsError, isEncrypted,
    isParticipant, currentUserName,
    fetchRooms, joinRoom, leaveRoom, joinParticipant, leaveParticipant, sendMessage,
  };
});
