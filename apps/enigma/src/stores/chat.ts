// Orchestrator: the single P2P (iroh) chat channel. The app is serverless — the
// former Forum/relay channel is gone; pairing is a QR-shared ticket and
// reconnects ride the peer NodeIds persisted per room.
//
// This is a plain module singleton (NOT a Pinia setup store) on purpose: Pinia's
// reactive() would deep-unwrap the channel's inner refs, which we want to keep as
// real Ref<>s for the ChatPanel prop and direct `.value` access.

import {
  useChatChannel,
  type ChatChannel,
} from "rakotis";
import type { AppRuntimeConfig } from "rakotis";
import { useFileShare } from "../components/chat/useFileShare";
import { useInviteAdmit } from "../components/chat/useInviteAdmit";
import { useP2pRooms } from "../components/chat/useP2pRooms";
import { beaconMailbox } from "../beaconMailbox";
import { loadBeacon, myBeacon } from "./beacon";

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export type { Message, MlsStatus, P2pRoomEntry, ChatChannel } from "rakotis";

function createChatStore() {
  // Frames also go to the room's Beacon mailbox when the room has one (8.B3);
  // without one the mailbox does nothing and the room is pure mesh.
  // eslint-disable-next-line prefer-const
  let p2p: ChatChannel;
  const mailbox = beaconMailbox({
    invoke: tauriInvoke,
    beaconFor: (room) => p2p.p2pRooms.value.find((r) => r.room === room)?.beacon,
    identity: () => p2p.mlsIdentity.value,
  });
  p2p = useChatChannel({
    mailbox,
    beaconForNewRoom: () => myBeacon.value?.onion,
    resetAuth: {
      sign: (room, resetId, ts) => tauriInvoke<string>("reset_sign", { room, resetId, ts }),
      verify: (deviceId, room, resetId, ts, sig) => tauriInvoke<boolean>("reset_verify", { deviceId, room, resetId, ts, sig }),
    },
  });
  // P2P file transfer rides the p2p channel's MLS group (onSync/sendSync seam).
  // Created here (once, for the app's lifetime) so incoming offers are caught
  // even while the Files modal is closed.
  const fileShare = useFileShare(p2p);
  // Invitation redemptions (technology.md §18). App-lifetime and NOT build-gated:
  // someone redeeming an invitation we issued must be admitted wherever the user
  // happens to be in the app, and a build that could mint invitations but not
  // honour them would strand every one it issued.
  const inviteAdmit = useInviteAdmit(p2p);
  // The rooms controller (create, join, info, delete): one for the app, so the
  // menu drawer can open a room or a dialog from any page.
  const rooms = useP2pRooms(p2p);
  let initialized = false;
  /** App-start bootstrap: load the saved room list and auto-reopen the most recent
   *  room. Rejoining passes the room's persisted peer NodeIds, so peers whose
   *  addresses changed since the QR pairing are still found via n0 discovery. */
  async function init() {
    if (initialized) return;
    initialized = true;
    await loadBeacon();
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
    p2p, fileShare, inviteAdmit, rooms,
    init,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState,
  };
}

let _instance: ReturnType<typeof createChatStore> | null = null;

/** Singleton accessor (kept the `useChatStore` name so call sites are unchanged). */
export function useChatStore() {
  return (_instance ??= createChatStore());
}
