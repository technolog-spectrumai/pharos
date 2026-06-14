// Orchestrator: holds the two simultaneous chat channels — Forum (relay/WS) and
// P2P (iroh) — plus which tab is active and the cross-tab switch automation. Both
// channels are always live (they subscribe to the transport independently), so you
// can be in a relay room AND a P2P room with the same people at the same time.
//
// This is a plain module singleton (NOT a Pinia setup store) on purpose: Pinia's
// reactive() would deep-unwrap the channels' inner refs, which we want to keep as
// real Ref<>s for the ChatPanel prop and direct `.value` access.

import { ref, computed } from "vue";
import { useChatChannel, type ChatChannel } from "rakotis";
import { api } from "../services/api";
import { useFileShare, type FileShare } from "../composables/useFileShare";
import type { AppRuntimeConfig } from "euclid";

export type { Message, MlsStatus, P2pRoomEntry, ChatChannel } from "rakotis";

// "vox" is the real-time voice-call tab; it has no ChatChannel (no message history)
// and drives the iroh voice backend directly.
export type ChatTab = "relay" | "p2p" | "vox" | "files";

function createChatStore() {
  const relay: ChatChannel = useChatChannel("relay", api);
  const p2p: ChatChannel = useChatChannel("p2p", api);
  // P2P file transfer rides the p2p channel's MLS group.
  const fileShare: FileShare = useFileShare(p2p);

  const activeTab = ref<ChatTab>("relay");
  const activeChannel = computed<ChatChannel>(() => (activeTab.value === "p2p" ? p2p : relay));

  function setTab(tab: ChatTab) {
    activeTab.value = tab;
    if (tab === "relay") relay.clearUnread();
    else if (tab === "p2p") p2p.clearUnread();
  }

  // ── cross-tab switch automation ───────────────────────────────────────────────
  /** Resolve the gossip NodeIds of every *other* member of the current relay room
   *  from the aster directory (over Tor). Offline members / those without an account
   *  simply resolve to nothing and are skipped — they bootstrap in later via the same
   *  deterministic room topic when they come online. */
  async function relayMemberNodeIds(): Promise<string[]> {
    const me = relay.currentUserName.value;
    const usernames = relay.participants.value
      .filter((p) => p.username && p.name !== me)
      .map((p) => p.username as string);
    const lists = await Promise.all(usernames.map((u) => relay.resolveNodes(u, "gossip")));
    return Array.from(new Set(lists.flat())).filter(Boolean);
  }

  /** Open (or rejoin) the P2P room mirroring the current relay room, bootstrapping
   *  from the relay members' aster-resolved NodeIds — no ticket needed. The relay
   *  slug is the shared, deterministic room key both sides derive the topic from. */
  async function openP2pWithRelayMembers(): Promise<boolean> {
    const room = relay.currentRoom.value;
    if (!room) return false;
    await p2p.ensureNode(); // register our gossip NodeId so peers can resolve us
    const nodeIds = await relayMemberNodeIds();
    await p2p.joinByNode(room.slug, nodeIds);
    return true;
  }

  /** Forum → P2P: open the mirrored P2P room by node, post a ticketless "join private
   *  room" nudge into the relay chat (opt-in for the others), then jump to the P2P tab. */
  async function switchToP2p() {
    const room = relay.currentRoom.value;
    if (!room) { setTab("p2p"); return; }
    const opened = await openP2pWithRelayMembers();
    if (opened) await relay.sendAutoJoin(room.slug);
    setTab("p2p");
  }

  /** P2P → Forum: just return to the relay tab (its chat stays live). */
  function switchToRelay() {
    setTab("relay");
  }

  /** Accept a ticketless auto-join nudge: join the mirrored P2P room by resolving the
   *  relay members from aster. `name` is the relay slug (the shared room key). */
  async function acceptP2pAutoJoin(name: string) {
    await p2p.ensureNode();
    const nodeIds = await relayMemberNodeIds();
    await p2p.joinByNode(name, nodeIds);
    setTab("p2p");
  }

  /** Accept a legacy ticket-based "join private room" invite card from the relay chat. */
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
    relay, p2p, fileShare, activeTab, activeChannel, setTab,
    switchToP2p, switchToRelay, acceptP2pInvite, acceptP2pAutoJoin,
    syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState, leaveAllChatsOnServer,
  };
}

let _instance: ReturnType<typeof createChatStore> | null = null;

/** Singleton accessor (kept the `useChatStore` name so call sites are unchanged). */
export function useChatStore() {
  return (_instance ??= createChatStore());
}
