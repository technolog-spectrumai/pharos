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
import { t } from "./i18n/chatText";
import type { Participant, Room } from "./services/types";
import { kvGet, kvPut } from "./services/localDb";
import {
  activeMuteUntil, clampRules, formatRemaining, pruneMutes, sanitizeMuteUntil,
  type MuteMap,
} from "./services/moderation";
import {
  validateLocationShare, validatePinShare, validateRegionShare,
  type MapLocationShare, type MapPinShare, type MapRegionShare,
} from "./mapModel";
import { sameUser, userPartOf, type PersistedMessage } from "./chatHistoryModel";
import { createLogAppender, loadLog, wipeLog } from "./services/chatLog";
import { getChatHistoryCapMsgs, getConnectTimeoutSecs } from "./services/appStorage";
import { nanoid } from "nanoid";

/** A validated map share riding a chat-timeline card (mapModel wire shapes). */
export type MapShare = MapPinShare | MapLocationShare | MapRegionShare;

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
  /** Ticketless-join room code (DHT rendezvous — technology.md §12). Present when this room
   *  was created/joined with DHT discovery on, or a code was minted for it. */
  code?: string;
  /** Room logo (small JPEG data URL) — captain-set, distributed via `room_meta`. */
  logo?: string;
  /** Room rules text — captain-set, distributed via `room_meta`. */
  rules?: string;
  /** Invite-only: gossip key packages are refused, and the only way in is a
   *  redeemed invitation (technology.md §18.8). Captain-set, distributed via
   *  `room_meta`. Enforced by every member independently — app convention, like
   *  the captain rule itself (§9.3). */
  inviteOnly?: boolean;
  /** Monotonic revision of the captain-authoritative meta/moderation snapshot. */
  metaRev?: number;
  /** Active mutes (MLS id → expiry epoch ms), captain-set. */
  mutes?: MuteMap;
  /** Kicked (banned) MLS identities — refused re-admission by the acting admin. */
  bans?: string[];
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
 *  credential (technology.md §12; mirrors `p2p_iroh::code_is_dht`). */
export function isDhtCode(ticket: string): boolean {
  return firstTagByte(ticket) === 0x44;
}
/** Invitations are base32(`0x4E` ('N') ++ version ++ kind ++ body) — encrypted,
 *  expiring, and redeemed by connecting to the inviter rather than by joining a
 *  topic (technology.md §18; mirrors `invite_ticket::is_invite_ticket`).
 *
 *  A sniff only: it answers "is this an invitation?", never "is it valid", "has
 *  it expired" or "is it mine". A Personal invitation is sealed, so only Rust —
 *  holding this device's identity secret — can answer any of those. */
export function isInviteTicket(ticket: string): boolean {
  return firstTagByte(ticket) === 0x4e;
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
    | "map_pin"
    | "map_loc"
    | "map_region"
    | "system_error"
    | "system_info";
  user: string;
  initials: string;
  avatar_url: string | null;
  content: string;
  image_data?: string;
  audio_data?: string;
  /** Validated map share payload (map_pin / map_loc / map_region cards). */
  map?: MapShare;
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

/** Downscale an image file to a JPEG data URL (exported: also used by the
 *  profile avatar picker and the room-logo picker). */
export async function downscaleImageToDataUrl(file: File, maxDim = 1600, quality = 0.85): Promise<string> {
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

/** Options for secondary channel instances (the hidden device-link room). A
 *  headless channel never touches the saved-rooms kv or the chat log; an
 *  `admissionCheck` gates inbound key packages (devlink: linkKey HMAC proof)
 *  and `keyPackageExtra` decorates outbound ones with that proof. */
export interface ChatChannelOptions {
  headless?: boolean;
  admissionCheck?: (data: Record<string, unknown>) => boolean | Promise<boolean>;
  keyPackageExtra?: (kpB64: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export function useChatChannel(options: ChatChannelOptions = {}) {
  const headless = !!options.headless;
  const currentRoom = ref<Room | null>(null);
  const messages = ref<Message[]>([]);
  const participants = ref<Participant[]>([]);
  const wsStatus = ref<WsStatus>("disconnected");
  const error = ref<string | null>(null);
  const unread = ref(0); // messages received while this tab wasn't active

  const currentUserName = ref<string>("You");
  const mlsIdentity = ref<string>("You");
  // The user's own avatar (small JPEG data URL, "" = none) — set by the app from
  // the local profile; rides presence + message envelopes so peers see it.
  const myAvatar = ref("");

  const mlsStatus = ref<MlsStatus>("idle");
  const mlsError = ref<string | null>(null);

  const pendingInvites = new Set<string>();
  const pendingRecoveryRooms = new Set<string>();
  const processedResetIds = new Set<string>();

  /**
   * Evidence that we are NOT the only member: an MLS application frame from
   * another device arrived while we were still negotiating.
   *
   * This is what separates a lone room creator — who legitimately becomes a
   * "group of one" — from someone who joined a live room and was never admitted.
   * A refused joiner sees other members' encrypted traffic go by and cannot open
   * any of it; a creator alone in a fresh room sees nothing at all.
   */
  let sawForeignTraffic = false;

  let creatorTimer: ReturnType<typeof setTimeout> | null = null;
  let admissionTimer: ReturnType<typeof setTimeout> | null = null;
  function clearCreatorTimer() {
    if (creatorTimer) { clearTimeout(creatorTimer); creatorTimer = null; }
    if (admissionTimer) { clearTimeout(admissionTimer); admissionTimer = null; }
  }

  const isParticipant = ref(false);
  const p2pRooms = ref<P2pRoomEntry[]>([]);

  // ── Tor captain election (onion host) ────────────────────────────────────────
  // Over Tor every member hosts its own onion; the frontend elects the captain
  // (lowest MLS id) and re-points the transport's outbound dial to it. Failover:
  // on a `captain_unreachable` status we mark that captain dead and re-elect. See
  // technology.md §11. All of this is a no-op on iroh rooms (gated by currentRoomIsTor).
  const myOnion = ref("");                              // my onion for the current room
  const currentRoomIsTor = ref(false);                 // gate: only Tor rooms re-point the transport
  const currentCaptainOnion = ref<string | null>(null); // last onion pushed to setCaptain
  const deadCaptains = new Set<string>();              // MLS ids currently believed unreachable
  let electionTimer: ReturnType<typeof setTimeout> | null = null;
  const CAPTAIN_DEBOUNCE_MS = 2000;                    // absorb join/presence bursts into one re-point

  // ── Room meta + moderation (captain-authoritative — technology.md §9) ────────
  // The captain (lowest live MLS id, elected on BOTH transports; over Tor it is
  // also the onion host) owns the room logo, the room rules, and moderation:
  // kick (MLS removal + ban) and timed mutes. State is broadcast as a `room_meta`
  // snapshot over the encrypted seam, validated on receive against the locally
  // elected captain, and persisted on the room's `P2pRoomEntry` so any future
  // admin keeps enforcing bans. Cooperative, like all group management here.
  const captainId = ref<string | null>(null);
  const amCaptain = computed(() => !!captainId.value && captainId.value === mlsIdentity.value);
  const roomLogo = ref("");
  const roomRules = ref("");
  const inviteOnly = ref(false);
  const metaRev = ref(0);
  const mutes = ref<MuteMap>({});
  const bans = ref<string[]>([]);
  // Coarse clock for mute countdowns/expiry (badges tick, expired mutes lift).
  const nowTick = ref(Date.now());
  setInterval(() => { nowTick.value = Date.now(); }, 15_000);
  /** Mute lookup that honours both keying schemes: new mutes key by user part
   *  (one mute covers all of a user's linked devices), legacy/old-build mutes
   *  by full leaf id. */
  function mutedUntilFor(id: string, now: number): number | null {
    return (
      activeMuteUntil(mutes.value, id, now) ??
      activeMuteUntil(mutes.value, userPartOf(id), now)
    );
  }
  /** Ban lookup with the same dual keying as mutes. */
  function isBanned(id: string): boolean {
    return bans.value.includes(id) || bans.value.includes(userPartOf(id));
  }
  const selfMuteUntil = computed(() => mutedUntilFor(mlsIdentity.value, nowTick.value));
  watch(nowTick, (now) => {
    const pruned = pruneMutes(mutes.value, now);
    if (pruned !== mutes.value) {
      mutes.value = pruned;
      persistRoomMod();
      void refreshP2pRoster(); // lift expired mute badges
    }
  });

  const isConnected = computed(() => wsStatus.value === "connected");
  const isEncrypted = computed(() => mlsStatus.value === "ready");

  // ── transport helpers (room-scoped) ──────────────────────────────────────────
  function send(payload: Record<string, unknown>) {
    const slug = currentRoom.value?.slug;
    if (slug) chatTransport.send(slug, payload);
  }
  function teardown() {
    const slug = currentRoom.value?.slug;
    void logAppender.flushNow(); // don't lose buffered log entries on switch
    if (slug) chatTransport.leaveRoom(slug);
  }

  function initials(name: string): string {
    return name.split(/\s+/).map((w) => w[0] ?? "").slice(0, 2).join("").toUpperCase();
  }

  /**
   * A TRANSLATED system notice — the form every new one should take.
   *
   * `systemMsg` below still takes finished text, because a few callers already
   * hold a string (an error from the transport, a caller-supplied reason). This
   * wrapper is the one that goes through the app's catalog, falling back to the
   * English beside the key when no translator is registered (`i18n/chatText.ts`).
   */
  function sysMsg(
    key: string,
    fallback: string,
    params?: Record<string, unknown>,
    type: "system_info" | "system_error" = "system_info",
  ): Message {
    return systemMsg(t(key, fallback, params), type);
  }

  function systemMsg(content: string, type: "system_info" | "system_error" = "system_info"): Message {
    return {
      id: nanoid(), type, user: "System", initials: "S",
      avatar_url: null, content, participant_type: "system",
      self: false, encrypted: false, timestamp: new Date(),
    };
  }

  // ── Persisted timeline (chat:log kv — the storage half of history sync) ──────
  // Human messages append (debounced) to the sealed per-room log; the log is
  // reloaded on room entry so the timeline survives restarts, and it is what a
  // linked device replays over the devlink channel. System messages and
  // headless channels never persist.
  let historyCap = 500;
  const logAppender = createLogAppender(() => historyCap);

  function toPersisted(msg: Message, senderLeafId?: string): PersistedMessage | null {
    if (msg.participant_type !== "human") return null;
    if (msg.type === "system_error" || msg.type === "system_info") return null;
    const pm: PersistedMessage = {
      id: msg.id, type: msg.type, user: msg.user, content: msg.content,
      encrypted: msg.encrypted, ts: msg.timestamp.getTime(),
    };
    if (senderLeafId) pm.deviceId = senderLeafId;
    if (msg.image_data) pm.image_data = msg.image_data;
    if (msg.audio_data) pm.audio_data = msg.audio_data;
    if (msg.map) pm.map = msg.map;
    return pm;
  }

  function fromPersisted(pm: PersistedMessage): Message {
    const self = pm.deviceId
      ? sameUser(pm.deviceId, mlsIdentity.value)
      : pm.user === currentUserName.value;
    return {
      id: pm.id, type: pm.type, user: pm.user, initials: initials(pm.user),
      avatar_url: null, content: pm.content,
      ...(pm.image_data ? { image_data: pm.image_data } : {}),
      ...(pm.audio_data ? { audio_data: pm.audio_data } : {}),
      ...(pm.map ? { map: pm.map } : {}),
      participant_type: "human", self, encrypted: pm.encrypted,
      timestamp: new Date(pm.ts),
    };
  }

  /** Prepend the stored log to the live timeline (skipping ids already shown —
   *  a live message can land while the load is in flight). Best-effort: a
   *  storage hiccup must never break entering a room. */
  async function restoreTimeline(slug: string) {
    try {
      historyCap = await getChatHistoryCapMsgs();
      const stored = await loadLog(slug);
      if (!stored.length || currentRoom.value?.slug !== slug) return;
      const seen = new Set(messages.value.map((m) => m.id));
      const restored = stored.filter((pm) => !seen.has(pm.id)).map(fromPersisted);
      if (restored.length) messages.value = [...restored, ...messages.value];
    } catch {
      /* keep the live timeline */
    }
  }

  function pushMessage(msg: Message, senderLeafId?: string) {
    // Stable sender-minted ids make cross-device replays idempotent — drop a
    // message we already show (live echo vs restored log vs devlink replay).
    if (msg.participant_type === "human" && messages.value.some((m) => m.id === msg.id)) return;
    messages.value.push(msg);
    if (!msg.self && msg.participant_type !== "system") unread.value++;
    if (!headless && currentRoom.value) {
      const pm = toPersisted(msg, senderLeafId);
      if (pm) logAppender.push(currentRoom.value.slug, pm);
    }
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
  function displayName(): string {
    return currentUserName.value !== "You" ? currentUserName.value : mlsIdentity.value;
  }
  function selfParticipant(): Participant {
    return { id: mlsIdentity.value, name: displayName(), avatar_url: myAvatar.value, type: "human" };
  }
  /** Our avatar as sent on message envelopes (null when unset, like peers'). */
  function myAvatarOrNull(): string | null {
    return myAvatar.value || null;
  }

  // ── P2P roster (authenticated from MLS membership) ───────────────────────────
  // `onion` is the member's Tor onion (empty on iroh), learned from its presence.
  const presenceById = new Map<string, { name: string; avatar: string; onion: string }>();

  // ── Data-sync seam ───────────────────────────────────────────────────────────
  // External orchestrators ride this channel's MLS group by registering an `onSync`
  // handler and sending via `sendSync`. Routed inner-message families: `sync_*`
  // (full-data pull), `file_*` (P2P file transfer offer/accept signaling —
  // consumed by `useFileShare` in the app), `meeting_*` (meeting invite/RSVP
  // signaling — consumed by `useMeetings`), `vox_*` (voice-call offer/decline/
  // cancel signaling — consumed by `useVoxCall`) and `dlink_*` (linked-device
  // registry/kv/history sync — consumed by `useDeviceSync` on its HEADLESS
  // devlink channel only). Each handler ignores the prefixes it does not own.
  // `map_*` (map_pin / map_loc / map_region) is deliberately NOT
  // routed here: map shares are human content rendered as timeline cards
  // (handled inline after the mute check), not control traffic. Adding the
  // prefix "for consistency" would make this gate `return` before the mute
  // check and swallow every card — no handler owns `map_`, so nothing would
  // ever render. The routing tests in multiDeviceChannel.test.ts assert a real
  // map_loc frame becomes a card and turn red the moment that happens.
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
    const now = Date.now();
    // One roster row per USER: linked-device leaves ("alice", "alice#dev-x")
    // group together; the row keeps every leaf id for moderation/election.
    const byUser = new Map<string, string[]>();
    for (const id of source) {
      const user = userPartOf(id);
      const leaves = byUser.get(user);
      if (leaves) leaves.push(id);
      else byUser.set(user, [id]);
    }
    const list: Participant[] = [...byUser.entries()].map(([user, leafIds]) => {
      leafIds.sort();
      const rep = leafIds.includes(user) ? user : leafIds[0];
      const mine = user === userPartOf(mlsIdentity.value);
      const p: Participant = mine
        ? { ...selfParticipant(), id: rep }
        : (() => {
            const info = leafIds
              .map((id) => presenceById.get(id))
              .find((i) => i && (i.name || i.avatar));
            return { id: rep, name: info?.name || user, avatar_url: info?.avatar || "", type: "human" as const };
          })();
      if (leafIds.length > 1) {
        p.leafIds = [...leafIds];
        p.deviceCount = leafIds.length;
      }
      const muteUntil = leafIds
        .map((id) => mutedUntilFor(id, now))
        .reduce<number | null>((max, u) => (u && (!max || u > max) ? u : max), null);
      if (muteUntil) p.muteUntil = muteUntil;
      return p;
    });

    // Elect the captain (lowest live MLS id) on BOTH transports — it is the room
    // authority for moderation + meta. Over Tor it is additionally the onion
    // host/relay: re-point the transport when the elected captain changes AND we
    // can reach it.
    const elected = electCaptain(source);
    captainId.value = elected.captainId;
    for (const p of list) {
      p.isCaptain = !!elected.captainId &&
        (p.id === elected.captainId || (p.leafIds?.includes(elected.captainId) ?? false));
    }
    if (currentRoomIsTor.value) {
      const { captainOnion } = elected;
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
      avatar: myAvatar.value,
      onion: myOnion.value, // Tor: our dialable address, for captain election
      reply,
    }).catch(() => {});
  }

  // A profile picture change propagates live: refresh our own roster row and
  // re-announce so peers pick it up (no-op until MLS is ready).
  watch(myAvatar, () => {
    void refreshP2pRoster();
    void announcePresence(true); // reply=true: peers just store it, no echo storm
  });

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

  // ── Moderation + room meta (captain actions & wire handlers) ─────────────────

  /** Merge a patch into the current room's persisted entry (no-op when the room
   *  was never saved — e.g. a ticketless `joinByNode` reconnect). */
  function updateRoomEntry(patch: Partial<P2pRoomEntry>) {
    const slug = currentRoom.value?.slug;
    if (!slug) return;
    const entry = p2pRooms.value.find((r) => r.room === slug);
    if (!entry) return;
    Object.assign(entry, patch);
    persistP2pRooms();
  }

  function persistRoomMod() {
    updateRoomEntry({
      logo: roomLogo.value || undefined,
      rules: roomRules.value || undefined,
      inviteOnly: inviteOnly.value || undefined,
      metaRev: metaRev.value,
      mutes: mutes.value,
      bans: bans.value,
    });
  }

  /** Broadcast the full meta snapshot (logo, rules, mutes, bans). The captain
   *  sends it after every moderation/meta change; with `share=true` ANY holder
   *  sends it (a new member just announced itself) — receivers apply a
   *  non-captain copy only when strictly newer, which is what hands the state
   *  over when captaincy shifted to a member that doesn't have it yet (e.g. a
   *  lower-id joiner became captain). */
  async function broadcastRoomMeta(share = false) {
    if ((!amCaptain.value && !share) || mlsStatus.value !== "ready") return;
    await sendEncryptedMedia("room_meta", {
      device_id: mlsIdentity.value,
      logo: roomLogo.value,
      rules: roomRules.value,
      inviteOnly: inviteOnly.value,
      mutes: mutes.value,
      bans: bans.value,
      rev: metaRev.value,
    }).catch(() => {});
  }

  /** Apply a received `room_meta` snapshot (already captain-validated). */
  function applyRoomMeta(inner: Record<string, unknown>) {
    const rev = typeof inner.rev === "number" ? inner.rev : 0;
    if (rev < metaRev.value) return; // stale snapshot (equal rev re-applies — idempotent)
    const now = Date.now();
    const nextMutes: MuteMap = {};
    if (inner.mutes && typeof inner.mutes === "object") {
      for (const [id, until] of Object.entries(inner.mutes as Record<string, unknown>)) {
        const u = sanitizeMuteUntil(until, now);
        if (u) nextMutes[id] = u;
      }
    }
    const rulesBefore = roomRules.value;
    metaRev.value = rev;
    roomLogo.value = typeof inner.logo === "string" ? inner.logo : "";
    roomRules.value = typeof inner.rules === "string" ? clampRules(inner.rules) : "";
    // Absent means OPEN, which is what an older peer's snapshot looks like. The
    // rev guard above is what stops a stale one silently reopening a closed room.
    inviteOnly.value = inner.inviteOnly === true;
    mutes.value = nextMutes;
    bans.value = Array.isArray(inner.bans) ? (inner.bans as unknown[]).filter((b): b is string => typeof b === "string") : [];
    persistRoomMod();
    if (roomRules.value && roomRules.value !== rulesBefore) {
      messages.value.push(sysMsg("chat.sys.rules", "📜 Room rules:\n{rules}", { rules: roomRules.value }));
    }
    void refreshP2pRoster();
  }

  /** True when the envelope sender is the locally elected captain — the authz
   *  check for every moderation/meta message. Advisory (ids are self-asserted;
   *  see technology.md §9), consistent with the rest of group management. */
  function fromCaptain(data: Record<string, unknown>): boolean {
    return !!captainId.value && data.device_id === captainId.value;
  }

  function bumpRev() {
    metaRev.value += 1;
  }

  /** Captain: set / clear the room logo (small JPEG data URL). */
  async function setRoomLogo(file: File | null) {
    if (!amCaptain.value) return;
    roomLogo.value = file ? await downscaleImageToDataUrl(file, 256, 0.8) : "";
    bumpRev();
    persistRoomMod();
    await broadcastRoomMeta();
  }

  /** Captain: set the room rules text (clamped; empty clears). */
  async function setRoomRules(text: string) {
    if (!amCaptain.value) return;
    roomRules.value = clampRules(text);
    bumpRev();
    persistRoomMod();
    await broadcastRoomMeta();
  }

  /**
   * Captain: close or reopen the room.
   *
   * While closed, every member refuses gossip key packages (see the
   * `mls_key_package` handler) and the only way in is a redeemed invitation,
   * which never travels over gossip at all. Returns whether the flag actually
   * MOVED — the caller claims a Privacy HP recovery only on a real false→true
   * flip, so re-asserting a closed room earns nothing.
   *
   * Enforcement is app convention (§9.3): a member on a modified or older build
   * will still auto-admit, so this narrows §9.7 rather than closing it.
   */
  async function setInviteOnly(on: boolean): Promise<boolean> {
    if (!amCaptain.value || inviteOnly.value === on) return false;
    inviteOnly.value = on;
    bumpRev();
    persistRoomMod();
    await broadcastRoomMeta();
    return true;
  }

  /** Captain: mute a member for `minutes`. Enforced cooperatively: everyone drops
   *  the muted member's messages until expiry, and its own composer locks.
   *  Keyed by USER part — one mute covers all of the member's linked devices. */
  async function muteMember(id: string, minutes: number) {
    if (!amCaptain.value || sameUser(id, mlsIdentity.value) || !currentRoom.value) return;
    const target = userPartOf(id);
    const until = sanitizeMuteUntil(Date.now() + minutes * 60_000, Date.now());
    if (!until) return;
    mutes.value = { ...mutes.value, [target]: until };
    bumpRev();
    persistRoomMod();
    await sendEncryptedMedia("mod_mute", { device_id: mlsIdentity.value, target, until }).catch(() => {});
    await broadcastRoomMeta();
    messages.value.push(sysMsg("chat.sys.muted", "🔇 {who} was muted for {time}.", { who: nameFor(target), time: formatRemaining(until, Date.now()) }));
    void refreshP2pRoster();
  }

  /** Captain: lift a member's mute early (either keying scheme). */
  async function unmuteMember(id: string) {
    const target = id in mutes.value ? id : userPartOf(id);
    if (!amCaptain.value || !(target in mutes.value)) return;
    const next = { ...mutes.value };
    delete next[target];
    mutes.value = next;
    bumpRev();
    persistRoomMod();
    await sendEncryptedMedia("mod_unmute", { device_id: mlsIdentity.value, target }).catch(() => {});
    await broadcastRoomMeta();
    messages.value.push(sysMsg("chat.sys.unmuted", "🔊 {who} was unmuted.", { who: nameFor(target) }));
    void refreshP2pRoster();
  }

  /** Captain: kick a member — notify (while it can still decrypt), ban the
   *  identity (the acting admin refuses its future key packages), then remove it
   *  from the MLS group. Cryptographic removal is what actually cuts access.
   *  Bans key by USER part and the removal takes out EVERY leaf of that user —
   *  kicking someone kicks all their linked devices. */
  async function kickMember(id: string) {
    if (!amCaptain.value || sameUser(id, mlsIdentity.value) || !currentRoom.value) return;
    const room = currentRoom.value.slug;
    const target = userPartOf(id);
    if (!bans.value.includes(target)) bans.value = [...bans.value, target];
    bumpRev();
    persistRoomMod();
    // Order matters: the kick notice + snapshot go out BEFORE the removal commit,
    // so the target still decrypts them and leaves cleanly.
    await sendEncryptedMedia("mod_kick", { device_id: mlsIdentity.value, target }).catch(() => {});
    await broadcastRoomMeta();
    const memberIds = await cryptoService.members(room, mlsIdentity.value).catch(() => [] as string[]);
    const leaves = memberIds.filter((m) => userPartOf(m) === target);
    for (const leaf of leaves.length ? leaves : [id]) {
      presenceById.delete(leaf);
      const commit = await cryptoService.removeMember(room, mlsIdentity.value, leaf).catch(() => null);
      if (commit) send({ type: "mls_commit", commit: bytesToBase64(commit) });
    }
    messages.value.push(sysMsg("chat.sys.removed", "🚫 {who} was removed from the room.", { who: nameFor(target) }));
    void refreshP2pRoster();
  }

  /** Captain: lift a ban (the identity may re-join with a fresh key package). */
  async function unbanMember(id: string) {
    if (!amCaptain.value || !bans.value.includes(id)) return;
    bans.value = bans.value.filter((b) => b !== id);
    bumpRev();
    persistRoomMod();
    await broadcastRoomMeta();
  }

  /** We were kicked: leave + forget the room (mirrors `handleRoomClosed`). */
  async function handleKicked() {
    if (!currentRoom.value) return;
    const slug = currentRoom.value.slug;
    const name = currentRoom.value.name;
    const tor = currentRoomIsTor.value;
    await cryptoService.clearState(slug, mlsIdentity.value).catch(() => {});
    if (tor) chatTransport.forgetTorOnion(name);
    if (!headless) { logAppender.drop(slug); void wipeLog(slug); }
    forgetP2pRoom(slug);
    clearLocalChatState(t("chat.sys.kicked", "🚫 You were removed from this room by the host."));
  }

  function nameFor(id: string): string {
    if (sameUser(id, mlsIdentity.value)) return displayName();
    const direct = presenceById.get(id)?.name;
    if (direct) return direct;
    // A user-part key (new-style mute/kick target): any of its leaves' presence.
    for (const [leaf, info] of presenceById) {
      if (userPartOf(leaf) === id && info.name) return info.name;
    }
    return id;
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
    messages.value.push(sysMsg("chat.sys.hostGone", "The room host went offline — electing a new host…"));
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
        const b64 = bytesToBase64(kp);
        send({ type: "mls_key_package", key_package: b64, device_id: identity, ...(await kpEnvelopeExtra(b64)) });
        messages.value.push(sysMsg("chat.sys.groupChanged", "🔑 MLS group changed — sent a fresh key package."));
      } else {
        mlsStatus.value = "error";
        messages.value.push(sysMsg("chat.sys.recoverFailed", "Could not recover MLS session.", undefined, "system_error"));
      }
    } catch (e) {
      mlsStatus.value = "error";
      mlsError.value = errorMessage(e);
      messages.value.push(sysMsg("chat.sys.recoverFailedWhy", "Could not recover MLS session: {why}", { why: errorMessage(e) }, "system_error"));
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
      messages.value.push(sysMsg("chat.sys.connected", "Connected to {room}.", { room: currentRoom.value?.name ?? "room" }));
      void startMls();
    } else if (status === "disconnected") {
      messages.value.push(sysMsg("chat.sys.disconnected", "Disconnected."));
    } else if (status === "error") {
      messages.value.push(sysMsg("chat.sys.connectionError", "Connection error.", undefined, "system_error"));
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
      // Devlink channel: a key package must prove possession of the linkKey
      // (HMAC over the kp bytes) before anyone here even considers it.
      if (options.admissionCheck && !(await options.admissionCheck(data))) return;
      const deviceId = (data.device_id as string) ?? (data.sender_channel as string);
      // Invite-only: nobody gets in off the topic. Placed ABOVE the admin split
      // below on purpose — a guard placed after it would close the branch that
      // ADDS while leaving the branch that DEFERS still answering a stranger
      // with our own key package, which is a half-closed door.
      //
      // The invitation path is untouched by this and that is the whole point:
      // `admitInvited` calls `cryptoService.addMember` directly and never rides
      // gossip, so a redeemed invitation still admits in a closed room.
      //
      // Headless channels (devlink, peer sync) carry their own `admissionCheck`
      // and have no room meta of their own, so they are exempt.
      if (!options.headless && inviteOnly.value) return;
      // Banned (kicked) identities are refused re-admission: the acting admin
      // never adds them, and nobody defers to them with a counter key package.
      // Bans key by user part, so every linked device of a kicked user is out.
      if (deviceId && isBanned(deviceId)) return;
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
            send({ type: "mls_key_package", key_package: b64, package: b64, device_id: mlsIdentity.value, user: currentUserName.value, target_channel: data.sender_channel, ...(await kpEnvelopeExtra(b64)) });
          }
          return;
        }
        pendingInvites.add(deviceId);
        const result = await cryptoService.addMember(currentRoom.value!.slug, mlsIdentity.value, base64ToBytes(rawKp));
        if (result) {
          mlsStatus.value = "ready";
          send({ type: "mls_commit", commit: bytesToBase64(result.commit) });
          send({ type: "mls_welcome", welcome: bytesToBase64(result.welcome), target_channel: data.sender_channel });
          messages.value.push(sysMsg("chat.sys.encrypted", "🔒 End-to-end encryption active."));
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
        messages.value.push(sysMsg("chat.sys.gotWelcome", "🔑 Received group invitation — joining encrypted group…"));
        const ok = await cryptoService.joinFromWelcome(currentRoom.value.slug, mlsIdentity.value, base64ToBytes(data.welcome as string));
        if (ok) {
          mlsStatus.value = "ready";
          messages.value.push(sysMsg("chat.sys.encrypted", "🔒 End-to-end encryption active."));
        } else {
          mlsStatus.value = "error";
          mlsError.value = t("chat.sys.joinGroupFailed", "Failed to join encrypted group.");
          messages.value.push(sysMsg("chat.sys.joinGroupFailed", "Failed to join encrypted group.", undefined, "system_error"));
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
            messages.value.push(sysMsg("chat.sys.commitFailed", "Could not process MLS commit: {why}", { why: errorMessage(e) }, "system_error"));
          }
        }
      }
      return;
    }

    if (type === "mls_app" && data.ciphertext) {
      if (data.device_id === mlsIdentity.value) return;
      // Somebody else is talking in here. Noted even when we cannot read it —
      // especially then, because being unable to read it is the whole point.
      sawForeignTraffic = true;
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
            messages.value.push(sysMsg("chat.sys.decryptFailedWhy", "Could not decrypt incoming message: {why}", { why: errorMessage(e) }, "system_error"));
          }
          return;
        }
        if (plaintext) {
          const text = new TextDecoder().decode(plaintext);
          const avatarUrl = (data.sender_avatar_url as string) ?? sender?.avatar_url ?? null;
          const senderLeafId = (data.device_id as string) || undefined;
          // "Self" spans the whole user: a message from our OTHER linked device
          // renders as ours (right-aligned, no unread bump).
          const isSelf = senderName === currentUserName.value ||
            (!!senderLeafId && sameUser(senderLeafId, mlsIdentity.value));
          let inner: Record<string, unknown> | null = null;
          try { inner = JSON.parse(text); } catch (_) {}
          // Sender-minted stable id (inner = encrypted, preferred; outer covers
          // raw-text messages) — the cross-device dedupe key. Old builds send
          // neither and fall back to a local nanoid (no dedupe, still renders).
          const rxId = (typeof inner?.msg_id === "string" && inner.msg_id) ||
            (typeof data.msg_id === "string" && data.msg_id) || nanoid();

          if (inner?.type === "presence" && inner.device_id) {
            const id = inner.device_id as string;
            if (id !== mlsIdentity.value) {
              presenceById.set(id, {
                name: (inner.name as string) || id,
                avatar: (inner.avatar as string) || "",
                onion: (inner.onion as string) || "",
              });
              deadCaptains.delete(id); // a fresh presence ⇒ this member is alive again
              const initialAnnounce = !inner.reply;
              void refreshP2pRoster().then(() => {
                // A new member announced itself: every meta holder shares the
                // snapshot (logo/rules/mutes/bans) so the joiner converges even
                // when the captain just changed or is missing. Receivers dedupe
                // by revision, so redundant copies are idempotent.
                if (initialAnnounce && metaRev.value > 0) void broadcastRoomMeta(true);
              });
              if (initialAnnounce) void announcePresence(true);
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
          // Captain-authoritative meta + moderation. The captain's snapshot
          // applies at same-or-higher revision; anyone else's only when
          // STRICTLY newer — that's the handoff path for a captaincy change
          // (the previous captain shares state the new captain doesn't hold).
          if (inner?.type === "room_meta") {
            const rev = typeof inner.rev === "number" ? inner.rev : 0;
            const accept = fromCaptain(data) ? rev >= metaRev.value : rev > metaRev.value;
            if (accept) {
              applyRoomMeta(inner);
              // If WE are the (new) captain adopting a handed-over snapshot,
              // re-broadcast it authoritatively so the whole room converges.
              if (amCaptain.value) void broadcastRoomMeta();
            }
            return;
          }
          if (inner?.type === "mod_mute" && typeof inner.target === "string") {
            if (fromCaptain(data)) {
              const until = sanitizeMuteUntil(inner.until, Date.now());
              if (until) {
                mutes.value = { ...mutes.value, [inner.target]: until };
                persistRoomMod();
                // Targets are user parts from new builds, full ids from old ones
                // — sameUser covers both against our leaf identity.
                const who = sameUser(inner.target, mlsIdentity.value) ? "You were" : `${nameFor(inner.target)} was`;
                messages.value.push(sysMsg("chat.sys.mutedShort", "🔇 {who} muted for {time}.", { who, time: formatRemaining(until, Date.now()) }));
                void refreshP2pRoster();
              }
            }
            return;
          }
          if (inner?.type === "mod_unmute" && typeof inner.target === "string") {
            if (fromCaptain(data) && inner.target in mutes.value) {
              const next = { ...mutes.value };
              delete next[inner.target];
              mutes.value = next;
              persistRoomMod();
              const who = sameUser(inner.target, mlsIdentity.value) ? "You were" : `${nameFor(inner.target)} was`;
              messages.value.push(sysMsg("chat.sys.unmutedShort", "🔊 {who} unmuted.", { who }));
              void refreshP2pRoster();
            }
            return;
          }
          if (inner?.type === "mod_kick" && typeof inner.target === "string") {
            if (fromCaptain(data)) {
              if (!bans.value.includes(inner.target)) bans.value = [...bans.value, inner.target];
              persistRoomMod();
              if (sameUser(inner.target, mlsIdentity.value)) {
                void handleKicked();
              } else {
                // Kicking a user drops the presence of every one of its leaves.
                for (const leaf of [...presenceById.keys()]) {
                  if (leaf === inner.target || userPartOf(leaf) === inner.target) presenceById.delete(leaf);
                }
                messages.value.push(sysMsg("chat.sys.removed", "🚫 {who} was removed from the room.", { who: nameFor(inner.target) }));
                void refreshP2pRoster();
              }
            }
            return;
          }
          if (typeof inner?.type === "string" && (inner.type.startsWith("sync_") || inner.type.startsWith("file_") || inner.type.startsWith("meeting_") || inner.type.startsWith("vox_") || inner.type.startsWith("dlink_") || inner.type.startsWith("plink_"))) {
            // `dlink_*` is the linked-device sync family (useDeviceSync) and
            // `plink_*` the peer-link family (usePeerSync). Each is only ever
            // produced/consumed on its own headless channel; on a normal room
            // channel no handler owns the prefix, so it drops here harmlessly
            // (same contract as every other sync family). A prefix MISSING from
            // this gate does not drop — it renders as a raw-JSON chat bubble and
            // gets persisted to chat:log. That was the CRITICAL finding of the
            // 2026-07-20 review; both families have a routing regression test.
            syncHandlers.forEach((h) => h(inner!.type as string, inner!, senderName));
            return;
          }
          // Mute enforcement (receive side): drop a muted member's HUMAN messages.
          // Control traffic above (presence/leave/sync/moderation) stays routed.
          if (mutedUntilFor((data.device_id as string) ?? "", Date.now())) return;
          if (inner?.type === "image_message" && inner.image_data) {
            pushMessage({ id: rxId, type: "image_message", user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: "", image_data: inner.image_data as string, participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date() }, senderLeafId);
          } else if (inner?.type === "voice_message" && inner.audio_data) {
            pushMessage({ id: rxId, type: "voice_message", user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: "", audio_data: inner.audio_data as string, participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date() }, senderLeafId);
          } else if (typeof inner?.type === "string" && inner.type.startsWith("map_")) {
            // Map shares (mapModel wire shapes) become timeline cards; anything
            // that fails validation — junk, unknown map_* kinds, newer `v` — is
            // dropped silently, never rendered as a raw-JSON bubble. Deliberately
            // NOT a sync family: cards are human content, so they sit after the
            // mute check above (control traffic they are not).
            //
            // `map_loc` (a shared location) rides here too and MUST NOT be given
            // its own prefix in the gate above — see that comment. Its expiry is
            // a render decision; the validator is time-independent so a stale
            // card still reloads intact.
            const share =
              inner.type === "map_pin" ? validatePinShare(inner)
                      : inner.type === "map_loc" ? validateLocationShare(inner)
              : inner.type === "map_region" ? validateRegionShare(inner)
              : null;
            if (share) {
              pushMessage({ id: rxId, type: share.type, user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: "", map: share, participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date() }, senderLeafId);
            }
          } else {
            pushMessage({ id: rxId, type: "mls_app", user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: text, participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date() }, senderLeafId);
          }
        } else {
          messages.value.push(sysMsg("chat.sys.decryptFailed", "⚠ Could not decrypt an incoming message.", undefined, "system_error"));
        }
      } else {
        // Transient "arrived before MLS was ready" placeholder — pushed straight
        // to the live view, NOT through pushMessage, so it is never persisted to
        // chat:log (and never replayed to a linked device or restored on reload).
        messages.value.push({
          id: nanoid(), type: "mls_app", user: senderName, initials: initials(senderName),
          avatar_url: (data.sender_avatar_url as string) ?? sender?.avatar_url ?? null,
          content: "🔒 [encrypted — session not ready]", participant_type: "human",
          self: false, encrypted: true, timestamp: new Date(),
        });
      }
      return;
    }
  }

  /** Extra outbound fields for `mls_key_package` envelopes (devlink attaches
   *  its linkKey HMAC proof here). Failures degrade to a bare envelope. */
  async function kpEnvelopeExtra(kpB64: string): Promise<Record<string, unknown>> {
    if (!options.keyPackageExtra) return {};
    try {
      return await options.keyPackageExtra(kpB64);
    } catch {
      return {};
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
        send({ type: "mls_key_package", key_package: b64, package: b64, device_id: identity, user: currentUserName.value, ...(await kpEnvelopeExtra(b64)) });
        messages.value.push(sysMsg("chat.sys.settingUp", "🔑 Setting up encryption…"));
        mlsStatus.value = "key_exchange";
        clearCreatorTimer();
        creatorTimer = setTimeout(() => {
          creatorTimer = null;
          if (mlsStatus.value !== "key_exchange") return;
          if (sawForeignTraffic) {
            // Other members are here and none of them has admitted us. Declaring
            // a group of one would be worse than saying nothing: it would show a
            // green lock over a group that cannot read us, and let the composer
            // send into the void (technology.md §9.5). Wait, then say so.
            armAdmissionTimeout();
            return;
          }
          // Nobody else is here — a fresh room with one member really is
          // encrypted, and this is the case the timer was written for.
          mlsStatus.value = "ready";
          messages.value.push(sysMsg("chat.sys.encrypted", "🔒 End-to-end encryption active."));
        }, 5000);
      }
    } catch (e) {
      mlsStatus.value = "error";
      mlsError.value = (e as Error).message;
      messages.value.push(sysMsg("chat.sys.initFailed", "Encryption init failed: {why}", { why: (e as Error).message }, "system_error"));
    }
  }

  /**
   * Give admission the user's own connect deadline, then say plainly that it did
   * not happen.
   *
   * Nothing is sent to anyone: the message is local, produced by a timeout. No
   * member has to confirm to a stranger that a room exists and is closed, and
   * there is no unauthenticated frame for anyone to forge. It replaces an
   * indefinite "Setting up encryption…", which is indistinguishable from a bug.
   *
   * Bounded by the user-set connect timeout like every other deadline in the app
   * (technology.md §15) — never a literal — so a slow but succeeding handshake
   * still wins: the Welcome sets `ready` and the check below finds nothing to say.
   */
  function armAdmissionTimeout() {
    if (admissionTimer) clearTimeout(admissionTimer);
    void getConnectTimeoutSecs().then((secs) => {
      admissionTimer = setTimeout(() => {
        admissionTimer = null;
        if (mlsStatus.value !== "key_exchange") return;
        messages.value.push(
          systemMsg(
            "No one admitted you to this room. It may require an invitation — ask whoever shared it for one.",
            "system_error",
          ),
        );
      }, secs * 1000);
    });
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
    if (headless) return; // the hidden devlink room never touches the saved list
    try {
      const raw = await kvGet("p2p:rooms", "default", "");
      p2pRooms.value = raw ? (JSON.parse(raw) as P2pRoomEntry[]) : [];
    } catch {
      p2pRooms.value = [];
    }
  }

  function persistP2pRooms() {
    if (headless) return;
    void kvPut("p2p:rooms", "default", "", JSON.stringify(p2pRooms.value)).catch(() => {});
  }

  function rememberP2pRoom(entry: P2pRoomEntry) {
    if (headless) return;
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
    captainId.value = null;
    deadCaptains.clear();
    if (electionTimer) { clearTimeout(electionTimer); electionTimer = null; }
    // Load the room's persisted meta + moderation state (captain snapshots
    // received later overwrite this by revision).
    const saved = p2pRooms.value.find((r) => r.room === room);
    roomLogo.value = saved?.logo ?? "";
    roomRules.value = saved?.rules ?? "";
    metaRev.value = saved?.metaRev ?? 0;
    mutes.value = pruneMutes(saved?.mutes ?? {}, Date.now());
    bans.value = saved?.bans ?? [];
    currentRoom.value = makeP2pRoom(room, name);
    participants.value = [selfParticipant()];
    isParticipant.value = true;
    mlsStatus.value = "idle";
    mlsError.value = null;
    pendingInvites.clear();
    wsStatus.value = chatTransport.lastStatus(room) ?? "connecting";
    // The stored timeline (chat:log) comes back so a reopened room isn't blank.
    if (!headless) void restoreTimeline(room);
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
      messages.value.push(
        sysMsg("chat.sys.created", "Created “{name}”. Share the QR / ticket to invite peers.", {
          name: res.name,
        }),
      );
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
      messages.value.push(
        sysMsg("chat.sys.joined", "Joined “{name}”. Connecting to peers…", { name: res.name }),
      );
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
      messages.value.push(
        sysMsg("chat.sys.joined", "Joined “{name}”. Connecting to peers…", { name: res.name }),
      );
    } catch (e) {
      error.value = errorMessage(e);
    }
  }

  // ── invitations (technology.md §18) ─────────────────────────────────────────
  // Redemption is driven by Rust, but the two MLS halves belong here, with every
  // other MLS operation in this app. The admission also has to BROADCAST its
  // commit over this room's transport, and `send` is this module's — exposing it
  // so a store could do the group work outside would be the wrong seam.

  /**
   * Admit someone who redeemed an invitation: add their key package to this
   * room's group, tell the existing members, and hand back the Welcome for the
   * newcomer.
   *
   * Requires the room to be OPEN and its group ready — the commit has nowhere to
   * go otherwise, and a member added to a group nobody else knows about would be
   * invisible to everyone. `null` means "could not admit", and the caller must
   * pass that on so Rust releases the invitation's lease rather than burning it.
   */
  async function admitInvited(
    roomSlug: string,
    keyPackageB64: string,
  ): Promise<{ welcome: string; roomName: string; peers: string[]; onion: string } | null> {
    if (!currentRoom.value || currentRoom.value.slug !== roomSlug) return null;
    if (mlsStatus.value !== "ready") return null;
    try {
      const result = await cryptoService.addMember(
        roomSlug,
        mlsIdentity.value,
        base64ToBytes(keyPackageB64),
      );
      if (!result) return null;
      // Existing members first: they must be able to process the commit before
      // the newcomer starts sending, or their group state diverges from his.
      send({ type: "mls_commit", commit: bytesToBase64(result.commit) });
      void refreshP2pRoster();

      // Where the newcomer should connect. Read from the ROOM's transport, not
      // from a global setting — a room opened before the Tor switch moved is
      // still on the transport it was opened with.
      //
      // This is the room's address, which every member necessarily has; it is
      // not a credential. Nothing here re-admits anybody: the group is closed
      // again the moment this commit lands.
      const onion = currentRoomIsTor.value ? myOnion.value : "";
      const peers = currentRoomIsTor.value ? [] : [(await ensureNode()) ?? ""].filter(Boolean);
      return {
        welcome: bytesToBase64(result.welcome),
        roomName: currentRoom.value.name,
        peers,
        onion,
      };
    } catch {
      return null;
    }
  }

  /**
   * The redeemer's half: join the group from the Welcome the inviter granted,
   * then join the room's transport.
   *
   * MLS first, transport second — the reverse of an ordinary join. A normal
   * joiner arrives on the topic and negotiates; here the negotiation already
   * happened over the authenticated redemption stream, so the group membership
   * is settled before the first gossip frame.
   */
  async function joinByInvite(
    grant: { roomName: string; welcome: string; peers: string[]; onion: string },
    /** The scratch room key the redeemer's KeyPackage was built under. It has to
     *  move onto the real room before the Welcome can be processed there — that
     *  session is the one holding the KeyPackage's private init key. */
    scratchRoom: string,
  ): Promise<boolean> {
    error.value = null;
    try {
      // `joinByNode` routes on both transports (realtime_join_room_by_node).
      // Over Tor it re-hosts this room's name as an onion of our own, so the
      // captain has to be pointed at explicitly afterwards — the same two-step
      // a Tor reconnect already performs.
      await joinByNode(grant.roomName, grant.peers);
      if (grant.onion && currentRoom.value) {
        chatTransport.setCaptain(currentRoom.value.slug, grant.onion);
      }
      if (!currentRoom.value) return false;
      const slug = currentRoom.value.slug;
      if (!(await cryptoService.adoptSession(scratchRoom, slug, mlsIdentity.value))) {
        mlsStatus.value = "error";
        mlsError.value = t("chat.sys.adoptFailed", "Could not take up the invitation's encrypted session.");
        return false;
      }
      const ok = await cryptoService.joinFromWelcome(
        slug,
        mlsIdentity.value,
        base64ToBytes(grant.welcome),
      );
      if (!ok) {
        mlsStatus.value = "error";
        mlsError.value = t("chat.sys.joinGroupFailed", "Failed to join encrypted group.");
        return false;
      }
      mlsStatus.value = "ready";
      messages.value.push(sysMsg("chat.sys.encrypted", "🔒 End-to-end encryption active."));
      return true;
    } catch (e) {
      error.value = errorMessage(e);
      return false;
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
  /** Returns the bytes of stored history that went away, so the caller can claim
   *  the Privacy HP data-deletion credit. 0 when there was nothing stored. */
  async function deleteRoom(entry: P2pRoomEntry): Promise<number> {
    const slug = entry.room;
    const identity = mlsIdentity.value;
    const isCurrent = currentRoom.value?.slug === slug;

    if (isCurrent && mlsStatus.value === "ready") {
      await sendEncryptedMedia(entry.host ? "room_closed" : "leave", { device_id: identity }).catch(() => {});
    }
    // Wipe local data (MLS state, saved entry, stored timeline).
    await cryptoService.clearState(slug, identity).catch(() => {});
    if (entry.tor) chatTransport.forgetTorOnion(entry.name); // stops the service + drops the key
    let freed = 0;
    if (!headless) {
      logAppender.drop(slug);
      // Awaited now (it used to be fire-and-forget) so the byte count is real
      // rather than a guess; the wipe was already ordered before this line.
      freed = await wipeLog(slug).catch(() => 0);
    }
    forgetP2pRoom(slug);
    // Close connections / reset the view.
    if (isCurrent) clearLocalChatState(t("chat.sys.roomDeleted", "Room deleted."));
    else chatTransport.leaveRoom(slug); // stop hosting/dialing a non-open room
    return freed;
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
    if (!headless) { logAppender.drop(slug); void wipeLog(slug); }
    forgetP2pRoom(slug);
    // Resets the channel + leaves the notice as the sole system message.
    clearLocalChatState(t("chat.sys.roomDeletedByHost", "This room was deleted by the host."));
  }

  // ── sending ──────────────────────────────────────────────────────────────────
  /** `msgId` (human content only) rides INSIDE the ciphertext — the stable
   *  sender-minted id that keeps linked devices' timelines deduplicated without
   *  leaking anything to the topic. Control payloads pass none. */
  async function sendEncryptedMedia(innerType: string, payload: Record<string, unknown>, msgId?: string) {
    const inner = msgId ? { type: innerType, msg_id: msgId, ...payload } : { type: innerType, ...payload };
    const ct = await cryptoService.encrypt(currentRoom.value!.slug, mlsIdentity.value, JSON.stringify(inner));
    if (!ct) throw new Error("Encryption failed");
    send({
      type: "mls_app", ciphertext: bytesToBase64(ct), device_id: mlsIdentity.value,
      user: currentUserName.value, sender_name: currentUserName.value,
      sender_avatar_url: myAvatarOrNull(),
    });
  }

  /** Send a data-sync control/data message over this channel's MLS group. */
  async function sendSync(type: string, payload: Record<string, unknown>) {
    await sendEncryptedMedia(type, payload);
  }

  /** Self-mute send guard: posts a notice + returns true while we are muted.
   *  Honors both keying schemes (user-part and legacy full-leaf) so a mute set
   *  against our user still locks a secondary device's composer. */
  function blockedByMute(): boolean {
    const until = mutedUntilFor(mlsIdentity.value, Date.now());
    if (!until) return false;
    messages.value.push(systemMsg(`🔇 You are muted for another ${formatRemaining(until, Date.now())}.`, "system_error"));
    return true;
  }

  async function sendImage(file: File, onProgress?: (pct: number) => void) {
    if (!currentRoom.value || !isConnected.value || !isParticipant.value) return;
    if (blockedByMute()) return;
    error.value = null;
    if (mlsStatus.value !== "ready") {
      messages.value.push(sysMsg("chat.sys.notReady", "Encryption not ready yet — try again in a moment.", undefined, "system_error"));
      return;
    }
    try {
      const dataUrl = await downscaleImageToDataUrl(file);
      const msgId = nanoid();
      await sendEncryptedMedia("image_message", { image_data: dataUrl }, msgId);
      pushMessage({ id: msgId, type: "image_message", user: currentUserName.value, initials: initials(currentUserName.value), avatar_url: myAvatarOrNull(), content: "", image_data: dataUrl, participant_type: "human", self: true, encrypted: true, timestamp: new Date() }, mlsIdentity.value);
      onProgress?.(100);
    } catch (e) { error.value = errorMessage(e); }
  }

  /** Send a validated map share (pin / route / region offer) as a chat card.
   *  Payloads are the compact mapModel wire shapes — map BYTES never ride MLS
   *  (regions transfer over the file_xfer QUIC path). */
  async function sendMapShare(share: MapShare) {
    if (!currentRoom.value || !isConnected.value || !isParticipant.value) return;
    if (blockedByMute()) return;
    error.value = null;
    if (mlsStatus.value !== "ready") {
      messages.value.push(sysMsg("chat.sys.notReady", "Encryption not ready yet — try again in a moment.", undefined, "system_error"));
      return;
    }
    try {
      const msgId = nanoid();
      await sendEncryptedMedia(share.type, { ...share }, msgId);
      pushMessage({ id: msgId, type: share.type, user: currentUserName.value, initials: initials(currentUserName.value), avatar_url: myAvatarOrNull(), content: "", map: share, participant_type: "human", self: true, encrypted: true, timestamp: new Date() }, mlsIdentity.value);
    } catch (e) { error.value = errorMessage(e); }
  }

  async function sendAudio(audioBlob: Blob) {
    if (!currentRoom.value || !isConnected.value || !isParticipant.value) return;
    if (blockedByMute()) return;
    error.value = null;
    if (mlsStatus.value !== "ready") {
      messages.value.push(sysMsg("chat.sys.notReady", "Encryption not ready yet — try again in a moment.", undefined, "system_error"));
      return;
    }
    try {
      const dataUrl = await blobToDataUrl(audioBlob);
      const msgId = nanoid();
      await sendEncryptedMedia("voice_message", { audio_data: dataUrl }, msgId);
      pushMessage({ id: msgId, type: "voice_message", user: currentUserName.value, initials: initials(currentUserName.value), avatar_url: myAvatarOrNull(), content: "", audio_data: dataUrl, participant_type: "human", self: true, encrypted: true, timestamp: new Date() }, mlsIdentity.value);
    } catch (e) { error.value = errorMessage(e); }
  }

  async function sendMessage(content: string) {
    const text = content.trim();
    if (!text || !isConnected.value || !currentRoom.value) return;
    if (blockedByMute()) return;

    if (mlsStatus.value === "ready") {
      const ct = await cryptoService.encrypt(currentRoom.value.slug, mlsIdentity.value, text);
      if (ct) {
        // Text stays RAW inside the ciphertext (old-build receivers render it
        // as-is), so its stable id rides the outer envelope. msg_id is a random
        // nanoid — it correlates nothing an observer doesn't already see as a
        // discrete gossip frame.
        const msgId = nanoid();
        send({ type: "mls_app", ciphertext: bytesToBase64(ct), device_id: mlsIdentity.value, user: currentUserName.value, sender_name: currentUserName.value, sender_avatar_url: myAvatarOrNull(), msg_id: msgId });
        pushMessage({ id: msgId, type: "mls_app", user: currentUserName.value, initials: initials(currentUserName.value), avatar_url: myAvatarOrNull(), content: text, participant_type: "human", self: true, encrypted: true, timestamp: new Date() }, mlsIdentity.value);
      } else {
        messages.value.push(sysMsg("chat.sys.encryptFailed", "Encryption failed — message not sent.", undefined, "system_error"));
      }
    } else {
      // Pre-MLS fallback (plaintext over the gossip topic; QUIC still encrypts hops).
      send({ type: "chat_message", message: text, id: nanoid() });
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
    messages.value = [sysMsg("chat.sys.sessionReset", "🔄 Session reset — history cleared.")];
    try {
      await cryptoService.clearState(room, identity);
      await cryptoService.initSession(room, identity);
      const kp = await cryptoService.keyPackage(room, identity);
      if (kp) {
        const b64 = bytesToBase64(kp);
        send({ type: "mls_key_package", key_package: b64, package: b64, device_id: identity, user: currentUserName.value, ...(await kpEnvelopeExtra(b64)) });
        mlsStatus.value = "key_exchange";
        messages.value.push(sysMsg("chat.sys.freshKp", "🔑 Fresh key package sent."));
        setTimeout(() => {
          if (mlsStatus.value === "key_exchange") {
            mlsStatus.value = "ready";
            messages.value.push(sysMsg("chat.sys.newGroup", "🔒 New encryption group created."));
          }
        }, 5000);
      } else {
        mlsStatus.value = "error";
        messages.value.push(sysMsg("chat.sys.kpFailed", "Failed to generate key package.", undefined, "system_error"));
      }
    } catch (e) {
      mlsStatus.value = "error";
      mlsError.value = (e as Error).message;
      messages.value.push(
        sysMsg("chat.sys.resetFailed", "Reset failed: {err}", { err: (e as Error).message }, "system_error"),
      );
    }
  }

  function clearUnread() { unread.value = 0; }

  /** Devlink catch-up: splice replayed history into the OPEN room's timeline
   *  (storage merge is the caller's job — this is only the live view). Ids
   *  dedupe against what's already shown; the result stays ts-ordered. */
  function mergeHistory(slug: string, incoming: PersistedMessage[]) {
    if (headless || currentRoom.value?.slug !== slug || incoming.length === 0) return;
    const seen = new Set(messages.value.map((m) => m.id));
    const fresh = incoming.filter((pm) => !seen.has(pm.id)).map(fromPersisted);
    if (!fresh.length) return;
    const merged = [...messages.value, ...fresh].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    messages.value = merged;
  }

  /** Remove ONE leaf from the current room's MLS group (linked-device unlink —
   *  unlike kickMember this must not touch the user's other leaves). Any member
   *  may enforce a registry revocation this way; exact-identity removal is safe
   *  because leaf ids are unique. */
  async function removeLeaf(leafId: string) {
    if (!currentRoom.value || leafId === mlsIdentity.value) return;
    const room = currentRoom.value.slug;
    const ids = await cryptoService.members(room, mlsIdentity.value).catch(() => [] as string[]);
    if (!ids.includes(leafId)) return;
    presenceById.delete(leafId);
    const commit = await cryptoService.removeMember(room, mlsIdentity.value, leafId).catch(() => null);
    if (commit) send({ type: "mls_commit", commit: bytesToBase64(commit) });
    void refreshP2pRoster();
  }

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
    isParticipant, currentUserName, mlsIdentity, myAvatar,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState,
    joinParticipant, leaveParticipant,
    sendMessage, sendImage, sendAudio, sendMapShare, forceResetMls,
    p2pRooms, loadP2pRooms, createRoom, joinByTicket, joinByNode, openP2pRoom,
    admitInvited, joinByInvite,
    cancelJoin, deleteRoom,
    ensureNode,
    onSync, sendSync, postSystemNotice,
    mergeHistory, removeLeaf,
    // Room meta + moderation (captain-authoritative)
    captainId, amCaptain, roomLogo, roomRules, inviteOnly, bans, selfMuteUntil,
    setRoomLogo, setRoomRules, setInviteOnly, kickMember, muteMember, unmuteMember, unbanMember,
  };
}

export type ChatChannel = ReturnType<typeof useChatChannel>;
