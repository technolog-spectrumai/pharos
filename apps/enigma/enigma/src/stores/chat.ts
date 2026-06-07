import { ref, computed } from "vue";
import { defineStore } from "pinia";
import { api, type Room, type Participant } from "../services/api";
import { chatTransport as wsService, type WsStatus } from "../services/chatTransport";
import { cryptoService, bytesToBase64, base64ToBytes } from "../services/crypto";
import {
  getRuntimeConfig,
  getTransportMode,
  setTransportMode as persistTransportMode,
  type AppRuntimeConfig,
  type TransportMode,
} from "../services/appStorage";
import { kvGet, kvPut } from "../services/localDb";
import { nanoid } from "nanoid";

/** A locally-known P2P (iroh) room: its topic id, display name and join ticket. */
export interface P2pRoomEntry {
  room: string;
  name: string;
  ticket: string;
}

export type MlsStatus =
  | "idle"
  | "initializing"
  | "key_exchange"   // sent key package, waiting for welcome
  | "ready"          // in a group, can encrypt
  | "error";

export interface Message {
  id: string;
  type: "chat_message" | "mls_app" | "image_message" | "voice_message" | "system_error" | "system_info";
  user: string;
  initials: string;
  avatar_url: string | null;
  content: string;
  image_data?: string;
  audio_data?: string;
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
  const mlsIdentity = ref<string>("You");

  // MLS state
  const mlsStatus = ref<MlsStatus>("idle");
  const mlsError = ref<string | null>(null);

  // track which device IDs we've already invited so we don't double-add
  const pendingInvites = new Set<string>();
  const pendingRecoveryRooms = new Set<string>();
  const processedResetIds = new Set<string>();

  // Fallback "I'm alone, declare myself the group creator" timer. Cancelled as
  // soon as a peer's key package arrives, so two present peers never both create
  // their own group (which would cause group-ID mismatches).
  let creatorTimer: ReturnType<typeof setTimeout> | null = null;
  function clearCreatorTimer() {
    if (creatorTimer) {
      clearTimeout(creatorTimer);
      creatorTimer = null;
    }
  }

  const isParticipant = ref(false);

  // P2P rooms (iroh) — created/joined locally, persisted in SQLite, browsable
  // with no server. A parallel room kind to the server (WS) rooms.
  const p2pRooms = ref<P2pRoomEntry[]>([]);

  // Chat transport mode: "relay" = server WebSocket, "direct" = P2P (iroh).
  const transportMode = ref<TransportMode>("relay");
  async function loadTransportMode() {
    transportMode.value = await getTransportMode();
  }
  async function setTransportMode(mode: TransportMode) {
    if (mode === transportMode.value) return;
    transportMode.value = mode;
    await persistTransportMode(mode);
    // Drop any active connection so the next room uses the chosen transport.
    wsService.disconnect();
    currentRoom.value = null;
    messages.value = [];
    participants.value = [];
    isParticipant.value = false;
    mlsStatus.value = "idle";
  }

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

  function participantForName(name: string): Participant | undefined {
    return participants.value.find((participant) => participant.name === name);
  }

  function avatarForName(name: string): string | null {
    return participantForName(name)?.avatar_url ?? null;
  }

  // P2P rooms have no server-provided roster — learn peers from their messages.
  function notePeer(name?: string | null, avatar?: string | null): void {
    if (!name || name === currentUserName.value) return;
    if (!participants.value.some((p) => p.name === name)) {
      participants.value.push({ name, avatar_url: avatar ?? "", type: "human" });
    }
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function isGroupMismatch(error: unknown): boolean {
    return errorMessage(error).toLowerCase().includes("group id differs");
  }

  async function requestFreshMlsInvite(reason: string) {
    if (!currentRoom.value || !mlsIdentity.value) return;

    const room = currentRoom.value.slug;
    const identity = mlsIdentity.value;
    const recoveryKey = `${room}:${identity}`;

    if (pendingRecoveryRooms.has(recoveryKey)) {
      return;
    }

    pendingRecoveryRooms.add(recoveryKey);
    mlsStatus.value = "key_exchange";
    mlsError.value = reason;
    pendingInvites.clear();

    try {
      await cryptoService.clearState(room, identity);
      await cryptoService.initSession(room, identity);
      const kp = await cryptoService.keyPackage(room, identity);
      if (kp) {
        wsService.send({ type: "mls_key_package", key_package: bytesToBase64(kp), device_id: identity });
        messages.value.push(systemMsg("🔑 MLS group changed — sent a fresh key package."));
      } else {
        mlsStatus.value = "error";
        messages.value.push(systemMsg("Could not recover MLS session.", "system_error"));
      }
    } catch (e) {
      mlsStatus.value = "error";
      mlsError.value = errorMessage(e);
      messages.value.push(systemMsg(`Could not recover MLS session: ${errorMessage(e)}`, "system_error"));
    } finally {
      pendingRecoveryRooms.delete(recoveryKey);
    }
  }

  // ── WS status ────────────────────────────────────────────────────────────────
  wsService.onStatus((status) => {
    log("ws status →", status);
    wsStatus.value = status;
    if (status === "connected") {
      messages.value.push(systemMsg(`Connected to ${currentRoom.value?.name ?? "room"}.`));
      // Start MLS when the transport is ready. startMls() no-ops if a handshake
      // is already in progress, so a transient reconnect won't wipe it.
      void startMls();
    } else if (status === "disconnected") {
      messages.value.push(systemMsg("Disconnected."));
      // Keep the MLS session across transient drops — re-handshaking on every
      // reconnect clears key material mid-flight. It's reset on an explicit
      // room change / leave instead.
    } else if (status === "error") {
      messages.value.push(systemMsg("Connection error.", "system_error"));
    }
  });

  // ── WS messages ──────────────────────────────────────────────────────────────
  wsService.onMessage((data) => {
    void handleMessage(data);
  });

  async function handleMessage(data: Record<string, unknown>) {
    const type = data.type as string;
    log("ws →", type, data);

    if (type === "room_participants") {
      const roomSlug = data.room_slug as string;
      const room = currentRoom.value;
      if (!room || roomSlug !== room.slug) return;

      const nextParticipants = Array.isArray(data.participants)
        ? data.participants as Participant[]
        : [];
      const participantCount = typeof data.participant_count === "number"
        ? data.participant_count
        : nextParticipants.length;

      participants.value = nextParticipants;
      currentRoom.value = {
        ...room,
        participant_count: participantCount,
        participants: nextParticipants,
      };
      rooms.value = rooms.value.map((room) =>
        room.slug === roomSlug
          ? { ...room, participant_count: participantCount }
          : room,
      );
      return;
    }

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

    if (type === "image_message" && (data.image_data || data.image_url)) {
      const senderName = (data.user as string) ?? "Unknown";
      messages.value.push({
        id: nanoid(), type: "image_message",
        user: senderName,
        initials: initials(senderName),
        avatar_url: (data.avatar_url as string) ?? null,
        content: "",
        image_data: (data.image_data ?? data.image_url) as string,
        participant_type: "human",
        self: senderName === currentUserName.value,
        encrypted: false,
        timestamp: new Date(),
      });
      return;
    }

    if (type === "voice_message" && data.audio_data) {
      const senderName = (data.user as string) ?? "Unknown";
      messages.value.push({
        id: nanoid(), type: "voice_message",
        user: senderName,
        initials: initials(senderName),
        avatar_url: (data.avatar_url as string) ?? null,
        content: "",
        audio_data: data.audio_data as string,
        participant_type: "human",
        self: senderName === currentUserName.value,
        encrypted: false,
        timestamp: new Date(),
      });
      return;
    }

    if (type === "mls_reset_request") {
      // Ignore our own broadcast echoed back, or duplicate IDs
      if ((data.device_id as string) === mlsIdentity.value) return;
      const resetId = data.reset_id as string | undefined;
      if (resetId) {
        if (processedResetIds.has(resetId)) return;
        processedResetIds.add(resetId);
        // Expire after 30 s to avoid unbounded growth
        setTimeout(() => processedResetIds.delete(resetId), 30000);
      }
      log("Received mls_reset_request from peer — resetting session locally");
      await forceResetMls(false); // reset locally; do NOT echo another reset
      return;
    }

    // Accept both "key_package" (Enigma) and "package" (browser) field names
    const rawKp = (data.key_package ?? data.package) as string | undefined;
    if (type === "mls_key_package" && rawKp) {
      notePeer(data.user as string);
      const deviceId = (data.device_id as string) ?? (data.sender_channel as string);
      const canAdd = (mlsStatus.value === "ready" || mlsStatus.value === "key_exchange")
                     && currentRoom.value
                     && !pendingInvites.has(deviceId);

      if (canAdd) {
        // A peer is present — cancel the lone-creator fallback so we don't end up
        // in our own separate group.
        clearCreatorTimer();

        // Tiebreaker: lower string is the group admin. Compare display names (fall back to device IDs).
        const ourId = currentUserName.value !== "You" ? currentUserName.value : mlsIdentity.value;
        const theirId = (data.user as string) || deviceId;
        const weAreAdmin = ourId < theirId;

        if (!weAreAdmin) {
          // Defer — wait to be added to the peer's group via their welcome. Drop
          // back to key_exchange so the welcome is accepted even if our fallback
          // timer had already flipped us to "ready".
          mlsStatus.value = "key_exchange";
          log("Deferring to peer (they are admin):", theirId);
          const kpDefer = await cryptoService.keyPackage(currentRoom.value!.slug, mlsIdentity.value);
          if (kpDefer) {
            const b64 = bytesToBase64(kpDefer);
            wsService.send({
              type: "mls_key_package",
              key_package: b64, package: b64,
              device_id: mlsIdentity.value,
              user: currentUserName.value,
              target_channel: data.sender_channel,
            });
          }
          return;
        }

        pendingInvites.add(deviceId);
        log("Adding MLS member (admin):", theirId);
        const result = await cryptoService.addMember(
          currentRoom.value!.slug, mlsIdentity.value, base64ToBytes(rawKp)
        );
        if (result) {
          mlsStatus.value = "ready";
          wsService.send({ type: "mls_commit", commit: bytesToBase64(result.commit) });
          wsService.send({
            type: "mls_welcome",
            welcome: bytesToBase64(result.welcome),
            target_channel: data.sender_channel,
          });
          log("Sent welcome + commit to", deviceId);
          messages.value.push(systemMsg("🔒 End-to-end encryption active."));
        } else {
          log("addMember failed for", deviceId);
          pendingInvites.delete(deviceId);
        }
      }
      return;
    }

    if (type === "mls_welcome" && data.welcome) {
      if (mlsStatus.value === "key_exchange" && currentRoom.value) {
        clearCreatorTimer();
        log("Joining MLS group from welcome");
        messages.value.push(systemMsg("🔑 Received group invitation — joining encrypted group…"));
        const ok = await cryptoService.joinFromWelcome(
          currentRoom.value.slug, mlsIdentity.value,
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
      // Only an established member applies commits. While still joining
      // (key_exchange) we must ignore the admin's add-commit — we get added via
      // the welcome instead; applying it here causes a group-ID mismatch that
      // would wipe our pending key package.
      if (mlsStatus.value === "ready" && currentRoom.value) {
        log("Processing MLS commit");
        try {
          await cryptoService.processMessage(
            currentRoom.value.slug, mlsIdentity.value,
            base64ToBytes(data.commit as string),
          );
        } catch (e) {
          console.error("[crypto] process commit failed:", e);
          if (isGroupMismatch(e)) {
            await requestFreshMlsInvite(errorMessage(e));
          } else {
            mlsStatus.value = "error";
            mlsError.value = errorMessage(e);
            messages.value.push(systemMsg(`Could not process MLS commit: ${errorMessage(e)}`, "system_error"));
          }
        }
      }
      return;
    }

    if (type === "mls_app" && data.ciphertext) {
      if (data.device_id === mlsIdentity.value) {
        log("Ignoring own mls_app echo");
        return;
      }
      const senderName = (data.sender_name as string) || (data.user as string) || (data.device_id as string) || "Unknown";
      notePeer(senderName, data.sender_avatar_url as string);
      const sender = participantForName(senderName);

      if (mlsStatus.value === "ready" && currentRoom.value) {
        log("Decrypting mls_app");
        let plaintext: Uint8Array | null = null;
        try {
          plaintext = await cryptoService.processMessage(
            currentRoom.value.slug, mlsIdentity.value,
            base64ToBytes(data.ciphertext as string),
          );
        } catch (e) {
          console.error("[crypto] process app message failed:", e);
          if (isGroupMismatch(e)) {
            await requestFreshMlsInvite(errorMessage(e));
          } else {
            mlsStatus.value = "error";
            mlsError.value = errorMessage(e);
            messages.value.push(systemMsg(`Could not decrypt incoming message: ${errorMessage(e)}`, "system_error"));
          }
          return;
        }

        if (plaintext) {
          const text = new TextDecoder().decode(plaintext);
          const avatarUrl = (data.sender_avatar_url as string) ?? sender?.avatar_url ?? null;
          const isSelf = senderName === currentUserName.value || data.device_id === mlsIdentity.value;
          let inner: Record<string, unknown> | null = null;
          try { inner = JSON.parse(text); } catch (_) {}

          if (inner?.type === "image_message" && inner.image_data) {
            messages.value.push({
              id: nanoid(), type: "image_message",
              user: senderName, initials: initials(senderName), avatar_url: avatarUrl,
              content: "", image_data: inner.image_data as string,
              participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date(),
            });
          } else if (inner?.type === "voice_message" && inner.audio_data) {
            messages.value.push({
              id: nanoid(), type: "voice_message",
              user: senderName, initials: initials(senderName), avatar_url: avatarUrl,
              content: "", audio_data: inner.audio_data as string,
              participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date(),
            });
          } else {
            messages.value.push({
              id: nanoid(), type: "mls_app",
              user: senderName, initials: initials(senderName), avatar_url: avatarUrl,
              content: text,
              participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date(),
            });
          }
        } else {
          log("Decryption returned null for mls_app");
          messages.value.push(systemMsg("⚠ Could not decrypt an incoming message.", "system_error"));
        }
      } else {
        // MLS session not ready — show the message as a locked placeholder so it isn't silently lost
        messages.value.push({
          id: nanoid(), type: "mls_app",
          user: senderName,
          initials: initials(senderName),
          avatar_url: (data.sender_avatar_url as string) ?? sender?.avatar_url ?? null,
          content: "🔒 [encrypted — session not ready]",
          participant_type: "human",
          self: false,
          encrypted: true,
          timestamp: new Date(),
        });
      }
      return;
    }
  }

  // ── MLS init ─────────────────────────────────────────────────────────────────
  async function startMls() {
    if (!currentRoom.value || !mlsIdentity.value) return;
    // Only (re)handshake when idle/errored. A room entry resets status to "idle";
    // a transient reconnect leaves it at initializing/key_exchange/ready, so this
    // guard prevents clobbering an in-flight or established session.
    if (mlsStatus.value !== "idle" && mlsStatus.value !== "error") return;
    const room = currentRoom.value.slug;
    const identity = mlsIdentity.value;

    log("startMls", room, identity);
    mlsStatus.value = "initializing";
    mlsError.value = null;
    pendingInvites.clear();

    try {
      // Always start fresh — restoring stale group state causes group-ID mismatches
      // when any peer reconnects with a different session. Both sides must negotiate
      // a new group on every connection.
      await cryptoService.clearState(room, identity);
      await cryptoService.initSession(room, identity);
      log("MLS session started fresh");

      const kp = await cryptoService.keyPackage(room, identity);
      if (kp) {
        const b64 = bytesToBase64(kp);
        wsService.send({ type: "mls_key_package", key_package: b64, package: b64, device_id: identity, user: currentUserName.value });
        log("Key package sent");
        messages.value.push(systemMsg("🔑 Setting up encryption…"));
        mlsStatus.value = "key_exchange";

        // Become the group creator after a grace period only if no peer shows up.
        clearCreatorTimer();
        creatorTimer = setTimeout(() => {
          creatorTimer = null;
          if (mlsStatus.value === "key_exchange") {
            log("No welcome received — declaring self as group creator");
            mlsStatus.value = "ready";
            messages.value.push(systemMsg("🔒 End-to-end encryption active."));
          }
        }, 5000);
      }
    } catch (e) {
      mlsStatus.value = "error";
      mlsError.value = (e as Error).message;
      log("MLS init error:", e);
      messages.value.push(systemMsg(`Encryption init failed: ${(e as Error).message}`, "system_error"));
    }
  }

  // ── Public actions ────────────────────────────────────────────────────────────
  async function syncRuntimeIdentity() {
    const runtime = await getRuntimeConfig();
    mlsIdentity.value = runtime.identity;
    // Also resolve the display name so self-detection works for plaintext messages
    try {
      const me = await api.getMe();
      if (me?.full_name) currentUserName.value = me.full_name;
      else if (me?.username) currentUserName.value = me.username;
    } catch {
      // non-fatal — self-highlighting just won't work
    }
  }

  async function applyRuntimeProfile(runtime: AppRuntimeConfig) {
    mlsIdentity.value = runtime.identity;
    clearLocalChatState(`Runtime profile switched to ${runtime.profile}. Left all chats and reset MLS.`);
  }

  function clearLocalChatState(message = "Left all chats and reset MLS.") {
    wsService.disconnect();
    rooms.value = [];
    currentRoom.value = null;
    messages.value = [
      systemMsg(message),
    ];
    participants.value = [];
    isParticipant.value = false;
    mlsStatus.value = "idle";
    mlsError.value = null;
    pendingInvites.clear();
    pendingRecoveryRooms.clear();
  }

  async function leaveAllChatsOnServer() {
    await api.leaveAllRooms();
  }

  async function fetchRooms() {
    loadingRooms.value = true;
    error.value = null;
    try {
      const data = await api.getRooms();
      rooms.value = data.channels;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loadingRooms.value = false;
    }
  }

  // ── P2P (iroh) rooms ───────────────────────────────────────────────────────
  async function loadP2pRooms() {
    try {
      const raw = await kvGet("p2p:rooms", "default", "");
      p2pRooms.value = raw ? (JSON.parse(raw) as P2pRoomEntry[]) : [];
    } catch {
      p2pRooms.value = [];
    }
  }

  function rememberP2pRoom(entry: P2pRoomEntry) {
    const i = p2pRooms.value.findIndex((r) => r.room === entry.room);
    if (i === -1) p2pRooms.value.unshift(entry);
    else p2pRooms.value[i] = entry;
    void kvPut("p2p:rooms", "default", "", JSON.stringify(p2pRooms.value)).catch(() => {});
  }

  function makeP2pRoom(room: string, name: string): Room {
    return {
      id: 0, slug: room, name, participant_count: 1,
      created_at: new Date().toISOString(), is_participant: true, participants: [],
    } as Room;
  }

  function enterP2pRoom(room: string, name: string) {
    currentRoom.value = makeP2pRoom(room, name);
    participants.value = [];
    isParticipant.value = true;
    mlsStatus.value = "idle";
    mlsError.value = null;
    pendingInvites.clear();
  }

  /** Create a new P2P room; returns the shareable ticket. */
  async function createRoom(name: string): Promise<string | null> {
    error.value = null;
    wsService.disconnect();
    messages.value = [];
    try {
      const res = await wsService.createRoom(name.trim());
      rememberP2pRoom({ room: res.room, name: res.name, ticket: res.ticket });
      enterP2pRoom(res.room, res.name);
      messages.value.push(systemMsg(`Created “${res.name}”. Share the ticket to invite peers.`));
      return res.ticket;
    } catch (e) {
      error.value = errorMessage(e);
      return null;
    }
  }

  /** Join a P2P room from a ticket. */
  async function joinByTicket(ticket: string) {
    error.value = null;
    wsService.disconnect();
    messages.value = [];
    try {
      const res = await wsService.joinRoom(ticket.trim());
      rememberP2pRoom({ room: res.room, name: res.name, ticket: ticket.trim() });
      enterP2pRoom(res.room, res.name);
      messages.value.push(systemMsg(`Joined “${res.name}”. Connecting to peers…`));
    } catch (e) {
      error.value = errorMessage(e);
    }
  }

  /** Re-open a previously-joined P2P room (re-subscribes via its ticket). */
  async function openP2pRoom(entry: P2pRoomEntry) {
    if (currentRoom.value?.slug === entry.room) return;
    error.value = null;
    wsService.disconnect();
    messages.value = [];
    try {
      await wsService.joinRoom(entry.ticket);
      enterP2pRoom(entry.room, entry.name);
    } catch (e) {
      error.value = errorMessage(e);
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
    mlsStatus.value = "idle";
    error.value = null;
    try {
      await api.leaveRoom(slug);
      wsService.disconnect();
      messages.value = [];
      isParticipant.value = false;
      const room = await api.getRoom(slug);
      currentRoom.value = room;
      participants.value = room.participants ?? [];
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function sendImage(file: File, onProgress?: (pct: number) => void) {
    if (!currentRoom.value || !isConnected.value || !isParticipant.value) return;
    error.value = null;
    try {
      await api.uploadImage(currentRoom.value.slug, file, onProgress);
      // Server relays the image via WebSocket to all channel members
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function sendAudio(audioBlob: Blob) {
    if (!currentRoom.value || !isConnected.value || !isParticipant.value) return;
    error.value = null;
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const mimeType = audioBlob.type || "audio/webm";
      wsService.send({
        type: "voice_message",
        audio_data: `data:${mimeType};base64,${base64}`,
      });
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function sendMessage(content: string) {
    if (!content.trim() || !isConnected.value || !currentRoom.value) return;

    if (mlsStatus.value === "ready") {
      log("Sending encrypted message");
      const ct = await cryptoService.encrypt(
        currentRoom.value.slug, mlsIdentity.value, content.trim()
      );
      if (ct) {
        wsService.send({
          type: "mls_app",
          ciphertext: bytesToBase64(ct),
          device_id: mlsIdentity.value,
          user: currentUserName.value,
          sender_name: currentUserName.value,
          sender_avatar_url: avatarForName(currentUserName.value),
        });
        messages.value.push({
          id: nanoid(), type: "mls_app",
          user: currentUserName.value,
          initials: initials(currentUserName.value),
          avatar_url: avatarForName(currentUserName.value), content: content.trim(),
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

  async function forceResetMls(broadcast = true) {
    if (!currentRoom.value || !mlsIdentity.value) return;
    const room = currentRoom.value.slug;
    const identity = mlsIdentity.value;
    // Only the initiator announces the reset. Peers reset locally WITHOUT
    // re-broadcasting — otherwise each side keeps answering a reset with a fresh
    // reset_id (which dedup never catches), and the session bounces forever.
    if (broadcast) {
      const resetId = nanoid();
      wsService.send({ type: "mls_reset_request", device_id: mlsIdentity.value, reset_id: resetId });
      processedResetIds.add(resetId);
      setTimeout(() => processedResetIds.delete(resetId), 30000);
    }
    mlsStatus.value = "initializing";
    mlsError.value = null;
    pendingInvites.clear();
    pendingRecoveryRooms.clear();
    messages.value = [systemMsg("🔄 Session reset — history cleared.")];
    try {
      await cryptoService.clearState(room, identity);
      await cryptoService.initSession(room, identity);
      const kp = await cryptoService.keyPackage(room, identity);
      if (kp) {
        const b64 = bytesToBase64(kp);
        wsService.send({ type: "mls_key_package", key_package: b64, package: b64, device_id: identity, user: currentUserName.value });
        mlsStatus.value = "key_exchange";
        messages.value.push(systemMsg("🔑 Fresh key package sent."));
        setTimeout(() => {
          if (mlsStatus.value === "key_exchange") {
            mlsStatus.value = "ready";
            messages.value.push(systemMsg("🔒 New encryption group created."));
          }
        }, 5000);
      } else {
        mlsStatus.value = "error";
        messages.value.push(systemMsg("Failed to generate key package.", "system_error"));
      }
    } catch (e) {
      mlsStatus.value = "error";
      mlsError.value = (e as Error).message;
      messages.value.push(systemMsg(`Reset failed: ${(e as Error).message}`, "system_error"));
    }
  }

  return {
    rooms, currentRoom, messages, participants,
    wsStatus, loadingRooms, error, isConnected,
    mlsStatus, mlsError, isEncrypted,
    isParticipant, currentUserName, mlsIdentity,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState, leaveAllChatsOnServer,
    fetchRooms, joinRoom, leaveRoom, joinParticipant, leaveParticipant, sendMessage, sendImage, sendAudio,
    forceResetMls,
    // P2P (iroh) rooms
    p2pRooms, loadP2pRooms, createRoom, joinByTicket, openP2pRoom,
    // transport mode (relay = WS server, direct = P2P)
    transportMode, loadTransportMode, setTransportMode,
  };
});
