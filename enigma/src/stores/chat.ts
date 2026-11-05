// Orchestrator: the single chat channel, over Tor onion services. Pairing is a
// QR-shared invitation; reconnects ride the onions persisted per room.
//
// This is a plain module singleton (NOT a Pinia setup store) on purpose: Pinia's
// reactive() would deep-unwrap the channel's inner refs, which we want to keep as
// real Ref<>s for the ChatPanel prop and direct `.value` access.

import {
  useChatChannel,
  type ChatChannel,
} from "rakotis";
import type { AppRuntimeConfig } from "rakotis";
import { useInviteAdmit } from "../components/chat/useInviteAdmit";

export type { Message, MlsStatus, P2pRoomEntry, ChatChannel } from "rakotis";

function createChatStore() {
  const p2p: ChatChannel = useChatChannel();
  // Invitation redemptions (technology.md §18). App-lifetime and NOT build-gated:
  // someone redeeming an invitation we issued must be admitted wherever the user
  // happens to be in the app, and a build that could mint invitations but not
  // honour them would strand every one it issued.
  const inviteAdmit = useInviteAdmit(p2p);
  let initialized = false;
  /** App-start bootstrap: load the saved room list and auto-reopen the most recent
   *  room over its onion. */
  async function init() {
    if (initialized) return;
    initialized = true;
    await p2p.loadP2pRooms();
    const last = p2p.p2pRooms.value[0];
    if (last) await p2p.openP2pRoom(last);
  }

  // ── identity / profile fan-out ────────────────────────────────────────────────
  async function syncRuntimeIdentity() {
    await p2p.syncRuntimeIdentity();
  }
  async function applyRuntimeProfile(runtime: AppRuntimeConfig) {
    await p2p.applyRuntimeProfile(runtime);
  }
  function clearLocalChatState(message?: string) {
    p2p.clearLocalChatState(message);
  }

  return {
    p2p, inviteAdmit,
    init,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState,
  };
}

let _instance: ReturnType<typeof createChatStore> | null = null;

/** Singleton accessor (kept the `useChatStore` name so call sites are unchanged). */
export function useChatStore() {
  return (_instance ??= createChatStore());
}
