// Peer links — the request/accept lifecycle and the app-side data sources for
// person-to-person sync (peer.md). The handshake is Rust (`peer_*` commands +
// `plink://*` events, src-tauri/peer_link.rs); the ongoing convergence is the
// chat store's `peerSync` (rakotis usePeerSync). This store is the UI-facing
// state machine plus the bridge that turns app state into wire shapes:
//
//   requester: request(nodeId, want, give) → peer_request → grant | declined
//   accepter:  plink://request → the Peers UI shows scopes + safety number →
//              respond(accept, give) → peer_respond → plink://linked
//
// It also owns the per-item conflict clocks. peerSyncModel deliberately has no
// storage of its own, and the counters must NOT be per-peer: the same meeting
// shared with two peers is one item with one history, so its clock lives in a
// single table keyed by item id (`peer:clock/default/""`).

import { ref, computed } from "vue";
import { defineStore } from "pinia";
import {
  bumpClock, getBuildConfig, invoke, isTauri, kvGet, kvPut,
  validateScopes,
  type LClock, type PeerCard, type PeerGrant, type PeerMeeting, type PeerScope,
} from "rakotis";
import { useChatStore } from "./chat";
import { useUserStore } from "./user";

export interface IncomingPeerRequest {
  requestId: string;
  fromNodeId: string;
  fromName: string;
  /** Scopes they are asking me to share. */
  want: PeerScope[];
  /** Scopes they offer to share back. */
  offered: PeerScope[];
  safetyNumber: string;
}

export type OutgoingRequestState = "idle" | "waiting" | "linked" | "declined" | "error";

const NS_CLOCK = "peer:clock";
const CLOCK_SCOPE = "default";

/** Per-item conflict clocks + the content fingerprint they were minted for. The
 *  counter advances only when the content actually changed — never on a resend,
 *  which is what keeps a routine push from out-clocking a peer's real edit. */
interface ClockRecord {
  clock: LClock;
  hash: string;
}

function contentHash(value: unknown): string {
  // Cheap, stable, and local-only: this never rides the wire, it only decides
  // "did my own copy change since I last stamped it".
  const s = JSON.stringify(value);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

export const usePeersStore = defineStore("peers", () => {
  const chatStore = useChatStore();
  const userStore = useUserStore();

  const enabled = computed(() => getBuildConfig().peers_enabled);
  const grants = computed<PeerGrant[]>(() => chatStore.peerSync?.grants.value ?? []);
  const liveGrants = computed<PeerGrant[]>(() => chatStore.peerSync?.liveGrants.value ?? []);
  const lastSyncAt = computed(() => chatStore.peerSync?.lastSyncAt.value ?? 0);

  const incoming = ref<IncomingPeerRequest | null>(null);
  const outgoing = ref<OutgoingRequestState>("idle");
  const outgoingError = ref("");
  const myNodeId = ref("");

  function grantFor(nodeId: string): PeerGrant | null {
    return grants.value.find((g) => g.peerNodeId === nodeId) ?? null;
  }

  function isLinked(nodeId: string): boolean {
    const g = grantFor(nodeId);
    return !!g && !g.revokedAt;
  }

  // ── conflict clocks ─────────────────────────────────────────────────────────

  async function loadClocks(): Promise<Record<string, ClockRecord>> {
    try {
      const raw = await kvGet(NS_CLOCK, CLOCK_SCOPE, "");
      return raw ? (JSON.parse(raw) as Record<string, ClockRecord>) : {};
    } catch {
      return {};
    }
  }

  async function saveClocks(table: Record<string, ClockRecord>): Promise<void> {
    await kvPut(NS_CLOCK, CLOCK_SCOPE, "", JSON.stringify(table)).catch(() => {});
  }

  /** Stamp `items` with clocks, bumping only those whose content changed since
   *  the last stamp. Returns the stamped list; persists the table once. */
  async function stampAll<T>(
    kind: string,
    items: { id: string; value: T }[],
  ): Promise<Map<string, LClock>> {
    const me = myNodeId.value;
    const table = await loadClocks();
    const out = new Map<string, LClock>();
    let dirty = false;
    for (const item of items) {
      const key = `${kind}:${item.id}`;
      const hash = contentHash(item.value);
      const rec = table[key];
      if (!rec || rec.hash !== hash || rec.clock.by !== me) {
        table[key] = { clock: bumpClock(rec?.clock, me), hash };
        dirty = true;
      }
      out.set(item.id, table[key].clock);
    }
    if (dirty) await saveClocks(table);
    return out;
  }

  // ── data sources handed to usePeerSync ──────────────────────────────────────

  /** Only meetings I ORGANISE. A meeting somebody else invited me to is their
   *  data and never leaves this device through a peer link (peer.md §1.4). */
  async function myMeetings(): Promise<PeerMeeting[]> {
    const meetings = chatStore.meetings;
    if (!meetings) return [];
    const me = chatStore.p2p.currentUserName.value;
    const mine = meetings.meetings.value.filter(
      (m: { organizer?: string }) => (m.organizer ?? "") === me,
    );
    const clocks = await stampAll(
      "meeting",
      mine.map((m: Record<string, unknown>) => ({
        id: String(m.id),
        value: [m.title, m.start, m.end, m.location, m.notes, m.status],
      })),
    );
    return mine.map((m: Record<string, unknown>): PeerMeeting => ({
      id: String(m.id),
      title: String(m.title ?? ""),
      start: Number(m.start ?? 0),
      end: Number(m.end ?? 0),
      location: String(m.location ?? ""),
      notes: String(m.notes ?? ""),
      status: m.status === "cancelled" ? "cancelled" : "scheduled",
      organizer: me,
      clock: clocks.get(String(m.id)) ?? { c: 1, by: myNodeId.value },
    }));
  }

  async function myCard(): Promise<PeerCard | null> {
    const profile = userStore.offlineProfile;
    const name = profile.display_name ?? "";
    const avatar = profile.avatar ?? "";
    const about = profile.bio ?? "";
    if (!name && !avatar && !about) return null;
    const clocks = await stampAll("card", [{ id: "me", value: [name, avatar, about] }]);
    return { name, avatar, about, clock: clocks.get("me") ?? { c: 1, by: myNodeId.value } };
  }

  /** Rooms this peer and I are both in — the authorisation gate for history
   *  backfill. Membership comes from the saved room's peer NodeId list, which is
   *  the app's own record of who it paired that room with; a peer's claim about
   *  a room is never sufficient on its own (usePeerSync intersects both sides). */
  async function sharedRooms(peerNodeId: string): Promise<string[]> {
    return chatStore.p2p.p2pRooms.value
      .filter((r: { peers?: string[] }) => (r.peers ?? []).includes(peerNodeId))
      .map((r: { room: string }) => r.room);
  }

  function sources() {
    return { myNodeId: () => myNodeId.value, myMeetings, myCard, sharedRooms };
  }

  // ── request / accept ────────────────────────────────────────────────────────

  let listening = false;
  async function ensureListeners(): Promise<void> {
    if (!isTauri() || listening || !enabled.value) return;
    listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<Record<string, unknown>>("plink://request", (e) => {
      incoming.value = {
        requestId: String(e.payload.requestId ?? ""),
        fromNodeId: String(e.payload.fromNodeId ?? ""),
        fromName: String(e.payload.fromName ?? ""),
        want: validateScopes(e.payload.want),
        offered: validateScopes(e.payload.offered),
        safetyNumber: String(e.payload.safetyNumber ?? ""),
      };
    });
    await listen<{ requestId: string }>("plink://resolved", (e) => {
      if (incoming.value?.requestId === e.payload.requestId) incoming.value = null;
    });
    // The accepter side persists its grant in Rust; reload so the link appears
    // and the sync channel starts without waiting for the next tick.
    await listen("plink://linked", () => {
      void chatStore.peerSync?.refresh().then(() => chatStore.peerSync?.start());
    });
    // Being reachable needs our endpoint up and listening on the peer ALPN.
    void invoke("realtime_node_info").catch(() => {});
  }

  async function loadMyNodeId(): Promise<void> {
    if (!isTauri()) return;
    try {
      const info = await invoke<{ node_id?: string }>("realtime_node_info");
      myNodeId.value = info?.node_id ?? "";
    } catch {
      /* offline / Tor — the id fills in on the next attempt */
    }
  }

  async function init(): Promise<void> {
    if (!enabled.value) return;
    await ensureListeners();
    await loadMyNodeId();
    // Hand the composable its app-side data sources before anything converges —
    // rakotis has no way to reach app state on its own.
    chatStore.setPeerSources(sources());
    await chatStore.peerSync?.refresh();
    await chatStore.peerSync?.start();
  }

  /** Ask a contact for a link. `want` is what I ask them to share, `give` what
   *  I offer. Resolves once they answer (or the window lapses). */
  async function request(nodeId: string, want: PeerScope[], give: PeerScope[]): Promise<void> {
    if (!isTauri()) {
      outgoing.value = "error";
      outgoingError.value = "peers.unavailable";
      return;
    }
    if (outgoing.value === "waiting") return;
    outgoing.value = "waiting";
    outgoingError.value = "";
    try {
      const grant = await invoke<PeerGrant | null>("peer_request", {
        nodeId,
        fromName: chatStore.p2p.currentUserName.value,
        want,
        give,
      });
      outgoing.value = grant ? "linked" : "declined";
      if (grant) {
        await chatStore.peerSync?.refresh();
        await chatStore.peerSync?.start();
      }
    } catch (e) {
      outgoing.value = "error";
      outgoingError.value = typeof e === "string" ? e : ((e as Error).message ?? "");
    }
  }

  function resetOutgoing(): void {
    outgoing.value = "idle";
    outgoingError.value = "";
  }

  /** Answer the pending request. `give` is what I actually grant — it may be
   *  narrower than what they asked for. */
  async function respond(accept: boolean, give: PeerScope[]): Promise<void> {
    const req = incoming.value;
    if (!req) return;
    incoming.value = null;
    await invoke("peer_respond", {
      requestId: req.requestId,
      accept,
      give: accept ? give : [],
      name: chatStore.p2p.currentUserName.value,
    }).catch(() => {});
  }

  /** Cut a link. Their copy of what we already sent stays on their device — the
   *  confirm dialog says so (peer.md P6). */
  async function revoke(nodeId: string): Promise<void> {
    await chatStore.peerSync?.revoke(nodeId);
    await invoke("peer_forget", { nodeId }).catch(() => {});
    await chatStore.peerSync?.refresh();
  }

  async function setMyScopes(nodeId: string, scopes: PeerScope[]): Promise<void> {
    await chatStore.peerSync?.setMyScopes(nodeId, scopes);
  }

  async function safetyNumberFor(nodeId: string): Promise<string> {
    if (!isTauri()) return "";
    return invoke<string>("peer_safety_number", { nodeId }).catch(() => "");
  }

  return {
    enabled, grants, liveGrants, lastSyncAt, myNodeId,
    incoming, outgoing, outgoingError,
    init, sources, grantFor, isLinked,
    request, resetOutgoing, respond, revoke, setMyScopes, safetyNumberFor,
  };
});
