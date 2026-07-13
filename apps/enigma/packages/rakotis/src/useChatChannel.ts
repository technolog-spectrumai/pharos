// One P2P chat channel, fully self-contained: its own room, messages,
// participants, MLS session and transport wiring. The app is serverless — the
// only transport is iroh-gossip (see chatTransport.ts); rendezvous is a QR-shared
// ticket, and reconnects ride the peer NodeIds persisted per room.
//
// The MLS envelope state machine below (key_package → welcome/commit → app) is
// transport-agnostic JSON; all crypto is delegated to the Rotor-backed `mls_*`
// Tauri commands via crypto.ts — never reimplemented here.

import { ref, computed, watch } from "vue";
import { chatTransport, type WsStatus } from "./chatTransport";
import { cryptoService, bytesToBase64, base64ToBytes } from "./crypto";
import { getRuntimeConfig, type AppRuntimeConfig } from "./services/appStorage";
import type { Participant, Room } from "./services/types";
import { kvGet, kvPut } from "./services/localDb";
import { nanoid } from "nanoid";

/** A locally-known P2P (iroh) room: topic id, display name, join ticket, and the
 *  peer NodeIds seen in it (the address book for ticketless reconnects). */
export interface P2pRoomEntry {
  room: string;
  name: string;
  ticket: string;
  /** NodeIds of peers seen in this room — persisted so a restart can re-subscribe
   *  and resolve their current addresses via n0 discovery (no fresh QR needed). */
  peers?: string[];
}

export type MlsStatus =
  | "idle"
  | "initializing"
  | "key_exchange"
  | "ready"
  | "error";

export interface Message {
  id: string;
  type:
    | "chat_message"
    | "mls_app"
    | "image_message"
    | "voice_message"
    | "system_error"
    | "system_info";
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

async function downscaleImageToDataUrl(file: File, maxDim = 1600, quality = 0.85): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return blobToDataUrl(file);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return blobToDataUrl(file);
  }
}

const log = (...args: unknown[]) => console.log("[enigma-chat]", ...args);

export function useChatChannel() {
  const currentRoom = ref<Room | null>(null);
  const messages = ref<Message[]>([]);
  const participants = ref<Participant[]>([]);
  const wsStatus = ref<WsStatus>("disconnected");
  const error = ref<string | null>(null);
  const unread = ref(0); // messages received while this tab wasn't active

  const currentUserName = ref<string>("You");
  const mlsIdentity = ref<string>("You");

  const mlsStatus = ref<MlsStatus>("idle");
  const mlsError = ref<string | null>(null);

  const pendingInvites = new Set<string>();
  const pendingRecoveryRooms = new Set<string>();
  const processedResetIds = new Set<string>();

  let creatorTimer: ReturnType<typeof setTimeout> | null = null;
  function clearCreatorTimer() {
    if (creatorTimer) { clearTimeout(creatorTimer); creatorTimer = null; }
  }

  const isParticipant = ref(false);
  const p2pRooms = ref<P2pRoomEntry[]>([]);

  const isConnected = computed(() => wsStatus.value === "connected");
  const isEncrypted = computed(() => mlsStatus.value === "ready");

  // ── transport helpers (room-scoped) ──────────────────────────────────────────
  function send(payload: Record<string, unknown>) {
    const slug = currentRoom.value?.slug;
    if (slug) chatTransport.send(slug, payload);
  }
  function teardown() {
    const slug = currentRoom.value?.slug;
    if (slug) chatTransport.leaveRoom(slug);
  }

  function initials(name: string): string {
    return name.split(/\s+/).map((w) => w[0] ?? "").slice(0, 2).join("").toUpperCase();
  }

  function systemMsg(content: string, type: "system_info" | "system_error" = "system_info"): Message {
    return {
      id: nanoid(), type, user: "System", initials: "S",
      avatar_url: null, content, participant_type: "system",
      self: false, encrypted: false, timestamp: new Date(),
    };
  }

  function pushMessage(msg: Message) {
    messages.value.push(msg);
    if (!msg.self && msg.participant_type !== "system") unread.value++;
  }

  function clearMessages() {
    messages.value = [];
  }
  function tsFrom(data: Record<string, unknown>): Date {
    const c = data.created_at;
    return typeof c === "string" ? new Date(c) : new Date();
  }

  function participantForName(name: string): Participant | undefined {
    return participants.value.find((p) => p.name === name);
  }
  function avatarForName(name: string): string | null {
    return participantForName(name)?.avatar_url ?? null;
  }
  function displayName(): string {
    return currentUserName.value !== "You" ? currentUserName.value : mlsIdentity.value;
  }
  function selfParticipant(): Participant {
    return { id: mlsIdentity.value, name: displayName(), avatar_url: avatarForName(currentUserName.value) ?? "", type: "human" };
  }

  // ── P2P roster (authenticated from MLS membership) ───────────────────────────
  const presenceById = new Map<string, { name: string; avatar: string }>();

  // ── Data-sync seam ───────────────────────────────────────────────────────────
  // External orchestrators ride this channel's MLS group by registering an `onSync`
  // handler and sending via `sendSync`. Routed inner-message families: `sync_*`
  // (full-data pull) and `file_*` (P2P file transfer offer/accept signaling — the
  // file feature is parked in limbo/, the seam stays). Each handler ignores the
  // prefixes it does not own.
  type SyncHandler = (type: string, payload: Record<string, unknown>, sender: string) => void;
  const syncHandlers = new Set<SyncHandler>();
  function onSync(fn: SyncHandler): () => void {
    syncHandlers.add(fn);
    return () => { syncHandlers.delete(fn); };
  }

  async function refreshP2pRoster() {
    if (!currentRoom.value) return;
    const ids = await cryptoService.members(currentRoom.value.slug, mlsIdentity.value);
    const source = ids.length ? ids : [mlsIdentity.value];
    const list: Participant[] = source.map((id) => {
      if (id === mlsIdentity.value) return selfParticipant();
      const info = presenceById.get(id);
      return { id, name: info?.name || id, avatar_url: info?.avatar || "", type: "human" as const };
    });
    participants.value = list;
    currentRoom.value = { ...currentRoom.value, participant_count: list.length };
  }

  async function announcePresence(reply = false) {
    if (mlsStatus.value !== "ready") return;
    await sendEncryptedMedia("presence", {
      device_id: mlsIdentity.value, name: displayName(),
      avatar: avatarForName(currentUserName.value) ?? "", reply,
    }).catch(() => {});
  }

  async function handlePeerLeave(deviceId: string) {
    presenceById.delete(deviceId);
    if (!currentRoom.value) return;
    const room = currentRoom.value.slug;
    const ids = await cryptoService.members(room, mlsIdentity.value);
    if (ids.includes(deviceId)) {
      const admin = ids.filter((id) => id !== deviceId).slice().sort()[0];
      if (admin === mlsIdentity.value) {
        const commit = await cryptoService.removeMember(room, mlsIdentity.value, deviceId);
        if (commit) send({ type: "mls_commit", commit: bytesToBase64(commit) });
      }
    }
    await refreshP2pRoster();
  }

  watch(mlsStatus, (status) => {
    if (status === "ready") {
      void announcePresence(false);
      void refreshP2pRoster();
    }
  });

  function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
  function isGroupMismatch(e: unknown): boolean {
    return errorMessage(e).toLowerCase().includes("group id differs");
  }

  async function requestFreshMlsInvite(reason: string) {
    if (!currentRoom.value || !mlsIdentity.value) return;
    const room = currentRoom.value.slug;
    const identity = mlsIdentity.value;
    const recoveryKey = `${room}:${identity}`;
    if (pendingRecoveryRooms.has(recoveryKey)) return;
    pendingRecoveryRooms.add(recoveryKey);
    mlsStatus.value = "key_exchange";
    mlsError.value = reason;
    pendingInvites.clear();
    try {
      await cryptoService.clearState(room, identity);
      await cryptoService.initSession(room, identity);
      const kp = await cryptoService.keyPackage(room, identity);
      if (kp) {
        send({ type: "mls_key_package", key_package: bytesToBase64(kp), device_id: identity });
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

  // ── transport status / messages ──────────────────────────────────────────────
  chatTransport.onStatus((room, status, peerId) => {
    // A neighbor's NodeId is our reconnect handle — persist it for ANY known room,
    // not only the one on screen (several rooms can be live at once).
    if (peerId) rememberPeerForRoom(room, peerId);
    if (room !== currentRoom.value?.slug) return;
    log("status →", status);
    wsStatus.value = status;
    if (status === "connected") {
      messages.value.push(systemMsg(`Connected to ${currentRoom.value?.name ?? "room"}.`));
      void startMls();
    } else if (status === "disconnected") {
      messages.value.push(systemMsg("Disconnected."));
    } else if (status === "error") {
      messages.value.push(systemMsg("Connection error.", "system_error"));
    }
  });

  chatTransport.onMessage((room, data) => {
    if (room !== currentRoom.value?.slug) return;
    void handleMessage(data as Record<string, unknown>);
  });

  async function handleMessage(data: Record<string, unknown>) {
    const type = data.type as string;
    log("←", type);

    // Plaintext fallback used only before MLS is ready.
    if (type === "chat_message" && data.message) {
      pushMessage({
        id: (data.id as string) || nanoid(), type: "chat_message",
        user: (data.user as string) ?? "Unknown", initials: initials((data.user as string) ?? "?"),
        avatar_url: (data.avatar_url as string) ?? null, content: data.message as string,
        participant_type: "human", self: data.user === currentUserName.value,
        encrypted: false, timestamp: tsFrom(data),
      });
      return;
    }

    if (type === "system_error" && data.message) {
      messages.value.push(systemMsg(data.message as string, "system_error"));
      return;
    }

    if (type === "mls_reset_request") {
      if ((data.device_id as string) === mlsIdentity.value) return;
      const resetId = data.reset_id as string | undefined;
      if (resetId) {
        if (processedResetIds.has(resetId)) return;
        processedResetIds.add(resetId);
        setTimeout(() => processedResetIds.delete(resetId), 30000);
      }
      await forceResetMls(false);
      return;
    }

    const rawKp = (data.key_package ?? data.package) as string | undefined;
    if (type === "mls_key_package" && rawKp) {
      const deviceId = (data.device_id as string) ?? (data.sender_channel as string);
      const canAdd = (mlsStatus.value === "ready" || mlsStatus.value === "key_exchange") && currentRoom.value && !pendingInvites.has(deviceId);
      if (canAdd) {
        clearCreatorTimer();
        const ourId = mlsIdentity.value;
        const theirId = deviceId || (data.user as string) || "";
        const weAreAdmin = ourId < theirId;
        if (!weAreAdmin) {
          mlsStatus.value = "key_exchange";
          const kpDefer = await cryptoService.keyPackage(currentRoom.value!.slug, mlsIdentity.value);
          if (kpDefer) {
            const b64 = bytesToBase64(kpDefer);
            send({ type: "mls_key_package", key_package: b64, package: b64, device_id: mlsIdentity.value, user: currentUserName.value, target_channel: data.sender_channel });
          }
          return;
        }
        pendingInvites.add(deviceId);
        const result = await cryptoService.addMember(currentRoom.value!.slug, mlsIdentity.value, base64ToBytes(rawKp));
        if (result) {
          mlsStatus.value = "ready";
          send({ type: "mls_commit", commit: bytesToBase64(result.commit) });
          send({ type: "mls_welcome", welcome: bytesToBase64(result.welcome), target_channel: data.sender_channel });
          messages.value.push(systemMsg("🔒 End-to-end encryption active."));
          void refreshP2pRoster();
        } else {
          pendingInvites.delete(deviceId);
        }
      }
      return;
    }

    if (type === "mls_welcome" && data.welcome) {
      if (mlsStatus.value === "key_exchange" && currentRoom.value) {
        clearCreatorTimer();
        messages.value.push(systemMsg("🔑 Received group invitation — joining encrypted group…"));
        const ok = await cryptoService.joinFromWelcome(currentRoom.value.slug, mlsIdentity.value, base64ToBytes(data.welcome as string));
        if (ok) {
          mlsStatus.value = "ready";
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
      if (mlsStatus.value === "ready" && currentRoom.value) {
        try {
          await cryptoService.processMessage(currentRoom.value.slug, mlsIdentity.value, base64ToBytes(data.commit as string));
          void refreshP2pRoster();
        } catch (e) {
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
      if (data.device_id === mlsIdentity.value) return;
      const senderName = (data.sender_name as string) || (data.user as string) || (data.device_id as string) || "Unknown";
      const sender = participantForName(senderName);
      if (mlsStatus.value === "ready" && currentRoom.value) {
        let plaintext: Uint8Array | null = null;
        try {
          plaintext = await cryptoService.processMessage(currentRoom.value.slug, mlsIdentity.value, base64ToBytes(data.ciphertext as string));
        } catch (e) {
          if (isGroupMismatch(e)) { await requestFreshMlsInvite(errorMessage(e)); }
          else {
            mlsStatus.value = "error"; mlsError.value = errorMessage(e);
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

          if (inner?.type === "presence" && inner.device_id) {
            const id = inner.device_id as string;
            if (id !== mlsIdentity.value) {
              presenceById.set(id, { name: (inner.name as string) || id, avatar: (inner.avatar as string) || "" });
              void refreshP2pRoster();
              if (!inner.reply) void announcePresence(true);
            }
            return;
          }
          if (inner?.type === "leave" && inner.device_id) {
            void handlePeerLeave(inner.device_id as string);
            return;
          }
          if (typeof inner?.type === "string" && (inner.type.startsWith("sync_") || inner.type.startsWith("file_"))) {
            syncHandlers.forEach((h) => h(inner!.type as string, inner!, senderName));
            return;
          }
          if (inner?.type === "image_message" && inner.image_data) {
            pushMessage({ id: nanoid(), type: "image_message", user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: "", image_data: inner.image_data as string, participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date() });
          } else if (inner?.type === "voice_message" && inner.audio_data) {
            pushMessage({ id: nanoid(), type: "voice_message", user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: "", audio_data: inner.audio_data as string, participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date() });
          } else {
            pushMessage({ id: nanoid(), type: "mls_app", user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: text, participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date() });
          }
        } else {
          messages.value.push(systemMsg("⚠ Could not decrypt an incoming message.", "system_error"));
        }
      } else {
        pushMessage({
          id: nanoid(), type: "mls_app", user: senderName, initials: initials(senderName),
          avatar_url: (data.sender_avatar_url as string) ?? sender?.avatar_url ?? null,
          content: "🔒 [encrypted — session not ready]", participant_type: "human",
          self: false, encrypted: true, timestamp: new Date(),
        });
      }
      return;
    }
  }

  // ── MLS init ─────────────────────────────────────────────────────────────────
  async function startMls() {
    if (!currentRoom.value || !mlsIdentity.value) return;
    if (mlsStatus.value !== "idle" && mlsStatus.value !== "error") return;
    const room = currentRoom.value.slug;
    const identity = mlsIdentity.value;
    mlsStatus.value = "initializing";
    mlsError.value = null;
    pendingInvites.clear();
    try {
      await cryptoService.clearState(room, identity);
      await cryptoService.initSession(room, identity);
      const kp = await cryptoService.keyPackage(room, identity);
      if (kp) {
        const b64 = bytesToBase64(kp);
        send({ type: "mls_key_package", key_package: b64, package: b64, device_id: identity, user: currentUserName.value });
        messages.value.push(systemMsg("🔑 Setting up encryption…"));
        mlsStatus.value = "key_exchange";
        clearCreatorTimer();
        creatorTimer = setTimeout(() => {
          creatorTimer = null;
          if (mlsStatus.value === "key_exchange") {
            mlsStatus.value = "ready";
            messages.value.push(systemMsg("🔒 End-to-end encryption active."));
          }
        }, 5000);
      }
    } catch (e) {
      mlsStatus.value = "error";
      mlsError.value = (e as Error).message;
      messages.value.push(systemMsg(`Encryption init failed: ${(e as Error).message}`, "system_error"));
    }
  }

  // ── identity / lifecycle ─────────────────────────────────────────────────────
  async function syncRuntimeIdentity() {
    const runtime = await getRuntimeConfig();
    mlsIdentity.value = runtime.identity;
    // The display name is set by the app from the local offline profile; default
    // to the runtime identity until it does.
    if (currentUserName.value === "You") currentUserName.value = runtime.identity;
  }

  async function applyRuntimeProfile(runtime: AppRuntimeConfig) {
    mlsIdentity.value = runtime.identity;
    clearLocalChatState(`Runtime profile switched to ${runtime.profile}. Left all chats and reset MLS.`);
  }

  function clearLocalChatState(message = "Left all chats and reset MLS.") {
    teardown();
    currentRoom.value = null;
    messages.value = [systemMsg(message)];
    participants.value = [];
    isParticipant.value = false;
    mlsStatus.value = "idle";
    mlsError.value = null;
    pendingInvites.clear();
    pendingRecoveryRooms.clear();
  }

  // ── P2P (iroh) rooms ─────────────────────────────────────────────────────────
  async function loadP2pRooms() {
    try {
      const raw = await kvGet("p2p:rooms", "default", "");
      p2pRooms.value = raw ? (JSON.parse(raw) as P2pRoomEntry[]) : [];
    } catch {
      p2pRooms.value = [];
    }
  }

  function persistP2pRooms() {
    void kvPut("p2p:rooms", "default", "", JSON.stringify(p2pRooms.value)).catch(() => {});
  }

  function rememberP2pRoom(entry: P2pRoomEntry) {
    const i = p2pRooms.value.findIndex((r) => r.room === entry.room);
    if (i === -1) p2pRooms.value.unshift(entry);
    else p2pRooms.value[i] = { ...p2pRooms.value[i], ...entry };
    persistP2pRooms();
  }

  /** Record a peer NodeId in a room's persisted address book (pair once by QR,
   *  reconnect by NodeId + n0 discovery forever after). */
  function rememberPeerForRoom(room: string, peerId: string) {
    const entry = p2pRooms.value.find((r) => r.room === room);
    if (!entry) return;
    const peers = entry.peers ?? [];
    if (peers.includes(peerId)) return;
    entry.peers = [...peers, peerId];
    persistP2pRooms();
  }

  function makeP2pRoom(room: string, name: string): Room {
    return { id: 0, slug: room, name, participant_count: 1, created_at: new Date().toISOString(), is_participant: true, participants: [] } as Room;
  }

  function enterP2pRoom(room: string, name: string) {
    presenceById.clear();
    currentRoom.value = makeP2pRoom(room, name);
    participants.value = [selfParticipant()];
    isParticipant.value = true;
    mlsStatus.value = "idle";
    mlsError.value = null;
    pendingInvites.clear();
    wsStatus.value = chatTransport.lastStatus(room) ?? "connecting";
  }

  async function createRoom(name: string): Promise<string | null> {
    error.value = null;
    teardown();
    clearMessages();
    try {
      const res = await chatTransport.createRoom(name.trim());
      rememberP2pRoom({ room: res.room, name: res.name, ticket: res.ticket });
      enterP2pRoom(res.room, res.name);
      messages.value.push(systemMsg(`Created “${res.name}”. Share the QR / ticket to invite peers.`));
      return res.ticket;
    } catch (e) {
      error.value = errorMessage(e);
      return null;
    }
  }

  async function joinByTicket(ticket: string) {
    error.value = null;
    teardown();
    clearMessages();
    try {
      const res = await chatTransport.joinRoom(ticket.trim());
      rememberP2pRoom({ room: res.room, name: res.name, ticket: ticket.trim() });
      enterP2pRoom(res.room, res.name);
      messages.value.push(systemMsg(`Joined “${res.name}”. Connecting to peers…`));
    } catch (e) {
      error.value = errorMessage(e);
    }
  }

  // Ticketless reconnect: re-enter a named room, bootstrapping from persisted peer
  // NodeIds (addresses resolve via iroh's n0 discovery).
  async function joinByNode(name: string, peerNodeIds: string[]) {
    error.value = null;
    teardown();
    clearMessages();
    try {
      const res = await chatTransport.joinRoomByNode(name.trim(), peerNodeIds);
      enterP2pRoom(res.room, res.name);
      messages.value.push(systemMsg(`Joined “${res.name}”. Connecting to peers…`));
    } catch (e) {
      error.value = errorMessage(e);
    }
  }

  /** Ensure this channel's iroh endpoint is started and return our NodeId (shown in
   *  Settings; also what a future contact-QR would carry). */
  async function ensureNode(): Promise<string | null> {
    try {
      const info = await chatTransport.nodeInfo();
      return info?.node_id ?? null;
    } catch {
      return null;
    }
  }

  /** Open a saved room: rejoin by ticket, seeding the bootstrap with the room's
   *  persisted peer NodeIds so stale ticket addresses don't strand us. */
  async function openP2pRoom(entry: P2pRoomEntry) {
    if (currentRoom.value?.slug === entry.room) return;
    error.value = null;
    teardown();
    clearMessages();
    try {
      await chatTransport.joinRoom(entry.ticket, entry.peers ?? []);
      enterP2pRoom(entry.room, entry.name);
    } catch (e) {
      error.value = errorMessage(e);
    }
  }

  // "Join"/"Leave" for the current room. P2P rooms are joined implicitly on entry;
  // leaving broadcasts an MLS leave so the admin can remove us from the group.
  async function joinParticipant() {
    if (!currentRoom.value) return;
    isParticipant.value = true;
  }

  async function leaveParticipant() {
    if (!currentRoom.value) return;
    if (mlsStatus.value === "ready") {
      await sendEncryptedMedia("leave", { device_id: mlsIdentity.value }).catch(() => {});
    }
    presenceById.clear();
    teardown();
    currentRoom.value = null;
    clearMessages();
    participants.value = [];
    isParticipant.value = false;
    mlsStatus.value = "idle";
  }

  // ── sending ──────────────────────────────────────────────────────────────────
  async function sendEncryptedMedia(innerType: string, payload: Record<string, unknown>) {
    const ct = await cryptoService.encrypt(currentRoom.value!.slug, mlsIdentity.value, JSON.stringify({ type: innerType, ...payload }));
    if (!ct) throw new Error("Encryption failed");
    send({
      type: "mls_app", ciphertext: bytesToBase64(ct), device_id: mlsIdentity.value,
      user: currentUserName.value, sender_name: currentUserName.value,
      sender_avatar_url: avatarForName(currentUserName.value),
    });
  }

  /** Send a data-sync control/data message over this channel's MLS group. */
  async function sendSync(type: string, payload: Record<string, unknown>) {
    await sendEncryptedMedia(type, payload);
  }

  async function sendImage(file: File, onProgress?: (pct: number) => void) {
    if (!currentRoom.value || !isConnected.value || !isParticipant.value) return;
    error.value = null;
    if (mlsStatus.value !== "ready") {
      messages.value.push(systemMsg("Encryption not ready yet — try again in a moment.", "system_error"));
      return;
    }
    try {
      const dataUrl = await downscaleImageToDataUrl(file);
      await sendEncryptedMedia("image_message", { image_data: dataUrl });
      pushMessage({ id: nanoid(), type: "image_message", user: currentUserName.value, initials: initials(currentUserName.value), avatar_url: avatarForName(currentUserName.value), content: "", image_data: dataUrl, participant_type: "human", self: true, encrypted: true, timestamp: new Date() });
      onProgress?.(100);
    } catch (e) { error.value = errorMessage(e); }
  }

  /** Send an already-encoded image (data URL). */
  async function sendImageDataUrl(dataUrl: string) {
    if (!currentRoom.value || !isConnected.value || !isParticipant.value) return;
    error.value = null;
    if (mlsStatus.value !== "ready") {
      messages.value.push(systemMsg("Encryption not ready yet — try again in a moment.", "system_error"));
      return;
    }
    try {
      await sendEncryptedMedia("image_message", { image_data: dataUrl });
      pushMessage({ id: nanoid(), type: "image_message", user: currentUserName.value, initials: initials(currentUserName.value), avatar_url: avatarForName(currentUserName.value), content: "", image_data: dataUrl, participant_type: "human", self: true, encrypted: true, timestamp: new Date() });
    } catch (e) { error.value = errorMessage(e); }
  }

  async function sendAudio(audioBlob: Blob) {
    if (!currentRoom.value || !isConnected.value || !isParticipant.value) return;
    error.value = null;
    if (mlsStatus.value !== "ready") {
      messages.value.push(systemMsg("Encryption not ready yet — try again in a moment.", "system_error"));
      return;
    }
    try {
      const dataUrl = await blobToDataUrl(audioBlob);
      await sendEncryptedMedia("voice_message", { audio_data: dataUrl });
      pushMessage({ id: nanoid(), type: "voice_message", user: currentUserName.value, initials: initials(currentUserName.value), avatar_url: avatarForName(currentUserName.value), content: "", audio_data: dataUrl, participant_type: "human", self: true, encrypted: true, timestamp: new Date() });
    } catch (e) { error.value = errorMessage(e); }
  }

  async function sendMessage(content: string) {
    const text = content.trim();
    if (!text || !isConnected.value || !currentRoom.value) return;

    if (mlsStatus.value === "ready") {
      const ct = await cryptoService.encrypt(currentRoom.value.slug, mlsIdentity.value, text);
      if (ct) {
        send({ type: "mls_app", ciphertext: bytesToBase64(ct), device_id: mlsIdentity.value, user: currentUserName.value, sender_name: currentUserName.value, sender_avatar_url: avatarForName(currentUserName.value) });
        pushMessage({ id: nanoid(), type: "mls_app", user: currentUserName.value, initials: initials(currentUserName.value), avatar_url: avatarForName(currentUserName.value), content: text, participant_type: "human", self: true, encrypted: true, timestamp: new Date() });
      } else {
        messages.value.push(systemMsg("Encryption failed — message not sent.", "system_error"));
      }
    } else {
      // Pre-MLS fallback (plaintext over the gossip topic; QUIC still encrypts hops).
      send({ type: "chat_message", message: text });
    }
  }

  async function forceResetMls(broadcast = true) {
    if (!currentRoom.value || !mlsIdentity.value) return;
    const room = currentRoom.value.slug;
    const identity = mlsIdentity.value;
    if (broadcast) {
      const resetId = nanoid();
      send({ type: "mls_reset_request", device_id: mlsIdentity.value, reset_id: resetId });
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
        send({ type: "mls_key_package", key_package: b64, package: b64, device_id: identity, user: currentUserName.value });
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

  function clearUnread() { unread.value = 0; }

  return {
    currentRoom, messages, participants,
    wsStatus, error, isConnected, unread, clearUnread,
    mlsStatus, mlsError, isEncrypted,
    isParticipant, currentUserName, mlsIdentity,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState,
    joinParticipant, leaveParticipant,
    sendMessage, sendImage, sendImageDataUrl, sendAudio, forceResetMls,
    p2pRooms, loadP2pRooms, createRoom, joinByTicket, joinByNode, openP2pRoom,
    ensureNode,
    onSync, sendSync,
  };
}

export type ChatChannel = ReturnType<typeof useChatChannel>;
