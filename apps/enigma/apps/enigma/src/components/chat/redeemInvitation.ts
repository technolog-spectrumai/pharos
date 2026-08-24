// Turning an invitation into membership — the exchange, in one place.
//
// Two surfaces reach it: pasting or scanning an invitation in "Join a chat"
// (useP2pRooms), and accepting a direct invite from a contact (useRoomInvites,
// which used to be handed a permanent room ticket and simply join with it). They
// are the same act and must not drift: one of them charging a different price, or
// skipping the scratch-session dance, would be a bug nobody notices until a room
// will not open.
//
// The scratch session is the part worth understanding. An invitation deliberately
// does not name its room until the capability is proven — that is what stops a QR
// from leaking which room it belongs to. But an MLS KeyPackage has to exist
// BEFORE the redeemer can be added, and a KeyPackage is built inside a session
// keyed by room. So it is built under a scratch key derived from the inviter and
// the expiry, and once the grant finally names a room, `mls_adopt_session` moves
// that session across — carrying the private init key the Welcome needs.

import { bytesToBase64, cryptoService, roomActionId, type ChatChannel } from "rakotis";
import { chargeHp } from "../hp/useHp";

export interface InvitePeek {
  kind: string;
  inviter: string;
  expiresAt: number;
  /** True when the invitation names an onion — so the redeem dials over Tor. */
  tor?: boolean;
}

export interface RedeemOutcome {
  ok: boolean;
  /** An i18n key when something went wrong; "" on success. */
  errorKey: string;
  peek: InvitePeek | null;
}

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * Map a backend refusal onto a message that says what to do next.
 *
 * The codes are deliberately coarse: an invitation's checks all run on the
 * INVITER's side, so a redeemer learning precisely which one failed would learn
 * something about a room it was refused entry to.
 */
export function inviteErrorKey(raw: string): string {
  const code = raw.match(/INVITE_[A-Z_]+/)?.[0] ?? "";
  switch (code) {
    case "INVITE_NOT_FOR_YOU":
    case "INVITE_WRONG_RECIPIENT":
      return "invite.errNotForYou";
    case "INVITE_EXPIRED":
      return "invite.errExpired";
    case "INVITE_USED":
      return "invite.errUsed";
    case "INVITE_REVOKED":
      return "invite.errRevoked";
    case "INVITE_BUSY":
      return "invite.errBusy";
    case "INVITE_UNREACHABLE":
      return "invite.errUnreachable";
    case "INVITE_ADMIT_FAILED":
      return "invite.errAdmitFailed";
    case "INVITE_VERSION":
      return "invite.errVersion";
    default:
      return "invite.errGeneric";
  }
}

/**
 * Redeem `code` and join the room it names.
 *
 * `onPeek` fires as soon as the local decode succeeds, before any dialling, so a
 * caller can show who is inviting and how long is left while the rendezvous runs.
 */
export async function redeemInvitation(
  channel: ChatChannel,
  code: string,
  onPeek?: (peek: InvitePeek) => void,
): Promise<RedeemOutcome> {
  let peek: InvitePeek | null = null;
  try {
    // Look before leaping: the peek is local and names the inviter and deadline.
    peek = await _invoke<InvitePeek>("invite_peek", { ticket: code });
    onPeek?.(peek);

    const identity = channel.mlsIdentity.value;
    const scratch = `invite:${peek.inviter}:${peek.expiresAt}`;
    await cryptoService.initSession(scratch, identity);
    const kp = await cryptoService.keyPackage(scratch, identity);
    if (!kp) throw new Error("INVITE_ADMIT_FAILED");

    const grant = await _invoke<{
      welcome: string;
      roomName: string;
      peers: string[];
      onion: string;
    }>("invite_redeem", {
      ticket: code,
      keyPackage: bytesToBase64(kp),
      name: channel.currentUserName.value,
    });

    if (!(await channel.joinByInvite(grant, scratch))) {
      return { ok: false, errorKey: "invite.errAdmitFailed", peek };
    }
    // Redeeming IS joining a room, and is charged as one — a second price for the
    // same event would break the ladder's ordering.
    await chargeHp(roomActionId("join", !!grant.onion));
    return { ok: true, errorKey: "", peek };
  } catch (e) {
    const raw = typeof e === "string" ? e : ((e as Error).message ?? "");
    return { ok: false, errorKey: inviteErrorKey(raw), peek };
  }
}
