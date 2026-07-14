// One P2P chat channel, fully self-contained: its own room, messages,
// participants, MLS session and transport wiring. The app is serverless — the
// transport (iroh-gossip, or peer-hosted Tor when the "use Tor" switch is on) is
// chosen in Rust (see chatTransport.ts); rendezvous is a QR-shared ticket, and
// reconnects ride the peer NodeIds / onion persisted per room.
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

/** A locally-known P2P room: topic id, display name, join ticket, and the peer
 *  NodeIds seen in it (the address book for ticketless reconnects). */
export interface P2pRoomEntry {
  room: string;
  name: string;
  ticket: string;
  /** NodeIds of peers seen in this room — persisted so a restart can re-subscribe
   *  and resolve their current addresses via n0 discovery (no fresh QR needed). */
  peers?: string[];
  /** True when WE created (host) this room. Over Tor the creator hosts the onion
   *  service and must re-host (not re-dial) on reopen; over iroh it's cosmetic. */
  host?: boolean;
  /** True for Tor rooms (the transport that has an elected onion captain). */
  tor?: boolean;
  /** Our own onion for this room (Tor) — announced over presence for election. */
  onion?: string;
  /** Ticketless-join room code (DHT rendezvous — dht.md). Present when this room
   *  was created/joined with DHT discovery on, or a code was minted for it. */
  code?: string;
}

/** Tor tickets are base32(`0x54` ++ postcard) — a leading `0x54` ('T') byte marks
 *  them apart from iroh's tagless tickets (mirrors `p2p_tor::ticket_is_tor`). We
 *  decode just the first byte from the first two base32 chars. */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function firstTagByte(ticket: string): number {
  const s = ticket.trim().toLowerCase();
  if (s.length < 2) return -1;
  const a = B32.indexOf(s[0]);
  const b = B32.indexOf(s[1]);
  if (a < 0 || b < 0) return -1;
  return ((a << 3) | (b >> 2)) & 0xff;
}
export function isTorTicket(ticket: string): boolean {
  return firstTagByte(ticket) === 0x54;
}
/** DHT room codes are base32(`0x44` ('D') ++ postcard) — the ticketless-join
 *  credential (dht.md; mirrors `p2p_iroh::code_is_dht`). */
export function isDhtCode(ticket: string): boolean {
  return firstTagByte(ticket) === 0x44;
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

  // ── Tor captain election (onion host) ────────────────────────────────────────
  // Over Tor every member hosts its own onion; the frontend elects the captain
  // (lowest MLS id) and re-points the transport's outbound dial to it. Failover:
  // on a `captain_unreachable` status we mark that captain dead and re-elect. See
  // capitan.md. All of this is a no-op on iroh rooms (gated by currentRoomIsTor).
  const myOnion = ref("");                              // my onion for the current room
  const currentRoomIsTor = ref(false);                 // gate: only Tor rooms elect a captain
  const currentCaptainOnion = ref<string | null>(null); // last onion pushed to setCaptain
  const deadCaptains = new Set<string>();              // MLS ids currently believed unreachable
  let electionTimer: ReturnType<typeof setTimeout> | null = null;
  const CAPTAIN_DEBOUNCE_MS = 2000;                    // absorb join/presence bursts into one re-point

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
  // `onion` is the member's Tor onion (empty on iroh), learned from its presence.
  const presenceById = new Map<string, { name: string; avatar: string; onion: string }>();

  // ── Data-sync seam ───────────────────────────────────────────────────────────
  // External orchestrators ride this channel's MLS group by registering an `onSync`
  // handler and sending via `sendSync`. Routed inner-message families: `sync_*`
  // (full-data pull), `file_*` (P2P file transfer offer/accept signaling —
  // consumed by `useFileShare` in the app) and `meeting_*` (meeting invite/RSVP
  // signaling — consumed by `useMeetings` in the app). Each handler ignores the
  // prefixes it does not own.
  type SyncHandler = (type: string, payload: Record<string, unknown>, sender: string) => void;
  const syncHandlers = new Set<SyncHandler>();
  function onSync(fn: SyncHandler): () => void {
    syncHandlers.add(fn);
    return () => { syncHandlers.delete(fn); };
  }

  /** The captain is the lowest MLS identity among live members (same rule as the
   *  leave-path admin). `captainOnion` is its onion if known (self trivially, else
   *  from presence) — null means "elected, but we can't dial it yet", in which case
   *  we keep the current connection rather than stranding ourselves. */
  function electCaptain(memberIds: string[]): { captainId: string | null; captainOnion: string | null } {
    const alive = memberIds.filter((id) => !deadCaptains.has(id)).slice().sort();
    const captainId = alive[0] ?? null;
    if (!captainId) return { captainId: null, captainOnion: null };
    const onion = captainId === mlsIdentity.value ? myOnion.value : presenceById.get(captainId)?.onion || "";
    return { captainId, captainOnion: onion || null };
  }

  function scheduleSetCaptain(slug: string, onion: string) {
    if (electionTimer) clearTimeout(electionTimer);
    electionTimer = setTimeout(() => {
      electionTimer = null;
      chatTransport.setCaptain(slug, onion);
    }, CAPTAIN_DEBOUNCE_MS);
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

    // Tor: elect the onion captain (the host/relay), badge it, and re-point the
    // transport when the elected captain changes AND we can reach it.
    if (currentRoomIsTor.value) {
      const { captainId, captainOnion } = electCaptain(source);
      for (const p of list) p.isCaptain = !!captainId && p.id === captainId;
      if (captainOnion && captainOnion !== currentCaptainOnion.value) {
        currentCaptainOnion.value = captainOnion;
        scheduleSetCaptain(currentRoom.value.slug, captainOnion);
      }
    }

    participants.value = list;
    currentRoom.value = { ...currentRoom.value, participant_count: list.length };
  }

  async function announcePresence(reply = false) {
    if (mlsStatus.value !== "ready") return;
    await sendEncryptedMedia("presence", {
      device_id: mlsIdentity.value, name: displayName(),
      avatar: avatarForName(currentUserName.value) ?? "",
      onion: myOnion.value, // Tor: our dialable address, for captain election
      reply,
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

  /** The elected onion captain became unreachable (Tor). Mark it dead so election
   *  skips it, re-elect + re-point to the next-lowest live member (whose onion we
   *  already know from presence), and — if we're now the admin — evict the dead
   *  captain from the MLS group so the roster + star converge. */
  async function handleCaptainDeath(deadOnion?: string) {
    if (!currentRoom.value || !currentRoomIsTor.value || !deadOnion) return;
    let deadId: string | null = null;
    for (const [id, info] of presenceById) {
      if (info.onion === deadOnion) { deadId = id; break; }
    }
    if (deadId) deadCaptains.add(deadId);
    currentCaptainOnion.value = null; // force a re-point on the next election
    messages.value.push(systemMsg("The room host went offline — electing a new host…"));
    await refreshP2pRoster(); // re-elect (skips deadCaptains) + re-point to the next captain
    // Evict the dead host from MLS only AFTER the re-point lands, so the removal
    // commit is broadcast over the NEW captain's connection (the old one is dead).
    if (deadId) {
      const id = deadId;
      setTimeout(() => { void handlePeerLeave(id); }, CAPTAIN_DEBOUNCE_MS + 1000);
    }
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
  chatTransport.onStatus((room, status, peerId, reason) => {
    // Tor captain died (peerId = its onion): re-elect around it. Don't persist the
    // onion as a reconnect peer — captain failover is election-driven, not by-id.
    if (reason === "captain_unreachable") {
      if (room === currentRoom.value?.slug) void handleCaptainDeath(peerId);
      return;
    }
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
              presenceById.set(id, {
                name: (inner.name as string) || id,
                avatar: (inner.avatar as string) || "",
                onion: (inner.onion as string) || "",
              });
              deadCaptains.delete(id); // a fresh presence ⇒ this member is alive again
              void refreshP2pRoster();
              if (!inner.reply) void announcePresence(true);
            }
            return;
          }
          if (inner?.type === "leave" && inner.device_id) {
            void handlePeerLeave(inner.device_id as string);
            return;
          }
          if (inner?.type === "room_closed") {
            void handleRoomClosed();
            return;
          }
          if (typeof inner?.type === "string" && (inner.type.startsWith("sync_") || inner.type.startsWith("file_") || inner.type.startsWith("meeting_"))) {
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

  /** Drop a room from the saved list + persisted `p2p:rooms` KV (the delete/forget
   *  counterpart of `rememberP2pRoom`). */
  function forgetP2pRoom(slug: string) {
    const before = p2pRooms.value.length;
    p2pRooms.value = p2pRooms.value.filter((r) => r.room !== slug);
    if (p2pRooms.value.length !== before) persistP2pRooms();
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
    // Reset captain-election state for the new room (myOnion / currentRoomIsTor are
    // set by the caller right after this, from the transport's create/join result).
    currentCaptainOnion.value = null;
    deadCaptains.clear();
    if (electionTimer) { clearTimeout(electionTimer); electionTimer = null; }
    currentRoom.value = makeP2pRoom(room, name);
    participants.value = [selfParticipant()];
    isParticipant.value = true;
    mlsStatus.value = "idle";
    mlsError.value = null;
    pendingInvites.clear();
    wsStatus.value = chatTransport.lastStatus(room) ?? "connecting";
    // Tor emits "connected" DURING the join/create invoke — before this room is
    // current — so the status handler's startMls() kick gets dropped (the joiner
    // then never sends its key package and stays "Not encrypted" forever). If the
    // transport already reports connected by the time we enter, kick MLS here;
    // startMls() guards on mlsStatus, so a late duplicate event is harmless.
    if (wsStatus.value === "connected") void startMls();
  }

  async function createRoom(name: string): Promise<string | null> {
    error.value = null;
    teardown();
    clearMessages();
    try {
      const res = await chatTransport.createRoom(name.trim());
      const tor = isTorTicket(res.ticket);
      rememberP2pRoom({
        room: res.room, name: res.name, ticket: res.ticket, host: true, tor,
        onion: res.onion, ...(res.code ? { code: res.code } : {}),
      });
      enterP2pRoom(res.room, res.name);
      currentRoomIsTor.value = tor;
      myOnion.value = res.onion;
      // Run the election now so the sole-member creator is marked captain (★) over
      // Tor immediately — before any joiner arrives.
      void refreshP2pRoster();
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
      const tor = isTorTicket(ticket.trim());
      // A DHT code join stores the code as the entry's "ticket" too — reopening
      // by it routes back through the code path (tag-sniffed), which never goes
      // stale the way a ticket's embedded addresses can.
      const code = isDhtCode(ticket.trim()) ? { code: ticket.trim() } : {};
      rememberP2pRoom({ room: res.room, name: res.name, ticket: ticket.trim(), tor, onion: res.onion, ...code });
      enterP2pRoom(res.room, res.name);
      currentRoomIsTor.value = tor;
      myOnion.value = res.onion;
      messages.value.push(systemMsg(`Joined “${res.name}”. Connecting to peers…`));
    } catch (e) {
      error.value = errorMessage(e);
    }
  }

  // Abort an in-flight Tor join (the join modal's "Cancel" button). Frees the
  // half-launched onion's lock in Rust so a retry doesn't hit "resource already in
  // use". No-op for iroh joins. Clears any error the aborted join left behind.
  async function cancelJoin() {
    chatTransport.cancelJoin();
    error.value = null;
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
      currentRoomIsTor.value = false; // ticketless reconnect is the iroh path
      myOnion.value = "";
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

  /** Open a saved room. iroh: rejoin by ticket, seeding the persisted peer NodeIds
   *  so stale ticket addresses don't strand us. Tor: the host re-launches its onion
   *  (same nickname ⇒ same `.onion`, idempotent), a joiner re-dials the saved onion.
   *  The transport is inferred from the ticket, so iroh rooms are unaffected. */
  async function openP2pRoom(entry: P2pRoomEntry) {
    if (currentRoom.value?.slug === entry.room) return;
    error.value = null;
    teardown();
    clearMessages();
    try {
      const tor = isTorTicket(entry.ticket);
      const res = tor && entry.host
        ? await chatTransport.createRoom(entry.name)
        : await chatTransport.joinRoom(entry.ticket, entry.peers ?? []);
      enterP2pRoom(entry.room, entry.name);
      currentRoomIsTor.value = tor;
      myOnion.value = res.onion;
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

  /** Delete a saved room: kick + wipe. If we HOST it and are connected, broadcast
   *  `room_closed` so every participant tears down + forgets it too; if we only joined,
   *  broadcast the ordinary `leave` (the remaining admin evicts us from MLS). Then wipe
   *  all local data for the room — MLS group state, the persisted entry, and (Tor) the
   *  onion identity — and close its connections. Kicking peers only reaches them while
   *  we are connected to the room with MLS ready (i.e. deleting the open room). */
  async function deleteRoom(entry: P2pRoomEntry) {
    const slug = entry.room;
    const identity = mlsIdentity.value;
    const isCurrent = currentRoom.value?.slug === slug;

    if (isCurrent && mlsStatus.value === "ready") {
      await sendEncryptedMedia(entry.host ? "room_closed" : "leave", { device_id: identity }).catch(() => {});
    }
    // Wipe local data.
    await cryptoService.clearState(slug, identity).catch(() => {});
    if (entry.tor) chatTransport.forgetTorOnion(entry.name); // stops the service + drops the key
    forgetP2pRoom(slug);
    // Close connections / reset the view.
    if (isCurrent) clearLocalChatState("Room deleted.");
    else chatTransport.leaveRoom(slug); // stop hosting/dialing a non-open room
  }

  /** A room's host broadcast `room_closed` — tear down + wipe it on our side, per the
   *  "fully wiped + notified" delete behaviour. Only fires for the room on screen (the
   *  transport delivers `room_closed` only for `currentRoom`). */
  async function handleRoomClosed() {
    if (!currentRoom.value) return;
    const slug = currentRoom.value.slug;
    const name = currentRoom.value.name;
    const tor = currentRoomIsTor.value;
    await cryptoService.clearState(slug, mlsIdentity.value).catch(() => {});
    if (tor) chatTransport.forgetTorOnion(name);
    forgetP2pRoom(slug);
    // Resets the channel + leaves the notice as the sole system message.
    clearLocalChatState("This room was deleted by the host.");
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

  /** Post a local system_info line into the chat log (e.g. "X invited you to a
   *  meeting"). Local-only — nothing is sent; sync orchestrators use this to
   *  leave a human-readable trace of signaling they consumed. */
  function postSystemNotice(content: string) {
    messages.value.push(systemMsg(content));
  }

  return {
    currentRoom, messages, participants,
    wsStatus, error, isConnected, unread, clearUnread,
    mlsStatus, mlsError, isEncrypted, currentRoomIsTor,
    isParticipant, currentUserName, mlsIdentity,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState,
    joinParticipant, leaveParticipant,
    sendMessage, sendImage, sendImageDataUrl, sendAudio, forceResetMls,
    p2pRooms, loadP2pRooms, createRoom, joinByTicket, joinByNode, openP2pRoom,
    cancelJoin, deleteRoom,
    ensureNode,
    onSync, sendSync, postSystemNotice,
  };
}

export type ChatChannel = ReturnType<typeof useChatChannel>;
