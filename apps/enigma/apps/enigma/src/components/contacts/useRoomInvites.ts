// Direct room invites (Contacts tab) — the offer/accept counterpart of
// useFileShare, but the payload is a room instead of a file. The handshake
// rides a dedicated iroh ALPN on the main p2p endpoint (Rust `p2p_invite`):
// dial the contact's stable NodeId, send the room's fresh ticket (+ DHT code),
// and wait for their explicit Accept/Decline.
//
// Flow (inviter I → contact C):
//   I: sendInvite(contact, room) → open the room (MLS admission needs a live
//      member) → invite_send → "waiting" until C answers (window ≤ 2×N)
//   C: `invite://incoming` arrives (this composable lives in chatStore, so it's
//      caught anywhere in the app; the Contacts nav shows a dot) → Accept joins
//      via the embedded code (DHT on) or ticket — the same path a scanned QR
//      takes, MLS admission included. Decline just answers.

import { ref } from "vue";
import { getDhtDiscovery } from "rakotis";
import type { ChatChannel, P2pRoomEntry } from "rakotis";

export type OutgoingInviteState = "idle" | "waiting" | "accepted" | "declined" | "error";

export interface IncomingInvite {
  inviteId: string;
  fromNodeId: string;
  roomName: string;
  ticket: string;
  code: string;
}

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export function useRoomInvites(channel: ChatChannel) {
  const available = _isTauri();

  // Inviter side.
  const outgoing = ref<OutgoingInviteState>("idle");
  const outgoingError = ref(""); // raw backend message; "" when clear

  // Invitee side — one invite at a time (like the single file-share offer).
  const incoming = ref<IncomingInvite | null>(null);

  let listening = false;
  async function ensureListeners() {
    if (!available || listening) return;
    listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<Record<string, string>>("invite://incoming", (e) => {
      incoming.value = {
        inviteId: e.payload.inviteId ?? "",
        fromNodeId: e.payload.fromNodeId ?? "",
        roomName: e.payload.roomName ?? "",
        ticket: e.payload.ticket ?? "",
        code: e.payload.code ?? "",
      };
    });
    // The Rust side clears an invite whose decision window lapsed unanswered.
    await listen<{ inviteId: string }>("invite://resolved", (e) => {
      if (incoming.value?.inviteId === e.payload.inviteId) incoming.value = null;
    });
    // Being invitable requires our endpoint to be up and listening on the
    // invite ALPN — nudge the lazy node start (offline mode just rejects).
    void _invoke("realtime_node_info").catch(() => {});
  }
  void ensureListeners();

  /** Offer `room` to a contact and wait for the answer. */
  async function sendInvite(nodeId: string, room: P2pRoomEntry) {
    if (!available) {
      outgoing.value = "error";
      outgoingError.value = "contacts.inviteUnavailable";
      return;
    }
    if (outgoing.value === "waiting") return;
    outgoing.value = "waiting";
    outgoingError.value = "";
    try {
      // Open the room first: when the invitee connects, the MLS auto-admission
      // (key package → welcome) runs against this side's active room.
      await channel.openP2pRoom(room);
      const outcome = await _invoke<string>("invite_send", {
        nodeId,
        room: room.room,
        name: room.name,
      });
      outgoing.value = outcome === "accepted" ? "accepted" : "declined";
    } catch (e) {
      outgoing.value = "error";
      outgoingError.value = typeof e === "string" ? e : ((e as Error).message ?? "");
    }
  }

  function resetOutgoing() {
    outgoing.value = "idle";
    outgoingError.value = "";
  }

  /** Accept the pending invite: answer the inviter, then join their room. */
  async function accept() {
    const invite = incoming.value;
    if (!invite) return;
    incoming.value = null;
    await _invoke("invite_respond", { inviteId: invite.inviteId, accept: true }).catch(() => {});
    // Join exactly like a scanned QR. Prefer the code when our DHT toggle is on
    // (we become a secret-holder: rendezvous + re-share); the fresh ticket is
    // the always-works fallback.
    const blob = invite.code && (await getDhtDiscovery()) ? invite.code : invite.ticket;
    await channel.joinByTicket(blob);
  }

  async function decline() {
    const invite = incoming.value;
    if (!invite) return;
    incoming.value = null;
    await _invoke("invite_respond", { inviteId: invite.inviteId, accept: false }).catch(() => {});
  }

  return { available, outgoing, outgoingError, incoming, sendInvite, resetOutgoing, accept, decline };
}

export type RoomInvitesController = ReturnType<typeof useRoomInvites>;
