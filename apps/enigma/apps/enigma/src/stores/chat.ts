// Orchestrator: the single P2P (iroh) chat channel. The app is serverless — the
// former Forum/relay channel is gone; pairing is a QR-shared ticket and
// reconnects ride the peer NodeIds persisted per room.
//
// This is a plain module singleton (NOT a Pinia setup store) on purpose: Pinia's
// reactive() would deep-unwrap the channel's inner refs, which we want to keep as
// real Ref<>s for the ChatPanel prop and direct `.value` access.

import { useChatChannel, type ChatChannel } from "rakotis";
import type { AppRuntimeConfig } from "rakotis";

export type { Message, MlsStatus, P2pRoomEntry, ChatChannel } from "rakotis";

function createChatStore() {
  const p2p: ChatChannel = useChatChannel();

  let initialized = false;
  /** App-start bootstrap: load the saved room list and auto-reopen the most recent
   *  room. Rejoining passes the room's persisted peer NodeIds, so peers whose
   *  addresses changed since the QR pairing are still found via n0 discovery. */
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
    p2p, init,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState,
  };
}

let _instance: ReturnType<typeof createChatStore> | null = null;

/** Singleton accessor (kept the `useChatStore` name so call sites are unchanged). */
export function useChatStore() {
  return (_instance ??= createChatStore());
}
