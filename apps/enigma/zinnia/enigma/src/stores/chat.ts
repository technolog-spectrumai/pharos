// Orchestrator: holds the two simultaneous chat channels — Forum (relay/WS) and
// P2P (iroh) — plus which tab is active and the cross-tab switch automation. Both
// channels are always live (they subscribe to the transport independently), so you
// can be in a relay room AND a P2P room with the same people at the same time.
//
// This is a plain module singleton (NOT a Pinia setup store) on purpose: Pinia's
// reactive() would deep-unwrap the channels' inner refs, which we want to keep as
// real Ref<>s for the ChatPanel prop and direct `.value` access.

import { ref, computed } from "vue";
import { useChatChannel, type ChatChannel } from "../composables/useChatChannel";
import { useDataSync, type DataSync } from "../composables/useDataSync";
import { useFileShare, type FileShare } from "../composables/useFileShare";
import type { AppRuntimeConfig } from "../services/appStorage";

export type { Message, MlsStatus, P2pRoomEntry, ChatChannel } from "../composables/useChatChannel";

// "vox" is the real-time voice-call tab and "sync" is the full-data pull tab — neither
// has a ChatChannel (no message history); they drive iroh/CRDT backends directly.
export type ChatTab = "relay" | "p2p" | "vox" | "sync" | "files";

function createChatStore() {
  const relay: ChatChannel = useChatChannel("relay");
  const p2p: ChatChannel = useChatChannel("p2p");
  // Full-data "Sync" and P2P file transfer both ride the p2p channel's MLS group.
  const dataSync: DataSync = useDataSync(p2p);
  const fileShare: FileShare = useFileShare(p2p);

  const activeTab = ref<ChatTab>("relay");
  const activeChannel = computed<ChatChannel>(() => (activeTab.value === "p2p" ? p2p : relay));

  function setTab(tab: ChatTab) {
    activeTab.value = tab;
    if (tab === "relay") relay.clearUnread();
    else if (tab === "p2p") p2p.clearUnread();
  }

  // ── cross-tab switch automation ───────────────────────────────────────────────
  /** Forum → P2P: open a fresh P2P room and post a "join private room" card into the
   *  relay chat (opt-in for the others), then jump to the P2P tab. */
  async function switchToP2p() {
    const room = relay.currentRoom.value;
    if (!room) { setTab("p2p"); return; }
    const ticket = await p2p.createRoom(room.name);
    if (ticket) await relay.sendInvite(ticket, room.name);
    setTab("p2p");
  }

  /** P2P → Forum: just return to the relay tab (its chat stays live). */
  function switchToRelay() {
    setTab("relay");
  }

  /** Accept a "join private room" invite card from the relay chat. */
  async function acceptP2pInvite(ticket: string) {
    await p2p.joinByTicket(ticket);
    setTab("p2p");
  }

  // ── identity / profile fan-out ────────────────────────────────────────────────
  async function syncRuntimeIdentity() {
    await relay.syncRuntimeIdentity();
    await p2p.syncRuntimeIdentity();
  }
  async function applyRuntimeProfile(runtime: AppRuntimeConfig) {
    await relay.applyRuntimeProfile(runtime);
    await p2p.applyRuntimeProfile(runtime);
  }
  function clearLocalChatState(message?: string) {
    relay.clearLocalChatState(message);
    p2p.clearLocalChatState(message);
  }
  async function leaveAllChatsOnServer() {
    await relay.leaveAllChatsOnServer();
  }

  return {
    relay, p2p, dataSync, fileShare, activeTab, activeChannel, setTab,
    switchToP2p, switchToRelay, acceptP2pInvite,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState, leaveAllChatsOnServer,
  };
}

let _instance: ReturnType<typeof createChatStore> | null = null;

/** Singleton accessor (kept the `useChatStore` name so call sites are unchanged). */
export function useChatStore() {
  return (_instance ??= createChatStore());
}
