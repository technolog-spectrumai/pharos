// One chat channel, fully self-contained: its own room, messages,
// participants, MLS session and transport wiring. The app is serverless: every
// member hosts an onion for the room and Rust keeps a link to every other member
// (see chatTransport.ts). This module tells Rust whose onions those are —
// learned from the encrypted presence messages and kept per room, so a reopened
// room finds its members again. Someone new gets in only by redeeming an
// invitation.
//
// The MLS envelope state machine below (key_package → welcome/commit → app) is
// transport-agnostic JSON; all crypto is delegated to the Rotor-backed `mls_*`
// Tauri commands via crypto.ts — never reimplemented here.

import { ref, computed, watch } from "vue";
import { chatTransport as defaultTransport, type ChatTransport, type WsStatus } from "./chatTransport";
import { cryptoService, cryptoService as defaultCrypto, bytesToBase64, base64ToBytes } from "./crypto";
import { getRuntimeConfig, type AppRuntimeConfig } from "./services/appStorage";
import { t } from "./i18n/chatText";
import type { Participant, Room } from "./services/types";
import { kvDelete, kvGet, kvPut, type KvBackend } from "./services/localDb";
import { isMapShareType, sameUser, userPartOf, type MapShareType, type PersistedMessage } from "./chatHistoryModel";
import { createLogAppender, loadLog, wipeLog } from "./services/chatLog";
import { getChatHistoryCapMsgs, getConnectTimeoutSecs } from "./services/appStorage";
import { nanoid } from "nanoid";
import {
  catchUp as mailboxCatchUp, envelope as mailboxEnvelope, freshPlace, frameId, note as mailboxNote,
  INLINE_MAX, mentionsName, tagsOf, type ChatMailbox, type MailboxPlace,
} from "./mailbox";

/** A room this device belongs to. */
export interface P2pRoomEntry {
  room: string;
  name: string;
  /** The other members' onions for this room, as last learned: what a reopen
   *  links to. */
  peers?: string[];
  /** True when WE created this room. */
  host?: boolean;
  /** Our own onion for this room (stable across restarts). */
  onion?: string;
  /** The room's Beacon onion, if it has one (8.C): frames also go to its mailbox. */
  beacon?: string;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function firstTagByte(ticket: string): number {
  const s = ticket.trim().toLowerCase();
  if (s.length < 2) return -1;
  const a = B32.indexOf(s[0]);
  const b = B32.indexOf(s[1]);
  if (a < 0 || b < 0) return -1;
  return ((a << 3) | (b >> 2)) & 0xff;
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
    // A small file carried inline (option `inlineFiles`; Demio's `file_inline`).
    | "file_message"
    // A map share from the Map tab that is gone: kept as a card that says it
    // cannot be shown (see chatHistoryModel's MAP_SHARE_TYPES).
    | MapShareType
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
  // ── with the `threads` option (Teutates) ──
  /** The sender's device identity. */
  deviceId?: string;
  /** Its `#tags` (community and event threads). */
  tags?: string[];
  /** It mentions this member (`@name`). */
  mention?: boolean;
  /** It came through the server's mailbox (option `mailbox`), sent while this device was away. */
  viaMailbox?: boolean;
  /** A file it carries inline (option `inlineFiles`): name, size, bytes in base64. */
  file?: { name: string; size: number; data: string };
}

/** The MLS service the engine calls (default: the Rotor-backed `mls_*` commands). */
export type ChatCrypto = Pick<
  typeof cryptoService,
  | "initSession" | "keyPackage" | "addMember" | "adoptSession" | "joinFromWelcome"
  | "processMessage" | "encrypt" | "clearState" | "members" | "removeMember"
>;

/** The byte length of base64 text. */
function b64Size(s: string): number {
  return Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
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

  // ── Shared-engine options (technology.md §"Shared room engine"). Teutates turns them on;
  // Enigma leaves them off, so its rooms behave as before. ──
  /** The transport (default: the Rust gateway through Tauri, `chatTransport`). */
  transport?: ChatTransport;
  /** The MLS service (default: `cryptoService`). */
  crypto?: ChatCrypto;
  /** Admit key packages off the topic when `admissionCheck` passes them — a certified roster
   *  instead of invitation-only. The lowest member that is live adds; the others stay quiet. */
  openAdmission?: boolean;
  /** Keep the MLS group across restarts: a member back in a room reads on at once, and what
   *  the mailbox kept for it can still be opened. */
  keepSession?: boolean;
  /** Whether this device may open the group alone when nobody answers (default: yes). */
  mayFound?: () => boolean;
  /** Offline delivery through a server's room mailbox (`mailbox.ts`, Demio's format). */
  mailbox?: ChatMailbox;
  /** The Beacon a room created here uses (8.C2); none → the room is pure mesh. */
  beaconForNewRoom?: () => string | undefined;
  /** `#tags`, `@mentions` and the sender's device on messages. */
  threads?: boolean;
  /** Small files (≤ 256 KiB) inline in a sealed message (`sendFile`, Demio's `file_inline`). */
  inlineFiles?: boolean;
  /** Say who joined and left on every commit, and notice our own removal (re-key on leave). */
  rosterNotices?: boolean;
  /** Where the mailbox's place and "let in" are kept (default: the kv store, `localDb.ts`). */
  storage?: KvBackend;
}

export function useChatChannel(options: ChatChannelOptions = {}) {
  const headless = !!options.headless;
  const chatTransport: ChatTransport = options.transport ?? defaultTransport;
  const cryptoService: ChatCrypto = options.crypto ?? defaultCrypto;
  const mailbox = options.mailbox ?? null;
  const store: KvBackend = options.storage ?? { get: kvGet, put: kvPut, delete: kvDelete };
  /** We were removed from the room's group (option `rosterNotices`). */
  const removed = ref(false);
  /** Names devices signed their messages with (option `rosterNotices`). */
  const namesSeen = new Map<string, string>();
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
  /** Bumped on every room entry and teardown, so an async step that outlives
   *  the room it started in (startMls) can tell and stop. */
  let entryGen = 0;
  let admissionTimer: ReturnType<typeof setTimeout> | null = null;
  function clearCreatorTimer() {
    if (creatorTimer) { clearTimeout(creatorTimer); creatorTimer = null; }
    if (admissionTimer) { clearTimeout(admissionTimer); admissionTimer = null; }
  }

  const isParticipant = ref(false);
  const p2pRooms = ref<P2pRoomEntry[]>([]);

  // ── the mesh ─────────────────────────────────────────────────────────────────
  // Our onion for the current room, announced in presence; and a debounce so a
  // burst of presence messages becomes one `setPeers`.
  const myOnion = ref("");
  /** Onions of the members linked to this device right now (current room). */
  const linkedOnions = ref<string[]>([]);
  let peersTimer: ReturnType<typeof setTimeout> | null = null;
  const PEERS_DEBOUNCE_MS = 1000;

  const isConnected = computed(() => wsStatus.value === "connected");
  const isEncrypted = computed(() => mlsStatus.value === "ready");

  // ── transport helpers (room-scoped) ──────────────────────────────────────────
  function send(payload: Record<string, unknown>) {
    const slug = currentRoom.value?.slug;
    if (!slug) return;
    if (mailbox && typeof payload.ts !== "number") payload.ts = Date.now();
    chatTransport.send(slug, payload);
    if (mailbox) mailboxOut(slug, JSON.stringify(payload));
  }
  function teardown() {
    entryGen++; // a startMls still in flight belongs to the room being left
    const slug = currentRoom.value?.slug;
    void logAppender.flushNow(); // don't lose buffered log entries on switch
    stopRoomTimers();
    if (slug) chatTransport.leaveRoom(slug);
  }

  // ── Server mailbox (option `mailbox`): every frame that matters also goes to the room's
  // mailbox; what came while away is fed in on entry and every `everyMs`. ─────────────────
  let place: MailboxPlace = freshPlace();
  let placeRoom = "";
  let unsent: Record<string, unknown>[] = [];
  let mailboxTimer: ReturnType<typeof setTimeout> | null = null;
  let kpTimer: ReturnType<typeof setInterval> | null = null;
  let catching: Promise<void> | null = null;
  function stopRoomTimers() {
    if (mailboxTimer) { clearTimeout(mailboxTimer); mailboxTimer = null; }
    if (kpTimer) { clearInterval(kpTimer); kpTimer = null; }
  }
  async function loadPlace(slug: string) {
    if (placeRoom === slug) return;
    placeRoom = slug;
    place = freshPlace();
    unsent = [];
    try {
      const raw = await store.get("chat:mailbox", slug, "place");
      if (raw) place = { ...freshPlace(), ...(JSON.parse(raw) as MailboxPlace) };
      const q = await store.get("chat:mailbox", slug, "unsent");
      if (q) unsent = JSON.parse(q);
    } catch { /* a fresh place */ }
  }
  function savePlace(slug: string) {
    if (placeRoom !== slug) return;
    void store.put("chat:mailbox", slug, "place", JSON.stringify(place)).catch(() => {});
    void store.put("chat:mailbox", slug, "unsent", JSON.stringify(unsent)).catch(() => {});
  }
  async function flushUnsent(slug: string) {
    if (!mailbox) return;
    while (unsent.length) {
      try { await mailbox.post(unsent[0]); } catch { break; } // the server does not answer: later
      unsent.shift();
    }
    savePlace(slug);
  }
  function mailboxOut(slug: string, frame: string) {
    const env = mailboxEnvelope(slug, frame);
    if (!env || placeRoom !== slug) return;
    mailboxNote(place, frame);
    unsent.push(env);
    void flushUnsent(slug);
  }
  /** Feeds in what the mailbox holds that this device has not seen (and dials the
   *  endpoints other devices posted). No-op without the `mailbox` option. */
  async function catchUpMailbox(): Promise<void> {
    if (!mailbox || !currentRoom.value) return;
    if (catching) return catching;
    const slug = currentRoom.value.slug;
    catching = (async () => {
      await loadPlace(slug);
      let got: { frames: string[]; nodes: string[] };
      try {
        got = await mailboxCatchUp(place, mailbox, slug);
      } catch {
        return; // the server does not answer: next time
      }
      savePlace(slug);
      for (const f of got.frames) {
        if (currentRoom.value?.slug !== slug) break;
        let data: Record<string, unknown>;
        try { data = JSON.parse(f); } catch { continue; }
        await handleMessage(data, true);
      }
      await flushUnsent(slug);
    })().finally(() => { catching = null; });
    return catching;
  }
  async function startMailbox(slug: string) {
    if (!mailbox) return;
    await loadPlace(slug);
    if (mailboxTimer) clearTimeout(mailboxTimer);
    // Exponential (Poisson) gaps around `everyMs`, not a fixed tick, so when this
    // device reads its mailbox says little about when anything happened (8.D2).
    const every = mailbox.everyMs ?? 30_000;
    const next = () => {
      const gap = Math.min(4 * every, Math.max(every / 6, -Math.log(1 - Math.random()) * every));
      mailboxTimer = setTimeout(() => { void catchUpMailbox(); next(); }, gap);
    };
    next();
  }

  // ── Kept sessions (option `keepSession`): a room this device was let into stays open. ──
  async function isAdmitted(slug: string): Promise<boolean> {
    return (await store.get("chat:admitted", slug, "v").catch(() => null)) === "1";
  }
  function markAdmitted(on: boolean) {
    const slug = currentRoom.value?.slug;
    if (!slug) return;
    void (on ? store.put("chat:admitted", slug, "v", "1") : store.delete("chat:admitted", slug, "v")).catch(() => {});
  }
  watch(mlsStatus, (st) => { if (st === "ready") { removed.value = false; markAdmitted(true); } });

  /** The lowest member that is live (us, or someone whose presence came over the network) —
   *  who adds and removes with `openAdmission` / `enforceRoster`. */
  function liveLeader(ids: string[]): string | undefined {
    return ids.filter((id) => id === mlsIdentity.value || presenceById.has(id)).sort()[0];
  }

  /** Fields the `threads` option adds to a message. */
  function threadFields(text: string, deviceId: string | undefined, self: boolean, viaMailbox = false) {
    if (!options.threads) return {};
    return {
      deviceId,
      tags: tagsOf(text),
      mention: !self && mentionsName(text, currentUserName.value),
      ...(viaMailbox ? { viaMailbox: true } : {}),
    };
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
    if (msg.file) pm.file = msg.file;
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
      ...(pm.file ? { file: pm.file } : {}),
      ...threadFields(pm.content, pm.deviceId, self),
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

  // ── roster (authenticated from MLS membership) ───────────────────────────────
  // `onion` is the member's onion for this room, learned from its presence.
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
  // routed here: map shares were human content rendered as timeline cards
  // (handled inline after the mute check), not control traffic. Adding the
  // prefix "for consistency" would make this gate `return` before the mute
  // check and swallow every card — no handler owns `map_`, so nothing would
  // ever render. (The routing tests that pinned this lived in
  // multiDeviceChannel.test.ts, deleted with device linking in enigma's
  // `f0c8126 Park device linking and file sync to limbo`; the parked copies are
  // in enigma's limbo/frontend/devices.)
  type SyncHandler = (type: string, payload: Record<string, unknown>, sender: string) => void;
  const syncHandlers = new Set<SyncHandler>();
  function onSync(fn: SyncHandler): () => void {
    syncHandlers.add(fn);
    return () => { syncHandlers.delete(fn); };
  }

  /** Tell Rust whose onions to keep links to: every member we learned one for,
   *  plus the ones saved with the room (members whose presence has not arrived
   *  yet after a reopen). Saved, so the next reopen starts from it. */
  function schedulePeers() {
    const slug = currentRoom.value?.slug;
    if (!slug) return;
    if (peersTimer) clearTimeout(peersTimer);
    peersTimer = setTimeout(() => {
      peersTimer = null;
      if (currentRoom.value?.slug !== slug) return;
      const saved = p2pRooms.value.find((r) => r.room === slug)?.peers ?? [];
      const live = [...presenceById.values()].map((i) => i.onion).filter(Boolean);
      const peers = [...new Set([...saved, ...live])].filter((o) => o !== myOnion.value);
      chatTransport.setPeers(slug, peers);
      updateRoomEntry({ peers });
    }, PEERS_DEBOUNCE_MS);
  }

  async function refreshP2pRoster() {
    if (!currentRoom.value) return;
    const ids = await cryptoService.members(currentRoom.value.slug, mlsIdentity.value);
    const source = ids.length ? ids : [mlsIdentity.value];
    // One roster row per USER: linked-device leaves ("alice", "alice#dev-x")
    // group together; the row keeps every leaf id.
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
            const linked = leafIds.some((id) => {
              const onion = presenceById.get(id)?.onion;
              return !!onion && linkedOnions.value.includes(onion);
            });
            return { id: rep, name: info?.name || user, avatar_url: info?.avatar || "", type: "human" as const, linked };
          })();
      if (leafIds.length > 1) {
        p.leafIds = [...leafIds];
        p.deviceCount = leafIds.length;
      }
      return p;
    });

    schedulePeers();
    participants.value = list;
    currentRoom.value = { ...currentRoom.value, participant_count: list.length };
  }

  function roomBeacon(): string | undefined {
    const slug = currentRoom.value?.slug;
    return slug ? p2pRooms.value.find((r) => r.room === slug)?.beacon : undefined;
  }
  /** A member told us the room's Beacon: the first one heard is kept (8.C1). */
  function learnBeacon(onion: unknown) {
    const slug = currentRoom.value?.slug;
    if (!slug || typeof onion !== "string" || !/^[a-z2-7]{56}\.onion$/.test(onion) || roomBeacon()) return;
    const entry = p2pRooms.value.find((r) => r.room === slug);
    if (entry) rememberP2pRoom({ ...entry, beacon: onion });
  }

  async function announcePresence(reply = false) {
    if (mlsStatus.value !== "ready") return;
    await sendEncryptedMedia("presence", {
      device_id: mlsIdentity.value, name: displayName(),
      avatar: myAvatar.value,
      onion: myOnion.value, // where the others link to us
      // The room's Beacon, inside the encryption, so every member uses it (8.C1).
      ...(roomBeacon() ? { beacon: roomBeacon() } : {}),
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
    const onion = presenceById.get(deviceId)?.onion;
    presenceById.delete(deviceId);
    if (!currentRoom.value) return;
    // Stop linking to someone who left.
    const entry = p2pRooms.value.find((r) => r.room === currentRoom.value?.slug);
    if (onion && entry?.peers?.includes(onion)) {
      entry.peers = entry.peers.filter((o) => o !== onion);
      persistP2pRooms();
    }
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

  // ── saved room entry ────────────────────────────────────────────────────────

  /** Merge a patch into the current room's saved entry (no-op when the room
   *  was never saved). */
  function updateRoomEntry(patch: Partial<P2pRoomEntry>) {
    const slug = currentRoom.value?.slug;
    if (slug) updateEntry(slug, patch);
  }

  function updateEntry(slug: string, patch: Partial<P2pRoomEntry>) {
    const entry = p2pRooms.value.find((r) => r.room === slug);
    if (!entry) return;
    Object.assign(entry, patch);
    persistP2pRooms();
  }

  function nameFor(id: string): string {
    if (userPartOf(id) === userPartOf(mlsIdentity.value)) return displayName();
    const direct = presenceById.get(id)?.name;
    if (direct) return direct;
    // A user-part key: any of its leaves' presence.
    for (const [leaf, info] of presenceById) {
      if (userPartOf(leaf) === id && info.name) return info.name;
    }
    // With `rosterNotices`: a name the device signed its messages with (someone who left is
    // often away, with no fresh presence).
    if (options.rosterNotices) return namesSeen.get(id) ?? namesSeen.get(userPartOf(id)) ?? userPartOf(id);
    return id;
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
  chatTransport.onStatus((room, status, peerId, linked) => {
    // A member's onion whose link just came up is how we find them next time,
    // for any saved room, not only the one on screen.
    if (peerId && status === "connected") rememberPeerForRoom(room, peerId);
    if (room !== currentRoom.value?.slug) return;
    const before = wsStatus.value;
    log("status →", status);
    wsStatus.value = status;
    linkedOnions.value = linked ?? [];
    void refreshP2pRoster();
    if (status === before) return;
    if (status === "connected") {
      messages.value.push(sysMsg("chat.sys.connected", "Connected to {room}.", { room: currentRoom.value?.name ?? "room" }));
      void catchUpMailbox();
    } else if (status === "disconnected" && before === "connected") {
      messages.value.push(sysMsg("chat.sys.disconnected", "Disconnected."));
    } else if (status === "error") {
      messages.value.push(sysMsg("chat.sys.connectionError", "Connection error.", undefined, "system_error"));
    }
  });

  chatTransport.onMessage((room, data) => {
    if (room !== currentRoom.value?.slug) return;
    if (mailbox) {
      // Fed in from the mailbox already (or ours): not again.
      const f = JSON.stringify(data);
      if (frameId(f) && placeRoom === room && !mailboxNote(place, f)) return;
    }
    void handleMessage(data as Record<string, unknown>);
  });

  async function handleMessage(data: Record<string, unknown>, viaMailbox = false) {
    const type = data.type as string;
    log("←", type);
    // The same frame comes by the mesh and by Beacon: whichever is second is dropped
    // (8.B4). Our own frames were noted when sent, so they are dropped too.
    if (mailbox && currentRoom.value && placeRoom === currentRoom.value.slug && !viaMailbox) mailboxNote(place, JSON.stringify(data));

    // Nothing in the clear is shown: a frame anyone with a member's onion could
    // send would otherwise read like a chat message.
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
      // Nobody gets in off the topic. Ever.
      //
      // This is the only mode, which is why there is nothing to read. A redeemed invitation is the sole way
      // into a room, and it never rides gossip at all — `admitInvited` calls
      // `cryptoService.addMember` directly — so this closes the door without
      // touching the one path that is supposed to open it.
      //
      // Placed ABOVE the admin split below on purpose: a guard placed after it
      // would close the branch that ADDS while leaving the branch that DEFERS
      // still answering a stranger with our own key package — a half-closed door.
      //
      // Headless channels (devlink, peer sync) carry their own `admissionCheck`
      // and have no room meta of their own, so they are exempt.
      if (!options.headless && !options.openAdmission) return;
      if (options.openAdmission && currentRoom.value && deviceId && deviceId !== mlsIdentity.value) {
        // A certified roster: the live leader adds; nobody defers with a counter key package.
        if (mlsStatus.value === "ready") {
          if (pendingInvites.has(deviceId)) return;
          const room = currentRoom.value.slug;
          const ids = await cryptoService.members(room, mlsIdentity.value);
          if (liveLeader(ids.filter((id) => id !== deviceId)) !== mlsIdentity.value) return;
          pendingInvites.add(deviceId);
          // A device that lost its group (a new install) comes back: its old leaf goes first.
          if (ids.includes(deviceId)) {
            const c = await cryptoService.removeMember(room, mlsIdentity.value, deviceId);
            if (c) send({ type: "mls_commit", commit: bytesToBase64(c), msg_id: nanoid() });
          }
          const result = await cryptoService.addMember(room, mlsIdentity.value, base64ToBytes(rawKp));
          if (!result) { pendingInvites.delete(deviceId); return; }
          send({ type: "mls_commit", commit: bytesToBase64(result.commit), msg_id: nanoid() });
          send({ type: "mls_welcome", welcome: bytesToBase64(result.welcome), target: deviceId, target_channel: deviceId });
          messages.value.push(sysMsg("chat.sys.joinedRoom", "{who} joined the room.", { who: (data.user as string) || nameFor(deviceId) }));
          void refreshP2pRoster();
          return;
        }
        // Two newcomers and no group yet: only one that may open the group adds.
        if (options.mayFound && !options.mayFound()) return;
      }
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
      if (options.openAdmission && typeof data.target === "string" && data.target !== mlsIdentity.value) return;
      if (options.openAdmission && mlsStatus.value === "key_exchange" && currentRoom.value) {
        // Ours if it opens with one of our key packages; else someone else's (or old): wait on.
        const ok = await cryptoService.joinFromWelcome(currentRoom.value.slug, mlsIdentity.value, base64ToBytes(data.welcome as string));
        if (ok) {
          clearCreatorTimer();
          mlsStatus.value = "ready";
          messages.value.push(sysMsg("chat.sys.encrypted", "🔒 End-to-end encryption active."));
          void catchUpMailbox();
        }
        return;
      }
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
        const room = currentRoom.value.slug;
        try {
          const before = options.rosterNotices ? await cryptoService.members(room, mlsIdentity.value) : [];
          await cryptoService.processMessage(room, mlsIdentity.value, base64ToBytes(data.commit as string));
          if (options.rosterNotices) rosterChanged(before, await cryptoService.members(room, mlsIdentity.value));
          void refreshP2pRoster();
        } catch (e) {
          // From the mailbox: an epoch seen already, or from before we were let in.
          if (viaMailbox || options.openAdmission) return;
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
      // Sealed sender: the frame's outside says nothing about who sent it; who
      // (device id and name) and the message id are read after decryption.
      // Somebody else is talking in here. Noted even when we cannot read it —
      // especially then, because being unable to read it is the whole point.
      if (!viaMailbox) sawForeignTraffic = true;
      if (mlsStatus.value === "ready" && currentRoom.value) {
        let plaintext: Uint8Array | null = null;
        try {
          plaintext = await cryptoService.processMessage(currentRoom.value.slug, mlsIdentity.value, base64ToBytes(data.ciphertext as string));
        } catch (e) {
          if (viaMailbox) return; // from before this device joined, or read already
          if (isGroupMismatch(e)) { await requestFreshMlsInvite(errorMessage(e)); }
          else {
            mlsStatus.value = "error"; mlsError.value = errorMessage(e);
            messages.value.push(sysMsg("chat.sys.decryptFailedWhy", "Could not decrypt incoming message: {why}", { why: errorMessage(e) }, "system_error"));
          }
          return;
        }
        if (plaintext) {
          const raw = new TextDecoder().decode(plaintext);
          let inner: Record<string, unknown> | null = null;
          try { inner = JSON.parse(raw); } catch (_) {}
          const from = (inner?.from ?? {}) as { id?: unknown; name?: unknown };
          const senderLeafId = typeof from.id === "string" && from.id ? from.id : undefined;
          if (senderLeafId === mlsIdentity.value) return; // our own, come back
          const senderName = (typeof from.name === "string" && from.name) || senderLeafId || "Unknown";
          if (options.rosterNotices && senderLeafId && typeof from.name === "string" && from.name) {
            namesSeen.set(senderLeafId, from.name);
            namesSeen.set(userPartOf(senderLeafId), from.name);
          }
          const avatarUrl = participantForName(senderName)?.avatar_url ?? null;
          // "Self" spans the whole user: a message from our OTHER linked device
          // renders as ours (right-aligned, no unread bump).
          const isSelf = !!senderLeafId && sameUser(senderLeafId, mlsIdentity.value);
          // A text message is {type:"text", text}; anything that is not JSON is
          // shown as it is.
          const text = inner?.type === "text" && typeof inner.text === "string" ? inner.text : raw;
          // The sender-minted id (inside the encryption): the dedupe key.
          const rxId = (typeof inner?.msg_id === "string" && inner.msg_id) || nanoid();

          if (inner?.type === "presence" && inner.device_id) {
            // An old "I am here" from the mailbox says nothing about now; a fresh one does
            // (the mailbox copy can beat the live one, which is then not seen again).
            if (viaMailbox && !(typeof data.ts === "number" && Date.now() - data.ts < 120_000)) return;
            const id = inner.device_id as string;
            if (id !== mlsIdentity.value) {
              presenceById.set(id, {
                name: (inner.name as string) || id,
                avatar: (inner.avatar as string) || "",
                onion: (inner.onion as string) || "",
              });
              learnBeacon(inner.beacon);
              void refreshP2pRoster();
              if (!inner.reply) void announcePresence(true);
            }
            return;
          }
          if (inner?.type === "leave" && inner.device_id && !viaMailbox) {
            void handlePeerLeave(inner.device_id as string);
            return;
          }
          if (inner?.type === "room_closed") {
            void handleRoomClosed();
            return;
          }
          const sentAt = typeof data.ts === "number" && data.ts > 0 && data.ts <= Date.now() + 60_000 ? new Date(data.ts) : new Date();
          if (options.inlineFiles && inner?.type === "file_inline") {
            const target = typeof inner.target === "string" ? inner.target : "";
            if ((target && target !== mlsIdentity.value) || typeof inner.data !== "string") return;
            const caption = typeof inner.caption === "string" ? inner.caption : "";
            const fid = (typeof inner.msg_id === "string" && inner.msg_id) || (typeof inner.offerId === "string" && inner.offerId) || rxId;
            const file = { name: typeof inner.name === "string" ? inner.name : "file", size: b64Size(inner.data), data: inner.data };
            pushMessage({ id: fid, type: "file_message", user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: caption, file, participant_type: "human", self: isSelf, encrypted: true, timestamp: sentAt, ...threadFields(caption, senderLeafId, isSelf, viaMailbox) }, senderLeafId);
            return;
          }
          // Room meta and moderation frames from an older build: nothing here acts on
          // them any more, and they must not render as a chat bubble.
          if (inner?.type === "room_meta" || (typeof inner?.type === "string" && inner.type.startsWith("mod_"))) return;
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
          if (inner?.type === "image_message" && inner.image_data) {
            pushMessage({ id: rxId, type: "image_message", user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: "", image_data: inner.image_data as string, participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date() }, senderLeafId);
          } else if (inner?.type === "voice_message" && inner.audio_data) {
            pushMessage({ id: rxId, type: "voice_message", user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: "", audio_data: inner.audio_data as string, participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date() }, senderLeafId);
          } else if (typeof inner?.type === "string" && inner.type.startsWith("map_")) {
            // A map share from a peer on a build that still has the Map tab.
            // This one has no maps, so the payload is not read; a known kind
            // becomes a card saying it cannot be shown, and anything else
            // `map_*` is dropped — never rendered as a raw-JSON bubble.
            // Deliberately NOT a sync family: it is human content, so it sits
            // after the mute check above, and must not be given a prefix in
            // the routing gate (see that comment).
            if (isMapShareType(inner.type)) {
              pushMessage({ id: rxId, type: inner.type, user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: "", participant_type: "human", self: isSelf, encrypted: true, timestamp: new Date() }, senderLeafId);
            }
          } else {
            pushMessage({ id: rxId, type: "mls_app", user: senderName, initials: initials(senderName), avatar_url: avatarUrl, content: text, participant_type: "human", self: isSelf, encrypted: true, timestamp: mailbox ? sentAt : new Date(), ...threadFields(text, senderLeafId, isSelf, viaMailbox) }, senderLeafId);
          }
        } else {
          messages.value.push(sysMsg("chat.sys.decryptFailed", "⚠ Could not decrypt an incoming message.", undefined, "system_error"));
        }
      } else if (!viaMailbox) {
        // Transient "arrived before MLS was ready" placeholder — pushed straight
        // to the live view, NOT through pushMessage, so it is never persisted to
        // chat:log (and never replayed to a linked device or restored on reload).
        messages.value.push({
          id: nanoid(), type: "mls_app", user: "…", initials: "…",
          avatar_url: null,
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
  /** Start the room's encryption. A room this device was let into comes back as
   *  it was. Otherwise a fresh session sends its key package; `alone` (we just
   *  created the room) makes it a group of one at once instead of after a wait. */
  async function startMls(opts: { alone?: boolean } = {}) {
    if (!currentRoom.value || !mlsIdentity.value) return;
    if (mlsStatus.value !== "idle" && mlsStatus.value !== "error") return;
    const room = currentRoom.value.slug;
    const identity = mlsIdentity.value;
    const gen = entryGen;
    // Left (or switched rooms) while awaiting: whatever we were doing is not
    // this room's any more — never send its key package into another room.
    const stale = () => gen !== entryGen;
    mlsStatus.value = "initializing";
    mlsError.value = null;
    pendingInvites.clear();
    try {
      // The group this device was let into comes back: no new handshake. (A
      // fresh session for every reopen would make a new group of one each time,
      // cut off from the members who stayed in the old one.)
      const restored = await cryptoService.initSession(room, identity);
      const admitted = restored && (await isAdmitted(room));
      if (stale()) return;
      if (admitted) {
        mlsStatus.value = "ready";
        messages.value.push(sysMsg("chat.sys.encrypted", "🔒 End-to-end encryption active."));
        await catchUpMailbox();
        return;
      }
      const kp = await cryptoService.keyPackage(room, identity);
      if (kp) {
        const b64 = bytesToBase64(kp);
        const extra = await kpEnvelopeExtra(b64);
        if (stale()) return;
        send({ type: "mls_key_package", key_package: b64, package: b64, device_id: identity, user: currentUserName.value, ...extra });
        // A room we just created is encrypted a moment later; saying "setting up"
        // first would only be noise.
        if (!opts.alone) messages.value.push(sysMsg("chat.sys.settingUp", "🔑 Setting up encryption…"));
        mlsStatus.value = "key_exchange";
        if (options.openAdmission) startKpRetry();
        void catchUpMailbox();
        clearCreatorTimer();
        creatorTimer = setTimeout(() => {
          creatorTimer = null;
          if (stale() || mlsStatus.value !== "key_exchange") return;
          if (options.mayFound && !options.mayFound()) { armAdmissionTimeout(); return; }
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
        }, opts.alone ? 0 : 5000);
      }
    } catch (e) {
      if (stale()) return;
      mlsStatus.value = "error";
      mlsError.value = (e as Error).message;
      messages.value.push(sysMsg("chat.sys.initFailed", "Encryption init failed: {why}", { why: (e as Error).message }, "system_error"));
    }
  }

  /** With `openAdmission`: ask again every 20 s until someone lets us in (the leader may be
   *  away; the key package also waits in the mailbox). */
  function startKpRetry() {
    if (kpTimer) clearInterval(kpTimer);
    kpTimer = setInterval(async () => {
      if (mlsStatus.value !== "key_exchange" || !currentRoom.value) {
        if (kpTimer) { clearInterval(kpTimer); kpTimer = null; }
        return;
      }
      const room = currentRoom.value.slug;
      const kp = await cryptoService.keyPackage(room, mlsIdentity.value).catch(() => null);
      if (!kp) return;
      const b64 = bytesToBase64(kp);
      send({ type: "mls_key_package", key_package: b64, package: b64, device_id: mlsIdentity.value, user: currentUserName.value, ...(await kpEnvelopeExtra(b64)) });
    }, 20_000);
  }

  /** Option `rosterNotices`: say who joined and left with a commit, and whether it was us. */
  function rosterChanged(before: string[], after: string[]) {
    if (before.length && !after.includes(mlsIdentity.value)) {
      removed.value = true;
      mlsStatus.value = "idle";
      markAdmitted(false);
      messages.value.push(sysMsg("chat.sys.youRemoved", "You were removed from the room: you no longer read it."));
      return;
    }
    const usersAfter = new Set(after.map(userPartOf));
    for (const id of before.filter((x) => !after.includes(x))) {
      if (usersAfter.has(userPartOf(id))) continue;
      messages.value.push(sysMsg("chat.sys.rekeyed", "{who} left: the room's keys were changed.", { who: nameFor(id) }));
    }
    for (const id of after.filter((x) => !before.includes(x))) {
      pendingInvites.delete(id);
      messages.value.push(sysMsg("chat.sys.joinedRoom", "{who} joined the room.", { who: nameFor(id) }));
    }
  }

  /**
   * Re-key on leave: keep only the members whose user is in `users` (the certified roster).
   * The live leader removes every device of anyone else — the room's keys change, and the one
   * who left cannot read on. Answers how many devices were removed.
   */
  async function enforceRoster(users: string[]): Promise<number> {
    if (!currentRoom.value || mlsStatus.value !== "ready" || !users.length) return 0;
    const room = currentRoom.value.slug;
    const ids = await cryptoService.members(room, mlsIdentity.value).catch(() => [] as string[]);
    const allowed = new Set(users);
    const keep = ids.filter((id) => allowed.has(userPartOf(id)));
    if (liveLeader(keep) !== mlsIdentity.value) return 0;
    let n = 0;
    for (const id of ids.filter((x) => !allowed.has(userPartOf(x)))) {
      const commit = await cryptoService.removeMember(room, mlsIdentity.value, id).catch(() => null);
      if (!commit) continue;
      send({ type: "mls_commit", commit: bytesToBase64(commit), msg_id: nanoid() });
      presenceById.delete(id);
      messages.value.push(sysMsg("chat.sys.rekeyed", "{who} left: the room's keys were changed.", { who: nameFor(id) }));
      n++;
    }
    if (n) void refreshP2pRoster();
    return n;
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

  // ── saved rooms ─────────────────────────────────────────────────────────────
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

  /** Record a member's onion in a room's saved list (what a reopen links to). */
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

  /** Make a room current. `onion` is ours for it; `alone` says we just created
   *  it. Encryption starts right away: it does not wait for anyone to be linked. */
  function enterP2pRoom(room: string, name: string, onion: string, opts: { alone?: boolean } = {}) {
    enterRoomView(room, name, onion);
    void startMls(opts);
  }

  /** Make a room current without starting its encryption. */
  function enterRoomView(room: string, name: string, onion: string) {
    entryGen++;
    presenceById.clear();
    if (peersTimer) { clearTimeout(peersTimer); peersTimer = null; }
    myOnion.value = onion;
    linkedOnions.value = [];
    currentRoom.value = makeP2pRoom(room, name);
    participants.value = [selfParticipant()];
    isParticipant.value = true;
    mlsStatus.value = "idle";
    mlsError.value = null;
    pendingInvites.clear();
    wsStatus.value = chatTransport.lastStatus(room) ?? "waiting";
    // The stored timeline (chat:log) comes back so a reopened room isn't blank.
    if (!headless) void restoreTimeline(room);
    if (mailbox) void startMailbox(room);
  }

  /**
   * Create a room and enter it. Returns its slug, or null on failure.
   *
   * Creating a room yields no shareable credential: letting anyone else in is a
   * separate, deliberate act of minting an invitation.
   */
  async function createRoom(name: string): Promise<string | null> {
    error.value = null;
    teardown();
    clearMessages();
    try {
      const res = await chatTransport.createRoom(name.trim());
      rememberP2pRoom({ room: res.room, name: res.name, host: true, onion: res.onion, ...(options.beaconForNewRoom?.() ? { beacon: options.beaconForNewRoom!() } : {}) });
      enterP2pRoom(res.room, res.name, res.onion, { alone: true });
      void refreshP2pRoster();
      messages.value.push(
        sysMsg("chat.sys.created", "Created “{name}”. Invite someone to let them in.", {
          name: res.name,
        }),
      );
      return res.room;
    } catch (e) {
      error.value = errorMessage(e);
      return null;
    }
  }


  // Abort an in-flight join (the join modal's "Cancel" button). Clears any error
  // the aborted join left behind.
  async function cancelJoin() {
    chatTransport.cancelJoin();
    error.value = null;
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
  ): Promise<{ welcome: string; roomName: string; peers: string[] } | null> {
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

      // Where the newcomer links to: every member's onion we know, ours first.
      // Every member necessarily has these; they are not a credential. Nothing
      // here re-admits anybody: the group is closed again once this commit lands.
      const others = [...presenceById.values()].map((i) => i.onion).filter(Boolean);
      const peers = [...new Set([myOnion.value, ...others])].filter(Boolean);
      return {
        welcome: bytesToBase64(result.welcome),
        roomName: currentRoom.value.name,
        peers,
      };
    } catch {
      return null;
    }
  }

  /**
   * The redeemer's half: join the group from the Welcome the inviter granted,
   * then open the room and link to its members.
   *
   * The negotiation already happened over the authenticated redemption stream,
   * so the group membership is settled before the first frame.
   */
  async function joinByInvite(
    grant: { roomName: string; welcome: string; peers: string[] },
    /** The scratch room key the redeemer's KeyPackage was built under. It has to
     *  move onto the real room before the Welcome can be processed there — that
     *  session is the one holding the KeyPackage's private init key. */
    scratchRoom: string,
  ): Promise<boolean> {
    error.value = null;
    try {
      teardown();
      clearMessages();
      const res = await chatTransport.joinRoom(grant.roomName.trim(), grant.peers);
      const slug = res.room;
      // Save the room first: membership must survive a restart, and the saved
      // member list is what a reopen links to.
      rememberP2pRoom({ room: slug, name: res.name, peers: grant.peers.filter((o) => o !== res.onion), onion: res.onion });
      // Enter without starting a fresh handshake: the Welcome below is our way in.
      enterRoomView(slug, res.name, res.onion);
      mlsStatus.value = "initializing";
      messages.value.push(sysMsg("chat.sys.joined", "Joined “{name}”. Connecting to the others…", { name: res.name }));
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
      schedulePeers();
      return true;
    } catch (e) {
      error.value = errorMessage(e);
      return false;
    }
  }

  /** This device's id, for a personal invitation (Settings, "My code"). */
  async function deviceId(): Promise<string | null> {
    return chatTransport.deviceId().catch(() => null);
  }

  /** Open a saved room: host our onion for it again (same address) and link to
   *  the members saved with it. */
  async function openP2pRoom(entry: P2pRoomEntry) {
    if (currentRoom.value?.slug === entry.room) return;
    error.value = null;
    teardown();
    clearMessages();
    try {
      const res = await chatTransport.joinRoom(entry.name, entry.peers ?? []);
      if (res.onion !== entry.onion) updateEntry(entry.room, { onion: res.onion });
      enterP2pRoom(entry.room, entry.name, res.onion);
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

  /** Delete a saved room. If we created it and it is open, broadcast
   *  `room_closed` so every member tears down + forgets it too; if we only joined,
   *  broadcast the ordinary `leave` (a remaining member removes us from MLS). Then
   *  wipe all local data for the room — MLS group state, the saved entry, the
   *  stored timeline and our onion for it — and close its links. */
  async function deleteRoom(entry: P2pRoomEntry): Promise<void> {
    const slug = entry.room;
    const identity = mlsIdentity.value;
    const isCurrent = currentRoom.value?.slug === slug;

    if (isCurrent && mlsStatus.value === "ready") {
      await sendEncryptedMedia(entry.host ? "room_closed" : "leave", { device_id: identity }).catch(() => {});
    }
    // Wipe local data (MLS state, saved entry, stored timeline).
    await cryptoService.clearState(slug, identity).catch(() => {});
    chatTransport.forgetOnion(entry.name); // stops the service + drops the key
    if (!headless) {
      logAppender.drop(slug);
      await wipeLog(slug).catch(() => {});
    }
    forgetP2pRoom(slug);
    // Close connections / reset the view.
    if (isCurrent) clearLocalChatState(t("chat.sys.roomDeleted", "Room deleted."));
    else chatTransport.leaveRoom(slug); // stop hosting/dialing a non-open room
  }

  /** A room's host broadcast `room_closed` — tear down + wipe it on our side, per the
   *  "fully wiped + notified" delete behaviour. Only fires for the room on screen (the
   *  transport delivers `room_closed` only for `currentRoom`). */
  async function handleRoomClosed() {
    if (!currentRoom.value) return;
    const slug = currentRoom.value.slug;
    const name = currentRoom.value.name;
    await cryptoService.clearState(slug, mlsIdentity.value).catch(() => {});
    chatTransport.forgetOnion(name);
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
    const from = { id: mlsIdentity.value, name: currentUserName.value };
    const inner = msgId ? { type: innerType, msg_id: msgId, from, ...payload } : { type: innerType, from, ...payload };
    const ct = await cryptoService.encrypt(currentRoom.value!.slug, mlsIdentity.value, JSON.stringify(inner));
    if (!ct) throw new Error("Encryption failed");
    // Sealed sender: only the ciphertext travels outside.
    send({ type: "mls_app", ciphertext: bytesToBase64(ct) });
  }

  /** Send a data-sync control/data message over this channel's MLS group. */
  async function sendSync(type: string, payload: Record<string, unknown>) {
    await sendEncryptedMedia(type, payload);
  }

  // Sending needs encryption, not a live link: Rust keeps a frame for every
  // member who is not linked yet and sends it when the link comes up.
  async function sendImage(file: File, onProgress?: (pct: number) => void) {
    if (!currentRoom.value || !isParticipant.value) return;
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

  async function sendAudio(audioBlob: Blob) {
    if (!currentRoom.value || !isParticipant.value) return;
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
    if (!text || !currentRoom.value) return;
    if (mlsStatus.value !== "ready") {
      // Never in the clear: nothing is sent before the room is encrypted.
      messages.value.push(sysMsg("chat.sys.notReady", "Encryption not ready yet — try again in a moment.", undefined, "system_error"));
      return;
    }
    {
      // Sealed sender: who sent it and its id travel inside the encryption.
      const msgId = nanoid();
      const sealed = JSON.stringify({ type: "text", text, msg_id: msgId, from: { id: mlsIdentity.value, name: currentUserName.value } });
      const ct = await cryptoService.encrypt(currentRoom.value.slug, mlsIdentity.value, sealed);
      if (ct) {
        send({ type: "mls_app", ciphertext: bytesToBase64(ct) });
        pushMessage({ id: msgId, type: "mls_app", user: currentUserName.value, initials: initials(currentUserName.value), avatar_url: myAvatarOrNull(), content: text, participant_type: "human", self: true, encrypted: true, timestamp: new Date(), ...threadFields(text, mlsIdentity.value, true) }, mlsIdentity.value);
      } else {
        messages.value.push(sysMsg("chat.sys.encryptFailed", "Encryption failed — message not sent.", undefined, "system_error"));
      }
    }
  }

  /** Option `inlineFiles`: a small file (≤ 256 KiB, base64) inline in a sealed message, with
   *  a caption (Demio's `file_inline`). Throws when it is too big or the room is not open. */
  async function sendFile(name: string, dataB64: string, caption = ""): Promise<void> {
    if (!options.inlineFiles || !currentRoom.value) return;
    const size = b64Size(dataB64);
    if (size > INLINE_MAX) throw new Error(t("chat.sys.fileTooBig", "Files up to 256 KiB go in the room."));
    if (mlsStatus.value !== "ready") throw new Error(t("chat.sys.notReady", "Encryption not ready yet — try again in a moment."));
    const msgId = nanoid();
    await sendEncryptedMedia("file_inline", { offerId: msgId, target: "", name, size, data: dataB64, fromName: currentUserName.value, caption }, msgId);
    pushMessage({ id: msgId, type: "file_message", user: currentUserName.value, initials: initials(currentUserName.value), avatar_url: myAvatarOrNull(), content: caption, file: { name, size, data: dataB64 }, participant_type: "human", self: true, encrypted: true, timestamp: new Date(), ...threadFields(caption, mlsIdentity.value, true) }, mlsIdentity.value);
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
    mlsStatus, mlsError, isEncrypted, myOnion, linkedOnions,
    isParticipant, currentUserName, mlsIdentity, myAvatar,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState,
    joinParticipant, leaveParticipant,
    sendMessage, sendImage, sendAudio, forceResetMls,
    p2pRooms, loadP2pRooms, createRoom, openP2pRoom,
    admitInvited, joinByInvite,
    cancelJoin, deleteRoom,
    deviceId,
    onSync, sendSync, postSystemNotice,
    // Shared-engine options (Teutates)
    removed, catchUpMailbox, enforceRoster, sendFile,
    mergeHistory, removeLeaf,
  };
}

export type ChatChannel = ReturnType<typeof useChatChannel>;
