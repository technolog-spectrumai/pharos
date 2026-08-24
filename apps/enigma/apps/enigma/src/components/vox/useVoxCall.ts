// Real-time 1:1 voice call ("Vox") controller.
//
// Drives the Rust iroh voice backend (the `vox_*` commands + `vox://*` events).
// Created once per app lifetime from the p2p chat channel (in stores/chat.ts,
// like `useFileShare`) so incoming rings are caught on any tab and the call-setup
// signaling for the "call a room member" flow rides the channel's MLS-encrypted
// `onSync`/`sendSync` seam (relay sees only ciphertext). Voice is desktop/Android
// only (iroh lives in Rust) — in a plain browser `available` is false and the
// panel shows a notice, mirroring how P2P chat is native-only.
//
// Three ways to start a call:
//   • ticket/QR  — createCall (callee) → shareable ticket → joinByTicket (caller).
//   • room peer  — callPeer(member): we `vox_create` (listener) and send a
//                  `vox_offer` over the room; the member rings, and on accept dials
//                  us back; we auto-accept the inbound Hello matching our call id.
//   • nickname / saved contact — callByNick / callNode: dial the peer's stable
//                  NodeId directly (resolved via the DHT nickname directory).

import { ref } from "vue";
import { chargeMana, confirmMana } from "../mana/useMana";
import type { ChatChannel, NickClaim } from "rakotis";
import { dhtFindNick } from "rakotis";

export type VoxPhase =
  | "idle" // nothing happening — show start/join
  | "waiting" // we created a ticket and are waiting for a peer to join (callee)
  | "calling" // we are dialing (caller) — includes a pending room-peer offer
  | "incoming" // a peer is calling us — show accept/decline
  | "connected" // call is live
  | "ended" // transient — settles back to idle
  | "error"; // transient — settles back to idle

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function useVoxCall(channel: ChatChannel) {
  const available = _isTauri();

  const phase = ref<VoxPhase>("idle");
  const ticket = ref("");
  const nodeId = ref("");
  const incomingName = ref("");
  const peerName = ref("");
  const muted = ref(false);
  const error = ref(""); // i18n key or raw message
  const callSeconds = ref(0);
  const spectrum = ref<number[]>([]); // live equalizer bands (0..1) of the incoming voice
  const encryption = ref<"mls" | "transport" | "">(""); // active media encryption of the call
  const nickResults = ref<NickClaim[]>([]); // "call by nickname" claim pick-list

  // Room-peer flow bookkeeping.
  //  • As the initiator (listener): the offer we broadcast, so we can auto-accept
  //    the matching inbound Hello and cancel it if we hang up first.
  //  • As the target (dialer): the incoming offer's ticket, to dial on accept.
  let pendingOffer: { offerId: string; callId: string } | null = null;
  let incomingOffer: { offerId: string; ticket: string } | null = null;

  let timer: ReturnType<typeof setInterval> | null = null;
  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
      // Privacy MANA, billed on the way out with the call's REAL duration: a
      // 40-second call and a four-hour call are not the same disclosure, and
      // charging up-front could only guess. Minutes round up, so any connected
      // call costs at least the base plus one minute. Voice is iroh-direct only
      // (Tor mode blocks it), so there is no cheaper variant to pick.
      const minutes = Math.ceil(callSeconds.value / 60);
      if (minutes > 0) void chargeMana("vox.call", { minutes });
    }
  }
  function startTimer() {
    stopTimer();
    callSeconds.value = 0;
    timer = setInterval(() => (callSeconds.value += 1), 1000);
  }

  function reset() {
    phase.value = "idle";
    ticket.value = "";
    nodeId.value = "";
    incomingName.value = "";
    peerName.value = "";
    muted.value = false;
    spectrum.value = [];
    encryption.value = "";
    pendingOffer = null;
    incomingOffer = null;
    stopTimer();
  }

  function busy(): boolean {
    return phase.value !== "idle" && phase.value !== "ended" && phase.value !== "error";
  }

  // ── backend events ──────────────────────────────────────────────────────────
  let listening = false;
  async function ensureListeners(): Promise<void> {
    if (listening || !available) return;
    listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ from_name: string; node_id: string; call_id: string }>("vox://incoming", (e) => {
      // If this is the inbound leg of a room-peer offer WE initiated, auto-accept
      // it (the target dialed us back). A mismatch while we're already calling is a
      // stranger dialing our one-shot ticket window — decline it.
      if (pendingOffer) {
        if (e.payload.call_id && e.payload.call_id === pendingOffer.callId) {
          void _invoke("vox_accept").catch(() => {});
        } else {
          void _invoke("vox_decline").catch(() => {});
        }
        return;
      }
      incomingName.value = e.payload.from_name || "Unknown";
      phase.value = "incoming";
    });
    await listen<{ bands: number[] }>("vox://spectrum", (e) => {
      spectrum.value = e.payload.bands ?? [];
    });
    await listen<{ state: string; peer: string | null; encryption?: string }>("vox://state", (e) => {
      const { state, peer } = e.payload;
      switch (state) {
        case "calling":
          phase.value = "calling";
          break;
        case "ringing":
          if (peer) incomingName.value = peer;
          break;
        case "connected":
          peerName.value = peer || incomingName.value || "Peer";
          incomingName.value = "";
          encryption.value = e.payload.encryption === "mls" ? "mls" : "transport";
          pendingOffer = null;
          incomingOffer = null;
          phase.value = "connected";
          startTimer();
          break;
        case "ended":
        case "error":
          if (state === "error") error.value = "vox.errorGeneric";
          phase.value = state;
          stopTimer();
          // Settle back to the start screen shortly after.
          setTimeout(() => {
            if (phase.value === "ended" || phase.value === "error") reset();
          }, 1500);
          break;
      }
    });
  }

  function myName(): string {
    const u = channel.currentUserName.value;
    return u && u !== "You" ? u : channel.mlsIdentity.value || "Caller";
  }

  // The stable device identity the chat MLS uses — also the call's MLS credential.
  function myIdentity(): string {
    return channel.mlsIdentity.value || channel.currentUserName.value || "anon";
  }

  // ── ticket flow ──────────────────────────────────────────────────────────────
  async function createCall(): Promise<void> {
    if (!available) {
      error.value = "vox.desktopOnly";
      return;
    }
    error.value = "";
    try {
      await ensureListeners();
      const res = await _invoke<{ ticket: string; node_id: string; call_id: string }>("vox_create", {
        name: myName(),
        identity: myIdentity(),
      });
      ticket.value = res.ticket;
      nodeId.value = res.node_id;
      phase.value = "waiting";
    } catch (e) {
      error.value = (e as Error).message || "vox.errorGeneric";
      phase.value = "error";
    }
  }

  async function joinByTicket(t: string): Promise<void> {
    if (!available) {
      error.value = "vox.desktopOnly";
      return;
    }
    const tk = t.trim();
    if (!tk) return;
    error.value = "";
    try {
      await ensureListeners();
      phase.value = "calling";
      await _invoke("vox_join", { ticket: tk, name: myName(), identity: myIdentity() });
    } catch (e) {
      error.value = (e as Error).message || "vox.errorGeneric";
      phase.value = "error";
    }
  }

  // ── nickname / contact flow ───────────────────────────────────────────────────
  /** Dial a peer directly by their stable NodeId (a saved contact, or a picked
   *  nickname claim). The callee still rings — consent is unchanged. */
  async function callNode(id: string, name?: string): Promise<void> {
    if (!available) {
      error.value = "vox.desktopOnly";
      return;
    }
    const target = id.trim();
    if (!target) return;
    error.value = "";
    nickResults.value = [];
    try {
      await ensureListeners();
      if (name) peerName.value = name;
      phase.value = "calling";
      await _invoke("vox_call_node", { nodeId: target, name: myName(), identity: myIdentity() });
    } catch (e) {
      error.value = (e as Error).message || "vox.errorGeneric";
      phase.value = "error";
    }
  }

  /** Resolve a nickname against the DHT directory. One claim → dial it; several →
   *  surface `nickResults` for the panel to disambiguate (claims are unauthenticated,
   *  so the panel shows NodeId fingerprints); none → an offline/needs-DHT error. */
  async function callByNick(nick: string): Promise<void> {
    if (!available) {
      error.value = "vox.desktopOnly";
      return;
    }
    const n = nick.trim();
    if (!n) return;
    error.value = "";
    nickResults.value = [];
    let claims: NickClaim[] = [];
    try {
      claims = await dhtFindNick(n);
    } catch (e) {
      error.value = (e as Error).message || "vox.needsDht";
      return;
    }
    if (claims.length === 0) {
      error.value = "vox.contactOffline";
      return;
    }
    if (claims.length === 1) {
      await callNode(claims[0].node_id, claims[0].name);
      return;
    }
    nickResults.value = claims;
  }

  // ── room-peer flow (offer over the MLS channel) ───────────────────────────────
  /** Ring a member of the current room: we open a call slot (listener) and send the
   *  ticket to them over the encrypted channel; they dial us back on accept. */
  async function callPeer(target: { id: string; name?: string }): Promise<void> {
    if (!available) {
      error.value = "vox.desktopOnly";
      return;
    }
    if (!target?.id) return;
    if (!(await confirmMana("vox.call"))) return;
    error.value = "";
    try {
      await ensureListeners();
      const res = await _invoke<{ ticket: string; node_id: string; call_id: string }>("vox_create", {
        name: myName(),
        identity: myIdentity(),
      });
      const offerId = randomId();
      pendingOffer = { offerId, callId: res.call_id };
      peerName.value = target.name || target.id;
      phase.value = "calling";
      await channel.sendSync("vox_offer", {
        offerId,
        target: target.id,
        ticket: res.ticket,
        callId: res.call_id,
        fromName: myName(),
      });
    } catch (e) {
      pendingOffer = null;
      error.value = (e as Error).message || "vox.errorGeneric";
      phase.value = "error";
    }
  }

  // ── call controls ─────────────────────────────────────────────────────────────
  async function accept(): Promise<void> {
    // Room-peer target: dial the initiator using the offered ticket. Otherwise it's
    // an inbound iroh call already at the backend — just accept it.
    if (incomingOffer) {
      const tk = incomingOffer.ticket;
      incomingOffer = null;
      await joinByTicket(tk);
      return;
    }
    try {
      await _invoke("vox_accept");
    } catch {
      /* the call may have already gone away */
    }
  }

  async function decline(): Promise<void> {
    if (incomingOffer) {
      // Room-peer offer we never dialed: tell the initiator over the channel.
      try {
        await channel.sendSync("vox_decline", { offerId: incomingOffer.offerId });
      } catch {
        /* ignore */
      }
    } else {
      try {
        await _invoke("vox_decline");
      } catch {
        /* ignore */
      }
    }
    reset();
  }

  async function hangup(): Promise<void> {
    // If we're the initiator still waiting on a room offer, cancel it for the peer.
    if (pendingOffer) {
      try {
        await channel.sendSync("vox_cancel", { offerId: pendingOffer.offerId });
      } catch {
        /* ignore */
      }
    }
    try {
      await _invoke("vox_hangup");
    } catch {
      /* ignore */
    }
    reset();
  }

  // End the current (e.g. transport-only) call so the user can start a fresh one
  // and re-attempt the MLS handshake.
  async function restart(): Promise<void> {
    await hangup();
  }

  async function toggleMute(): Promise<void> {
    const next = !muted.value;
    try {
      await _invoke("vox_set_mute", { muted: next });
      muted.value = next;
    } catch {
      /* ignore */
    }
  }

  // ── incoming call-setup signaling (over the MLS channel) ───────────────────────
  channel.onSync((type, payload, sender) => {
    if (!type.startsWith("vox_")) return; // not ours
    const offerId = payload.offerId as string;
    switch (type) {
      case "vox_offer": {
        // Only ring if addressed to us (multi-party rooms broadcast).
        if (payload.target && payload.target !== channel.mlsIdentity.value) return;
        if (busy()) {
          // Already on/placing a call — decline so the initiator isn't left hanging.
          void channel.sendSync("vox_decline", { offerId }).catch(() => {});
          return;
        }
        void ensureListeners();
        incomingOffer = { offerId, ticket: (payload.ticket as string) ?? "" };
        incomingName.value = (payload.fromName as string) || sender;
        phase.value = "incoming";
        break;
      }
      case "vox_decline":
        // Initiator side: the member we rang declined.
        if (!pendingOffer || offerId !== pendingOffer.offerId) return;
        void _invoke("vox_hangup").catch(() => {});
        error.value = "vox.declined";
        phase.value = "ended";
        stopTimer();
        setTimeout(() => {
          if (phase.value === "ended" || phase.value === "error") reset();
        }, 1500);
        break;
      case "vox_cancel":
        // Target side: the initiator gave up before we answered.
        if (incomingOffer && offerId === incomingOffer.offerId) reset();
        break;
    }
  });

  // App-lifetime: register listeners and lazily bind the p2p node so we're
  // call-reachable after startup even with no room open. No-ops offline/Tor.
  if (available) {
    void ensureListeners();
    void channel.ensureNode?.().catch?.(() => {});
  }

  return {
    available,
    phase,
    ticket,
    nodeId,
    incomingName,
    peerName,
    muted,
    error,
    callSeconds,
    spectrum,
    encryption,
    nickResults,
    createCall,
    joinByTicket,
    callNode,
    callByNick,
    callPeer,
    accept,
    decline,
    hangup,
    restart,
    toggleMute,
  };
}
