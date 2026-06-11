// Aurora chat store — relay only.
//
// Aurora is the data-workspace app: its chat is MLS-encrypted (where supported)
// relay chat over the toto telegraph WebSocket. There is NO P2P/iroh transport,
// no voice calls, and no CRDT data-sync — those live in Enigma. A single relay
// channel (from Rakotis) backs the chat view; the app-specific `api` is injected.

import { useChatChannel, type ChatChannel } from "rakotis";
import { api } from "../services/api";
import type { AppRuntimeConfig } from "euclid";

export type { Message, MlsStatus, ChatChannel } from "rakotis";

function createChatStore() {
  const relay: ChatChannel = useChatChannel("relay", api);

  async function syncRuntimeIdentity() {
    await relay.syncRuntimeIdentity();
  }
  async function applyRuntimeProfile(runtime: AppRuntimeConfig) {
    await relay.applyRuntimeProfile(runtime);
  }
  function clearLocalChatState(message?: string) {
    relay.clearLocalChatState(message);
  }
  async function leaveAllChatsOnServer() {
    await relay.leaveAllChatsOnServer();
  }

  return { relay, syncRuntimeIdentity, applyRuntimeProfile, clearLocalChatState, leaveAllChatsOnServer };
}

let _instance: ReturnType<typeof createChatStore> | null = null;

/** Singleton accessor (same name as Enigma's so shared call sites are unchanged). */
export function useChatStore() {
  return (_instance ??= createChatStore());
}
