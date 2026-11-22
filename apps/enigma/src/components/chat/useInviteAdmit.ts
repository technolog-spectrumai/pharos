// The inviter's half of a redemption: answer Rust's request to admit someone.
//
// Rust does every CHECK — signature, expiry against its own clock, revocation,
// recipient binding, the capability proof — and takes the invitation's lease.
// Then it stops and asks here, because admission is an MLS group operation and
// the resulting commit has to reach the room's existing members over that room's
// transport. Both of those belong to `useChatChannel`, which is why this parks
// on an event exactly the way `useRoomInvites` does for direct room invites.
//
// ── the constraint this composable makes visible ───────────────────────────
//
// A redemption completes only while the inviter has THAT ROOM OPEN. Not merely
// the app running: `addMember` needs the group loaded and the commit needs a
// live transport to go out on. Combined with the older rule that the inviter
// must be online at all (there is no store-and-forward — technology.md §16), an
// invitation is a rendezvous, not a message left for someone.
//
// When the room is not open we answer `ok: false` immediately rather than
// letting the request time out. That difference matters: a fast, specific
// refusal releases the invitation's lease at once, so the holder can try again
// the moment the room is reopened, and the invitation is not burned by someone
// else's bad timing.

import { ref } from "vue";
import type { ChatChannel } from "rakotis";

const isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(cmd, args);
}

/** What Rust asks for when someone redeems one of our invitations. */
interface AdmitRequest {
  requestId: string;
  inviteId: string;
  roomSlug: string;
  roomName: string;
  keyPackage: string;
  redeemer: string;
  redeemerName: string;
  tor: boolean;
}

export interface InviteAdmitController {
  /** The most recent admission and how it went — drives a small notice in the
   *  room, so the inviter sees that somebody used their invitation. */
  lastAdmitted: ReturnType<typeof ref<{ name: string; at: number } | null>>;
  lastRefusal: ReturnType<typeof ref<string>>;
}

export function useInviteAdmit(channel: ChatChannel): InviteAdmitController {
  const lastAdmitted = ref<{ name: string; at: number } | null>(null);
  const lastRefusal = ref("");

  let listening = false;

  async function answer(requestId: string, answerBody: Record<string, unknown>) {
    await invoke("invite_admit", { requestId, answer: answerBody }).catch(() => false);
  }

  async function handle(req: AdmitRequest) {
    // The room must be the one that is open. Anything else is answered at once
    // so the lease comes straight back.
    const grant = await channel.admitInvited(req.roomSlug, req.keyPackage);
    if (!grant) {
      lastRefusal.value = "invite.admitRoomClosed";
      await answer(req.requestId, {
        ok: false,
        // Stays on this side: Rust logs it and sends the redeemer a bare code,
        // because why an admission failed can name a room or a group state.
        error: "room not open, or its encrypted session is not ready",
      });
      return;
    }

    // The coordinates come from the channel, which knows the room's actual
    // transport — reading a global Tor setting here would hand a Tor room's
    // joiner an iroh address, or the reverse.
    await answer(req.requestId, {
      ok: true,
      welcome: grant.welcome,
      roomName: grant.roomName,
      peers: grant.peers,
      onion: grant.onion,
    });
    lastAdmitted.value = { name: req.redeemerName || req.redeemer, at: Date.now() };
    lastRefusal.value = "";
  }

  async function ensureListeners() {
    if (!isTauri() || listening) return;
    listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<AdmitRequest>("invite://admit", (e) => {
      void handle(e.payload);
    });
  }
  void ensureListeners();

  return { lastAdmitted, lastRefusal };
}
