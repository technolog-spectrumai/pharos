// Orchestrator: the single P2P (iroh) chat channel. The app is serverless — the
// former Forum/relay channel is gone; pairing is a QR-shared ticket and
// reconnects ride the peer NodeIds persisted per room.
//
// This is a plain module singleton (NOT a Pinia setup store) on purpose: Pinia's
// reactive() would deep-unwrap the channel's inner refs, which we want to keep as
// real Ref<>s for the ChatPanel prop and direct `.value` access.

import {
  getBuildConfig, invoke, isTauri, useChatChannel, useDeviceSync, usePeerSync,
  type ChatChannel, type DeviceSync, type PeerSync, type PeerSyncSources,
} from "rakotis";
import type { AppRuntimeConfig } from "rakotis";
import { useFileShare } from "../components/chat/useFileShare";
import { useVoxCall } from "../components/vox/useVoxCall";
import { useRoomInvites } from "../components/contacts/useRoomInvites";
import { useMeetings } from "../components/calendar/useMeetings";
import { useKanban } from "../components/kanban/useKanban";

export type { Message, MlsStatus, P2pRoomEntry, ChatChannel } from "rakotis";

function createChatStore() {
  const p2p: ChatChannel = useChatChannel();
  // P2P file transfer rides the p2p channel's MLS group (onSync/sendSync seam).
  // Created here (once, for the app's lifetime) so incoming offers are caught
  // even while the Files modal is closed.
  const fileShare = useFileShare(p2p);
  // 1:1 voice calls — same lifetime rationale: an incoming ring (and its nav dot)
  // must be caught wherever the user is, and room-peer call offers ride this
  // channel's MLS group (onSync/sendSync seam) like file offers.
  // Gated by the compile-time build flag (pland.md: Plus and up) — the same
  // pattern as kanban below. A flag-off build never instantiates the composable,
  // so it registers no sync handler at all: a call offer from a higher-edition
  // peer is an unhandled sync type and is dropped, not merely hidden.
  const callsEnabled = getBuildConfig().calls_enabled;
  const vox = callsEnabled ? useVoxCall(p2p) : null;
  // Direct room invites (Contacts) — same lifetime rationale: an incoming
  // invite must be caught (and the Contacts nav dot lit) wherever the user is.
  const contactsEnabled = getBuildConfig().contacts_enabled;
  const invites = contactsEnabled ? useRoomInvites(p2p) : null;
  // Meeting scheduling — rides the same seam; app-lifetime so incoming invites
  // land (Calendar nav dot) and the reminder tick runs regardless of the view.
  const calendarEnabled = getBuildConfig().calendar_enabled;
  const meetings = calendarEnabled ? useMeetings(p2p) : null;
  // Group Kanban board — one per room, rides the same seam; app-lifetime so
  // remote column/card changes land (Board nav dot) regardless of the view. Gated
  // by the compile-time build flag: a flag-off build never instantiates it, so no
  // sync handler / watchers register at all (getBuildConfig is final by now —
  // initBuildConfig is awaited in main.ts before the app mounts / this runs).
  const kanbanEnabled = getBuildConfig().kanban_enabled;
  const kanban = kanbanEnabled ? useKanban(p2p) : null;
  // Linked-device sync — owns the hidden devlink channel (headless second
  // useChatChannel instance) for registry/kv/history convergence with the
  // user's other devices. Flag-off builds never instantiate it.
  const devicesEnabled = getBuildConfig().devices_allow_linking;
  const deviceSync: DeviceSync | null = devicesEnabled ? useDeviceSync(p2p) : null;
  // Peer links — scoped person-to-person sync (peer.md). Flag-off builds never
  // instantiate it, so no `plink_` handler registers and no link channel exists.
  // The data sources are injected by stores/peers.ts (rakotis must not reach
  // into app state); until it calls `setSources` the link converges nothing,
  // which is exactly right for a profile that has not opened Peers yet.
  const peersEnabled = getBuildConfig().peers_enabled;
  let peerSources: PeerSyncSources = { myNodeId: () => "" };
  const peerSync: PeerSync | null = peersEnabled
    ? usePeerSync(p2p, {
        myNodeId: () => peerSources.myNodeId(),
        myMeetings: () => peerSources.myMeetings?.() ?? Promise.resolve([]),
        myCard: () => peerSources.myCard?.() ?? Promise.resolve(null),
        sharedRooms: (id) => peerSources.sharedRooms?.(id) ?? Promise.resolve([]),
      })
    : null;
  /** Hand the peer-sync composable its app-side data sources (stores/peers.ts). */
  function setPeerSources(next: PeerSyncSources): void {
    peerSources = next;
  }

  let initialized = false;
  /** App-start bootstrap: load the saved room list and auto-reopen the most recent
   *  room. Rejoining passes the room's persisted peer NodeIds, so peers whose
   *  addresses changed since the QR pairing are still found via n0 discovery. */
  async function init() {
    if (initialized) return;
    initialized = true;
    await p2p.loadP2pRooms();
    // A paired profile starts its devlink channel (no-op when never paired).
    if (deviceSync) await deviceSync.start();
    const last = p2p.p2pRooms.value[0];
    if (last) await p2p.openP2pRoom(last);
  }

  // ── identity / profile fan-out ────────────────────────────────────────────────
  async function syncRuntimeIdentity() {
    // A paired (linked) profile boots with the profile-name identity; adopt its
    // stored leaf id ("user#dev-…") BEFORE the channel reads the runtime config.
    if (devicesEnabled && isTauri()) {
      try { await invoke("devlink_adopt_identity"); } catch { /* never paired */ }
    }
    await p2p.syncRuntimeIdentity();
  }
  async function applyRuntimeProfile(runtime: AppRuntimeConfig) {
    await p2p.applyRuntimeProfile(runtime);
    // The profile switch swapped the kv data dir — re-read the meeting list and
    // the open room's board.
    if (meetings) await meetings.reload();
    if (kanban) await kanban.reload();
    if (deviceSync) {
      deviceSync.stop();
      await deviceSync.start();
    }
    // The profile switch swapped the kv data dir — reload this profile's peer
    // grants and reconnect their link rooms.
    if (peerSync) {
      peerSync.stop();
      await peerSync.start();
    }
  }
  function clearLocalChatState(message?: string) {
    p2p.clearLocalChatState(message);
  }

  return {
    p2p, fileShare, vox, callsEnabled, invites, contactsEnabled,
    meetings, calendarEnabled, kanban, kanbanEnabled,
    deviceSync, devicesEnabled, peerSync, peersEnabled, setPeerSources, init,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState,
  };
}

let _instance: ReturnType<typeof createChatStore> | null = null;

/** Singleton accessor (kept the `useChatStore` name so call sites are unchanged). */
export function useChatStore() {
  return (_instance ??= createChatStore());
}
