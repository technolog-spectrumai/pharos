// Peer-link ongoing sync — the runtime half of person-to-person sync (the
// handshake is Rust: src-tauri/src/peer_link.rs). Owns ONE headless chat channel
// per live link, joined to that link's hidden room ("plink-…", derived Rust-side
// from the pairwise key), and converges only the granted scopes over `plink_*`
// inner messages through the stock MLS seam:
//
//   • hello     — my grant rev, the scopes I share, and my per-room log heads
//   • cal       — meetings I ORGANISE (never ones I was merely invited to)
//   • board     — the per-link board: no room, no captain, owner/guest roles
//   • card      — my contact card
//   • hist_req / hist — chunked replay of a shared room's log, deduped by msg id
//   • revoke    — "I have cut this link" (courtesy; the tombstone is authoritative)
//
// This is deliberately NOT useDeviceSync with a different prefix. Three rules
// separate them, and every send and receive path below obeys all three:
//
//   1. Scope enforcement BOTH WAYS. `mayISend` bounds every outbound frame,
//      `mayIAccept` bounds every inbound one. A frame outside the grant is
//      dropped, never merged — so a peer cannot widen its own access by simply
//      sending more.
//   2. Mirrors, not merges. A peer's calendar and card land in per-peer
//      namespaces (`peer:cal/<nodeId>`), never in your own `meetings` or
//      `contacts`. History is the single exception, and it is authorised
//      against real MLS membership before anything is written.
//   3. No clock trust. Every item carries {counter, author}; conflicts resolve
//      by peerSyncModel's `lclockWins`. Nothing on this wire is a timestamp
//      that decides a winner.
//
// Admission to a link room is double-gated exactly like devlink's: the topic is
// unguessable AND every key package must carry `link_proof` = HMAC(linkKey, kp).
// A revoked grant refuses admission even though the peer still knows the key.

import { ref, computed } from "vue";
import { useChatChannel, type ChatChannel } from "./useChatChannel";
import { kvGet, kvPut } from "./services/localDb";
import { getPeerResyncSecs, getChatHistoryCapMsgs } from "./services/appStorage";
import { logMeta, mergeIntoLog, messagesSince } from "./services/chatLog";
import { validatePersistedMessage, type PersistedMessage } from "./deviceSyncModel";
import {
  PLINK_VERSION, PEER_HMAC_LABEL_KP, PEER_LINK_MAX, PLINK_HISTORY_CHUNK_MAX_MSGS,
  grantIsLive, lclockWins, mayIAccept, mayISend, mergePeerBoards, mergePeerMeetings,
  peerScopeKv, validatePeerBoard, validatePeerGrant, validatePlinkBoard,
  validatePlinkCal, validatePlinkCard, validatePlinkHello, validatePlinkHist,
  validatePlinkHistReq, validatePlinkRevoke,
  type PeerBoard, type PeerCard, type PeerGrant, type PeerMeeting, type PeerScope,
} from "./peerSyncModel";

const NS_PEERS = "peers";
const SCOPE_INDEX = "index";
const KEY_GRANT = "";

// ── WebCrypto HMAC-SHA256 (the one MAC implementation, as in useDeviceSync) ────

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(linkKeyB64: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", b64ToBytes(linkKeyB64).slice().buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

/** Key-package admission proof for a link room. Note the plink label: a devlink
 *  proof can never validate here, nor the reverse. */
export async function peerKpProof(linkKeyB64: string, kpB64: string): Promise<string> {
  return hmacHex(linkKeyB64, `${PEER_HMAC_LABEL_KP}\0${kpB64}`);
}

// ── stored-state helpers ──────────────────────────────────────────────────────

async function loadIndex(): Promise<string[]> {
  try {
    const raw = await kvGet(NS_PEERS, SCOPE_INDEX, KEY_GRANT);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

async function loadGrant(nodeId: string): Promise<PeerGrant | null> {
  try {
    const raw = await kvGet(NS_PEERS, nodeId, KEY_GRANT);
    return raw ? validatePeerGrant(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

async function saveGrant(grant: PeerGrant): Promise<void> {
  await kvPut(NS_PEERS, grant.peerNodeId, KEY_GRANT, JSON.stringify(grant)).catch(() => {});
}

async function loadJson<T>(ns: string, scope: string, fallback: T): Promise<T> {
  try {
    const raw = await kvGet(ns, scope, "");
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** What the local user contributes to a link, supplied by the app (rakotis must
 *  not reach into app state). Every getter is optional: a scope with no source
 *  simply sends nothing, which is indistinguishable from an empty set. */
export interface PeerSyncSources {
  /** My own NodeId — the clock author and the tiebreak key. */
  myNodeId: () => string;
  /** Meetings I organise, already in wire shape (peer.md §1.4: mine only). */
  myMeetings?: () => Promise<PeerMeeting[]>;
  /** My contact card. */
  myCard?: () => Promise<PeerCard | null>;
  /** Room slugs I hold history for AND this peer is a real MLS member of.
   *  Authorisation lives in the app because only it can ask cryptoService. */
  sharedRooms?: (peerNodeId: string) => Promise<string[]>;
}

export function usePeerSync(main: ChatChannel, sources: PeerSyncSources) {
  const grants = ref<PeerGrant[]>([]);
  const lastSyncAt = ref(0);
  const syncing = ref(false);

  /** One live channel per link, keyed by peer NodeId. */
  const channels = new Map<string, ChatChannel>();
  let tick: ReturnType<typeof setInterval> | null = null;
  let started = false;

  const liveGrants = computed(() => grants.value.filter(grantIsLive));

  function grantFor(nodeId: string): PeerGrant | null {
    return grants.value.find((g) => g.peerNodeId === nodeId) ?? null;
  }

  // ── channel lifecycle ───────────────────────────────────────────────────────

  function makeChannel(nodeId: string): ChatChannel {
    return useChatChannel({
      headless: true,
      admissionCheck: async (data) => {
        // Re-read the grant on every admission: a revoked link must refuse the
        // peer even though it still holds the link key, and a stale closure
        // would happily let it back in.
        const grant = grantFor(nodeId);
        if (!grantIsLive(grant)) return false;
        const kp = (data.key_package ?? data.package) as string | undefined;
        const proof = data.link_proof as string | undefined;
        if (!kp || !proof) return false;
        try {
          return proof === (await peerKpProof(grant.linkKey, kp));
        } catch {
          return false;
        }
      },
      keyPackageExtra: async (kpB64) => {
        const grant = grantFor(nodeId);
        if (!grantIsLive(grant)) return {};
        return { link_proof: await peerKpProof(grant.linkKey, kpB64) };
      },
    });
  }

  async function connectLink(grant: PeerGrant): Promise<void> {
    let ch = channels.get(grant.peerNodeId);
    if (!ch) {
      ch = makeChannel(grant.peerNodeId);
      channels.set(grant.peerNodeId, ch);
      ch.onSync((type, payload) => void onFrame(grant.peerNodeId, type, payload));
    }
    // Gate on the room name, not just isConnected: a re-link mints a new room
    // and an isConnected-only guard would strand the channel (the devlink bug).
    if (ch.currentRoom.value?.slug === grant.roomName && ch.isConnected.value) return;
    ch.mlsIdentity.value = main.mlsIdentity.value;
    ch.currentUserName.value = main.currentUserName.value;
    await ch.joinByNode(grant.roomName, [grant.peerNodeId]).catch(() => {});
  }

  function channelOnline(nodeId: string): boolean {
    const ch = channels.get(nodeId);
    return !!ch && ch.isConnected.value && ch.mlsStatus.value === "ready";
  }

  async function send(nodeId: string, type: string, payload: Record<string, unknown>) {
    const ch = channels.get(nodeId);
    if (!ch || !channelOnline(nodeId)) return;
    await ch.sendSync(type, payload).catch(() => {});
  }

  // ── outbound ────────────────────────────────────────────────────────────────

  async function sendHello(nodeId: string): Promise<void> {
    const grant = grantFor(nodeId);
    if (!grantIsLive(grant)) return;
    const rooms: { slug: string; latestTs: number }[] = [];
    if (mayISend(grant, "history") && sources.sharedRooms) {
      for (const slug of await sources.sharedRooms(nodeId).catch(() => [])) {
        const meta = await logMeta(slug);
        rooms.push({ slug, latestTs: meta.latestTs });
      }
    }
    await send(nodeId, "plink_hello", {
      v: PLINK_VERSION, rev: grant.rev, scopes: grant.myScopes, rooms,
    });
    lastSyncAt.value = Date.now();
  }

  async function pushScopes(nodeId: string): Promise<void> {
    const grant = grantFor(nodeId);
    if (!grantIsLive(grant)) return;

    if (mayISend(grant, "calendar") && sources.myMeetings) {
      const meetings = await sources.myMeetings().catch(() => [] as PeerMeeting[]);
      // `full: true` — this IS my complete organised set, so the peer may drop
      // anything missing. Only ever true because the source is authoritative.
      await send(nodeId, "plink_cal", { v: PLINK_VERSION, meetings, full: true });
    }
    if (mayISend(grant, "card") && sources.myCard) {
      const card = await sources.myCard().catch(() => null);
      if (card) await send(nodeId, "plink_card", { v: PLINK_VERSION, card });
    }
    if (mayISend(grant, "board")) {
      const board = await loadBoard(nodeId);
      if (board) await send(nodeId, "plink_board", { v: PLINK_VERSION, board });
    }
  }

  async function sendHistory(nodeId: string, room: string, sinceTs: number): Promise<void> {
    const grant = grantFor(nodeId);
    if (!grantIsLive(grant) || !mayISend(grant, "history")) return;
    // Re-authorise at send time, not just at request time: the peer may have
    // left the room since it asked.
    const allowed = await sources.sharedRooms?.(nodeId).catch(() => []) ?? [];
    if (!allowed.includes(room)) return;
    const msgs = await messagesSince(room, sinceTs);
    if (!msgs.length) return;
    const chunks: PersistedMessage[][] = [];
    for (let i = 0; i < msgs.length; i += PLINK_HISTORY_CHUNK_MAX_MSGS) {
      chunks.push(msgs.slice(i, i + PLINK_HISTORY_CHUNK_MAX_MSGS));
    }
    for (let i = 0; i < chunks.length; i++) {
      await send(nodeId, "plink_hist", {
        v: PLINK_VERSION, room, msgs: chunks[i], chunk: i + 1, of: chunks.length,
      });
    }
  }

  // ── the per-link board ──────────────────────────────────────────────────────

  async function loadBoard(nodeId: string): Promise<PeerBoard | null> {
    const kv = peerScopeKv("board", nodeId);
    const raw = await loadJson<unknown>(kv.ns, kv.scope, null);
    return raw ? validatePeerBoard(raw) : null;
  }

  async function saveBoard(nodeId: string, board: PeerBoard): Promise<void> {
    const kv = peerScopeKv("board", nodeId);
    await kvPut(kv.ns, kv.scope, kv.k, JSON.stringify(board)).catch(() => {});
  }

  /** Write a locally-edited board and push it. The caller owns clock bumping
   *  (peerSyncModel.bumpClock) — this only persists and broadcasts. */
  async function putBoard(nodeId: string, board: PeerBoard): Promise<void> {
    const grant = grantFor(nodeId);
    if (!grantIsLive(grant)) return;
    await saveBoard(nodeId, board);
    if (mayISend(grant, "board")) {
      await send(nodeId, "plink_board", { v: PLINK_VERSION, board });
    }
  }

  // ── inbound ─────────────────────────────────────────────────────────────────

  async function onFrame(
    nodeId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const grant = grantFor(nodeId);
    if (!grantIsLive(grant)) return;
    if (type === "plink_hello") await onHello(grant, payload);
    else if (type === "plink_cal") await onCal(grant, payload);
    else if (type === "plink_board") await onBoard(grant, payload);
    else if (type === "plink_card") await onCard(grant, payload);
    else if (type === "plink_hist_req") await onHistReq(grant, payload);
    else if (type === "plink_hist") await onHist(grant, payload);
    else if (type === "plink_revoke") await onRevoke(grant, payload);
  }

  async function onHello(grant: PeerGrant, payload: Record<string, unknown>): Promise<void> {
    const hello = validatePlinkHello(payload);
    if (!hello) return;
    // Answer with everything I grant them, then ask for the history I miss.
    await pushScopes(grant.peerNodeId);
    if (mayIAccept(grant, "history")) {
      const mine = await sources.sharedRooms?.(grant.peerNodeId).catch(() => []) ?? [];
      for (const theirs of hello.rooms) {
        // Only rooms I too consider shared — their claim is never sufficient.
        if (!mine.includes(theirs.slug)) continue;
        const ours = await logMeta(theirs.slug);
        if (theirs.latestTs > ours.latestTs) {
          await send(grant.peerNodeId, "plink_hist_req", {
            v: PLINK_VERSION, room: theirs.slug, sinceTs: ours.latestTs,
          });
        }
      }
    }
    lastSyncAt.value = Date.now();
  }

  async function onCal(grant: PeerGrant, payload: Record<string, unknown>): Promise<void> {
    if (!mayIAccept(grant, "calendar")) return;
    const frame = validatePlinkCal(payload);
    if (!frame) return;
    const kv = peerScopeKv("calendar", grant.peerNodeId);
    const local = await loadJson<PeerMeeting[]>(kv.ns, kv.scope, []);
    const { merged, changed } = mergePeerMeetings(local, frame.meetings, frame.full);
    if (changed) await kvPut(kv.ns, kv.scope, kv.k, JSON.stringify(merged)).catch(() => {});
    lastSyncAt.value = Date.now();
  }

  async function onBoard(grant: PeerGrant, payload: Record<string, unknown>): Promise<void> {
    if (!mayIAccept(grant, "board")) return;
    const frame = validatePlinkBoard(payload);
    if (!frame) return;
    const local = await loadBoard(grant.peerNodeId);
    if (!local) {
      await saveBoard(grant.peerNodeId, frame.board);
      return;
    }
    const { merged, changed } = mergePeerBoards(local, frame.board);
    if (changed) await saveBoard(grant.peerNodeId, merged);
    lastSyncAt.value = Date.now();
  }

  async function onCard(grant: PeerGrant, payload: Record<string, unknown>): Promise<void> {
    if (!mayIAccept(grant, "card")) return;
    const frame = validatePlinkCard(payload);
    if (!frame) return;
    const kv = peerScopeKv("card", grant.peerNodeId);
    const local = await loadJson<PeerCard | null>(kv.ns, kv.scope, null);
    // A card is one clocked document: accept only a genuinely newer one.
    if (!lclockWins(frame.card.clock, local?.clock)) return;
    await kvPut(kv.ns, kv.scope, kv.k, JSON.stringify(frame.card)).catch(() => {});
    lastSyncAt.value = Date.now();
  }

  async function onHistReq(grant: PeerGrant, payload: Record<string, unknown>): Promise<void> {
    const frame = validatePlinkHistReq(payload);
    if (!frame) return;
    await sendHistory(grant.peerNodeId, frame.room, frame.sinceTs);
  }

  async function onHist(grant: PeerGrant, payload: Record<string, unknown>): Promise<void> {
    if (!mayIAccept(grant, "history")) return;
    const frame = validatePlinkHist(payload);
    if (!frame) return;
    // AUTHORISATION, not just validation: a peer must not be able to inject a
    // log for a room we do not both belong to (that would fabricate history —
    // or create a log for a room we never joined).
    const allowed = await sources.sharedRooms?.(grant.peerNodeId).catch(() => []) ?? [];
    if (!allowed.includes(frame.room)) return;
    const msgs = frame.msgs
      .map(validatePersistedMessage)
      .filter((m): m is PersistedMessage => m !== null);
    if (!msgs.length) return;
    const cap = await getChatHistoryCapMsgs();
    const added = await mergeIntoLog(frame.room, msgs, cap);
    if (added > 0) main.mergeHistory(frame.room, msgs);
    lastSyncAt.value = Date.now();
  }

  async function onRevoke(grant: PeerGrant, payload: Record<string, unknown>): Promise<void> {
    if (!validatePlinkRevoke(payload)) return;
    // They cut the link. Mirror it locally so we stop sending too — their copy
    // of our data is beyond reach either way (peer.md P6).
    await revoke(grant.peerNodeId, false);
  }

  // ── revocation ──────────────────────────────────────────────────────────────

  /** Cut a link: tombstone the grant (so admission is refused even though the
   *  peer knows the key), tell them if we can, and evict their leaf. Data
   *  already delivered stays on their device — the UI says so. */
  async function revoke(nodeId: string, notify = true): Promise<void> {
    const grant = grantFor(nodeId);
    if (!grant || grant.revokedAt) return;
    if (notify) {
      await send(nodeId, "plink_revoke", { v: PLINK_VERSION });
    }
    const tombstoned: PeerGrant = {
      ...grant,
      myScopes: [],
      theirScopes: [],
      rev: grant.rev + 1,
      revokedAt: Date.now(),
    };
    await saveGrant(tombstoned);
    grants.value = grants.value.map((g) => (g.peerNodeId === nodeId ? tombstoned : g));
    // Enforcement is the tombstone + teardown, not an MLS eviction: the link
    // room keys members by MLS leaf identity, which we never learn from a
    // NodeId. Leaving and refusing re-admission (admissionCheck re-reads the
    // grant on every key package) cuts them off just as completely, and unlike
    // an eviction it works while they are offline.
    const ch = channels.get(nodeId);
    if (ch) {
      await ch.clearLocalChatState();
      channels.delete(nodeId);
    }
  }

  /** Narrow or widen what I share with a peer. Bumps the grant revision so the
   *  peer can tell its copy is behind. */
  async function setMyScopes(nodeId: string, scopes: PeerScope[]): Promise<void> {
    const grant = grantFor(nodeId);
    if (!grantIsLive(grant)) return;
    const next: PeerGrant = { ...grant, myScopes: scopes, rev: grant.rev + 1 };
    await saveGrant(next);
    grants.value = grants.value.map((g) => (g.peerNodeId === nodeId ? next : g));
    await sendHello(nodeId);
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  async function refresh(): Promise<void> {
    const index = await loadIndex();
    const loaded: PeerGrant[] = [];
    for (const nodeId of index.slice(0, PEER_LINK_MAX * 2)) {
      const g = await loadGrant(nodeId);
      if (g) loaded.push(g);
    }
    grants.value = loaded;
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await refresh();
    syncing.value = true;
    for (const g of liveGrants.value.slice(0, PEER_LINK_MAX)) await connectLink(g);
    const secs = await getPeerResyncSecs();
    tick = setInterval(() => {
      void (async () => {
        await refresh();
        for (const g of liveGrants.value.slice(0, PEER_LINK_MAX)) {
          if (!channelOnline(g.peerNodeId)) await connectLink(g);
          else await sendHello(g.peerNodeId);
        }
      })();
    }, secs * 1000);
  }

  function stop(): void {
    if (tick) {
      clearInterval(tick);
      tick = null;
    }
    for (const ch of channels.values()) void ch.clearLocalChatState();
    channels.clear();
    syncing.value = false;
    started = false;
  }

  return {
    grants, liveGrants, lastSyncAt, syncing,
    start, stop, refresh, grantFor, revoke, setMyScopes,
    sendHello, loadBoard, putBoard,
    // exposed for tests
    _internal: { onFrame, pushScopes, sendHistory, channels },
  };
}

export type PeerSync = ReturnType<typeof usePeerSync>;
