// Direct room invites (Contacts tab) — the offer/accept counterpart of
// useFileShare, but the payload is a room instead of a file. The handshake
// rides a dedicated iroh ALPN on the main p2p endpoint (Rust `p2p_invite`):
// dial the contact's stable NodeId, send a personal invitation sealed to them,
// and wait for their explicit Accept/Decline.
//
// Flow (inviter I → contact C):
//   I: sendInvite(contact, room) → open the room (MLS admission needs a live
//      member) → invite_send → "waiting" until C answers (window ≤ 2×N)
//   C: `invite://incoming` arrives (this composable lives in chatStore, so it's
//      caught anywhere in the app; the Contacts nav shows a dot) → Accept
//      REDEEMS the invitation — the same path a scanned invitation QR takes,
//      MLS admission included. Decline just answers.
//
// What arrives used to be a permanent room ticket, which C then joined with. It
// is now an invitation that expires and can be withdrawn, redeemed through the
// same `redeemInvitation` the join modal uses so the two cannot diverge.

import { ref } from "vue";
import type { ChatChannel, P2pRoomEntry } from "rakotis";
import { redeemInvitation } from "../chat/redeemInvitation";

export type OutgoingInviteState = "idle" | "waiting" | "accepted" | "declined" | "error";

export interface IncomingInvite {
  inviteId: string;
  fromNodeId: string;
  roomName: string;
  /** A personal invitation sealed to us — not a room ticket. */
  invite: string;
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
  /** i18n key when a redemption we accepted then failed; "" when clear. */
  const acceptError = ref("");

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
        invite: e.payload.invite ?? "",
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

  /** Accept the pending invite: answer the inviter, then redeem what they sent.
   *
   *  Answering FIRST matters: the inviter is parked on our response byte, and the
   *  redemption that follows needs them present with the room open to admit us. */
  async function accept() {
    const invite = incoming.value;
    if (!invite) return;
    incoming.value = null;
    acceptError.value = "";
    await _invoke("invite_respond", { inviteId: invite.inviteId, accept: true }).catch(() => {});
    const out = await redeemInvitation(channel, invite.invite);
    if (!out.ok) acceptError.value = out.errorKey;
  }

  async function decline() {
    const invite = incoming.value;
    if (!invite) return;
    incoming.value = null;
    await _invoke("invite_respond", { inviteId: invite.inviteId, accept: false }).catch(() => {});
  }

  return {
    available, outgoing, outgoingError, incoming, acceptError,
    sendInvite, resetOutgoing, accept, decline,
  };
}

export type RoomInvitesController = ReturnType<typeof useRoomInvites>;
